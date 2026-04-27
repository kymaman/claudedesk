/**
 * workspaces.ts
 * "Projects" in the UI — a dedicated workspace concept separate from the
 * existing tag-like Folders. One chat belongs to at most one project
 * (1:1 mapping), and clicking a project is meant to re-open every chat
 * assigned to it at once. Backed by SQLite next to the sessions DB.
 *
 * Called "workspaces" in code only to avoid colliding with the
 * parallel-code `projects` store (that one tracks git-worktree targets).
 * Every user-facing string says "Project".
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getWorkspacesDbPath } from '../paths.js';

export interface Project {
  id: string;
  name: string;
  color?: string;
  position: number;
  createdAt: number;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(getWorkspacesDbPath());
  _db.exec(`
    CREATE TABLE IF NOT EXISTS chat_projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_project_map (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      added_at   INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES chat_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_project_project
      ON session_project_map(project_id);

    -- "Pending" chats — fresh chats started inside a project that haven't
    -- yet produced a Claude session JSONL on disk. We persist enough
    -- intent (cwd, agent, title) to recreate them when the user re-opens
    -- the project after an app restart. Once a chat's sessionId becomes
    -- known, we move it to session_project_map and delete the pending row.
    CREATE TABLE IF NOT EXISTS project_pending_chats (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      title      TEXT NOT NULL,
      flags_json TEXT NOT NULL DEFAULT '[]',
      skip_perms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES chat_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pending_project ON project_pending_chats(project_id);
  `);
  return _db;
}

export interface PendingChat {
  id: string;
  projectId: string;
  cwd: string;
  agentId: string;
  title: string;
  extraFlags: string[];
  skipPermissions: boolean;
  createdAt: number;
}

export function listPendingChats(projectId: string): PendingChat[] {
  const db = getDb();
  const rows = db
    .prepare<
      [string],
      {
        id: string;
        project_id: string;
        cwd: string;
        agent_id: string;
        title: string;
        flags_json: string;
        skip_perms: number;
        created_at: number;
      }
    >(
      'SELECT id, project_id, cwd, agent_id, title, flags_json, skip_perms, created_at FROM project_pending_chats WHERE project_id = ? ORDER BY created_at ASC',
    )
    .all(projectId);
  return rows.map((r) => {
    let flags: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.flags_json);
      if (Array.isArray(parsed)) flags = parsed.filter((f): f is string => typeof f === 'string');
    } catch {
      /* keep empty */
    }
    return {
      id: r.id,
      projectId: r.project_id,
      cwd: r.cwd,
      agentId: r.agent_id,
      title: r.title,
      extraFlags: flags,
      skipPermissions: r.skip_perms === 1,
      createdAt: r.created_at,
    };
  });
}

export function addPendingChat(args: {
  id: string;
  projectId: string;
  cwd: string;
  agentId: string;
  title: string;
  extraFlags?: string[];
  skipPermissions?: boolean;
}): void {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO project_pending_chats (id, project_id, cwd, agent_id, title, flags_json, skip_perms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    args.id,
    args.projectId,
    args.cwd,
    args.agentId,
    args.title,
    JSON.stringify(args.extraFlags ?? []),
    args.skipPermissions ? 1 : 0,
    Date.now(),
  );
}

export function removePendingChat(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM project_pending_chats WHERE id = ?').run(id);
}

export function listProjects(): Project[] {
  const db = getDb();
  const rows = db
    .prepare<
      [],
      { id: string; name: string; color: string | null; position: number; created_at: number }
    >('SELECT id, name, color, position, created_at FROM chat_projects ORDER BY position ASC, name ASC')
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    createdAt: r.created_at,
    ...(r.color ? { color: r.color } : {}),
  }));
}

export function createProject(args: { name: string; color?: string }): Project {
  const db = getDb();
  const name = args.name.trim() || 'Untitled project';
  const id = randomUUID();
  const maxPos =
    db
      .prepare<[], { maxPos: number | null }>('SELECT MAX(position) as maxPos FROM chat_projects')
      .get()?.maxPos ?? -1;
  const position = (maxPos ?? -1) + 1;
  const color = (args.color ?? '').trim() || null;
  const createdAt = Date.now();
  db.prepare(
    'INSERT INTO chat_projects (id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, name, color, position, createdAt);
  return { id, name, position, createdAt, ...(color ? { color } : {}) };
}

export function renameProject(args: { id: string; name: string }): void {
  const db = getDb();
  const name = args.name.trim();
  if (!name) return;
  db.prepare('UPDATE chat_projects SET name = ? WHERE id = ?').run(name, args.id);
}

export function deleteProject(args: { id: string }): void {
  const db = getDb();
  // FK ON DELETE CASCADE drops memberships.
  db.prepare('DELETE FROM chat_projects WHERE id = ?').run(args.id);
}

/**
 * Assign a session to a project (1:1 replacement) or clear assignment
 * when `projectId` is null.
 */
export function assignSessionToProject(args: {
  sessionId: string;
  projectId: string | null;
}): void {
  const db = getDb();
  if (args.projectId === null) {
    db.prepare('DELETE FROM session_project_map WHERE session_id = ?').run(args.sessionId);
    return;
  }
  db.prepare(
    'INSERT OR REPLACE INTO session_project_map (session_id, project_id, added_at) VALUES (?, ?, ?)',
  ).run(args.sessionId, args.projectId, Date.now());
}

/** Returns the session ids that belong to the given project, in insertion order. */
export function listSessionsInProject(projectId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare<
      [string],
      { session_id: string }
    >('SELECT session_id FROM session_project_map WHERE project_id = ? ORDER BY added_at ASC')
    .all(projectId);
  return rows.map((r) => r.session_id);
}

/** Returns a map `{ sessionId → projectId }` for every session that has an assignment. */
export function listSessionProjectMap(): Record<string, string> {
  const db = getDb();
  const rows = db
    .prepare<
      [],
      { session_id: string; project_id: string }
    >('SELECT session_id, project_id FROM session_project_map')
    .all();
  const out: Record<string, string> = {};
  for (const r of rows) out[r.session_id] = r.project_id;
  return out;
}
