/**
 * scripts/bulk-summarize.cjs
 *
 * One-shot bulk pass: give EVERY real claude session an AI title (alias)
 * and an AI description (session_summaries.ai_summary) so History shows
 * "название + описание" for the whole archive, not just hand-renamed rows.
 *
 * Mirrors electron/ipc/session-summarize.ts (two-line haiku prompt) but is
 * standalone so it can run OUTSIDE the app, directly against the real DB:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/bulk-summarize.cjs
 *
 * (electron-as-node is required because better-sqlite3 here is built for
 * Electron's ABI.)
 *
 * Safety rules:
 *  - NEVER overwrites an existing alias (manual names win).
 *  - NEVER overwrites an existing ai_summary (idempotent / resumable).
 *  - Helper runs use a dedicated temp cwd; their mini-JSONLs are deleted
 *    from ~/.claude/projects at the end (only that dedicated folder).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const HOME = os.homedir();
const DB_PATH =
  process.env.BULK_DB || path.join(HOME, 'AppData', 'Roaming', 'Electron', 'session-aliases.db');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CLAUDE_BIN = path.join(HOME, '.local', 'bin', 'claude.exe');
const MODEL = process.env.BULK_MODEL || 'haiku';
const CONCURRENCY = Number(process.env.BULK_CONCURRENCY || 3);
const LIMIT = Number(process.env.BULK_LIMIT || 0); // 0 = no limit
const TAIL_CHARS = 7000;
const MAX_TITLE = 80;
const MAX_DESC = 220;
const TIMEOUT_MS = 90_000;
// Same marker session-history.ts uses to hide helper runs from History.
const HELPER_PREFIX = 'Ниже фрагмент диалога пользователя с ассистентом';
// Dedicated cwd for helper runs → their JSONLs land in ONE known project
// folder which we delete afterwards.
const HELPER_CWD = path.join(os.tmpdir(), 'claudedesk-bulk-helper');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** Light transcript: "user: …" / "assistant: …" lines from a JSONL. */
function readTranscript(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const out = [];
  let firstUserText = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const role = obj?.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractText(obj.message.content).trim();
    if (!text) continue;
    if (role === 'user' && firstUserText === null) firstUserText = text;
    out.push(`${role}: ${text}`);
  }
  if (firstUserText && firstUserText.startsWith(HELPER_PREFIX)) return null; // helper run
  const plain = out.join('\n').trim();
  return plain.length > 0 ? plain : null;
}

