/**
 * e2e/rename-live-update.spec.ts
 *
 * Pins: rename must update the visible title IMMEDIATELY in all three
 * surfaces, not only after an app restart:
 *   1. Chip in the TopSwitcher strip
 *   2. Open chat tile head
 *   3. Session row in the History sidebar
 *
 * User report: «ренейм плохо работает. в моменте не ренеймит, после
 * перезагрузки показывает новое название - должно сразу».
 *
 * Mechanism: each rename path calls a setter (renameChat or
 * renameSessionLocal) that does `prev.map(x => x.id === id ? {...x,
 * title}: x)`. Solid's reactivity on the source signal should make the
 * `<For>` re-render the affected row.
 *
 * RED conditions: title text in the DOM still shows the OLD value
 * after the rename commit has fired. Each surface is its own test —
 * they may fail independently.
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

test('chip in TopSwitcher updates title immediately after double-click rename', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  const chip = win.locator('.ts-chip').first();
  await expect(chip).toBeVisible({ timeout: 5_000 });
  const before = (await chip.locator('.ts-chip__name').textContent())?.trim() ?? '';
  expect(before.length).toBeGreaterThan(0);

  // Double-click triggers beginRenameChip → inline input appears.
  await chip.dblclick();
  const renameInput = chip.locator('.ts-chip__rename');
  await expect(renameInput).toBeVisible({ timeout: 2_000 });

  const newTitle = `renamed-chip-${Date.now().toString().slice(-5)}`;
  // Replace the value in the input then commit with Enter.
  await renameInput.fill(newTitle);
  await renameInput.press('Enter');
  // Give Solid a frame.
  await win.waitForTimeout(300);

  const after = (await chip.locator('.ts-chip__name').textContent())?.trim() ?? '';
  expect(
    after,
    `BUG: chip rename didn't update title in place.\n` +
      `Before: ${JSON.stringify(before)}\n` +
      `After:  ${JSON.stringify(after)}\n` +
      `Expected the visible chip name to start with "${newTitle.slice(0, 20)}".`,
  ).toContain(newTitle.slice(0, 20));

  await closeAllChats(win);
});

test('chat tile head updates title immediately after right-click → Rename', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  const tile = win.locator('.chat-tile').first();
  const titleEl = tile.locator('.chat-tile__title');
  const before = (await titleEl.textContent())?.trim() ?? '';
  expect(before.length).toBeGreaterThan(0);

  const newTitle = `renamed-tile-${Date.now().toString().slice(-5)}`;
  // window.prompt is shown via the right-click → Rename path. Hook the
  // dialog handler BEFORE clicking so we accept it with the new name.
  win.once('dialog', async (dialog) => {
    await dialog.accept(newTitle);
  });

  // Right-click the head → menu → Rename.
  await tile.locator('.chat-tile__head').click({ button: 'right' });
  const menu = win.locator('.chat-tile__menu');
  await expect(menu).toBeVisible({ timeout: 3_000 });
  await menu.locator('button', { hasText: /^rename$/i }).click();

  // After the prompt is accepted, renameChat fires → tile title updates.
  await win.waitForTimeout(300);
  const after = (await titleEl.textContent())?.trim() ?? '';
  expect(
    after,
    `BUG: tile rename didn't update head title.\n` +
      `Before: ${JSON.stringify(before)}\n` +
      `After:  ${JSON.stringify(after)}\n` +
      `Expected to contain "${newTitle}".`,
  ).toContain(newTitle);

  await closeAllChats(win);
});

test('history session row updates title immediately after rename', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);

  const row = win.locator('.session-item').first();
  if ((await row.count()) === 0) test.skip(true, 'no sessions to rename');

  const titleEl = row.locator('.session-item__title');
  const before = (await titleEl.textContent())?.trim() ?? '';
  expect(before.length).toBeGreaterThan(0);

  // Double-click the title row to start inline edit (the path that
  // doesn't go through prompt() — it shows an inline input).
  await row.dblclick();
  const input = row.locator('.session-item__title-input');
  await expect(input).toBeVisible({ timeout: 3_000 });

  const newTitle = `renamed-history-${Date.now().toString().slice(-5)}`;
  await input.fill(newTitle);
  await input.press('Enter');
  await win.waitForTimeout(300);

  const after = (await titleEl.textContent())?.trim() ?? '';
  expect(
    after,
    `BUG: history rename didn't update session row title.\n` +
      `Before: ${JSON.stringify(before)}\n` +
      `After:  ${JSON.stringify(after)}\n` +
      `Expected to contain "${newTitle}".`,
  ).toContain(newTitle);
});
