/**
 * scan-computer.ts — onboarding "scan the whole computer for dialogs".
 *
 * claude normally stores every session under ~/.claude/projects, which the app
 * already reads. But sessions can live elsewhere: a second drive, a synced
 * folder from another machine, a copied/backed-up `.claude` tree, or a
 * non-default CLAUDE config dir. This bounded filesystem walk finds every
 * directory that LOOKS like a claude "projects root" — i.e. the equivalent of
 * ~/.claude/projects — so onboarding can offer to add them as extra scan
 * folders (which `listSessions(extraFolders)` already consumes).
 *
 * A "projects root" is detected structurally (not by name): a directory that
 * directly contains at least one subdirectory holding at least one UUID-named
 * `*.jsonl` session file. That is exactly the shape `scanFolder()` expects.
 *
 * The walk is hard-bounded (depth, dirs-visited, wall-clock) and skips heavy /
 * system trees so it can't run away on a full disk. Permission errors are
 * swallowed. fs + clock are injectable so it unit-tests against a temp tree.
 */
import fsDefault from 'fs';
import os from 'os';
import path from 'path';

/** A claude session file: <uuid>.jsonl. */
export const SESSION_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** Directory names we never descend into (system, caches, VCS, deps). */
export const DEFAULT_SKIP_DIRS = new Set<string>([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.cache',
  'Cache',
  'Caches',
  '$Recycle.Bin',
  '$RECYCLE.BIN',
  'System Volume Information',
  'Windows',
  'WinSxS',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'tmp',
  'temp',
  'Temp',
  // big media/cloud caches that never hold claude sessions
  'OneDriveTemp',
]);

/** Minimal fs surface — lets tests inject an in-memory or temp tree. */
export interface ScanFs {
  readdirSync: (
    p: string,
    opts: { withFileTypes: true },
  ) => Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
  }>;
}

export interface ScanOptions {
  /** Max directory depth below each start dir (start dir = depth 0). */
  maxDepth?: number;
  /** Hard cap on directories visited (runaway guard). */
  maxDirs?: number;
  /** Wall-clock budget in ms. */
  deadlineMs?: number;
  /** Directory names to skip (defaults to DEFAULT_SKIP_DIRS). */
  skipDirNames?: Set<string>;
  /** Injected fs (defaults to node:fs). */
  fs?: ScanFs;
  /** Injected clock (defaults to Date.now), for deterministic tests. */
  now?: () => number;
}

export interface ScanResult {
  /** Directories that look like a claude projects root (add as extra folders). */
  roots: string[];
  /** How many directories the walk inspected. */
  dirsVisited: number;
  /** True if a bound (depth/dirs/deadline) stopped the walk early. */
  hitLimit: boolean;
}

/**
 * Does `dirPath` directly contain ≥1 subdirectory that holds ≥1 UUID `.jsonl`?
 * If so it is a claude projects root. Returns false on any read error.
 */
function looksLikeProjectsRoot(dirPath: string, fs: ScanFs): boolean {
  let entries: ReturnType<ScanFs['readdirSync']>;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = path.join(dirPath, entry.name);
    let childEntries: ReturnType<ScanFs['readdirSync']>;
    try {
      childEntries = fs.readdirSync(childPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of childEntries) {
      if (f.isFile() && SESSION_FILE_RE.test(f.name)) return true;
    }
  }
  return false;
}

/**
 * Walk `startDirs` (e.g. drive roots / home) and return every claude projects
 * root found, bounded by depth / dirs-visited / wall-clock. Once a directory is
 * identified as a projects root we record it and do NOT descend further (its
 * children are project dirs, already covered by the consumer's scanFolder).
 */
export function scanForClaudeProjectRoots(startDirs: string[], opts: ScanOptions = {}): ScanResult {
  const maxDepth = opts.maxDepth ?? 8;
  const maxDirs = opts.maxDirs ?? 200_000;
  const deadlineMs = opts.deadlineMs ?? 20_000;
  const skip = opts.skipDirNames ?? DEFAULT_SKIP_DIRS;
  const fs = opts.fs ?? (fsDefault as unknown as ScanFs);
  const now = opts.now ?? Date.now;

  const start = now();
  const roots: string[] = [];
  const seenRoots = new Set<string>();
  const visited = new Set<string>();
  let dirsVisited = 0;
  let hitLimit = false;

  // BFS queue of [dir, depth].
  const queue: Array<[string, number]> = [];
  for (const d of startDirs) queue.push([d, 0]);

  while (queue.length > 0) {
    if (dirsVisited >= maxDirs || now() - start >= deadlineMs) {
      hitLimit = true;
      break;
    }
    const item = queue.shift();
    if (!item) break; // queue.length>0 guards this, but keeps TS/lint happy
    const [dir, depth] = item;
    if (visited.has(dir)) continue;
    visited.add(dir);
    dirsVisited += 1;

    // Is this a projects root? If so, record and don't descend.
    if (looksLikeProjectsRoot(dir, fs)) {
      if (!seenRoots.has(dir)) {
        seenRoots.add(dir);
        roots.push(dir);
      }
      continue;
    }

    if (depth >= maxDepth) continue;

    let entries: ReturnType<ScanFs['readdirSync']>;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied / not a dir — skip
    }
    for (const entry of entries) {
      // Never follow symlinks (avoids cycles and escaping the tree).
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (skip.has(entry.name)) continue;
      queue.push([path.join(dir, entry.name), depth + 1]);
    }
  }

  return { roots, dirsVisited, hitLimit };
}

/**
 * Sensible roots for a "scan the whole computer" run. On Windows that's every
 * existing fixed drive (C:..Z:); elsewhere the user's home (scanning '/' is
 * too slow and never holds claude sessions outside home in practice). Home is
 * always included so a non-default config dir under it is reachable.
 */
export function defaultScanStartDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const roots: string[] = [];
    for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      try {
        if (fsDefault.existsSync(root)) roots.push(root);
      } catch {
        /* ignore unreadable drive */
      }
    }
    if (home && !roots.some((r) => home.toUpperCase().startsWith(r.toUpperCase()))) {
      roots.push(home);
    }
    return roots.length > 0 ? roots : [home];
  }
  return [home];
}
