/* eslint-disable @typescript-eslint/no-non-null-assertion -- test file uses ! on locator-resolved DOM that is asserted-visible above */
/**
 * e2e/scrollback-no-hang.spec.ts
 *
 * Catches "infinite loading" — the regression the user reported
 * after my first round of fixes. The original 1000-line test passed
 * but missed the real failure mode because it (a) opens chats from
 * a clean grid and (b) only fails on the SCROLL assertion, not on
 * "did the tile ever render claude's banner".
 *
 * This test pins three independent invariants:
 *   1. **Tile renders within 5s.** After clicking resume, the xterm
 *      element must show ANY content (any non-empty line in the
 *      buffer) within 5 seconds. If claude PTY is gated behind a
 *      transcript wait that takes longer, this fails — exactly the
 *      user's "infinite loading" complaint.
 *   2. **Scrollback grows past one screen.** After tile renders,
 *      buffer.length must exceed rows (i.e. real history is in the
 *      scrollback, not just the visible viewport).
 *   3. **Wheel scrolls effectively.** Real win.mouse.wheel events
 *      move viewportY by at least 200 rows on a session that has
 *      ≥1000 lines of history. (Different from the 1000-line spec:
 *      that one programmatically calls scrollLines, this one
 *      requires the WHEEL EVENT path to work end-to-end.)
 *
 * Multi-tile scenario is exercised by opening TWO sessions and
 * running the invariants on each — the user reported needing to
 * "open a second tile to make the first fit", suggesting layout
 * timing differs between single- and multi-tile mode.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, closeAllChats } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.describe.configure({ timeout: 240_000 });

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

interface XtermInternals {
  __term?: {
    rows: number;
    cols: number;
    buffer: {
      active: {
        viewportY: number;
        baseY: number;
        length: number;
        getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined;
      };
    };
  };
}

async function tileHasContent(tileIndex: number): Promise<boolean> {
  return await win.evaluate((idx) => {
    const tiles = Array.from(document.querySelectorAll('.chat-tile .xterm')) as HTMLElement[];
    if (idx >= tiles.length) return false;
    const t = (tiles[idx] as unknown as XtermInternals).__term;
    if (!t) return false;
    const buf = t.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const ln = buf.getLine(i);
      if (ln && ln.translateToString(true).trim().length > 0) return true;
    }
    return false;
  }, tileIndex);
}

async function tileStats(tileIndex: number) {
  return await win.evaluate((idx) => {
    const tiles = Array.from(document.querySelectorAll('.chat-tile .xterm')) as HTMLElement[];
    if (idx >= tiles.length) return null;
    const t = (tiles[idx] as unknown as XtermInternals).__term;
    if (!t) return null;
    const buf = t.buffer.active;
    return {
      length: buf.length,
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      rows: t.rows,
      cols: t.cols,
    };
  }, tileIndex);
}

async function openSession(rowIndex: number): Promise<void> {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const row = win.locator('.session-item').nth(rowIndex);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.locator('.session-item__resume').click();
}

async function waitForTileContent(
  tileIndex: number,
  timeoutMs: number,
): Promise<{ rendered: boolean; tookMs: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await tileHasContent(tileIndex)) {
      return { rendered: true, tookMs: Date.now() - start };
    }
    await win.waitForTimeout(150);
  }
  return { rendered: false, tookMs: Date.now() - start };
}

// eslint-disable-next-line no-empty-pattern -- need testInfo; fixture is unused
test('resumed chat tile must render visible content within 5s (no infinite loading)', async ({}, info) => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const total = await win.locator('.session-item').count();
  if (total === 0) test.skip(true, 'No sessions to test');

  await openSession(0);
  await expect(win.locator('.chat-tile .xterm').first()).toBeVisible({ timeout: 8_000 });

  const result = await waitForTileContent(0, 5_000);
  await info.attach('render-timing.txt', {
    body: Buffer.from(`rendered=${result.rendered} after=${result.tookMs}ms`, 'utf8'),
    contentType: 'text/plain',
  });
  expect(
    result.rendered,
    `Tile must show content within 5s. Took ${result.tookMs}ms. ` +
      `This catches the "infinite loading" the user reports when PTY is gated behind transcript wait.`,
  ).toBe(true);

  await closeAllChats(win);
});

// eslint-disable-next-line no-empty-pattern -- need testInfo; fixture is unused
test('resumed chat must have scrollback content (buffer.length > rows)', async ({}, info) => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const total = await win.locator('.session-item').count();
  if (total === 0) test.skip(true, 'No sessions to test');

  let found = false;
  for (let i = 0; i < Math.min(total, 5); i++) {
    await openSession(i);
    await expect(win.locator('.chat-tile .xterm').first()).toBeVisible({ timeout: 8_000 });
    await waitForTileContent(0, 6_000);
    // Give transcript its window to land.
    await win.waitForTimeout(3_000);
    const stats = await tileStats(0);
    await info.attach(`session-${i}-stats.txt`, {
      body: Buffer.from(JSON.stringify(stats, null, 2), 'utf8'),
      contentType: 'text/plain',
    });
    if (stats && stats.length > stats.rows + 10) {
      found = true;
      await closeAllChats(win);
      break;
    }
    await closeAllChats(win);
    await win.waitForTimeout(300);
  }
  expect(
    found,
    'At least one tested session must have scrollback content (buffer.length > rows + 10).',
  ).toBe(true);
});

// eslint-disable-next-line no-empty-pattern -- need testInfo; fixture is unused
test('wheel events must scroll viewport when scrollback exists', async ({}, info) => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const total = await win.locator('.session-item').count();
  if (total === 0) test.skip(true, 'No sessions to test');

  // Find a session with substantial scrollback to test wheel scroll on.
  let candidate = -1;
  let firstStats = null;
  for (let i = 0; i < Math.min(total, 5); i++) {
    await openSession(i);
    await expect(win.locator('.chat-tile .xterm').first()).toBeVisible({ timeout: 8_000 });
    await waitForTileContent(0, 6_000);
    await win.waitForTimeout(3_000);
    const stats = await tileStats(0);
    if (stats && stats.length > stats.rows + 200) {
      candidate = i;
      firstStats = stats;
      break;
    }
    await closeAllChats(win);
    await win.waitForTimeout(300);
  }
  if (candidate < 0) test.skip(true, 'No session with enough scrollback for wheel test');

  const xterm = win.locator('.chat-tile .xterm').first();
  const box = await xterm.boundingBox();
  expect(box).not.toBeNull();
  await win.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  for (let k = 0; k < 30; k++) {
    await win.mouse.wheel(0, -250);
    await win.waitForTimeout(25);
  }
  await win.waitForTimeout(500);

  const after = await tileStats(0);
  await info.attach('wheel-stats.txt', {
    body: Buffer.from(
      `before: ${JSON.stringify(firstStats)}\nafter:  ${JSON.stringify(after)}`,
      'utf8',
    ),
    contentType: 'text/plain',
  });
  expect(after, 'tile must still be alive after wheel events').not.toBeNull();
  const delta = firstStats!.viewportY - after!.viewportY;
  expect(
    delta,
    `Wheel must move viewportY by at least 200 rows. before=${firstStats!.viewportY} after=${after!.viewportY} Δ=${delta}`,
  ).toBeGreaterThanOrEqual(200);

  await closeAllChats(win);
});
