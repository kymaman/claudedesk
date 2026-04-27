/**
 * chat-projects-isolation.test.ts
 *
 * Locks the new isolation rules added in this commit:
 *   - Switching projects does NOT close existing chats. The chat list keeps
 *     every chat alive; only the visible filter changes.
 *   - openChatsInProject(id) returns only chats tagged with that project.
 *   - reorderChat moves a chat to the target index, leaving the rest in
 *     their relative order.
 *   - setChatProject re-tags an existing chat.
 *
 * These were the user-visible bug: "новый чат закрывает старые" — the old
 * openProject() called closeChat() on everything, killing PTYs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal localStorage polyfill — vitest is Node, no DOM by default.
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

// Stub the parallel-code core store — chats.ts only reads availableAgents.
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
    ],
  },
}));

async function importChats() {
  vi.resetModules();
  return await import('./chats');
}

describe('openChatsInProject — workspace filter', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('returns only chats tagged with the given projectId', async () => {
    const { openFreshChat, openChatsInProject } = await importChats();
    const a = openFreshChat({ cwd: '/tmp/a', projectId: 'p1', title: 'a' });
    const b = openFreshChat({ cwd: '/tmp/b', projectId: 'p2', title: 'b' });
    const c = openFreshChat({ cwd: '/tmp/c', projectId: null, title: 'c' });
    expect(a && b && c).toBeTruthy();

    expect(openChatsInProject('p1').map((x) => x.title)).toEqual(['a']);
    expect(openChatsInProject('p2').map((x) => x.title)).toEqual(['b']);
    // Unassigned bucket
    expect(openChatsInProject(null).map((x) => x.title)).toEqual(['c']);
  });

  it('keeps every chat alive when filtering — switching projects must not destroy work', async () => {
    const { openFreshChat, openChats, openChatsInProject } = await importChats();
    openFreshChat({ cwd: '/tmp/a', projectId: 'p1', title: 'a' });
    openFreshChat({ cwd: '/tmp/b', projectId: 'p2', title: 'b' });
    // Reading p1's view doesn't touch p2's chat.
    void openChatsInProject('p1');
    expect(
      openChats()
        .map((c) => c.title)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('setChatProject — re-tagging an existing chat', () => {
  beforeEach(() => localStorage.clear());

  it('moves a chat from one project bucket to another without closing it', async () => {
    const { openFreshChat, openChatsInProject, setChatProject } = await importChats();
    const chat = openFreshChat({ cwd: '/tmp/a', projectId: 'p1' });
    expect(chat).toBeTruthy();
    expect(openChatsInProject('p1')).toHaveLength(1);
    setChatProject((chat as { id: string }).id, 'p2');
    expect(openChatsInProject('p1')).toHaveLength(0);
    expect(openChatsInProject('p2')).toHaveLength(1);
  });

  it('null projectId puts a chat back into the unassigned bucket', async () => {
    const { openFreshChat, openChatsInProject, setChatProject } = await importChats();
    const chat = openFreshChat({ cwd: '/tmp/x', projectId: 'p9' });
    expect(chat).toBeTruthy();
    setChatProject((chat as { id: string }).id, null);
    expect(openChatsInProject('p9')).toHaveLength(0);
    expect(openChatsInProject(null)).toHaveLength(1);
  });
});

describe('reorderChat — drag-rearrange tab order', () => {
  beforeEach(() => localStorage.clear());

  it('moves a chat to a target index, preserving the rest', async () => {
    const { openFreshChat, openChats, reorderChat } = await importChats();
    const a = openFreshChat({ cwd: '/a', title: 'a' });
    const b = openFreshChat({ cwd: '/b', title: 'b' });
    const c = openFreshChat({ cwd: '/c', title: 'c' });
    const d = openFreshChat({ cwd: '/d', title: 'd' });
    expect(a && b && c && d).toBeTruthy();
    expect(openChats().map((x) => x.title)).toEqual(['a', 'b', 'c', 'd']);

    // Drag 'a' → index 2 (between c and d).
    reorderChat((a as { id: string }).id, 2);
    expect(openChats().map((x) => x.title)).toEqual(['b', 'c', 'a', 'd']);

    // Drag 'd' → index 0.
    reorderChat((d as { id: string }).id, 0);
    expect(openChats().map((x) => x.title)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('clamps the target index into [0, length-1]', async () => {
    const { openFreshChat, openChats, reorderChat } = await importChats();
    const a = openFreshChat({ cwd: '/a', title: 'a' });
    const b = openFreshChat({ cwd: '/b', title: 'b' });
    expect(a && b).toBeTruthy();
    reorderChat((a as { id: string }).id, 99);
    expect(openChats().map((x) => x.title)).toEqual(['b', 'a']);
    reorderChat((b as { id: string }).id, -5);
    expect(openChats().map((x) => x.title)).toEqual(['b', 'a']);
  });

  it('is a no-op when the chat is already at the target index', async () => {
    const { openFreshChat, openChats, reorderChat } = await importChats();
    const a = openFreshChat({ cwd: '/a', title: 'a' });
    const b = openFreshChat({ cwd: '/b', title: 'b' });
    expect(a && b).toBeTruthy();
    reorderChat((a as { id: string }).id, 0);
    expect(openChats().map((x) => x.title)).toEqual(['a', 'b']);
  });
});
