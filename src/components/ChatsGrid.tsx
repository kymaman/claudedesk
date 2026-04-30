/**
 * ChatsGrid.tsx
 * Responsive tile layout for open chats. 1 → 12 per-window, after which a
 * banner suggests opening a new window. Each tile hosts its own xterm via
 * TerminalView. Tile selection ring shows the active chat.
 */

import { For, Show, createMemo, createSignal, onMount, onCleanup } from 'solid-js';
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
import { DragMime, acceptDrag, dragHasMime, handleDrop, setDragPayload } from '../lib/drag-mime';
import { markDirty } from '../lib/terminalFitManager';
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
 * `chats` is the full population the grid is responsible for keeping
 * mounted. `visible`, when present, decides which subset of those chats
 * is actually shown — non-matching tiles get `display:none` instead of
 * being unmounted, so their xterm + PTY survive the toggle.
 *
 * The projects view passes ALL project-tagged chats as `chats` and the
 * active project's filter as `visible` — flipping projects becomes a
 * pure CSS swap. Without this split the Solid `<For>` removes tiles on
 * project switch, TerminalView.onCleanup fires, and the PTY dies.
 */
export function ChatsGrid(props: { chats?: () => Chat[]; visible?: (c: Chat) => boolean } = {}) {
  const list = createMemo(() => (props.chats ? props.chats() : openChats()));
  const isVisible = (c: Chat) => (props.visible ? props.visible(c) : true);
  const visibleCount = createMemo(() => list().filter(isVisible).length);
  const cols = createMemo(() => columnsForCount(visibleCount()));

  return (
    <div class="chats-grid-wrap">
      <Show when={visibleCount() === 0}>
        <div class="chats-grid__empty">
          Click ▶ on a session in History to open a chat here. Up to
          {' ' + MAX_CHATS_PER_WINDOW} chats fit in this window; after that a new window opens.
        </div>
      </Show>
      <div
        class="chats-grid"
        style={{
          'grid-template-columns': `repeat(${cols()}, minmax(0, 1fr))`,
          // Keep the grid in the DOM even when nothing is visible — the
          // <Show> above renders the empty hint on top. Hiding via display
          // when there are no visible tiles avoids a stray empty grid box
          // showing between the hint and the parent container.
          display: visibleCount() === 0 ? 'none' : 'grid',
        }}
      >
        <For each={list()}>{(chat) => <ChatTile chat={chat} hidden={!isVisible(chat)} />}</For>
      </div>
    </div>
  );
}

function ChatTile(props: { chat: Chat; hidden?: boolean }) {
  const isActive = () => activeChatId() === props.chat.id;
  // True while another tile is being dragged over this one — drives the
  // drop-target ring so the user can see exactly where the drop will land.
  const [isDropTarget, setIsDropTarget] = createSignal(false);

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
  const acceptHandler = acceptDrag(DragMime.ChatId);
  function onTileDragOver(e: DragEvent) {
    if (!dragHasMime(e, DragMime.ChatId)) return;
    acceptHandler(e);
    setIsDropTarget(true);
  }
  function onTileDragLeave() {
    setIsDropTarget(false);
  }
  // The drop handler closes over props.chat.id — Solid's lint flags
  // factory-built handlers as "untracked", but DOM event listeners read
  // the current props via the closure on each event so this is fine.
  // eslint-disable-next-line solid/reactivity
  const onTileDrop = handleDrop(DragMime.ChatId, (fromId) => {
    setIsDropTarget(false);
    if (fromId === props.chat.id) return;
    const targetIndex = openChats().findIndex((c) => c.id === props.chat.id);
    if (targetIndex >= 0) reorderChat(fromId, targetIndex);
  });

  // Observe the tile body so xterm refits when the grid reflows (e.g. when a
  // second chat is opened and tiles go from 1-wide to 2-wide).
  //
  // Previously this dispatched a `window.resize` event, which terminalFitManager
  // does NOT listen to — so the fit was a no-op and the user saw "text in a
  // narrow column on the right" because xterm cols were stuck at the initial
  // (small / pre-layout) width. Now we call markDirty(chat.id) directly,
  // which queues a fit on the next animation frame in the manager.
  let bodyRef!: HTMLDivElement;
  onMount(() => {
    if (!bodyRef || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => markDirty(props.chat.id));
    ro.observe(bodyRef);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div
      class={`chat-tile${isActive() ? ' chat-tile--active' : ''}${
        isDropTarget() ? ' chat-tile--drop-target' : ''
      }`}
      // `hidden` toggles display:none. The DOM stays put, xterm canvas
      // keeps its rendered state, and onCleanup never runs — so the PTY
      // survives a project / tab switch.
      style={props.hidden ? { display: 'none' } : undefined}
      onClick={() => setActiveChatId(props.chat.id)}
      onDragOver={onTileDragOver}
      onDragLeave={onTileDragLeave}
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
          // The active tile auto-focuses on mount AND every time it
          // becomes active (TerminalView's createEffect on isFocused).
          // autoFocus on first mount handles the very first chat open.
          autoFocus={isActive()}
          isFocused={isActive()}
        />
      </div>
    </div>
  );
}
