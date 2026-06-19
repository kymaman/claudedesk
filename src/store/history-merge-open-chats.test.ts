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

  it('opening an OLD disk session bumps it to the top of "newest" IMMEDIATELY (no refresh)', async () => {
    const { chats, history } = await importBoth();
    const oldSession = {
      sessionId: 'old-one',
      filePath: '/j/o.jsonl',
      projectPath: '/tmp/b',
      title: 'старая сессия',
      date: '2026-01-05',
      folderIds: [] as string[],
    };
    history.setSessions([
      {
        sessionId: 'newer',
        filePath: '/j/n.jsonl',
        projectPath: '/tmp/a',
        title: 'newer',
        date: '2026-06-09',
        folderIds: [],
      },
      oldSession,
    ]);
    // Sanity: before opening, the newer disk session is first.
    expect(history.filteredSessions()[0]!.sessionId).toBe('newer');

    chats.openChatFromSession(oldSession, {
      agentId: 'claude-opus-4-8',
      extraFlags: [],
      skipPermissions: false,
    });

    // The open bump must reorder IN THE MOMENT — no loadSessions(), no
    // app restart. createdAt(now) > '2026-06-09' lexicographically.
    const visible = history.filteredSessions();
    expect(visible[0]!.sessionId).toBe('old-one');
    // Title and the rest of the disk entry are untouched by the bump.
    expect(visible[0]!.title).toBe('старая сессия');
    expect(visible[0]!.filePath).toBe('/j/o.jsonl');
  });

  it('the open bump only moves time FORWARD — never sinks a future-dated session', async () => {
    const { chats, history } = await importBoth();
    const future = {
      sessionId: 'future',
      filePath: '/j/f.jsonl',
      projectPath: '/tmp/f',
      title: 'future',
      date: '2099-12-31',
      folderIds: [] as string[],
    };
    history.setSessions([future]);
    chats.openChatFromSession(future, {
      agentId: 'claude-opus-4-8',
      extraFlags: [],
      skipPermissions: false,
    });
    // openedAt(2026-…) < '2099-12-31' → the original date must survive.
    expect(history.filteredSessions()[0]!.date).toBe('2099-12-31');
  });

  // 🔒 ЭТАЛОН (docs/wiki/title-parity-canonical.md): the tile header title
  // (titleFor) and the History row title for the SAME session must be equal —
  // both in the plain disk-title case AND when the tile carries an AI-title /
  // manual rename override. App.tsx's effect feeds the disk title into chats'
  // _diskTitles map; we replicate that here (the effect doesn't run in this
  // unit env) so the assertion mirrors the real render path.
  it('PARITY: titleFor(tile) equals the History row title — disk tier AND override tier', async () => {
    const { chats, history } = await importBoth();
    const DISK_TITLE = 'Автономный цикл откликов на вакансии hh.ru';
    history.setSessions([
      {
        sessionId: RESUMED_SESSION.sessionId,
        filePath: '/jsonl/p.jsonl',
        projectPath: '/tmp/proj',
        title: DISK_TITLE,
        date: '2026-05-28',
        folderIds: [],
      },
    ]);
    const chat = chats.openChatFromSession(RESUMED_SESSION, {
      agentId: 'claude-opus-4-8',
      extraFlags: [],
      skipPermissions: false,
    })!;
    // Replicate App.tsx's sessions()→setDiskTitleForChat sync.
    chats.setDiskTitleForChat(chat.id, DISK_TITLE);
    const rowTitle = () =>
      history.filteredSessions().find((s) => s.sessionId === RESUMED_SESSION.sessionId)!.title;

    // Disk tier: tile and History both show the disk title — NO divergence.
    expect(chats.titleFor(chat)).toBe(DISK_TITLE);
    expect(chats.titleFor(chat)).toBe(rowTitle());

    // Override tier (AI-title / manual rename): both show the override.
    chats.renameChat(chat.id, 'миграция HH');
    expect(chats.titleFor(chat)).toBe('миграция HH');
    expect(chats.titleFor(chat)).toBe(rowTitle());
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
