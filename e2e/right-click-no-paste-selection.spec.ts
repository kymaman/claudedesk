/**
 * e2e/right-click-no-paste-selection.spec.ts
 *
 * Reproduces the user's "right-click pastes my selection into the
 * terminal" bug (reported 2026-06-15) and pins the fix.
 *
 * Mechanism: xterm's rightClickHandler mirrors the active selection into
 * its hidden helper-textarea so a native context-menu "Copy" works:
 *     moveTextAreaUnderMouseCursor(...);
 *     textarea.value = selectionService.selectionText;
 *     textarea.select();
 * Our 200ms Wispr-Flow poll in TerminalView reads that textarea, and the
 * OLD code treated the mirrored selection as externally-injected
 * dictation and forwarded it to the PTY — so on every right-click the
 * user's own selection got typed back into the terminal.
 *
 * The fix passes the live term.getSelection() into classifyInjectedText;
 * when the polled text equals the current selection it is recognised as
 * the copy-mirror and dropped.
 *
 * This test:
 *   1. Writes a known token into the terminal and selects the buffer.
 *   2. Captures everything that reaches the PTY via term.onData.
 *   3. Replays xterm's mirror (textarea.value = selectionText), waits
 *      for the poll, and asserts NOTHING reached the PTY.
 *   4. Negative control: injects DIFFERENT text (genuine dictation) while
 *      the same selection is active and asserts it STILL reaches the PTY
 *      — proving the guard isn't over-broad.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, openOneChat, awaitChatReady, closeAllChats } from './helpers.js';

let app: ElectronApplication;
let win: Page;

// Resuming a real session in openOneChat can transiently flake on a busy
// machine (tile slow to mount). The logic under test is deterministic;
// retry the whole spec so a setup hiccup doesn't mask a real result.
test.describe.configure({ retries: 2 });

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.afterAll(async () => {
  if (app) await app.close();
});

test('right-click selection mirror is NOT typed back into the PTY', async () => {
  await closeAllChats(win);
  await openOneChat(win);
  await awaitChatReady(win);

  const result = await win.evaluate(async () => {
    interface XtermInternals {
      __term?: {
        write: (t: string, cb?: () => void) => void;
        selectAll: () => void;
        getSelection: () => string;
        clearSelection: () => void;
        onData: (cb: (d: string) => void) => { dispose: () => void };
      };
    }
    const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    if (!xtermEl) throw new Error('no .chat-tile .xterm');
    const term = (xtermEl as unknown as XtermInternals).__term;
    if (!term) throw new Error('no __term');
    const ta = xtermEl.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (!ta) throw new Error('no helper textarea');

    // Put a known token in the buffer, then select everything so
    // getSelection() returns real, geometry-independent text.
    const token = 'SELECTME-12345';
    await new Promise<void>((r) => term.write('\r\n' + token + '\r\n', () => r()));
    await new Promise((r) => setTimeout(r, 60));
    term.selectAll();
    await new Promise((r) => setTimeout(r, 20));
    const selection = term.getSelection();

    const captured: string[] = [];
    const sub = term.onData((d) => captured.push(d));

    // Replay xterm's rightClickHandler mirror EXACTLY:
    //   textarea.value = selectionText; textarea.select();
    // The defining trait is the full select() — that's how the poll tells
    // the copy-mirror apart from dictation.
    ta.value = selection;
    ta.focus();
    ta.select();
    await new Promise((r) => setTimeout(r, 320)); // let the 200ms poll run
    const afterMirror = captured.join('');

    // Negative control: genuine injection — value set with the caret
    // COLLAPSED at the end (what Wispr Flow / SendInput do), NOT a full
    // selection. Made MULTI-LINE on purpose so it routes through the
    // 'paste' branch (term.paste, which term.onData observes); single-line
    // 'type' delivery goes via enqueueInput → IPC and is intentionally not
    // visible to onData. This must STILL reach the PTY.
    const dictationToken = 'GENUINE-DICTATION-9f3a';
    const dictation = dictationToken + '\nsecond injected line';
    ta.value = dictation;
    ta.selectionStart = ta.selectionEnd = dictation.length;
    await new Promise((r) => setTimeout(r, 320));
    const afterDictation = captured.join('');

    sub.dispose();
    term.clearSelection();
    return { selection, afterMirror, afterDictation, dictationToken };
  });

  // Precondition: the selection really contains our token.
  expect(result.selection, 'precondition: token should be selected').toContain('SELECTME-12345');

  // THE BUG: the mirrored selection must NOT have been forwarded to the PTY.
  expect(
    result.afterMirror,
    `right-click selection mirror leaked into the PTY: ${JSON.stringify(result.afterMirror)}`,
  ).toBe('');

  // Guard isn't over-broad: a genuine (caret-collapsed) injection still
  // arrives at the PTY — its token shows up in the captured stream.
  expect(
    result.afterDictation,
    'genuine injection (caret collapsed, not a full-select mirror) was wrongly suppressed',
  ).toContain(result.dictationToken);

  await closeAllChats(win);
});
