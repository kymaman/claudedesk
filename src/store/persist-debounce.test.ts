/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code */
/**
 * Unit: persistOpenChats is debounced.
 *
 * Before: every _chats() change wrote JSON to localStorage immediately,
 * so a burst of rename/recency/close events caused many redundant
 * serialize+write passes. After: writes coalesce within ~500ms, and
 * flushPersistOpenChatsForTest() forces an immediate drain (used by
 * beforeunload).
 *
 * Real timers here — Solid effect scheduling + vi.useFakeTimers fight
 * over the microtask queue and the test becomes flaky. Adding ~1s to
 * the unit suite is a fair trade for behavior correctness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes: Array<{ key: string; value: string }> = [];

{
  const s = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => s.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push({ key: k, value: String(v) });
        s.set(k, String(v));
      },
      removeItem: (k: string) => void s.delete(k),
      clear: () => {
        s.clear();
        writes.length = 0;
      },
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('persistOpenChats debounce', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    // Belt-and-braces: drain any pending timer between tests.
  });

  it('coalesces a burst of changes into a single localStorage write', async () => {
    const m = await importChats();

    // Burst: open 3 chats and rename one. Pre-debounce this would have
    // produced ≥4 localStorage.setItem calls.
    m.openFreshChat({ cwd: '/a', title: 'A' });
    m.openFreshChat({ cwd: '/b', title: 'B' });
    m.openFreshChat({ cwd: '/c', title: 'C' });
    const chats = m.chats();
    m.renameChat(chats[0]!.id, 'A renamed');

    // Wait past the debounce window.
    await wait(700);

    // Exactly one write committed for the whole burst.
    expect(writes.length).toBe(1);
    const persisted = JSON.parse(writes[0]!.value) as Array<Record<string, unknown>>;
    expect(persisted.length).toBe(3);
    expect(persisted.every((p) => typeof p.id === 'string' && typeof p.cwd === 'string')).toBe(
      true,
    );
  });

  it('flushPersistOpenChatsForTest drains immediately', async () => {
    const m = await importChats();
    m.openFreshChat({ cwd: '/tmp', title: 'pending' });
    // No wait — debounce timer hasn't fired yet.
    m.flushPersistOpenChatsForTest();
    expect(writes.length).toBe(1);
    // After flush the pending timer (if any) must NOT add another write.
    await wait(700);
    expect(writes.length).toBe(1);
  });

  it('the eventual write reflects the LATEST title (last-write-wins inside the window)', async () => {
    const m = await importChats();
    const chat = m.openFreshChat({ cwd: '/x', title: 'first' });
    m.renameChat(chat!.id, 'second');
    m.renameChat(chat!.id, 'final');
    await wait(700);
    expect(writes.length).toBe(1);
    const persisted = JSON.parse(writes[0]!.value) as Array<{ title: string }>;
    expect(persisted[0]!.title).toBe('final');
  });
});
