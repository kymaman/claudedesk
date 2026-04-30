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

import { createSignal, createMemo, createEffect, For, Show, onMount } from 'solid-js';
import { mainView } from '../store/mainView';
import {
  projects,
  activeProjectId,
  sessionProjectMap,
  loadProjects,
  createProject,
  assignSessionToProject,
  openProject,
  leaveProject,
  persistPendingChat,
} from '../store/chat-projects';
import { sessions, loadSessions } from '../store/sessions-history';
import { openChats, openFreshChat } from '../store/chats';
import { ChatsGrid } from './ChatsGrid';
import { ProjectRow } from './ProjectRow';
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

  // Re-fetch projects whenever the user navigates back to the Projects
  // tab. Pre-fix the panel was rendered via <Show>, so navigating to it
  // remounted and re-ran loadProjects(); we now keep it mounted via
  // display:none, so the auto-refresh has to be reactive instead.
  // Catches: another window / a CLI flow / a test creating a project via
  // IPC and the rail picking it up on the next tab switch.
  createEffect(() => {
    if (mainView() === 'projects') void loadProjects();
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

  /** Every chat tagged with ANY project — kept mounted as a single pool so
   *  switching the active project becomes a CSS visibility flip rather than
   *  an unmount cascade that would kill PTYs. */
  const allProjectChats = createMemo(() => openChats().filter((c) => c.projectId !== null));
  /** Visibility filter passed to ChatsGrid: only the active project's tiles
   *  show; the rest stay in the DOM with display:none, terminals alive. */
  const isVisibleInActive = (c: { projectId: string | null }) => c.projectId === active()?.id;
  /** Counter for the header — only chats actually visible right now. */
  const visibleProjectChatCount = createMemo(
    () => allProjectChats().filter(isVisibleInActive).length,
  );

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
                  {visibleProjectChatCount()}/{sessionsInActive().length} chats
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
              {/* All project-tagged chats live in a single grid so the DOM
                  tree never loses tiles on project switch; ChatsGrid hides
                  non-active ones via display:none. PTYs stay alive. */}
              <div class="projects-main__grid">
                <ChatsGrid chats={allProjectChats} visible={isVisibleInActive} />
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
    const chat = openFreshChat({
      cwd,
      title: 'New chat',
      projectId,
    });
    // Persist intent so this chat survives app restarts. The pending row
    // is keyed by the chat's id — we drop it on close.
    if (chat) {
      void persistPendingChat({
        id: chat.id,
        projectId,
        cwd: chat.cwd,
        agentId: chat.agentDefId,
        title: chat.title,
        extraFlags: chat.settings.extraFlags,
        skipPermissions: chat.settings.skipPermissions,
      });
    }
  }
}
