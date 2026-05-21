/**
 * e2e/paste-then-enter-still-works.spec.ts
 *
 * RED test: reproduces the focus-loss bug after Ctrl+V paste in
 * TerminalView.tsx.
 *
 * Root cause:
 *   TerminalView.tsx calls term.paste(text) at lines 329-330 and 386-390
 *   but never calls term.focus() afterwards. xterm's attachCustomKeyEventHandler
 *   returns `false` for the paste action, which makes xterm's _keyDown return
 *   early — skipping the internal this.focus() call that normally runs on keydown.
 *   If the terminal was not already focused (user switched window/tab, app just
 *   reopened, TopSwitcher chip clicked), term.paste() does NOT restore focus and
 *   subsequent keyboard input is silently swallowed.
 *
 * Why plain document.activeElement doesn't catch this:
 *   On Electron/Chromium on Windows, setting textarea.value="" inside paste()
 *   does not trigger a browser blur event — the DOM focus stays on the textarea.
 *   The bug lives in xterm's own _coreBrowserService._isFocused flag, which is
 *   driven strictly by focus/blur events on the helper-textarea. Since term.blur()
 *   fires the blur event (clears _isFocused) but term.paste() does NOT call
 *   term.focus() (which would re-set _isFocused via the focus event), xterm thinks
 *   it is unfocused even though the DOM textarea still has the cursor.
 *   In this state xterm refuses to route keyboard events to the PTY.
 *
 * Test strategy (sharp RED/GREEN boundary):
 *   1. Open a chat, blur the xterm (simulating: user switched window/tab).
 *   2. Seed the clipboard, then trigger the REAL Ctrl+V keypress through
 *      page.keyboard.press — this routes through TerminalView's
 *      attachCustomKeyEventHandler at line 280, which is the code path the
 *      fix actually patches.
 *   3. Assert _coreBrowserService._isFocused is true after the keypress.
 *      → FAILS on current code  (no term.focus() in the handler → false)  [RED]
 *      → PASSES after fix       (term.focus() after term.paste() → true)   [GREEN]
 */

import { test, expect } from '@playwright/test';
import { launchApp, openOneChat, awaitChatReady, closeAllChats } from './helpers.js';
import type { ElectronApplication, Page } from '@playwright/test';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.afterAll(async () => {
  if (app) await app.close();
});

test('xterm must be focused after term.paste() — focus not restored on current code', async () => {
  // Step 1: open a chat and let the PTY start
  await openOneChat(win);
  await awaitChatReady(win);

  // Step 2a: seed the clipboard via the Electron bridge (synchronous read
  // path is what the Ctrl+V handler uses).
  await win.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (window as any).electron;
    bridge?.clipboardWriteText?.('hello');
  });

  // Step 2b: blur the terminal first so we can detect whether the handler
  // restores focus. Without blurring, xterm starts focused and any focus()
  // call would be a no-op — so we wouldn't catch the missing fix.
  const beforeKey = await win.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xtermEl = document.querySelector('.chat-tile .xterm') as any;
    if (!xtermEl?.__term) return { error: 'no __term' };
    const term = xtermEl.__term;
    const browserSvc = term?._core?._coreBrowserService;
    if (!browserSvc) return { error: 'no _coreBrowserService on _core' };

    // Start focused so the blur has real effect.
    term.focus();
    await new Promise((r) => setTimeout(r, 50));
    const beforeBlur = browserSvc._isFocused as boolean;
    term.blur();
    await new Promise((r) => setTimeout(r, 50));
    const afterBlur = browserSvc._isFocused as boolean;
    return { beforeBlur, afterBlur };
  });

  expect('error' in beforeKey).toBe(false);
  const before = beforeKey as { beforeBlur: boolean; afterBlur: boolean };
  expect(before.beforeBlur, 'terminal must start focused').toBe(true);
  expect(before.afterBlur, 'term.blur() must clear _isFocused').toBe(false);

  // Step 2c: send a REAL Ctrl+V keypress. This routes through
  // TerminalView's attachCustomKeyEventHandler — the same path the fix
  // patches. xterm's helper textarea must be the active element for the
  // keydown to reach it; focus() it programmatically (we want to test the
  // handler's focus-restore logic, not Playwright's keyboard targeting).
  await win.evaluate(() => {
    const ta = document.querySelector(
      '.chat-tile .xterm-helper-textarea',
    ) as HTMLTextAreaElement | null;
    ta?.focus({ preventScroll: true });
  });
  await win.keyboard.press('Control+V');
  await win.waitForTimeout(150);

  // Step 2d: read the focus flag after the handler ran.
  const result = await win.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xtermEl = document.querySelector('.chat-tile .xterm') as any;
    const term = xtermEl?.__term;
    const browserSvc = term?._core?._coreBrowserService;
    if (!browserSvc) return { error: 'no _coreBrowserService' };
    return { afterPaste: browserSvc._isFocused as boolean };
  });

  expect('error' in result).toBe(false);
  const r = result as { afterPaste: boolean };

  // ---------------------------------------------------------------
  // CORE ASSERTION — this is where current code fails.
  //
  // After Ctrl+V routes through the TerminalView handler that calls
  // term.paste(text), the handler MUST also call term.focus() so xterm's
  // _isFocused flag is restored. Without it, xterm refuses to route the
  // user's next keystrokes to the PTY (Enter, letters — all dropped).
  //
  // On buggy code  (TerminalView.tsx:330 has no term.focus()):
  //   afterPaste === false  → assertion FAILS  [RED]
  //
  // After fix (term.focus() added after term.paste()):
  //   afterPaste === true   → assertion PASSES [GREEN]
  // ---------------------------------------------------------------
  expect(
    r.afterPaste,
    'BUG: Ctrl+V paste did not restore xterm focus.\n' +
      'xterm._coreBrowserService._isFocused is false after the keypress.\n' +
      'The user cannot press Enter or type — keystrokes are silently dropped.\n' +
      'Fix: add `term?.focus()` after `term?.paste(text)` in TerminalView.tsx.',
  ).toBe(true);

  await closeAllChats(win);
});
