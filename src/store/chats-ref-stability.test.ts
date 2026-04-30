/**
 * chats-ref-stability.test.ts
 *
 * Pins the PTY-survives-click invariant: setActiveChatId must NOT replace
 * chat objects in the chats() array. Solid <For> keys by reference — a new
 * object causes ChatTile → TerminalView.onCleanup → KillAgent → PTY dies.
 *
 * The fix: lastActiveAt updates go through _lastActiveAtById (side Map),
 * keeping chat object refs stable across every setActiveChatId call.
 *
 * These tests FAIL on the old code (which did _setChats(prev => prev.map(…)))
 * and PASS on the fixed code.
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code asserts on
   freshly-constructed chats whose existence is verified inline. */
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

const SESSION = {
  sessionId: 'sess-ref-stability-0001',
  filePath: '/var/sessions/sess-ref-stability-0001.jsonl',
  projectPath: '/tmp/proj',
  title: 'PTY stability thread',
  date: '2026-04-30',
  folderIds: [] as string[],
};

const SESSION_B = {
  sessionId: 'sess-ref-stability-0002',
  filePath: '/var/sessions/sess-ref-stability-0002.jsonl',
  projectPath: '/tmp/proj-b',
  title: 'PTY stability thread B',
  date: '2026-04-30',
  folderIds: [] as string[],
};

const SETTINGS = {
  agentId: 'claude-opus-4-7',
  extraFlags: [],
  skipPermissions: false,
};

describe('PTY-survives-click — chat object reference stability', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('setActiveChatId on an already-open chat preserves the chat object reference in chats() array', async () => {
    const { openChatFromSession, chats, setActiveChatId } = await importChats();

    openChatFromSession(SESSION, SETTINGS);
    const capturedRef = chats()[0];

    // Call setActiveChatId again on the same chat.
    setActiveChatId(capturedRef.id);

    // Solid <For> reconciles by reference — the object in the array MUST be
    // the identical reference, not a new spread copy.
    expect(chats()[0]).toBe(capturedRef);
  });

  it('clicking the same chat 5 times keeps the same reference', async () => {
    const { openChatFromSession, chats, setActiveChatId } = await importChats();

    openChatFromSession(SESSION, SETTINGS);
    const original = chats()[0];

    const refs: object[] = [];
    for (let i = 0; i < 5; i++) {
      setActiveChatId(original.id);
      refs.push(chats()[0]);
    }

    for (const ref of refs) {
      expect(ref).toBe(original);
    }
  });

  it('setActiveChatId on a different chat preserves both chat object refs', async () => {
    const { openChatFromSession, chats, setActiveChatId } = await importChats();

    openChatFromSession(SESSION, SETTINGS);
    openChatFromSession(SESSION_B, SETTINGS);

    const aRef = chats().find((c) => c.sessionId === SESSION.sessionId)!;
    const bRef = chats().find((c) => c.sessionId === SESSION_B.sessionId)!;
    expect(aRef).toBeTruthy();
    expect(bRef).toBeTruthy();

    // Switch to chat B — neither A nor B's object should be replaced.
    setActiveChatId(bRef.id);

    expect(chats().find((c) => c.sessionId === SESSION.sessionId)).toBe(aRef);
    expect(chats().find((c) => c.sessionId === SESSION_B.sessionId)).toBe(bRef);
  });

  it('setActiveChatId still updates activeChatId() correctly', async () => {
    const { openChatFromSession, chats, setActiveChatId, activeChatId } = await importChats();

    openChatFromSession(SESSION, SETTINGS);
    openChatFromSession(SESSION_B, SETTINGS);

    const aId = chats().find((c) => c.sessionId === SESSION.sessionId)!.id;
    const bId = chats().find((c) => c.sessionId === SESSION_B.sessionId)!.id;

    setActiveChatId(aId);
    expect(activeChatId()).toBe(aId);

    setActiveChatId(bId);
    expect(activeChatId()).toBe(bId);
  });

  it('lastActiveAt persisted to localStorage reflects the latest setActiveChatId call, not the chat construction time', async () => {
    const { openChatFromSession, chats, setActiveChatId } = await importChats();

    openChatFromSession(SESSION, SETTINGS);
    const chatA = chats()[0];

    // Give a measurable gap so "construction time" vs "activation time" differ.
    await new Promise((r) => setTimeout(r, 5));

    setActiveChatId(chatA.id);

    const raw = localStorage.getItem('claudedesk.openChats');
    expect(raw).not.toBeNull();

    const persisted: Array<{ id: string; lastActiveAt: number; createdAt: number }> = JSON.parse(
      raw!,
    );
    const entry = persisted.find((p) => p.id === chatA.id);
    expect(entry).toBeTruthy();

    // lastActiveAt must be AFTER the chat was constructed (createdAt).
    expect(entry!.lastActiveAt).toBeGreaterThan(entry!.createdAt);
  });

  it('closing a chat removes its entry from the side Map — no stale entry in persisted list', async () => {
    const { openChatFromSession, chats, setActiveChatId, closeChat } = await importChats();

    openChatFromSession(SESSION, SETTINGS);
    const chatA = chats()[0];
    setActiveChatId(chatA.id);

    // Close chat A and wait for the 50ms prune timer.
    closeChat(chatA.id);
    await new Promise((r) => setTimeout(r, 60));

    // Open chat B, then call setActiveChatId to force a persistOpenChats
    // flush (createEffect doesn't re-trigger in Node/vitest environment).
    const chatB = openChatFromSession(SESSION_B, SETTINGS)!;
    setActiveChatId(chatB.id);

    const raw = localStorage.getItem('claudedesk.openChats');
    expect(raw).not.toBeNull();

    const persisted: Array<{ id: string }> = JSON.parse(raw!);
    const staleEntry = persisted.find((p) => p.id === chatA.id);

    // Chat A must not appear — it was pruned from _chats and its side-Map
    // entry was deleted by closeChat's setTimeout callback.
    expect(staleEntry).toBeUndefined();
  });
});
