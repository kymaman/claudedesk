/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures index into known-shaped data */
/**
 * session-transcript.test.ts
 *
 * Pins the native-style rendering invariants: claude-like `●` / `⎿` /
 * `>` markers, tool calls collapsed and paired with their result, no
 * raw file-content dumps, most-recent-kept truncation, and CRLF.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadSessionTranscript, chooseRevealTarget } from './session-transcript.js';

function writeJsonl(file: string, entries: unknown[]): void {
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

// Strip ANSI so assertions read plainly.
// eslint-disable-next-line no-control-regex
const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(STRIP_ANSI, '');

describe('loadSessionTranscript — native rendering', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    file = path.join(dir, 'session.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns empty for missing file', async () => {
    expect(await loadSessionTranscript({ filePath: path.join(dir, 'nope.jsonl') })).toBe('');
  });

  it('renders user prompts with a ❯ marker and assistant text with a ● bullet', async () => {
    writeJsonl(file, [
      { type: 'user', message: { role: 'user', content: 'fix the scroll bug' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
      },
    ]);
    const out = plain(await loadSessionTranscript({ filePath: file }));
    expect(out).toMatch(/❯\s+fix the scroll bug/);
    expect(out).toMatch(/●\s+On it\./);
  });

  it('terminates every line with CRLF', async () => {
    writeJsonl(file, [{ type: 'user', message: { role: 'user', content: 'a\nb' } }]);
    const out = await loadSessionTranscript({ filePath: file });
    const lf = (out.match(/\n/g) ?? []).length;
    const crlf = (out.match(/\r\n/g) ?? []).length;
    expect(crlf).toBe(lf);
  });

  it('renders a Bash tool call as ● Bash(cmd) with a ⎿ result preview', async () => {
    writeJsonl(file, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm run build' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'built ok\nline2\nline3\nline4' },
          ],
        },
      },
    ]);
    const out = plain(await loadSessionTranscript({ filePath: file }));
    expect(out).toContain('● Bash(npm run build)');
    expect(out).toContain('⎿  built ok');
    // Long result is collapsed, not dumped in full.
    expect(out).toMatch(/\+\d+ line\(s\)/);
    expect(out).not.toContain('line4');
  });

  it('collapses Edit/Write to ● Update(file)/Write(file) — never inlines content', async () => {
    const huge = 'export const x = 1\n'.repeat(500);
    writeJsonl(file, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Edit',
              input: { file_path: '/a/foo.ts', new_string: huge },
            },
            {
              type: 'tool_use',
              id: 't2',
              name: 'Write',
              input: { file_path: '/a/bar.md', content: huge },
            },
          ],
        },
      },
    ]);
    const out = plain(await loadSessionTranscript({ filePath: file }));
    expect(out).toContain('● Update(foo.ts)');
    expect(out).toContain('● Write(bar.md)');
    expect(out).not.toContain('export const x = 1');
  });

  it('pairs tool_use with its tool_result by id', async () => {
    writeJsonl(file, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'abc', name: 'Read', input: { file_path: '/x/y.ts' } }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'file contents here' }],
        },
      },
    ]);
    const out = plain(await loadSessionTranscript({ filePath: file }));
    expect(out).toContain('● Read(y.ts)');
    expect(out).toContain('⎿  file contents here');
  });

  it('does not render tool_result-only user turns as a > prompt', async () => {
    writeJsonl(file, [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'orphan result' }],
        },
      },
    ]);
    const out = plain(await loadSessionTranscript({ filePath: file }));
    // No standalone "❯ orphan result" — tool results are not user prose.
    expect(out).not.toMatch(/❯\s+orphan result/);
    expect(out).not.toMatch(/>\s+orphan result/);
  });

  it('strips embedded ⎿ Wrote N lines previews inside text blocks', async () => {
    writeJsonl(file, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Done.\n⎿  Wrote 200 lines to /x.ts\n       1 /**\n       2  * header\n       3  */\nTail.',
            },
          ],
        },
      },
    ]);
    const out = plain(await loadSessionTranscript({ filePath: file }));
    expect(out).toContain('Wrote 200 lines to /x.ts');
    expect(out).not.toContain('/**');
    expect(out).toContain('Tail.');
  });

  it('keeps the MOST RECENT turns when truncating, drops oldest', async () => {
    const big = 'pad '.repeat(20_000);
    const entries: unknown[] = [];
    for (let i = 0; i < 30; i += 1) {
      entries.push({ type: 'user', message: { role: 'user', content: `MARK_${i}:: ${big}` } });
    }
    writeJsonl(file, entries);
    const out = plain(await loadSessionTranscript({ filePath: file }));
    expect(out).toContain('MARK_29');
    expect(out).not.toContain('MARK_0::');
    expect(out).toMatch(/older message\(s\) hidden/);
  });

  it('skips meta entries (mode, ai-title, attachment)', async () => {
    writeJsonl(file, [
      { type: 'mode', mode: 'normal' },
      { type: 'ai-title', aiTitle: 'whatever' },
      { type: 'attachment', attachment: {} },
    ]);
    expect(plain(await loadSessionTranscript({ filePath: file })).trim()).toBe('');
  });

  it('does NOT render the continuation banner (compacted-chat flood fix)', async () => {
    const banner =
      'This session is being continued from a previous conversation that ran out of context. ' +
      'The summary below covers the earlier portion of the conversation.\n' +
      'Lots and lots of summary lines.\n'.repeat(40);
    writeJsonl(file, [
      { type: 'user', message: { role: 'user', content: banner } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing.' }] },
      },
    ]);
    const out = plain(await loadSessionTranscript({ filePath: file }));
    expect(out).not.toContain('This session is being continued');
    expect(out).not.toContain('Lots and lots of summary');
    // The real assistant turn still renders.
    expect(out).toContain('● Continuing.');
  });

  it('REGRESSION: pasted old-format content with bare CR never lands at column 0', async () => {
    // The exact shape that broke: the user pasted an old-format
    // transcript block into a message, separated by LONE carriage
    // returns. xterm resets to column 0 on every \r, so if those
    // survive, the pasted `[ TOOL RESULT ]` / `----` lines render at
    // column 0 and look like structural headers. After the fix they
    // must be indented under the ❯ user turn.
    const pasted =
      'status\r\r----------------------------------------\r[ ASSISTANT ]\r' +
      '----------------------------------------\r[Bash] cd /x && run\r' +
      '> tool_result · 9 line(s), 625 byte(s) (hidden)';
    writeJsonl(file, [{ type: 'user', message: { role: 'user', content: pasted } }]);
    const raw = await loadSessionTranscript({ filePath: file });
    const out = plain(raw);
    // Model xterm: a column-0 line starts after \r OR \n.
    const cols0 = out.split(/\r\n|\r|\n/);
    const bareHeaders = cols0.filter((l) => /^\[ (USER|ASSISTANT|TOOL RESULT) \]$/.test(l));
    const bareRules = cols0.filter((l) => /^-{40}$/.test(l));
    const bareTRS = cols0.filter((l) => /^> tool_result · \d+ line/.test(l));
    expect(bareHeaders, `bare headers at col0: ${JSON.stringify(bareHeaders)}`).toEqual([]);
    expect(bareRules).toEqual([]);
    expect(bareTRS).toEqual([]);
    // The user's actual words still render (under the ❯ marker).
    expect(out).toContain('status');
  });

  it('REGRESSION: never emits the old hand-rolled block format', async () => {
    writeJsonl(file, [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a\nb\nc\nd\ne' }],
        },
      },
    ]);
    const out = plain(await loadSessionTranscript({ filePath: file }));
    // The unreadable format the user rejected must be gone for good.
    expect(out).not.toContain('[ USER ]');
    expect(out).not.toContain('[ ASSISTANT ]');
    expect(out).not.toContain('[ TOOL RESULT ]');
    expect(out).not.toMatch(/tool_result · \d+ line/);
    expect(out).not.toContain('----------------------------------------');
    // Native markers present instead.
    expect(out).toContain('●');
    expect(out).toContain('⎿');
  });
});

