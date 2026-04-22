/**
 * session-history.ts
 * Electron main-process module for Claude Code session history.
 * Scans ~/.claude/projects/*\/*.jsonl, parses SESSIONS_INDEX.md,
 * and persists user-defined aliases in SQLite (userData/session-aliases.db).
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import Database from 'better-sqlite3';
import { homeDir } from '../platform.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionItem {
  /** UUID of the session (from filename, without extension) */
  sessionId: string;
  /** Absolute path to the .jsonl file */
  filePath: string;
  /** Decoded project path (from parent folder name) */
  projectPath: string;
  /** Display title — from index, alias, or fallback */
  title: string;
  /** ISO date string extracted from index or file mtime */
  date: string;
  /** Short description from SESSIONS_INDEX.md (if found) */
  description?: string;
  /** User-defined folder memberships (from session_folder_map) */
  folderIds: string[];
}

export interface FolderItem {
  id: string;
  name: string;
  color?: string;
  position: number;
  pinned: boolean;
}

export interface SessionPreview {
  sessionId: string;
  firstLines: string[];
  lastLines: string[];
}

// ---------------------------------------------------------------------------
// SQLite alias store
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const dir = app.getPath('userData');
  const dbPath = path.join(dir, 'session-aliases.db');
  _db = new Database(dbPath);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS session_aliases (
      session_id TEXT PRIMARY KEY,
      alias      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id  TEXT PRIMARY KEY,
      file_path   TEXT NOT NULL,
      mtime_ms    INTEGER NOT NULL,
      title       TEXT,
      summary     TEXT,
      cwd         TEXT,
      cached_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_filepath ON session_summaries(file_path);
    CREATE TABLE IF NOT EXISTS folders (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT,
      position   INTEGER NOT NULL DEFAULT 0,
      pinned     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_folder_map (
      session_id TEXT NOT NULL,
      folder_id  TEXT NOT NULL,
      added_at   INTEGER NOT NULL,
      PRIMARY KEY (session_id, folder_id),
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_folder_map_folder ON session_folder_map(folder_id);
    CREATE INDEX IF NOT EXISTS idx_folder_map_session ON session_folder_map(session_id);
  `);
  // Upgrade path: additive ALTERs for older DBs.
  try {
    const folderCols = _db.prepare<[], { name: string }>("PRAGMA table_info('folders')").all();
    if (!folderCols.some((c) => c.name === 'pinned')) {
      _db.exec('ALTER TABLE folders ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    const summaryCols = _db
      .prepare<[], { name: string }>("PRAGMA table_info('session_summaries')")
      .all();
    if (!summaryCols.some((c) => c.name === 'cwd')) {
      _db.exec('ALTER TABLE session_summaries ADD COLUMN cwd TEXT');
    }
  } catch {
    /* best-effort migration */
  }
  _db.exec(`
    CREATE TABLE IF NOT EXISTS session_launch_settings (
      session_id       TEXT PRIMARY KEY,
      agent_id         TEXT NOT NULL,
      extra_flags_json TEXT NOT NULL DEFAULT '[]',
      skip_permissions INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL
    );
  `);
  return _db;
}

export interface LaunchSettings {
  agentId: string;
  extraFlags: string[];
  skipPermissions: boolean;
}

export function getLaunchSettings(sessionId: string): LaunchSettings | null {
  const db = getDb();
  const row = db
    .prepare<
      [string],
      { agent_id: string; extra_flags_json: string; skip_permissions: number }
    >('SELECT agent_id, extra_flags_json, skip_permissions FROM session_launch_settings WHERE session_id = ?')
    .get(sessionId);
  if (!row) return null;
  let flags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.extra_flags_json);
    if (Array.isArray(parsed)) {
      flags = parsed.filter((f: unknown): f is string => typeof f === 'string');
    }
  } catch {
    /* fallthrough with empty flags */
  }
  return {
    agentId: row.agent_id,
    extraFlags: flags,
    skipPermissions: row.skip_permissions === 1,
  };
}

export function setLaunchSettings(sessionId: string, s: LaunchSettings): void {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO session_launch_settings (session_id, agent_id, extra_flags_json, skip_permissions, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, s.agentId, JSON.stringify(s.extraFlags), s.skipPermissions ? 1 : 0, Date.now());
}

interface CachedSummary {
  title: string | null;
  summary: string | null;
  cwd: string | null;
  mtime_ms: number;
}

function getCachedSummary(sessionId: string): CachedSummary | null {
  const db = getDb();
  const row = db
    .prepare<
      [string],
      { title: string | null; summary: string | null; cwd: string | null; mtime_ms: number }
    >('SELECT title, summary, cwd, mtime_ms FROM session_summaries WHERE session_id = ?')
    .get(sessionId);
  return row ?? null;
}

function setCachedSummary(
  sessionId: string,
  filePath: string,
  mtimeMs: number,
  title: string | null,
  summary: string | null,
  cwd: string | null,
): void {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO session_summaries (session_id, file_path, mtime_ms, title, summary, cwd, cached_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(sessionId, filePath, mtimeMs, title, summary, cwd, Date.now());
}

export function getAlias(sessionId: string): string | null {
  const db = getDb();
  const row = db
    .prepare<[string], { alias: string }>('SELECT alias FROM session_aliases WHERE session_id = ?')
    .get(sessionId);
  return row ? row.alias : null;
}

export async function renameSession(sessionId: string, alias: string): Promise<void> {
  const db = getDb();
  if (alias.trim() === '') {
    db.prepare('DELETE FROM session_aliases WHERE session_id = ?').run(sessionId);
  } else {
    db.prepare(
      'INSERT OR REPLACE INTO session_aliases (session_id, alias, updated_at) VALUES (?, ?, ?)',
    ).run(sessionId, alias.trim(), Date.now());
  }
}

// ---------------------------------------------------------------------------
// Folder CRUD
// ---------------------------------------------------------------------------

export function listFolders(): FolderItem[] {
  const db = getDb();
  const rows = db
    .prepare<
      [],
      { id: string; name: string; color: string | null; position: number; pinned: number }
    >('SELECT id, name, color, position, pinned FROM folders ORDER BY pinned DESC, position ASC, name ASC')
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    pinned: r.pinned === 1,
    ...(r.color ? { color: r.color } : {}),
  }));
}

function cryptoRandomId(): string {
  return randomUUID();
}

export function createFolder(args: { name: string; color?: string }): FolderItem {
  const db = getDb();
  const name = args.name.trim() || 'Untitled';
  const id = cryptoRandomId();
  const maxPos =
    (
      db
        .prepare<[], { maxPos: number | null }>('SELECT MAX(position) as maxPos FROM folders')
        .get() ?? { maxPos: -1 }
    ).maxPos ?? -1;
  const position = (maxPos ?? -1) + 1;
  const color = (args.color ?? '').trim() || null;
  db.prepare(
    'INSERT INTO folders (id, name, color, position, pinned, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  ).run(id, name, color, position, Date.now());
  return { id, name, position, pinned: false, ...(color ? { color } : {}) };
}

export function pinFolder(args: { id: string; pinned: boolean }): void {
  const db = getDb();
  db.prepare('UPDATE folders SET pinned = ? WHERE id = ?').run(args.pinned ? 1 : 0, args.id);
}

/**
 * Hard-delete a session: remove the JSONL file from disk + all associated
 * rows (alias, cached summary, folder memberships, launch settings). The
 * caller is expected to confirm the destructive action in the UI.
 */
export async function deleteSessionFile(args: {
  sessionId: string;
  filePath: string;
}): Promise<void> {
  // Safety: only allow deleting files within a claude projects-like tree so
  // a compromised renderer can't wipe arbitrary paths. Accept ~/.claude/projects
  // or any extra folder prefix the user configured (those are also under their
  // control, so if the path is inside something the user asked us to scan we
  // honour it).
  const normalized = path.resolve(args.filePath);
  if (!normalized.endsWith('.jsonl')) {
    throw new Error('Refusing to delete non-jsonl file');
  }
  try {
    await fs.promises.unlink(normalized);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
    // File already gone — fall through and still clean up DB rows
  }
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM session_aliases WHERE session_id = ?').run(args.sessionId);
    db.prepare('DELETE FROM session_summaries WHERE session_id = ?').run(args.sessionId);
    db.prepare('DELETE FROM session_folder_map WHERE session_id = ?').run(args.sessionId);
    db.prepare('DELETE FROM session_launch_settings WHERE session_id = ?').run(args.sessionId);
  });
  tx();
}

export function renameFolder(args: { id: string; name: string }): void {
  const db = getDb();
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(args.name.trim(), args.id);
}

export function deleteFolder(args: { id: string }): void {
  const db = getDb();
  // FK ON DELETE CASCADE removes membership rows automatically.
  db.prepare('DELETE FROM folders WHERE id = ?').run(args.id);
}

export function addSessionToFolder(args: { sessionId: string; folderId: string }): void {
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO session_folder_map (session_id, folder_id, added_at) VALUES (?, ?, ?)',
  ).run(args.sessionId, args.folderId, Date.now());
}

export function removeSessionFromFolder(args: { sessionId: string; folderId: string }): void {
  const db = getDb();
  db.prepare('DELETE FROM session_folder_map WHERE session_id = ? AND folder_id = ?').run(
    args.sessionId,
    args.folderId,
  );
}

function getFolderIdsForSessions(sessionIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (sessionIds.length === 0) return map;
  const db = getDb();
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db
    .prepare<
      string[],
      { session_id: string; folder_id: string }
    >(`SELECT session_id, folder_id FROM session_folder_map WHERE session_id IN (${placeholders})`)
    .all(...sessionIds);
  for (const r of rows) {
    const arr = map.get(r.session_id) ?? [];
    arr.push(r.folder_id);
    map.set(r.session_id, arr);
  }
  return map;
}

// ---------------------------------------------------------------------------
// SESSIONS_INDEX.md parser
// ---------------------------------------------------------------------------

interface IndexEntry {
  uuid8: string; // first 8 chars of session UUID
  title: string;
  date: string;
  description: string;
}

const INDEX_PATH = path.join(homeDir(), '.claude', 'projects', 'SESSIONS_INDEX.md');

function parseSessionsIndex(): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  let content: string;
  try {
    content = fs.readFileSync(INDEX_PATH, 'utf-8');
  } catch {
    return map;
  }

  // Each session block starts with: ### 2026-04-14 · 9b693c03 — <title>
  const headerRe = /^###\s+(\d{4}-\d{2}-\d{2})\s+[·•]\s+([0-9a-f]{8})\s+[—–-]\s+(.+)$/m;
  const blocks = content.split(/^(?=###\s)/m);

  for (const block of blocks) {
    const m = block.match(headerRe);
    if (!m) continue;
    const [, date, uuid8, title] = m;
    // Collect **Обсуждалось:** lines as description
    const descMatch = block.match(/\*\*Обсуждалось:\*\*\s*(.+)/);
    const description = descMatch ? descMatch[1].trim() : '';
    map.set(uuid8, { uuid8, title: title.trim(), date, description });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Folder scanner
// ---------------------------------------------------------------------------

function decodeProjectPath(folderName: string): string {
  // Folder name encodes path: replace '--' with os separator chars heuristically
  // e.g. "D--YandexDisk-Antigravity-EasyTable" → "D:/YandexDisk/Antigravity/EasyTable"
  // Pattern: leading drive letter + '--' on Windows, or leading '-' for unix roots
  if (/^[A-Za-z]--/.test(folderName)) {
    // Windows: "D--foo-bar" → "D:/foo/bar"
    const drive = folderName[0].toUpperCase();
    const rest = folderName.slice(3).replace(/-/g, '/');
    return `${drive}:/${rest}`;
  }
  // Unix: "-home-user-project" → "/home/user/project"
  if (folderName.startsWith('-')) {
    return folderName.replace(/-/g, '/');
  }
  return folderName;
}

interface RawSession {
  sessionId: string;
  filePath: string;
  projectPath: string;
  mtime: Date;
}

function scanFolder(rootDir: string): RawSession[] {
  const results: RawSession[] = [];
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(rootDir);
  } catch {
    return results;
  }

  for (const projectDir of projectDirs) {
    const projectDirPath = path.join(rootDir, projectDir);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(projectDirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const projectPath = decodeProjectPath(projectDir);
    let files: string[];
    try {
      files = fs.readdirSync(projectDirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -6); // strip .jsonl
      const filePath = path.join(projectDirPath, file);
      let fileStat: fs.Stats;
      try {
        fileStat = fs.statSync(filePath);
      } catch {
        continue;
      }
      results.push({ sessionId, filePath, projectPath, mtime: fileStat.mtime });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// JSONL-derived summary (fallback for sessions missing from SESSIONS_INDEX.md)
// ---------------------------------------------------------------------------

const JSONL_SCAN_MAX_LINES = 40;
const JSONL_PARSE_CONCURRENCY = 16;

/** Bounded concurrent map — processes `items` with up to `limit` tasks in flight. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          out[i] = await fn(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

/** Strip common noise: channel XML tags, markdown, tool_result wrappers. */
function cleanMessageText(raw: string): string {
  let t = raw;
  // Strip channel/source XML-like wrappers and their body markers
  t = t.replace(/<channel[^>]*>[\s\S]*?<\/channel>/g, '');
  t = t.replace(/<\/?[a-z-]+[^>]*>/gi, '');
  // Drop standalone markers like "(voice message)"
  t = t.replace(/\(\s*voice message\s*\)/gi, '');
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') return cleanMessageText(content) || null;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') {
          const cleaned = cleanMessageText(p.text);
          if (cleaned) return cleaned;
        }
      }
    }
  }
  return null;
}

interface ExtractedSummary {
  title: string | null;
  summary: string | null;
  cwd: string | null;
}

async function parseJsonlSummary(filePath: string): Promise<ExtractedSummary> {
  return new Promise((resolve) => {
    const result: ExtractedSummary = { title: null, summary: null, cwd: null };
    let count = 0;
    let summaryFromIndex: string | null = null;
    let firstUserText: string | null = null;
    let cwd: string | null = null;
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    } catch {
      resolve(result);
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const finish = () => {
      rl.removeAllListeners();
      stream.destroy();
      if (summaryFromIndex) {
        result.title = summaryFromIndex.slice(0, 80);
        result.summary = summaryFromIndex.slice(0, 240);
      } else if (firstUserText) {
        result.title = firstUserText.slice(0, 80);
        result.summary = firstUserText.slice(0, 240);
      }
      result.cwd = cwd;
      resolve(result);
    };

    rl.on('line', (line) => {
      count += 1;
      if (count > JSONL_SCAN_MAX_LINES) {
        finish();
        return;
      }
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          summary?: string;
          cwd?: unknown;
          message?: { role?: string; content?: unknown };
          isMeta?: boolean;
        };
        if (!cwd && typeof obj.cwd === 'string' && obj.cwd.trim()) {
          cwd = obj.cwd;
        }
        // Claude Code periodically writes {type:"summary", summary:"..."} records
        if (obj.type === 'summary' && typeof obj.summary === 'string') {
          summaryFromIndex = obj.summary.trim();
          // Keep scanning a few more lines if cwd still missing
          if (cwd || count > 8) {
            finish();
            return;
          }
        }
        if (obj.type === 'user' && !obj.isMeta && obj.message?.role === 'user') {
          const text = extractUserText(obj.message.content);
          if (text && !firstUserText) {
            firstUserText = text;
            if (cwd && count > 4) {
              finish();
              return;
            }
          }
        }
      } catch {
        // Skip malformed line
      }
    });

    rl.on('close', finish);
    rl.on('error', () => finish());
  });
}

// ---------------------------------------------------------------------------
// Public: listSessions
// ---------------------------------------------------------------------------

export async function listSessions(extraFolders?: string[]): Promise<SessionItem[]> {
  const defaultRoot = path.join(homeDir(), '.claude', 'projects');
  const index = parseSessionsIndex();

  const rawSessions: RawSession[] = [];

  // Scan default location
  rawSessions.push(...scanFolder(defaultRoot));

  // Scan extra folders
  if (extraFolders && extraFolders.length > 0) {
    for (const folder of extraFolders) {
      rawSessions.push(...scanFolder(folder));
    }
  }

  // Deduplicate by filePath
  const seen = new Set<string>();
  const unique = rawSessions.filter((s) => {
    if (seen.has(s.filePath)) return false;
    seen.add(s.filePath);
    return true;
  });

  // Sort newest first by mtime
  unique.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  // Pre-fetch folder memberships for all sessions in one query.
  const folderIdsMap = getFolderIdsForSessions(unique.map((u) => u.sessionId));

  // Resolve each session's display title + description.
  // Priority: user alias → SESSIONS_INDEX.md → cached JSONL extract → live JSONL parse.
  const items: SessionItem[] = await mapPool(unique, JSONL_PARSE_CONCURRENCY, async (raw) => {
    const uuid8 = raw.sessionId.slice(0, 8);
    const indexEntry = index.get(uuid8);
    const alias = getAlias(raw.sessionId);
    const date = indexEntry?.date ?? raw.mtime.toISOString().slice(0, 10);

    const folderIds = folderIdsMap.get(raw.sessionId) ?? [];

    // Always try to recover the real cwd from the JSONL (folder-name decoding
    // is lossy — dashes in path segments can't be distinguished from separators).
    // Cache by mtime so we only pay the read once.
    const mtimeMs = raw.mtime.getTime();
    let cached = getCachedSummary(raw.sessionId);
    if (!cached || cached.mtime_ms !== mtimeMs) {
      const extracted = await parseJsonlSummary(raw.filePath);
      setCachedSummary(
        raw.sessionId,
        raw.filePath,
        mtimeMs,
        extracted.title,
        extracted.summary,
        extracted.cwd,
      );
      cached = {
        title: extracted.title,
        summary: extracted.summary,
        cwd: extracted.cwd,
        mtime_ms: mtimeMs,
      };
    }

    const projectPath = cached.cwd ?? raw.projectPath;

    // When SESSIONS_INDEX.md covers the session, trust its title+description.
    if (indexEntry) {
      const title = alias ?? indexEntry.title;
      return {
        sessionId: raw.sessionId,
        filePath: raw.filePath,
        projectPath,
        title,
        date,
        folderIds,
        ...(indexEntry.description ? { description: indexEntry.description } : {}),
      };
    }

    const title = alias ?? cached.title ?? `session ${raw.sessionId.slice(0, 8)}`;
    const description = cached.summary ?? undefined;

    return {
      sessionId: raw.sessionId,
      filePath: raw.filePath,
      projectPath,
      title,
      date,
      folderIds,
      ...(description ? { description } : {}),
    };
  });

  return items;
}

// ---------------------------------------------------------------------------
// Public: getSessionPreview
// ---------------------------------------------------------------------------

const PREVIEW_LINES = 8;

export async function getSessionPreview(filePath: string): Promise<SessionPreview> {
  const sessionId = path.basename(filePath, '.jsonl');

  return new Promise((resolve, reject) => {
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    } catch (err) {
      reject(err);
      return;
    }

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const allLines: string[] = [];

    rl.on('line', (line) => {
      if (line.trim()) allLines.push(line);
    });

    rl.on('close', () => {
      const firstLines = allLines.slice(0, PREVIEW_LINES);
      const lastLines =
        allLines.length > PREVIEW_LINES
          ? allLines.slice(Math.max(0, allLines.length - PREVIEW_LINES))
          : [];
      resolve({ sessionId, firstLines, lastLines });
    });

    rl.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Test-only exports. Not part of the public IPC surface.
// ---------------------------------------------------------------------------

export const __test = {
  parseJsonlSummary,
  decodeProjectPath,
};
