/**
 * TranscriptView.tsx — a clean, read-only view of a chat's conversation.
 *
 * Why this exists: Claude Code's live TUI repaints itself on every resize and
 * those repaints pile overlapping copies into xterm's normal-buffer scrollback
 * ("скомканная история / по рулям") — claude owns that rendering, so we can't
 * fully clean it. But the SAME conversation rendered from the session JSONL
 * (electron/ipc/session-transcript.ts → ●/⎿/❯) is verified clean. This view
 * shows that render in a read-only xterm with NO PTY attached, so the history
 * is always legible regardless of what the live TUI did.
 *
 * It is a sibling of TerminalView, NOT a replacement: the tile keeps the live
 * TerminalView mounted (hidden) so the PTY survives the toggle — unmounting it
 * would fire KillAgent (see the ref-stability contract in store/chats.ts).
 */

import { onMount, onCleanup, createEffect } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { getTerminalFontFamily } from '../lib/fonts';
import { getTerminalTheme } from '../lib/theme';
import { TERMINAL_SCROLLBACK_LINES } from '../lib/terminalConstants';
import { planWheelScroll } from '../lib/terminal-wheel';
import { store } from '../store/store';

const WHEEL_LINES_PER_NOTCH = 3;

interface TranscriptViewProps {
  /** Session whose JSONL to render. Undefined until claude mints one. */
  sessionId: string | undefined;
  fontSize: number;
  /** Bump to force a reload (e.g. each time the user opens read mode). */
  refreshKey?: number;
  /** Called when the user wheels DOWN while already at the bottom of the
   *  transcript — the tile uses this to hand back to the live terminal when
   *  read mode was auto-engaged by a scroll-up. */
  onReachedBottom?: () => void;
}

export function TranscriptView(props: TranscriptViewProps) {
  let containerRef!: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let webgl: WebglAddon | undefined;
  let loadSeq = 0;

  async function load() {
    if (!term) return;
    const seq = ++loadSeq;
    term.reset();
    const sid = props.sessionId;
    if (!sid) {
      term.write('\x1b[90m  История появится после первого сообщения в этом чате.\x1b[0m\r\n');
      return;
    }
    term.write('\x1b[90m  Загружаю историю…\x1b[0m');
    try {
      const transcript = await invoke<string>(IPC.LoadSessionTranscript, { sessionId: sid });
      // A newer load started while we awaited — drop this stale result.
      if (!term || seq !== loadSeq) return;
      term.reset();
      if (transcript && transcript.length > 0) {
        // Start at the BOTTOM (most recent) so engaging read mode from the live
        // terminal is seamless — you continue from where you were.
        term.write(transcript, () => term?.scrollToBottom());
      } else {
        term.write('\x1b[90m  (история пуста)\x1b[0m\r\n');
      }
    } catch {
      if (term && seq === loadSeq) {
        term.reset();
        term.write('\x1b[31m  Не удалось загрузить историю этой сессии.\x1b[0m\r\n');
      }
    }
  }

  onMount(() => {
    term = new Terminal({
      fontSize: props.fontSize,
      fontFamily: getTerminalFontFamily(store.terminalFont),
      theme: getTerminalTheme(store.themePreset),
      scrollback: TERMINAL_SCROLLBACK_LINES,
      // Read-only: no PTY, no input. This is the whole point — nothing can
      // repaint or scramble what we render.
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
      scrollSensitivity: 3,
      fastScrollSensitivity: 12,
      // Smooth, animated scrolling (VS-Code-like). This is the whole reason
      // history scrolling lives here and not in the live claude terminal —
      // claude can only page-jump; here we scroll our own buffer by lines.
      smoothScrollDuration: 125,
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef);
    try {
      webgl = new WebglAddon();
      term.loadAddon(webgl);
    } catch {
      /* WebGL unavailable — DOM renderer still works */
    }
    try {
      fitAddon.fit();
    } catch {
      /* container not laid out yet */
    }
    // Expose the Terminal on the .xterm element for e2e buffer assertions
    // (mirrors TerminalView). Harmless in production.
    const xtermEl = containerRef.querySelector('.xterm');
    if (xtermEl) (xtermEl as unknown as { __term?: Terminal }).__term = term;

    // Wheel-to-scroll. This read pane is a STATIC, read-only buffer holding
    // the full transcript — it has real xterm scrollback, so we scroll xterm's
    // own scrollback by whole lines (smooth, line-level). When the user wheels
    // DOWN and is already at the bottom, we hand back to the live terminal
    // (onReachedBottom) — that's how auto-engaged read mode is dismissed.
    const onWheel = (e: WheelEvent) => {
      if (!term) return;
      const plan = planWheelScroll({
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        altScreen: term.buffer.active.type === 'alternate',
        claudeTui: false,
        ctrlKey: e.ctrlKey,
        linesPerNotch: WHEEL_LINES_PER_NOTCH,
      });
      if (plan.action !== 'scrollback') return;
      const b = term.buffer.active;
      const atBottom = b.viewportY >= b.baseY;
      if (plan.scrollLines > 0 && atBottom) {
        // Wheeling down at the bottom → back to the live terminal.
        props.onReachedBottom?.();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      term.scrollLines(plan.scrollLines);
      e.preventDefault();
      e.stopPropagation();
    };
    containerRef.addEventListener('wheel', onWheel, { capture: true, passive: false });

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            try {
              fitAddon?.fit();
            } catch {
              /* mid-teardown */
            }
          })
        : undefined;
    ro?.observe(containerRef);

    void load();

    onCleanup(() => {
      containerRef.removeEventListener('wheel', onWheel, { capture: true });
      ro?.disconnect();
      webgl?.dispose();
      term?.dispose();
      term = undefined;
    });
  });

  // Reload when the session id or the refresh key changes.
  createEffect(() => {
    // Track both so the effect re-runs on either change.
    void props.sessionId;
    void props.refreshKey;
    void load();
  });

  return (
    <div
      class="transcript-view"
      ref={containerRef}
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
    />
  );
}
