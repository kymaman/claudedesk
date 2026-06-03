/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code */
/**
 * Unit: chat restore preserves grid order AND pre-minted sessionId.
 *
 * Bugs covered:
 *  - #34 plitki after app open were in the wrong places — restoreOpenChats
 *    sorted by lastActiveAt, scrambling user's tile layout.
 *  - #36 some chats opened as a fresh terminal after restart even though
 *    a conversation existed — openFreshChat never minted a session UUID,
 *    so on restart the persisted snapshot had no sessionId and we re-spawned
 *    a blank claude process instead of resuming.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        id: 'claude-opus-4-8',
        name: 'Claude Code (Opus 4.8)',
        command: 'claude',
        args: ['--model', 'claude-opus-4-8'],
        skip_permissions_args: ['--dangerously-skip-permissions'],
        available: true,
      },
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

describe('openFreshChat — no pre-mint sessionId (broke scrollback)', () => {
  // The earlier #36 fix pre-minted a UUID and passed it to claude as
  // `--session-id <uuid>`. Users reported terminal scrollback became
  // unreachable; removing the flag fixed it. Fresh chats now start
  // without a sessionId. Restore-time recovery for fresh-without-
  // messages chats is intentionally given up (no JSONL to resume).
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('fresh chat carries NO sessionId and NO --session-id flag', async () => {
    const m = await importChats();
    const chat = m.openFreshChat({ cwd: '/tmp/proj', title: 'fresh-A' });
    expect(chat).not.toBeNull();
    expect(chat!.sessionId).toBeUndefined();
    expect(chat!.args).not.toContain('--session-id');
  });

  it('non-claude agents (codex) also have no sessionId — unchanged', async () => {
    const m = await importChats();
    const chat = m.openFreshChat({ cwd: '/x', agentId: 'codex', title: 't' });
    expect(chat!.sessionId).toBeUndefined();
    expect(chat!.args).not.toContain('--session-id');
  });

  it('persisted snapshot of a fresh chat has no sessionId; restore is via openFreshChat', async () => {
    let m = await importChats();
    const first = m.openFreshChat({ cwd: '/tmp/p', title: 'fresh' });
    expect(first!.sessionId).toBeUndefined();
    m.flushPersistOpenChatsForTest();

    m = await importChats();
    m.restoreOpenChats();
    expect(m.openChats().length).toBe(1);
    const restored = m.openChats()[0]!;
    expect(restored.sessionId).toBeUndefined();
    // No --resume; the restored chat is a fresh claude.
    expect(restored.args).not.toContain('--resume');
  });
});

describe('restoreOpenChats — bug #34 grid order preserved', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('tiles come back in the exact same grid order as before the restart', async () => {
    let m = await importChats();
    // Open three chats. Order in openChats() === A, B, C.
    const a = m.openFreshChat({ cwd: '/a', title: 'A-first' })!;
    const b = m.openFreshChat({ cwd: '/b', title: 'B-second' })!;
    const c = m.openFreshChat({ cwd: '/c', title: 'C-third' })!;
    // Activate them in a SCRAMBLED order. Before the fix, persist would
    // sort by lastActiveAt → restore would yield C, A, B (or similar).
    m.setActiveChatId(c.id);
    m.setActiveChatId(a.id);
    m.setActiveChatId(b.id);
    m.flushPersistOpenChatsForTest();

    m = await importChats();
    m.restoreOpenChats();
    const titles = m.openChats().map((x) => x.title);
    expect(titles).toEqual(['A-first', 'B-second', 'C-third']);
  });

  it('most-recently-used chat becomes active after restore (independent of grid order)', async () => {
    let m = await importChats();
    const a = m.openFreshChat({ cwd: '/a', title: 'A' })!;
    const b = m.openFreshChat({ cwd: '/b', title: 'B' })!;
    m.openFreshChat({ cwd: '/c', title: 'C' });
    // User clicked A last → A should be active after restore even though
    // its grid index is 0.
    m.setActiveChatId(b.id);
    m.setActiveChatId(a.id);
    m.flushPersistOpenChatsForTest();

    m = await importChats();
    m.restoreOpenChats();
    const active = m.openChats().find((x) => x.id === m.activeChatId());
    expect(active?.title).toBe('A');
  });

  it('legacy snapshot (no gridIndex) falls back to lastActiveAt order', async () => {
    // Hand-craft a pre-#34 snapshot — no gridIndex on entries. Restore must
    // not throw and must order by lastActiveAt-ascending as before.
    const legacy = [
      {
        id: 'one',
        title: 'oldest',
        cwd: '/',
        agentDefId: 'claude-opus-4-8',
        extraFlags: [],
        skipPermissions: false,
        lastActiveAt: 100,
        createdAt: 100,
      },
      {
        id: 'two',
        title: 'mid',
        cwd: '/',
        agentDefId: 'claude-opus-4-8',
        extraFlags: [],
        skipPermissions: false,
        lastActiveAt: 200,
        createdAt: 100,
      },
      {
        id: 'three',
        title: 'newest',
        cwd: '/',
        agentDefId: 'claude-opus-4-8',
        extraFlags: [],
        skipPermissions: false,
        lastActiveAt: 300,
        createdAt: 100,
      },
    ];
    localStorage.setItem('claudedesk.openChats', JSON.stringify(legacy));
    const m = await importChats();
    m.restoreOpenChats();
    expect(m.openChats().map((c) => c.title)).toEqual(['oldest', 'mid', 'newest']);
  });
});
