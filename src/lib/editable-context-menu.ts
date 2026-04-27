/**
 * editable-context-menu.ts
 * Electron's renderer does not get a native Copy/Paste menu out of the box,
 * so pasting with the right mouse button into an <input> / <textarea> /
 * contenteditable fails silently — the user reported exactly that. This
 * module installs a single document-level "contextmenu" listener that
 * opens a small in-renderer menu over any editable target (xterm's hidden
 * helper-textarea is also included) with Cut, Copy, Paste, "Paste image",
 * and Select all. Text paste is backed by the Clipboard API; image paste
 * reads the image bytes off the clipboard, hands them to the main process
 * to save under userData/clipboard-pastes, and types the resulting absolute
 * path into the focused element — claude CLI happily reads images by path.
 *
 * The menu is a plain absolutely-positioned <div> — no framework, no portals,
 * so it works regardless of which Solid tree happens to be mounted.
 */

import { invoke } from './ipc';
import { IPC } from '../../electron/ipc/channels';
import { dispatchXtermPaste, readXtermSelection } from './xterm-bridge';

interface State {
  el: HTMLDivElement | null;
  installed: boolean;
}

const state: State = { el: null, installed: false };

function isEditable(
  el: EventTarget | null,
): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    // Only text-like inputs accept paste
    return !type || /^(text|search|url|email|tel|password|number)$/i.test(type);
  }
  if (el.tagName === 'TEXTAREA') return true;
  // xterm renders rows into a sibling tree; the target is usually a
  // <div>/<span> inside .xterm. Treat anything inside an xterm container
  // as editable so we can show the right-click menu over the terminal.
  let n: HTMLElement | null = el;
  while (n) {
    if (n.classList?.contains('xterm')) return true;
    n = n.parentElement;
  }
  return false;
}

function close() {
  if (state.el) {
    state.el.remove();
    state.el = null;
  }
}

/** Quick async check: does the system clipboard hold an image right now?
 *  Uses the Web Clipboard API (no IPC) so the menu can decide whether to
 *  enable the "Paste image" item without waiting on the main process.
 *  Falls back to false on permission errors. */
async function clipboardHasImage(): Promise<boolean> {
  try {
    if (!navigator.clipboard?.read) return false;
    const items = await navigator.clipboard.read();
    return items.some((it) => it.types.some((t) => t.startsWith('image/')));
  } catch {
    return false;
  }
}

/** Walks up from a click target to find the xterm container, if any. */
function findXtermContainer(el: HTMLElement | null): HTMLElement | null {
  let n: HTMLElement | null = el;
  while (n) {
    if (n.classList?.contains('xterm')) return n;
    n = n.parentElement;
  }
  return null;
}

/** Read xterm's current selection — falls back to the DOM's window.getSelection
 *  when xterm has nothing (e.g. user dragged across rendered span text). */
function readXtermSelectionWithFallback(xtermEl: HTMLElement): string {
  const fromXterm = readXtermSelection(xtermEl);
  if (fromXterm) return fromXterm;
  return window.getSelection()?.toString() ?? '';
}

