/**
 * e2e/mass-spawn-no-crash.spec.ts
 *
 * Reproduces the LAUNCH crash (2026-06-17): the app fully crashed, and on
 * relaunch it restored many tiles at once and died immediately. A crash dump
 * showed 17 threads inside conpty.node simultaneously — N concurrent ConPTY
 * connects (one per restored tile) racing in the pseudo-console allocator
 * (Windows c0000374 heap corruption).
 *
 * This opens MANY real History sessions in quick succession (no awaiting
 * between resumes), mimicking the mass restore, and asserts the Electron app
 * survives. The spawn serialiser (one ConPTY connect at a time) is what keeps
 * it alive. RED on the crashing build, GREEN with the serialiser.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, closeAllChats, BridgeWindow } from './helpers.js';

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

async function appAlive(): Promise<boolean> {
  try {
    if (app.windows().length === 0) return false;
    return await win.evaluate(() => typeof document !== 'undefined' && !!document.body);
  } catch {
    return false;
  }
}

test('opening many sessions back-to-back never crashes the app', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  // History scans ~/.claude/projects — it can take several seconds to populate.
  // Wait for the list to actually load before counting (400ms was too short and
  // made the spec skip itself even when sessions exist).
  await win
    .locator('.session-item')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => undefined);
  const total = await win.locator('.session-item').count();
  test.skip(total < 3, 'need at least 3 real sessions to stress mass spawn');

  const TARGET = Math.min(total, 10);
  // Fire resumes in a tight loop WITHOUT waiting for each tile to settle —
  // this is the mass-restore concurrency that crashed the launch.
  for (let i = 0; i < TARGET; i += 1) {
    const row = win.locator('.session-item').nth(i);
    if ((await row.count()) === 0) break;
    await row
      .locator('.session-item__resume')
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    // Tiny gap only — far faster than the tiles can finish spawning, so several
    // ConPTY connects are in flight at once unless the main process serialises.
    await win.waitForTimeout(60);
    expect(await appAlive(), `app died after opening session #${i + 1}`).toBe(true);
  }

  // Let the serialised spawns + deferred resizes fully drain, then prove the
  // renderer can still round-trip IPC (i.e. the main process is alive).
  await win.waitForTimeout(3_000);
  expect(await appAlive(), 'app died while spawns drained').toBe(true);

  const ok = await win.evaluate(async () => {
    const bridge = (window as unknown as BridgeWindow).electron;
    const list = (await bridge?.ipcRenderer.invoke('list_claude_sessions')) as unknown[];
    return Array.isArray(list);
  });
  expect(ok, 'IPC round-trip failed → main process is dead').toBe(true);

  const tiles = await win.locator('.chat-tile').count();
  expect(tiles, 'at least some tiles opened').toBeGreaterThan(0);

  await closeAllChats(win);
});
