/**
 * e2e/branches-terminal-survives-tabs.spec.ts
 *
 * Regression test for: switching away from the Branches tab kills the PTY.
 *
 * Root cause: src/App.tsx wraps <TilingLayout> in
 *   <Show when={mainView() === 'branches'}>
 * which UNMOUNTS the whole subtree on any tab switch. TerminalView.onCleanup
 * fires → KillAgent IPC → PTY dies. Switching back renders a fresh (empty)
 * terminal — content is gone and the process is dead.
 *
 * The fix should mirror the ProjectsPanel approach: keep the subtree in the
 * DOM at all times via display:none toggling, never via conditional mounting.
 *
 * This test MUST FAIL on the current code (red) and pass once the fix lands.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, awaitChatReady } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.afterAll(async () => {
  if (app) await app.close();
});

test('Branches terminal PTY survives a tab switch to History and back', async () => {
  // Step 1: Navigate to Branches tab.
  await win.locator('.ts-nav', { hasText: 'Branches' }).click();
  await win.waitForTimeout(400);
  await expect(win.locator('.ts-nav--active')).toHaveText(/Branches/);

  // Step 2: Create a plain terminal via the "New terminal" button in the
  // NewTaskPlaceholder strip that TilingLayout always renders on the right.
  // This avoids any dependency on a configured project or git repo.
  const addTerminalBtn = win.locator('[aria-label="New terminal"]');
  const hasBtnNow = (await addTerminalBtn.count()) > 0;
  if (!hasBtnNow) {
    test.skip(true, 'New terminal button not found — TilingLayout not mounted');
    return;
  }
  await addTerminalBtn.click();
  await win.waitForTimeout(600);

  // Step 3: Wait for the xterm inside the tiling layout to appear and
  // for the PTY to produce at least one line of output.
  const xtermSelector = '.tiling-layout-shell .xterm';
  await expect(win.locator(xtermSelector).first()).toBeVisible({ timeout: 8_000 });
  await awaitChatReady(win, 10_000, xtermSelector);

  // Step 4: Capture the DOM element handle — identity check below
  // proves the element was NOT unmounted and remounted.
  const handleBefore = await win.locator(xtermSelector).first().elementHandle();
  expect(handleBefore, 'xterm element must exist before tab switch').not.toBeNull();

  // Also snapshot the buffer length so we can assert it survived.
  const bufLenBefore = await win.evaluate((sel) => {
    type XtermEl = HTMLElement & { __term?: { buffer: { active: { length: number } } } };
    const el = document.querySelector(sel) as XtermEl | null;
    return el?.__term?.buffer.active.length ?? 0;
  }, xtermSelector);

  // Step 5: Click History tab — this is the action that triggers the bug.
  await win.locator('.ts-nav', { hasText: 'History' }).click();

  // Step 6: Give SolidJS time to run any onCleanup / remount cycles.
  await win.waitForTimeout(500);

  // Step 7: Return to Branches tab.
  await win.locator('.ts-nav', { hasText: 'Branches' }).click();

  // Step 8: Short settle.
  await win.waitForTimeout(500);

  // Step 9a: The SAME DOM element must still be present — if the <Show>
  // unmounted and remounted it, the handle will point to a detached node
  // and the querySelector will return a different (new) element.
  //
  // On CURRENT BUGGY code this assertion fails because the old node is
  // detached and a fresh one was created.
  const isSameElement = await win.evaluate(
    ([sel, h]) => {
      const current = document.querySelector(sel);
      return current === (h as Element | null);
    },
    [xtermSelector, handleBefore] as [string, typeof handleBefore],
  );
  expect(
    isSameElement,
    'xterm DOM element must be the SAME object after tab round-trip ' +
      '(a new element means TilingLayout was unmounted → PTY killed)',
  ).toBe(true);

  // Step 9b: The buffer must still be alive — length > 0 means the PTY
  // wrote data into xterm before the switch and that data is still there.
  //
  // On CURRENT BUGGY code the new xterm starts empty (buffer.length === 0
  // or only pre-allocated blank rows with no content), confirming the PTY
  // was killed and a fresh one started.
  const bufLenAfter = await win.evaluate((sel) => {
    type XtermEl = HTMLElement & { __term?: { buffer: { active: { length: number } } } };
    const el = document.querySelector(sel) as XtermEl | null;
    return el?.__term?.buffer.active.length ?? 0;
  }, xtermSelector);

  expect(
    bufLenAfter,
    `xterm buffer must have content after round-trip ` +
      `(was ${bufLenBefore} before, got ${bufLenAfter} after — ` +
      `0 means PTY was killed and terminal remounted empty)`,
  ).toBeGreaterThan(0);
});
