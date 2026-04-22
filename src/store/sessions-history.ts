/**
 * sessions-history.ts
 * SolidJS signals for the Claude Code sessions history panel.
 * Isolated from other stores to avoid conflicts with parallel agents.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store } from './core';
import { addProject } from './projects';
import { createTask } from './tasks';
import { filterState } from './session-filters';
import type { AgentDef } from '../ipc/types';

// ---------------------------------------------------------------------------
// Types (mirrored from electron/ipc/session-history.ts)
// ---------------------------------------------------------------------------

export interface SessionItem {
  sessionId: string;
  filePath: string;
  projectPath: string;
  title: string;
  date: string;
  description?: string;
  folderIds: string[];
}

export interface SessionPreview {
  sessionId: string;
  firstLines: string[];
  lastLines: string[];
}

export interface FolderItem {
  id: string;
  name: string;
  color?: string;
  position: number;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

// Module-level signals are owned by a persistent root so Solid doesn't warn
// about "computations created outside createRoot" during HMR.
type RootSig<T> = [Accessor<T>, Setter<T>];

const [_sessions, _setSessions] = createRoot<RootSig<SessionItem[]>>(() =>
  createSignal<SessionItem[]>([]),
);
const [_searchQuery, _setSearchQuery] = createRoot<RootSig<string>>(() =>
  createSignal<string>(''),
);
const [_sessionsLoading, _setSessionsLoading] = createRoot<RootSig<boolean>>(() =>
  createSignal<boolean>(false),
);
const [_sessionsError, _setSessionsError] = createRoot<RootSig<string | null>>(() =>
  createSignal<string | null>(null),
);

// Folders state
const [_folders, _setFolders] = createRoot<RootSig<FolderItem[]>>(() =>
  createSignal<FolderItem[]>([]),
);
const [_activeFolderId, _setActiveFolderId] = createRoot<RootSig<string | null>>(() =>
  createSignal<string | null>(null),
);
const [_activeProjectPath, _setActiveProjectPath] = createRoot<RootSig<string | null>>(() =>
  createSignal<string | null>(null),
);

export const sessions = _sessions;
export const setSessions = _setSessions;
export const searchQuery = _searchQuery;
export const setSearchQuery = _setSearchQuery;
export const sessionsLoading = _sessionsLoading;
export const setSessionsLoading = _setSessionsLoading;
export const sessionsError = _sessionsError;
export const setSessionsError = _setSessionsError;
export const folders = _folders;
export const activeFolderId = _activeFolderId;
export const setActiveFolderId = _setActiveFolderId;
export const activeProjectPath = _activeProjectPath;
export const setActiveProjectPath = _setActiveProjectPath;

/** Smart-folder auto-groups derived from the unique project paths on disk. */
export function smartProjectGroups(): { projectPath: string; basename: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of sessions()) {
    counts.set(s.projectPath, (counts.get(s.projectPath) ?? 0) + 1);
  }
  const out: { projectPath: string; basename: string; count: number }[] = [];
  for (const [projectPath, count] of counts) {
    const basename =
      projectPath
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() ?? projectPath;
    out.push({ projectPath, basename, count });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function loadSessions(extraFolders?: string[]): Promise<void> {
  setSessionsLoading(true);
  setSessionsError(null);
  try {
    // Merge caller-provided + user-configured extra folders
    const configured = filterState().extraFolders;
    const merged = Array.from(new Set([...configured, ...(extraFolders ?? [])]));
    const result = await invoke<SessionItem[]>(IPC.ListClaudeSessions, {
      extraFolders: merged,
    });
    setSessions(result);
  } catch (err) {
    setSessionsError(err instanceof Error ? err.message : String(err));
  } finally {
    setSessionsLoading(false);
  }
}

export async function renameSessionLocal(sessionId: string, alias: string): Promise<void> {
  await invoke<void>(IPC.RenameClaudeSession, { sessionId, alias });
  // Optimistically update local title
  setSessions((prev) =>
    prev.map((s) => (s.sessionId === sessionId ? { ...s, title: alias || s.sessionId.slice(0, 16) } : s)),
  );
}

export async function fetchSessionPreview(filePath: string): Promise<SessionPreview> {
  return invoke<SessionPreview>(IPC.GetClaudeSessionPreview, { filePath });
}

export function filteredSessions(): SessionItem[] {
  const q = searchQuery().toLowerCase().trim();
  const folderId = activeFolderId();
  const projectPath = activeProjectPath();
  const f = filterState();
  let list = sessions();

  // Hide explicitly-suppressed projects (unless user is drilling into one)
  if (!projectPath && f.hiddenProjects.length > 0) {
    list = list.filter((s) => !f.hiddenProjects.includes(s.projectPath));
  }
  if (folderId) {
    list = list.filter((s) => s.folderIds.includes(folderId));
  }
  if (projectPath) {
    list = list.filter((s) => s.projectPath === projectPath);
  }
  if (q) {
    list = list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.projectPath.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q),
    );
  }

  // Sort
  list = [...list];
  switch (f.sort) {
    case 'oldest':
      list.sort((a, b) => a.date.localeCompare(b.date));
      break;
    case 'project':
      list.sort(
        (a, b) =>
          a.projectPath.localeCompare(b.projectPath) ||
          b.date.localeCompare(a.date),
      );
      break;
    case 'title':
      list.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'newest':
    default:
      list.sort((a, b) => b.date.localeCompare(a.date));
  }
  return list;
}

