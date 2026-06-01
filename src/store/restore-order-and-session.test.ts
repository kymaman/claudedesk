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

describe('openFreshChat — bug #36 pre-mint sessionId', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('fresh chat has a UUID sessionId and --session-id flag in args', async () => {
    const m = await importChats();
    const chat = m.openFreshChat({ cwd: '/tmp/proj', title: 'fresh-A' });
    expect(chat).not.toBeNull();
    expect(chat!.sessionId, 'fresh chats must carry a pre-minted sessionId').toBeTruthy();
    expect(chat!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // The CLI flag must reference the SAME UUID we stored on the chat.
    const idx = chat!.args.indexOf('--session-id');
    expect(idx, 'args must contain --session-id').toBeGreaterThanOrEqual(0);
    expect(chat!.args[idx + 1]).toBe(chat!.sessionId);
  });

  it('non-claude agents do NOT get a session UUID (codex/gemini/copilot)', async () => {
    const m = await importChats();
    const chat = m.openFreshChat({ cwd: '/x', agentId: 'codex', title: 't' });
    expect(chat!.sessionId, 'non-claude agents must NOT get a session UUID').toBeUndefined();
    expect(chat!.args).not.toContain('--session-id');
  });

  it('round-trip: persisted snapshot includes sessionId and restore preserves it', async () => {
    let m = await importChats();
    const first = m.openFreshChat({ cwd: '/tmp/p', title: 'has-session' });
    expect(first!.sessionId).toBeTruthy();
    const expectedSid = first!.sessionId!;
    m.flushPersistOpenChatsForTest();

    // Re-import the module — simulates app restart. localStorage is shared.
    m = await importChats();
    m.restoreOpenChats();
    expect(m.openChats().length, 'restore must produce at least one chat').toBe(1);
    const restored = m.openChats()[0]!;
    expect(restored.sessionId).toBe(expectedSid);
    // After restore, args use --resume <sid> (openChatFromSession path),
    // proving the chat is treated as an existing session, not a blank one.
    const ri = restored.args.indexOf('--resume');
    expect(ri, 'restored chat must be spawned with --resume').toBeGreaterThanOrEqual(0);
    expect(restored.args[ri + 1]).toBe(expectedSid);
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
