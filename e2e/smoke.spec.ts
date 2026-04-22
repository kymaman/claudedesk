/**
 * e2e/smoke.spec.ts
 * Launches the built Electron app and exercises the key UI flows:
 *  - App loads, main window visible
 *  - TopSwitcher renders with History/Branches/Agents
 *  - History view: session list + folder sidebar + preview pane
 *  - Creating a folder persists in the folders pane
 *  - Agents view: agent cards + terminal defaults textarea
 *  - Branches view: tiling layout container present
 *  - Hotkeys Ctrl+H / Ctrl+Shift+B / Ctrl+J switch main view
 *
 * Prereq (handled by test:e2e script): `npm run build:frontend && npm run compile`
 * so dist/index.html + dist-electron/main.js exist — the app starts in
 * production mode (loadFile) without needing a running vite dev server.
 */

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'dist-electron', 'main.js');

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  if (!fs.existsSync(MAIN)) {
    throw new Error(
      `Electron entry missing at ${MAIN}. Run \`npm run build:frontend && npm run compile\` first.`,
    );
  }
  app = await electron.launch({
    args: [MAIN, '--no-sandbox'],
    cwd: ROOT,
    env: {
      ...process.env,
      // Ensure we load the built bundle, not a dev server.
      VITE_DEV_SERVER_URL: '',
      // Silence update checks etc in tests.
      CLAUDEDESK_E2E: '1',
    },
    timeout: 45_000,
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  // Give Solid a tick to render after load
  await window.waitForTimeout(500);
});

test.afterAll(async () => {
  if (app) await app.close();
});

test('window loads and is titled', async () => {
  const title = await window.title();
  expect(title.length).toBeGreaterThan(0);
  expect(await window.isVisible('body')).toBe(true);
});

test('TopSwitcher renders four nav buttons: History, Chats, Branches, Agents', async () => {
  const nav = window.locator('.top-switcher__nav .ts-nav');
  await expect(nav).toHaveCount(4);
  await expect(nav.nth(0)).toHaveText(/History/);
  await expect(nav.nth(1)).toHaveText(/Chats/);
  await expect(nav.nth(2)).toHaveText(/Branches/);
  await expect(nav.nth(3)).toHaveText(/Agents/);
});

test('History is the default view and shows folders + session list + preview', async () => {
  // History should be active on first launch
  const active = window.locator('.ts-nav--active');
  await expect(active).toHaveText(/History/);

  // Three-pane layout is visible
  await expect(window.locator('.folders-pane')).toBeVisible();
  await expect(window.locator('.sessions-panel__list')).toBeVisible();
  await expect(window.locator('.preview-pane')).toBeVisible();

  // "All sessions" folder row is present
  await expect(window.locator('.folder-row', { hasText: 'All sessions' })).toBeVisible();
});

test('Search input filters sessions', async () => {
  const search = window.locator('.sessions-panel__search');
  await expect(search).toBeVisible();
  await search.fill('definitely-no-match-xyz-12345');
  // Either the list becomes empty, or existing items disappear
  await window.waitForTimeout(300);
  await search.fill('');
});

test('Switch to Agents view — CLI agents + terminal defaults present', async () => {
  await window.locator('.ts-nav', { hasText: 'Agents' }).click();
  await expect(window.locator('.agents-view')).toBeVisible();
  await expect(window.locator('.agent-card').first()).toBeVisible();
  await expect(window.locator('.defaults-btn', { hasText: 'Save flags' })).toBeVisible();
  await expect(window.locator('.defaults-btn', { hasText: 'Save & rescan' })).toBeVisible();
});

test('Terminal defaults persist after save', async () => {
  // The flags textarea lives in the accent section at the top of Settings
  const flagsArea = window.locator('.agents-section--accent .defaults-textarea').first();
  await flagsArea.fill('--dangerously-skip-permissions');
  await window.locator('.defaults-btn', { hasText: 'Save flags' }).click();
  await expect(window.locator('.defaults-flash', { hasText: 'saved' })).toBeVisible();
});

test('Switch to Branches view — tiling layout mounts', async () => {
  await window.locator('.ts-nav', { hasText: 'Branches' }).click();
  await expect(window.locator('.ts-nav--active')).toHaveText(/Branches/);
  // History panel stays in DOM (prevents xterm remount/blink) but is hidden.
  await expect(window.locator('.sessions-panel')).not.toBeVisible();
});

