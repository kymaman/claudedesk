/**
 * e2e/history-search-by-rename.spec.ts
 *
 * REAL proof of the "поиск HH не находит миграция HH" fix, driven
 * through the live Electron UI:
 *
 *   1. Open a real History session as a chat tile.
 *   2. Rename the tile (real path: inline editor → renameChat) to a
 *      title containing a unique token the original title does NOT
 *      contain.
 *   3. Type that token into the real History search box.
 *   4. Assert the renamed session shows up in the filtered list.
 *
 * Before the fix, the rename lived only in localStorage and History
 * searched the stale first-message title — so the token never matched
 * and the session was unfindable. This test would be RED then, GREEN
 * now.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, closeAllChats, awaitChatReady, type BridgeWindow } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.describe.configure({ timeout: 120_000 });

test.afterAll(async () => {
  if (!app) return;
  try {
    await win
      .locator('.sessions-panel__search')
      .fill('')
      .catch(() => undefined);
    await closeAllChats(win).catch(() => undefined);
  } catch {
    /* ignore */
  }
  await app.close();
});

// eslint-disable-next-line no-empty-pattern -- need testInfo; fixture is unused
test('History search finds a session by its tile rename (миграция HH bug)', async ({}, info) => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(400);
  const rows = win.locator('.session-item');
  const total = await rows.count();
  if (total === 0) test.skip(true, 'No real History sessions on disk');

  // A token unlikely to occur in any real session's first message.
  const token = 'ZZQHH';
  const newTitle = `миграция ${token} тест`;

  // Open the first session as a tile.
  await rows.first().locator('.session-item__resume').click();
  const tile = win.locator('.chat-tile').first();
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await awaitChatReady(win, 10_000).catch(() => undefined);

  // Trigger the actual UI rename: double-click the tile title opens the
  // INLINE editor (window.prompt was replaced — fragile in Electron).
  await tile.locator('.chat-tile__title').dblclick();
  const titleInput = tile.locator('.chat-tile__title-input');
  await expect(titleInput).toBeVisible({ timeout: 3_000 });
  await titleInput.fill(newTitle);
  await titleInput.press('Enter');
  await win.waitForTimeout(400);

  // The tile header must now show the new title.
  await expect(tile.locator('.chat-tile__title')).toHaveText(newTitle, { timeout: 4_000 });

  // Type the token into the REAL History search box.
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const search = win.locator('.sessions-panel__search');
  await expect(search).toBeVisible({ timeout: 4_000 });
  await search.fill(token);
  await win.waitForTimeout(500);

  const visible = win.locator('.session-item');
  const count = await visible.count();
  await info.attach('search-result.txt', {
    body: Buffer.from(
      `token=${token} newTitle=${newTitle} matches=${count}\n` +
        `first match text: ${count > 0 ? await visible.first().innerText() : '(none)'}`,
      'utf8',
    ),
    contentType: 'text/plain; charset=utf-8',
  });

  // At least one result, and it must carry our renamed title.
  expect(count, `search "${token}" returned no sessions`).toBeGreaterThanOrEqual(1);
  const anyMatch = await visible
    .filter({ hasText: token })
    .count()
    .catch(() => 0);
  expect(anyMatch, `no visible session-item contained "${token}"`).toBeGreaterThanOrEqual(1);

  // Lowercase search must also match (case-insensitive).
  await search.fill(token.toLowerCase());
  await win.waitForTimeout(400);
  expect(await win.locator('.session-item').count()).toBeGreaterThanOrEqual(1);

  // Persistence: the rename must live in the alias DB (not just this
  // window's localStorage) — the REAL list IPC returns it as the title.
  const persistedSid = await win.evaluate(async (t) => {
    const bridge = (window as unknown as BridgeWindow).electron;
    if (!bridge) return null;
    const list = (await bridge.ipcRenderer.invoke('list_claude_sessions')) as Array<{
      sessionId: string;
      title: string;
    }>;
    return list.find((s) => s.title === t)?.sessionId ?? null;
  }, newTitle);
  expect(persistedSid, 'rename was not persisted as a session alias').not.toBeNull();

  // Cleanup: clear the test alias so the user's real session goes back
  // to its parsed title instead of keeping "миграция ZZQHH тест".
  if (persistedSid) {
    await win.evaluate(async (sid) => {
      const bridge = (window as unknown as BridgeWindow).electron;
      if (!bridge) return;
      await bridge.ipcRenderer.invoke('rename_claude_session', { sessionId: sid, alias: '' });
    }, persistedSid);
  }

  await search.fill('');
});
