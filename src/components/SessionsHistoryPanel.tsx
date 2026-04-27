/**
 * SessionsHistoryPanel.tsx
 * Main History view: folders sidebar · session list · preview pane.
 *
 * Interactions:
 *  - Click row → resume in terminal with current agent version
 *  - Hover row → preview on the right pane (first/last 5 messages)
 *  - Double-click title → inline rename
 *  - Drag row → drop on folder to add membership
 *  - "+ New folder" creates a custom folder
 */

import {
  createSignal,
  onMount,
  onCleanup,
  createEffect,
  For,
  Show,
  createMemo,
  createResource,
} from 'solid-js';
import './SessionsHistoryPanel.css';
import { store } from '../store/store';
import {
  sessions,
  searchQuery,
  setSearchQuery,
  sessionsLoading,
  sessionsError,
  loadSessions,
  renameSessionLocal,
  filteredSessions,
  folders,
  activeFolderId,
  setActiveFolderId,
  activeProjectPath,
  setActiveProjectPath,
  smartProjectGroups,
  loadFolders,
  createFolderAction,
  renameFolderAction,
  deleteFolderAction,
  addSessionToFolderAction,
  removeSessionFromFolderAction,
  pinFolderAction,
  fetchSessionPreview,
  type SessionItem,
  type FolderItem,
} from '../store/sessions-history';
import {
  loadLaunchSettings,
  saveLaunchSettings,
  type LaunchSettings,
} from '../store/launch-settings';
import { openChatFromSession, openChats } from '../store/chats';
import { ChatsGrid } from './ChatsGrid';
import {
  filterState,
  setSortOrder,
  toggleHiddenProject,
  type SortOrder,
} from '../store/session-filters';
import { mainView } from '../store/mainView';
import { hideEmptyFolders, setHideEmptyFolders } from '../store/folder-prefs';
import { hideSession } from '../store/session-hide';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { DragMime } from '../lib/drag-mime';

interface Props {
  /** When provided, renders a close button in the header (overlay mode). */
  onClose?: () => void;
}

const DRAG_MIME = DragMime.SessionId;

function claudeAgents() {
  const list = store.availableAgents.filter(
    (a) => a.id.startsWith('claude-') && a.available !== false,
  );
  if (list.length === 0) return store.availableAgents.filter((a) => a.id.startsWith('claude-'));
  return list;
}

