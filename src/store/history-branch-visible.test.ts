/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code asserts on
   freshly-constructed chats whose existence is verified inline. */
/**
 * history-branch-visible.test.ts
 *
 * The user branched a dialog and (a) couldn't see the branch in the left
 * History list without reopening, and (b) the branch was gone after a
 * restart (2026-06-15).
 *
 * Root cause: a fresh branch shares its PARENT's sessionId until claude
 * writes the fork's own JSONL (on the first turn). So:
 *   - filteredSessions() keys rows by sessionId → the branch collapses
 *     onto the parent row and is invisible.
 *   - restoreOpenChats() --resumes that shared id → openChatFromSession
 *     dedup focuses the parent tile and the branch tile is dropped.
 *
 * Both must be fixed: the branch needs its OWN History row immediately,
 * and it must survive a restart as a SEPARATE forked dialog.
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
    ],
  },
}));

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

const PARENT = {
  sessionId: 'parent-sess-0001',
  filePath: '/jsonl/parent.jsonl',
  projectPath: '/tmp/openclaw',
  title: 'openclaw skills',
  date: '2026-06-14',
  folderIds: [] as string[],
};

const SETTINGS = { agentId: 'claude-opus-4-8', extraFlags: [], skipPermissions: false };

describe('branch shows in History immediately + survives restart', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('a freshly-branched tile gets its OWN History row (not collapsed onto the parent)', async () => {
    const { chats, history } = await importBoth();
    history.setSessions([PARENT]);

    const branch = chats.branchChatFromSession(PARENT, SETTINGS);
    expect(branch).not.toBeNull();
    // Undiverged: still carries the parent's session id.
    expect(branch!.sessionId).toBe(PARENT.sessionId);

    const rows = history.filteredSessions();
    // Parent row + a SEPARATE branch row.
    expect(rows.length).toBe(2);

    const branchRow = rows.find((r) => r.sessionId !== PARENT.sessionId);
    expect(branchRow, 'branch must have its own row').toBeTruthy();
    // Tagged so a click focuses the open tile instead of --resuming a
    // session that does not exist on disk yet.
    expect(branchRow!.openChatId).toBe(branch!.id);
    // Lineage badge points at the parent.
    expect(branchRow!.branchParentId).toBe(PARENT.sessionId);
  });

  it('the branch row carries the branch title (so the user recognises it)', async () => {
    const { chats, history } = await importBoth();
    history.setSessions([PARENT]);
    const branch = chats.branchChatFromSession(PARENT, SETTINGS)!;
    const branchRow = history.filteredSessions().find((r) => r.openChatId === branch.id);
    expect(branchRow!.title).toMatch(/branch/);
  });

  it('restoreOpenChats brings the branch back as a SEPARATE forked dialog', async () => {
    const { chats } = await importBoth();
    // Simulate the previous session's persisted snapshot: parent tile +
    // an undiverged branch (sessionId === forkParent.sessionId).
    const snapshot = [
      {
        id: 'chat-parent',
        sessionId: PARENT.sessionId,
        title: PARENT.title,
        cwd: PARENT.projectPath,
        agentDefId: 'claude-opus-4-8',
        extraFlags: [],
        skipPermissions: false,
        lastActiveAt: 1000,
        createdAt: 1000,
        gridIndex: 0,
      },
      {
        id: 'chat-branch',
        sessionId: PARENT.sessionId, // undiverged — same as parent
        title: 'openclaw skills • branch 12:00',
        cwd: PARENT.projectPath,
        agentDefId: 'claude-opus-4-8',
        extraFlags: [],
        skipPermissions: false,
        lastActiveAt: 2000,
        createdAt: 2000,
        gridIndex: 1,
        forkParent: { sessionId: PARENT.sessionId, title: PARENT.title },
      },
    ];
    localStorage.setItem('claudedesk.openChats', JSON.stringify(snapshot));

    // staggerMs:0 schedules the 2nd tile in the same tick (still async);
    // drain a few macrotasks so it spawns before we assert.
    chats.restoreOpenChats({ staggerMs: 0 });
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

    const open = chats.openChats();
    // BOTH the parent and the branch must come back — not collapsed to one.
    expect(open.length).toBe(2);
    const restoredBranch = open.find((c) => c.forkParent);
    expect(restoredBranch, 'branch tile must be restored').toBeTruthy();
    expect(restoredBranch!.forkParent!.sessionId).toBe(PARENT.sessionId);
    // It re-forks from the parent, so its spawn args keep --fork-session.
    expect(restoredBranch!.args).toContain('--fork-session');
  });
});
