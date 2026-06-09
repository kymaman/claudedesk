/**
 * session-transcript.ts
 *
 * Reads a claude session JSONL and renders it to text styled like
 * claude Code's OWN live TUI — `●` assistant bullets, `⎿` collapsed
 * tool results, and a `>` user-prompt marker — so that when the user
 * scrolls up through a resumed chat the history looks NATIVE, exactly
 * like the messages they'd see while chatting live.
 *
 * Why this exists: claude (2.1.116 AND 2.1.162) does NOT replay the
 * conversation on `--resume`. Empirically it emits <1KB (banner +
 * trust prompt) then idles. So xterm's scrollback is empty and there
 * is nothing to scroll into. We pre-fill the scrollback from the
 * JSONL before the PTY output lands.
 *
 * The earlier version used a hand-rolled `[ USER ] / [ ASSISTANT ] /
 * [ TOOL RESULT ]` block format — the user (rightly) called it
 * unreadable and "not the original". This renderer mirrors claude's
 * native look instead:
 *
 *     > <user prompt>
 *
 *     ● <assistant text>
 *
 *     ● Bash(npm run build)
 *       ⎿  <result preview, dimmed>
 *          … +18 lines
 *
 * Tool calls are paired with their tool_result (by tool_use_id) and
 * the result is shown collapsed under `⎿`, just like the live TUI.
 *
 * Hard cap of 1.5 MB keeps the IPC payload small and matches xterm's
 * scrollback budget; older turns are trimmed from the FRONT so the
 * most recent context is always kept.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getClaudeProjectsDir } from '../paths.js';
import { isNoiseUserText } from './session-title.js';

const MAX_TRANSCRIPT_BYTES = 1_500_000;
// Bound memory on huge (50MB+) sessions: keep only the most recent
// turns / results in a rolling window. Tool results sit a few entries
// after their tool_use, so a wide window keeps pairing intact.
const MAX_ENTRIES = 8_000;
const MAX_RESULTS = 8_000;

// ANSI colours (subtle, persist in xterm scrollback). Chosen to echo
// claude's own palette: green action bullet, cyan user marker, dim
// grey tool results.
const C = {
  bullet: '\x1b[32m', // green
  user: '\x1b[36m', // cyan
  bold: '\x1b[1m',
  unbold: '\x1b[22m',
  dim: '\x1b[90m', // bright black / grey
  reset: '\x1b[0m',
  fg: '\x1b[39m',
};

interface ContentBlock {
  type?: string;
  text?: string;
  content?: string | ContentBlock[];
  input?: Record<string, unknown> | unknown;
  name?: string;
  id?: string;
  tool_use_id?: string;
}

interface JsonlEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

interface Turn {
  role: 'user' | 'assistant';
  blocks: ContentBlock[];
}

// ---------------------------------------------------------------------------
// Native-style rendering
// ---------------------------------------------------------------------------

/** Prefix the first line with `marker`, indent continuation lines so
 *  wrapped text lines up under the first character after the marker. */
function gutter(text: string, markerColored: string, indent: string): string {
  // Normalize ALL carriage returns — including LONE `\r` — to `\n`.
  // Conversation content (e.g. old-format transcript blocks the user
  // pasted into a message) can contain bare `\r`, which xterm treats
  // as "return to column 0". Left in, those bytes make pasted lines
  // render at column 0 and masquerade as structural headers instead
  // of sitting indented under their `●`/`❯` turn. Converting `\r` to a
  // real newline routes them through the indent logic below.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(i === 0 ? `${markerColored}${lines[i]}` : `${indent}${lines[i]}`);
  }
  return out.join('\n');
}