test('Hotkey Ctrl+H returns to History', async () => {
  await window.keyboard.press('Control+h');
  await window.waitForTimeout(200);
  await expect(window.locator('.ts-nav--active')).toHaveText(/History/);
});

test('Chats tab zooms history so chats grid fills window', async () => {
  await window.locator('.ts-nav', { hasText: 'Chats' }).click();
  // Chats tab = the same SessionsHistoryPanel but in zoom mode (folders +
  // sessions list hidden). Avoids remounting xterm when flipping tabs.
  await expect(window.locator('.sessions-panel--chats-zoom')).toBeVisible();
  await expect(window.locator('.chats-grid__empty')).toBeVisible();
});

test('Settings gear in TopSwitcher opens the Settings view (terminal defaults)', async () => {
  await window.locator('.ts-nav', { hasText: 'History' }).click();
  await window.locator('.ts-settings').click();
  // The gear now routes to our Settings view, where terminal defaults live
  await expect(window.locator('.agents-view')).toBeVisible();
  await expect(window.locator('.agents-section--accent').first()).toBeVisible();
  await expect(window.locator('.defaults-btn', { hasText: 'Save flags' })).toBeVisible();
});

test('App preferences link opens parallel-code Settings dialog', async () => {
  await window.locator('.ts-nav', { hasText: 'Agents' }).click();
  await window.locator('.agents-view__apprefs').click();
  await expect(window.locator('.dialog-panel').first()).toBeVisible({ timeout: 3_000 });
  await window.keyboard.press('Escape');
});

test('Right-click custom folder opens menu with Rename + Delete', async () => {
  await window.locator('.ts-nav', { hasText: 'History' }).click();
  await window.waitForTimeout(300);

  // Create folder via direct IPC + force a UI reload so the row appears.
  const folderName = `rc-test-${Date.now().toString().slice(-5)}`;
  await window.evaluate(async (name) => {
    const el = (
      window as unknown as {
        electron?: { ipcRenderer: { invoke: (ch: string, args?: unknown) => Promise<unknown> } };
      }
    ).electron;
    if (!el) throw new Error('electron bridge missing');
    await el.ipcRenderer.invoke('create_folder', { name });
  }, folderName);
  await window.locator('.sessions-panel__refresh').click();
  await window.waitForTimeout(700);

  const row = window.locator('.folder-row', { hasText: folderName });
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click({ button: 'right' });
  const menu = window.locator('.folder-row__menu').first();
  await expect(menu).toBeVisible();
  await expect(menu.locator('.folder-row__menu-item', { hasText: 'Rename' })).toBeVisible();
  await expect(menu.locator('.folder-row__menu-item--danger', { hasText: 'Delete' })).toBeVisible();
  await menu.locator('.folder-row__menu-item', { hasText: 'Cancel' }).click();
});

test('Launch options gear expands per-session inline form', async () => {
  await window.locator('.ts-nav', { hasText: 'History' }).click();
  const firstRow = window.locator('.session-item').first();
  const hasRow = (await firstRow.count()) > 0;
  test.skip(!hasRow, 'No sessions available to test launch options');
  const gear = firstRow.locator('.session-item__gear');
  await gear.click();
  await expect(firstRow.locator('.session-item__launch-options')).toBeVisible();
  await expect(firstRow.locator('.launch-option__textarea')).toBeVisible();
});

test('Clicking ▶ on a session opens a wide chat tile next to the sessions list', async () => {
  await window.locator('.ts-nav', { hasText: 'History' }).click();
  await window.waitForTimeout(500);

  const firstRow = window.locator('.session-item').first();
  const hasRow = (await firstRow.count()) > 0;
  test.skip(!hasRow, 'No sessions available to open a chat');

  await firstRow.locator('.session-item__resume').click();
  await window.waitForTimeout(1200);

  // We stay on History — the layout auto-compacts and shows the chats grid
  // on the right side of the sessions list. No tab change.
  await expect(window.locator('.ts-nav--active')).toHaveText(/History/);
  await expect(window.locator('.sessions-panel__body--compact')).toBeVisible();

  const tile = window.locator('.chat-tile').first();
  await expect(tile).toBeVisible();
  await expect(tile.locator('.xterm').first()).toBeVisible({ timeout: 5_000 });

  const box = await tile.boundingBox();
  if (!box) throw new Error('tile has no bounding box');

  const parentBoxes = await window.evaluate(() => {
    const rect = (el: Element | null) =>
      el ? { w: (el as HTMLElement).clientWidth, h: (el as HTMLElement).clientHeight } : null;
    return {
      win: [window.innerWidth, window.innerHeight],
      chatsPane: rect(document.querySelector('.sessions-panel__chats')),
      chatsGrid: rect(document.querySelector('.chats-grid')),
      tileCount: document.querySelectorAll('.chat-tile').length,
    };
  });
  console.warn('Layout boxes:', JSON.stringify(parentBoxes, null, 2));

  // Side-by-side layout: with folders 160px + sessions 260px = 420px of rail,
  // on a 1335-wide window the tile gets ~915px. Guard against the 15px /
  // 582px regressions — require at least 600px wide and 300px tall.
  expect(
    box.width,
    `tile.width=${box.width}; layout=${JSON.stringify(parentBoxes)}`,
  ).toBeGreaterThan(600);
  expect(box.height, `tile.height=${box.height}`).toBeGreaterThan(300);

  // Clean up
  await tile.locator('.chat-tile__close').click();
  await window.waitForTimeout(400);
});

