/**
 * e2e/paste-no-duplicate.spec.ts
 *
 * RED test for the "Ctrl+V pastes 3 times" bug. Cause: previously we
 * had THREE paths catching the same paste:
 *   1. xterm's native paste handler (writes once to PTY)
 *   2. our explicit `paste` ClipboardEvent listener on the helper-textarea
 *   3. our `input`-event listener that ran via queueMicrotask
 *
 * Result: a single Ctrl+V → 3 copies in the terminal.
 *
 * Fix: remove our paste/input listeners. The 200 ms safety-net poll
 * stays for Wispr Flow (which writes textarea.value programmatically
 * with no event). Regular Ctrl+V is xterm-only — exactly one byte
 * stream to the PTY.
 *
 * The assertion looks at the bytes xterm hands to `onData` after a
 * single Ctrl+V. With the bug active, the captured stream contains
 * the payload (or its bracketed-paste form) THREE times. With the
 * fix in place, it contains it exactly ONCE.
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

test('single Ctrl+V on xterm produces exactly one paste in the PTY stream', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  // Seed clipboard with a recognisable unique payload — easy to count.
  const PAYLOAD = `marker-${Date.now()}-uniq`;
  await win.evaluate((text) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (window as any).electron;
    bridge?.clipboardWriteText?.(text);
  }, PAYLOAD);

  // Focus the helper-textarea so xterm receives the keypress.
  await win.evaluate(() => {
    const ta = document.querySelector(
      '.chat-tile .xterm-helper-textarea',
    ) as HTMLTextAreaElement | null;
    ta?.focus({ preventScroll: true });
  });
  // Subscribe to __term.onData BEFORE the keypress so we capture every
  // byte xterm forwards to its consumer (which then writes to PTY).
  await win.evaluate(() => {
    interface CaptureWindow {
      __pasteCapture?: string;
    }
    const w = window as unknown as CaptureWindow;
    w.__pasteCapture = '';
    const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    if (!xtermEl) return;
    interface XtermInternals {
      __term?: {
        onData: (cb: (d: string) => void) => { dispose: () => void };
      };
    }
    const term = (xtermEl as unknown as XtermInternals).__term;
    if (!term) return;
    term.onData((d) => {
      const win2 = window as unknown as CaptureWindow;
      win2.__pasteCapture = (win2.__pasteCapture ?? '') + d;
    });
  });

  await win.keyboard.press('Control+V');
  // Give all three paths (xterm, listener, poll) a chance to fire if
  // they exist. The poll is 200 ms, so wait long enough to catch any
  // stragglers — if it duplicates, we want to see it.
  await win.waitForTimeout(700);

  const captured = (await win.evaluate(() => {
    interface CaptureWindow {
      __pasteCapture?: string;
    }
    return (window as unknown as CaptureWindow).__pasteCapture ?? '';
  })) as string;

  // Count occurrences of the unique payload.
  const occurrences = captured.split(PAYLOAD).length - 1;

  expect(
    occurrences,
    `BUG: Ctrl+V produced ${occurrences} copies of the payload in the PTY stream.\n` +
      `Captured (${captured.length} bytes): ${JSON.stringify(captured.slice(0, 300))}\n` +
      `Expected exactly 1. >1 = duplicate paste listeners are firing.`,
  ).toBe(1);

  await closeAllChats(win);
});
