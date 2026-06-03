/**
 * chip-chats-recency.test.ts
 *
 * Pins the "recent dialogs rise to the top of the tab strip" behaviour
 * (user: «последние диалоги поднимаются вверх» on the open-chat tabs).
 *
 * chipChats(projectId) returns the project's open chats sorted by
 * last-activity DESC — activating a chat (setActiveChatId) bumps it to
 * the front. It must NOT mutate the underlying _chats array (terminal
 * object identity has to stay stable so xterm/PTY don't remount).
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

describe('chipChats — most-recently-used first', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('orders chats by last activation, newest first', async () => {
    // Advance the clock on each Date.now() so created/activated timestamps
    // are strictly increasing — otherwise three same-millisecond creations
    // tie and the sort just preserves insertion order.
    let clock = 1_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10));

    const { openFreshChat, setActiveChatId, chipChats } = await importChats();
    const a = openFreshChat({ cwd: '/a', title: 'a' });
    const b = openFreshChat({ cwd: '/b', title: 'b' });
    const c = openFreshChat({ cwd: '/c', title: 'c' });
    expect(a && b && c).toBeTruthy();

    // Newest-created is active → it leads initially (c, b, a by createdAt).
    expect(chipChats(null).map((x) => x.title)).toEqual(['c', 'b', 'a']);

    // Activate 'a' → it jumps to the front.
    setActiveChatId((a as { id: string }).id);
    expect(chipChats(null).map((x) => x.title)).toEqual(['a', 'c', 'b']);

    // Then activate 'b' → b leads, a stays second (more recent than c).
    setActiveChatId((b as { id: string }).id);
    expect(chipChats(null).map((x) => x.title)).toEqual(['b', 'a', 'c']);

    spy.mockRestore();
  });

  it('scopes to the given projectId', async () => {
    const { openFreshChat, chipChats } = await importChats();
    openFreshChat({ cwd: '/a', title: 'a', projectId: 'p1' });
    openFreshChat({ cwd: '/b', title: 'b', projectId: 'p2' });
    openFreshChat({ cwd: '/c', title: 'c', projectId: null });

    expect(chipChats('p1').map((x) => x.title)).toEqual(['a']);
    expect(chipChats('p2').map((x) => x.title)).toEqual(['b']);
    expect(chipChats(null).map((x) => x.title)).toEqual(['c']);
  });

  it('does not mutate the underlying openChats order (terminal identity stays stable)', async () => {
    const { openFreshChat, openChats, setActiveChatId, chipChats } = await importChats();
    const a = openFreshChat({ cwd: '/a', title: 'a' });
    openFreshChat({ cwd: '/b', title: 'b' });
    const beforeRefs = openChats();
    const beforeOrder = beforeRefs.map((x) => x.title);

    setActiveChatId((a as { id: string }).id);
    void chipChats(null);

    const afterRefs = openChats();
    // Same array order AND same object references — chipChats returned a copy.
    expect(afterRefs.map((x) => x.title)).toEqual(beforeOrder);
    expect(afterRefs[0]).toBe(beforeRefs[0]);
    expect(afterRefs[1]).toBe(beforeRefs[1]);
  });

  it('renameChat updates the title shown in the chip list', async () => {
    const { openFreshChat, renameChat, chipChats } = await importChats();
    const a = openFreshChat({ cwd: '/a', title: 'old' });
    expect(a).toBeTruthy();
    renameChat((a as { id: string }).id, 'new name');
    expect(chipChats(null).map((x) => x.title)).toEqual(['new name']);
  });
});
