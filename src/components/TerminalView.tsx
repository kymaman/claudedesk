import { onMount, onCleanup, createEffect } from 'solid-js';
import { Terminal, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke, fireAndForget, Channel } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { getTerminalFontFamily } from '../lib/fonts';
import { TERMINAL_SCROLLBACK_LINES } from '../lib/terminalConstants';
import { getTerminalTheme } from '../lib/theme';
import { matchesGlobalShortcut } from '../lib/shortcuts';
import { isMac } from '../lib/platform';
import { resolvedBindings } from '../store/keybindings';
import { matchesKeyEvent } from '../lib/keybindings';
import { store, setTaskLastInputAt } from '../store/store';
import { terminalDefaults } from '../store/terminal-defaults';
import { mergeSpawnArgs, mergeSpawnEnv } from '../lib/terminal-spawn-merge';
import { filterArgsBySupport } from '../lib/agent-args-filter';
import { listenXtermBridge } from '../lib/xterm-bridge';
import { classifyInjectedText } from '../lib/injected-text';
import { isSelectionMirror } from '../lib/selection-mirror';
import { resolveFileLink } from '../lib/file-link-resolve';
import { extractFileLinkCandidates, stripLineColSuffix } from '../lib/terminal-file-links';
import { createResizeCoalescer } from '../lib/terminal-resize-coalescer';
import { registerTerminal, unregisterTerminal, markDirty } from '../lib/terminalFitManager';
import { shouldWriteTranscript, shouldLiveTerminalPrefill } from '../lib/transcript-prefill';
import { shouldAutoConfirmFolderTrust } from '../lib/auto-trust';
import { planWheelScroll } from '../lib/terminal-wheel';
import type { PtyOutput } from '../ipc/types';

// Whole lines moved per wheel notch (no smoothing — see terminal-wheel.ts).
// One knob to tune scroll speed: small enough to never lose your place,
// large enough not to feel sluggish.
const WHEEL_LINES_PER_NOTCH = 3;

// Pre-computed base64 lookup table — avoids atob() intermediate string allocation.
const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

function base64ToUint8Array(b64: string): Uint8Array {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61 /* '=' */) end--;
  const out = new Uint8Array((end * 3) >>> 2);
  let j = 0;
  for (let i = 0; i < end; ) {
    const a = B64_LOOKUP[b64.charCodeAt(i++)];
    const b = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const c = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const d = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    out[j++] = (triplet >>> 16) & 0xff;
    if (j < out.length) out[j++] = (triplet >>> 8) & 0xff;
    if (j < out.length) out[j++] = triplet & 0xff;
  }
  return out;
}

interface TerminalViewProps {
  taskId: string;
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  isShell?: boolean;
  stepsEnabled?: boolean;
  dockerMode?: boolean;
  dockerImage?: string;
  onExit?: (exitInfo: {
    exit_code: number | null;
    signal: string | null;
    last_output: string[];
  }) => void;
  onData?: (data: Uint8Array) => void;
  onPromptDetected?: (text: string) => void;
  onFileLink?: (filePath: string) => void;
  onReady?: (focusFn: () => void) => void;
  onBufferReady?: (getBuffer: () => string) => void;
  /** Exposes step-bookmark API: `mark(i)` registers a marker at the current line for
   *  step index `i`; `jump(i)` scrolls the viewport so that marker is visible.
   *  Called with `undefined` on unmount so the consumer can reset its state — important
   *  on agent restart, where this component remounts but the parent does not. */
  onStepNavReady?: (
    api: { mark: (i: number) => void; jump: (i: number) => boolean } | undefined,
  ) => void;
  fontSize?: number;
  autoFocus?: boolean;
  initialCommand?: string;
  isFocused?: boolean;
}

// Status parsing only needs recent output. Capping forwarded bytes avoids
// expensive full-chunk decoding during large terminal bursts.
const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;

/** Terminal-layer bindings — filtered from resolved bindings.
 *  Called in the key handler (hot path); resolveBindings walks the full
 *  defaults list on each call, which is fine at human typing speed. */
function getTerminalBindings() {
  return resolvedBindings().filter((b) => b.layer === 'terminal');
}

/** True when the spawn command is a claude binary (claude / claude.exe / …). */
function isClaudeCommand(command: string | undefined): boolean {
  return /(^|[\\/])claude(?:\.(?:exe|cmd|bat))?$/i.test(command ?? '');
}

