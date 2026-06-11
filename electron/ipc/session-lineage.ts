/**
 * session-lineage.ts
 *
 * Reconstructs the FAMILY TREE of claude sessions from the JSONL files
 * alone — claude records no explicit parentage, but:
 *
 *  - every resume/fork COPIES the conversation history into the new
 *    file and message `uuid`s survive the copy, so two files that share
 *    their FIRST message uuid belong to the same family (same root
 *    conversation);
 *  - parent edges come from message-uuid OVERLAP among mtime-older
 *    members (see resolveParents), with exact overrides for branches
 *    ClaudeDesk created itself.
 *
 * Dead ends verified empirically (2026-06-10), do not retry:
 *  - per-record `sessionId` is rewritten to the new file's id during
 *    the copy — useless for parentage;
 *  - `logicalParentUuid` lives on type=system COMPACTION markers spread
 *    through the file (copied along with history) — it is NOT a fork
 *    header;
 *  - NTFS creation time suffers tunneling (a file written today can
 *    report a birth date weeks back);
 *  - record timestamps are copied verbatim, so the first timestamp of a
 *    fork is the ROOT's date, not the fork's.
 *
 * This module also fixes the «branch forks from the FIRST session» bug:
 * a chat tile records its sessionId once at open time, but claude mints
 * a NEW session file on every resume. resolveLiveSessionId() finds the
 * newest descendant of the tile's original session so Branch forks from
 * what the user actually sees, not from a stale snapshot.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getClaudeProjectsDir } from '../paths.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionLineageNode {
  sessionId: string;
  filePath: string;
  projectDir: string;
  /** uuid of the first message — family key */
  rootUuid: string;
  /** parent session in the family tree; null for roots */
  parentSessionId: string | null;
  /** message count (uuid-bearing records, capped) — node size hint */
  messageCount: number;
  mtimeMs: number;
}

export interface SessionFamily {
  rootUuid: string;
  /** members sorted by last activity (oldest first — root leads) */
  members: SessionLineageNode[];
}

interface FileMeta {
  sessionId: string;
  filePath: string;
  projectDir: string;
  rootUuid: string | null;
  /** message uuids (capped) — used for containment / overlap checks */
  uuids: Set<string>;
  mtimeMs: number;
}

/** Hard cap keeps tree building cheap even with huge sessions. */
const MAX_UUIDS_PER_FILE = 20_000;

async function readFileMeta(filePath: string): Promise<FileMeta | null> {
  const base = path.basename(filePath).replace(/\.jsonl$/i, '');
  if (!UUID_RE.test(base)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  const meta: FileMeta = {
    sessionId: base,
    filePath,
    projectDir: path.dirname(filePath),
    rootUuid: null,
    uuids: new Set(),
    mtimeMs: st.mtimeMs,
  };

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (raw) => {
      if (!raw.trim()) return;
      if (meta.uuids.size >= MAX_UUIDS_PER_FILE) {
        rl.close();
        return;
      }
      let r: { uuid?: unknown };
      try {
        r = JSON.parse(raw) as typeof r;
      } catch {
        return;
      }
      if (typeof r.uuid === 'string' && r.uuid) {
        if (!meta.rootUuid) meta.rootUuid = r.uuid;
        meta.uuids.add(r.uuid);
      }
    });
    rl.on('close', resolve);
    rl.on('error', () => resolve());
  });

  return meta.rootUuid ? meta : null;
}

function listJsonlFiles(root: string): string[] {
  const out: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const full = path.join(root, d);
    let entries: string[] = [];
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      entries = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) out.push(path.join(full, name));
    }
  }
  return out;
}

/**
 * Resolve each member's parent inside one family. Exported for tests.
 *
 * Ordering note: NTFS creation time is a lie (tunneling), and record
 * timestamps are copied verbatim into forks — the only trustworthy
 * per-file clock is mtime (= last activity). Members are ordered by
 * mtime; the parent of S is picked among mtime-OLDER members:
 *   1) exact overrides (ClaudeDesk-recorded branches), when provided;
 *   2) the member with the largest message-uuid overlap — history is
 *      copied from the parent, so the true parent's uuids sit inside
 *      the child's set, and a deeper ancestor overlaps LESS than the
 *      direct parent.
 * Heuristic by design: if the user returns to an ancestor AFTER
 * branching, its mtime moves past the child's and the edge may
 * misresolve. Branches created through ClaudeDesk are recorded exactly
 * (overrides) and never misresolve.
 */
export function resolveParents(
  members: Array<Pick<FileMeta, 'sessionId' | 'uuids' | 'mtimeMs'>>,
  overrides?: ReadonlyMap<string, string>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const sorted = [...members].sort(
    (a, b) => a.mtimeMs - b.mtimeMs || a.sessionId.localeCompare(b.sessionId),
  );
  const ids = new Set(sorted.map((m) => m.sessionId));
  for (let i = 0; i < sorted.length; i += 1) {
    const m = sorted[i];
    const exact = overrides?.get(m.sessionId);
    if (exact && ids.has(exact) && exact !== m.sessionId) {
      out.set(m.sessionId, exact);
      continue;
    }
    const older = sorted.slice(0, i);
    if (older.length === 0) {
      out.set(m.sessionId, null);
      continue;
    }
    let best: (typeof older)[number] | null = null;
    let bestScore = -1;
    for (const o of older) {
      let score = 0;
      for (const u of o.uuids) if (m.uuids.has(u)) score += 1;
      // ties → the most recently active older member (closest ancestor)
      if (score > bestScore || (score === bestScore && best && o.mtimeMs > best.mtimeMs)) {
        bestScore = score;
        best = o;
      }
    }
    out.set(m.sessionId, best ? best.sessionId : null);
  }
  return out;
}