function openAt(x: number, y: number, target: HTMLElement, imageReady: boolean) {
  close();
  const menu = document.createElement('div');
  menu.className = 'editable-context-menu';
  menu.setAttribute('role', 'menu');
  Object.assign(menu.style, {
    position: 'fixed',
    left: `${x}px`,
    top: `${y}px`,
    zIndex: '10000',
    background: 'var(--bg, #1a1a1a)',
    color: 'var(--fg, #eee)',
    border: '1px solid var(--border, #333)',
    borderRadius: '6px',
    padding: '4px',
    boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
    fontFamily: 'var(--font-ui, sans-serif)',
    fontSize: '12px',
    minWidth: '140px',
  } as Partial<CSSStyleDeclaration>);

  const xtermEl = findXtermContainer(target);
  const isXterm = xtermEl !== null;

  const windowSelection = window.getSelection()?.toString() ?? '';
  const hasSelection = isXterm
    ? readXtermSelectionWithFallback(xtermEl).length > 0
    : target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.selectionStart !== target.selectionEnd
      : windowSelection.length > 0;

  const dispatchPasteToXterm = (text: string) => {
    if (!xtermEl || !text) return;
    dispatchXtermPaste(xtermEl, text);
  };

  const items: { label: string; enabled: boolean; action: () => Promise<void> | void }[] = [
    {
      label: 'Cut',
      // Cutting from a terminal is meaningless — the user would expect us
      // to delete their typed input out from under the running process.
      enabled: hasSelection && !isXterm,
      action: () => {
        const sel = readSelection(target);
        if (!sel) return;
        void navigator.clipboard.writeText(sel);
        replaceSelection(target, '');
      },
    },
    {
      label: 'Copy',
      enabled: hasSelection,
      action: () => {
        if (isXterm && xtermEl) {
          const text = readXtermSelectionWithFallback(xtermEl);
          if (text) void navigator.clipboard.writeText(text);
          return;
        }
        const sel = readSelection(target);
        if (sel) void navigator.clipboard.writeText(sel);
      },
    },
    {
      label: 'Paste',
      enabled: true,
      action: async () => {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        if (isXterm) {
          // term.paste() respects bracketedPasteMode, so a multi-line
          // paste lands in claude CLI as a single block instead of one
          // Enter-fired send per newline.
          dispatchPasteToXterm(text);
          return;
        }
        replaceSelection(target, text);
      },
    },
    {
      label: 'Paste image',
      enabled: imageReady,
      action: async () => {
        try {
          // Main-process electron.clipboard.readImage() → temp PNG path.
          // For xterm: type the path so claude CLI can read it. For
          // regular fields: insert the path as plain text.
          const filePath = await invoke<string | null>(IPC.SaveClipboardImage);
          if (!filePath) return;
          if (isXterm) dispatchPasteToXterm(filePath);
          else replaceSelection(target, filePath);
        } catch (err) {
          console.warn('[paste-image] save failed:', err);
        }
      },
    },
    {
      label: 'Select all',
      enabled: !isXterm,
      action: () => {
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          target.select();
        } else if (target.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(target);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      },
    },
  ];

  for (const item of items) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.type = 'button';
    btn.disabled = !item.enabled;
    if (item.label === 'Paste image') btn.setAttribute('data-paste-image', '1');
    Object.assign(btn.style, {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      background: 'transparent',
      border: 'none',
      color: 'inherit',
      padding: '6px 10px',
      borderRadius: '4px',
      cursor: item.enabled ? 'pointer' : 'default',
      opacity: item.enabled ? '1' : '0.4',
      font: 'inherit',
    } as Partial<CSSStyleDeclaration>);
    btn.onmouseenter = () => {
      if (item.enabled) btn.style.background = 'rgba(255,255,255,0.08)';
    };
    btn.onmouseleave = () => {
      btn.style.background = 'transparent';
    };
    btn.onclick = () => {
      close();
      target.focus();
      void item.action();
    };
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  state.el = menu;

  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight)
    menu.style.top = `${window.innerHeight - rect.height - 4}px`;
}

function readSelection(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    return el.value.slice(start, end);
  }
  return window.getSelection()?.toString() ?? '';
}

function replaceSelection(el: HTMLElement, text: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    // Fire an input event so frameworks see the update
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (el.isContentEditable) {
    // Use execCommand as a pragmatic fallback — still works in Chromium/Electron
    // for contenteditable even though it's deprecated on paper.
    document.execCommand('insertText', false, text);
  }
}

export function installEditableContextMenu(): void {
  if (state.installed) return;
  state.installed = true;
  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (!isEditable(target)) return;
    e.preventDefault();
    // Open immediately with imageReady=false so the menu doesn't lag, then
    // upgrade the "Paste image" item if an image turns out to be on the
    // clipboard. Most users right-click + click within ~150ms; the upgrade
    // race is fine for a UX hint.
    openAt(e.clientX, e.clientY, target, false);
    void clipboardHasImage().then((has) => {
      if (!has || !state.el) return;
      const item = state.el.querySelector<HTMLButtonElement>('button[data-paste-image]');
      if (item) {
        item.disabled = false;
        item.style.opacity = '1';
        item.style.cursor = 'pointer';
      }
    });
  });
  document.addEventListener('mousedown', (e) => {
    if (!state.el) return;
    if (e.target instanceof Node && state.el.contains(e.target)) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  window.addEventListener('blur', close);
}