export function SessionsHistoryPanel(props: Props) {
  const [hoveredSession, setHoveredSession] = createSignal<SessionItem | null>(null);
  const [draggedFolderTarget, setDraggedFolderTarget] = createSignal<string | null>(null);
  const [creatingFolder, setCreatingFolder] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal('');
  const [foldersCollapsed, setFoldersCollapsed] = createSignal(false);
  let newFolderInputRef: HTMLInputElement | undefined;

  // Compact mode when any chat is open: sessions rail + chats grid
  const compact = () => openChats().length > 0 || mainView() === 'chats';
  // Zoom mode = user explicitly switched to Chats tab. Folders + sessions
  // list collapse so the chats grid fills the window.
  const chatsZoom = () => mainView() === 'chats';

  onMount(() => {
    if (sessions().length === 0) void loadSessions();
    void loadFolders();
  });

  function beginCreateFolder() {
    setCreatingFolder(true);
    setNewFolderName('');
    requestAnimationFrame(() => newFolderInputRef?.focus());
  }

  async function commitCreateFolder() {
    const name = newFolderName().trim();
    setCreatingFolder(false);
    setNewFolderName('');
    if (!name) return;
    const folder = await createFolderAction(name);
    // Auto-select so the new row is visible even when "Hide empty" is on —
    // the filter special-cases the active folder id.
    if (folder) {
      setActiveFolderId(folder.id);
      setActiveProjectPath(null);
    }
  }

  function cancelCreateFolder() {
    setCreatingFolder(false);
    setNewFolderName('');
  }

  return (
    <div class={`sessions-panel${chatsZoom() ? ' sessions-panel--chats-zoom' : ''}`}>
      <div class="sessions-panel__header">
        <span class="sessions-panel__title">History</span>
        <input
          class="sessions-panel__search"
          type="search"
          placeholder="Search title, project, description..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
        <select
          class="sessions-panel__sort"
          value={filterState().sort}
          onChange={(e) => setSortOrder(e.currentTarget.value as SortOrder)}
          title="Sort order"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="project">Project</option>
          <option value="title">Title</option>
        </select>
        <button
          class="sessions-panel__refresh"
          onClick={() => {
            void loadSessions();
            void loadFolders();
          }}
          title="Refresh"
          disabled={sessionsLoading()}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            style={sessionsLoading() ? 'animation: spin 1s linear infinite' : undefined}
          >
            <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z" />
            <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
          </svg>
        </button>
        <Show when={props.onClose}>
          <button class="sessions-panel__close" onClick={() => props.onClose?.()} title="Close">
            &times;
          </button>
        </Show>
      </div>

      <div
        class={`sessions-panel__body${compact() ? ' sessions-panel__body--compact' : ''}${foldersCollapsed() ? ' sessions-panel__body--folders-hidden' : ''}`}
      >
        <Show when={!foldersCollapsed()}>
          <aside class="folders-pane">
            <div class="folders-pane__head">
              <span class="folders-pane__label">Folders</span>
              <button
                class="folders-pane__collapse"
                onClick={() => setFoldersCollapsed(true)}
                title="Hide folders"
              >
                ‹
              </button>
              <button
                class="folders-pane__add"
                onClick={beginCreateFolder}
                title="Create new folder"
                disabled={creatingFolder()}
              >
                +
              </button>
            </div>

            <Show when={creatingFolder()}>
              <div class="folder-create">
                <input
                  ref={newFolderInputRef}
                  class="folder-create__input"
                  value={newFolderName()}
                  placeholder="Folder name…"
                  onInput={(e) => setNewFolderName(e.currentTarget.value)}
                  onBlur={() => void commitCreateFolder()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitCreateFolder();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelCreateFolder();
                    }
                  }}
                />
              </div>
            </Show>

            <FolderRow
              label="All sessions"
              active={activeFolderId() === null && activeProjectPath() === null}
              onClick={() => {
                setActiveFolderId(null);
                setActiveProjectPath(null);
              }}
              count={sessions().length}
              highlight={draggedFolderTarget() === '__all__'}
              onDragEnter={() => setDraggedFolderTarget('__all__')}
              onDragLeave={() => {
                if (draggedFolderTarget() === '__all__') setDraggedFolderTarget(null);
              }}
              onDrop={(sessionId) => {
                setDraggedFolderTarget(null);
                // Pull the session out of every folder it currently belongs to —
                // dragging "back to All sessions" is the undo for a mis-drop.
                const target = sessions().find((s) => s.sessionId === sessionId);
                if (!target) return;
                for (const fid of target.folderIds) {
                  void removeSessionFromFolderAction(sessionId, fid);
                }
              }}
            />

            <Show when={folders().length > 0}>
              <div class="folders-pane__section-title">My folders</div>
            </Show>
            <For
              each={folders().filter((f) => {
                if (!hideEmptyFolders()) return true;
                // Always keep pinned folders and the currently-active one visible —
                // otherwise a freshly-created (empty) folder would vanish behind
                // the filter the moment it's saved.
                if (f.pinned || activeFolderId() === f.id) return true;
                const count = sessions().filter((s) => s.folderIds.includes(f.id)).length;
                return count > 0;
              })}
            >
              {(folder) => (
                <FolderRowCustom
                  folder={folder}
                  active={activeFolderId() === folder.id}
                  highlight={draggedFolderTarget() === folder.id}
                  count={sessions().filter((s) => s.folderIds.includes(folder.id)).length}
                  onClick={() => {
                    setActiveFolderId(folder.id);
                    setActiveProjectPath(null);
                  }}
                  onDragEnter={() => setDraggedFolderTarget(folder.id)}
                  onDragLeave={() => {
                    if (draggedFolderTarget() === folder.id) setDraggedFolderTarget(null);
                  }}
                  onDrop={(sessionId) => {
                    setDraggedFolderTarget(null);
                    void addSessionToFolderAction(sessionId, folder.id);
                  }}
                  onRename={(newName) => {
                    void renameFolderAction(folder.id, newName);
                  }}
                  onDelete={() => {
                    if (
                      window.confirm(`Delete folder "${folder.name}"? Sessions are not deleted.`)
                    ) {
                      void deleteFolderAction(folder.id);
                    }
                  }}
                  onPin={() => {
                    void pinFolderAction(folder.id, !folder.pinned);
                  }}
                />
              )}
            </For>

            <div class="folders-pane__footer">
              <button
                class={`folders-pane__footer-btn ${hideEmptyFolders() ? 'is-active' : ''}`}
                onClick={() => setHideEmptyFolders(!hideEmptyFolders())}
                title="Hide folders that contain zero sessions (pinned folders stay visible)"
              >
                {hideEmptyFolders() ? '☑' : '☐'} Hide empty
              </button>
            </div>

            <Show when={smartProjectGroups().length > 0}>
              <div class="folders-pane__section-title">By project</div>
              <For each={smartProjectGroups()}>
                {(group) => {
                  const isHidden = () => filterState().hiddenProjects.includes(group.projectPath);
                  return (
                    <div class="folder-row-smart-wrap">
                      <button
                        class={`folder-row folder-row--smart${activeProjectPath() === group.projectPath ? ' folder-row--active' : ''}${isHidden() ? ' folder-row--hidden' : ''}`}
                        onClick={() => {
                          setActiveProjectPath(group.projectPath);
                          setActiveFolderId(null);
                        }}
                        title={
                          group.projectPath + (isHidden() ? ' (hidden from All sessions)' : '')
                        }
                      >
                        <span class="folder-row__label">{group.basename}</span>
                        <span class="folder-row__count">{group.count}</span>
                      </button>
                      <button
                        class="folder-row-smart-wrap__toggle"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleHiddenProject(group.projectPath);
                        }}
                        title={isHidden() ? 'Show in All sessions' : 'Hide from All sessions'}
                      >
                        {isHidden() ? '◇' : '◆'}
                      </button>
                    </div>
                  );
                }}
              </For>
            </Show>
          </aside>
        </Show>
        <Show when={foldersCollapsed()}>
          <button
            class="folders-pane__expand"
            onClick={() => setFoldersCollapsed(false)}
            title="Show folders"
          >
            ›
          </button>
        </Show>

        <div class="sessions-panel__list">
          <Show when={sessionsError()}>
            {(err) => <div class="sessions-panel__error">Error: {err()}</div>}
          </Show>

          <Show
            when={filteredSessions().length > 0}
            fallback={
              <div class="sessions-panel__empty">
                {sessionsLoading() ? 'Loading sessions...' : 'No sessions found.'}
              </div>
            }
          >
            <For each={filteredSessions()}>
              {(session) => (
                <SessionRow
                  session={session}
                  onClose={props.onClose ?? (() => {})}
                  onHover={(s) => setHoveredSession(s)}
                />
              )}
            </For>
          </Show>
        </div>

        <Show when={compact()} fallback={<PreviewPane session={hoveredSession()} />}>
          <div class="sessions-panel__chats">
            <ChatsGrid />
          </div>
        </Show>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Folder rows
