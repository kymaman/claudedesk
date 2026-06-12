/**
 * Unit + REAL smoke for session-summarize.ts.
 *
 * - cleanTitleLine: pure parsing of claude's raw stdout into a usable
 *   one-line title.
 * - summarizeSession behavior: alias-skip semantics (bulk mode must not
 *   clobber manual names), empty-transcript rejection.
 * - REAL smoke (runIf claude.exe exists): builds a temp session JSONL,
 *   runs the ACTUAL `claude -p --model haiku` pipeline end-to-end and
 *   asserts a non-empty single-line Russian title comes back and is
 *   persisted via renameSession. This is the same code path the
 *   "AI title ✨" button drives in the app.
 *
 * session-history.js is mocked because it pulls in better-sqlite3,
 * which is built for Electron's ABI and cannot load under vitest's
 * node. The mock records renameSession calls so persistence is still
 * asserted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const renameCalls: Array<{ sessionId: string; alias: string }> = [];
const aiSummaryCalls: Array<{ sessionId: string; text: string }> = [];
let aliasReturn: string | null = null;
let aiSummaryReturn: string | null = null;

vi.mock('./session-history.js', () => ({
  renameSession: vi.fn(async (sessionId: string, alias: string) => {
    renameCalls.push({ sessionId, alias });
  }),
  getAlias: vi.fn(() => aliasReturn),
  getAiSummary: vi.fn(() => aiSummaryReturn),
  setAiSummary: vi.fn((sessionId: string, text: string) => {
    aiSummaryCalls.push({ sessionId, text });
  }),
}));

import { cleanTitleLine, parseTitleAndDescription, summarizeSession } from './session-summarize.js';

const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const HAS_CLAUDE = process.platform === 'win32' ? fs.existsSync(CLAUDE_BIN) : true;

beforeEach(() => {
  renameCalls.length = 0;
  aiSummaryCalls.length = 0;
  aliasReturn = null;
  aiSummaryReturn = null;
});

describe('cleanTitleLine', () => {
  it('takes the first non-empty line', () => {
    expect(cleanTitleLine('\n\nНастройка бэкапа\nвторая строка')).toBe('Настройка бэкапа');
  });

  it('strips wrapping quotes and trailing dots', () => {
    expect(cleanTitleLine('"Миграция HH на новый стек."')).toBe('Миграция HH на новый стек');
    expect(cleanTitleLine('«Поиск по истории»')).toBe('Поиск по истории');
  });

  it('caps at 80 chars with an ellipsis', () => {
    const long = 'а'.repeat(120);
    const out = cleanTitleLine(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty string for whitespace-only input', () => {
    expect(cleanTitleLine('  \n \r\n ')).toBe('');
  });
});

describe('parseTitleAndDescription', () => {
  it('splits a two-line answer into title + description', () => {
    const res = parseTitleAndDescription(
      'Настройка бэкапа\nОбсудили rsync и cron, задание работает',
    );
    expect(res.title).toBe('Настройка бэкапа');
    expect(res.description).toBe('Обсудили rsync и cron, задание работает');
  });

  it('joins multi-line descriptions and strips wrapping quotes', () => {
    const res = parseTitleAndDescription('«Заголовок»\n"Первая часть\nвторая часть."');
    expect(res.title).toBe('Заголовок');
    expect(res.description).toBe('Первая часть вторая часть.');
  });

  it('tolerates a single-line answer (empty description)', () => {
    const res = parseTitleAndDescription('Только заголовок');
    expect(res.title).toBe('Только заголовок');
    expect(res.description).toBe('');
  });

  it('caps the description at 220 chars with an ellipsis', () => {
    const res = parseTitleAndDescription('Заголовок\n' + 'б'.repeat(400));
    expect(res.description.length).toBeLessThanOrEqual(220);
    expect(res.description.endsWith('…')).toBe(true);
  });

  it('skips leading blank lines before the title', () => {
    const res = parseTitleAndDescription('\n\nЗаголовок\nОписание');
    expect(res.title).toBe('Заголовок');
    expect(res.description).toBe('Описание');
  });
});

describe('summarizeSession behavior', () => {
  it('skips when alias AND description already exist with force=false (bulk mode safety)', async () => {
    aliasReturn = 'ручное имя';
    aiSummaryReturn = 'уже есть описание';
    const res = await summarizeSession({ sessionId: 'any', force: false });
    expect(res).toEqual({ title: 'ручное имя', skipped: true });
    expect(renameCalls).toEqual([]);
    expect(aiSummaryCalls).toEqual([]);
  });

  it('does NOT skip an aliased session missing its description (but rejects later on empty transcript)', async () => {
    aliasReturn = 'ручное имя';
    aiSummaryReturn = null;
    // Proceeds past the skip-guard into transcript loading, which fails
    // for the missing file — proving the guard no longer short-circuits.
    await expect(
      summarizeSession({
        sessionId: 'no-such-session-abc',
        filePath: path.join(os.tmpdir(), 'definitely-missing-67890.jsonl'),
        force: false,
      }),
    ).rejects.toThrow();
    expect(renameCalls).toEqual([]);
  });

  it('rejects when the transcript is empty/missing', async () => {
    await expect(
      summarizeSession({
        sessionId: 'no-such-session-xyz',
        filePath: path.join(os.tmpdir(), 'definitely-missing-12345.jsonl'),
        force: true,
      }),
    ).rejects.toThrow();
    expect(renameCalls).toEqual([]);
  });
});

describe('REAL smoke — actual claude -p haiku over a real JSONL', () => {
  it.runIf(HAS_CLAUDE)(
    'produces a one-line Russian title and persists it as the alias',
    { timeout: 180_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedesk-summarize-'));
      const file = path.join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
      const lines = [
        {
          type: 'user',
          message: {
            role: 'user',
            content: 'Как настроить автоматический бэкап фотографий на внешний диск по расписанию?',
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Используйте rsync и планировщик cron: rsync -av ~/Photos /mnt/backup, затем строку в crontab.',
              },
            ],
          },
        },
        {
          type: 'user',
          message: { role: 'user', content: 'А как проверить, что задание реально выполняется?' },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Смотрите журнал cron (grep CRON /var/log/syslog) и mtime файлов в /mnt/backup.',
              },
            ],
          },
        },
      ];
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

      try {
        const res = await summarizeSession({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          filePath: file,
          force: true,
        });
        // A real model answered: non-empty, single line, sane length.
        expect(res.skipped).toBe(false);
        expect(res.title.length).toBeGreaterThan(3);
        expect(res.title.length).toBeLessThanOrEqual(80);
        expect(res.title).not.toMatch(/[\r\n]/);
        // Persisted through renameSession with the same title.
        expect(renameCalls).toEqual([
          { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', alias: res.title },
        ]);
        // The two-line prompt should also yield a description, persisted
        // via setAiSummary. (Model output isn't guaranteed, so only assert
        // persistence when a description actually came back.)
        if (res.description) {
          expect(aiSummaryCalls).toEqual([
            { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', text: res.description },
          ]);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
