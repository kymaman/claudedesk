/**
 * e2e/title-parity-divergence.spec.ts
 *
 * Real-UI (Electron) regression guard for the title-parity FIX in
 * src/store/sessions-history.ts → sessionsWithOpenChats.
 *
 * THE FIX: the History row for an OPEN chat now renders through the SAME
 * resolver the tile/chip use — titleFor(c) = override ?? _diskTitles ?? base —
 * instead of a separate `override ?? s.title` chain. So the History row and the
 * tile header read ONE source of truth and cannot drift apart.
 *
 * WHY THIS SPEC IS A PARITY PROOF (not a force-a-divergence reproduction):
 * In the running app a true tile↔History title divergence is NOT reproducible,
 * because App.tsx's sessions→tile effect keeps `_diskTitles` pinned to the disk
 * `s.title` for the current session — the effect even subscribes to `_diskTitles`
 * (its body reads it via setDiskTitleForChat) and synchronously reverts any
 * external write back to the disk title. So tile and History already coincide;
 * the fix removes the FRAGILE second precedence chain (future-proofing) rather
 * than changing today's pixels. The unit test (src/store/title-unify.test.ts)
 * pins the precedence at the store level; THIS spec proves end-to-end in the
 * rendered DOM that the two surfaces show identical text for an open session —
 * both at open AND after a user rename, which propagates tile→History through
 * the unified overlay.
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

test('open + rename: History row and tile header render identical text in the real UI', async () => {
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
  await win.waitForTimeout(800); // let App's sessions→tile effect settle

  // Helper: rendered text of every History row title (textContent — the parity
  // property is about the text the row renders, independent of scroll position
  // in the compact sessions rail).
  const rowTitles = (): Promise<string[]> =>
    win.evaluate(() =>
      Array.from(document.querySelectorAll('.session-item__title')).map((e) =>
        (e.textContent ?? '').trim(),
      ),
    );

  // ---- Parity #1: at open, the tile header text appears verbatim as a row ----
  // The open session's row renders titleFor(c) (the unified overlay), which must
  // equal the tile header.
  const tileBase = (await win.locator('.chat-tile__title').first().innerText()).trim();
  expect(tileBase.length, 'tile should have a non-empty title').toBeGreaterThan(0);
  expect(
    (await rowTitles()).filter((t) => t === tileBase).length,
    `a History row should render the SAME title as the tile header ("${tileBase}")`,
  ).toBeGreaterThanOrEqual(1);

  // ---- Parity #2: rename the tile via the real UI; History must follow ----
  // Double-click the tile title → inline editor → type a UNIQUE name → Enter.
  // renameChat sets the override; sessionsWithOpenChats overlays titleFor(c)
  // (= the override) onto the open session's row, so the History row must
  // re-render to the SAME unique string. A unique token can reach a History row
  // ONLY via this open-chat overlay, so the row that shows it IS this session's.
  const unique = `PARITY-UI-${Date.now()}`;
  await win.locator('.chat-tile__title').first().dblclick();
  const input = win.locator('.chat-tile__title-input').first();
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(unique);
  await input.press('Enter');
  await win.waitForTimeout(600); // let both surfaces re-render

  // RENDERED tile header text.
  const tileTitle = (await win.locator('.chat-tile__title').first().innerText()).trim();
  expect(tileTitle, 'tile header should show the renamed title').toBe(unique);

  // RENDERED History row text — exactly the session whose tile we renamed.
  const matches = (await rowTitles()).filter((t) => t === unique);
  expect(
    matches.length,
    'exactly the open session row should render the renamed unique title',
  ).toBe(1);

  // Core parity assertion, read from the rendered DOM of BOTH surfaces.
  expect(matches[0], `History row "${matches[0]}" must equal tile header "${tileTitle}"`).toBe(
    tileTitle,
  );
});