// ---------------------------------------------------------------------------
// Smoke test against the user's REAL sessions, when present on disk.
// Skipped on CI / machines without ~/.claude/projects. Proves the
// renderer produces native output (no old format, bounded tool
// previews) on actual conversation data — the case the user reported.
// ---------------------------------------------------------------------------
describe('loadSessionTranscript — real sessions (smoke)', () => {
  const root = path.join(os.homedir(), '.claude', 'projects');

  function someRealSessions(limit: number): string[] {
    if (!fs.existsSync(root)) return [];
    const found: { p: string; size: number }[] = [];
    const stack = [root];
    while (stack.length && found.length < 400) {
      const d = stack.pop()!;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'subagents') stack.push(fp);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const sz = fs.statSync(fp).size;
            if (sz > 20_000) found.push({ p: fp, size: sz });
          } catch {
            /* ignore */
          }
        }
      }
    }
    return found
      .sort((a, b) => b.size - a.size)
      .slice(0, limit)
      .map((f) => f.p);
  }

  const sessions = someRealSessions(4);

  it.runIf(sessions.length > 0)(
    'renders real sessions in native format with no old artifacts',
    async () => {
      for (const fp of sessions) {
        const raw = await loadSessionTranscript({ filePath: fp });
        const out = plain(raw);
        // Native, not the old block format.
        expect(out, `old format leaked in ${fp}`).not.toContain('[ ASSISTANT ]');
        expect(out, `old tool_result line in ${fp}`).not.toMatch(/tool_result · \d+ line/);
        // Has real content and at least one native marker.
        expect(out.length, `empty render for ${fp}`).toBeGreaterThan(0);
        expect(/[●>]/.test(out), `no native marker in ${fp}`).toBe(true);
        // Within the byte cap.
        expect(raw.length).toBeLessThanOrEqual(1_600_000);
      }
    },
    30_000,
  );
});

