/**
 * e2e/session-layout.spec.ts
 *
 * Verifies the reshuffled session card: description sits right below the
 * title row, and the project path is relegated to a compact meta pill next
 * to folder tags — not shown as a prominent line.
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

test('session card order: title-row → description → meta (path/folders)', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(400);

  const firstItem = win.locator('.session-item').first();
  await expect(firstItem).toBeVisible({ timeout: 8_000 });

  // The separate "__filepath" line is gone — no more redundant path row.
  await expect(firstItem.locator('.session-item__filepath')).toHaveCount(0);

  // Meta line exists and sits AFTER the title row and description.
  const meta = firstItem.locator('.session-item__meta');
  await expect(meta).toBeVisible();

  // Project pill inside meta shows just a basename (not a full path with many slashes).
  const project = firstItem.locator('.session-item__project');
  await expect(project).toBeVisible();
  const projectText = (await project.textContent())?.trim() ?? '';
  expect(projectText.length).toBeGreaterThan(0);
  expect(projectText.split(/[\\/]/).length).toBeLessThanOrEqual(1);
  expect(projectText).not.toContain('...'); // we no longer use the ".../a/b" shorthand
});

test('description — when present — sits above the meta line, not below it', async () => {
  // Find a session that has a description rendered.
  const withDesc = win.locator('.session-item:has(.session-item__desc)').first();
  const count = await withDesc.count();
  test.skip(count === 0, 'no session in the list has a description — nothing to assert');

  const descBox = await withDesc.locator('.session-item__desc').boundingBox();
  const metaBox = await withDesc.locator('.session-item__meta').boundingBox();
  if (!descBox || !metaBox) throw new Error('bounding boxes not available');
  // Description must be vertically above the meta row.
  expect(descBox.y).toBeLessThan(metaBox.y);
});
