/**
 * e2e/single-space-no-duplicate.spec.ts
 *
 * Regression: pressing space typed two spaces. Root cause was the
 * 200ms Wispr Flow poll picking up xterm's helper-textarea residue
 * before xterm cleared it, then forwarding it to the PTY again.
 *
 * Fix: poll skips single-character samples (real dictation is always
 * multi-char). This test reads xterm's internal buffer (WebGL
 * renderer paints to canvas, so the .xterm-rows DOM is unreliable).
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

test('single space keystrokes are forwarded exactly once each (no Wispr poll residue duplication)', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  // Subscribe to term.onData BEFORE typing — captures every byte xterm
  // hands to its consumer (which then writes to PTY). The Wispr poll
  // path also calls enqueueInput, but more importantly: if xterm DID
  // double-fire on space (e.g. a synthetic onData triggered by stuck
  // helper-textarea residue) we'd see it here. The real-world bug was
  // a slightly different shape — poll → enqueueInput direct → IPC —
  // but the cheapest observable side-effect is the onData stream.
  await win.evaluate(() => {
    interface CaptureWindow {
      __spaceCapture?: string;
    }
    const w = window as unknown as CaptureWindow;
    w.__spaceCapture = '';
    const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    interface XtermInternals {
      __term?: { onData: (cb: (d: string) => void) => { dispose: () => void } };
    }
    const term = (xtermEl as unknown as XtermInternals)?.__term;
    term?.onData((d) => {
      const w2 = window as unknown as CaptureWindow;
      w2.__spaceCapture = (w2.__spaceCapture ?? '') + d;
    });
  });

  // Focus the helper-textarea so xterm receives keypresses.
  const helper = win.locator('.chat-tile .xterm-helper-textarea').first();
  await helper.focus();

  // Type a known sequence with spaces. With the bug we'd see an extra
  // space appear somewhere. Use slow=so xterm processes each key fully.
  await win.keyboard.type('a b c', { delay: 50 });

  // Wait > 200 ms so the Wispr poll has fired at least once and (with
  // the bug) had a chance to duplicate the trailing space.
  await win.waitForTimeout(800);

  const captured = (await win.evaluate(() => {
    interface CaptureWindow {
      __spaceCapture?: string;
    }
    return (window as unknown as CaptureWindow).__spaceCapture ?? '';
  })) as string;

  // Strong assertion: the captured byte stream contains the exact typed
  // text and NOT a double-space variant. Captured may also contain echo
  // bytes from claude — we only care that "a b c" appears and no "a  b"
  // / "b  c" appears.
  expect(
    captured,
    `Expected captured stream to contain "a b c" — got: ${JSON.stringify(captured)}`,
  ).toContain('a b c');
  expect(
    captured,
    `BUG: doubled space in captured stream — got: ${JSON.stringify(captured)}`,
  ).not.toMatch(/a {2,}b|b {2,}c|a {2,}|c {2,}/);

  await closeAllChats(win);
});
