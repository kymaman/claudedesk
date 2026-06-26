/**
 * branch-restart-no-glue.test.ts
 *
 * Restore-path guarantee for the "сделал бранч, перезапустил приложение, и в
 * обе плитки подгрузился один и тот же старый чат" bug.
 *
 * A branch tile starts life sharing the parent's session id; watchLiveSession
 * splits them onto distinct live sessions over the following minutes. If the
 * app is restarted BEFORE that split, the parent and the branch persist with
 * the same session id. On restore a plain `--resume` of the branch would dedup
 * onto the restored parent tile (merging/gluing the two). restoreOpenChats
 * must instead RE-FORK such a branch so it comes back as a separate dialog and
 * watchLiveSession can split it.
 *
 * window is intentionally left undefined so watchLiveSession (gated on
 * `typeof window`) is a no-op — this isolates the restore DECISION (re-fork vs
 * resume) from the live-split machinery, which branch-no-glue.test.ts covers.
 */

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

const PERSIST_KEY = 'claudedesk.openChats';

interface SeedChat {
  id: string;
  sessionId: string;
  gridIndex: number;
  forkParent?: { sessionId: string; title: string };
}

function seed(chats: SeedChat[]): void {
  const list = chats.map((c) => ({
    id: c.id,
    sessionId: c.sessionId,
    title: c.id,
    cwd: '/tmp/proj',
    agentDefId: 'claude-opus-4-7',
    extraFlags: [] as string[],
    skipPermissions: false,
    lastActiveAt: 1000 + c.gridIndex,
    createdAt: 1000 + c.gridIndex,
    gridIndex: c.gridIndex,
    ...(c.forkParent ? { forkParent: c.forkParent } : {}),
  }));
  localStorage.setItem(PERSIST_KEY, JSON.stringify(list));
}

describe('restoreOpenChats — branch + restart never glues two tiles', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('re-forks a branch whose persisted id collides with the parent (glue already started)', async () => {
    // Parent and branch BOTH advanced onto the same continuation S1 before the
    // restart (the glue had begun). forkParent still points at the original
    // fork origin S0, so the simple `sessionId === forkParent.sessionId` test
    // does NOT catch it — only the sibling-collision check does.
    seed([
      { id: 'parent', sessionId: 'S1', gridIndex: 0 },
      { id: 'branch', sessionId: 'S1', gridIndex: 1, forkParent: { sessionId: 'S0', title: 'P' } },
    ]);
    const { restoreOpenChats, openChats, RESTORE_STAGGER_MS } = await importChats();

    restoreOpenChats();
    vi.advanceTimersByTime(RESTORE_STAGGER_MS);

    const all = openChats();
    // Two separate tiles — the branch did NOT merge onto the parent.
    expect(all.length).toBe(2);
    const branch = all.find((c) => c.forkParent);
    const parent = all.find((c) => !c.forkParent);
    expect(branch).toBeTruthy();
    expect(parent).toBeTruthy();
    // The branch was re-forked, not plain-resumed.
    expect(branch?.args).toContain('--fork-session');
    // The parent is a plain resume.
    expect(parent?.args).not.toContain('--fork-session');
  });

  it('re-forks an undiverged branch sharing the parent id verbatim (regression guard)', async () => {
    seed([
      { id: 'parent', sessionId: 'S0', gridIndex: 0 },
      { id: 'branch', sessionId: 'S0', gridIndex: 1, forkParent: { sessionId: 'S0', title: 'P' } },
    ]);
    const { restoreOpenChats, openChats, RESTORE_STAGGER_MS } = await importChats();

    restoreOpenChats();
    vi.advanceTimersByTime(RESTORE_STAGGER_MS);

    const all = openChats();
    expect(all.length).toBe(2);
    const branch = all.find((c) => c.forkParent);
    expect(branch?.args).toContain('--fork-session');
  });

  it('does not re-fork a plain (non-fork) tile that happens to share an id', async () => {
    // Two non-fork tiles with the same id should dedup to ONE (the existing
    // openChatFromSession behaviour) — we must not turn this into a spurious
    // fork. Only tiles carrying forkParent get the re-fork treatment.
    seed([
      { id: 'a', sessionId: 'S9', gridIndex: 0 },
      { id: 'b', sessionId: 'S9', gridIndex: 1 },
    ]);
    const { restoreOpenChats, openChats, RESTORE_STAGGER_MS } = await importChats();

    restoreOpenChats();
    vi.advanceTimersByTime(RESTORE_STAGGER_MS);

    const all = openChats();
    expect(all.length).toBe(1); // deduped, not forked
    expect(all[0]?.args).not.toContain('--fork-session');
  });
});
