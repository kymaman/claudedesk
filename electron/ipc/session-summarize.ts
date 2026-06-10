/**
 * session-summarize.ts
 *
 * Generates a ONE-LINE Russian title ("о чём этот диалог") for a claude
 * session by feeding the transcript tail to a headless `claude -p
 * --model haiku` run, then persists the result as the session ALIAS —
 * the same mechanism manual rename uses, so the new title shows up
 * everywhere (history panel, search, tile headers) instantly and
 * survives restarts.
 *
 * Why headless claude and not a local heuristic: the user explicitly
 * asked for "the function that writes one line about what was
 * discussed". claude's own JSONL files on this machine carry NO
 * `{type:"summary"}` records (verified across all 534 session files),
 * so the summary has to be generated. Haiku keeps it fast and cheap.
 */

import { spawn } from 'child_process';
import path from 'path';
import { homedir } from 'os';
import fs from 'fs';
import { loadSessionTranscript } from './session-transcript.js';
import { renameSession, getAlias } from './session-history.js';

const SUMMARIZE_TIMEOUT_MS = 90_000;
/** Transcript tail fed to the model — enough to know the topic, small
 *  enough to keep haiku latency ~seconds. */
const TRANSCRIPT_TAIL_CHARS = 7_000;
const MAX_TITLE_CHARS = 80;

// eslint-disable-next-line no-control-regex -- stripping ANSI escapes from transcript
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Same resolution order as agents.ts WIN_CLAUDE_MODERN: prefer the
 *  modern .local/bin binary, fall back to PATH. */
function resolveClaudeBin(): string {
  const modern = path.join(homedir(), '.local', 'bin', 'claude.exe');
  if (process.platform === 'win32' && fs.existsSync(modern)) return modern;
  return 'claude';
}

function runClaudeHeadless(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = resolveClaudeBin();
    const child = spawn(bin, ['-p', '--model', 'haiku'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      reject(new Error('summarize timed out'));
    }, SUMMARIZE_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf-8');
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf-8');
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.write(prompt, 'utf-8');
    child.stdin.end();
  });
}

/** First non-empty line, quotes/trailing dot stripped, length-capped. */
export function cleanTitleLine(raw: string): string {
  const line =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const unquoted = line
    .replace(/^["'«]+/, '')
    .replace(/["'»]+$/, '')
    .replace(/\.+$/, '')
    .trim();
  return unquoted.length > MAX_TITLE_CHARS
    ? unquoted.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…'
    : unquoted;
}

export interface SummarizeResult {
  title: string;
  /** true when an existing manual alias was left untouched. */
  skipped: boolean;
}

export async function summarizeSession(opts: {
  sessionId: string;
  filePath?: string;
  /** Overwrite an existing alias. Default false — bulk runs must not
   *  clobber names the user typed by hand. */
  force?: boolean;
}): Promise<SummarizeResult> {
  const existing = getAlias(opts.sessionId);
  if (existing && !opts.force) {
    return { title: existing, skipped: true };
  }

  const transcript = await loadSessionTranscript({
    sessionId: opts.sessionId,
    ...(opts.filePath ? { filePath: opts.filePath } : {}),
  });
  const plain = transcript.replace(ANSI_RE, '').replace(/\r\n/g, '\n').trim();
  if (!plain) throw new Error('empty transcript');
  const tail = plain.length > TRANSCRIPT_TAIL_CHARS ? plain.slice(-TRANSCRIPT_TAIL_CHARS) : plain;

  const prompt =
    'Ниже фрагмент диалога пользователя с ассистентом. Ответь ОДНОЙ короткой строкой ' +
    'на русском (максимум 8 слов): о чём этот диалог. Без кавычек, без точки в конце, ' +
    'без пояснений — только сама строка.\n\n---\n' +
    tail;

  const raw = await runClaudeHeadless(prompt);
  const title = cleanTitleLine(raw);
  if (!title) throw new Error('claude returned no usable title');

  await renameSession(opts.sessionId, title);
  return { title, skipped: false };
}
