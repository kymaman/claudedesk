/* eslint-disable solid/reactivity -- createRoot(() => createSignal(...)) is an intentional HMR-safe pattern; the tuple is destructured at the outer call site, which the linter can't see through the closure. */
/**
 * sessions-history.ts
 * SolidJS signals for the Claude Code sessions history panel.
 * Isolated from other stores to avoid conflicts with parallel agents.
 *
 * This module owns the *state* (types, signals, derived selectors). All
 * IPC-orchestrating actions (loadSessions, loadFolders, resumeSession, …)
 * live in `sessions-history-actions.ts` and are re-exported below so the
 * public import surface is unchanged for callers.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';
import { filterState } from './session-filters';
import { hiddenSessions } from './session-hide';

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
  pinned: boolean;
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
const [_searchQuery, _setSearchQuery] = createRoot<RootSig<string>>(() => createSignal<string>(''));
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

/**
 * Internal setters — exported only for the sibling -actions module which
 * mutates folder/active-folder state in response to IPC results. Not part
 * of the public API; do NOT import these from outside this folder.
 */
export const setFoldersInternal = _setFolders;
export const setActiveFolderIdInternal = _setActiveFolderId;

/** Smart-folder auto-groups derived from the unique project paths on disk. */
export function smartProjectGroups(): { projectPath: string; basename: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of sessions()) {
    counts.set(s.projectPath, (counts.get(s.projectPath) ?? 0) + 1);
  }
  const out: { projectPath: string; basename: string; count: number }[] = [];
  for (const [projectPath, count] of counts) {
    const basename = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
    out.push({ projectPath, basename, count });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

export function filteredSessions(): SessionItem[] {
  const q = searchQuery().toLowerCase().trim();
  const folderId = activeFolderId();
  const projectPath = activeProjectPath();
  const f = filterState();
  const hidden = hiddenSessions();
  let list = sessions();

  // Session-level hide (right-click → Delete from view)
  if (hidden.size > 0) {
    list = list.filter((s) => !hidden.has(s.sessionId));
  }

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
        (a, b) => a.projectPath.localeCompare(b.projectPath) || b.date.localeCompare(a.date),
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
// Actions — re-exported from sessions-history-actions.ts so existing call
// sites continue to import everything from `./sessions-history` unchanged.
// ---------------------------------------------------------------------------

export {
  loadSessions,
  renameSessionLocal,
  fetchSessionPreview,
  loadFolders,
  createFolderAction,
  renameFolderAction,
  deleteFolderAction,
  addSessionToFolderAction,
  removeSessionFromFolderAction,
  pinFolderAction,
  resumeSession,
} from './sessions-history-actions';
