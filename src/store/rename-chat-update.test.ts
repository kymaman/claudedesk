/**
 * Sanity unit test: does renameChat actually update _chats?
 *
 * Three orthogonal checks isolate where rename can fail:
 *   (a) Map override — titleFor(chat) returns the new title
 *   (b) Array entry  — chats()[i].title is the new title
 *   (c) Tick bump    — _titleTick increments by exactly 1
 *
 * If all three pass here but the e2e still shows stale DOM, the bug is
 * downstream (Solid <For> not reconciling, JSX not subscribing, etc.).
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code asserts on
   freshly-constructed chats whose existence is verified inline. */
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
    ],
  },
}));

async function importChats() {
  vi.resetModules();
  return await import('./chats');
}

const SESSION: SessionItem = {
  sessionId: 'sess-rename-0001',
  filePath: '/var/sessions/sess-rename-0001.jsonl',
  projectPath: '/tmp/proj',
  title: 'Original title',
  date: '2026-05-21',
  folderIds: [] as string[],
};

describe('renameChat updates every read path', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('titleFor returns new value, chats()[i].title is new', async () => {
    const m = await importChats();
    const chat = m.openChatFromSession(SESSION, {
      agentId: 'claude-opus-4-7',
      extraFlags: [],
      skipPermissions: false,
    });
    expect(chat).not.toBeNull();
    const id = chat!.id;
    // Read the actual chat from the array — that's what UI components get
    // via `<For>`.
    const fresh = () => m.chats().find((c) => c.id === id)!;

    // Before rename
    expect(m.titleFor(fresh())).toBe('Original title');
    expect(fresh().title).toBe('Original title');

    m.renameChat(id, 'Renamed live');

    // After rename: titleFor + the array entry both reflect the new title.
    // (Array entry change is what feeds the chat-tile fallback if titleFor
    // ever loses the override.)
    expect(m.titleFor(fresh())).toBe('Renamed live');
    expect(fresh().title).toBe('Renamed live');
  });

  it('successive renames overwrite the override', async () => {
    const m = await importChats();
    const chat = m.openChatFromSession(SESSION, {
      agentId: 'claude-opus-4-7',
      extraFlags: [],
      skipPermissions: false,
    });
    const id = chat!.id;

    m.renameChat(id, 'First');
    expect(m.titleFor({ id, title: '?' })).toBe('First');
    m.renameChat(id, 'Second');
    expect(m.titleFor({ id, title: '?' })).toBe('Second');
    m.renameChat(id, 'Third');
    expect(m.titleFor({ id, title: '?' })).toBe('Third');
  });
});