/** Map a tool name to claude's display verb + a short argument. */
function toolLabel(block: ContentBlock): string {
  const name = block.name ?? 'Tool';
  const input = (block.input ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const oneLine = (v: string, n = 90): string => {
    const t = v.replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  const base = (p: string): string => {
    if (!p) return '';
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  };
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `Bash(${oneLine(s('command') || s('script'))})`;
    case 'Edit':
    case 'MultiEdit':
      return `Update(${base(s('file_path'))})`;
    case 'Write':
      return `Write(${base(s('file_path'))})`;
    case 'NotebookEdit':
      return `Update(${base(s('notebook_path'))})`;
    case 'Read':
      return `Read(${base(s('file_path'))})`;
    case 'Grep':
      return `Grep(${oneLine(s('pattern'))})`;
    case 'Glob':
      return `Glob(${oneLine(s('pattern'))})`;
    case 'WebFetch':
      return `Fetch(${oneLine(s('url'))})`;
    case 'WebSearch':
      return `Web Search(${oneLine(s('query'))})`;
    case 'Task':
    case 'Agent':
      return `Task(${oneLine(s('description') || s('prompt'))})`;
    case 'TodoWrite':
      return 'Update Todos';
    default: {
      const firstStr = Object.values(input).find((v) => typeof v === 'string') as
        | string
        | undefined;
      return firstStr ? `${name}(${oneLine(firstStr, 60)})` : name;
    }
  }
}

/** Collapsed, dimmed preview of a tool result — first lines + "+N more". */
function resultPreview(raw: string | undefined): string {
  if (raw === undefined || raw === '') return `${C.dim}  ⎿  (no output)${C.reset}`;
  // Normalize lone `\r` too (see gutter) so result previews never
  // carry stray carriage returns into the xterm buffer.
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) return `${C.dim}  ⎿  (no output)${C.reset}`;
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const shown = lines.slice(0, 2).map((l) => (l.length > 100 ? l.slice(0, 100) + '…' : l));
  const more = lines.length - shown.length;
  const body = shown
    .map((l, i) => (i === 0 ? `${C.dim}  ⎿  ${l}${C.reset}` : `${C.dim}     ${l}${C.reset}`))
    .join('\n');
  if (more > 0) {
    return `${body}\n${C.dim}     … +${more} line(s)${C.reset}`;
  }
  return body;
}

/** Strip claude's inline `⎿ Wrote N lines / 1.. 2..` preview dumps that
 *  sometimes get embedded inside a text block (quoted TUI output). */
