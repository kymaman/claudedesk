/**
 * open-project-dedup.test.ts
 *
 * Pins the duplication fix the user reported: "I keep clicking between
 * projects, my chats duplicate." Two failure modes had to be covered:
 *
 *   1. Click-to-open re-runs `openProject()` every time, so the dedup
 *      checks must hold across N consecutive calls — never a second tile
 *      for the same chat.
 *
 *   2. A pending chat that gets successfully resumed gets a brand-new
 *      chat UUID, but the row in `project_pending_chats` still carried
 *      the original id. The previous version dedup-by-id missed on the
 *      second pass and respawned. Fix: drop the pending row at resume
 *      time and write a session→project map row instead — so the next
 *      pass sees nothing to do.
 *
 * These tests stub IPC so we can drive `openProject` end-to-end without
 * standing up Electron.
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

// IPC mock — backs the in-memory pending DB and session→project map.
interface PendingRow {
  id: string;
  projectId: string;
  cwd: string;
  agentId: string;
  title: string;
  extraFlags: string[];
  skipPermissions: boolean;
  createdAt: number;
}
const pendingDb = new Map<string, PendingRow>();
const sessionProjectMap = new Map<string, string>();
const ipcCalls: Array<{ ch: string; args: unknown }> = [];

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string, args?: unknown) => {
    ipcCalls.push({ ch: channel, args });
    if (channel === 'list_projects_ws') return [];
    if (channel === 'list_session_project_map') {
      return Object.fromEntries(sessionProjectMap.entries());
    }
    if (channel === 'list_pending_chats') {
      const projectId = (args as { projectId: string }).projectId;
      return Array.from(pendingDb.values()).filter((p) => p.projectId === projectId);
    }
    if (channel === 'add_pending_chat') {
      const row = args as PendingRow;
      pendingDb.set(row.id, row);
      return undefined;
    }
    if (channel === 'remove_pending_chat') {
      pendingDb.delete((args as { id: string }).id);
      return undefined;
    }
    if (channel === 'assign_session_to_project') {
      const a = args as { sessionId: string; projectId: string | null };
      if (a.projectId === null) sessionProjectMap.delete(a.sessionId);
      else sessionProjectMap.set(a.sessionId, a.projectId);
      return undefined;
    }
    return undefined;
  }),
}));

// Stub session list source — openProject calls loadSessions, which we
// fake by pre-populating the sessions signal.
let sessionFixtures: Array<{
  sessionId: string;
  projectPath: string;
  date: string;
  title: string;
  filePath: string;
  folderIds: string[];
}> = [];
vi.mock('./sessions-history', () => {
  // The store import below triggers `createRoot` synchronously, so we
  // build a real signal here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRoot, createSignal } = require('solid-js');
  const [list, setList] = createRoot(() => createSignal(sessionFixtures));
  return {
    sessions: list,
    loadSessions: async () => setList([...sessionFixtures]),
  };
});

vi.mock('./launch-settings', () => ({
  loadLaunchSettings: vi.fn(async () => null),
}));

async function loadStore() {
  vi.resetModules();
  ipcCalls.length = 0;
  pendingDb.clear();
  sessionProjectMap.clear();
  const cp = await import('./chat-projects');
  const chats = await import('./chats');
  return { ...cp, ...chats };
}

describe('openProject — pending → session promotion', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionFixtures = [];
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('drops the pending row and writes a session map row when a match resumes', async () => {
    const { openProject } = await loadStore();
    const projectId = 'p1';
    pendingDb.set('U1', {
      id: 'U1',
      projectId,
      cwd: '/tmp/proj',
      agentId: 'claude-opus-4-7',
      title: 'fresh',
      extraFlags: [],
      skipPermissions: false,
      createdAt: 1000,
    });
    sessionFixtures = [
      {
        sessionId: 'S1',
        projectPath: '/tmp/proj',
        date: new Date(2000).toISOString(),
        title: 'matched',
        filePath: '/tmp/file.jsonl',
        folderIds: [],
      },
    ];

    await openProject(projectId);

    expect(pendingDb.has('U1')).toBe(false);
    expect(sessionProjectMap.get('S1')).toBe(projectId);
  });

  it('does NOT duplicate the chat tile when openProject is called repeatedly', async () => {
    const { openProject, openChatsInProject } = await loadStore();
    const projectId = 'p1';
    pendingDb.set('U1', {
      id: 'U1',
      projectId,
      cwd: '/tmp/proj',
      agentId: 'claude-opus-4-7',
      title: 'fresh',
      extraFlags: [],
      skipPermissions: false,
      createdAt: 1000,
    });
    sessionFixtures = [
      {
        sessionId: 'S1',
        projectPath: '/tmp/proj',
        date: new Date(2000).toISOString(),
        title: 'matched',
        filePath: '/tmp/file.jsonl',
        folderIds: [],
      },
    ];

    await openProject(projectId);
    expect(openChatsInProject(projectId)).toHaveLength(1);

    // Simulate user clicking project A → B → A again. The chat tile is
    // still alive (we model that by NOT closing it). openProject must
    // be a no-op for the already-resumed session.
    await openProject(projectId);
    await openProject(projectId);

    expect(openChatsInProject(projectId)).toHaveLength(1);
  });

  it('does NOT respawn a chat that was already resumed via session→project map', async () => {
    const { openProject, openChatsInProject, loadProjects } = await loadStore();
    const projectId = 'p1';
    sessionProjectMap.set('S1', projectId);
    sessionFixtures = [
      {
        sessionId: 'S1',
        projectPath: '/tmp/proj',
        date: new Date(2000).toISOString(),
        title: 'mapped',
        filePath: '/tmp/file.jsonl',
        folderIds: [],
      },
    ];
    // Project mount loads the session→project map into memory once.
    await loadProjects();

    await openProject(projectId);
    expect(openChatsInProject(projectId)).toHaveLength(1);

    // Click again — same project, no new tile.
    await openProject(projectId);
    expect(openChatsInProject(projectId)).toHaveLength(1);
  });

  it('multiple pendings line up with multiple matches and none duplicate on a second pass', async () => {
    const { openProject, openChatsInProject } = await loadStore();
    const projectId = 'p1';
    pendingDb.set('U1', {
      id: 'U1',
      projectId,
      cwd: '/tmp/proj',
      agentId: 'claude-opus-4-7',
      title: 'first',
      extraFlags: [],
      skipPermissions: false,
      createdAt: 1000,
    });
    pendingDb.set('U2', {
      id: 'U2',
      projectId,
      cwd: '/tmp/proj',
      agentId: 'claude-opus-4-7',
      title: 'second',
      extraFlags: [],
      skipPermissions: false,
      createdAt: 1100,
    });
    sessionFixtures = [
      {
        sessionId: 'S1',
        projectPath: '/tmp/proj',
        date: new Date(1500).toISOString(),
        title: 's1',
        filePath: '/tmp/s1.jsonl',
        folderIds: [],
      },
      {
        sessionId: 'S2',
        projectPath: '/tmp/proj',
        date: new Date(1600).toISOString(),
        title: 's2',
        filePath: '/tmp/s2.jsonl',
        folderIds: [],
      },
    ];

    await openProject(projectId);
    expect(openChatsInProject(projectId)).toHaveLength(2);
    expect(pendingDb.size).toBe(0);
    expect(sessionProjectMap.get('S1')).toBe(projectId);
    expect(sessionProjectMap.get('S2')).toBe(projectId);

    await openProject(projectId);
    expect(openChatsInProject(projectId)).toHaveLength(2);
  });

  it('falls back to a fresh chat when no on-disk session matches the pending', async () => {
    const { openProject, openChatsInProject } = await loadStore();
    const projectId = 'p1';
    pendingDb.set('U1', {
      id: 'U1',
      projectId,
      cwd: '/tmp/proj',
      agentId: 'claude-opus-4-7',
      title: 'orphan',
      extraFlags: [],
      skipPermissions: false,
      createdAt: 1000,
    });
    sessionFixtures = []; // no matches

    await openProject(projectId);
    expect(openChatsInProject(projectId)).toHaveLength(1);
    // pending stays — the chat is still "fresh", waiting for a JSONL.
    expect(pendingDb.has('U1')).toBe(true);
  });

  it('repeated openProject with NO matching session does NOT duplicate the fresh chat', async () => {
    // Reproduces the user-reported "switching projects keeps duplicating my
    // chat" bug. The fresh-fallback path used to spawn a chat with a brand-
    // new UUID, so the pending.id dedup check missed on every subsequent
    // pass and another fresh chat appeared. Fix: pass `id: p.id` to
    // openFreshChat so the chat reuses the pending id.
    const { openProject, openChatsInProject } = await loadStore();
    const projectId = 'p1';
    pendingDb.set('U1', {
      id: 'U1',
      projectId,
      cwd: '/tmp/proj',
      agentId: 'claude-opus-4-7',
      title: 'fresh-no-jsonl-yet',
      extraFlags: [],
      skipPermissions: false,
      createdAt: 1000,
    });
    sessionFixtures = []; // no JSONL on disk → fresh-fallback path

    await openProject(projectId);
    expect(openChatsInProject(projectId)).toHaveLength(1);
    const firstChatId = openChatsInProject(projectId)[0].id;
    // The fresh-fallback chat MUST take the pending row's id.
    expect(firstChatId).toBe('U1');

    // Hammer the same project — what users do clicking around between
    // projects. Should be idempotent.
    await openProject(projectId);
    await openProject(projectId);
    await openProject(projectId);
    expect(openChatsInProject(projectId)).toHaveLength(1);
  });
});