// ---------------------------------------------------------------------------
// Folder actions
// ---------------------------------------------------------------------------

export async function loadFolders(): Promise<void> {
  try {
    const result = await invoke<FolderItem[]>(IPC.ListFolders, {});
    _setFolders(result);
  } catch (err) {
    console.warn('[sessions-history] loadFolders failed:', err);
  }
}

export async function createFolderAction(name: string, color?: string): Promise<FolderItem | null> {
  try {
    const folder = await invoke<FolderItem>(IPC.CreateFolder, { name, color });
    _setFolders((prev) => [...prev, folder]);
    return folder;
  } catch (err) {
    console.warn('[sessions-history] createFolder failed:', err);
    return null;
  }
}

export async function renameFolderAction(id: string, name: string): Promise<void> {
  try {
    await invoke<void>(IPC.RenameFolder, { id, name });
    _setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
  } catch (err) {
    console.warn('[sessions-history] renameFolder failed:', err);
  }
}

export async function deleteFolderAction(id: string): Promise<void> {
  try {
    await invoke<void>(IPC.DeleteFolder, { id });
    _setFolders((prev) => prev.filter((f) => f.id !== id));
    // Remove membership from all sessions client-side
    setSessions((prev) =>
      prev.map((s) =>
        s.folderIds.includes(id) ? { ...s, folderIds: s.folderIds.filter((x) => x !== id) } : s,
      ),
    );
    if (activeFolderId() === id) _setActiveFolderId(null);
  } catch (err) {
    console.warn('[sessions-history] deleteFolder failed:', err);
  }
}

export async function addSessionToFolderAction(sessionId: string, folderId: string): Promise<void> {
  try {
    await invoke<void>(IPC.AddSessionToFolder, { sessionId, folderId });
    setSessions((prev) =>
      prev.map((s) =>
        s.sessionId === sessionId && !s.folderIds.includes(folderId)
          ? { ...s, folderIds: [...s.folderIds, folderId] }
          : s,
      ),
    );
  } catch (err) {
    console.warn('[sessions-history] addSessionToFolder failed:', err);
  }
}

export async function removeSessionFromFolderAction(
  sessionId: string,
  folderId: string,
): Promise<void> {
  try {
    await invoke<void>(IPC.RemoveSessionFromFolder, { sessionId, folderId });
    setSessions((prev) =>
      prev.map((s) =>
        s.sessionId === sessionId
          ? { ...s, folderIds: s.folderIds.filter((x) => x !== folderId) }
          : s,
      ),
    );
  } catch (err) {
    console.warn('[sessions-history] removeSessionFromFolder failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/**
 * Open a historical session in a new direct-mode task, passing `--resume <uuid>`
 * to the selected Claude binary. If the project isn't registered yet, it's added
 * on the fly using the session's cwd as the project path.
 */
export async function resumeSession(
  session: SessionItem,
  opts: { agentId?: string } = {},
): Promise<string | null> {
  try {
    // 1. Find or create the project that owns the session's cwd
    let project = store.projects.find((p) => p.path === session.projectPath);
    let projectId: string;
    if (project) {
      projectId = project.id;
    } else {
      const basename = session.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? session.projectPath;
      projectId = addProject(basename, session.projectPath);
    }

    // 2. Pick a Claude binary. Prefer Opus 4.7, then any claude-*, then the first available.
    const preferred = opts.agentId ?? 'claude-opus-4-7';
    const available = store.availableAgents;
    const baseAgent =
      available.find((a) => a.id === preferred) ??
      available.find((a) => a.id.startsWith('claude-')) ??
      available[0];
    if (!baseAgent) {
      throw new Error('No Claude agent available — install claude CLI first');
    }

    // 3. Clone the base agent with --resume <sessionId>. Global default flags
    // are merged inside TerminalView at spawn time (so they apply to every
    // terminal, not only resumes).
    const agentDef: AgentDef = {
      ...baseAgent,
      id: `${baseAgent.id}-resume-${session.sessionId.slice(0, 8)}`,
      name: `${baseAgent.name} · resume`,
      args: ['--resume', session.sessionId],
    };

    // 4. Create a direct-mode task so the claude runs in the session's cwd
    const taskId = await createTask({
      name: (session.title || session.sessionId.slice(0, 8)).slice(0, 60),
      agentDef,
      projectId,
      gitIsolation: 'direct',
      baseBranch: '',
    });
    return taskId;
  } catch (err) {
    setSessionsError(err instanceof Error ? err.message : String(err));
    return null;
  }
}
