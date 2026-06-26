/**
 * chats-restore-stagger.test.ts
 *
 * Pins the startup-restore behaviour fixed for the "rendering suffers on
 * startup" report: restoreOpenChats() must NOT spawn every persisted chat in
 * one synchronous burst. It opens the first tile immediately, then drips the
 * rest one every RESTORE_STAGGER_MS so the `claude --resume` spawn storm (and
 * the WebGL-context exhaustion it caused) is spread out over time.
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

const PERSIST_KEY = 'claudedesk.openChats';

/** Build N persisted non-project chats, each with a DISTINCT sessionId so
 *  dedup doesn't collapse them into one tile. */
function seedPersisted(n: number): void {
  const list = Array.from({ length: n }, (_, i) => ({
    id: `chat-${i}`,
    sessionId: `sess-${i}-aaaa-bbbb`,
    title: `Restored ${i}`,
    cwd: `/tmp/proj-${i}`,
    agentDefId: 'claude-opus-4-7',
    extraFlags: [] as string[],
    skipPermissions: false,
    lastActiveAt: 1000 + i,
    createdAt: 1000 + i,
    gridIndex: i,
  }));
  localStorage.setItem(PERSIST_KEY, JSON.stringify(list));
}

describe('restoreOpenChats — staggered startup spawn', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('opens only the first tile synchronously, then one per RESTORE_STAGGER_MS', async () => {
    seedPersisted(4);
    const { restoreOpenChats, openChats, RESTORE_STAGGER_MS } = await importChats();

    restoreOpenChats();
    // Synchronous: exactly one tile is live, the rest are still queued.
    expect(openChats().filter((c) => !c.closed).length).toBe(1);

    vi.advanceTimersByTime(RESTORE_STAGGER_MS);
    expect(openChats().filter((c) => !c.closed).length).toBe(2);

    vi.advanceTimersByTime(RESTORE_STAGGER_MS);
    expect(openChats().filter((c) => !c.closed).length).toBe(3);

    vi.advanceTimersByTime(RESTORE_STAGGER_MS);
    expect(openChats().filter((c) => !c.closed).length).toBe(4);

    // No further tiles appear after the last scheduled spawn.
    vi.advanceTimersByTime(RESTORE_STAGGER_MS * 5);
    expect(openChats().filter((c) => !c.closed).length).toBe(4);
  });

  it('a single persisted chat restores immediately via the fast path', async () => {
    seedPersisted(1);
    const { restoreOpenChats, openChats, RESTORE_STAGGER_MS } = await importChats();

    restoreOpenChats();
    // Live synchronously — the single-chat fast path returns before scheduling.
    expect(openChats().filter((c) => !c.closed).length).toBe(1);
    // Draining timers must NOT spawn a second tile (no stagger was queued).
    vi.advanceTimersByTime(RESTORE_STAGGER_MS * 5);
    expect(openChats().filter((c) => !c.closed).length).toBe(1);
  });

  it('empty persistence is a no-op (no tiles, no timers)', async () => {
    const { restoreOpenChats, openChats } = await importChats();

    restoreOpenChats();
    expect(openChats().filter((c) => !c.closed).length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
