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
import './TopSwitcher.css';

interface NavItem {
  id: MainView;
  label: string;
  hotkey: string;
}

const NAV: NavItem[] = [
  { id: 'history', label: 'History', hotkey: '⌃H' },
  { id: 'branches', label: 'Branches', hotkey: '⌃B' },
  { id: 'agents', label: 'Agents', hotkey: '⌃A' },
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
            </button>
          )}
        </For>
      </div>

      <div class="top-switcher__sep" />

      <div class="top-switcher__chats" title="Open chats">
        <For each={activeTasks()} fallback={<span class="ts-empty">No open chats</span>}>
          {(task) => (
            <button
              class={`ts-chip ${store.activeTaskId === task.id ? 'ts-chip--active' : ''}`}
              onClick={() => {
                setActiveTask(task.id);
                setMainView('branches');
              }}
              title={`${task.name} · ${task.branchName}`}
            >
              <span class="ts-chip__name">
                {task.name.length > 24 ? task.name.slice(0, 22) + '…' : task.name}
              </span>
            </button>
          )}
        </For>
        <Show when={activeTasks().length > 0 || mainView() === 'branches'}>
          <button
            class="ts-chip ts-chip--add"
            onClick={() => {
              setMainView('branches');
              toggleNewTaskDialog(true);
            }}
            title="New chat"
          >
            + New
          </button>
        </Show>
      </div>
    </div>
  );
}
