/**
 * Capture README screenshots by driving the packaged Electron build with Playwright.
 * Run with: npx tsx scripts/capture-screenshots.ts
 */
import { _electron as electron } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'dist-electron', 'main.js');
const OUT = path.join(ROOT, 'docs', 'screenshots');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const app = await electron.launch({
    args: [MAIN, '--no-sandbox'],
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: '',
      CLAUDEDESK_E2E: '1',
    },
    timeout: 45_000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1600, height: 1000 });
  await win.waitForTimeout(1200);

  async function shot(name: string) {
    const fp = path.join(OUT, `${name}.png`);
    await win.screenshot({ path: fp });
    // eslint-disable-next-line no-console
    console.log('saved', path.relative(ROOT, fp));
  }

  // 1. History (default view, session list + preview pane)
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(600);
  await shot('01-history');

  // 2. Hover a session so the preview pane populates
  const firstRow = win.locator('.session-item').first();
  if (await firstRow.count()) {
    await firstRow.hover();
    await win.waitForTimeout(800);
    await shot('02-history-preview');
  }

  // 3. Launch options: click gear on first row
  if (await firstRow.count()) {
    await firstRow.locator('.session-item__gear').click();
    await win.waitForTimeout(400);
    await shot('03-launch-options');
    // Collapse it
    await firstRow.locator('.session-item__gear').click();
    await win.waitForTimeout(200);
  }

  // 4. New Session bar expanded
  await win.locator('.new-session-bar__trigger').click();
  await win.waitForTimeout(300);
  await shot('04-new-session-bar');
  await win.locator('.nsb-btn--cancel').click();
  await win.waitForTimeout(200);

  // 5. Open a chat → side-by-side compact layout
  if (await firstRow.count()) {
    await firstRow.locator('.session-item__resume').click();
    await win.waitForTimeout(2000);
    await shot('05-chat-compact');
    // Close the chat so the last shot shows a clean Settings view
    const tile = win.locator('.chat-tile').first();
    if (await tile.count()) {
      await tile.locator('.chat-tile__close').click();
      await win.waitForTimeout(400);
    }
  }

  // 6. Agents & Settings
  await win.locator('.ts-nav', { hasText: 'Agents' }).click();
  await win.waitForTimeout(500);
  await shot('06-agents-settings');

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
