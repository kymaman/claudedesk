/**
 * editable-context-menu.ts
 * Electron's renderer does not get a native Copy/Paste menu out of the box,
 * so pasting with the right mouse button into an <input> / <textarea> /
 * contenteditable fails silently — the user has reported exactly that.
 * This module installs a single document-level "contextmenu" listener that
 * opens a small in-renderer menu over any editable target with Cut, Copy,
 * Paste, and Select all, backed by the Clipboard API.
 *
 * The menu is a plain absolutely-positioned <div> — no framework, no portals,
 * so it works regardless of which Solid tree happens to be mounted.
 */

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
  return false;
}

function close() {
  if (state.el) {
    state.el.remove();
    state.el = null;
  }
}

function openAt(x: number, y: number, target: HTMLElement) {
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

  const selection = window.getSelection()?.toString() ?? '';
  const hasSelection =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.selectionStart !== target.selectionEnd
      : selection.length > 0;

  const items: { label: string; enabled: boolean; action: () => Promise<void> | void }[] = [
    {
      label: 'Cut',
      enabled: hasSelection,
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
        const sel = readSelection(target);
        if (sel) void navigator.clipboard.writeText(sel);
      },
    },
    {
      label: 'Paste',
      enabled: true,
      action: async () => {
        const text = await navigator.clipboard.readText();
        if (text) replaceSelection(target, text);
      },
    },
    {
      label: 'Select all',
      enabled: true,
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
    openAt(e.clientX, e.clientY, target);
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
