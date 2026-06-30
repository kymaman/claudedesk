/**
 * e2e/title-rename-unified.spec.ts
 *
 * Real-UI (Electron) proofs for the two owner-reported title bugs:
 *
 * BUG 1 — Renaming an OPEN session from the HISTORY list did nothing.
 *   SessionsHistoryPanel.commitEdit early-returned for any open-chat row, so the
 *   rename was a silent no-op. Fixed by routing open-chat renames through
 *   renameChat(openChatId/sessionId-match), which sets the title OVERRIDE and
 *   updates the tile header live (both surfaces read titleFor).
 *
 * BUG 2 — A name typed when CREATING a session got erased once claude derived a
 *   first-message/AI disk title. Fixed by registering the user-typed creation
 *   title as an OVERRIDE (wins over the disk title) and persisting it as the
 *   session alias once the chat binds a sessionId.
 *
 * Both are proven against the rendered DOM of the running app.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, awaitChatReady, closeAllChats } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});
test.afterAll(async () => {
  if (!app) return;
  await closeAllChats(win).catch(() => undefined);
  await app.close();
});

test('BUG 1: renaming an OPEN session from the History list updates the tile header live', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win
    .locator('.session-item')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => undefined);
  if ((await win.locator('.session-item').count()) === 0)
    test.skip(true, 'No real History sessions on disk');

  // Open the first session as a tile.
  await win.locator('.session-item').first().locator('.session-item__resume').click();
  await win.locator('.chat-tile .xterm').first().waitFor({ state: 'visible', timeout: 45_000 });
  await awaitChatReady(win, 30_000).catch(() => undefined);
  await win.waitForTimeout(800);

  // Opening bumps the session's row to the top (openedAt ISO date sorts first),
  // so the first VISIBLE row IS the open session. (The panel renders rows in
  // both a full list and a compact rail; one is display:none, so scope to
  // :visible to avoid operating on a hidden copy.)
  const tileBefore = (await win.locator('.chat-tile__title').first().innerText()).trim();
  const openRow = win.locator('.session-item:visible').first();
  const rowTitle = (await openRow.locator('.session-item__title').innerText()).trim();
  expect(rowTitle, 'the top History row should be the open session (parity precondition)').toBe(
    tileBefore,
  );

  // Rename via the HISTORY row's context menu → Rename → inline input.
  await openRow.click({ button: 'right' });
  const renameBtn = win.locator('.session-item__menu-item:visible', { hasText: 'Rename' }).first();
  await expect(renameBtn).toBeVisible({ timeout: 5_000 });
  await renameBtn.click();
  await win.waitForTimeout(300);

  // The inline rename input renders in the editing row. In the narrow compact
  // sessions rail it has width 0 (CSS), so Playwright's actionability would
  // reject .fill(); drive the REAL onInput/onKeyDown handlers directly: focus
  // the editing input, type the name (real key events → setDraft), Enter
  // (→ commitEdit → renameChat). The assertion below still reads rendered DOM.
  const editInputSel = '.session-item--editing .session-item__title-input';
  await expect(win.locator(editInputSel)).toHaveCount(1, { timeout: 5_000 });
  const unique = `HIST-RENAME-${Date.now()}`;
  await win.evaluate((sel) => {
    (document.querySelector(sel) as HTMLInputElement | null)?.focus();
  }, editInputSel);
  await win.keyboard.type(unique);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(700);

  // BUG 1 fix: the History rename propagates to the TILE header (renameChat
  // override → titleFor). On the old code the tile would still show tileBefore.
  const tileAfter = (await win.locator('.chat-tile__title').first().innerText()).trim();
  expect(
    tileAfter,
    `tile header should reflect the History rename "${unique}" (was "${tileBefore}")`,
  ).toBe(unique);
});

test('BUG 2: a name typed when creating a session sticks on the tile after the terminal is ready', async () => {
  await closeAllChats(win).catch(() => undefined);
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(200);

  // Open the New session form and type a unique name.
  await win.locator('.new-session-bar__trigger').click();
  const titleInput = win.locator('.nsb-input--title');
  await expect(titleInput).toBeVisible({ timeout: 5_000 });
  const unique = `CREATE-NAME-${Date.now()}`;
  await titleInput.fill(unique);

  // Launch the fresh session.
  await win.locator('.nsb-btn--run').click();

  // Tile mounts; the typed name is an override → shown immediately AND kept
  // after the terminal is ready (i.e. after claude starts and any auto disk
  // title would otherwise shadow it).
  await win.locator('.chat-tile .xterm').first().waitFor({ state: 'visible', timeout: 45_000 });
  await awaitChatReady(win, 30_000).catch(() => undefined);
  await win.waitForTimeout(1_500); // give claude a chance to write a session + auto title

  const tileTitle = (await win.locator('.chat-tile__title').first().innerText()).trim();
  expect(tileTitle, `tile header should keep the user-typed creation name "${unique}"`).toBe(
    unique,
  );
});