const PREVIEW_HEADER_RE = /^\s*⎿\s+(Wrote|Read|Edited|Updated|Created|Listed)\b/;
const PREVIEW_NUMBERED_LINE_RE = /^\s+\d+\s/;
const PREVIEW_NUMBERED_MULTILINE_RE = /^\s+\d+\s/m;
function collapseInlineToolPreviews(text: string): string {
  if (!text || (!text.includes('⎿') && !PREVIEW_NUMBERED_MULTILINE_RE.test(text))) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (PREVIEW_HEADER_RE.test(line)) {
      out.push(line.trimEnd());
      i += 1;
      let hidden = 0;
      while (i < lines.length) {
        const peek = lines[i];
        if (PREVIEW_NUMBERED_LINE_RE.test(peek)) {
          hidden += 1;
          i += 1;
          continue;
        }
        if (
          peek.trim() === '' &&
          i + 1 < lines.length &&
          PREVIEW_NUMBERED_LINE_RE.test(lines[i + 1])
        ) {
          hidden += 1;
          i += 1;
          continue;
        }
        break;
      }
      if (hidden > 0) out.push(`   … [${hidden} preview line(s) hidden]`);
      continue;
    }
    if (PREVIEW_NUMBERED_LINE_RE.test(line)) {
      let run = 0;
      const start = i;
      while (i < lines.length && PREVIEW_NUMBERED_LINE_RE.test(lines[i])) {
        run += 1;
        i += 1;
      }
      if (run >= 3) out.push(`   … [${run} numbered preview line(s) hidden]`);
      else for (let k = start; k < i; k += 1) out.push(lines[k]);
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

function textOf(content: string | ContentBlock[] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** Render one turn into native-styled text blocks. */
function renderTurn(turn: Turn, toolResults: Map<string, string>): string {
  if (turn.role === 'user') {
    // Show only real user prose — tool_result-only user messages are
    // inlined under their tool call, not shown as standalone turns.
    const txt = collapseInlineToolPreviews(textOf(turn.blocks).trim());
    if (!txt) return '';
    // Skip continuation banners / caveat blocks / slash-command
    // wrappers. In compacted sessions the first "user" message is the
    // huge "This session is being continued…" wall — rendering it
    // floods the scrollback with lines the user doesn't want.
    if (isNoiseUserText(txt)) return '';
    // `❯` (U+276F) is the exact glyph claude uses for user turns in
    // its own scrollback — matching it makes the pre-filled transcript
    // indistinguishable from claude's live rendering.
    return gutter(txt, `${C.user}❯${C.reset} `, '  ');
  }

  // Assistant: render each block in order.
  const segments: string[] = [];
  for (const block of turn.blocks) {
    if (typeof block.text === 'string' && block.text.trim()) {
      const txt = collapseInlineToolPreviews(block.text.trim());
      segments.push(gutter(txt, `${C.bullet}●${C.reset} `, '  '));
    } else if (block.type === 'tool_use') {
      const label = toolLabel(block);
      const head = `${C.bullet}●${C.reset} ${C.bold}${label}${C.unbold}`;
      const id = typeof block.id === 'string' ? block.id : '';
      const preview = resultPreview(id ? toolResults.get(id) : undefined);
      segments.push(`${head}\n${preview}`);
    }
  }
  return segments.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// File lookup
// ---------------------------------------------------------------------------

function findSessionFile(sessionId: string): string | null {
  const root = getClaudeProjectsDir();
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length>0 guarantees pop()
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name === `${sessionId}.jsonl`) return full;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function loadSessionTranscript(opts: {
  sessionId?: string;
  filePath?: string;
}): Promise<string> {
  const filePath =
    opts.filePath && opts.filePath.length > 0
      ? opts.filePath
      : opts.sessionId
        ? findSessionFile(opts.sessionId)
        : null;
  if (!filePath || !fs.existsSync(filePath)) return '';

  return new Promise<string>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    // Rolling windows keep memory bounded on multi-MB sessions.
    const turns: Turn[] = [];
    const toolResults = new Map<string, string>();
    const resultOrder: string[] = [];

    const pushResult = (id: string, text: string) => {
      if (!toolResults.has(id)) resultOrder.push(id);
      toolResults.set(id, text);
      if (resultOrder.length > MAX_RESULTS) {
        const old = resultOrder.shift();
        if (old) toolResults.delete(old);
      }
    };

    rl.on('line', (raw) => {
      if (!raw.trim()) return;
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(raw) as JsonlEntry;
      } catch {
        return;
      }
      const t = entry.type;
      if (t !== 'user' && t !== 'assistant') return;
      const content = entry.message?.content;
      if (content === undefined || content === null) return;

      // Harvest tool_result blocks into the pairing map regardless of
      // which side they arrived on (claude stores them in user msgs).
      const blocks: ContentBlock[] = Array.isArray(content)
        ? (content as ContentBlock[])
        : [{ type: 'text', text: String(content) }];
      for (const b of blocks) {
        if (b && typeof b === 'object' && b.type === 'tool_result' && b.tool_use_id) {
          const resText =
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? textOf(b.content)
                : '';
          pushResult(b.tool_use_id, resText);
        }
      }

      // Does this entry carry anything renderable (prose or tool_use)?
      const renderable = blocks.some(
        (b) =>
          b &&
          typeof b === 'object' &&
          ((typeof b.text === 'string' && b.text.trim()) || b.type === 'tool_use'),
      );
      if (!renderable) return;

      turns.push({ role: t as 'user' | 'assistant', blocks });
      if (turns.length > MAX_ENTRIES) turns.shift();
    });

    rl.on('close', () => {
      const rendered: string[] = [];
      for (const turn of turns) {
        const block = renderTurn(turn, toolResults);
        if (block.trim()) rendered.push(block);
      }

      // Join turns with a blank line; trim from the FRONT to fit the cap
      // so the freshest context survives.
      let body = rendered.join('\n\n');
      let dropped = 0;
      if (body.length > MAX_TRANSCRIPT_BYTES) {
        // Drop whole leading turns until under cap.
        while (rendered.length > 0 && rendered.join('\n\n').length > MAX_TRANSCRIPT_BYTES) {
          rendered.shift();
          dropped += 1;
        }
        body = rendered.join('\n\n');
      }
      const banner =
        dropped > 0
          ? `${C.dim}  … ${dropped} older message(s) hidden (history capped) …${C.reset}\n\n`
          : '';

      // CRLF so xterm returns the cursor to column 0 on each newline.
      const text = (banner + body).replace(/\n/g, '\r\n');
      resolve(text + '\r\n');
    });

    rl.on('error', reject);
  });
}