// ---------------------------------------------------------------------------

function FolderRow(props: {
  label: string;
  count?: number;
  active: boolean;
  highlight: boolean;
  onClick: () => void;
  onDrop?: (sessionId: string) => void;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
}) {
  function handleDragOver(e: DragEvent) {
    if (!props.onDrop) return;
    if (e.dataTransfer?.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }
  function handleDrop(e: DragEvent) {
    if (!props.onDrop) return;
    e.preventDefault();
    const sessionId = e.dataTransfer?.getData(DRAG_MIME);
    if (sessionId) props.onDrop(sessionId);
  }
  return (
    <button
      class={`folder-row${props.active ? ' folder-row--active' : ''}${props.highlight ? ' folder-row--drop' : ''}`}
      onClick={() => props.onClick()}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnter={() => props.onDragEnter?.()}
      onDragLeave={() => props.onDragLeave?.()}
    >
      <span class="folder-row__label">{props.label}</span>
      <Show when={typeof props.count === 'number'}>
        <span class="folder-row__count">{props.count}</span>
      </Show>
    </button>
  );
}

function FolderRowCustom(props: {
  folder: FolderItem;
  active: boolean;
  highlight: boolean;
  count: number;
  onClick: () => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (sessionId: string) => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onPin: () => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [menuOpen, setMenuOpen] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  // Close the right-click menu when the user clicks anywhere outside it.
  // The listener is attached only while the menu is open so we don't pay for
  // it on every row.
  createEffect(() => {
    if (!menuOpen()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.folder-row__menu')) return;
      if (t?.closest('.folder-row') && t.closest('.folder-row') === refEl) return;
      setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onEsc);
    }, 0);
    onCleanup(() => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    });
  });

  let refEl: HTMLButtonElement | undefined;

  function handleDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const sessionId = e.dataTransfer?.getData(DRAG_MIME);
    if (sessionId) void props.onDrop(sessionId);
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen((v) => !v);
  }

  function beginRename(e?: MouseEvent) {
    e?.stopPropagation();
    setMenuOpen(false);
    setDraft(props.folder.name);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  }

  function commitRename() {
    const value = draft().trim();
    setEditing(false);
    if (value && value !== props.folder.name) {
      props.onRename(value);
    }
  }

  function handleDelete(e?: MouseEvent) {
    e?.stopPropagation();
    setMenuOpen(false);
    props.onDelete();
  }

  function handlePin(e?: MouseEvent) {
    e?.stopPropagation();
    setMenuOpen(false);
    props.onPin();
  }

  return (
    <button
      ref={refEl}
      class={`folder-row${props.active ? ' folder-row--active' : ''}${props.highlight ? ' folder-row--drop' : ''}`}
      onClick={(e) => {
        if (editing() || menuOpen()) {
          e.stopPropagation();
          return;
        }
        props.onClick();
      }}
      onDblClick={beginRename}
      onContextMenu={handleContextMenu}
      onDragEnter={() => props.onDragEnter()}
      onDragLeave={() => props.onDragLeave()}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      title="Right-click for menu · double-click to rename"
    >
      <Show
        when={editing()}
        fallback={
          <span class="folder-row__label">
            <Show when={props.folder.pinned}>
              <span class="folder-row__pin" title="Pinned">
                ★
              </span>
            </Show>
            {props.folder.name}
          </span>
        }
      >
        <input
          ref={inputRef}
          class="folder-row__input"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      </Show>
      <span class="folder-row__count">{props.count}</span>
      <Show when={menuOpen()}>
        <div class="folder-row__menu" onClick={(e) => e.stopPropagation()}>
          <button class="folder-row__menu-item" onClick={handlePin}>
            {props.folder.pinned ? 'Unpin' : 'Pin to top'}
          </button>
          <button class="folder-row__menu-item" onClick={beginRename}>
            Rename
          </button>
          <button
            class="folder-row__menu-item folder-row__menu-item--danger"
            onClick={handleDelete}
          >
            Delete
          </button>
          <button
            class="folder-row__menu-item"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(false);
            }}
          >
            Cancel
          </button>
        </div>
      </Show>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

