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

describe('bug #35 — History shows freshly-opened chats without refresh', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('filteredSessions includes open chats not yet on disk', async () => {
    const { chats, history } = await importBoth();
    // Disk is empty; only an in-memory chat exists.
    const chat = chats.openFreshChat({ cwd: '/tmp/proj', title: 'just-opened' });
    expect(chat!.sessionId).toBeTruthy();

    const visible = history.filteredSessions();
    expect(visible.length).toBe(1);
    expect(visible[0]!.sessionId).toBe(chat!.sessionId);
    expect(visible[0]!.title).toBe('just-opened');
    // Ephemeral entries have no filePath until the JSONL is written.
    expect(visible[0]!.filePath).toBe('');
  });

  it('disk session wins when both disk and open-chat have the same sessionId', async () => {
    const { chats, history } = await importBoth();
    const chat = chats.openFreshChat({ cwd: '/tmp/proj', title: 'in-memory-title' })!;
    // Simulate loadSessions() landing — claude wrote a JSONL with the same
    // sessionId, plus metadata (folderIds, description) that ephemeral has not.
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
    expect(visible[0]!.filePath).toBe('/jsonl/path.jsonl');
    expect(visible[0]!.folderIds).toEqual(['folder-1']);
  });

  it('multiple open chats with no disk sessions all appear', async () => {
    const { chats, history } = await importBoth();
    chats.openFreshChat({ cwd: '/a', title: 'A' });
    chats.openFreshChat({ cwd: '/b', title: 'B' });
    chats.openFreshChat({ cwd: '/c', title: 'C' });
    const titles = history
      .filteredSessions()
      .map((s) => s.title)
      .sort();
    expect(titles).toEqual(['A', 'B', 'C']);
  });

  it('open chat with no sessionId (non-claude agent) is NOT merged', async () => {
    const { chats, history } = await importBoth();
    chats.openFreshChat({ cwd: '/x', agentId: 'codex', title: 'codex-chat' });
    expect(history.filteredSessions()).toEqual([]);
  });

  it('renaming an open chat updates its title in History live', async () => {
    const { chats, history } = await importBoth();
    const chat = chats.openFreshChat({ cwd: '/tmp/proj', title: 'before' })!;
    chats.renameChat(chat.id, 'after');
    const visible = history.filteredSessions();
    expect(visible[0]!.title).toBe('after');
  });
});
