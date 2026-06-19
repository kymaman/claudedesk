/* eslint-disable @typescript-eslint/no-non-null-assertion -- test asserts the
   chats exist inline before dereferencing. */
/**
 * rename-keeps-chat-ref.test.ts
 *
 * RED→GREEN guard for the rename crash (2026-06-16). A crash dump + an e2e
 * proved the app died (Windows ConPTY heap corruption, c0000374) when a tile
 * was RENAMED. Root cause: `renameChat` replaced the chat object with a fresh
 * `{...c, title}`, and Solid's `<For>` keys items by reference identity — a
 * new object unmounts the ChatTile → TerminalView subtree, whose onCleanup
 * fires KillAgent → the ConPTY teardown that corrupts the heap. The fix
 * mutates the title IN PLACE so the object reference is stable and the PTY
 * survives, while display stays reactive through the titleOverrides Map.
 *
 * This test pins the exact invariant: rename must NOT change the chat object
 * reference (that is what keeps the terminal alive), yet titleFor must report
 * the new title. RED on the old `_setChats(prev.map(...))`, GREEN on the fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionItem } from './sessions-history';

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

const invokeMock = vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => undefined);
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

const SESSION: SessionItem = {
  sessionId: '00000000-0000-4000-8000-000000000000',
  filePath: '/var/sessions/S0.jsonl',
  projectPath: '/tmp/openclaw',
  title: 'openclaw skills',
  date: '2026-06-16',
  folderIds: [],
};
const SETTINGS = { agentId: 'claude-opus-4-8', extraFlags: [], skipPermissions: false };

describe('renameChat keeps the chat object reference stable (PTY survives)', () => {
  beforeEach(() => storageMap.clear());
  afterEach(() => storageMap.clear());

  it('does NOT replace the chat object, yet updates the displayed title', async () => {
    const m = await importChats();
    const chat = m.openChatFromSession(SESSION, SETTINGS)!;
    expect(chat).toBeTruthy();

    const refBefore = m.openChats().find((c) => c.id === chat.id);
    expect(refBefore, 'chat is open').toBeTruthy();

    m.renameChat(chat.id, 'мой бранч');

    const refAfter = m.openChats().find((c) => c.id === chat.id);
    // THE invariant: same object reference → <For> reconciliation is a no-op
    // → TerminalView never unmounts → no KillAgent → no ConPTY crash.
    expect(refAfter, 'rename must not replace the chat object').toBe(refBefore);
    // Display still reflects the new title (reactive via titleOverrides).
    expect(m.titleFor(refAfter!)).toBe('мой бранч');
  });

  it('a second rename also preserves the reference', async () => {
    const m = await importChats();
    const chat = m.openChatFromSession(SESSION, SETTINGS)!;
    const ref0 = m.openChats().find((c) => c.id === chat.id)!;

    m.renameChat(chat.id, 'первое имя');
    m.renameChat(chat.id, 'второе имя');

    const ref2 = m.openChats().find((c) => c.id === chat.id)!;
    expect(ref2, 'still the same object after two renames').toBe(ref0);
    expect(m.titleFor(ref2)).toBe('второе имя');
  });
});
