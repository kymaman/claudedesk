/**
 * e2e/project-click-spawns-chat.spec.ts
 *
 * Pins the deliberate UX decision (Variant A): clicking a project does
 * NOT auto-spawn a chat. A freshly entered, empty project shows the
 * ChatsGrid empty hint ("Click ▶ on a session in History…") with zero
 * tiles; the user creates a terminal explicitly via "+ new chat".
 *
 * History: an earlier version auto-spawned a chat in openProject()
 * whenever the project had zero open chats ("user should always land on
 * a usable terminal"). But openProject() is the project-row onClick
 * handler, so that fallback fired on EVERY click — clicking the row and
 * then "+ new chat" produced TWO tiles. That was the duplication bug the
 * user reported when switching between projects. The fallback was removed;
 * the no-surprise empty-state is the intended behaviour.
 *
 * This test now guards AGAINST the auto-spawn coming back: entering an
 * empty project must yield 0 tiles, and a single "+ new chat" click must
 * yield exactly 1 (never 2).
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchApp,
  closeAllChats,
  resetProjectsState,
  visibleProjectChatTiles,
  createProjectViaUi,
  projectRow,
} from './helpers.js';

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

test.beforeEach(async () => {
  await resetProjectsState(win);
});

test('entering a fresh empty project shows the empty hint (no auto-spawn)', async () => {
  const name = `prj-empty-${Date.now().toString().slice(-6)}`;
  await createProjectViaUi(win, name);

  // Leave then re-enter to simulate a real "click the rail row" entry.
  await win.locator('.projects-rail__btn', { hasText: '✕' }).first().click();
  await win.waitForTimeout(300);
  await projectRow(win, name).click();
  await win.waitForTimeout(800);

  // Variant A: zero tiles, the empty hint is shown. Clicking a project
  // must NOT fabricate a terminal — that auto-spawn was the source of
  // the tile-duplication bug.
  await expect(visibleProjectChatTiles(win)).toHaveCount(0, { timeout: 5_000 });
  await expect(win.locator('.projects-main__grid .chats-grid__empty')).toBeVisible({
    timeout: 5_000,
  });
});

test('+ new chat in an empty project creates exactly one tile (never two)', async () => {
  const name = `prj-one-${Date.now().toString().slice(-6)}`;
  await createProjectViaUi(win, name);
  await projectRow(win, name).click();
  await win.waitForTimeout(300);

  // Single explicit creation → exactly one tile.
  await win.locator('.projects-main__head button', { hasText: '+ new chat' }).click();
  await win.waitForTimeout(800);
  await expect(visibleProjectChatTiles(win)).toHaveCount(1, { timeout: 5_000 });

  // Re-clicking the row (re-entering the project) must not add a second
  // tile — the chat is already alive, openProject is idempotent.
  await projectRow(win, name).click();
  await win.waitForTimeout(400);
  await expect(visibleProjectChatTiles(win)).toHaveCount(1);
});
