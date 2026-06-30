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
import { openChats, titleFor } from './chats';

// ---------------------------------------------------------------------------
// Types (mirrored from electron/ipc/session-history.ts)
// ---------------------------------------------------------------------------

export interface SessionItem {
  sessionId: string;
  filePath: string;
  projectPath: string;
  title: string;
  /** Title parsed from the first real prompt (line-2 material when an
   *  alias/AI title occupies line 1) */
  parsedTitle?: string;
  date: string;
  description?: string;
  folderIds: string[];
  /** Session this one was explicitly branched from (⑂), if recorded */
  branchParentId?: string;
  /** When this row stands in for an OPEN chat tile that has no distinct
   *  session on disk yet (a freshly-branched fork still sharing its
   *  parent's sessionId), this is that tile's chat id. Clicking the row
   *  focuses the tile instead of trying to --resume a non-existent
   *  session. */
  openChatId?: string;
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

/**
 * Synthesize "ephemeral" SessionItems for every open chat that carries a
 * sessionId but doesn't yet have a JSONL on disk (because claude only
 * writes the file after the first turn). Without this, brand-new chats
 * never showed up in History until the user had typed AND the user
 * refreshed — which the History panel has no manual button for. (#35)
 *
 * Disk-loaded sessions win on dedup: once claude writes the JSONL and
 * loadSessions() picks it up, the ephemeral entry is dropped in favor
 * of the real one (preserving folderIds, description, etc.).
 */
function sessionsWithOpenChats(): SessionItem[] {
  const disk = sessions();
  const known = new Set(disk.map((s) => s.sessionId));

  // Map sessionId → the open tile's RESOLVED title (titleFor). We overlay
  // this onto the matching disk session so the History row renders the EXACT
  // SAME text the tile header shows — title parity, «название слева в истории
  // и сверху над терминалом — одни задачи». titleFor already encodes the
  // canonical precedence (manual override ?? live disk/alias title ??
  // base) and is the SAME function the tile (ChatsGrid) and chip
  // (TopSwitcher) render through, so the row and the tile can never drift:
  // they read one resolver, not two chains that merely happen to agree.
  // (Previously this overlaid only the manual override, leaving the disk
  // row on `s.title` while the tile resolved through `_diskTitles`/base —
  // a second, parallel precedence chain that could diverge.)
  const tileTitleById = new Map<string, string>();
  // sessionId → ISO datetime the chat tile was opened. Overlaid onto the
  // matching disk session's date so OPENING a chat bumps it to the top
  // of the "newest" sort IMMEDIATELY (openChats() is reactive) — not
  // after an app restart. Disk dates are bare "YYYY-MM-DD" (mtime), so
  // a full ISO datetime compares above every same-day disk session.
  const openedAtById = new Map<string, string>();
  const ephemeral: SessionItem[] = [];
  for (const c of openChats()) {
    if (!c.sessionId) continue;
    const openedAt = new Date(c.createdAt).toISOString();

    // A freshly-branched tile shares its PARENT's sessionId until claude
    // writes the fork's own JSONL (on the first turn). Keyed by sessionId
    // it would collapse onto the parent row and the user "can't see the
    // branch they just made". Give every still-undiverged fork its OWN
    // row, keyed by the unique chat id and tagged so a click focuses the
    // tile rather than --resuming a session that isn't on disk yet. Its
    // rename override is NOT overlaid onto the parent (different row).
    if (c.forkParent && c.sessionId === c.forkParent.sessionId) {
      ephemeral.push({
        sessionId: c.id,
        filePath: '',
        projectPath: c.cwd,
        title: titleFor(c),
        date: openedAt,
        folderIds: [],
        branchParentId: c.forkParent.sessionId,
        openChatId: c.id,
      });
      continue;
    }

    if (known.has(c.sessionId)) {
      // The disk row for an open chat must render through titleFor — the
      // exact resolver the tile uses — so the two are identical by
      // construction (not just when _diskTitles happens to equal s.title).
      tileTitleById.set(c.sessionId, titleFor(c));
      openedAtById.set(c.sessionId, openedAt);
      continue;
    }
    ephemeral.push({
      sessionId: c.sessionId,
      filePath: '',
      projectPath: c.cwd,
      title: titleFor(c),
      // Use ISO date so sort:newest places fresh chats above older disk
      // sessions — matches the "just opened" feel.
      date: openedAt,
      folderIds: [],
      // A diverged fork whose JSONL isn't on disk yet still wants to
      // focus its open tile on click.
      ...(c.forkParent ? { branchParentId: c.forkParent.sessionId, openChatId: c.id } : {}),
    });
  }

  // Overlay open tiles' resolved titles (titleFor) + open-bump dates onto
  // on-disk sessions, so each row matches its tile header exactly.
  const overlaid =
    tileTitleById.size === 0 && openedAtById.size === 0
      ? disk
      : disk.map((s) => {
          const tileTitle = tileTitleById.get(s.sessionId);
          const openedAt = openedAtById.get(s.sessionId);
          // Bump only forward in time — an old still-open tile must not
          // sink a session that something updated more recently.
          const date = openedAt && openedAt > s.date ? openedAt : s.date;
          if ((tileTitle === undefined || tileTitle === s.title) && date === s.date) return s;
          return { ...s, title: tileTitle ?? s.title, date };
        });

  return ephemeral.length === 0 ? overlaid : [...overlaid, ...ephemeral];
}

export function filteredSessions(): SessionItem[] {
  const q = searchQuery().toLowerCase().trim();
  const folderId = activeFolderId();
  const projectPath = activeProjectPath();
  const f = filterState();
  const hidden = hiddenSessions();
  let list = sessionsWithOpenChats();

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
  summarizeSessionAction,
  loadFolders,
  createFolderAction,
  renameFolderAction,
  deleteFolderAction,
  addSessionToFolderAction,
  removeSessionFromFolderAction,
  pinFolderAction,
  resumeSession,
} from './sessions-history-actions';
