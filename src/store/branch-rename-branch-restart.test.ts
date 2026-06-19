/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code asserts on
   freshly-constructed chats whose existence is verified inline. */
/**
 * branch-rename-branch-restart.test.ts
 *
 * Replays the user's EXACT global-zone sequence (2026-06-15):
 *   1. open a session ("openclaw skills") as a tile
 *   2. branch it
 *   3. rename the branch (Russian) and press Enter
 *   4. branch it AGAIN
 *   5. quit (persist flush)
 *   6. reopen (restoreOpenChats)
 * and asserts every branch comes back. The user reported the branch was
 * gone after reopening — this test must localise WHERE in that flow the
 * branch is dropped from what gets persisted / restored.
 *
 * Runs the real store with `window` defined (so watchLiveSession fires)
 * and an IPC mock. The mock models claude's on-disk reality: a --resume
 * mints a fresh continuation file, so resolving S0 yields a NEW id the
 * first time and "nothing new" once that id is excluded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionItem } from './sessions-history';
import { IPC } from '../../electron/ipc/channels';

// jsdom-free globals chats.ts touches.
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

const S0 = '00000000-0000-4000-8000-000000000000';

// IPC mock: model "no continuation exists yet" — branches stay undiverged
// (sessionId === parent) until the user actually sends a message, which a
// restore never does. This is the real state right after branching: claude
// has not written the fork's own JSONL, so ResolveLiveSession finds nothing
// newer and returns changed:false. The tiles must survive ANYWAY.
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === IPC.ResolveLiveSession) {
    return { sessionId: args?.sessionId as string, changed: false };
  }
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

const SESSION: SessionItem = {
  sessionId: S0,
  filePath: '/var/sessions/S0.jsonl',
  projectPath: '/tmp/openclaw',
  title: 'openclaw skills',
  date: '2026-06-15',
  folderIds: [],
};
const SETTINGS = { agentId: 'claude-opus-4-8', extraFlags: [], skipPermissions: false };

describe('branch → rename → branch → restart keeps every branch (global zone)', () => {
  beforeEach(() => storageMap.clear());
  afterEach(() => storageMap.clear());

  it('after restart the two branches are still there', async () => {
    let m = await importChats();

    // 1. open the parent session as a tile
    const parent = m.openChatFromSession(SESSION, SETTINGS)!;
    expect(parent).toBeTruthy();

    // 2. branch it
    const a = await m.branchChat(parent.id);
    expect(a, 'first branch created').toBeTruthy();

    // 3. rename the branch (Russian) — the user pressed Enter here
    m.renameChat(a!.id, 'мой бранч');

    // 4. branch it AGAIN (branch of the branch)
    const b = await m.branchChat(a!.id);
    expect(b, 'second branch created').toBeTruthy();

    await flush();

    // Sanity: before "quit", all three tiles are live.
    expect(m.openChats().length).toBe(3);

    // 5. quit — flush the debounced snapshot to localStorage
    m.flushPersistOpenChatsForTest();
    const snapshot = JSON.parse(storageMap.get('claudedesk.openChats') ?? '[]');
    // Every tile (parent + 2 branches) must be in the persisted snapshot.
    expect(snapshot.length, 'all 3 tiles persisted').toBe(3);

    // 6. reopen — fresh module instance, same localStorage
    m = await importChats();
    expect(m.openChats().length, 'no tiles before restore').toBe(0);
    m.restoreOpenChats();
    await flush();

    const open = m.openChats();
    const branches = open.filter((c) => c.forkParent);
    expect(open.length, 'parent + 2 branches restored').toBe(3);
    expect(branches.length, 'both branches restored').toBe(2);
  });
});
