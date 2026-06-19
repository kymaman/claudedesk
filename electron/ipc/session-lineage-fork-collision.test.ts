/**
 * session-lineage-fork-collision.test.ts
 *
 * Reproduces the user's "I branched a dialog and now the SAME
 * conversation runs in both tiles" bug (reported 2026-06-15).
 *
 * Why it happens:
 *   Branching spawns a sibling tile with `--resume <S0> --fork-session`.
 *   Both tiles START life carrying sessionId = S0, and BOTH run
 *   watchLiveSession() → resolveLiveSessionId({ sessionId: S0 }).
 *
 *   claude copies the parent's whole history into every continuation /
 *   fork file, so the parent's last-message uuid (the "anchor") appears
 *   in BOTH the parent's own continuation AND the fork's file. The old
 *   resolveLiveSessionId just returns the NEWEST sibling containing the
 *   anchor — which is the same file for every caller. So the two tiles
 *   adopt the SAME live session id and glue together: typing in one
 *   shows up as the other's conversation.
 *
 * The fix: resolveLiveSessionId accepts `excludeSessionIds` so a tile can
 * skip continuations already claimed by its siblings, letting each tile
 * land on its OWN distinct live session.
 *
 * These tests are written to be RED against the pre-fix function (no
 * excludeSessionIds support) and GREEN after.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (_: string): string =>
      path.join(os.tmpdir(), `claudedesk-fork-collision-${process.pid}`),
  },
}));

import { resolveLiveSessionId } from './session-lineage.js';

const sid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const mid = (n: number): string => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

describe('resolveLiveSessionId — fork collision (branch creates a NEW independent dialog)', () => {
  let root: string;
  let proj: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-fork-'));
    proj = path.join(root, 'D--fork-project');
    fs.mkdirSync(proj, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * The exact disk shape after branching session S0:
   *   sid(0): parent, last message uuid = mid(2)        (old)
   *   sid(1): parent's own continuation — copies mid(2) (fresh)
   *   sid(2): the FORK — also copies mid(2)             (fresh, newest)
   * Both continuations qualify; they must be handed to DIFFERENT tiles.
   */
  function layoutBranchedFamily(): { parent: string; contA: string; contB: string } {
    const old = new Date(Date.now() - 120_000);
    writeJsonl(proj, sid(0), [mid(1), mid(2)], old);
    // contA slightly older than contB so "newest" is deterministic.
    writeJsonl(proj, sid(1), [mid(1), mid(2), mid(10)], new Date(Date.now() - 10_000));
    writeJsonl(proj, sid(2), [mid(1), mid(2), mid(20)], new Date(Date.now() - 2_000));
    return { parent: sid(0), contA: sid(1), contB: sid(2) };
  }

  it('first tile claims the newest continuation of the forked parent', async () => {
    const { parent, contB } = layoutBranchedFamily();
    const res = await resolveLiveSessionId({
      sessionId: parent,
      sinceMs: Date.now() - 60_000,
      waitMs: 0,
      projectsDir: root,
    });
    expect(res).toEqual({ sessionId: contB, changed: true });
  });

  it('second tile must NOT re-claim the id its sibling already took (excludeSessionIds)', async () => {
    const { parent, contA, contB } = layoutBranchedFamily();
    // Tile A already adopted contB. Tile B asks again, telling the
    // resolver contB is taken — it must hand back the OTHER continuation,
    // never the same one (that glue is the bug).
    const res = await resolveLiveSessionId({
      sessionId: parent,
      sinceMs: Date.now() - 60_000,
      waitMs: 0,
      projectsDir: root,
      excludeSessionIds: [contB],
    });
    expect(res.changed).toBe(true);
    expect(res.sessionId).toBe(contA);
    expect(res.sessionId).not.toBe(contB);
  });

  it('two tiles forking the same parent end up on DISTINCT live sessions', async () => {
    const { parent } = layoutBranchedFamily();
    // Tile A resolves first, with nothing excluded.
    const a = await resolveLiveSessionId({
      sessionId: parent,
      sinceMs: Date.now() - 60_000,
      waitMs: 0,
      projectsDir: root,
    });
    // Tile B resolves next, excluding whatever A took.
    const b = await resolveLiveSessionId({
      sessionId: parent,
      sinceMs: Date.now() - 60_000,
      waitMs: 0,
      projectsDir: root,
      excludeSessionIds: [a.sessionId],
    });
    expect(a.changed).toBe(true);
    expect(b.changed).toBe(true);
    // The whole point of a branch: two SEPARATE conversations.
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('excludeSessionIds with no remaining candidate returns the original unchanged', async () => {
    const { parent, contA, contB } = layoutBranchedFamily();
    // Both continuations already taken by other tiles → nothing left to
    // claim; the tile keeps its current id rather than gluing onto a peer.
    const res = await resolveLiveSessionId({
      sessionId: parent,
      sinceMs: Date.now() - 60_000,
      waitMs: 0,
      projectsDir: root,
      excludeSessionIds: [contA, contB],
    });
    expect(res).toEqual({ sessionId: parent, changed: false });
  });
});