function SessionRow(props: {
  session: SessionItem;
  onClose: () => void;
  onHover: (s: SessionItem) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [opening, setOpening] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const agents = createMemo(() => claudeAgents());

  let inputRef: HTMLInputElement | undefined;
  let rowRef: HTMLDivElement | undefined;

  // Close the right-click menu when the user clicks anywhere outside — the
  // listener is only attached while the menu is open.
  createEffect(() => {
    if (!menuOpen()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.session-item__menu')) return;
      if (rowRef && t && rowRef.contains(t)) return;
      setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const tm = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onEsc);
    }, 0);
    onCleanup(() => {
      clearTimeout(tm);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    });
  });

  // Load persisted launch settings for this session (defaults to opus-4.7 + no flags)
  const [settings, setSettings] = createSignal<LaunchSettings>({
    agentId: 'claude-opus-4-7',
    extraFlags: [],
    skipPermissions: false,
  });
  onMount(async () => {
    const saved = await loadLaunchSettings(props.session.sessionId);
    if (saved) setSettings(saved);
  });

  function startEdit() {
    setDraft(props.session.title);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  }

  async function handleResume(e: MouseEvent) {
    e.stopPropagation();
    if (opening()) return;
    setOpening(true);
    try {
      openChatFromSession(props.session, settings());
      // Stay on History: the layout auto-compacts (folders + sessions rail
      // on the left, chats grid on the right). User explicitly asked for
      // the side-by-side view — do NOT jump to a full-screen Chats tab.
    } catch (err) {
      console.error('[SessionRow] openChat failed:', err);
    } finally {
      setOpening(false);
    }
  }

  async function persistSettings(next: LaunchSettings) {
    setSettings(next);
    await saveLaunchSettings(props.session.sessionId, next);
  }

  async function commitEdit() {
    const value = draft().trim();
    setEditing(false);
    if (value !== props.session.title) {
      await renameSessionLocal(props.session.sessionId, value);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitEdit();
    }
    if (e.key === 'Escape') {
      setEditing(false);
    }
  }

  function handleDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    // Only the custom mime so the global GitHub-URL DropOverlay does not fire
    // (it triggers on text/plain or text/uri-list).
    e.dataTransfer.setData(DRAG_MIME, props.session.sessionId);
    e.dataTransfer.effectAllowed = 'copy';

    // Compact ghost image: a small chip with the session title (instead of
    // the huge default screenshot of the whole row which blocks the cursor).
    const ghost = document.createElement('div');
    ghost.className = 'session-drag-ghost';
    ghost.textContent = props.session.title.slice(0, 40);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 10, 10);
    // Defer removal until after the browser snapshots the element.
    setTimeout(() => ghost.remove(), 0);
  }

  /** Last non-empty path segment — used as a compact "project" label. */
  function basename(p: string): string {
    return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  }

  async function handleRemoveFromFolder(folderId: string, e: MouseEvent) {
    e.stopPropagation();
    await removeSessionFromFolderAction(props.session.sessionId, folderId);
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen((v) => !v);
  }

  function handleHideFromView(e: MouseEvent) {
    e.stopPropagation();
    setMenuOpen(false);
    hideSession(props.session.sessionId);
  }

  async function handleDeletePermanent(e: MouseEvent) {
    e.stopPropagation();
    setMenuOpen(false);
    const ok = window.confirm(
      `Permanently delete session JSONL file?\n\n${props.session.filePath}\n\nThis removes the file from disk AND all local metadata (alias, folder, launch settings). Cannot be undone.`,
    );
    if (!ok) return;
    try {
      await invoke(IPC.DeleteSessionFile, {
        sessionId: props.session.sessionId,
        filePath: props.session.filePath,
      });
      // Also hide locally in case the in-memory list doesn't refresh instantly
      hideSession(props.session.sessionId);
    } catch (err) {
      window.alert(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div
      ref={rowRef}
      class={`session-item${editing() ? ' session-item--editing' : ''}`}
      draggable={!editing()}
      onDragStart={handleDragStart}
      onMouseEnter={() => props.onHover(props.session)}
      onClick={(e) => {
        if (editing() || menuOpen()) {
          e.stopPropagation();
          return;
        }
        void handleResume(e);
      }}
      onDblClick={(e) => {
        e.stopPropagation();
        startEdit();
      }}
      onContextMenu={handleContextMenu}
      title="Click to resume · double-click to rename · right-click for delete menu"
    >
      <div class="session-item__title-row">
        <Show
          when={editing()}
          fallback={<span class="session-item__title">{props.session.title}</span>}
        >
          <input
            ref={inputRef}
            class="session-item__title-input"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onBlur={() => void commitEdit()}
            onClick={(e) => e.stopPropagation()}
          />
        </Show>
        <span class="session-item__date">{props.session.date}</span>
        <select
          class="session-item__version"
          value={settings().agentId}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            void persistSettings({ ...settings(), agentId: e.currentTarget.value });
          }}
          title="CLI version to resume with"
        >
          <For each={agents()}>
            {(a) => <option value={a.id}>{a.name.replace(/^Claude Code\s*/, '')}</option>}
          </For>
        </select>
        <button
          class="session-item__gear"
          onClick={(e) => {
            e.stopPropagation();
            setShowSettings((v) => !v);
          }}
          title="Launch options (flags, skip permissions)"
        >
          ⚙
        </button>
        <button
          class="session-item__resume"
          onClick={handleResume}
          disabled={opening()}
          title={`Resume with ${settings().agentId}`}
        >
          {opening() ? '…' : '▶'}
        </button>
      </div>
      <Show when={props.session.description}>
        {(desc) => <div class="session-item__desc">{desc()}</div>}
      </Show>
      <div class="session-item__meta">
        <Show when={props.session.folderIds.length > 0}>
          <div class="session-item__tags">
            <For each={props.session.folderIds}>
              {(fid) => {
                const folder = folders().find((f) => f.id === fid);
                if (!folder) return null;
                return (
                  <span class="session-tag" title="Click × to remove from folder">
                    <span>{folder.name}</span>
                    <button
                      class="session-tag__x"
                      onClick={(e) => void handleRemoveFromFolder(fid, e)}
                    >
                      ×
                    </button>
                  </span>
                );
              }}
            </For>
          </div>
        </Show>
        <span class="session-item__project" title={props.session.projectPath}>
          {basename(props.session.projectPath)}
        </span>
      </div>
      <Show when={menuOpen()}>
        <div class="session-item__menu" onClick={(e) => e.stopPropagation()}>
          <button class="session-item__menu-item" onClick={handleHideFromView}>
            Delete from view
          </button>
          <button
            class="session-item__menu-item session-item__menu-item--danger"
            onClick={handleDeletePermanent}
          >
            Delete permanently (from disk)
          </button>
          <button
            class="session-item__menu-item"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(false);
            }}
          >
            Cancel
          </button>
        </div>
      </Show>
      <Show when={showSettings()}>
        <div class="session-item__launch-options" onClick={(e) => e.stopPropagation()}>
          <label class="launch-option">
            <input
              type="checkbox"
              checked={settings().skipPermissions}
              onChange={(e) =>
                void persistSettings({ ...settings(), skipPermissions: e.currentTarget.checked })
              }
            />
            <span>Skip permissions (--dangerously-skip-permissions)</span>
          </label>
          <label class="launch-option launch-option--full">
            <span class="launch-option__label">Extra flags (one per line)</span>
            <textarea
              class="launch-option__textarea"
              rows={3}
              value={settings().extraFlags.join('\n')}
              placeholder="--model sonnet&#10;--verbose"
              onInput={(e) =>
                void persistSettings({
                  ...settings(),
                  extraFlags: e.currentTarget.value
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <div class="launch-option__hint">
            Saved per-session. Applied automatically every time you resume this chat.
          </div>
        </div>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview pane (right column)
// ---------------------------------------------------------------------------

function PreviewPane(props: { session: SessionItem | null }) {
  const [preview] = createResource(
    () => props.session,
    async (s) => {
      if (!s) return null;
      try {
        return await fetchSessionPreview(s.filePath);
      } catch {
        return null;
      }
    },
  );

  function cleanLine(line: string): string {
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        summary?: string;
        message?: { role?: string; content?: unknown };
      };
      if (obj.type === 'summary' && typeof obj.summary === 'string') {
        return `[summary] ${obj.summary}`;
      }
      if (obj.type === 'user' && obj.message?.content) {
        const c = obj.message.content;
        if (typeof c === 'string') return `[user] ${c.replace(/<[^>]+>/g, '').slice(0, 300)}`;
        if (Array.isArray(c)) {
          for (const part of c) {
            if (part && typeof part === 'object') {
              const p = part as { type?: string; text?: string };
              if (p.type === 'text' && p.text) return `[user] ${p.text.slice(0, 300)}`;
            }
          }
        }
      }
      if (obj.type === 'assistant' && obj.message?.content) {
        const c = obj.message.content;
        if (Array.isArray(c)) {
          for (const part of c) {
            if (part && typeof part === 'object') {
              const p = part as { type?: string; text?: string };
              if (p.type === 'text' && p.text) return `[asst] ${p.text.slice(0, 300)}`;
            }
          }
        }
      }
      return '';
    } catch {
      return '';
    }
  }

  return (
    <aside class="preview-pane">
      <Show
        when={props.session}
        fallback={
          <div class="preview-pane__empty">Hover a session to preview its first/last messages.</div>
        }
      >
        {(s) => (
          <>
            <div class="preview-pane__head">
              <div class="preview-pane__title">{s().title}</div>
              <div class="preview-pane__meta">
                {s().date} · {s().sessionId.slice(0, 8)}
              </div>
              <div class="preview-pane__path" title={s().filePath}>
                <span class="preview-pane__path-label">JSONL</span>
                <span class="preview-pane__path-value">{s().filePath}</span>
              </div>
              <div class="preview-pane__path" title={s().projectPath}>
                <span class="preview-pane__path-label">cwd</span>
                <span class="preview-pane__path-value">{s().projectPath}</span>
              </div>
            </div>
            <div class="preview-pane__body">
              <Show when={preview()} fallback={<div class="preview-pane__loading">Loading…</div>}>
                {(p) => (
                  <>
                    <div class="preview-pane__section">
                      <div class="preview-pane__section-label">First messages</div>
                      <For each={p().firstLines.map(cleanLine).filter(Boolean).slice(0, 4)}>
                        {(line) => <div class="preview-pane__line">{line}</div>}
                      </For>
                    </div>
                    <Show when={p().lastLines.length > 0}>
                      <div class="preview-pane__section">
                        <div class="preview-pane__section-label">Last messages</div>
                        <For each={p().lastLines.map(cleanLine).filter(Boolean).slice(-4)}>
                          {(line) => <div class="preview-pane__line">{line}</div>}
                        </For>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </aside>
  );
}
