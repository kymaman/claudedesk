/**
 * e2e/wispr-flow-dictation.spec.ts
 *
 * Pins the Wispr Flow dictation fix:
 *
 *   BUG: With N chat tiles open, N a11y-exposed .xterm-helper-textareas exist.
 *        Wispr Flow wrote to the wrong one; only the Ask sidebar (lone terminal,
 *        isFocused=undefined) worked reliably.
 *
 *   FIX (TerminalView.tsx): a11y exposure depends on `props.isFocused`:
 *     - false  → background tile: left:-9999px, aria-hidden="true", tabIndex=-1
 *     - true   → active tile:     left:0 (1×1), aria-hidden absent, tabIndex=0
 *     - undefined → Ask sidebar lone terminal: exposed (must not regress)
 *
 *   ChatsGrid.tsx passes `isFocused={isActive()}` to each tile's TerminalView
 *   where isActive = activeChatId() === chat.id.
 *
 * Test steps:
 *   1. Open TWO chats from History (test.skip if < 2 sessions).
 *   2. Assert exactly ONE helper-textarea is a11y-exposed.
 *   3. Click the other tile → assert exposed textarea moved.
 *   4. Wispr injection into ACTIVE tile → textarea cleared (consumed).
 *   5. Wispr injection into BACKGROUND tile → guarded, active tile unchanged.
 *   6. Cleanup.
 */

import { test, expect } from '@playwright/test';
import { launchApp, closeAllChats } from './helpers.js';
import type { ElectronApplication, Page } from '@playwright/test';

let app: ElectronApplication;
let win: Page;

