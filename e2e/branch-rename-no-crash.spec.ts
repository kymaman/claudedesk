/**
 * e2e/branch-rename-no-crash.spec.ts
 *
 * Reproduces the user-reported crash: "I make a branch and right after the
 * branch it closed." A crash dump proved it is a ConPTY heap corruption
 * (Windows c0000374) inside conpty.node — the branch's fresh `pty.spawn`
 * racing the grid-reflow resize storm.
 *
 * These drive the EXACT user flow through the real right-click menu on the
 * chat-tile head (Branch / Rename), repeatedly, and assert the Electron app
 * stays ALIVE the whole time. A native main-process crash kills every window,
 * so any post-action `win.evaluate` / locator call would reject and the test
 * fails — i.e. this spec IS a crash detector. RED on the crashing build,
 * GREEN once the spawn↔resize de-confliction lands.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, openOneChat, awaitChatReady, closeAllChats, BridgeWindow } from './helpers.js';

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
    /* ignore — tearing down */
  }
  await app.close();
});

/** Force a sessionId onto the first chat so Branch is enabled (claude only
 *  mints a real one after the first round-trip; we don't need a live model). */
async function seedSessionId(): Promise<boolean> {
  return win.evaluate(() => {
    interface Hook {
      chats: () => Array<{ id: string; sessionId?: string }>;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook = (window as any).__claudedeskChats as Hook | undefined;
    if (!hook) return false;
    const all = hook.chats();
    if (all.length === 0) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!all[0].sessionId) (all[0] as any).sessionId = 'e2e-fake-sid-' + String(Date.now());
    return true;
  });
}

/** True if the app is still responsive (no native crash took the window). */
async function appAlive(): Promise<boolean> {
  try {
    if (app.windows().length === 0) return false;
    return await win.evaluate(() => typeof document !== 'undefined' && !!document.body);
  } catch {
    return false;
  }
}

/** Open the right-click context menu on the most recently added tile head. */
async function openTileMenu(tileIndex: number): Promise<void> {
  const head = win.locator('.chat-tile .chat-tile__head').nth(tileIndex);
  await expect(head).toBeVisible({ timeout: 5_000 });
  await head.click({ button: 'right' });
  await expect(win.locator('.chat-tile__menu').first()).toBeVisible({ timeout: 3_000 });
}

test('repeated Branch via right-click menu never crashes the app', async () => {
  await openOneChat(win);
  await awaitChatReady(win).catch(() => undefined);
  const seeded = await seedSessionId();
  test.skip(!seeded, 'no chats/hook — nothing to branch');

  const BRANCHES = 4;
  for (let i = 0; i < BRANCHES; i += 1) {
    const before = await win.locator('.chat-tile').count();
    await openTileMenu(0); // always branch from the first tile
    await win
      .locator('.chat-tile__menu button', { hasText: /^Branch$/ })
      .first()
      .click();
    // The branch spawns a PTY and reflows the grid — the exact crash window.
    await expect(win.locator('.chat-tile')).toHaveCount(before + 1, { timeout: 10_000 });
    expect(await appAlive(), `app died after branch #${i + 1}`).toBe(true);
    await win.waitForTimeout(400); // let the deferred resize storm drain
    expect(await appAlive(), `app died while resizes drained after branch #${i + 1}`).toBe(true);
  }

  await closeAllChats(win);
});

test('Rename via right-click menu never crashes the app', async () => {
  await openOneChat(win);
  await awaitChatReady(win).catch(() => undefined);
  test.skip(!(await seedSessionId()), 'no chats/hook');

  for (let i = 0; i < 3; i += 1) {
    await openTileMenu(0);
    await win
      .locator('.chat-tile__menu button', { hasText: /^Rename$/ })
      .first()
      .click();
    const input = win.locator('.chat-tile__title-input').first();
    await expect(input).toBeVisible({ timeout: 3_000 });
    await input.fill(`renamed-${i}-${Date.now()}`);
    await input.press('Enter');
    await win.waitForTimeout(250);
    expect(await appAlive(), `app died after rename #${i + 1}`).toBe(true);
  }

  await closeAllChats(win);
});

test('interleaved Branch + Rename storm never crashes the app', async () => {
  await openOneChat(win);
  await awaitChatReady(win).catch(() => undefined);
  test.skip(!(await seedSessionId()), 'no chats/hook');

  for (let round = 0; round < 3; round += 1) {
    // Branch.
    const before = await win.locator('.chat-tile').count();
    await openTileMenu(0);
    await win
      .locator('.chat-tile__menu button', { hasText: /^Branch$/ })
      .first()
      .click();
    await expect(win.locator('.chat-tile')).toHaveCount(before + 1, { timeout: 10_000 });
    // Immediately rename the freshest tile — rename + the still-settling
    // branch reflow overlap, which is the worst case for the native race.
    const last = before; // newest tile index (0-based count → last index)
    await openTileMenu(last);
    await win
      .locator('.chat-tile__menu button', { hasText: /^Rename$/ })
      .first()
      .click();
    const input = win.locator('.chat-tile__title-input').first();
    await expect(input).toBeVisible({ timeout: 3_000 });
    await input.fill(`r${round}-${Date.now()}`);
    await input.press('Enter');
    expect(await appAlive(), `app died in round ${round}`).toBe(true);
    await win.waitForTimeout(350);
    expect(await appAlive(), `app died draining round ${round}`).toBe(true);
  }

  // Final liveness proof: the renderer can still round-trip an IPC call.
  const sessionCount = await win.evaluate(async () => {
    const bridge = (window as unknown as BridgeWindow).electron;
    const list = (await bridge?.ipcRenderer.invoke('list_claude_sessions')) as unknown[];
    return Array.isArray(list) ? list.length : -1;
  });
  expect(sessionCount, 'IPC round-trip failed → main process is dead').toBeGreaterThanOrEqual(0);

  await closeAllChats(win);
});