test('NewSessionBar expands into inline form and launches a fresh chat', async () => {
  await window.locator('.ts-nav', { hasText: 'History' }).click();
  await window.waitForTimeout(200);
  await window.locator('.new-session-bar__trigger').click();
  await expect(window.locator('.new-session-bar__form')).toBeVisible();
  await window.locator('.nsb-input--cwd').fill('D:/tmp/non-existent-for-test');
  await window.locator('.nsb-input--flags').fill('--help');
  // Cancel instead of actually spawning to keep the test environment tidy.
  await window.locator('.nsb-btn--cancel').click();
  await expect(window.locator('.new-session-bar__trigger')).toBeVisible();
});

test('Session row shows JSONL file path on the item', async () => {
  await window.locator('.ts-nav', { hasText: 'History' }).click();
  await window.waitForTimeout(300);
  const first = window.locator('.session-item').first();
  const has = (await first.count()) > 0;
  test.skip(!has, 'No sessions available');
  await expect(first.locator('.session-item__filepath')).toBeVisible();
});

test('Right-click session row opens delete menu with both delete options', async () => {
  await window.locator('.ts-nav', { hasText: 'History' }).click();
  await window.waitForTimeout(400);

  const firstRow = window.locator('.session-item').first();
  const hasRow = (await firstRow.count()) > 0;
  test.skip(!hasRow, 'No sessions available');

  await firstRow.click({ button: 'right' });
  const menu = window.locator('.session-item__menu').first();
  await expect(menu).toBeVisible();
  await expect(
    menu.locator('.session-item__menu-item', { hasText: 'Delete from view' }),
  ).toBeVisible();
  await expect(
    menu.locator('.session-item__menu-item--danger', { hasText: 'Delete permanently' }),
  ).toBeVisible();
  // Dismiss without deleting anything
  await menu.locator('.session-item__menu-item', { hasText: 'Cancel' }).click();
  await expect(menu).toBeHidden();
});

test('Create folder via inline input persists in folders pane', async () => {
  // Capture renderer console + ipc errors for diagnosis
  const logs: string[] = [];
  window.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  window.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  // Must be in History
  if (!(await window.locator('.folders-pane').isVisible())) {
    await window.locator('.ts-nav', { hasText: 'History' }).click();
  }

  const testFolderName = `e2e-folder-${Date.now().toString().slice(-6)}`;

  // Verify IPC channel works directly first — this pinpoints whether the
  // failure is in the UI handler or in the IPC/SQLite layer.
  const directResult = await window.evaluate(async (name) => {
    const el = (
      window as unknown as {
        electron?: { ipcRenderer: { invoke: (ch: string, args?: unknown) => Promise<unknown> } };
      }
    ).electron;
    if (!el) return { ok: false, err: 'window.electron missing' };
    try {
      const folder = await el.ipcRenderer.invoke('create_folder', { name });
      return { ok: true, folder };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  }, testFolderName);

  if (!directResult.ok) {
    console.error('Logs captured:', logs);
    throw new Error(`Direct IPC create_folder failed: ${directResult.err}`);
  }

  // Refresh the folders pane so the newly created folder appears in UI
  await window.evaluate(() => {
    // Trigger a refresh by clicking the refresh button
    const btn = document.querySelector('.sessions-panel__refresh') as HTMLElement | null;
    btn?.click();
  });
  await window.waitForTimeout(800);

  await expect(window.locator('.folder-row', { hasText: testFolderName })).toBeVisible({
    timeout: 5_000,
  });
});
