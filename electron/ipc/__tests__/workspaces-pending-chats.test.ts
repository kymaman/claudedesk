/**
 * electron/ipc/__tests__/workspaces-pending-chats.test.ts
 *
 * Unit tests for the pending-chat SQLite persistence in workspaces.ts.
 * No Electron, no IPC — imports the functions directly.
 *
 * Why mock better-sqlite3?
 *   The installed better-sqlite3 binary is compiled against Electron's Node
 *   ABI (v143). Vitest runs under plain Node 22 (ABI v127) and cannot load
 *   that .node file. We replace the module with a thin shim built on top of
 *   Node 22's built-in `node:sqlite` (DatabaseSync), which is real SQLite
 *   and handles all the SQL used by workspaces.ts.
 *
 * Isolation strategy:
 *   - All vi.mock() calls are hoisted (survive vi.resetModules).
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code asserts on
   freshly-constructed rows whose existence is verified inline.
 *   - A module-level counter `testRun` increments in beforeEach; the mocks
 *     read it to decide which DB instance to create/return.
 *   - vi.resetModules() in beforeEach flushes workspaces.ts so _db = null,
 *     then dynamic import picks up the mocked better-sqlite3 and paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// ── Shared state read by hoisted mock factories ─────────────────────────────
// A counter that increments before each test — used as a key so each test
// gets a distinct DatabaseSync instance even though they all use ':memory:'.
let _testRun = 0;
// Map from testRun → DatabaseSync, populated by the better-sqlite3 mock.
const _dbs = new Map<number, DatabaseSync>();

// ── Hoisted mocks (survive vi.resetModules) ──────────────────────────────────

// Prevent paths.ts from touching Electron's `app`.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
}));

// Redirect getWorkspacesDbPath to a per-test key.
vi.mock('../paths.js', () => ({
  getWorkspacesDbPath: () => `test-db-${_testRun}`,
  getHomeDir: () => '/tmp',
  getUserDataDir: () => '/tmp',
  getClaudeProjectsDir: () => '/tmp/.claude/projects',
  getAssistantDir: () => '/tmp/assistant',
  getSessionAliasesDbPath: () => '/tmp/session-aliases.db',
}));

// Replace better-sqlite3 with a shim over node:sqlite DatabaseSync.
// Each unique path argument maps to one in-memory DatabaseSync.
vi.mock('better-sqlite3', () => {
  function BetterSqliteShim(path: string) {
    // Reuse the DB for a given path (within the same module lifecycle).
    // We key by the path string, which is 'test-db-<N>'.
    const key = parseInt((path.match(/\d+$/) ?? ['0'])[0], 10);
    let db = _dbs.get(key);
    if (!db) {
      db = new DatabaseSync(':memory:');
      _dbs.set(key, db);
    }
    return {
      exec(sql: string) {
        db!.exec(sql);
      },
      prepare(sql: string) {
        const stmt = db!.prepare(sql);
        return {
          all(...args: unknown[]) {
            const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
            return stmt.all(...(params as Parameters<typeof stmt.all>));
          },
          run(...args: unknown[]) {
            const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
            return stmt.run(...(params as Parameters<typeof stmt.run>));
          },
          get(...args: unknown[]) {
            const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
            return stmt.get(...(params as Parameters<typeof stmt.get>));
          },
        };
      },
    };
  }
  return { default: BetterSqliteShim };
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe('pending chat persistence', () => {
  let createProject: (args: { name: string; color?: string }) => { id: string; name: string };
  let deleteProject: (args: { id: string }) => void;
  let addPendingChat: (args: {
    id: string;
    projectId: string;
    cwd: string;
    agentId: string;
    title: string;
    extraFlags?: string[];
    skipPermissions?: boolean;
  }) => void;
  let listPendingChats: (projectId: string) => Array<{
    id: string;
    projectId: string;
    cwd: string;
    agentId: string;
    title: string;
    extraFlags: string[];
    skipPermissions: boolean;
    createdAt: number;
  }>;
  let removePendingChat: (id: string) => void;

  beforeEach(async () => {
    _testRun++;
    // Reset module cache so workspaces.ts starts with _db = null.
    vi.resetModules();
    const mod = await import('../workspaces.js');
    createProject = mod.createProject;
    deleteProject = mod.deleteProject;
    addPendingChat = mod.addPendingChat;
    listPendingChats = mod.listPendingChats;
    removePendingChat = mod.removePendingChat;
  });

  afterEach(() => {
    // Drop the DatabaseSync for this test run so the next test is clean.
    const db = _dbs.get(_testRun);
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      _dbs.delete(_testRun);
    }
  });

  it('addPendingChat → listPendingChats returns the persisted row with all fields', () => {
    const project = createProject({ name: 'test-add' });

    addPendingChat({
      id: 'chat-uuid-1',
      projectId: project.id,
      cwd: 'D:/some/path',
      agentId: 'claude-opus-4-7',
      title: 'My pending',
      extraFlags: ['--model=opus'],
      skipPermissions: true,
    });

    const rows = listPendingChats(project.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('chat-uuid-1');
    expect(rows[0].cwd).toBe('D:/some/path');
    expect(rows[0].agentId).toBe('claude-opus-4-7');
    expect(rows[0].title).toBe('My pending');
    expect(rows[0].extraFlags).toEqual(['--model=opus']);
    expect(rows[0].skipPermissions).toBe(true);
  });

  it('removePendingChat drops the row but leaves siblings', () => {
    const project = createProject({ name: 'test-remove' });

    for (const id of ['p1', 'p2', 'p3']) {
      addPendingChat({
        id,
        projectId: project.id,
        cwd: '/tmp',
        agentId: 'claude-opus-4-7',
        title: id,
      });
    }

    removePendingChat('p2');

    const rows = listPendingChats(project.id);
    expect(rows.map((r) => r.id).sort()).toEqual(['p1', 'p3']);
  });

  it('deleteProject cascades — every pending row for that project disappears', () => {
    const project = createProject({ name: 'test-cascade' });

    addPendingChat({
      id: 'cascade-1',
      projectId: project.id,
      cwd: '/tmp',
      agentId: 'claude-opus-4-7',
      title: 'doomed',
    });

    deleteProject({ id: project.id });

    const rows = listPendingChats(project.id);
    expect(rows).toHaveLength(0);
  });
});