test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.afterAll(async () => {
  if (!app) return;
  try {
    await closeAllChats(win).catch(() => undefined);
  } catch {
    /* ignore */
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the History panel and resume the Nth session (0-indexed). */
async function openChatN(win: Page, n: number): Promise<void> {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const row = win.locator('.session-item').nth(n);
  await row.locator('.session-item__resume').click();
  await win.waitForTimeout(600);
}

/**
 * Returns, for each .chat-tile, whether its helper-textarea is a11y-exposed:
 *   { left: computed left style, ariaHidden: value of aria-hidden attr (null=absent) }
 */
async function getTextareaA11yStates(
  win: Page,
): Promise<Array<{ left: string; ariaHidden: string | null }>> {
  return win.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('.chat-tile'));
    return tiles.map((tile) => {
      const ta = tile.querySelector('.xterm-helper-textarea') as HTMLElement | null;
      if (!ta) return { left: 'missing', ariaHidden: 'missing' };
      const computed = window.getComputedStyle(ta).left;
      const ariaHidden = ta.getAttribute('aria-hidden');
      return { left: computed, ariaHidden };
    });
  });
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

test('Wispr Flow dictation: only the active tile is a11y-exposed', async () => {
  // --- Step 1: Open 2 chats --------------------------------------------------
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const sessionCount = await win.locator('.session-item').count();
  if (sessionCount < 2) {
    test.skip(true, 'Need at least 2 history sessions to open 2 chats');
    return;
  }

  await openChatN(win, 0);
  await openChatN(win, 1);

  // Wait for both tiles to mount their xterm content
  await expect(win.locator('.chat-tile')).toHaveCount(2, { timeout: 8_000 });
  await expect(win.locator('.chat-tile .xterm').first()).toBeVisible({ timeout: 6_000 });
  await win.waitForTimeout(600); // let createEffect run and park background textarea

  // --- Step 2: Exactly one textarea is a11y-exposed -------------------------
  const statesBefore = await getTextareaA11yStates(win);

  const exposedBefore = statesBefore.filter((s) => s.ariaHidden === null && s.left !== '-9999px');
  const hiddenBefore = statesBefore.filter((s) => s.ariaHidden === 'true');

  expect(
    exposedBefore.length,
    `Expected exactly 1 a11y-exposed textarea before tile switch, got ${exposedBefore.length}. States: ${JSON.stringify(statesBefore)}`,
  ).toBe(1);
  expect(
    hiddenBefore.length,
    `Expected exactly 1 aria-hidden textarea before tile switch, got ${hiddenBefore.length}. States: ${JSON.stringify(statesBefore)}`,
  ).toBe(1);

  // --- Step 3: Click the OTHER tile; exposed textarea must move -------------
  // The active tile is the LAST one opened (second resume). We click the
  // first tile to switch focus.
  const tiles = win.locator('.chat-tile');
  await tiles.first().click();
  await win.waitForTimeout(400); // createEffect re-runs

  const statesAfter = await getTextareaA11yStates(win);
  const exposedAfter = statesAfter.filter((s) => s.ariaHidden === null && s.left !== '-9999px');
  const hiddenAfter = statesAfter.filter((s) => s.ariaHidden === 'true');

  expect(
    exposedAfter.length,
    `Expected exactly 1 a11y-exposed textarea after tile switch, got ${exposedAfter.length}. States: ${JSON.stringify(statesAfter)}`,
  ).toBe(1);
  expect(
    hiddenAfter.length,
    `Expected exactly 1 aria-hidden textarea after tile switch, got ${hiddenAfter.length}. States: ${JSON.stringify(statesAfter)}`,
  ).toBe(1);

  // The exposed tile must have changed (was tile index 1 → now tile index 0)
  // We verify by comparing which tile holds the exposed textarea.
  const exposedTileIndexBefore = statesBefore.findIndex(
    (s) => s.ariaHidden === null && s.left !== '-9999px',
  );
  const exposedTileIndexAfter = statesAfter.findIndex(
    (s) => s.ariaHidden === null && s.left !== '-9999px',
  );
  expect(
    exposedTileIndexAfter,
    `Exposed textarea tile index did not change after click (still ${exposedTileIndexAfter}). States before: ${JSON.stringify(statesBefore)}, after: ${JSON.stringify(statesAfter)}`,
  ).not.toBe(exposedTileIndexBefore);

  // --- Step 4: Wispr injection into ACTIVE tile → textarea cleared ----------
  const activeResult = await win.evaluate(async () => {
    // Find the currently a11y-exposed textarea (active tile).
    const tiles = Array.from(document.querySelectorAll('.chat-tile'));
    let activeTa: HTMLTextAreaElement | null = null;
    for (const tile of tiles) {
      const ta = tile.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      if (!ta) continue;
      if (ta.getAttribute('aria-hidden') === null) {
        activeTa = ta;
        break;
      }
    }
    if (!activeTa) return { error: 'no exposed textarea found', cleared: false };

    try {
      activeTa.value = 'wispr-dictated-text';
      activeTa.dispatchEvent(new Event('input', { bubbles: true }));
      // The input listener defers via queueMicrotask; also give the 200ms
      // flush interval a chance. Wait 400ms to be safe.
      await new Promise((r) => setTimeout(r, 400));
      return { error: null, cleared: activeTa.value === '' };
    } catch (err) {
      return { error: String(err), cleared: false };
    }
  });

  expect(
    activeResult.error,
    `Wispr injection into active tile threw: ${activeResult.error}`,
  ).toBeNull();
  expect(
    activeResult.cleared,
    'Active tile textarea was NOT cleared after Wispr injection — forwarding path did not consume it',
  ).toBe(true);

  // --- Step 5: Wispr injection into BACKGROUND tile → guarded ---------------
  // Active tile index is now exposedTileIndexAfter (first tile, index 0).
  // Background tile is the other one.
  const bgResult = await win.evaluate(async (activeIdx) => {
    const tiles = Array.from(document.querySelectorAll('.chat-tile'));
    const bgIdx = activeIdx === 0 ? 1 : 0;
    const bgTile = tiles[bgIdx];
    if (!bgTile) return { error: 'no background tile', unchanged: true };

    const bgTa = bgTile.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (!bgTa) return { error: 'no background textarea', unchanged: true };

    // Sanity: background textarea must be aria-hidden.
    if (bgTa.getAttribute('aria-hidden') !== 'true') {
      return { error: 'background textarea is NOT aria-hidden', unchanged: false };
    }

    // Find active textarea value before injection.
    const activeTile = tiles[activeIdx];
    const activeTa = activeTile?.querySelector(
      '.xterm-helper-textarea',
    ) as HTMLTextAreaElement | null;
    const activeBefore = activeTa?.value ?? '';

    try {
      bgTa.value = 'bg-injected-text';
      bgTa.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));

      const activeAfter = activeTa?.value ?? '';
      // Background guard must clear the bg textarea; active textarea must be unchanged.
      const bgCleared = bgTa.value === '';
      const activeUnchanged = activeAfter === activeBefore;
      return { error: null, bgCleared, activeUnchanged };
    } catch (err) {
      return { error: String(err), unchanged: true };
    }
  }, exposedTileIndexAfter);

  expect(bgResult.error, `Background injection threw: ${bgResult.error}`).toBeNull();
  // The guard must clear the bg textarea (defence-in-depth, not forwarded).
  expect(
    (bgResult as { bgCleared?: boolean }).bgCleared,
    'Background tile textarea was NOT cleared by the guard',
  ).toBe(true);
  // Active tile must remain untouched.
  expect(
    (bgResult as { activeUnchanged?: boolean }).activeUnchanged,
    'Active tile textarea was modified by background injection — forwarding guard failed',
  ).toBe(true);

  // --- Step 6: Cleanup -------------------------------------------------------
  await closeAllChats(win);
});
