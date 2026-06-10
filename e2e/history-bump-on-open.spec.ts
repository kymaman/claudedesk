/**
 * e2e/history-bump-on-open.spec.ts
 *
 * REAL proof, in the live Electron app against the user's actual
 * sessions: opening a NON-first History session bumps it to the TOP of
 * the list IN THE MOMENT — no refresh, no app restart.
 *
 * Mechanism under test: sessionsWithOpenChats() overlays the chat's
 * openedAt (full ISO datetime) onto the disk session's bare
 * "YYYY-MM-DD" date, so the "newest" sort places it first reactively
 * the instant openChats() changes.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, closeAllChats, awaitChatReady } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.describe.configure({ timeout: 120_000 });

test.afterAll(async () => {
  if (!app) return;
  try {
    await closeAllChats(win).catch(() => undefined);
  } catch {
    /* ignore */
  }
  await app.close();
});

// eslint-disable-next-line no-empty-pattern -- need testInfo; fixture is unused
test('opening an older session lifts it to the top of History immediately', async ({}, info) => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(400);
  await closeAllChats(win); // older tiles would carry their own bumps
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);

  const rows = win.locator('.session-item');
  const total = await rows.count();
  if (total < 3) test.skip(true, 'Need at least 3 real sessions to prove reordering');

  const titleAt = async (i: number) =>
    (await rows.nth(i).locator('.session-item__title').innerText()).trim();

  const firstTitle = await titleAt(0);
  // Pick the first non-top row whose title differs from row 0 so the
  // "became first" assertion can't pass by title collision.
  let pickIdx = -1;
  for (let i = 2; i < Math.min(total, 8); i += 1) {
    const t = await titleAt(i);
    if (t && t !== firstTitle) {
      pickIdx = i;
      break;
    }
  }
  if (pickIdx === -1) test.skip(true, 'All visible sessions share one title — cannot prove move');
  const pickedTitle = await titleAt(pickIdx);

  await info.attach('before.txt', {
    body: Buffer.from(`row0="${firstTitle}" picked#${pickIdx}="${pickedTitle}"`, 'utf8'),
    contentType: 'text/plain; charset=utf-8',
  });

  // Open the picked session as a real chat tile (real PTY spawn).
  await rows.nth(pickIdx).locator('.session-item__resume').click();
  await expect(win.locator('.chat-tile').first()).toBeVisible({ timeout: 15_000 });
  await awaitChatReady(win, 10_000).catch(() => undefined);

  // Back to History — the picked session must now be FIRST, with no
  // loadSessions()/refresh in between.
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  await expect(win.locator('.session-item').first().locator('.session-item__title')).toHaveText(
    pickedTitle,
    { timeout: 5_000 },
  );

  await closeAllChats(win);
});
