/**
 * e2e/compact-dual-no-crash.spec.ts
 *
 * 5th branch-crash trigger (user report): dialog → Branch → rename branch →
 * `/compact` in BOTH terminals → the whole app closed. A crash dump showed the
 * same ConPTY heap corruption (c0000374) with 187 pointers into conpty.node:
 * node-pty's per-PTY reader threads hammering the pseudo-console allocator while
 * two terminals flood output at once. Unlike triggers 1–4 this path is pure
 * concurrent READ (no spawn/resize/kill), so the earlier guards don't cover it;
 * the cross-terminal output-drain scheduler (one drain token at a time) does.
 *
 * HONEST SCOPE: a native heap-corruption race can't be made to fire
 * deterministically from an e2e, and `/compact` needs a live claude session we
 * don't assume here — so this is a SURVIVAL smoke test: it stands up two
 * terminals, branches/renames, and fires `/compact` into both, asserting the
 * Electron main process stays alive and still round-trips IPC. The deterministic
 * proof of the serialisation invariant lives in the unit/integration tests
 * (electron/ipc/output-scheduler.test.ts + the scheduler block in pty.test.ts).
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

/** True if the app is still responsive (no native crash took the window). */
async function appAlive(): Promise<boolean> {
  try {
    if (app.windows().length === 0) return false;
    return await win.evaluate(() => typeof document !== 'undefined' && !!document.body);
  } catch {
    return false;
  }
}

/** Seed a sessionId on every chat so Branch is enabled without a live model. */
async function seedAllSessionIds(): Promise<boolean> {
  return win.evaluate(() => {
    interface Hook {
      chats: () => Array<{ id: string; sessionId?: string }>;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook = (window as any).__claudedeskChats as Hook | undefined;
    if (!hook) return false;
    const all = hook.chats();
    if (all.length === 0) return false;
    let i = 0;
    for (const c of all) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!c.sessionId) (c as any).sessionId = `e2e-fake-sid-${Date.now()}-${i}`;
      i += 1;
    }
    return true;
  });
}

async function openTileMenu(tileIndex: number): Promise<void> {
  const head = win.locator('.chat-tile .chat-tile__head').nth(tileIndex);
  await expect(head).toBeVisible({ timeout: 5_000 });
  await head.click({ button: 'right' });
  await expect(win.locator('.chat-tile__menu').first()).toBeVisible({ timeout: 3_000 });
}

/** Type text into one tile's xterm input (best-effort: only does something when
 *  a live shell/claude is attached, but always exercises the write path). */
async function typeIntoTile(tileIndex: number, text: string): Promise<void> {
  const textarea = win.locator('.chat-tile .xterm-helper-textarea').nth(tileIndex);
  if ((await textarea.count()) === 0) return;
  await textarea.focus().catch(() => undefined);
  await textarea.type(text, { delay: 0 }).catch(() => undefined);
  await textarea.press('Enter').catch(() => undefined);
}

test('Branch + rename + dual /compact never crashes the app', async () => {
  // Two terminals: open one, branch it so we have a second PTY (a real sibling).
  await openOneChat(win);
  await awaitChatReady(win).catch(() => undefined);
  test.skip(!(await seedAllSessionIds()), 'no chats/hook — nothing to drive');

  // Branch → second tile (second PTY).
  const before = await win.locator('.chat-tile').count();
  await openTileMenu(0);
  await win
    .locator('.chat-tile__menu button', { hasText: /^Branch$/ })
    .first()
    .click();
  await expect(win.locator('.chat-tile')).toHaveCount(before + 1, { timeout: 10_000 });
  expect(await appAlive(), 'app died after branch').toBe(true);

  // Rename the fresh branch (the exact user sequence before /compact).
  await openTileMenu(before); // newest tile
  await win
    .locator('.chat-tile__menu button', { hasText: /^Rename$/ })
    .first()
    .click();
  const input = win.locator('.chat-tile__title-input').first();
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill(`branch-${Date.now()}`);
  await input.press('Enter');
  expect(await appAlive(), 'app died after rename').toBe(true);

  await seedAllSessionIds();

  // Fire /compact into BOTH terminals as close to simultaneously as we can —
  // the concurrent-output burst that drove conpty.node into heap corruption.
  await Promise.all([typeIntoTile(0, '/compact'), typeIntoTile(1, '/compact')]);

  // Give any output burst time to flow through the drain scheduler.
  for (let i = 0; i < 6; i += 1) {
    await win.waitForTimeout(250);
    expect(await appAlive(), `app died during dual /compact (tick ${i})`).toBe(true);
  }

  // Final liveness proof: the renderer can still round-trip an IPC call —
  // impossible if a native crash had taken the main process.
  const sessionCount = await win.evaluate(async () => {
    const bridge = (window as unknown as BridgeWindow).electron;
    const list = (await bridge?.ipcRenderer.invoke('list_claude_sessions')) as unknown[];
    return Array.isArray(list) ? list.length : -1;
  });
  expect(sessionCount, 'IPC round-trip failed → main process is dead').toBeGreaterThanOrEqual(0);

  await closeAllChats(win);
});
