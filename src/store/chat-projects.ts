/* eslint-disable solid/reactivity -- createRoot(() => createSignal(...)) is an intentional HMR-safe pattern. */
/**
 * chat-projects.ts
 * Projects = user-defined workspaces that own a set of chat sessions.
 * One session belongs to at most one project (1:1). Opening a project
 * closes any current non-project chats and resumes all of its members.
 *
 * Named with the "chat-" prefix to avoid colliding with the pre-existing
 * parallel-code `projects` store (that one is for git worktrees).
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { sessions, loadSessions } from './sessions-history';
import { openChatFromSession, openChats, closeChat } from './chats';
import { loadLaunchSettings } from './launch-settings';

export interface Project {
  id: string;
  name: string;
  color?: string;
  position: number;
  createdAt: number;
}

type Sig<T> = [Accessor<T>, Setter<T>];

const [_projects, _setProjects] = createRoot<Sig<Project[]>>(() => createSignal<Project[]>([]));
const [_activeId, _setActiveId] = createRoot<Sig<string | null>>(() =>
  createSignal<string | null>(loadActivePersisted()),
);
const [_sessionMap, _setSessionMap] = createRoot<Sig<Record<string, string>>>(() =>
  createSignal<Record<string, string>>({}),
);

export const projects = _projects;
export const activeProjectId = _activeId;
export const sessionProjectMap = _sessionMap;

const ACTIVE_KEY = 'claudedesk.activeProjectId';

function loadActivePersisted(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY) || null;
  } catch {
    return null;
  }
}

export function setActiveProjectId(id: string | null): void {
  _setActiveId(id);
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export async function loadProjects(): Promise<void> {
  try {
    const [list, map] = await Promise.all([
      invoke<Project[]>(IPC.ListProjects, {}),
      invoke<Record<string, string>>(IPC.ListSessionProjectMap, {}),
    ]);
    _setProjects(list);
    _setSessionMap(map);
  } catch (err) {
    console.warn('[chat-projects] load failed:', err);
  }
}

export async function createProject(name: string, color?: string): Promise<Project | null> {
  try {
    const p = await invoke<Project>(IPC.CreateProject, { name, color });
    _setProjects((prev) => [...prev, p]);
    return p;
  } catch (err) {
    console.warn('[chat-projects] create failed:', err);
    return null;
  }
}

export async function renameProject(id: string, name: string): Promise<void> {
  await invoke<undefined>(IPC.RenameProject, { id, name });
  _setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
}

export async function deleteProject(id: string): Promise<void> {
  await invoke<undefined>(IPC.DeleteProject, { id });
  _setProjects((prev) => prev.filter((p) => p.id !== id));
  // Drop cached memberships for that project
  _setSessionMap((prev) => {
    const next: Record<string, string> = {};
    for (const [sid, pid] of Object.entries(prev)) if (pid !== id) next[sid] = pid;
    return next;
  });
  if (_activeId() === id) setActiveProjectId(null);
}

export async function assignSessionToProject(
  sessionId: string,
  projectId: string | null,
): Promise<void> {
  await invoke<undefined>(IPC.AssignSessionToProject, { sessionId, projectId });
  _setSessionMap((prev) => {
    const next = { ...prev };
    if (projectId === null) delete next[sessionId];
    else next[sessionId] = projectId;
    return next;
  });
}

export function sessionIdsInProject(projectId: string): string[] {
  const map = _sessionMap();
  const out: string[] = [];
  for (const [sid, pid] of Object.entries(map)) if (pid === projectId) out.push(sid);
  return out;
}

/**
 * Open a project: close every currently-open chat and resume every session
 * assigned to the given project. Keeps the session list loaded fresh.
 */
export async function openProject(projectId: string): Promise<void> {
  setActiveProjectId(projectId);
  // Close everything that's open right now. The workspace becomes "the only
  // thing on screen".
  for (const c of openChats()) closeChat(c.id);
  // Make sure we have the current session list to resume from.
  if (sessions().length === 0) await loadSessions();
  const ids = new Set(sessionIdsInProject(projectId));
  if (ids.size === 0) return;
  const items = sessions().filter((s) => ids.has(s.sessionId));
  // Launch settings are per-session, so pull them in parallel.
  await Promise.all(
    items.map(async (s) => {
      const saved = await loadLaunchSettings(s.sessionId);
      openChatFromSession(
        s,
        saved ?? { agentId: 'claude-opus-4-7', extraFlags: [], skipPermissions: false },
      );
    }),
  );
}

/** Close the current project (chats stay open; user just leaves workspace mode). */
export function leaveProject(): void {
  setActiveProjectId(null);
}
