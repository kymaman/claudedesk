/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code asserts on
   freshly-constructed chats whose existence is verified inline. */
/**
 * branch-no-glue.test.ts
 *
 * Renderer-side guarantee for the "I branched a dialog and the SAME
 * conversation now runs in both tiles" bug (2026-06-15).
 *
 * When two tiles fork the same parent session S0, claude writes TWO
 * continuation files that both copy S0's last-message uuid, so the live
 * resolver matches both. The store must hand each tile a DISTINCT live
 * session id instead of gluing both onto the newest match.
 *
 * This drives the real watchLiveSession → claimLiveSession path with a
 * mocked IPC that mimics that disk shape: it returns the newest
 * continuation, unless that one is in `excludeSessionIds`, in which case
 * it returns the other. The sequential (single-threaded) collision retry
 * must split the two tiles apart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionItem } from './sessions-history';
import { IPC } from '../../electron/ipc/channels';

// jsdom-free: provide the globals chats.ts touches.
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
  // watchLiveSession is gated on `typeof window !== 'undefined'`; chats.ts
  // also registers beforeunload/pagehide listeners at import time.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
}

const CONT_A = '0000aaaa-0000-4000-8000-000000000000';
const CONT_B = '0000bbbb-0000-4000-8000-000000000000'; // "newest" continuation

// Controllable IPC mock. ResolveLiveSession mimics two sibling
// continuations of the same parent: hand out CONT_B first, then CONT_A
// once CONT_B is excluded, then "nothing left" (unchanged).
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === IPC.ResolveLiveSession) {
    const exclude = new Set((args?.excludeSessionIds as string[] | undefined) ?? []);
    if (!exclude.has(CONT_B)) return { sessionId: CONT_B, changed: true };
    if (!exclude.has(CONT_A)) return { sessionId: CONT_A, changed: true };
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
  invokeMock.mockClear();
  return await import('./chats');
}

const SESSION: SessionItem = {
  sessionId: '00000000-0000-4000-8000-000000000000',
  filePath: '/var/sessions/S0.jsonl',
  projectPath: '/tmp/proj',
  title: 'Parent dialog',
  date: '2026-06-15',
  folderIds: [],
};

/** Drain the async claimLiveSession retry chain (microtasks + the
 *  awaited re-invoke). A handful of macrotask flushes is plenty. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('branching never glues two tiles onto one live session', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('two branches from the same parent adopt DISTINCT live session ids', async () => {
    const m = await importChats();
    const settings = { agentId: 'claude-opus-4-7', extraFlags: [], skipPermissions: false };

    const t1 = m.branchChatFromSession(SESSION, settings);
    const t2 = m.branchChatFromSession(SESSION, settings);
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();

    await flush();

    const chats = m.openChats();
    const c1 = chats.find((c) => c.id === t1!.id);
    const c2 = chats.find((c) => c.id === t2!.id);
    expect(c1?.sessionId).toBeTruthy();
    expect(c2?.sessionId).toBeTruthy();
    // The whole point of a branch: two SEPARATE conversations.
    expect(c1!.sessionId).not.toBe(c2!.sessionId);
    // And both advanced off the shared parent onto real continuations.
    expect([CONT_A, CONT_B]).toContain(c1!.sessionId);
    expect([CONT_A, CONT_B]).toContain(c2!.sessionId);
  });

  it('passes sibling-owned ids as excludeSessionIds when watching', async () => {
    const m = await importChats();
    const settings = { agentId: 'claude-opus-4-7', extraFlags: [], skipPermissions: false };
    m.branchChatFromSession(SESSION, settings);
    m.branchChatFromSession(SESSION, settings);
    await flush();

    const resolveCalls = invokeMock.mock.calls.filter((c) => c[0] === IPC.ResolveLiveSession);
    expect(resolveCalls.length).toBeGreaterThan(0);
    // At least one ResolveLiveSession call carried a non-empty exclude set
    // — proof the store tells the resolver which continuations are taken.
    const sawExclude = resolveCalls.some(
      (c) => ((c[1]?.excludeSessionIds as string[] | undefined)?.length ?? 0) > 0,
    );
    expect(sawExclude).toBe(true);
  });
});
