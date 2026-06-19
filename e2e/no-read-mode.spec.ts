/**
 * e2e/no-read-mode.spec.ts
 *
 * The read mode (📖) was parked (src/_parked/read-mode/) and auto-engage on
 * wheel-up was removed. The live claude terminal is now plain xterm, like
 * upstream parallel-code. This proves, in a real Electron window against a
 * real resumed claude:
 *
 *  - there is NO 📖 read-mode button on the tile;
 *  - wheeling UP over the live terminal does NOT open any read pane;
 *  - the live terminal stays mounted/visible the whole time.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, closeAllChats, openChatWithHistory } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});
test.afterAll(async () => {
  if (!app) return;
  await closeAllChats(win).catch(() => undefined);
  await app.close();
});

test('live claude terminal is bare: no 📖 button, wheel-up never opens a read pane', async () => {
  await openChatWithHistory(win);

  // No read-mode button anywhere.
  expect(await win.locator('.chat-tile__read').count()).toBe(0);
  // No read pane present at rest.
  expect(await win.locator('.chat-tile__read-pane').count()).toBe(0);

  const xterm = win.locator('.chat-tile .xterm').first();
  await expect(xterm).toBeVisible();
  const box = await xterm.boundingBox();
  if (!box) throw new Error('no terminal box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Wheel UP several times over the live terminal — must NOT engage any read
  // pane (the auto-engage was removed).
  await win.mouse.move(cx, cy);
  for (let i = 0; i < 6; i++) {
    await win.mouse.wheel(0, -200);
    await win.waitForTimeout(120);
  }
  await win.waitForTimeout(500);

  expect(
    await win.locator('.chat-tile__read-pane').count(),
    'wheel-up must not open a read pane (read mode is parked)',
  ).toBe(0);
  // Live terminal still there.
  await expect(win.locator('.chat-tile__live .xterm').first()).toBeVisible();
});
