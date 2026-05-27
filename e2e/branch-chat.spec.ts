/**
 * e2e/branch-chat.spec.ts
 *
 * Branching an open chat must produce a sibling tile with the same
 * sessionId and `--fork-session` in its spawn args. We drive the
 * action through the window hook (UI menu would require a chat with a
 * real sessionId — claude only mints one after the first round-trip).
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

test('branchChat creates a sibling tile with --fork-session', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  // Seed a synthetic sessionId on the first chat so branchChat doesn't
  // bail. The hook intentionally keeps the underlying chat object refs
  // stable, so we mutate it in place via Object.assign equivalent.
  const seeded = await win.evaluate(() => {
    interface Hook {
      chats: () => Array<{ id: string; sessionId?: string; args: string[] }>;
      branchChat: (id: string) => unknown;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook = (window as any).__claudedeskChats as Hook | undefined;
    if (!hook) return { error: 'no hook' };
    const all = hook.chats();
    if (all.length === 0) return { error: 'no chats' };
    const first = all[0];
    // Branching from grid menu requires a sessionId. Forge one — the
    // PTY may complain to claude, but for the store-shape assertions
    // below that's irrelevant.
    if (!first.sessionId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (first as any).sessionId = 'e2e-fake-sid-' + Date.now();
    }
    const out = hook.branchChat(first.id) as { id?: string; args?: string[] } | null;
    return { ok: true, sourceId: first.id, sourceSid: first.sessionId, branch: out };
  });

  expect((seeded as { error?: string }).error, JSON.stringify(seeded)).toBeUndefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = seeded as any;
  expect(res.branch, 'branchChat must return the new chat').toBeTruthy();
  expect(res.branch.args, 'branched args must contain --fork-session').toContain('--fork-session');
  expect(res.branch.args[0]).toBe('--resume');
  expect(res.branch.args[1]).toBe(res.sourceSid);

  // Two tiles must now be visible in the grid.
  const tiles = win.locator('.chat-tile');
  await expect(tiles).toHaveCount(2, { timeout: 5_000 });

  await closeAllChats(win);
});