function cleanLine(line, cap) {
  const un = line
    .replace(/^["'«]+/, '')
    .replace(/["'»]+$/, '')
    .replace(/\.+$/, '')
    .trim();
  return un.length > cap ? un.slice(0, cap - 1).trimEnd() + '…' : un;
}

function parseTwoLines(rawOut) {
  const lines = rawOut.split(/\r?\n/).map((l) => l.trim());
  const i = lines.findIndex((l) => l.length > 0);
  if (i < 0) return { title: '', description: '' };
  const title = cleanLine(lines[i], MAX_TITLE);
  const rest = lines
    .slice(i + 1)
    .filter((l) => l.length > 0)
    .join(' ')
    .replace(/^["'«]+/, '')
    .replace(/["'»]+$/, '')
    .trim();
  const description = rest.length > MAX_DESC ? rest.slice(0, MAX_DESC - 1).trimEnd() + '…' : rest;
  return { title, description };
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', '--model', MODEL], {
      windowsHide: true,
      cwd: HELPER_CWD,
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
      reject(new Error('timeout'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d.toString('utf-8')));
    child.stderr.on('data', (d) => (err += d.toString('utf-8')));
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.write(prompt, 'utf-8');
    child.stdin.end();
  });
}

async function main() {
  if (!fs.existsSync(CLAUDE_BIN)) throw new Error(`claude binary missing: ${CLAUDE_BIN}`);
  fs.mkdirSync(HELPER_CWD, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
  // Make sure the ai_summary column exists even before the app migration ran.
  const cols = db.prepare("PRAGMA table_info('session_summaries')").all();
  if (!cols.some((c) => c.name === 'ai_summary')) {
    db.exec('ALTER TABLE session_summaries ADD COLUMN ai_summary TEXT');
  }

  const getAlias = db.prepare('SELECT alias FROM session_aliases WHERE session_id = ?');
  const getAi = db.prepare('SELECT ai_summary FROM session_summaries WHERE session_id = ?');
  const setAlias = db.prepare(
    'INSERT INTO session_aliases (session_id, alias, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING',
  );
  const updAi = db.prepare('UPDATE session_summaries SET ai_summary = ? WHERE session_id = ?');
  const insAi = db.prepare(
    'INSERT INTO session_summaries (session_id, file_path, mtime_ms, title, summary, cwd, ai_summary, cached_at) VALUES (?, ?, 0, NULL, NULL, NULL, ?, ?)',
  );

  // Collect candidate sessions (newest first so fresh chats get covered early).
  const candidates = [];
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    if (proj.includes('claudedesk-bulk-helper')) continue;
    const dir = path.join(PROJECTS_DIR, proj);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.slice(0, -6);
      if (!UUID_RE.test(sid)) continue;
      const fp = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      if (st.size < 500) continue; // no real content
      const hasAlias = !!getAlias.get(sid);
      const hasAi = !!getAi.get(sid)?.ai_summary;
      if (hasAlias && hasAi) continue;
      candidates.push({ sid, fp, mtime: st.mtimeMs, hasAlias });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const work = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;
  console.log(
    `candidates: ${work.length} (of ${candidates.length}), model=${MODEL}, conc=${CONCURRENCY}`,
  );

  let done = 0;
  let ok = 0;
  let skip = 0;
  let fail = 0;

  async function worker() {
    for (;;) {
      const item = work.shift();
      if (!item) return;
      const tag = `${++done}/${done + work.length} ${item.sid.slice(0, 8)}`;
      try {
        const plain = readTranscript(item.fp);
        if (!plain) {
          skip++;
          console.log(`${tag} SKIP (helper/empty)`);
          continue;
        }
        const tail = plain.length > TAIL_CHARS ? plain.slice(-TAIL_CHARS) : plain;
        const prompt =
          HELPER_PREFIX +
          '. Ответь ДВУМЯ строками на русском. ' +
          'Строка 1: короткое название (максимум 8 слов): о чём этот диалог. ' +
          'Строка 2: описание одним-двумя предложениями (максимум 200 знаков): что обсуждалось и чем закончилось. ' +
          'Без кавычек, без пояснений, без префиксов вроде «Название:» — только эти две строки.\n\n---\n' +
          tail;
        const raw = await runClaude(prompt);
        const { title, description } = parseTwoLines(raw);
        if (!title) throw new Error('no usable title');
        if (!item.hasAlias) setAlias.run(item.sid, title, Date.now());
        if (description) {
          const r = updAi.run(description, item.sid);
          if (r.changes === 0) insAi.run(item.sid, item.fp, description, Date.now());
        }
        ok++;
        console.log(`${tag} OK  ${title}${description ? ' | ' + description.slice(0, 60) : ''}`);
      } catch (e) {
        fail++;
        console.log(`${tag} FAIL ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\ndone: ok=${ok} skip=${skip} fail=${fail}`);

  // Sweep helper mini-JSONLs: only the dedicated helper project folder.
  try {
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      if (proj.includes('claudedesk-bulk-helper')) {
        fs.rmSync(path.join(PROJECTS_DIR, proj), { recursive: true, force: true });
        console.log(`cleaned helper project folder: ${proj}`);
      }
    }
  } catch (e) {
    console.warn('helper cleanup failed:', e.message);
  }
  db.close();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
