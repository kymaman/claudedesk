/**
 * sessions-history-actions.ts
 * IPC-orchestrating actions for the sessions-history store. Sibling to
 * `sessions-history.ts`, which owns the signals and pure derived selectors.
 *
 * No new behaviour — these functions and signatures are verbatim from the
 * pre-split `sessions-history.ts`. They were extracted to keep the
 * state file under 200 LOC and make the IPC surface easy to skim.
 */

import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store } from './core';
import { addProject } from './projects';
import { createTask } from './tasks';
import { filterState } from './session-filters';
import type { AgentDef } from '../ipc/types';
import {
  type SessionItem,
  type SessionPreview,
  type FolderItem,
  setSessions,
  setSessionsLoading,
  setSessionsError,
  activeFolderId,
  setFoldersInternal,
  setActiveFolderIdInternal,
} from './sessions-history';

// ---------------------------------------------------------------------------
// Sessions
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
  await invoke<undefined>(IPC.RenameClaudeSession, { sessionId, alias });
  // Optimistically update local title
  setSessions((prev) =>
    prev.map((s) =>
      s.sessionId === sessionId ? { ...s, title: alias || s.sessionId.slice(0, 16) } : s,
    ),
  );
}

export async function fetchSessionPreview(filePath: string): Promise<SessionPreview> {
  return invoke<SessionPreview>(IPC.GetClaudeSessionPreview, { filePath });
}

// ---------------------------------------------------------------------------
// Folder actions
// ---------------------------------------------------------------------------

export async function loadFolders(): Promise<void> {
  try {
    const result = await invoke<FolderItem[]>(IPC.ListFolders, {});
    setFoldersInternal(result);
  } catch (err) {
    console.warn('[sessions-history] loadFolders failed:', err);
  }
}

export async function createFolderAction(name: string, color?: string): Promise<FolderItem | null> {
  try {
    const folder = await invoke<FolderItem>(IPC.CreateFolder, { name, color });
    setFoldersInternal((prev) => [...prev, folder]);
    return folder;
  } catch (err) {
    console.warn('[sessions-history] createFolder failed:', err);
    return null;
  }
}

export async function renameFolderAction(id: string, name: string): Promise<void> {
  try {
    await invoke<undefined>(IPC.RenameFolder, { id, name });
    setFoldersInternal((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
  } catch (err) {
    console.warn('[sessions-history] renameFolder failed:', err);
  }
}

export async function deleteFolderAction(id: string): Promise<void> {
  try {
    await invoke<undefined>(IPC.DeleteFolder, { id });
    setFoldersInternal((prev) => prev.filter((f) => f.id !== id));
    // Remove membership from all sessions client-side
    setSessions((prev) =>
      prev.map((s) =>
        s.folderIds.includes(id) ? { ...s, folderIds: s.folderIds.filter((x) => x !== id) } : s,
      ),
    );
    if (activeFolderId() === id) setActiveFolderIdInternal(null);
  } catch (err) {
    console.warn('[sessions-history] deleteFolder failed:', err);
  }
}

export async function addSessionToFolderAction(sessionId: string, folderId: string): Promise<void> {
  try {
    await invoke<undefined>(IPC.AddSessionToFolder, { sessionId, folderId });
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
    await invoke<undefined>(IPC.RemoveSessionFromFolder, { sessionId, folderId });
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

export async function pinFolderAction(id: string, pinned: boolean): Promise<void> {
  try {
    await invoke<undefined>(IPC.PinFolder, { id, pinned });
    setFoldersInternal((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, pinned } : f));
      // Re-sort: pinned first, then by position/name
      next.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return a.position - b.position || a.name.localeCompare(b.name);
      });
      return next;
    });
  } catch (err) {
    console.warn('[sessions-history] pinFolder failed:', err);
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
    const project = store.projects.find((p) => p.path === session.projectPath);
    let projectId: string;
    if (project) {
      projectId = project.id;
    } else {
      const basename =
        session.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? session.projectPath;
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