describe('loadSessionTranscript — huge-file tail seek', () => {
  it('reads only the tail of a >8MB JSONL (early turns beyond the window are cut)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-tail-'));
    const file = path.join(dir, 'big.jsonl');
    try {
      const early = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'EARLY-MARKER turn' },
      });
      // ~9MB of non-renderable padding entries between the two real turns.
      const pad = JSON.stringify({ type: 'progress', pad: 'A'.repeat(1024) });
      const late = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'FINAL-TURN survives' },
      });
      fs.writeFileSync(
        file,
        early + '\n' + Array(9000).fill(pad).join('\n') + '\n' + late + '\n',
        'utf-8',
      );

      const t0 = Date.now();
      const out = plain(await loadSessionTranscript({ filePath: file }));
      const tookMs = Date.now() - t0;

      // The tail window starts mid-file: the early turn is physically
      // outside the read range, the final turn renders fine.
      expect(out).toContain('FINAL-TURN survives');
      expect(out).not.toContain('EARLY-MARKER');
      // Sanity (not a strict perf assertion): tail read of 8MB must not
      // take longer than a generous CI-safe bound.
      expect(tookMs).toBeLessThan(5_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('chooseRevealTarget — "Open dialog folder" picks the transcript, not the cwd', () => {
  it('reveals the session .jsonl when it exists (opens its folder, selects it)', () => {
    const file = '/home/u/.claude/projects/-home-u-proj/abc.jsonl';
    expect(chooseRevealTarget(file, '/home/u/proj')).toEqual({ kind: 'reveal', path: file });
  });

  it('falls back to opening the working dir when there is no session file yet', () => {
    expect(chooseRevealTarget(null, '/home/u/proj')).toEqual({
      kind: 'open',
      path: '/home/u/proj',
    });
  });

  it('prefers the session file over the fallback (never the project cwd when a dialog exists)', () => {
    const file = '/p/x.jsonl';
    const target = chooseRevealTarget(file, '/work/dir');
    expect(target).toEqual({ kind: 'reveal', path: file });
  });

  it('returns null when neither a session file nor a fallback is available', () => {
    expect(chooseRevealTarget(null)).toBeNull();
    expect(chooseRevealTarget(null, undefined)).toBeNull();
  });
});
