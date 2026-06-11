/**
 * session-lineage.test.ts
 *
 * - resolveParents: overlap-based parent edges, exact overrides,
 *   mtime ordering (NTFS birthtime is a lie — tunneling).
 * - listSessionFamilies / resolveLiveSessionId over synthetic JSONLs.
 * - REAL sweep: the user's actual Wispr Flow family (root 110b89b0
 *   from 2026-05-28, incl. fc4a2f36 forked 2026-06-10) must be
 *   reconstructed if those files are present on this machine.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (_: string): string => path.join(os.tmpdir(), `claudedesk-lineage-${process.pid}`),
  },
}));

import { listSessionFamilies, resolveLiveSessionId, resolveParents } from './session-lineage.js';

const REAL_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const WISPR_FORK = 'fc4a2f36-010c-416c-8d4a-48c960441aad';
const WISPR_ROOT = '110b89b0-44e2-4fd6-a89f-b992f4b72811';
const HAS_WISPR =
  fs.existsSync(path.join(REAL_PROJECTS, 'C--Users-burmistrov', `${WISPR_FORK}.jsonl`)) &&
  fs.existsSync(path.join(REAL_PROJECTS, 'C--Users-burmistrov', `${WISPR_ROOT}.jsonl`));

// --- synthetic helpers ------------------------------------------------------

const sid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const mid = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

function writeJsonl(dir: string, sessionId: string, messageUuids: string[], mtime?: Date): string {
  const lines = messageUuids.map((u, i) =>
    JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      uuid: u,
      sessionId,
      message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${u}` },
    }),
  );
  const f = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n', 'utf-8');
  if (mtime) fs.utimesSync(f, mtime, mtime);
  return f;
}

const setOf = (...ns: number[]): Set<string> => new Set(ns.map(mid));

describe('resolveParents', () => {
  it('parent is the mtime-older member with the largest uuid overlap', () => {
    const A = { sessionId: 'A', uuids: setOf(1, 2), mtimeMs: 100 };
    const B = { sessionId: 'B', uuids: setOf(1, 2, 3), mtimeMs: 200 };
    const parents = resolveParents([A, B]);
    expect(parents.get('A')).toBeNull();
    expect(parents.get('B')).toBe('A');
  });

  it('fork-of-fork resolves to the MIDDLE session, not the root', () => {
    // A: 1 own message; B forked off A and added 2,3; C forked off B
    // and added 4. Overlap C∩B = {1,2,3} beats C∩A = {1}.
    const A = { sessionId: 'A', uuids: setOf(1), mtimeMs: 100 };
    const B = { sessionId: 'B', uuids: setOf(1, 2, 3), mtimeMs: 200 };
    const C = { sessionId: 'C', uuids: setOf(1, 2, 3, 4), mtimeMs: 300 };
    const parents = resolveParents([A, B, C]);
    expect(parents.get('B')).toBe('A');
    expect(parents.get('C')).toBe('B');
  });

  it('exact override wins over the overlap heuristic', () => {
    const A = { sessionId: 'A', uuids: setOf(1), mtimeMs: 100 };
    const B = { sessionId: 'B', uuids: setOf(1, 2, 3), mtimeMs: 200 };
    // by overlap C would resolve to B; the recorded branch says A
    const C = { sessionId: 'C', uuids: setOf(1, 2, 3, 4), mtimeMs: 300 };
    const parents = resolveParents([A, B, C], new Map([['C', 'A']]));
    expect(parents.get('C')).toBe('A');
  });

  it('override pointing outside the family is ignored', () => {
    const A = { sessionId: 'A', uuids: setOf(1), mtimeMs: 100 };
    const B = { sessionId: 'B', uuids: setOf(1, 2), mtimeMs: 200 };
    const parents = resolveParents([A, B], new Map([['B', 'ghost']]));
    expect(parents.get('B')).toBe('A');
  });
});

describe('listSessionFamilies / resolveLiveSessionId (synthetic)', () => {
  let root: string;
  let proj: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-lineage-'));
    proj = path.join(root, 'D--fake-project');
    fs.mkdirSync(proj, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('groups files sharing the first message uuid into one family', async () => {
    const old = new Date(Date.now() - 60_000);
    writeJsonl(proj, sid(1), [mid(1), mid(2)], old);
    writeJsonl(proj, sid(2), [mid(1), mid(2), mid(3)]);
    writeJsonl(proj, sid(3), [mid(9)]); // unrelated singleton
    const fams = await listSessionFamilies({ projectsDir: root });
    expect(fams).toHaveLength(1);
    expect(fams[0].members.map((m) => m.sessionId).sort()).toEqual([sid(1), sid(2)].sort());
    const child = fams[0].members.find((m) => m.sessionId === sid(2));
    expect(child?.parentSessionId).toBe(sid(1));
    const head = fams[0].members.find((m) => m.sessionId === sid(1));
    expect(head?.parentSessionId).toBeNull();
  });

  it('resolveLiveSessionId finds the continuation file containing the anchor uuid', async () => {
    const old = new Date(Date.now() - 120_000);
    writeJsonl(proj, sid(1), [mid(1), mid(2)], old);
    const since = Date.now() - 60_000;
    // continuation: copied history INCLUDING sid(1)'s last uuid mid(2)
    writeJsonl(proj, sid(2), [mid(1), mid(2), mid(3), mid(4)]);
    // unrelated newer file — must not be picked
    writeJsonl(proj, sid(3), [mid(50), mid(51)]);
    const res = await resolveLiveSessionId({
      sessionId: sid(1),
      sinceMs: since,
      waitMs: 0,
      projectsDir: root,
    });
    expect(res).toEqual({ sessionId: sid(2), changed: true });
  });

  it('returns the original unchanged when no descendant exists', async () => {
    writeJsonl(proj, sid(1), [mid(1), mid(2)]);
    const res = await resolveLiveSessionId({
      sessionId: sid(1),
      sinceMs: Date.now() - 60_000,
      waitMs: 0,
      projectsDir: root,
    });
    expect(res).toEqual({ sessionId: sid(1), changed: false });
  });

  it('ignores descendants modified BEFORE sinceMs (stale forks)', async () => {
    const old = new Date(Date.now() - 600_000);
    writeJsonl(proj, sid(1), [mid(1), mid(2)], old);
    writeJsonl(proj, sid(2), [mid(1), mid(2), mid(3)], old); // old fork
    const res = await resolveLiveSessionId({
      sessionId: sid(1),
      sinceMs: Date.now() - 60_000,
      waitMs: 0,
      projectsDir: root,
    });
    expect(res.changed).toBe(false);
  });
});

describe('meta cache', () => {
  let root: string;
  let proj: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-lineage-cache-'));
    proj = path.join(root, 'D--cache-project');
    fs.mkdirSync(proj, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('cache hit: unchanged files are NOT re-read on the second call', async () => {
    const old = new Date(Date.now() - 120_000);
    writeJsonl(proj, sid(10), [mid(10), mid(11)], old);
    writeJsonl(proj, sid(11), [mid(10), mid(11), mid(12)], old);
    // first call populates the cache
    await listSessionFamilies({ projectsDir: root });
    // spy AFTER first call so we only measure the second
    const spy = vi.spyOn(fs, 'createReadStream');
    await listSessionFamilies({ projectsDir: root });
    expect(spy.mock.calls.length).toBe(0);
  });

  it('invalidation: appending to a file causes it to be re-read', async () => {
    const old = new Date(Date.now() - 120_000);
    writeJsonl(proj, sid(20), [mid(20), mid(21)], old);
    writeJsonl(proj, sid(21), [mid(20), mid(21), mid(22)], old);
    // first call populates the cache
    await listSessionFamilies({ projectsDir: root });

    // mutate one file: append a new message uuid
    const changedFile = path.join(proj, `${sid(21)}.jsonl`);
    const newUuid = mid(99);
    fs.appendFileSync(
      changedFile,
      JSON.stringify({
        type: 'user',
        uuid: newUuid,
        sessionId: sid(21),
        message: { role: 'user', content: 'new' },
      }) + '\n',
      'utf-8',
    );
    // advance mtime to guarantee cache invalidation on coarse-grained clocks
    const newMtime = new Date(old.getTime() + 10_000);
    fs.utimesSync(changedFile, newMtime, newMtime);

    const fams = await listSessionFamilies({ projectsDir: root, includeSingletons: true });
    const member = fams.flatMap((f) => f.members).find((m) => m.sessionId === sid(21));
    // the re-read file now has one more message in its count
    expect(member).toBeDefined();
    if (member) expect(member.messageCount).toBe(4);
  });
});

describe.runIf(HAS_WISPR)('REAL: Wispr Flow family on this machine', () => {
  it(
    'reconstructs the family around fc4a2f36 with a sane shape',
    { timeout: 300_000 },
    async () => {
      const fams = await listSessionFamilies({ projectsDir: REAL_PROJECTS });
      const wispr = fams.find((f) => f.members.some((m) => m.sessionId === WISPR_FORK));
      expect(wispr, 'family containing fc4a2f36 not found').toBeDefined();
      if (!wispr) return;
      expect(wispr.members.length).toBeGreaterThanOrEqual(2);
      // exactly one root, and it is the May-28 origin session — NOT the
      // fork that NTFS tunneling stamps with a fake old birthtime
      const roots = wispr.members.filter((m) => m.parentSessionId === null);
      expect(roots).toHaveLength(1);
      expect(roots[0].sessionId).toBe(WISPR_ROOT);
      // every non-root parent is a member of the same family
      const ids = new Set(wispr.members.map((m) => m.sessionId));
      for (const m of wispr.members) {
        if (m.parentSessionId !== null) expect(ids.has(m.parentSessionId)).toBe(true);
      }
      // the fork made today is NOT the root
      const fork = wispr.members.find((m) => m.sessionId === WISPR_FORK);
      expect(fork?.parentSessionId).not.toBeNull();
    },
  );
});
