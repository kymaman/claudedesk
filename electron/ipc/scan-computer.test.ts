/**
 * scan-computer.test.ts — the onboarding whole-PC scanner.
 *
 * Builds a real temp directory tree with a couple of claude "projects roots"
 * buried at different depths (plus decoys and a skip-dir) and asserts the walk
 * finds exactly the roots, respects depth / skip / deadline bounds, and never
 * descends into a found root.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanForClaudeProjectRoots, SESSION_FILE_RE } from './scan-computer.js';

const UUID = '0123abcd-4567-89ab-cdef-0123456789ab';
let tmp: string;

function mkProjectsRoot(at: string) {
  // <at>/<encoded-project>/<uuid>.jsonl — the shape scanFolder expects.
  const proj = path.join(at, 'D--some-project');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${UUID}.jsonl`), '{"type":"user"}\n');
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  // Root A: <tmp>/home/.claude/projects (canonical, depth 3)
  mkProjectsRoot(path.join(tmp, 'home', '.claude', 'projects'));
  // Root B: <tmp>/drive/backup/.claude/projects (deeper)
  mkProjectsRoot(path.join(tmp, 'drive', 'backup', '.claude', 'projects'));
  // Decoy: a .jsonl that is NOT a session-uuid name → must be ignored.
  const decoy = path.join(tmp, 'decoy', 'notes');
  fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(decoy, 'random.jsonl'), 'x\n');
  // Skip dir: a projects root hidden inside node_modules → must be skipped.
  mkProjectsRoot(path.join(tmp, 'node_modules', 'pkg', '.claude', 'projects'));
});

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('SESSION_FILE_RE', () => {
  it('matches a uuid .jsonl and rejects others', () => {
    expect(SESSION_FILE_RE.test(`${UUID}.jsonl`)).toBe(true);
    expect(SESSION_FILE_RE.test('random.jsonl')).toBe(false);
    expect(SESSION_FILE_RE.test(`${UUID}.txt`)).toBe(false);
  });
});

describe('scanForClaudeProjectRoots', () => {
  it('finds projects roots at varying depths, ignores decoys and skip-dirs', () => {
    const { roots, hitLimit } = scanForClaudeProjectRoots([tmp]);
    expect(hitLimit).toBe(false);
    const norm = roots.map((r) => r.replace(/\\/g, '/'));
    expect(norm.some((r) => r.endsWith('/home/.claude/projects'))).toBe(true);
    expect(norm.some((r) => r.endsWith('/drive/backup/.claude/projects'))).toBe(true);
    // decoy (non-uuid jsonl) is not a root:
    expect(norm.some((r) => r.includes('/decoy'))).toBe(false);
    // node_modules is skipped:
    expect(norm.some((r) => r.includes('node_modules'))).toBe(false);
  });

  it('does NOT descend into a found root (its children are project dirs)', () => {
    // The project dir under a root contains the .jsonl but is itself NOT a
    // projects root, so it must never be reported.
    const { roots } = scanForClaudeProjectRoots([tmp]);
    const norm = roots.map((r) => r.replace(/\\/g, '/'));
    expect(norm.some((r) => r.endsWith('/D--some-project'))).toBe(false);
  });

  it('respects maxDepth (too shallow finds nothing)', () => {
    // Roots sit at depth ≥3 below tmp; depth 1 can't reach them.
    const { roots } = scanForClaudeProjectRoots([tmp], { maxDepth: 1 });
    expect(roots).toEqual([]);
  });

  it('respects the deadline (a zero budget stops immediately)', () => {
    let t = 0;
    const { hitLimit } = scanForClaudeProjectRoots([tmp], {
      deadlineMs: 5,
      now: () => (t += 10), // every clock read advances 10ms → over budget at once
    });
    expect(hitLimit).toBe(true);
  });

  it('swallows unreadable start dirs without throwing', () => {
    const { roots } = scanForClaudeProjectRoots([path.join(tmp, 'does-not-exist')]);
    expect(roots).toEqual([]);
  });
});
