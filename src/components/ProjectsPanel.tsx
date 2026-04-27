/**
 * ProjectsPanel.tsx
 * Main view for the "Projects" tab. Left rail = list of projects; center =
 * sessions that belong to the active project. Opening a project resumes
 * every chat it owns at once — this is the "workspace" UX the user asked for.
 *
 * Sessions are added to a project by drag-drop from the History list or
 * via the session row's right-click menu. One session lives in at most one
 * project (replacing its previous assignment).
 */

import { createSignal, createMemo, For, Show, onMount } from 'solid-js';
import {
  projects,
  activeProjectId,
  sessionProjectMap,
  loadProjects,
  createProject,
  renameProject,
  deleteProject,
  assignSessionToProject,
  openProject,
  leaveProject,
  type Project,
} from '../store/chat-projects';
import { sessions, loadSessions } from '../store/sessions-history';
import { openChatsInProject, openFreshChat } from '../store/chats';
import { ChatsGrid } from './ChatsGrid';
import { DragMime, dragHasMime } from '../lib/drag-mime';
import './ProjectsPanel.css';

export function ProjectsPanel() {
  const [creating, setCreating] = createSignal(false);
  const [newName, setNewName] = createSignal('');
  const [dragOverProjectId, setDragOverProjectId] = createSignal<string | null>(null);
  let newNameRef: HTMLInputElement | undefined;
  // Enter+blur both fire commitCreate; this flag makes the second call a no-op.
  let committing = false;

  onMount(() => {
    void loadProjects();
    if (sessions().length === 0) void loadSessions();
  });

  const active = createMemo(() => projects().find((p) => p.id === activeProjectId()) ?? null);

  const sessionsInActive = createMemo(() => {
    const a = active();
    if (!a) return [];
    const map = sessionProjectMap();
    return sessions().filter((s) => map[s.sessionId] === a.id);
  });

  const unassignedCount = createMemo(() => {
    const map = sessionProjectMap();
    return sessions().filter((s) => !map[s.sessionId]).length;
  });

  /** Live chats whose projectId === active project. Re-evaluated reactively
   *  so opening / closing chats updates the visible tile list immediately. */
  const projectChats = createMemo(() => {
    const a = active();
    return a ? openChatsInProject(a.id) : [];
  });

  function beginCreate() {
    setCreating(true);
    setNewName('');
    requestAnimationFrame(() => newNameRef?.focus());
  }

  async function commitCreate() {
    // Set the lock first, before any await AND before any early return, so
    // the onBlur call that fires when Enter unmounts the input can't slip in
    // another createProject for the same name.
    if (committing) return;
    committing = true;
    try {
      const name = newName().trim();
      setCreating(false);
      setNewName('');
      if (!name) return;
      const created = await createProject(name);
      if (created) openProject(created.id).catch(() => undefined);
    } finally {
      committing = false;
    }
  }

  function cancelCreate() {
    setCreating(false);
    setNewName('');
  }

  function handleProjectDragOver(e: DragEvent, projectId: string) {
    if (!dragHasMime(e, DragMime.SessionId)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    setDragOverProjectId(projectId);
  }

  function handleProjectDrop(e: DragEvent, projectId: string) {
    e.preventDefault();
    setDragOverProjectId(null);
    const sid = e.dataTransfer?.getData(DragMime.SessionId);
    if (sid) void assignSessionToProject(sid, projectId);
  }

  return (
    <div class="projects-panel">
      <aside class="projects-rail">
        <div class="projects-rail__head">
          <span class="projects-rail__title">Projects</span>
          <button
            class="projects-rail__btn"
            onClick={beginCreate}
            title="New project"
            disabled={creating()}
          >
            +
          </button>
        </div>

        <Show when={creating()}>
          <div class="projects-rail__create">
            <input
              ref={newNameRef}
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              onBlur={() => void commitCreate()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitCreate();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelCreate();
                }
              }}
              placeholder="Project name…"
              class="projects-rail__create-input"
              spellcheck={false}
            />
          </div>
        </Show>

        <button
          class={`projects-rail__row${activeProjectId() === null ? ' projects-rail__row--active' : ''}`}
          onClick={() => leaveProject()}
          title="Show unassigned sessions (no active project)"
        >
          <span class="projects-rail__row-name">No project</span>
          <span class="projects-rail__row-count">{unassignedCount()}</span>
        </button>

        <For each={projects()}>
          {(p) => (
            <ProjectRow
              project={p}
              dragOver={dragOverProjectId() === p.id}
              onDragOver={(e) => handleProjectDragOver(e, p.id)}
              onDragLeave={() => {
                if (dragOverProjectId() === p.id) setDragOverProjectId(null);
              }}
              onDrop={(e) => handleProjectDrop(e, p.id)}
            />
          )}
        </For>
      </aside>

      <section class="projects-main">
        <Show
          when={active()}
          fallback={
            <div class="projects-main__empty">
              <p>
                Projects are workspaces. Drag sessions from the History list onto a project, then
                click the project to open all of its chats at once.
              </p>
              <Show when={projects().length === 0}>
                <button class="projects-main__cta" onClick={beginCreate}>
                  + New project
                </button>
              </Show>
            </div>
          }
        >
          {(p) => (
            <>
              <header class="projects-main__head">
                <h2 class="projects-main__title">{p().name}</h2>
                <span class="projects-main__count">
                  {projectChats().length}/{sessionsInActive().length} chats
                </span>
                <button
                  class="projects-rail__btn"
                  onClick={() => {
                    void openProject(p().id);
                  }}
                  title="Resume every saved session in this project (existing live chats stay open)"
                >
                  ▶ open all
                </button>
                <button
                  class="projects-rail__btn"
                  onClick={() => newChatInProject(p().id)}
                  title="Create a new chat tagged to this project"
                >
                  + new chat
                </button>
                <button
                  class="projects-rail__btn"
                  onClick={() => leaveProject()}
                  title="Close this project view (chats keep running)"
                >
                  ✕
                </button>
              </header>
              {/* Chats are filtered to only ones tagged with this project id —
                  flipping projects here doesn't kill any chat anywhere. */}
              <div class="projects-main__grid">
                <ChatsGrid chats={projectChats} />
              </div>
            </>
          )}
        </Show>
      </section>
    </div>
  );

  function newChatInProject(projectId: string) {
    // Use the project's first session cwd as the cwd for new chats — that
    // matches what the user almost always wants (the project's repo). If
    // no sessions yet, fall back to home (handled by pty.ts when cwd='').
    const first = sessionsInActive()[0];
    const cwd = first?.projectPath ?? '';
    openFreshChat({
      cwd,
      title: 'New chat',
      projectId,
    });
  }
}

