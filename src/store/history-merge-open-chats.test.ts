/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code */
/**
 * Unit: filteredSessions() shows freshly-opened chats immediately.
 *
 * Bug #35: there's no manual refresh button — when the user creates a
 * new chat tile, it must appear in History at once. Previously History
 * only listed JSONLs already on disk, so a brand-new chat (claude hasn't
 * written its file yet) was invisible until the user typed AND refreshed.
 *
 * The fix merges open chats with a sessionId into the filteredSessions
 * stream; disk entries with the same sessionId win on dedup so once
 * loadSessions() picks up the real JSONL nothing changes for the user.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        id: 'claude-opus-4-8',
        name: 'Claude Code (Opus 4.8)',
        command: 'claude',
        args: ['--model', 'claude-opus-4-8'],
        skip_permissions_args: ['--dangerously-skip-permissions'],
        available: true,
      },
      {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        skip_permissions_args: ['--full-auto'],
        available: true,
      },
    ],
  },
}));

// Skip the session-filters defaults so our test list isn't filtered
// by hidden-projects or anything else surprising.
vi.mock('./session-filters', () => ({
  filterState: () => ({ sort: 'newest', hiddenProjects: [] }),
  setSortOrder: () => undefined,
  toggleHiddenProject: () => undefined,
}));

vi.mock('./session-hide', () => ({
  hiddenSessions: () => new Set<string>(),
  hideSession: () => undefined,
}));

async function importBoth() {
  vi.resetModules();
  const chats = await import('./chats');
  const history = await import('./sessions-history');
  return { chats, history };
}

describe('bug #35 — History shows OPEN chats with a sessionId without refresh', () => {
  // The merge runs only for chats that carry a sessionId — i.e. chats
  // opened from History (--resume). Fresh chats no longer carry one
  // (removed in #39 because --session-id broke claude's scrollback),
  // so they're invisible in History until claude writes their JSONL
  // and loadSessions() picks it up on the next refresh.
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const RESUMED_SESSION = {
    sessionId: 'sess-history-merge-0001',
    filePath: '/var/sessions/sess-history-merge-0001.jsonl',
    projectPath: '/tmp/proj',
    title: 'pre-loaded',
    date: '2026-05-28',
    folderIds: [] as string[],
  };

  it('a chat opened via openChatFromSession appears in filteredSessions immediately', async () => {
    const { chats, history } = await importBoth();
    const chat = chats.openChatFromSession(RESUMED_SESSION, {
      agentId: 'claude-opus-4-8',
      extraFlags: [],
      skipPermissions: false,
    });
    expect(chat!.sessionId).toBe(RESUMED_SESSION.sessionId);

    // Disk is empty; the entry comes purely from the open-chats merger.
    const visible = history.filteredSessions();
    expect(visible.length).toBe(1);
    expect(visible[0]!.sessionId).toBe(RESUMED_SESSION.sessionId);
    // Ephemeral entries have empty filePath until disk picks them up.
    expect(visible[0]!.filePath).toBe('');
  });

  it('disk session wins when both disk and open-chat share a sessionId', async () => {
    const { chats, history } = await importBoth();
    const chat = chats.openChatFromSession(RESUMED_SESSION, {
      agentId: 'claude-opus-4-8',
      extraFlags: [],
      skipPermissions: false,
    })!;
    history.setSessions([
      {
        sessionId: chat.sessionId!,
        filePath: '/jsonl/path.jsonl',
        projectPath: '/tmp/proj',
        title: 'real-on-disk',
        date: '2026-05-28',
        description: 'from disk',
        folderIds: ['folder-1'],
      },
    ]);
    const visible = history.filteredSessions();
    expect(visible.length).toBe(1);
    expect(visible[0]!.title).toBe('real-on-disk');
    expect(visible[0]!.folderIds).toEqual(['folder-1']);
  });

  it('fresh chats (no sessionId) are NOT merged — would need claude to write JSONL first', async () => {
    const { chats, history } = await importBoth();
    chats.openFreshChat({ cwd: '/a', title: 'A' });
    chats.openFreshChat({ cwd: '/b', title: 'B' });
    expect(history.filteredSessions()).toEqual([]);
  });

  it('renaming a resumed chat updates its title in History live', async () => {
    const { chats, history } = await importBoth();
    const chat = chats.openChatFromSession(RESUMED_SESSION, {
      agentId: 'claude-opus-4-8',
      extraFlags: [],
      skipPermissions: false,
    })!;
    chats.renameChat(chat.id, 'renamed');
    expect(history.filteredSessions()[0]!.title).toBe('renamed');
  });

  it('SEARCH finds an on-disk session by its open-tile rename (the "миграция HH" bug)', async () => {
    const { chats, history } = await importBoth();
    // Session exists on disk with its stale first-message title.
    history.setSessions([
      {
        sessionId: RESUMED_SESSION.sessionId,
        filePath: '/jsonl/p.jsonl',
        projectPath: '/tmp/proj',
        title: 'настрой как все в другом хермесе',
        date: '2026-05-28',
        folderIds: [],
      },
    ]);
    // Open the same session and rename the tile to "миграция HH —".
    const chat = chats.openChatFromSession(RESUMED_SESSION, {
      agentId: 'claude-opus-4-8',
      extraFlags: [],
      skipPermissions: false,
    })!;
    chats.renameChat(chat.id, 'миграция HH —');

    // Display reflects the rename.
    expect(history.filteredSessions()[0]!.title).toBe('миграция HH —');

    // Searching "HH" must now find it (previously matched only the
    // stale disk title and missed the rename entirely).
    history.setSearchQuery('HH');
    const hits = history.filteredSessions();
    expect(hits.length).toBe(1);
    expect(hits[0]!.sessionId).toBe(RESUMED_SESSION.sessionId);

    // Case-insensitive too.
    history.setSearchQuery('hh');
    expect(history.filteredSessions().length).toBe(1);

    history.setSearchQuery('');
  });

  it('a NON-renamed open chat does NOT override the fresh disk title', async () => {
    const { chats, history } = await importBoth();
    history.setSessions([
      {
        sessionId: RESUMED_SESSION.sessionId,
        filePath: '/jsonl/p.jsonl',
        projectPath: '/tmp/proj',
        title: 'real-on-disk',
        date: '2026-05-28',
        folderIds: ['f1'],
      },
    ]);
    chats.openChatFromSession(RESUMED_SESSION, {
      agentId: 'claude-opus-4-8',
      extraFlags: [],
      skipPermissions: false,
    });
    // No rename → disk title wins, folderIds preserved.
    const visible = history.filteredSessions();
    expect(visible[0]!.title).toBe('real-on-disk');
    expect(visible[0]!.folderIds).toEqual(['f1']);
  });
});
