/**
 * e2e/whisper-flow-paste.spec.ts
 *
 * RED test: Whisper Flow dictates text into focused inputs system-wide.
 * It works in Telegram and notes apps (plain <input>/<textarea>) but
 * NOT in our xterm. Hypothesis (after the bracketed-paste theory was
 * disproven): Whisper Flow injects text by ONE of these mechanisms:
 *
 *   M1) Dispatching a `paste` ClipboardEvent on document.activeElement
 *       (which would be `.xterm-helper-textarea` when xterm is focused).
 *   M2) Setting `activeElement.value = text` directly and dispatching
 *       an `input` event (or none).
 *   M3) Calling `document.execCommand('insertText', false, text)`.
 *
 * xterm.js handles its own keystroke→PTY pipeline via real keydown
 * events on the helper-textarea. If text appears via M1/M2/M3 instead,
 * xterm may not see it. The user reports text never reaches the PTY,
 * confirming at least one of these paths is blind.
 *
 * This test simulates M1 (the most common API for "type into focused
 * field" tools) on the helper-textarea and asserts the text reaches
 * the PTY via __term.onData. On current code the assertion fails for
 * at least one of the three methods. The fix will add a paste/input
 * listener on the .xterm container so any text injection lands in the
 * PTY regardless of method.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, openOneChat, awaitChatReady, closeAllChats } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.describe.configure({ timeout: 180_000 });
test.afterAll(async () => {
  if (!app) return;
  try {
    await closeAllChats(win).catch(() => undefined);
    await win.waitForTimeout(300);
  } catch {
    /* ignore */
  }
  await app.close();
});

test('paste ClipboardEvent on helper-textarea (Whisper Flow path) reaches PTY', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  const captured = await win.evaluate(async () => {
    const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    if (!xtermEl) throw new Error('no .xterm element on the page');

    interface XtermInternals {
      __term?: {
        onData: (cb: (d: string) => void) => { dispose: () => void };
      };
    }
    const term = (xtermEl as unknown as XtermInternals).__term;
    if (!term) throw new Error('Terminal instance not exposed');

    const buf: string[] = [];
    const sub = term.onData((d) => buf.push(d));

    // Find the helper-textarea xterm uses for input. Whisper Flow targets
    // document.activeElement; xterm focuses this textarea when the
    // terminal is focused.
    const ta = xtermEl.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (!ta) throw new Error('no helper-textarea');
    ta.focus();
    await new Promise((r) => setTimeout(r, 50));

    // Method M1: dispatch a real paste event with text — exactly what
    // Whisper Flow / many "type into focused field" tools do. We pass
    // the `clipboardData` via DataTransfer so the receiver can read it.
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello whisper');
    const evt = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(evt);

    await new Promise((r) => setTimeout(r, 200));
    sub.dispose();
    return buf.join('');
  });

  // After fix: capture should include "hello whisper". On current code
  // it's empty (xterm ignores synthetic paste events that don't go
  // through its own keydown pipeline).
  expect(
    captured,
    `BUG: paste ClipboardEvent on helper-textarea did NOT reach PTY.\n` +
      `Whisper Flow dictation is dropped because xterm only listens to real\n` +
      `keystrokes, not synthetic paste events from external tools.\n` +
      `Fix: add a 'paste' listener on .xterm container that forwards\n` +
      `event.clipboardData.getData('text') via enqueueInput.\n` +
      `Captured onData: ${JSON.stringify(captured)}`,
  ).toContain('hello whisper');

  await closeAllChats(win);
});