function ProjectRow(props: {
  project: Project;
  dragOver: boolean;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  function beginRename(e: MouseEvent) {
    e.stopPropagation();
    setDraft(props.project.name);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  }

  async function commit() {
    const value = draft().trim();
    setEditing(false);
    if (value && value !== props.project.name) {
      await renameProject(props.project.id, value);
    }
  }

  async function handleDelete(e: MouseEvent) {
    e.stopPropagation();
    if (!window.confirm(`Delete project "${props.project.name}"? Chat sessions are kept.`)) return;
    await deleteProject(props.project.id);
  }

  const isActive = () => activeProjectId() === props.project.id;

  return (
    // <div role="button"> rather than <button> so we can nest the delete
    // × button — nested <button>s are invalid HTML and Solid's event
    // delegation throws $$click errors on them.
    <div
      role="button"
      tabIndex={0}
      class={`projects-rail__row${isActive() ? ' projects-rail__row--active' : ''}${props.dragOver ? ' projects-rail__row--drop' : ''}`}
      onClick={() => {
        if (editing()) return;
        void openProject(props.project.id);
      }}
      onDblClick={beginRename}
      onDragOver={(e) => props.onDragOver(e)}
      onDragLeave={() => props.onDragLeave()}
      onDrop={(e) => props.onDrop(e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !editing()) void openProject(props.project.id);
      }}
      title="Click to open · double-click to rename"
    >
      <Show
        when={editing()}
        fallback={<span class="projects-rail__row-name">{props.project.name}</span>}
      >
        <input
          ref={inputRef}
          class="projects-rail__row-input"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => void commit()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      </Show>
      <button
        class="projects-rail__row-x"
        onClick={(e) => void handleDelete(e)}
        title="Delete project"
      >
        ×
      </button>
    </div>
  );
}
