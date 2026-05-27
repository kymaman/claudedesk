/**
 * e2e/chat-tile-menu-outside-click.spec.ts
 *
 * Right-click on a chat tile head opens its context menu. Previously the
 * only way to dismiss it was the Cancel button — clicking anywhere else
 * left the menu stuck open. Now an outside mousedown OR pressing Escape
 * must close it, matching the History / Folder menus.
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

test('ChatTile menu closes on outside click', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  const head = win.locator('.chat-tile .chat-tile__head').first();
  await head.click({ button: 'right' });

  const menu = win.locator('.chat-tile__menu').first();
  await expect(menu).toBeVisible({ timeout: 3_000 });

  // Click somewhere clearly outside the menu and outside the tile head —
  // the History/title bar area near the top of the window.
  await win.mouse.click(5, 5);

  await expect(menu).toBeHidden({ timeout: 2_000 });

  await closeAllChats(win);
});

test('ChatTile menu closes on Escape', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  const head = win.locator('.chat-tile .chat-tile__head').first();
  await head.click({ button: 'right' });

  const menu = win.locator('.chat-tile__menu').first();
  await expect(menu).toBeVisible({ timeout: 3_000 });

  await win.keyboard.press('Escape');

  await expect(menu).toBeHidden({ timeout: 2_000 });

  await closeAllChats(win);
});
