/**
 * ChatsGrid.tsx
 * Responsive tile layout for open chats. 1 → 12 per-window, after which a
 * banner suggests opening a new window. Each tile hosts its own xterm via
 * TerminalView. Tile selection ring shows the active chat.
 */

import { For, Show, createMemo, onMount, onCleanup } from 'solid-js';
import {
  activeChatId,
  setActiveChatId,
  closeChat,
  renameChat,
  openChats,
  MAX_CHATS_PER_WINDOW,
  reorderChat,
  type Chat,
} from '../store/chats';
import { TerminalView } from './TerminalView';
import { DragMime, acceptDrag, handleDrop, setDragPayload } from '../lib/drag-mime';
import './ChatsGrid.css';

function columnsForCount(n: number): number {
  if (n <= 1) return 1;
  if (n <= 2) return 2;
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  if (n <= 9) return 3;
  return 4;
}

/**
 * Optional `chats` overrides the global open-chats list — used by the
 * Projects view, which needs to show only the chats tagged with its
 * project id while leaving every other chat alive in the background.
 */
export function ChatsGrid(props: { chats?: () => Chat[] } = {}) {
  const list = createMemo(() => (props.chats ? props.chats() : openChats()));
  const cols = createMemo(() => columnsForCount(list().length));

  return (
    <div class="chats-grid-wrap">
      <Show when={list().length === 0}>
        <div class="chats-grid__empty">
          Click ▶ on a session in History to open a chat here. Up to
          {' ' + MAX_CHATS_PER_WINDOW} chats fit in this window; after that a new window opens.
        </div>
      </Show>
      <Show when={list().length > 0}>
        <div
          class="chats-grid"
          style={{ 'grid-template-columns': `repeat(${cols()}, minmax(0, 1fr))` }}
        >
          <For each={list()}>{(chat) => <ChatTile chat={chat} />}</For>
        </div>
      </Show>
    </div>
  );
}

function ChatTile(props: { chat: Chat }) {
  const isActive = () => activeChatId() === props.chat.id;

  function onRename(e: MouseEvent) {
    e.stopPropagation();
    const current = props.chat.title;
    const next = window.prompt('Rename chat', current);
    if (next && next.trim() && next !== current) renameChat(props.chat.id, next.trim());
  }

  // Drag a tile by its header to reorder. We don't use draggable on the
  // whole tile because that would interfere with text selection inside
  // the xterm body.
  const onHeadDragStart = (e: DragEvent) => setDragPayload(e, DragMime.ChatId, props.chat.id);
  const onTileDragOver = acceptDrag(DragMime.ChatId);
  // The drop handler closes over props.chat.id — Solid's lint flags
  // factory-built handlers as "untracked", but DOM event listeners read
  // the current props via the closure on each event so this is fine.
  // eslint-disable-next-line solid/reactivity
  const onTileDrop = handleDrop(DragMime.ChatId, (fromId) => {
    if (fromId === props.chat.id) return;
    const targetIndex = openChats().findIndex((c) => c.id === props.chat.id);
    if (targetIndex >= 0) reorderChat(fromId, targetIndex);
  });

  // Observe the tile body so xterm refits when the grid reflows (e.g. when a
  // second chat is opened and tiles go from 1-wide to 2-wide).
  let bodyRef!: HTMLDivElement;
  onMount(() => {
    if (!bodyRef || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      // markDirty in terminalFitManager re-runs fit(); imported as side effect
      // via TerminalView, but we re-dispatch a window resize so the fit manager
      // picks up the tile's new size even before its internal debounce.
      window.dispatchEvent(new Event('resize'));
    });
    ro.observe(bodyRef);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div
      class={`chat-tile${isActive() ? ' chat-tile--active' : ''}`}
      onClick={() => setActiveChatId(props.chat.id)}
      onDragOver={onTileDragOver}
      onDrop={onTileDrop}
    >
      <div
        class="chat-tile__head"
        draggable={true}
        onDragStart={onHeadDragStart}
        title="Drag to reorder · double-click title to rename"
      >
        <span class="chat-tile__title" title={props.chat.cwd} onDblClick={onRename}>
          {props.chat.title}
        </span>
        <span class="chat-tile__agent">{props.chat.agentDefId.replace(/^claude-/, '')}</span>
        <button
          class="chat-tile__close"
          onClick={(e) => {
            e.stopPropagation();
            closeChat(props.chat.id);
          }}
          title="Close chat"
        >
          ×
        </button>
      </div>
      <div class="chat-tile__body" ref={bodyRef}>
        <TerminalView
          taskId={props.chat.id}
          agentId={props.chat.id}
          command={props.chat.command}
          args={props.chat.args}
          cwd={props.chat.cwd}
          env={props.chat.env}
          isShell={false}
          fontSize={13}
        />
      </div>
    </div>
  );
}
