/**
 * e2e/title-parity.spec.ts
 *
 * The title shown above the terminal (chat tile header) must match the title
 * shown in the History list for the same session — «название слева в истории и
 * сверху над терминалом — одни задачи». Verified by resuming a real session and
 * comparing the two rendered titles.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, awaitChatReady, closeAllChats } from './helpers.js';

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

test('tile header title matches the History row title for the session', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win
    .locator('.session-item')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => undefined);
  if ((await win.locator('.session-item').count()) === 0)
    test.skip(true, 'No real History sessions on disk');

  const row = win.locator('.session-item').first();
  const historyTitle = (await row.locator('.session-item__title').innerText()).trim();

  await row.locator('.session-item__resume').click();
  await win.locator('.chat-tile .xterm').first().waitFor({ state: 'visible', timeout: 45_000 });
  await awaitChatReady(win, 30_000).catch(() => undefined);
  // Let App's sessions→tile title effect settle.
  await win.waitForTimeout(800);

  const tileTitle = (await win.locator('.chat-tile__title').first().innerText()).trim();

  // The tile header should show the SAME title the History row showed. (Both
  // resolve to the session's disk/alias title now.)
  expect(tileTitle, `tile header "${tileTitle}" should match History row "${historyTitle}"`).toBe(
    historyTitle,
  );
});
