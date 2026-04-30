/**
 * chats-dedup.test.ts
 *
 * Verifies that openChatFromSession deduplicates against already-open tiles.
 * The fix: scan _chats() for a non-closed entry with the same (sessionId,
 * projectId); if found, call setActiveChatId and return the existing chat
 * instead of spawning a fresh --resume PTY.
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code asserts on
   freshly-constructed chats whose existence is verified inline. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionItem } from './sessions-history';

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

const SESSION: SessionItem = {
  sessionId: 'sess-1234-5678',
  filePath: '/var/sessions/sess-1234-5678.jsonl',
  projectPath: '/tmp/proj',
  title: 'Resumed thread',
  date: '2026-04-27',
  folderIds: [],
};

const SETTINGS = {
  agentId: 'claude-opus-4-7',
  extraFlags: [],
  skipPermissions: false,
};

describe('openChatFromSession — dedup behaviour', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('clicking the same session twice returns the same Chat — only one tile in openChats()', async () => {
    const { openChatFromSession, chats, openChats, activeChatId } = await importChats();

    const first = openChatFromSession(SESSION, SETTINGS);
    expect(first).toBeTruthy();

    const second = openChatFromSession(SESSION, SETTINGS);
    expect(second).toBeTruthy();

    // Same object id — dedup fired, no new tile was created.
    expect(second!.id).toBe(first!.id);

    // Exactly one non-closed tile.
    const open = openChats();
    expect(open.length).toBe(1);
    expect(chats().filter((c) => !c.closed).length).toBe(1);

    // Active chat must be that tile.
    expect(activeChatId()).toBe(first!.id);
  });

  it('same session in two different projects creates two tiles; third call with p1 returns first', async () => {
    const { openChatFromSession, chats } = await importChats();

    const chatP1 = openChatFromSession(SESSION, SETTINGS, { projectId: 'p1' });
    expect(chatP1).toBeTruthy();

    const chatP2 = openChatFromSession(SESSION, SETTINGS, { projectId: 'p2' });
    expect(chatP2).toBeTruthy();

    // Two distinct tiles — dedup is per (sessionId, projectId).
    expect(chatP1!.id).not.toBe(chatP2!.id);
    expect(chats().filter((c) => !c.closed).length).toBe(2);

    // Third call with p1 must return the first tile (dedup hits).
    const chatP1Again = openChatFromSession(SESSION, SETTINGS, { projectId: 'p1' });
    expect(chatP1Again!.id).toBe(chatP1!.id);
    expect(chats().filter((c) => !c.closed).length).toBe(2);
  });

  it('closed chats do not block dedup — a new chat is created', async () => {
    const { openChatFromSession, chats, closeChat } = await importChats();

    const first = openChatFromSession(SESSION, SETTINGS);
    expect(first).toBeTruthy();
    const firstId = first!.id;

    // Close the tile.
    closeChat(firstId);

    // closeChat uses setTimeout(50ms) to prune — wait for it.
    await new Promise((r) => setTimeout(r, 100));

    // Opening the same session now must create a brand-new chat.
    const second = openChatFromSession(SESSION, SETTINGS);
    expect(second).toBeTruthy();
    expect(second!.id).not.toBe(firstId);

    // The closed chat may have been pruned; either way at most one open tile.
    expect(chats().filter((c) => !c.closed).length).toBe(1);
  });

  it('null projectId equality — undefined and null both dedup against the same null tile', async () => {
    const { openChatFromSession, chats } = await importChats();

    // First call — no projectId option at all (defaults to null internally).
    const first = openChatFromSession(SESSION, SETTINGS);
    expect(first).toBeTruthy();

    // Second call — explicit null.
    const second = openChatFromSession(SESSION, SETTINGS, { projectId: null });
    expect(second!.id).toBe(first!.id);

    // Third call — explicit undefined (same as omitted).
    const third = openChatFromSession(SESSION, SETTINGS, { projectId: undefined });
    expect(third!.id).toBe(first!.id);

    // Still only one open tile.
    expect(chats().filter((c) => !c.closed).length).toBe(1);
  });
});
