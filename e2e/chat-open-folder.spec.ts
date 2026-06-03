/**
 * e2e/chat-open-folder.spec.ts
 *
 * Pins the new feature: right-click on the chat tile head opens a menu
 * with an "Open folder" item that calls `open_path` with the chat's
 * working directory.
 *
 * Note on test scope: contextBridge-exposed objects are frozen by
 * Electron (security model), so we can't stub `window.electron.ipcRenderer.invoke`
 * directly from the renderer to spy on the call. Instead we install a
 * passthrough JS wrapper around `lib/ipc`'s `invoke` indirectly — but
 * that's invasive. The pragmatic test guards the regression we care
 * about: the menu item exists, has the right text and title, and
 * clicking it closes the menu (proves the handler ran). The real-world
 * "did Explorer open" is checked manually.
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

test('right-click chat tile shows "Open folder" item bound to chat cwd', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  // The chat tile's title attribute is bound to props.chat.cwd — read it
  // so we can assert the menu item's `title` matches.
  const expectedCwd = await win.evaluate(() => {
    const tile = document.querySelector('.chat-tile') as HTMLElement | null;
    const titleEl = tile?.querySelector('.chat-tile__title') as HTMLElement | null;
    return titleEl?.getAttribute('title') ?? null;
  });
  expect(expectedCwd, 'chat tile must expose its cwd in title attribute').toBeTruthy();

  // Right-click the tile head to open the context menu.
  const head = win.locator('.chat-tile .chat-tile__head').first();
  await head.click({ button: 'right' });

  const menu = win.locator('.chat-tile__menu').first();
  await expect(menu).toBeVisible({ timeout: 3_000 });

  // The new item must be present.
  const openFolderBtn = menu.locator('button', { hasText: /open folder/i });
  await expect(openFolderBtn).toBeVisible({ timeout: 2_000 });

  // The button's title attribute carries the cwd — proves the binding
  // resolved against the real chat object (not undefined / stale).
  const btnTitle = await openFolderBtn.getAttribute('title');
  expect(btnTitle, 'Open folder button must carry the chat cwd in its title').toBe(expectedCwd);

  // Click should close the menu (proves the handler ran). We can't
  // verify the IPC call from a stub (contextBridge is frozen), but
  // menu-closes-on-click is observable.
  await openFolderBtn.click();
  await expect(menu).toBeHidden({ timeout: 2_000 });

  await closeAllChats(win);
});
