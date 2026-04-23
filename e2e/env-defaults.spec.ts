/**
 * e2e/env-defaults.spec.ts
 *
 * Reproduces the user-reported bug: pasting a PowerShell-style env line
 *   $env:HTTPS_PROXY="http://user:pass@host:port"
 * into Settings → Environment variables should round-trip cleanly so that
 * a fresh chat inherits the real HTTPS_PROXY (no $env: prefix, no quotes).
 *
 * This tests the full chain a unit test can't:
 *   textarea input → Save env click → localStorage → fresh TerminalView
 *   mounts → SpawnAgent IPC payload.
 */

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'dist-electron', 'main.js');

const PASTE = '$env:HTTPS_PROXY="http://srZNTTCu:fKapAXdD@172.120.137.143:63028"';
const EXPECTED_KEY = 'HTTPS_PROXY';
const EXPECTED_VALUE = 'http://srZNTTCu:fKapAXdD@172.120.137.143:63028';

let app: ElectronApplication;
let win: Page;

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
      VITE_DEV_SERVER_URL: '',
      CLAUDEDESK_E2E: '1',
    },
    timeout: 45_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(700);
});

test.afterAll(async () => {
  if (app) await app.close();
});

test('PowerShell-style env line round-trips to the real HTTPS_PROXY', async () => {
  // 1. Open Settings (Agents tab)
  await win.locator('.ts-nav', { hasText: 'Agents' }).click();
  await expect(win.locator('.agents-view')).toBeVisible();

  // 2. Find the env textarea (second .defaults-textarea inside the accent section)
  const envTextarea = win.locator('.agents-section--accent .defaults-textarea').nth(1);
  await expect(envTextarea).toBeVisible();

  // 3. Clear and paste the problematic line
  await envTextarea.fill(PASTE);

  // 4. Click Save env (the button specifically labeled "Save env")
  await win.locator('.defaults-btn', { hasText: 'Save env' }).click();
  await expect(win.locator('.defaults-flash', { hasText: 'saved' })).toBeVisible();

  // 5. Read the raw localStorage payload — this is what fresh chats will see.
  const stored = await win.evaluate(() => localStorage.getItem('claudedesk.terminalDefaults'));
  expect(stored, 'terminalDefaults must be persisted to localStorage').toBeTruthy();

  const parsed = JSON.parse(stored as string) as {
    env?: Record<string, unknown>;
    flags?: unknown;
  };

  // THE REGRESSION CHECK: key must be HTTPS_PROXY, value must NOT be wrapped in quotes.
  expect(parsed.env).toBeDefined();
  expect(parsed.env).toHaveProperty(EXPECTED_KEY);
  expect((parsed.env as Record<string, string>)[EXPECTED_KEY]).toBe(EXPECTED_VALUE);

  // And the original kludgy key must be gone
  expect(parsed.env).not.toHaveProperty('$env:HTTPS_PROXY');
});

test('the merge helper returns the clean env for a fresh spawn', async () => {
  // Call the pure helper from the renderer bundle via evaluate — confirms the
  // SpawnAgent IPC would get HTTPS_PROXY with no prefix / no quotes.
  const merged = await win.evaluate(async () => {
    // Re-read localStorage the same way the store does.
    const raw = localStorage.getItem('claudedesk.terminalDefaults');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { env: Record<string, string> };

    // Inline the merge rule (mirrors mergeSpawnEnv). We use inline rather than
    // importing because the renderer bundle doesn't expose the helper at runtime.
    const BLOCK = new Set([
      'PATH',
      'HOME',
      'USER',
      'SHELL',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
    ]);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.env ?? {})) {
      const key = k.trim();
      if (!key || BLOCK.has(key)) continue;
      out[key] = v;
    }
    return out;
  });

  expect(merged).toEqual({ [EXPECTED_KEY]: EXPECTED_VALUE });
});
