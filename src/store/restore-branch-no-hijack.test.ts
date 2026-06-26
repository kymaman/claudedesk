/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code asserts on
   freshly-constructed chats whose existence is verified inline. */
/**
 * restore-branch-no-hijack.test.ts
 *
 * The "my branch disappeared after I reopened the app" bug, take 2
 * (2026-06-15). The user branched an "openclaw skills" dialog, renamed
 * the branch, made another branch, quit, reopened — and the branch was
 * gone / showed the parent's conversation.
 *
 * Earlier restore tests only proved the branch tile is RE-CREATED. They
 * passed because `window` was undefined, so `watchLiveSession()` never
 * ran. The real app DOES run it: every restored tile immediately asks
 * the main process for its live continuation.
 *
 * The trap: an UNDIVERGED branch shares its parent's sessionId (S0). It
 * has no continuation of its OWN on disk yet — the only continuation of
 * S0 is the PARENT's (SP). On restore both the parent tile and the
 * re-forked branch tile watch S0. If the BRANCH resolves first it adopts
 * SP — i.e. it glues onto the parent's conversation, and the user's
 * branch is effectively gone.
 *
 * This test drives the real restoreOpenChats → watchLiveSession path
 * with `window` defined and an IPC mock that mimics a single existing
 * continuation (SP) of S0. The branch must NOT end up on SP: the fork
 * must stay distinct from the parent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

// jsdom-free globals chats.ts touches.
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
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
}

const S0 = '00000000-0000-4000-8000-000000000000'; // parent + undiverged branch share this
const SP = '0000pppp-0000-4000-8000-00000000pppp'.replace(/p/g, 'a'); // parent's lone continuation

// IPC mock: S0 has exactly ONE continuation on disk, SP — the parent's.
// (An undiverged branch has no continuation of its own.) Whoever asks
// for S0's live id gets SP, unless SP is already excluded, in which case
// there's nothing left (changed:false) — the branch must then stay on S0.
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === IPC.ResolveLiveSession) {
    const exclude = new Set((args?.excludeSessionIds as string[] | undefined) ?? []);
    if (!exclude.has(SP)) return { sessionId: SP, changed: true };
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
  for (let i = 0; i < 16; i++) await new Promise((r) => setTimeout(r, 0));
}

const SNAPSHOT = [
  {
    id: 'chat-parent',
    sessionId: S0,
    title: 'openclaw skills',
    cwd: '/tmp/openclaw',
    agentDefId: 'claude-opus-4-8',
    extraFlags: [],
    skipPermissions: false,
    lastActiveAt: 1000,
    createdAt: 1000,
    gridIndex: 0,
  },
  {
    id: 'chat-branch',
    sessionId: S0, // undiverged — still the parent's id
    title: 'openclaw skills • branch 12:00',
    cwd: '/tmp/openclaw',
    agentDefId: 'claude-opus-4-8',
    extraFlags: [],
    skipPermissions: false,
    lastActiveAt: 2000,
    createdAt: 2000,
    gridIndex: 1,
    forkParent: { sessionId: S0, title: 'openclaw skills' },
  },
];

describe('restore: a re-forked branch never glues onto the parent continuation', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('parent + branch both come back and stay on DISTINCT sessions', async () => {
    const m = await importChats();
    localStorage.setItem('claudedesk.openChats', JSON.stringify(SNAPSHOT));

    m.restoreOpenChats({ staggerMs: 0 });
    await flush();

    const open = m.openChats();
    expect(open.length).toBe(2);

    const parent = open.find((c) => !c.forkParent);
    const branch = open.find((c) => c.forkParent);
    expect(parent, 'parent tile restored').toBeTruthy();
    expect(branch, 'branch tile restored').toBeTruthy();

    // The fork must not have stolen the parent's continuation: the two
    // tiles must be on different live sessions.
    expect(branch!.sessionId).not.toBe(parent!.sessionId);
  });

  it('the parent — not the fork — owns its continuation SP', async () => {
    const m = await importChats();
    localStorage.setItem('claudedesk.openChats', JSON.stringify(SNAPSHOT));

    m.restoreOpenChats({ staggerMs: 0 });
    await flush();

    const open = m.openChats();
    const parent = open.find((c) => !c.forkParent)!;
    const branch = open.find((c) => c.forkParent)!;

    // SP is S0's only on-disk continuation, and it is the PARENT's.
    // The branch, having no continuation of its own yet, must stay on S0.
    expect(branch.sessionId).toBe(S0);
    expect(parent.sessionId).toBe(SP);
  });
});
