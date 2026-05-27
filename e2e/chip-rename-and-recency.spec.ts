/**
 * e2e/chip-rename-and-recency.spec.ts
 *
 * Pins two TopSwitcher chat-tab features the user asked for:
 *
 *   - Rename from the tab: double-clicking a chat chip opens an inline
 *     editor; typing a new name + Enter renames the chat. (user: "когда
 *     нажимаю на диалог ренайм сверху во вкладке я мог переименовывать")
 *   - Recent dialogs rise to the top: activating a chat bumps its chip to
 *     the front of the strip. (user: "последние диалоги поднимаются вверх")
 *
 * Needs >= 2 History sessions to open two chats; skips cleanly otherwise.
 */

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'dist-electron', 'main.js');

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  if (!fs.existsSync(MAIN)) throw new Error(`build missing at ${MAIN}`);
  app = await electron.launch({
    args: [MAIN, '--no-sandbox'],
    cwd: ROOT,
    env: { ...process.env, VITE_DEV_SERVER_URL: '', CLAUDEDESK_E2E: '1' },
    timeout: 45_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(800);
});

test.afterAll(async () => {
  if (app) await app.close();
});

async function openChatsFromHistory(n: number): Promise<number> {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const rows = win.locator('.session-item');
  const count = await rows.count();
  const toOpen = Math.min(n, count);
  for (let i = 0; i < toOpen; i += 1) {
    await rows.nth(i).locator('.session-item__resume').click();
    await win.waitForTimeout(500);
  }
  return toOpen;
}

async function closeChats(): Promise<void> {
  let safety = 20;
  while ((await win.locator('.chat-tile__close').count()) > 0 && safety-- > 0) {
    await win.locator('.chat-tile__close').first().click({ force: true });
    await win.waitForTimeout(150);
  }
}

test('double-click a chat chip renames the chat inline', async () => {
  const opened = await openChatsFromHistory(1);
  if (opened < 1) test.skip(true, 'No sessions to open');

  const chip = win.locator('.top-switcher__chats .ts-chip').first();
  await expect(chip).toBeVisible({ timeout: 5_000 });

  await chip.dblclick();
  const input = win.locator('.top-switcher__chats .ts-chip__rename');
  await expect(input).toBeVisible({ timeout: 3_000 });
  const newName = `renamed-${Date.now().toString().slice(-5)}`;
  await input.fill(newName);
  await input.press('Enter');

  await expect(input).toBeHidden({ timeout: 3_000 });
  await expect(
    win.locator('.top-switcher__chats .ts-chip__name', { hasText: newName }),
  ).toBeVisible({ timeout: 3_000 });

  await closeChats();
});

test('Escape cancels chip rename without changing the title', async () => {
  const opened = await openChatsFromHistory(1);
  if (opened < 1) test.skip(true, 'No sessions to open');

  const nameBefore = await win.locator('.top-switcher__chats .ts-chip__name').first().textContent();

  const chip = win.locator('.top-switcher__chats .ts-chip').first();
  await chip.dblclick();
  const input = win.locator('.top-switcher__chats .ts-chip__rename');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill('this-should-be-discarded');
  await input.press('Escape');

  await expect(input).toBeHidden({ timeout: 3_000 });
  const nameAfter = await win.locator('.top-switcher__chats .ts-chip__name').first().textContent();
  expect(nameAfter).toBe(nameBefore);

  await closeChats();
});

test('activating a chat bumps its chip to the front of the strip', async () => {
  const opened = await openChatsFromHistory(2);
  if (opened < 2) test.skip(true, 'Need at least 2 sessions to open 2 chats');

  const chipNames = () =>
    win.locator('.top-switcher__chats .ts-chip .ts-chip__name').allTextContents();

  await expect(win.locator('.top-switcher__chats .ts-chip')).toHaveCount(2, { timeout: 5_000 });
  const before = await chipNames();

  // Click the LAST chip — it should jump to the front.
  await win.locator('.top-switcher__chats .ts-chip').last().click();
  await win.waitForTimeout(300);
  const after = await chipNames();

  // The chip that was last is now first (order changed, MRU-first).
  expect(after[0]).toBe(before[before.length - 1]);
  expect(after.join('|')).not.toBe(before.join('|'));

  await closeChats();
});
