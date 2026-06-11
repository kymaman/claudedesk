/**
 * session-transcript-full-answers.test.ts
 *
 * User report (2026-06-10): «опять не вижу полные ответы, скрываются»
 * — in resumed tiles parts of assistant answers are missing from the
 * pre-filled scrollback.
 *
 * Two layers:
 *  1. Synthetic pins — long prose answers, answers with numbered
 *     lines, and real user prompts that merely MENTION continuation
 *     phrases must all survive rendering in full.
 *  2. REAL sweep (runIf the user's ~/.claude/projects exists): render
 *     the newest real sessions and assert every long assistant text
 *     from the JSONL is present in the output. This is the test that
 *     actually catches whatever the user is seeing.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (_: string): string =>
      path.join(os.tmpdir(), `claudedesk-transcript-test-${process.pid}`),
  },
}));

import { loadSessionTranscript } from './session-transcript.js';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const HAS_REAL = fs.existsSync(PROJECTS);

// eslint-disable-next-line no-control-regex -- stripping ANSI colour escapes from rendered transcripts
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const flat = (s: string): string => s.replace(/\s+/g, ' ');

function writeSession(dir: string, lines: unknown[]): string {
  const f = path.join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return f;
}

const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const asst = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('synthetic: full answers survive rendering', () => {
  it('a long multi-paragraph assistant answer is rendered IN FULL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-ta-'));
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) =>
        `Абзац номер ${i}: это длинное содержательное объяснение того, как работает префилл истории в терминале.`,
    );
    const answer = paragraphs.join('\n\n');
    const f = writeSession(dir, [user('расскажи подробно'), asst(answer)]);
    try {
      const out = flat(strip(await loadSessionTranscript({ sessionId: 'x', filePath: f })));
      for (const p of paragraphs) {
        expect(out, `paragraph missing: "${p.slice(0, 50)}…"`).toContain(flat(p));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an answer containing a numbered list with bare numbers is NOT collapsed', async () => {
    // collapseInlineToolPreviews hides runs of 3+ lines matching
    // /^\s+\d+\s/ — meant for quoted cat -n file previews, but answers
    // legitimately contain indented numbered lines too.
    const answer = [
      'Вот шаги настройки:',
      ' 1 установить пакет',
      ' 2 прописать конфиг',
      ' 3 перезапустить сервис',
      ' 4 проверить логи',
      'Готово — это весь план.',
    ].join('\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-ta-'));
    const f = writeSession(dir, [user('как настроить?'), asst(answer)]);
    try {
      const out = flat(strip(await loadSessionTranscript({ sessionId: 'x', filePath: f })));
      expect(out).toContain('1 установить пакет');
      expect(out).toContain('4 проверить логи');
      expect(out).not.toContain('preview line(s) hidden');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a real user prompt that merely MENTIONS "ran out of context" is not hidden', async () => {
    const prompt =
      'Слушай, вчера сессия упала с ошибкой that ran out of context — давай разберёмся, почему так вышло и как чинить.';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-ta-'));
    const f = writeSession(dir, [user(prompt), asst('Разбираемся: причина в лимите контекста.')]);
    try {
      const out = flat(strip(await loadSessionTranscript({ sessionId: 'x', filePath: f })));
      expect(out, 'user prompt mentioning the phrase was swallowed as noise').toContain(
        flat('давай разберёмся, почему так вышло'),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an answer quoting a ⎿ Wrote preview keeps ALL prose around the quote', async () => {
    const answer = [
      'Я записал файл, вот что вывела команда:',
      '⎿  Wrote 25 lines to config.json',
      '     1  {',
      '     2    "name": "test",',
      '     3    "version": "1.0.0"',
      'Это важное продолжение ответа после цитаты — оно должно остаться видимым.',
    ].join('\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-ta-'));
    const f = writeSession(dir, [user('запиши конфиг'), asst(answer)]);
    try {
      const out = flat(strip(await loadSessionTranscript({ sessionId: 'x', filePath: f })));
      expect(out).toContain(flat('Я записал файл, вот что вывела команда:'));
      expect(out).toContain(flat('Это важное продолжение ответа после цитаты'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(HAS_REAL)('REAL sweep: newest sessions render all long answers', () => {
  it(
    'every long assistant text from the JSONL appears in the rendered transcript',
    { timeout: 120_000 },
    async () => {
      // newest 6 real session files across all projects
      const files: Array<{ f: string; mt: number }> = [];
      for (const dir of fs.readdirSync(PROJECTS)) {
        const full = path.join(PROJECTS, dir);
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(full);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (!name.endsWith('.jsonl')) continue;
          const fp = path.join(full, name);
          try {
            const st = fs.statSync(fp);
            if (st.size > 10_000) files.push({ f: fp, mt: st.mtimeMs });
          } catch {
            /* ignore */
          }
        }
      }
      files.sort((a, b) => b.mt - a.mt);
      const newest = files.slice(0, 6);
      expect(newest.length).toBeGreaterThan(0);

      const problems: string[] = [];
      for (const { f } of newest) {
        const rendered = flat(strip(await loadSessionTranscript({ sessionId: 'x', filePath: f })));
        const lines = fs.readFileSync(f, 'utf-8').split('\n');
        let checked = 0;
        for (const raw of lines) {
          if (!raw.trim()) continue;
          let e: { type?: string; message?: { content?: unknown } };
          try {
            e = JSON.parse(raw) as typeof e;
          } catch {
            continue;
          }
          if (e.type !== 'assistant') continue;
          const c = e.message?.content;
          if (!Array.isArray(c)) continue;
          for (const b of c as Array<{ type?: string; text?: string }>) {
            if (b?.type !== 'text' || typeof b.text !== 'string') continue;
            const t = b.text.trim();
            if (t.length < 200) continue;
            checked += 1;
            // probe a slice from the middle of the answer — start/end can
            // be legitimately reformatted by gutter/indent logic
            const probe = flat(t.slice(60, 140)).trim();
            if (probe.length < 40) continue;
            if (!rendered.includes(probe)) {
              problems.push(
                `${path.basename(f)}: HIDDEN answer fragment: "${flat(t.slice(0, 120))}…"`,
              );
            }
          }
        }
        // sanity: the sweep actually exercised something
        expect(checked).toBeGreaterThanOrEqual(0);
      }
      expect(
        problems,
        `${problems.length} long answer(s) missing from rendered transcripts:\n` +
          problems.slice(0, 15).join('\n'),
      ).toEqual([]);
    },
  );
});
