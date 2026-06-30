/* eslint-disable @typescript-eslint/no-non-null-assertion -- test asserts on a
   freshly-created chat whose existence is checked inline. */
/**
 * fresh-session-adopt.test.ts
 *
 * A fresh tile (openFreshChat, no --resume seed) must ADOPT the session
 * id claude mints, so it survives an app restart. Before the fix the tile
 * kept sessionId=undefined forever → on restart it spawned a blank claude
 * («последние диалоги открылись как новые чаты»).
 *
 * Here the main process (ResolveFreshSession IPC) is mocked to report the
 * minted id; the test asserts the renderer adopts it into the tile AND
 * persists it so a restart would resume.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const storageMap = new Map<string, string>();
{
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => void storageMap.set(k, String(v)),
      removeItem: (k: string) => void storageMap.delete(k),
      clear: () => void storageMap.clear(),
      key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
      get length() {
        return storageMap.size;
      },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: globalThis.crypto ?? { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
  });
}

const MINTED = 'aaaaaaaa-1111-4000-8000-000000000001';

// Main process: report the fresh session claude minted; report no live
// continuation (so the follow-up watchLiveSession is a no-op).
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === IPC.ResolveFreshSession) return { sessionId: MINTED, changed: true };
  if (cmd === IPC.ResolveLiveSession)
    return { sessionId: args?.sessionId as string, changed: false };
  return undefined;
});

vi.mock('../lib/ipc', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  fireAndForget: () => {},
}));

vi.mock('./core', () => ({
  store: {
    availableAgents: [
      {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
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
  invokeMock.mockClear();
  return await import('./chats');
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('fresh chat adopts the session claude mints', () => {
  beforeEach(() => storageMap.clear());
  afterEach(() => storageMap.clear());

  it('a fresh chat with no sessionId adopts the minted id and persists it', async () => {
    const m = await importChats();
    const chat = m.openFreshChat({ cwd: '/tmp/proj', title: 'cross posting' })!;
    expect(chat.sessionId).toBeUndefined();

    await flush();

    const live = m.openChats().find((c) => c.id === chat.id)!;
    expect(live.sessionId, 'tile adopted the minted session id').toBe(MINTED);

    m.flushPersistOpenChatsForTest();
    const snap = JSON.parse(storageMap.get('claudedesk.openChats') ?? '[]');
    expect(snap[0].sessionId, 'minted id is persisted → survives restart').toBe(MINTED);
    expect(invokeMock).toHaveBeenCalledWith(
      IPC.ResolveFreshSession,
      expect.objectContaining({ cwd: '/tmp/proj' }),
    );
  }, 30_000);

  it('does not overwrite a slot a sibling tile already owns', async () => {
    const m = await importChats();
    // Pre-existing tile already owning MINTED (resumed from a session).
    m.openChatFromSession(
      {
        sessionId: MINTED,
        filePath: '/x.jsonl',
        projectPath: '/tmp/proj',
        title: 'owner',
        date: '2026-06-27',
        folderIds: [],
      },
      { agentId: 'claude-opus-4-8', extraFlags: [], skipPermissions: false },
    );
    const fresh = m.openFreshChat({ cwd: '/tmp/proj', title: 'fresh' })!;
    await flush();
    const live = m.openChats().find((c) => c.id === fresh.id)!;
    expect(live.sessionId, 'must NOT steal the sibling-owned id').toBeUndefined();
  }, 30_000);
});