/**
 * Build all session families across every project dir.
 * Returns only families (and singletons) — singletons included so the
 * Tree view can show standalone sessions too if it wants.
 */
export async function listSessionFamilies(opts?: {
  projectsDir?: string;
  /** include families with a single member (default false) */
  includeSingletons?: boolean;
  /** exact child→parent edges recorded by ClaudeDesk at branch time */
  overrides?: ReadonlyMap<string, string>;
}): Promise<SessionFamily[]> {
  const root = opts?.projectsDir ?? getClaudeProjectsDir();
  const files = listJsonlFiles(root);
  const metas: FileMeta[] = [];
  for (const f of files) {
    const m = await readFileMeta(f);
    if (m) metas.push(m);
  }
  const byRoot = new Map<string, FileMeta[]>();
  for (const m of metas) {
    const key = m.rootUuid as string;
    const arr = byRoot.get(key);
    if (arr) arr.push(m);
    else byRoot.set(key, [m]);
  }
  const families: SessionFamily[] = [];
  for (const [rootUuid, members] of byRoot) {
    if (members.length < 2 && !opts?.includeSingletons) continue;
    const parents = resolveParents(members, opts?.overrides);
    const nodes: SessionLineageNode[] = members
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .map((m) => ({
        sessionId: m.sessionId,
        filePath: m.filePath,
        projectDir: m.projectDir,
        rootUuid,
        parentSessionId: parents.get(m.sessionId) ?? null,
        messageCount: m.uuids.size,
        mtimeMs: m.mtimeMs,
      }));
    families.push({ rootUuid, members: nodes });
  }
  // biggest / freshest families first
  families.sort(
    (a, b) =>
      Math.max(...b.members.map((m) => m.mtimeMs)) - Math.max(...a.members.map((m) => m.mtimeMs)),
  );
  return families;
}

function findSessionFileIn(root: string, sessionId: string): string | null {
  for (const f of listJsonlFiles(root)) {
    if (path.basename(f) === `${sessionId}.jsonl`) return f;
  }
  return null;
}

/** Last message uuid of a file — cheap tail probe via full read of the
 *  last N KB (sessions are append-only). */
function lastUuidOf(filePath: string): string | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(filePath).size;
    const window = Math.min(size, 256 * 1024);
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(window);
    fs.readSync(fd, buf, 0, window, size - window);
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const raw = lines[i].trim();
      if (!raw) continue;
      try {
        const r = JSON.parse(raw) as { uuid?: unknown };
        if (typeof r.uuid === 'string' && r.uuid) return r.uuid;
      } catch {
        continue; // first line of the window may be cut in half
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Does the file contain the given uuid as a message uuid? Substring
 *  pre-filter, then exact JSON check on matching lines. */
async function fileContainsUuid(filePath: string, uuid: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let found = false;
    rl.on('line', (raw) => {
      if (found || !raw.includes(uuid)) return;
      try {
        const r = JSON.parse(raw) as { uuid?: unknown };
        if (r.uuid === uuid) {
          found = true;
          rl.close();
        }
      } catch {
        /* ignore */
      }
    });
    rl.on('close', () => resolve(found));
    rl.on('error', () => resolve(false));
  });
}

/**
 * Find the LIVE session id for a chat tile that was opened with
 * `--resume <sessionId>`: the newest sibling JSONL born after `sinceMs`
 * that contains the original session's last message uuid (i.e. claude's
 * continuation of that very conversation).
 *
 * waitMs > 0 polls every 2s until found or timeout — used right after
 * spawning the PTY, when claude may not have minted the file yet.
 * waitMs = 0 is a single scan — used as a last-moment check at branch
 * time.
 */
export async function resolveLiveSessionId(opts: {
  sessionId: string;
  sinceMs: number;
  waitMs?: number;
  projectsDir?: string;
}): Promise<{ sessionId: string; changed: boolean }> {
  const root = opts.projectsDir ?? getClaudeProjectsDir();
  const original = findSessionFileIn(root, opts.sessionId);
  if (!original) return { sessionId: opts.sessionId, changed: false };
  const anchor = lastUuidOf(original);
  if (!anchor) return { sessionId: opts.sessionId, changed: false };
  const dir = path.dirname(original);

  const deadline = Date.now() + Math.max(0, opts.waitMs ?? 0);
  // Candidates already vetted (sessionId -> contains anchor?) so polls
  // don't re-read the same files.
  const vetted = new Map<string, boolean>();

  for (;;) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return { sessionId: opts.sessionId, changed: false };
    }
    // mtime, NOT birthtime: NTFS tunneling can stamp a freshly-created
    // file with a weeks-old creation time. A live continuation is being
    // WRITTEN right now, so its mtime is necessarily >= sinceMs.
    const candidates: Array<{ id: string; f: string; mtime: number }> = [];
    for (const name of names) {
      const id = name.replace(/\.jsonl$/i, '');
      if (id === opts.sessionId || !UUID_RE.test(id)) continue;
      const f = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (st.mtimeMs < opts.sinceMs) continue;
      candidates.push({ id, f, mtime: st.mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      let ok = vetted.get(c.id);
      if (ok === undefined) {
        ok = await fileContainsUuid(c.f, anchor);
        // Unvetted files may still be mid-write — only cache negative
        // results briefly by NOT caching them at all while polling.
        if (ok || (opts.waitMs ?? 0) === 0) vetted.set(c.id, ok);
      }
      if (ok) return { sessionId: c.id, changed: true };
    }
    if (Date.now() >= deadline) return { sessionId: opts.sessionId, changed: false };
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
