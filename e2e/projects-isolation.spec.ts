/**
 * e2e/projects-isolation.spec.ts
 *
 * Surface-level checks for the Projects-isolation work shipped in v0.3.10.
 * The internal store-level invariants (don't-close-chats, openChatsInProject
 * filter, reorderChat) are exhaustively covered by the unit suite at
 * src/store/chat-projects-isolation.test.ts — this spec just confirms the
 * wiring is reachable from the UI:
 *   - The Projects tab renders and opens the panel.
 *   - The "+ new chat" button shows up next to the project header.
 *   - "▶ open all" and "✕" close-the-view buttons are still present.
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

test('Projects panel exposes "+ new chat", "▶ open all", and close buttons in the active-project header', async () => {
  await win.locator('.ts-nav', { hasText: 'Projects' }).click();
  await win.waitForTimeout(400);
  await expect(win.locator('.projects-panel')).toBeVisible({ timeout: 5_000 });

  // Create a project so the active-project header materialises.
  const folderName = `pi-${Date.now().toString().slice(-6)}`;
  await win.evaluate(async (name) => {
    const bridge = (
      window as unknown as {
        electron?: {
          ipcRenderer: { invoke: (ch: string, args?: unknown) => Promise<unknown> };
        };
      }
    ).electron;
    const project = (await bridge?.ipcRenderer.invoke('create_project_ws', { name })) as
      | { id: string }
      | undefined;
    return project?.id ?? null;
  }, folderName);

  // Refresh the rail by toggling the tab.
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.locator('.ts-nav', { hasText: 'Projects' }).click();
  await win.waitForTimeout(300);

  // Click the project we just created.
  await win.locator('.projects-rail__row', { hasText: folderName }).click();

  const head = win.locator('.projects-main__head');
  await expect(head).toBeVisible({ timeout: 4_000 });
  await expect(head.locator('button', { hasText: '▶ open all' })).toBeVisible();
  await expect(head.locator('button', { hasText: '+ new chat' })).toBeVisible();
  await expect(head.locator('button', { hasText: '✕' })).toBeVisible();

  // Cleanup: delete the test project via its row × button.
  const row = win.locator('.projects-rail__row', { hasText: folderName });
  win.once('dialog', (d) => d.accept().catch(() => undefined));
  await row.locator('.projects-rail__row-x').click();
});
