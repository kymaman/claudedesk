/**
 * TopSwitcher.tsx
 * Top navigation strip. Two rows:
 *   1. View switch — History (default) · Branches · Agents
 *   2. Active-chats chips — always visible, lets you hop between open tasks
 *      regardless of which view is active.
 */

import { For, Show } from 'solid-js';
import { store, setActiveTask, toggleNewTaskDialog } from '../store/store';
import { mainView, setMainView, type MainView } from '../store/mainView';
import {
  openChats,
  openChatsInProject,
  activeChatId,
  setActiveChatId,
  closeChat,
  reorderChat,
} from '../store/chats';
import { activeProjectId } from '../store/chat-projects';
import { assistantOpen, toggleAssistant } from '../store/assistant';
import { DragMime, acceptDrag, handleDrop, setDragPayload } from '../lib/drag-mime';
import './TopSwitcher.css';

interface NavItem {
  id: MainView;
  label: string;
  hotkey: string;
}

const NAV: NavItem[] = [
  { id: 'history', label: 'History', hotkey: '⌃H' },
  { id: 'chats', label: 'Chats', hotkey: '⌃K' },
  { id: 'projects', label: 'Projects', hotkey: '⌃P' },
  { id: 'branches', label: 'Branches', hotkey: '⌃⇧B' },
  { id: 'agents', label: 'Agents', hotkey: '⌃J' },
];

export function TopSwitcher() {
  const activeTasks = () =>
    store.taskOrder
      .map((id) => store.tasks[id])
      .filter((t): t is NonNullable<typeof t> => Boolean(t));

  return (
    <div class="top-switcher">
      <div class="top-switcher__nav">
        <For each={NAV}>
          {(item) => (
            <button
              class={`ts-nav ${mainView() === item.id ? 'ts-nav--active' : ''}`}
              onClick={() => setMainView(item.id)}
              title={`${item.label} (${item.hotkey})`}
            >
              {item.label}
              <Show when={item.id === 'chats' && openChats().length > 0}>
                <span class="ts-mode__count">{openChats().length}</span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <div class="top-switcher__sep" />

      <div class="top-switcher__chats" title="Open chats">
        {/* Filter chips by current view: in Projects mode, show only the
            active project's chats so we don't bleed unrelated workspaces.
            In any other view, show every project-less chat. The chips are
            draggable for reordering. */}
        <For
          each={
            mainView() === 'projects'
              ? openChatsInProject(activeProjectId())
              : openChatsInProject(null)
          }
        >
          {(chat) => (
            <button
              class={`ts-chip ${activeChatId() === chat.id ? 'ts-chip--active' : ''}`}
              draggable={true}
              onDragStart={(e) => setDragPayload(e, DragMime.ChatId, chat.id)}
              onDragOver={acceptDrag(DragMime.ChatId)}
              onDrop={handleDrop(DragMime.ChatId, (fromId) => {
                if (fromId === chat.id) return;
                const targetIndex = openChats().findIndex((c) => c.id === chat.id);
                if (targetIndex >= 0) reorderChat(fromId, targetIndex);
              })}
              onClick={() => {
                setActiveChatId(chat.id);
                if (mainView() !== 'projects') setMainView('chats');
              }}
              title={`${chat.title} · ${chat.cwd} · drag to reorder`}
            >
              <span class="ts-chip__name">
                {chat.title.length > 22 ? chat.title.slice(0, 20) + '…' : chat.title}
              </span>
              <span
                class="ts-chip__close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeChat(chat.id);
                }}
              >
                ×
              </span>
            </button>
          )}
        </For>

        {/* Branches tasks — only when on Branches view to reduce clutter */}
        <Show when={mainView() === 'branches'}>
          <For each={activeTasks()}>
            {(task) => (
              <button
                class={`ts-chip ${store.activeTaskId === task.id ? 'ts-chip--active' : ''}`}
                onClick={() => setActiveTask(task.id)}
                title={`Branch task: ${task.name} · ${task.branchName}`}
              >
                <span class="ts-chip__name">
                  {task.name.length > 22 ? task.name.slice(0, 20) + '…' : task.name}
                </span>
              </button>
            )}
          </For>
          <button
            class="ts-chip ts-chip--add"
            onClick={() => toggleNewTaskDialog(true)}
            title="New Branches task (worktree)"
          >
            + Task
          </button>
        </Show>

        <Show when={openChats().length === 0 && mainView() !== 'branches'}>
          <span class="ts-empty">No open chats — click ▶ on a session to start one</span>
        </Show>
      </div>

      <button
        class={`ts-settings ts-ask${assistantOpen() ? ' ts-ask--on' : ''}`}
        onClick={() => toggleAssistant()}
        title="Ask — search across all your chats"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Zm-.69 3.37 2.41 2.41a.75.75 0 1 1-1.06 1.06l-2.41-2.41a5 5 0 1 1 1.06-1.06Z" />
        </svg>
      </button>

      <button
        class="ts-settings"
        onClick={() => setMainView('agents')}
        title="Settings — terminal defaults, agents, extra folders (Ctrl+J)"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.41 1.25a.75.75 0 0 1 1.18 0l.57.72c.23.29.6.43.96.36l.9-.18a.75.75 0 0 1 .88.75v.92c0 .37.2.7.53.89l.78.45a.75.75 0 0 1 .32 1.07l-.5.82a.93.93 0 0 0 0 .96l.5.82a.75.75 0 0 1-.32 1.07l-.78.45a.93.93 0 0 0-.53.89v.92a.75.75 0 0 1-.88.75l-.9-.18a1 1 0 0 0-.96.36l-.57.72a.75.75 0 0 1-1.18 0l-.57-.72a1 1 0 0 0-.96-.36l-.9.18a.75.75 0 0 1-.88-.75v-.92a.93.93 0 0 0-.53-.89l-.78-.45a.75.75 0 0 1-.32-1.07l.5-.82a.93.93 0 0 0 0-.96l-.5-.82a.75.75 0 0 1 .32-1.07l.78-.45a.93.93 0 0 0 .53-.89V2.9a.75.75 0 0 1 .88-.75l.9.18c.36.07.73-.07.96-.36l.57-.72ZM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
        </svg>
      </button>
    </div>
  );
}
