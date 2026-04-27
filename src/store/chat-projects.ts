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
import { openChatFromSession, openChatsInProject, openFreshChat } from './chats';
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
 * Open a project. Project-scoped chats stay running across switches —
 * we only flip the activeProjectId signal, which the UI uses to filter
 * which open chats are visible.
 *
 * Sessions assigned to the project that aren't already running get resumed
 * (and tagged with this projectId so they show in the project view). Chats
 * already alive elsewhere are NOT touched — switching workspaces never
 * kills work in progress.
 */
export async function openProject(projectId: string): Promise<void> {
  setActiveProjectId(projectId);
  if (sessions().length === 0) await loadSessions();

  // (1) Resume saved sessions that belong to this project.
  const projectSessionIds = new Set(sessionIdsInProject(projectId));
  const alreadyOpenSessionIds = new Set(
    openChatsInProject(projectId)
      .map((c) => c.sessionId)
      .filter((s): s is string => Boolean(s)),
  );
  if (projectSessionIds.size > 0) {
    const toOpen = sessions().filter(
      (s) => projectSessionIds.has(s.sessionId) && !alreadyOpenSessionIds.has(s.sessionId),
    );
    await Promise.all(
      toOpen.map(async (s) => {
        const saved = await loadLaunchSettings(s.sessionId);
        openChatFromSession(
          s,
          saved ?? { agentId: 'claude-opus-4-7', extraFlags: [], skipPermissions: false },
          { projectId },
        );
      }),
    );
  }

  // (2) Restore any "pending" (intent-only) chats — fresh chats the user
  //     created in this project that didn't yet have a session JSONL when
  //     the app last closed.
  //
  //     For each pending row we try to recover the actual conversation
  //     by matching against on-disk Claude sessions: a session with the
  //     same cwd whose date is later than the pending row's createdAt is
  //     almost certainly the one this pending chat produced. Pendings are
  //     processed in creation order, picking the oldest unclaimed match
  //     each time, so consecutive fresh chats in the same cwd line up
  //     with consecutive sessions.
  //
  //     If a match is found → openChatFromSession (--resume) so the
  //     conversation continues exactly where the user left off.
  //     If not (process never produced a JSONL, or all matches already
  //     consumed) → openFreshChat as a last-resort intent restore.
  try {
    const pending = await invoke<
      Array<{
        id: string;
        cwd: string;
        agentId: string;
        title: string;
        extraFlags: string[];
        skipPermissions: boolean;
        createdAt: number;
      }>
    >(IPC.ListPendingChats, { projectId });
    const alreadyOpenPendingIds = new Set(openChatsInProject(projectId).map((c) => c.id));
    // sort by createdAt asc so the oldest pending claims the oldest match
    const pendingByAge = [...pending].sort((a, b) => a.createdAt - b.createdAt);
    const claimedSessionIds = new Set<string>();
    for (const p of pendingByAge) {
      if (alreadyOpenPendingIds.has(p.id)) continue;
      const match = findResumableSession(sessions(), p, claimedSessionIds);
      if (match) {
        claimedSessionIds.add(match.sessionId);
        const saved = await loadLaunchSettings(match.sessionId);
        openChatFromSession(
          match,
          saved ?? {
            agentId: p.agentId,
            extraFlags: p.extraFlags,
            skipPermissions: p.skipPermissions,
          },
          { projectId },
        );
        continue;
      }
      // No on-disk match — fall back to a fresh re-spawn so the user at
      // least gets a placeholder tab back. They lose conversation history
      // but the workspace shape is preserved.
      openFreshChat({
        cwd: p.cwd,
        agentId: p.agentId,
        title: p.title,
        extraFlags: p.extraFlags,
        skipPermissions: p.skipPermissions,
        projectId,
      });
    }
  } catch (err) {
    console.warn('[chat-projects] failed to restore pending chats:', err);
  }
}

/**
 * Find the on-disk Claude session that most likely belongs to a pending
 * chat. Match criteria, in priority order:
 *   1. Same cwd as the pending row.
 *   2. Session.date is after the pending.createdAt timestamp (the JSONL
 *      was created AFTER the pending row was registered).
 *   3. Not already claimed by an earlier pending in this restore pass.
 *   4. Pick the oldest of the remaining matches.
 *
 * Exported (with the underscore-prefix convention used elsewhere as a
 * "test-only" hint) so the unit suite can pin behaviour without standing
 * up the whole openProject path.
 */
export function findResumableSession(
  sessionList: ReadonlyArray<SessionForResume>,
  pending: { cwd: string; createdAt: number },
  claimed: ReadonlySet<string>,
): SessionForResume | null {
  // Normalise paths (Windows backslashes vs forward) — the same project
  // can show up either way depending on entry point.
  const cwdNorm = pending.cwd.replace(/\\/g, '/').toLowerCase();
  const candidates = sessionList.filter((s) => {
    if (claimed.has(s.sessionId)) return false;
    if (s.projectPath.replace(/\\/g, '/').toLowerCase() !== cwdNorm) return false;
    const sessionMs = Date.parse(s.date);
    if (Number.isNaN(sessionMs)) return false;
    return sessionMs >= pending.createdAt;
  });
  if (candidates.length === 0) return null;
  // Oldest first — preserves "first pending claims first session" ordering.
  candidates.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return candidates[0] ?? null;
}

/** Subset of SessionItem used by findResumableSession — kept narrow so the
 *  helper is easy to unit-test without faking the full SessionItem shape. */
export interface SessionForResume {
  sessionId: string;
  projectPath: string;
  date: string;
  title: string;
  filePath: string;
  description?: string;
  folderIds: string[];
}

/** Leave a project — flip activeProjectId back to null. Chats stay running. */
export function leaveProject(): void {
  setActiveProjectId(null);
}

/**
 * Persist a new fresh chat as "pending" so reopening the project after an
 * app restart re-creates it. Called from ProjectsPanel right after
 * `openFreshChat({...projectId})` returns.
 */
export async function persistPendingChat(args: {
  id: string;
  projectId: string;
  cwd: string;
  agentId: string;
  title: string;
  extraFlags?: string[];
  skipPermissions?: boolean;
}): Promise<void> {
  try {
    await invoke<undefined>(IPC.AddPendingChat, args);
  } catch (err) {
    console.warn('[chat-projects] persistPendingChat failed:', err);
  }
}

export async function dropPendingChat(id: string): Promise<void> {
  try {
    await invoke<undefined>(IPC.RemovePendingChat, { id });
  } catch (err) {
    console.warn('[chat-projects] dropPendingChat failed:', err);
  }
}
