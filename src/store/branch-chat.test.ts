/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code asserts on
   freshly-constructed chats whose existence is verified inline. */
/**
 * Unit: branchChat / branchChatFromSession behavior.
 *
 * Pins three guarantees the UI relies on:
 *   1. branchChat refuses when source has no sessionId (nothing to fork)
 *   2. branchChat clones an open chat: new id, same sessionId, args
 *      include `--resume <sid>` then `--fork-session`, title gets the
 *      " • branch" suffix, and the new tile is inserted right after
 *      the source (not appended to the end).
 *   3. branchChatFromSession bypasses the openChatFromSession dedup —
 *      calling it for an already-open session still produces a SECOND
 *      tile (the whole point of branching).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionItem } from './sessions-history';

// In-memory localStorage polyfill — vitest runs in Node.
{
  const s = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => s.get(k) ?? null,
      setItem: (k: string, v: string) => void s.set(k, String(v)),
      removeItem: (k: string) => void s.delete(k),
      clear: () => void s.clear(),
      key: (i: number) => Array.from(s.keys())[i] ?? null,
      get length() {
        return s.size;
      },
    },
  });
}

vi.mock('./core', () => ({
  store: {
    availableAgents: [
      {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        command: 'claude',
        args: [],
        skip_permissions_args: ['--dangerously-skip-permissions'],
        available: true,
      },
      // Non-claude agent so we can still exercise the "no sessionId" guard
      // after #36 — fresh claude chats now always have a pre-minted UUID.
      {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        skip_permissions_args: ['--full-auto'],
        available: true,
      },
    ],
  },
}));

async function importChats() {
  vi.resetModules();
  return await import('./chats');
}

const SESSION: SessionItem = {
  sessionId: 'sess-branch-0001',
  filePath: '/var/sessions/sess-branch-0001.jsonl',
  projectPath: '/tmp/proj',
  title: 'Source chat',
  date: '2026-05-26',
  folderIds: [],
};

describe('branchChat', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('refuses to branch when source chat has no sessionId', async () => {
    const m = await importChats();
    // Use codex — non-claude agents intentionally skip the session UUID
    // mint (#36), so the "no sessionId" branch is still reachable.
    const fresh = m.openFreshChat({
      cwd: '/tmp/proj',
      title: 'No-session chat',
      agentId: 'codex',
    });
    expect(fresh).not.toBeNull();
    expect(fresh!.sessionId).toBeUndefined();
    const out = m.branchChat(fresh!.id);
    expect(out).toBeNull();
    // No tile was added.
    expect(m.openChats().length).toBe(1);
  });

  it('clones an open chat with --fork-session, inserts after the source', async () => {
    const m = await importChats();
    // Open something else first so we can prove the branch goes RIGHT
    // AFTER the source, not at the end.
    m.openFreshChat({ cwd: '/tmp/other', title: 'Other' });
    const src = m.openChatFromSession(SESSION, {
      agentId: 'claude-opus-4-7',
      extraFlags: ['--model=opus'],
      skipPermissions: true,
    });
    expect(src).not.toBeNull();
    // Append a trailing chat so the branch isn't accidentally last-by-default.
    m.openFreshChat({ cwd: '/tmp/trailing', title: 'Trailing' });

    const before = m.openChats().length;
    const branched = m.branchChat(src!.id);
    expect(branched).not.toBeNull();

    // Distinct chat (new tile, new id) but same sessionId.
    expect(branched!.id).not.toBe(src!.id);
    expect(branched!.sessionId).toBe(SESSION.sessionId);
    expect(branched!.cwd).toBe(src!.cwd);
    expect(branched!.projectId).toBe(src!.projectId);

    // Title carries the " • branch" suffix.
    expect(branched!.title).toBe(`${SESSION.title} • branch`);

    // args: --resume <sid> first, then --fork-session, then skip-perms, then extras.
    expect(branched!.args).toEqual([
      '--resume',
      SESSION.sessionId,
      '--fork-session',
      '--dangerously-skip-permissions',
      '--model=opus',
    ]);

    // Inserted directly after the source.
    const list = m.openChats();
    expect(list.length).toBe(before + 1);
    const srcIdx = list.findIndex((c) => c.id === src!.id);
    expect(list[srcIdx + 1]!.id).toBe(branched!.id);

    // Becomes active.
    expect(m.activeChatId()).toBe(branched!.id);
  });

  it('branchChat picks up the latest renamed title, not the stale chat.title', async () => {
    const m = await importChats();
    const src = m.openChatFromSession(SESSION, {
      agentId: 'claude-opus-4-7',
      extraFlags: [],
      skipPermissions: false,
    });
    m.renameChat(src!.id, 'Renamed source');
    const branched = m.branchChat(src!.id);
    expect(branched!.title).toBe('Renamed source • branch');
  });
});

describe('branchChatFromSession', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('produces a SECOND tile for a session that is already open (bypasses dedup)', async () => {
    const m = await importChats();
    const first = m.openChatFromSession(SESSION, {
      agentId: 'claude-opus-4-7',
      extraFlags: [],
      skipPermissions: false,
    });
    // Calling openChatFromSession again would focus the existing tile —
    // that's what dedup is for. branchChatFromSession must explicitly
    // create another.
    const branched = m.branchChatFromSession(SESSION, {
      agentId: 'claude-opus-4-7',
      extraFlags: [],
      skipPermissions: false,
    });
    expect(branched).not.toBeNull();
    expect(branched!.id).not.toBe(first!.id);
    expect(m.openChats().length).toBe(2);
    expect(branched!.args).toContain('--fork-session');
  });
});
