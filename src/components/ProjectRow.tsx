/**
 * ProjectRow.tsx
 * Single row in the Projects rail. Owns its own rename/edit state and the
 * inline delete confirmation; the parent only feeds it drag-state and the
 * Project record. Extracted from ProjectsPanel.tsx (which was 334 LOC, half
 * of which was this row component).
 *
 * No behaviour changes vs the inline version — same DOM, same handlers, same
 * event ordering. Only the file boundary changed.
 */

import { createSignal, Show } from 'solid-js';
import {
  activeProjectId,
  deleteProject,
  openProject,
  renameProject,
  type Project,
} from '../store/chat-projects';

export interface ProjectRowProps {
  project: Project;
  dragOver: boolean;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}

export function ProjectRow(props: ProjectRowProps) {
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