export function TerminalView(props: TerminalViewProps) {
  let containerRef!: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let webglAddon: WebglAddon | undefined;

  // A claude (non-shell) terminal: it repaints in place and has no usable
  // xterm scrollback, but it DOES scroll its own transcript on PageUp/PageDown
  // (and shows its "Jump to bottom (ctrl+End)" hint). So for claude we
  // translate the wheel into those keys and send them to the PTY — claude does
  // the scrolling. A plain shell instead uses xterm's own scrollback below.
  // command/isShell are fixed for a tile's lifetime, so reading them once (not
  // reactively) is correct.
  // eslint-disable-next-line solid/reactivity -- command/isShell are stable for the tile
  const claudeTuiTerminal = isClaudeCommand(props.command) && !props.isShell;

  onMount(() => {
    // Capture props eagerly so cleanup/callbacks always use the original values
    const taskId = props.taskId;
    const agentId = props.agentId;
    const initialFontSize = props.fontSize ?? 13;

    // Fire-and-forget font preload. xterm's canvas renderer measures glyph
    // widths once at init — if the webfont (incl. Cyrillic subset) hasn't
    // arrived yet, Russian characters fall back per-glyph and jitter vertically.
    // Loading both latin and cyrillic weight variants primes the FontFaceSet.
    const fontName = store.terminalFont || 'JetBrains Mono';
    if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
      void Promise.all([
        document.fonts.load(`${initialFontSize}px "${fontName}"`, 'Aa'),
        document.fonts.load(`${initialFontSize}px "${fontName}"`, 'Аа'),
        document.fonts.load(`500 ${initialFontSize}px "${fontName}"`, 'Аа'),
      ]).then(() => {
        // Re-render terminal after fonts ready so glyph widths use the real font.
        try {
          term?.refresh(0, term.rows - 1);
        } catch {
          /* term may be disposed */
        }
      });
    }

    term = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: getTerminalFontFamily(store.terminalFont),
      theme: getTerminalTheme(store.themePreset),
      allowProposedApi: true,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      // Wheel scrolling is handled by our own capture-phase listener
      // (see WHEEL_LINES_PER_NOTCH below): Claude Code's TUI enables mouse
      // tracking, which makes xterm forward the wheel to the app instead
      // of scrolling — so we take it over. No smooth animation (the owner
      // explicitly didn't want it); every notch moves whole lines so no
      // line is skipped. These options are the fallback for the rare
      // not-hijacked path.
      scrollSensitivity: 3,
      fastScrollSensitivity: 12,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Require Cmd+click (Mac) or Ctrl+click (Linux) to open links
        if (!(isMac ? event.metaKey : event.ctrlKey)) return;
        try {
          const parsed = new URL(uri);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            window.open(uri, '_blank');
          }
        } catch {
          // Invalid URL, ignore
        }
      }),
    );

    term.open(containerRef);

    // File drag-and-drop into the terminal: drop one or more files from
    // the OS file manager and the absolute paths get pasted (space-quoted
    // for safety). Claude CLI accepts a path argument as a file reference
    // — this is the canonical "show Claude this file" gesture.
    const onContainerDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onContainerDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      const paths: string[] = [];
      // Electron exposes the absolute path of dropped OS files via
      // `webUtils.getPathForFile(file)` — but we can also use the legacy
      // (still working in current Electron) `file.path` property which
      // is set on dropped files in renderer.
      for (let i = 0; i < files.length; i += 1) {
        const f = files.item(i);
        if (!f) continue;
        const p = (f as File & { path?: string }).path ?? '';
        if (p) {
          // Quote the path if it contains spaces so the CLI parses it as
          // a single argument.
          paths.push(p.includes(' ') ? `"${p}"` : p);
        }
      }
      if (paths.length > 0) enqueueInput(paths.join(' '));
    };
    containerRef.addEventListener('dragover', onContainerDragOver);
    containerRef.addEventListener('drop', onContainerDrop);

    // Whisper-Flow-style dictation tools inject text by dispatching a
    // SYNTHETIC `paste` ClipboardEvent on the focused helper-textarea.
    // xterm only wires its paste pipeline to REAL clipboard events, so
    // synthetic ones silently vanished (dictation reached Telegram /
    // notes apps but never our PTY). Forward them ourselves. Real
    // Ctrl+V pastes are handled (and preventDefault-ed) by xterm before
    // bubbling here — the defaultPrevented guard makes double-pasting
    // impossible.
    const onContainerPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      try {
        term?.paste(text);
      } catch {
        /* terminal disposed */
      }
    };
    containerRef.addEventListener('paste', onContainerPaste);

    // Wheel-to-scroll (policy lives in lib/terminal-wheel.ts, unit-tested):
    //  - shell (real xterm scrollback): scroll the buffer by whole lines.
    //  - claude TUI (old, baseY===0): claude repaints in place with no usable
    //    xterm scrollback but scrolls its OWN transcript on PageUp/PageDown, so
    //    we translate each wheel notch into those keys and write them to the
    //    PTY. claude then scrolls itself and shows its "Jump to bottom" hint.
    //  - claude TUI (2.1.183+, baseY>0): claude now fills xterm's native
    //    scrollback, so we scroll THAT directly (PageUp would move nothing the
    //    user can see). hasScrollback below selects between the two.
    // Ctrl+wheel (zoom) and the alternate screen bubble untouched.
    const onContainerWheel = (e: WheelEvent) => {
      if (!term) return;
      const plan = planWheelScroll({
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        altScreen: term.buffer.active.type === 'alternate',
        claudeTui: claudeTuiTerminal,
        // claude 2.1.183 fills xterm's native scrollback; when it has lines
        // above the viewport, scroll THAT instead of sending PageUp (the wheel
        // had nothing to move via PageUp once real scrollback exists).
        hasScrollback: term.buffer.active.baseY > 0,
        ctrlKey: e.ctrlKey,
        linesPerNotch: WHEEL_LINES_PER_NOTCH,
      });
      if (plan.action === 'ignore') return;
      if (plan.action === 'ptyKeys') {
        enqueueInput(plan.data); // PageUp/PageDown → claude scrolls its transcript
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      term.scrollLines(plan.scrollLines);
      e.preventDefault();
      e.stopPropagation();
    };
    containerRef.addEventListener('wheel', onContainerWheel, { capture: true, passive: false });

    onCleanup(() => {
      containerRef.removeEventListener('dragover', onContainerDragOver);
      containerRef.removeEventListener('drop', onContainerDrop);
      containerRef.removeEventListener('paste', onContainerPaste);
      containerRef.removeEventListener('wheel', onContainerWheel, { capture: true });
    });

    // File path link provider — makes file paths clickable in terminal output
    // Must be registered after term.open() so the DOM is available.
    term.registerLinkProvider({
      provideLinks(y, callback) {
        if (!term) {
          callback(undefined);
          return;
        }
        const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
        // Matching rules (incl. Windows drive paths) live in
        // terminal-file-links.ts so they're unit-testable.
        const links = extractFileLinkCandidates(line);
        callback(
          links.map((link) => ({
            range: {
              start: { x: link.startIndex + 1, y },
              end: { x: link.startIndex + link.length + 1, y },
            },
            text: link.text,
            activate(event: MouseEvent, _text: string) {
              // Require Cmd+click (Mac) or Ctrl+click (Linux) to open links
              const modifierHeld = isMac ? event.metaKey : event.ctrlKey;
              if (!modifierHeld) return;
              // Strip line:col suffix for opening
              const filePath = stripLineColSuffix(link.text);
              const resolved = resolveFileLink(filePath, props.cwd);
              // .md files open in viewer; Shift held = open externally instead
              if (/\.md$/i.test(resolved) && props.onFileLink && !event.shiftKey) {
                props.onFileLink(resolved);
              } else {
                invoke(IPC.OpenPath, { filePath: resolved }).catch(console.error);
              }
            },
          })),
        );
      },
    });

    props.onReady?.(() => term?.focus());

    // Step bookmarks — anchor each agent step to the current scrollback line so the
    // user can jump from the steps panel back to the terminal moment a step was written.
    // Markers auto-track buffer truncation; once the marker scrolls past the scrollback
    // limit xterm disposes it, in which case `jump` returns false so the caller can no-op.
    // The map is owned by xterm and freed implicitly when term.dispose() runs in onCleanup.
    const stepMarkers = new Map<number, IMarker>();
    const stepNavApi = {
      mark(i: number) {
        if (!term || stepMarkers.has(i)) return;
        const m = term.registerMarker(0);
        if (m) stepMarkers.set(i, m);
      },
      jump(i: number): boolean {
        if (!term) return false;
        const m = stepMarkers.get(i);
        if (!m || m.isDisposed) return false;
        term.scrollToLine(m.line);
        return true;
      },
    };
    props.onStepNavReady?.(stepNavApi);
    onCleanup(() => props.onStepNavReady?.(undefined));

    props.onBufferReady?.(() => {
      if (!term) return '';
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i <= buf.length - 1; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines.join('\n');
    });

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') {
        // Suppress Shift+Enter keyup so xterm doesn't echo a bare Enter
        if (e.key === 'Enter' && e.shiftKey) return false;
        return true;
      }

      // Let global app shortcuts pass through to the window handler
      if (matchesGlobalShortcut(e)) return false;

      // Look up terminal bindings from registry
      for (const binding of getTerminalBindings()) {
        if (!matchesKeyEvent(e, binding)) continue;

        // Special actions that need custom handling
        if (binding.action === 'copy') {
          const sel = term?.getSelection();
          if (sel) {
            e.preventDefault();
            navigator.clipboard.writeText(sel);
            return false;
          }
          // No selection — let the keystroke through (Ctrl+C → SIGINT,
          // the canonical terminal behaviour). Don't preventDefault, don't
          // return false, just keep matching subsequent bindings.
          continue;
        }

        e.preventDefault();

        if (binding.action === 'paste') {
          e.preventDefault();
          // Synchronous read via Electron's clipboard (exposed in preload) —
          // this avoids the previous async race where pressing Enter right
          // after Ctrl+V would land before the paste content because
          // navigator.clipboard.readText() resolves on a microtask.
          // Wispr Flow and similar dictation apps simulate Ctrl+V to deliver
          // text; the sync path makes them reliable too.
          const bridge = (window as unknown as { electron?: { clipboardReadText?: () => string } })
            .electron;
          const text = bridge?.clipboardReadText?.() ?? '';
          if (text) {
            // Use term.paste() so multi-line pastes get wrapped in
            // \e[200~ … \e[201~ (bracketed paste). Otherwise embedded
            // newlines are interpreted as Enter and the CLI submits
            // the first line — making the rest of the paste "disappear".
            // term.paste() routes through term.onData → enqueueInput,
            // so the keystroke still ends up in pendingInput as a single
            // batch.
            try {
              term?.paste(text);
              // term.paste() does NOT fire a focus event, so xterm's internal
              // _isFocused flag stays false if the user had switched windows /
              // tabs between focus and paste. Without this, after paste the
              // user can't press Enter or type anything until they click the
              // terminal again. Explicit focus() restores the flag.
              term?.focus();
            } catch {
              // term may have been disposed mid-keypress; fall back to raw
              // enqueue so the user's input isn't silently dropped.
              enqueueInput(text);
            }
            return false;
          }
          // No text on clipboard — try image fallback (async is fine here:
          // there's no Enter race because the user explicitly pasted into
          // an empty-text scenario).
          (async () => {
            const filePath = await invoke<string | null>(IPC.SaveClipboardImage);
            if (filePath) enqueueInput(filePath);
          })().catch(() => {});
          return false;
        }

        // Generic escape sequence bindings
        if (binding.escapeSequence) {
          enqueueInput(binding.escapeSequence);
          return false;
        }
      }

      return true;
    });

    // Register BEFORE first fit so terminalFitManager's ResizeObserver
    // catches every container size change from the very first frame.
    // Previously the order was reversed and any layout reflow between
    // first fit() and register was missed → xterm stuck at small cols.
    registerTerminal(agentId, containerRef, fitAddon, term);
    fitAddon.fit();

    // Expose the live Terminal on the .xterm container so e2e tests
    // (and devtools sessions) can drive it programmatically — most
    // notably, the bracketed-paste contract is verified by calling
    // term.paste() and reading what would reach the PTY. The reference
    // is read-only from the test side; the cost in production is one
    // hidden property per chat tile.
    {
      const xtermEl = containerRef.querySelector('.xterm');
      if (xtermEl) {
        (xtermEl as unknown as { __term?: Terminal }).__term = term;
      }
    }

    // External paste/copy bridge — see src/lib/xterm-bridge.ts. The
    // right-click context menu fires custom events on the .xterm container
    // (xterm doesn't expose the Terminal instance through the DOM) and we
    // forward them to the live `term` here. term.paste() respects
    // bracketedPasteMode so multi-line paste lands as one block.
    const offBridge = listenXtermBridge(containerRef, {
      onPaste: ({ text }) => {
        if (text.length === 0) return;
        try {
          term?.paste(text);
          // Same focus-restore as the Ctrl+V keyboard path — without it,
          // pasting via the right-click menu leaves the terminal unable
          // to receive Enter/keystrokes until the user clicks back on it.
          term?.focus();
        } catch {
          /* term may be disposed */
        }
      },
      onCopy: ({ result }) => {
        try {
          const sel = term?.getSelection() ?? '';
          if (sel) void navigator.clipboard.writeText(sel);
          // Surface the selection back so the menu can fall back to
          // window.getSelection() if xterm gave us an empty string.
          result.text = sel;
        } catch {
          /* ignore */
        }
      },
    });

    // ------------------------------------------------------------
    // Whisper Flow / external text injection safety net
    // ------------------------------------------------------------
    // xterm only sees text that arrives via real keydown events on its
    // hidden helper-textarea. Whisper Flow (and similar dictation tools)
    // injects text by setting `textarea.value` programmatically — that
    // path doesn't fire keydown, so xterm ignores it and the dictated
    // text disappears entirely. Telegram and notes apps accept it
    // because they read `value` directly.
    //
    // Defensive fix: listen for `input` events (capture=false so xterm
    // runs first) AND poll the textarea value periodically. If after
    // xterm's own handling the textarea still contains text, treat it
    // as an external injection and forward to the PTY.
    const taEl = containerRef.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    // xterm hides the helper-textarea off-screen (left:-9999px) so
    // dictation tools (Wispr Flow, Dragon, etc.) can't detect it as a
    // focusable input. Their accessibility-tree scanner skips elements
    // positioned outside the viewport.
    //
    // To let Wispr Flow target it we park the textarea on-screen with a
    // 1×1 px / zero-opacity footprint so it's a "real" focused input in
    // the a11y tree. BUT: with N chat tiles open there are N helper
    // textareas. If they were ALL a11y-visible, Wispr Flow's scanner
    // sees N identical "Terminal input" textboxes and writes to an
    // arbitrary one — which is exactly the user's bug ("only the Ask
    // sidebar works; Ask has just one terminal"). And "sometimes it
    // registers, sometimes not" is the same ambiguity racing focus.
    //
    // Fix: expose EXACTLY ONE textarea to the a11y tree at a time — the
    // focused chat's. Every other tile's textarea is shoved back off
    // screen and aria-hidden so Wispr Flow has a single unambiguous
    // target that always maps to the chat the user is looking at.
    if (taEl) {
      taEl.setAttribute('aria-label', 'Terminal input');
      taEl.setAttribute('aria-multiline', 'true');
      taEl.setAttribute('role', 'textbox');
    }
    const exposeTextareaToA11y = (expose: boolean) => {
      if (!taEl) return;
      if (expose) {
        taEl.style.position = 'absolute';
        taEl.style.left = '0';
        taEl.style.top = '0';
        taEl.style.width = '1px';
        taEl.style.height = '1px';
        taEl.style.opacity = '0';
        taEl.style.pointerEvents = 'none';
        taEl.removeAttribute('aria-hidden');
        taEl.tabIndex = 0;
      } else {
        // Back to xterm's default off-screen parking + hidden from the
        // a11y tree, so dictation tools never resolve to this terminal.
        taEl.style.left = '-9999px';
        taEl.style.top = '0';
        taEl.style.width = '1px';
        taEl.style.height = '1px';
        taEl.setAttribute('aria-hidden', 'true');
        taEl.tabIndex = -1;
      }
    };
    // Exposure rule: expose unless this terminal is EXPLICITLY a
    // non-active chat tile (isFocused === false). `undefined` means the
    // caller opted out of focus tracking entirely — that's the Ask
    // sidebar, which is a lone terminal and must stay a11y-visible
    // (Wispr Flow already works there; do not regress it). `true` is the
    // active chat tile. Only `false` (a background chat tile) is hidden.
    const shouldExpose = () => props.isFocused !== false;
    exposeTextareaToA11y(shouldExpose());
    createEffect(() => {
      exposeTextareaToA11y(shouldExpose());
    });
    const whisperFlushInterval: number | undefined = taEl
      ? // eslint-disable-next-line solid/reactivity -- poll callback reads current props.isFocused intentionally; not a tracked scope by design
        window.setInterval(() => {
          if (!taEl.value) return;
          // Only the active chat (or a lone Ask terminal, isFocused
          // undefined) may forward externally-injected text — a
          // background tile must never swallow dictation meant for the
          // active one (defence-in-depth on top of the a11y gating).
          if (props.isFocused === false) {
            taEl.value = '';
            return;
          }
          // xterm's right-click copy-mirror: on right-click xterm runs
          // `textarea.value = selectionText; textarea.select()` so the OS
          // "Copy" works. That leaves the WHOLE value selected. Without
          // this guard the poll forwards the user's own selection back
          // into the PTY on every right-click ("right-click pastes my
          // selection into the terminal"). Read selection bounds BEFORE
          // clearing value — clearing destroys them. See selection-mirror.ts.
          if (
            isSelectionMirror({
              value: taEl.value,
              selectionStart: taEl.selectionStart,
              selectionEnd: taEl.selectionEnd,
            })
          ) {
            taEl.value = '';
            return;
          }
          // After xterm's keydown handler runs, value is normally
          // cleared synchronously. A persistent non-empty value (200ms
          // sample) means something else wrote it — Whisper, AHK,
          // SendInput unicode mode, Wispr, paste-into-textarea, etc.
          const text = taEl.value;
          taEl.value = '';
          // Decide delivery (see lib/injected-text.ts):
          //   ignore — single-char residue (would double-type)
          //   paste  — multi-line block: MUST go through term.paste so
          //            it's bracketed-paste-wrapped. Forwarding raw
          //            multi-line text sends each newline as Enter,
          //            which makes claude submit the first line and
          //            wipe the rest — the user's "paste erases the
          //            previous block" bug.
          //   type   — single-line dictation: forward raw.
          const delivery = classifyInjectedText(text);
          if (delivery === 'ignore') return;
          if (delivery === 'paste') {
            try {
              term?.paste(text);
              term?.focus();
            } catch {
              // term disposed mid-tick — raw enqueue so input isn't lost.
              enqueueInput(text);
            }
            return;
          }
          enqueueInput(text);
        }, 200)
      : undefined;
    // Whisper Flow safety net is the 200 ms poll above ONLY. We previously
    // also hooked `input` and `paste` events on the helper-textarea, but
    // those duplicated every normal Ctrl+V — xterm already handles paste
    // natively, and our listeners forwarded the same text again. Result:
    // a single paste landed in the terminal 3 times. The poll alone is
    // enough for Wispr Flow (it writes textarea.value programmatically
    // without firing input events, so the poll's 200 ms window catches
    // dictation while xterm's own keystroke pipeline keeps regular typing
    // and pasting exclusive — no double-fire).

    // Mount-time sizing race: Solid places the element in the DOM, but the
    // browser may not have settled the layout pass when onMount() runs — so
    // containerRef can report 0×0 and fit() collapses to xterm's 80×24 default.
    // Re-fit on next frame and several times after fonts/layouts settle.
    //
    // The 0/120/400/1200ms ladder catches:
    //   0    — current frame after Solid mount
    //   120  — after style + font load
    //   400  — after async data populates the parent (e.g. session list
    //          finishes loading and chat-tile body grows)
    //   1200 — after the user has likely seen the chat — last safety net for
    //          the "text in a narrow column" rendering bug, which happens
    //          when fit() grabbed cols from a stale layout snapshot.
    //
    // FitAddon no-ops when grid size hasn't changed, so extra fits are cheap.
    const refit = () => {
      try {
        fitAddon?.fit();
      } catch {
        /* term may already be disposed */
      }
    };
    requestAnimationFrame(refit);
    setTimeout(refit, 120);
    setTimeout(refit, 400);
    setTimeout(refit, 1200);

    if (props.autoFocus) {
      term.focus();
    }

    let outputRaf: number | undefined;
    let outputQueue: Uint8Array[] = [];
    let outputQueuedBytes = 0;
    let outputWriteInFlight = false;
    let watermark = 0;
    let ptyPaused = false;
    const FLOW_HIGH = 256 * 1024; // 256KB — pause PTY reader
    const FLOW_LOW = 32 * 1024; // 32KB — resume PTY reader
    let pendingExitPayload: {
      exit_code: number | null;
      signal: string | null;
      last_output: string[];
    } | null = null;

    function emitExit(payload: {
      exit_code: number | null;
      signal: string | null;
      last_output: string[];
    }) {
      if (!term) return;
      term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
      props.onExit?.(payload);
    }

    function flushOutputQueue() {
      if (!term || outputWriteInFlight || outputQueue.length === 0) return;

      const chunks = outputQueue;
      const totalBytes = outputQueuedBytes;
      outputQueue = [];
      outputQueuedBytes = 0;

      let payload: Uint8Array;
      if (chunks.length === 1) {
        payload = chunks[0];
      } else {
        payload = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          payload.set(chunk, offset);
          offset += chunk.length;
        }
      }

      const statusPayload =
        payload.length > STATUS_ANALYSIS_MAX_BYTES
          ? payload.subarray(payload.length - STATUS_ANALYSIS_MAX_BYTES)
          : payload;

      outputWriteInFlight = true;
      // eslint-disable-next-line solid/reactivity -- write callback is not a reactive context
      term.write(payload, () => {
        outputWriteInFlight = false;
        watermark = Math.max(watermark - payload.length, 0);

        // Resume PTY reader when xterm.js has caught up
        if (watermark < FLOW_LOW && ptyPaused) {
          ptyPaused = false;
          invoke(IPC.ResumeAgent, { agentId }).catch(() => {
            ptyPaused = false;
          });
        }

        props.onData?.(statusPayload);
        try {
          maybeAutoTrust(decoder.decode(statusPayload, { stream: true }));
        } catch {
          /* ignore decoder glitches */
        }
        if (outputQueue.length > 0) {
          scheduleOutputFlush();
          return;
        }
        if (pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      });
    }

    function scheduleOutputFlush() {
      if (outputRaf !== undefined) return;
      outputRaf = requestAnimationFrame(() => {
        outputRaf = undefined;
        flushOutputQueue();
      });
    }

    function enqueueOutput(chunk: Uint8Array) {
      outputQueue.push(chunk);
      outputQueuedBytes += chunk.length;
      watermark += chunk.length;

      // Pause PTY reader when xterm.js falls behind
      if (watermark > FLOW_HIGH && !ptyPaused) {
        ptyPaused = true;
        invoke(IPC.PauseAgent, { agentId }).catch(() => {
          ptyPaused = false;
        });
      }

      // Flush large bursts promptly to keep perceived latency low.
      if (outputQueuedBytes >= 64 * 1024) {
        flushOutputQueue();
      } else {
        scheduleOutputFlush();
      }
    }

    const onOutput = new Channel<PtyOutput>();
    let initialCommandSent = false;
    // Holds PTY output bytes until the transcript has been written
    // (or the safety timeout fired). For resumed chats we spawn PTY
    // immediately to avoid a "black screen for several seconds"
    // experience, but we don't want claude's banner to land in xterm
    // BEFORE the transcript — that order is what makes the transcript
    // appear above the banner in scrollback. So early bytes go to
    // this buffer; once flushed the gate stays open and bytes flow
    // straight to enqueueOutput.
    let prePtyGateOpen = false;
    const prePtyBuffer: Uint8Array[] = [];
    function openPrePtyGate() {
      if (prePtyGateOpen) return;
      prePtyGateOpen = true;
      while (prePtyBuffer.length > 0) {
        const chunk = prePtyBuffer.shift();
        if (chunk) enqueueOutput(chunk);
      }
    }
    onOutput.onmessage = (msg) => {
      if (msg.type === 'Data') {
        const bytes = base64ToUint8Array(msg.data);
        if (prePtyGateOpen) {
          enqueueOutput(bytes);
        } else {
          prePtyBuffer.push(bytes);
        }
        if (!initialCommandSent && props.initialCommand) {
          const cmd = props.initialCommand;
          initialCommandSent = true;
          setTimeout(() => enqueueInput(cmd + '\r'), 50);
        }
      } else if (msg.type === 'Exit') {
        // On exit, always flush whatever's buffered so the user
        // doesn't miss diagnostics.
        openPrePtyGate();
        pendingExitPayload = msg.data;
        flushOutputQueue();
        if (!outputWriteInFlight && outputQueue.length === 0 && pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      }
    };

    let inputBuffer = '';
    let pendingInput = '';
    let inputFlushTimer: number | undefined;

    function flushPendingInput() {
      if (!pendingInput) return;
      const data = pendingInput;
      pendingInput = '';
      if (inputFlushTimer !== undefined) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = undefined;
      }
      fireAndForget(IPC.WriteToAgent, { agentId, data });
      if (!props.isShell && (data.includes('\r') || data.includes('\n'))) {
        setTaskLastInputAt(props.taskId);
      }
    }

    function enqueueInput(data: string) {
      pendingInput += data;
      if (pendingInput.length >= 2048) {
        flushPendingInput();
        return;
      }
      if (inputFlushTimer !== undefined) return;
      // eslint-disable-next-line solid/reactivity
      inputFlushTimer = window.setTimeout(() => {
        inputFlushTimer = undefined;
        flushPendingInput();
      }, 8);
    }

    // eslint-disable-next-line solid/reactivity -- event handler reads current prop values intentionally
    term.onData((data) => {
      if (props.onPromptDetected) {
        for (const ch of data) {
          if (ch === '\r') {
            const trimmed = inputBuffer.trim();
            if (trimmed) props.onPromptDetected?.(trimmed);
            inputBuffer = '';
          } else if (ch === '\x7f') {
            inputBuffer = inputBuffer.slice(0, -1);
          } else if (ch === '\x03' || ch === '\x15') {
            inputBuffer = '';
          } else if (ch === '\x1b') {
            // Skip escape sequences — break out, rest of data may contain seq chars
            break;
          } else if (ch >= ' ') {
            inputBuffer += ch;
          }
        }
      }
      enqueueInput(data);
    });

    // Claude Code repaints the whole transcript on every PTY resize, and
    // each repaint leaves a stale copy in scrollback ("скомканная история"
    // in long sessions). Coalesce: the PTY hears the FINAL size of a drag
    // / grid reflow, with a 1s heartbeat during continuous resizes.
    const resizeCoalescer = createResizeCoalescer((cols, rows) => {
      fireAndForget(IPC.ResizeAgent, { agentId, cols, rows });
    });

    term.onResize(({ cols, rows }) => {
      resizeCoalescer.push(cols, rows);
    });

    // Only disable cursor blink for non-focused terminals to save one RAF
    // loop per terminal.
    createEffect(() => {
      if (!term) return;
      term.options.cursorBlink = props.isFocused === true;
    });

    // Auto-focus the terminal whenever it becomes the active chat — covers
    // both initial open ("I clicked Resume, why can't I type?") and TopSwitcher
    // chip clicks (clicking another chat tab should focus its terminal).
    // Without this, the user has to click inside the xterm container before
    // typing — which the user reported as a UX paper-cut.
    createEffect(() => {
      if (!term) return;
      if (props.isFocused === true) {
        // Defer to next frame so a fresh tile that just mounted has its
        // canvas in the DOM — focus() on a 0×0 element is a no-op.
        requestAnimationFrame(() => {
          try {
            term?.focus();
          } catch {
            /* disposed */
          }
        });
      }
    });

    // Load WebGL addon for all terminals. On context loss (e.g. too many
    // WebGL contexts), the terminal gracefully falls back to the DOM renderer.
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = undefined;
      });
      term.loadAddon(webglAddon);
    } catch {
      // WebGL2 not supported — DOM renderer used automatically
    }

    // Merge global Terminal Defaults (from Agents view) with task-specific props.
    // Merge rules live in lib/terminal-spawn-merge.ts and are unit-tested.
    const defaults = terminalDefaults();
    const commandLooksClaude = /(^|[\\/])claude(?:\.(?:exe|cmd|bat))?$/i.test(props.command ?? '');
    // Auto-trust folders: when the global App-preferences toggle is on, and
    // the command is a Claude binary, auto-append --dangerously-skip-permissions
    // so the user isn't prompted "Trust this folder?" on every resume.
    const autoFlags =
      store.autoTrustFolders && commandLooksClaude ? ['--dangerously-skip-permissions'] : [];
    const rawArgs = mergeSpawnArgs(props.args, defaults.flags, autoFlags);
    // Filter out flags the resolved claude binary's --help doesn't list,
    // so a future CLI update that drops e.g. --remote-control doesn't
    // crash spawn. Capabilities come from listAgents() probing the bin.
    const agentDef = store.availableAgents.find((a) => a.id === props.agentId);
    const supportedFlags = agentDef?.capabilities
      ? new Set(agentDef.capabilities.supportedFlags)
      : undefined;
    const mergedArgs = commandLooksClaude ? filterArgsBySupport(rawArgs, supportedFlags) : rawArgs;
    const mergedEnv = mergeSpawnEnv(defaults, props.env);

    // Belt-and-braces fallback: Claude shows a blocking "Trust this folder?"
    // prompt and IDLES until answered. On --resume (restored / branched tiles)
    // that froze the tile — the conversation sat hidden in scrollback above an
    // unanswered prompt ("история замирает и её не видно"), and a crash restart
    // froze EVERY restored tile at once. We auto-press Enter on the folder-trust
    // prompt for resumed sessions regardless of the global toggle (resuming a
    // session means the user already worked in — and trusts — that folder). The
    // decision (incl. the destructive-output safety exclusion) lives in the
    // unit-tested lib/auto-trust.ts. NB: this does NOT skip per-tool permission
    // prompts — only the folder-trust dialog.
    const isResumeSpawn = commandLooksClaude && mergedArgs.includes('--resume');
    // eslint-disable-next-line no-control-regex
    const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]/g;
    let trustTail = '';
    let lastTrustSendAt = 0;
    function maybeAutoTrust(decoded: string) {
      if (!commandLooksClaude) return;
      const now = Date.now();
      if (now - lastTrustSendAt < 2500) return; // cooldown
      trustTail = (trustTail + decoded).slice(-2048);
      const plain = trustTail.replace(ANSI_STRIP, '');
      if (
        !shouldAutoConfirmFolderTrust({
          text: plain,
          commandLooksClaude,
          isResume: isResumeSpawn,
          autoTrustEnabled: store.autoTrustFolders,
        })
      ) {
        return;
      }
      lastTrustSendAt = now;
      trustTail = '';
      invoke(IPC.WriteToAgent, { agentId, data: '\r' }).catch(() => {
        /* swallow: worst case the user presses Enter manually */
      });
    }
    const decoder = new TextDecoder('utf-8', { fatal: false });

    // Transcript pre-fill for resumed claude chats. claude --resume
    // does NOT replay conversation history (verified empirically on
    // 2.1.116 and 2.1.162: <1KB banner + trust prompt, then idle), so
    // after an app restart every resumed tile would show an empty
    // scrollback. We render the session JSONL into claude-native-style
    // text (●/⎿/❯ — see electron/ipc/session-transcript.ts) and write
    // it into xterm BEFORE the first PTY byte; the prePtyGate holds
    // claude's banner until the transcript landed. The claude TUI
    // itself is untouched — we only pre-seed xterm's scrollback.
    //
    // VARIANT A (2026-06-17): prefill into the LIVE terminal is now OFF
    // (shouldLiveTerminalPrefill() === false) — pre-seeding the same xterm
    // that claude repaints caused the «надлом/каша» seam on resize. The
    // full history now lives in the read-only TranscriptView (📖 toggle),
    // which renders the SAME JSONL without a competing live TUI. The live
    // terminal stays clean like upstream parallel-code. See the rationale
    // (and revert switch) in src/lib/transcript-prefill.ts.
    const resumeIdx = mergedArgs.indexOf('--resume');
    const resumeCandidate = resumeIdx >= 0 ? mergedArgs[resumeIdx + 1] : undefined;
    const resumeSessionId =
      commandLooksClaude &&
      !props.isShell &&
      resumeCandidate &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resumeCandidate)
        ? resumeCandidate
        : undefined;
    if (resumeSessionId && shouldLiveTerminalPrefill()) {
      // Safety valve: never hold PTY output hostage if the transcript
      // IPC stalls (huge JSONL, slow disk) — open the gate after 3s.
      const gateTimer = window.setTimeout(openPrePtyGate, 3000);
      invoke<string>(IPC.LoadSessionTranscript, { sessionId: resumeSessionId })
        .then((transcript) => {
          // Write whenever the transcript loaded and the term is alive —
          // NOT only when the gate is still closed. If the IPC stalled
          // past the 3s gate (e.g. main process busy), the old `!gateOpen`
          // guard DROPPED the transcript and left empty scrollback. A late
          // transcript below the banner beats no transcript at all.
          if (shouldWriteTranscript({ transcript, termAlive: !!term })) {
            try {
              term?.write(transcript + '\r\n');
            } catch {
              /* terminal disposed while transcript was loading */
            }
          }
        })
        .catch(() => {
          /* transcript missing/unreadable — claude still spawns */
        })
        .finally(() => {
          clearTimeout(gateTimer);
          openPrePtyGate();
        });
    } else {
      queueMicrotask(openPrePtyGate);
    }

    invoke(IPC.SpawnAgent, {
      taskId,
      agentId,
      command: props.command,
      args: mergedArgs,
      cwd: props.cwd,
      env: mergedEnv,
      cols: term.cols,
      rows: term.rows,
      isShell: props.isShell,
      stepsEnabled: props.stepsEnabled,
      dockerMode: props.dockerMode,
      dockerImage: props.dockerImage,
      onOutput,
      // eslint-disable-next-line solid/reactivity -- promise catch handler reads current prop values intentionally
    }).catch((err) => {
      // eslint-disable-next-line no-control-regex -- intentionally stripping control/escape chars to prevent terminal injection
      const safeErr = String(err).replace(/[\x00-\x1f\x7f]/g, '');
      openPrePtyGate();
      term?.write(`\x1b[31mFailed to spawn: ${safeErr}\x1b[0m\r\n`);
      props.onExit?.({
        exit_code: null,
        signal: 'spawn_failed',
        last_output: [`Failed to spawn: ${safeErr}`],
      });
    });

    onCleanup(() => {
      flushPendingInput();
      // No final-resize flush: the PTY is killed right below anyway.
      resizeCoalescer.dispose();
      if (inputFlushTimer !== undefined) clearTimeout(inputFlushTimer);
      if (outputRaf !== undefined) cancelAnimationFrame(outputRaf);
      if (whisperFlushInterval !== undefined) clearInterval(whisperFlushInterval);
      onOutput.cleanup?.();
      offBridge();
      webglAddon?.dispose();
      webglAddon = undefined;
      unregisterTerminal(agentId);
      // kill_agent already clears paused flag before killing
      fireAndForget(IPC.KillAgent, { agentId });
      term?.dispose();
    });
  });

  createEffect(() => {
    const size = props.fontSize;
    if (size === undefined || !term || !fitAddon) return;
    term.options.fontSize = size;
    markDirty(props.agentId);
  });

  createEffect(() => {
    const font = store.terminalFont;
    if (!term || !fitAddon) return;
    term.options.fontFamily = getTerminalFontFamily(font);
    markDirty(props.agentId);
  });

  createEffect(() => {
    const preset = store.themePreset;
    if (!term) return;
    term.options.theme = getTerminalTheme(preset);
    markDirty(props.agentId);
  });

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        padding: '4px 0 0 4px',
      }}
    />
  );
}
