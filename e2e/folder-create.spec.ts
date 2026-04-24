/**
 * e2e/folder-create.spec.ts
 *
 * Regression: user reported that typing a folder name and pressing Enter
 * caused the newly-created folder to disappear. Root cause: the "Hide empty"
 * filter (default ON) filters a brand-new (zero-session) folder out of view.
 * Fix: always keep the active folder visible — we set the new folder as
 * active right after creation.
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
let win: Page;

test.beforeAll(async () => {
  if (!fs.existsSync(MAIN)) throw new Error(`build missing at ${MAIN}`);
  app = await electron.launch({
    args: [MAIN, '--no-sandbox'],
    cwd: ROOT,
    env: { ...process.env, VITE_DEV_SERVER_URL: '', CLAUDEDESK_E2E: '1' },
    timeout: 45_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(800);
});

test.afterAll(async () => {
  if (app) await app.close();
});

test('creating a folder via Enter keeps it visible even when "Hide empty" is on', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);

  // Make sure "Hide empty" is on — that's the default and the regression case.
  const hideBtn = win.locator('.folders-pane__footer-btn', { hasText: 'Hide empty' });
  const isActive = (await hideBtn.getAttribute('class'))?.includes('is-active');
  if (!isActive) await hideBtn.click();

  // Click + to start creating
  await win.locator('.folders-pane__add').click();
  const input = win.locator('.folder-create__input');
  await expect(input).toBeVisible();

  const folderName = `e2e-${Date.now().toString().slice(-6)}`;
  await input.fill(folderName);
  await input.press('Enter');

  // The folder must be visible in the pane. Before the fix, Hide-empty was
  // filtering it out the instant it was saved (0 sessions → hidden).
  const row = win.locator('.folder-row', { hasText: folderName });
  await expect(row).toBeVisible({ timeout: 5_000 });

  // And it should be the active folder (we auto-select on create).
  await expect(row).toHaveClass(/folder-row--active/);
});
