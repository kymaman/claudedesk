/**
 * e2e/terminal-cols-on-layout-change.spec.ts
 *
 * RED test: when the chats grid changes layout (e.g. user opens a 2nd
 * tile, the grid goes from 1-column to 2-column, every tile shrinks),
 * every xterm should refit to the new container width. Currently the
 * first-opened tile stays at the wide cols computed against the bigger
 * container, OR if a tile's container was zero-width at fit() time
 * (display:none parent during a tab switch), the tile stays at cols=1.
 *
 * Screenshot evidence from the user: 4 tiles open, each rendered with
 * text wrapping one character per line — cols stuck at 1-2.
 *
 * Repro: open one chat, then open another. After 2nd opens, both tiles
 * should have cols >= 20 (any reasonable terminal width). On buggy
 * code, the first tile's cols is stuck at the 1-tile-wide value, or
 * the 2nd tile gets cols=1 because the grid was display:none when fit
 * fired.
 *
 * Fix plan:
 *   - terminalFitManager.flush(): skip fit() when container.clientWidth=0,
 *     keep dirty=true so it retries when visible
 *   - When the grid layout changes (tile count up/down), explicitly
 *     mark every registered terminal dirty
 *   - Add a MutationObserver / visibility-change retry so display
 *     transitions trigger a fit
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

async function readTermCols(): Promise<number[]> {
  return await win.evaluate(() => {
    const tiles = document.querySelectorAll('.chat-tile');
    const cols: number[] = [];
    for (const tile of Array.from(tiles)) {
      const xtermEl = tile.querySelector('.xterm') as HTMLElement | null;
      if (!xtermEl) continue;
      interface XtermInternals {
        __term?: { cols: number };
      }
      const term = (xtermEl as unknown as XtermInternals).__term;
      if (!term) continue;
      cols.push(term.cols);
    }
    return cols;
  });
}

test('opening a 2nd chat refits the 1st — neither ends up with tiny cols', async () => {
  // Go to History and open 2 sessions one after the other.
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);

  const rows = win.locator('.session-item');
  const rowCount = await rows.count();
  if (rowCount < 2) test.skip(true, 'Need ≥2 sessions to test multi-tile layout');

  // Open first chat
  await rows.nth(0).locator('.session-item__resume').click();
  await win.waitForTimeout(800);
  await expect(win.locator('.chat-tile').first()).toBeVisible({ timeout: 5_000 });
  // give terminalFitManager a chance to fit
  await win.waitForTimeout(400);

  const after1 = await readTermCols();
  expect(after1.length).toBeGreaterThanOrEqual(1);
  expect(
    after1[0],
    `1st tile cols after opening solo = ${after1[0]} (expected >= 20)`,
  ).toBeGreaterThan(20);

  // Open second chat — this changes the grid from 1-col to 2-col, every
  // tile shrinks horizontally. Both must refit.
  await rows.nth(1).locator('.session-item__resume').click();
  await win.waitForTimeout(800);
  await expect(win.locator('.chat-tile')).toHaveCount(2, { timeout: 5_000 });
  await win.waitForTimeout(600);

  const after2 = await readTermCols();
  expect(after2.length).toBe(2);

  // ASSERTION: every tile must have cols > 20. On buggy code, at least
  // one will be stuck (cols=1 or stale-wide).
  for (let i = 0; i < after2.length; i++) {
    expect(
      after2[i],
      `BUG: tile ${i} cols = ${after2[i]}.\n` +
        `All tiles in [${after2.join(',')}] must be > 20 after grid layout change.\n` +
        `Fix: terminalFitManager must refit every tile on container resize\n` +
        `AND skip fit() when clientWidth=0 (retry when visible).`,
    ).toBeGreaterThan(20);
  }

  // Resize the window — every tile should refit again.
  const initial = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await win.setViewportSize({
    width: Math.max(800, initial.w - 200),
    height: initial.h,
  });
  await win.waitForTimeout(600);
  await win.setViewportSize({ width: initial.w, height: initial.h });
  await win.waitForTimeout(600);

  const afterResize = await readTermCols();
  for (let i = 0; i < afterResize.length; i++) {
    expect(
      afterResize[i],
      `BUG: tile ${i} cols = ${afterResize[i]} after resize cycle. All must be > 20.`,
    ).toBeGreaterThan(20);
  }

  await closeAllChats(win);
});
