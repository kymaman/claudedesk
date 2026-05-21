/**
 * e2e/right-click-rename.spec.ts
 *
 * RED tests: right-click Rename is not yet implemented.
 *
 * Case 1 — right-click on a session row in History shows a Rename
 *           item in the context menu.
 * Case 2 — right-click on an open chat tile shows a context menu
 *           with a Rename item.
 *
 * Both tests MUST FAIL on current code and pass once the feature
 * is added.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, openOneChat, closeAllChats } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

// Windows + node-pty + Electron sometimes takes >30s to release PTY handles
// during app.close(). Bump the hook timeout — assertions are fast, only
// teardown lingers.
test.describe.configure({ timeout: 180_000 });
test.afterAll(async () => {
  if (!app) return;
  try {
    // Drain any open chats so PTYs aren't holding the renderer hostage at close.
    await closeAllChats(win).catch(() => undefined);
    await win.waitForTimeout(300);
  } catch {
    /* ignore — we're tearing down */
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// 1. History session-row right-click menu has a Rename item
// ---------------------------------------------------------------------------

test('right-click on a session row in History shows a Rename item in the menu', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);

  const firstRow = win.locator('.session-item').first();
  if ((await firstRow.count()) === 0) {
    test.skip(true, 'no sessions');
  }

  await firstRow.click({ button: 'right' });

  const menu = firstRow.locator('.session-item__menu');
  await expect(menu).toBeVisible({ timeout: 3_000 });

  // This assertion FAILS on current code — the menu only has
  // Delete / Cancel, not Rename.
  const renameBtn = menu.locator('button', { hasText: /Rename/i });
  await expect(renameBtn).toBeVisible({ timeout: 2_000 });
});

// ---------------------------------------------------------------------------
// 2. Open chat-tile head right-click menu has a Rename item
// ---------------------------------------------------------------------------

test('right-click on an open chat tile shows a context menu with Rename', async () => {
  await openOneChat(win);

  // Right-click the chat tile header / title area.
  // We prefer .chat-tile__title; fall back to .chat-tile__head.
  const tile = win.locator('.chat-tile').first();
  await expect(tile).toBeVisible({ timeout: 5_000 });

  const titleLocator = tile.locator('.chat-tile__title').first();
  const headLocator = tile.locator('.chat-tile__head').first();

  const target = (await titleLocator.count()) > 0 ? titleLocator : headLocator;
  await target.click({ button: 'right' });

  // The feature doesn't exist yet — this selector will NOT be found,
  // so toBeVisible() fails (that is the intended RED behaviour).
  const menu = tile.locator('.chat-tile__menu');
  await expect(menu).toBeVisible({ timeout: 2_000 });

  const renameBtn = menu.locator('button', { hasText: /Rename/i });
  await expect(renameBtn).toBeVisible({ timeout: 2_000 });

  // Dismiss the menu and the chat so app.close() in afterAll doesn't hang
  // waiting for the open menu/tile to release focus.
  await win.keyboard.press('Escape');
  await closeAllChats(win);
});
