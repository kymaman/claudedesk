/**
 * e2e/chip-recency.spec.ts
 *
 * Pins the "most-recently-active chat jumps to the front of the chip
 * strip" behaviour. Mechanism: setActiveChatId bumps _activityTick;
 * chipChats() reads the tick + sorts by lastActiveAtFor() so the
 * just-clicked chat moves to position 0 in the rendered chip list.
 *
 * RED if the activity bump is missing or if chipChats doesn't read
 * the tick — the chip order stays stuck on insertion order.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, closeAllChats } from './helpers.js';

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

async function readChipOrder(): Promise<string[]> {
  return await win.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('.ts-chip')) as HTMLElement[];
    return chips
      .map((c) => c.querySelector('.ts-chip__name')?.textContent?.trim() ?? '')
      .filter((t) => t.length > 0);
  });
}

test('clicking an older chat moves its chip to the front of the strip', async () => {
  // Open 3 distinct sessions so we get 3 chips.
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);

  const rows = win.locator('.session-item');
  const rowCount = await rows.count();
  if (rowCount < 3) test.skip(true, 'Need ≥3 sessions to test recency order');

  for (let i = 0; i < 3; i++) {
    await rows.nth(i).locator('.session-item__resume').click();
    await win.waitForTimeout(400);
  }

  // The most-recently-opened chat (index 2) should be at position 0 of
  // the chip strip — opening a chat is itself an activation.
  await win.waitForTimeout(400);
  const initial = await readChipOrder();
  expect(initial.length, 'expected 3 chips').toBeGreaterThanOrEqual(3);

  // Click the LAST chip (oldest active = position 2) — it must hop to
  // position 0.
  const lastChipText = initial[initial.length - 1];
  const lastChip = win.locator('.ts-chip', { hasText: lastChipText }).first();
  await lastChip.click();
  await win.waitForTimeout(300);

  const reordered = await readChipOrder();
  expect(
    reordered[0],
    `BUG: clicked chip "${lastChipText}" did not move to position 0.\n` +
      `Initial order: ${JSON.stringify(initial)}\n` +
      `After click:   ${JSON.stringify(reordered)}\n` +
      `Fix: setActiveChatId must bump _activityTick AND chipChats must read it.`,
  ).toBe(lastChipText);

  await closeAllChats(win);
});
