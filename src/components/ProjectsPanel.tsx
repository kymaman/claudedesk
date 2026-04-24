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
import { openChats } from '../store/chats';
import { setMainView } from '../store/mainView';
import './ProjectsPanel.css';

const DRAG_MIME = 'application/x-claudedesk-session-id';

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
    if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverProjectId(projectId);
  }

  function handleProjectDrop(e: DragEvent, projectId: string) {
    e.preventDefault();
    setDragOverProjectId(null);
    const sid = e.dataTransfer?.getData(DRAG_MIME);
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
                <span class="projects-main__count">{sessionsInActive().length} chats</span>
                <button
                  class="projects-rail__btn"
                  onClick={() => {
                    void openProject(p().id);
                  }}
                  title="Open all chats in this project"
                >
                  ▶ open all
                </button>
                <button
                  class="projects-rail__btn"
                  onClick={() => leaveProject()}
                  title="Close this project view"
                >
                  ✕
                </button>
              </header>
              <Show
                when={openChats().length > 0}
                fallback={
                  <div class="projects-main__hint">
                    Click <strong>▶ open all</strong> to resume every chat assigned to this project.
                  </div>
                }
              >
                <div class="projects-main__hint">
                  {openChats().length} chat{openChats().length === 1 ? '' : 's'} running.{' '}
                  <button class="projects-main__cta" onClick={() => setMainView('chats')}>
                    Go to Chats tab →
                  </button>
                </div>
              </Show>
            </>
          )}
        </Show>
      </section>
    </div>
  );
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
