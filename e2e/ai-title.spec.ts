/* eslint-disable @typescript-eslint/no-non-null-assertion -- test asserts presence above */
/**
 * e2e/ai-title.spec.ts
 *
 * REAL end-to-end proof of the "AI title ✨" feature: a synthetic (but
 * real, on-disk) session JSONL is planted under ~/.claude/projects, the
 * live Electron app finds it in History, the row's context menu's
 * "AI title ✨" runs the ACTUAL `claude -p --model haiku` pipeline, and
 * the row title becomes a model-generated one-liner — visible in the
 * list without any refresh, persisted as the session alias.
 *
 * The synthetic session (not a real user session) keeps the test
 * non-destructive; afterAll deletes the planted file + its DB rows via
 * the real delete_session_file IPC.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { launchApp, closeAllChats, type BridgeWindow } from './helpers.js';

const MARKER = 'e2e-ai-title-marker';
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', 'e2e-ai-title-tests');
const SESSION_ID = randomUUID();
const FILE = path.join(PROJ_DIR, `${SESSION_ID}.jsonl`);

const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const HAS_CLAUDE = process.platform === 'win32' ? fs.existsSync(CLAUDE_BIN) : true;

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  const lines = [
    {
      type: 'user',
      message: {
        role: 'user',
        content: `${MARKER}: как настроить автоматический бэкап фотографий на внешний диск по расписанию?`,
      },
      cwd: 'D:/tmp/e2e-ai-title',
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Используйте rsync + cron: rsync -av ~/Photos /mnt/backup, затем добавьте строку в crontab -e.',
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: 'А как убедиться, что задание реально выполняется каждый день?',
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Проверяйте журнал cron и время изменения файлов в /mnt/backup.' },
        ],
      },
    },
  ];
  fs.writeFileSync(FILE, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

  ({ app, win } = await launchApp());
});

test.describe.configure({ timeout: 240_000 });

test.afterAll(async () => {
  try {
    if (app && win) {
      // Real cleanup path: removes the planted JSONL + alias/summary rows.
      await win
        .evaluate(
          async ({ sessionId, filePath }) => {
            const bridge = (window as unknown as BridgeWindow).electron;
            await bridge?.ipcRenderer.invoke('delete_session_file', { sessionId, filePath });
          },
          { sessionId: SESSION_ID, filePath: FILE },
        )
        .catch(() => undefined);
      await closeAllChats(win).catch(() => undefined);
    }
  } finally {
    fs.rmSync(PROJ_DIR, { recursive: true, force: true });
    if (app) await app.close();
  }
});

// eslint-disable-next-line no-empty-pattern -- need testInfo; fixture is unused
test('AI title ✨ renames a session row with a real haiku one-liner, live', async ({}, info) => {
  if (!HAS_CLAUDE) test.skip(true, 'claude binary not installed');

  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(400);

  // Find the planted session through the REAL search box.
  const search = win.locator('.sessions-panel__search');
  await expect(search).toBeVisible({ timeout: 5_000 });
  await search.fill(MARKER);
  await win.waitForTimeout(500);

  const row = win.locator('.session-item').first();
  await expect(row, 'planted session not found in History').toBeVisible({ timeout: 10_000 });
  const oldTitle = (await row.locator('.session-item__title').innerText()).trim();
  expect(oldTitle).toContain(MARKER);

  // Right-click → AI title ✨ (the real context-menu path).
  await row.click({ button: 'right' });
  const aiBtn = win.locator('.session-item__menu-item', { hasText: 'AI title' });
  await expect(aiBtn).toBeVisible({ timeout: 4_000 });
  await aiBtn.click();

  // The row stays visible (search still matches the description) and
  // its title becomes the model's one-liner — without any refresh.
  const title = row.locator('.session-item__title');
  await expect(title, 'AI title did not replace the marker title').not.toContainText(MARKER, {
    timeout: 180_000,
  });
  const newTitle = (await title.innerText()).trim();

  await info.attach('ai-title.txt', {
    body: Buffer.from(`old="${oldTitle}"\nnew="${newTitle}"`, 'utf8'),
    contentType: 'text/plain; charset=utf-8',
  });

  expect(newTitle.length).toBeGreaterThan(3);
  expect(newTitle.length).toBeLessThanOrEqual(80);

  // Persistence: the REAL list IPC returns the alias as the title now.
  const persisted = await win.evaluate(async (sid) => {
    const bridge = (window as unknown as BridgeWindow).electron;
    const list = (await bridge!.ipcRenderer.invoke('list_claude_sessions')) as Array<{
      sessionId: string;
      title: string;
    }>;
    return list.find((s) => s.sessionId === sid)?.title ?? null;
  }, SESSION_ID);
  expect(persisted).toBe(newTitle);

  await search.fill('');
});
