/**
 * ChatsArea.tsx
 * Full-main view for all open History chats. Tabs on top, active xterm below.
 * Completely independent of parallel-code's Branches/worktree system.
 */

import { For, Show } from 'solid-js';
import { activeChatId, setActiveChatId, closeChat, openChats, type Chat } from '../store/chats';
import { store } from '../store/store';
import { TerminalView } from './TerminalView';
import './ChatsArea.css';

export function ChatsArea() {
  const visibleChats = () => openChats();
  const current = () => visibleChats().find((c) => c.id === activeChatId()) ?? visibleChats()[0];

  return (
    <div class="chats-area">
      <div class="chats-area__tabs">
        <For each={visibleChats()} fallback={<span class="chats-area__empty">No open chats</span>}>
          {(chat) => (
            <button
              class={`chat-tab ${activeChatId() === chat.id ? 'chat-tab--active' : ''}`}
              onClick={() => setActiveChatId(chat.id)}
              title={`${chat.cwd} · ${chat.agentDefId}`}
            >
              <span class="chat-tab__name">
                {chat.title.length > 28 ? chat.title.slice(0, 26) + '…' : chat.title}
              </span>
              <span
                class="chat-tab__close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeChat(chat.id);
                }}
                title="Close chat"
              >
                ×
              </span>
            </button>
          )}
        </For>
      </div>

      <div class="chats-area__body">
        <Show
          when={current()}
          fallback={
            <div class="chats-area__hint">
              Open a session from <b>History</b> to start a chat here. Chats run independently
              of Branches — closing one never touches the others.
            </div>
          }
        >
          {(chat) => <ActiveChatPane chat={chat()} />}
        </Show>
      </div>
    </div>
  );
}

function ActiveChatPane(_props: { chat: Chat }) {
  // TerminalView is mounted once per chat id; switching tabs hides/shows via CSS
  // so the pty doesn't get killed on tab switch.
  return (
    <div class="chats-area__panes">
      <For each={openChats()}>
        {(chat) => {
          const agent = () => store.agents[chat.agentId];
          const task = () => store.tasks[chat.id];
          return (
            <div class={`chat-pane ${activeChatId() === chat.id ? 'chat-pane--active' : ''}`}>
              <Show when={agent() && task()}>
                <TerminalView
                  taskId={chat.id}
                  agentId={chat.agentId}
                  command={agent()?.def.command ?? ''}
                  args={agent()?.def.args ?? []}
                  cwd={task()?.worktreePath ?? chat.cwd}
                  env={{}}
                  isShell={false}
                  fontSize={13}
                />
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
