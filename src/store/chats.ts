/* eslint-disable solid/reactivity -- createRoot(() => createSignal(...)) is an intentional HMR-safe pattern; the tuple is destructured at the outer call site, which the linter can't see through the closure. */
/**
 * chats.ts
 * History chats are fully independent of parallel-code's tasks/worktree store.
 * We keep chat state in our own signal — nothing is written to store.tasks
 * or store.agents, so autosave/taskStatus polling/Sidebar never touch our
 * chats. Terminal spawn happens directly inside ChatsArea through TerminalView,
 * driven by the Chat record (command/args/cwd/env). Multiple chats run in
 * parallel; closing one never affects the others or any Branches task.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';
import { store } from './core';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { SessionItem } from './sessions-history';

export interface ChatLaunchSettings {
  agentId: string;
  extraFlags: string[];
  skipPermissions: boolean;
}

export interface Chat {
  /** UUID used as xterm session id + SpawnAgent agentId */
  id: string;
  /** UUID of the Claude Code session being resumed (absent for fresh chats) */
  sessionId?: string;
  /** Tab/title text */
  title: string;
  /** Working directory the CLI runs from */
  cwd: string;
  /** AgentDef used to start the chat (e.g. claude-opus-4-7) */
  agentDefId: string;
  /** Resolved command path */
  command: string;
  /** Resolved CLI arguments */
  args: string[];
  /** Env overrides (merged with terminalDefaults inside TerminalView) */
  env: Record<string, string>;
  /** Launch options the chat was started with */
  settings: ChatLaunchSettings;
  /** Project this chat belongs to (workspace isolation). null = unassigned. */
  projectId: string | null;
  createdAt: number;
  /** Last time the user interacted with this chat (became active). Used to
   *  sort restored chats on app startup so the most-recently-used appears
   *  first — matches the user's expectation that "the chat I was in last
   *  is on top when I reopen the app". */
  lastActiveAt: number;
  /** Marked true when user closes the tab — kept in the array briefly so we
   *  can animate out, then pruned. */
  closed: boolean;
}

type RootSig<T> = [Accessor<T>, Setter<T>];

const [_chats, _setChats] = createRoot<RootSig<Chat[]>>(() => createSignal<Chat[]>([]));
const [_activeChatId, _setActiveChatId] = createRoot<RootSig<string | null>>(() =>
  createSignal<string | null>(null),
);

/**
 * Side-channel for `lastActiveAt` updates. We MUST NOT replace chat
 * objects in the `_chats` array on every click, because Solid's `<For>`
 * keys items by reference identity — a new object means the old DOM
 * subtree (ChatTile → TerminalView) gets unmounted, which fires
 * `onCleanup` → `KillAgent` → PTY dies, then `onMount` → `SpawnAgent`
 * spawns a fresh PTY. The user sees this as "the chat reloads on
 * click". Storing timestamps in a side Map keeps chat object refs
 * stable, so `<For>` reconciliation is a no-op and the PTY survives.
 *
 * Persistence (sort by recency on next launch) reads through this Map
 * with a fallback to `chat.lastActiveAt` for chats that never became
 * active — see `persistOpenChats`.
 */
const _lastActiveAtById = new Map<string, number>();

/**
 * Reactive "something became active" tick. The `_lastActiveAtById` Map is
 * intentionally non-reactive (it keeps chat object refs stable so <For>
 * doesn't remount terminals). But the chip strip wants to re-sort
 * most-recently-used to the front whenever a chat is activated — that
 * needs a reactive trigger. Bumping this signal on every activation lets
 * `chipChats()` re-run without touching chat object identity.
 */
const [_activityTick, _setActivityTick] = createRoot<RootSig<number>>(() => createSignal(0));

/**
 * Per-chat title overrides + reactive tick. Renames went through
 * `_setChats(prev.map(...))` which creates a new chat object — but in
 * practice Solid's `<For>` was NOT picking up the new title on render
 * (confirmed by an e2e: title text in the DOM stayed at the old value
 * even after the rename committed). Suspect: the chat ref change
 * collapsed back to in-place reuse somewhere up the chain. Cause is
 * worth a follow-up but the user-visible fix is what matters now.
 *
 * Workaround: store the latest title in a side Map and have every
 * surface (chip, tile head, history row's chat copy) read through
 * `titleFor(chat)`. The Map is paired with `_titleTick` so reading
 * subscribes to renames reactively.
 */
// Solid signal wrapping a Map — reading `_titleOverrides()` tracks the
// signal in any reactive scope (effect, JSX, memo). Bumping the signal
// (by setting a new Map) fires re-renders everywhere titleFor is read.
// Replaced an earlier `Map + separate tick signal` pair whose tick was
// not always tracked in JSX (production minification sometimes inlined
// the read out of a tracking scope, so chip-strip rename looked broken).
const [_titleOverrides, _setTitleOverrides] = createRoot<RootSig<Map<string, string>>>(() =>
  createSignal(new Map<string, string>()),
);

export const chats = _chats;
export const activeChatId = _activeChatId;

/**
 * Returns the latest title for a chat. Reactive: subscribers re-run
 * when `renameChat` bumps `_titleTick`. Use this everywhere the title
 * is rendered — `chat.title` directly is a stale read.
 */
export function titleFor(chat: Pick<Chat, 'id' | 'title'>): string {
  return _titleOverrides().get(chat.id) ?? chat.title;
}

/**
 * Lightweight test/debug hook so Playwright e2e (and DevTools manual
 * pokes) can reach the store without going through the UI. The
 * surface is intentionally tiny and read/write-symmetric; it's not
 * documented as a public API.
 */
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__claudedeskChats = {
    chats: () => _chats(),
    renameChat: (id: string, title: string) => renameChat(id, title),
    titleFor: (chat: Pick<Chat, 'id' | 'title'>) => titleFor(chat),
    branchChat: (id: string) => branchChat(id),
  };
}

/** Read the freshest lastActiveAt for a chat — Map first, then the
 *  chat's own field (which is the value set at construction time). */
function lastActiveAtFor(c: Chat): number {
  return _lastActiveAtById.get(c.id) ?? c.lastActiveAt;
}

/**
 * Set the active chat. The lastActiveAt update goes through the side
 * Map so chat object refs stay stable — see `_lastActiveAtById`.
 */
export function setActiveChatId(id: string | null): void {
  _setActiveChatId(id);
  if (id !== null) {
    _lastActiveAtById.set(id, Date.now());
    _setActivityTick((n) => n + 1);
    schedulePersistOpenChats();
  }
}

/**
 * Open chats for the chip strip, sorted most-recently-used first. Reading
 * `_activityTick` makes this reactive: activating a chat bumps it to the
 * front of the tab strip ("последние диалоги поднимаются вверх"). Returns
 * a fresh array — never mutates `_chats`, so terminal object refs and
 * their live PTYs are untouched. Chips don't host xterm, so reordering
 * the chip DOM is free; the grid tiles keep their own (insertion) order.
 */
export function chipChats(projectId: string | null): Chat[] {
  void _activityTick();
  return openChatsInProject(projectId)
    .slice()
    .sort((a, b) => lastActiveAtFor(b) - lastActiveAtFor(a));
}

export function openChats(): Chat[] {
  return _chats().filter((c) => !c.closed);
}

/** Soft cap — after this, a new chat opens in a separate Electron window. */
export const MAX_CHATS_PER_WINDOW = 12;

function resolveAgent(agentDefId: string) {
  return (
    store.availableAgents.find((a) => a.id === agentDefId) ??
    store.availableAgents.find((a) => a.id.startsWith('claude-')) ??
    store.availableAgents[0]
  );
}

/**
 * Internal: assemble a Chat record from already-resolved primitives, append it
 * to the in-memory list, and mark it active. Both `openChatFromSession` and
 * `openFreshChat` funnel through here — they only differ in how they derive
 * the title/cwd/args. Keeping a single Chat-shape constructor avoids the two
 * paths drifting out of sync (e.g. one forgetting `projectId`).
 */
function buildChat(params: {
  id: string;
  sessionId?: string;
  title: string;
  cwd: string;
  baseAgent: { id: string; command: string };
  args: string[];
  settings: ChatLaunchSettings;
  projectId?: string | null;
}): Chat {
  const now = Date.now();
  const chat: Chat = {
    id: params.id,
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    title: params.title,
    cwd: params.cwd,
    agentDefId: params.baseAgent.id,
    command: params.baseAgent.command,
    args: params.args,
    env: {},
    settings: params.settings,
    projectId: params.projectId ?? null,
    createdAt: now,
    lastActiveAt: now,
    closed: false,
  };
  _setChats((prev) => [...prev, chat]);
  _lastActiveAtById.set(chat.id, now);
  _setActiveChatId(chat.id);
  schedulePersistOpenChats();
  return chat;
}

export function openChatFromSession(
  session: SessionItem,
  settings: ChatLaunchSettings,
  options: { projectId?: string | null } = {},
): Chat | null {
  const baseAgent = resolveAgent(settings.agentId);
  if (!baseAgent) {
    console.error('[chats] no Claude agent available');
    return null;
  }

  // Dedup: clicking a session row that's already open as a tile must
  // focus the existing tile, not spawn a fresh PTY. Without this, the
  // user sees the chat "reload" on every click — a new --resume process
  // starts and the old tile sticks around. Match on (sessionId,
  // projectId) so the same session can legitimately appear in two
  // workspaces (global Chats vs. inside a project).
  const targetProjectId = options.projectId ?? null;
  const existing = _chats().find(
    (c) =>
      !c.closed && c.sessionId === session.sessionId && (c.projectId ?? null) === targetProjectId,
  );
  if (existing) {
    setActiveChatId(existing.id);
    return existing;
  }

  const args = [
    '--resume',
    session.sessionId,
    ...(settings.skipPermissions ? baseAgent.skip_permissions_args : []),
    ...settings.extraFlags,
  ];

  return buildChat({
    id: crypto.randomUUID(),
    sessionId: session.sessionId,
    title: session.title || session.sessionId.slice(0, 8),
    cwd: session.projectPath,
    baseAgent,
    args,
    settings,
    projectId: targetProjectId,
  });
}

export function openFreshChat(params: {
  /**
   * Optional pre-determined chat id. The pending-chat restore path uses
   * the pending row's `id` here so subsequent dedup checks (which compare
   * against `chat.id`) match correctly. Without this, every fresh-fallback
   * pass through openProject creates a chat with a new UUID and the
   * pending row's id never matches anything → infinite duplication on
   * project switches. See chat-projects.ts:openProject (fallback branch).
   */
  id?: string;
  cwd: string;
  agentId?: string;
  extraFlags?: string[];
  skipPermissions?: boolean;
  title?: string;
  projectId?: string | null;
}): Chat | null {
  const baseAgent = resolveAgent(params.agentId ?? 'claude-opus-4-8');
  if (!baseAgent) {
    console.error('[chats] no Claude agent available');
    return null;
  }
  // Pre-mint a claude session UUID. Without this, claude internally
  // assigns its own random uuid for its JSONL when the user types the
  // first message — and we never observe it, so on next launch the chat
  // restores as a blank terminal (bug #36). Tasks.ts already mints
  // upfront via `--session-id <uuid>` for the same reason; chats now
  // follow the same pattern. Only applied to claude-* agents, since
  // codex/gemini/copilot don't accept --session-id.
  const sessionId = baseAgent.id.startsWith('claude-') ? crypto.randomUUID() : undefined;
  const args = [
    ...(sessionId ? ['--session-id', sessionId] : []),
    ...(params.skipPermissions ? baseAgent.skip_permissions_args : []),
    ...(params.extraFlags ?? []),
  ];
  const settings: ChatLaunchSettings = {
    agentId: baseAgent.id,
    extraFlags: params.extraFlags ?? [],
    skipPermissions: params.skipPermissions ?? false,
  };
  return buildChat({
    id: params.id ?? crypto.randomUUID(),
    sessionId,
    title: params.title ?? 'New chat',
    cwd: params.cwd,
    baseAgent,
    args,
    settings,
    projectId: params.projectId ?? null,
  });
}

/**
 * Move a chat to a different project (or unassign with null). Updates the
 * in-memory chat object only; if the chat has a sessionId, the caller is
 * responsible for also persisting via assignSessionToProject IPC so the
 * association survives an app restart.
 */
export function setChatProject(chatId: string, projectId: string | null): void {
  _setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, projectId } : c)));
  schedulePersistOpenChats();
}

/** Reorder a chat — moves it to `targetIndex` in the openChats list. */
export function reorderChat(chatId: string, targetIndex: number): void {
  _setChats((prev) => {
    const next = [...prev];
    const from = next.findIndex((c) => c.id === chatId);
    if (from < 0 || from === targetIndex) return prev;
    const clamped = Math.max(0, Math.min(targetIndex, next.length - 1));
    const [item] = next.splice(from, 1);
    next.splice(clamped, 0, item);
    return next;
  });
  schedulePersistOpenChats();
}

/** All open chats that belong to a particular project (or null = unassigned). */
export function openChatsInProject(projectId: string | null): Chat[] {
  return openChats().filter((c) => (c.projectId ?? null) === projectId);
}

export function closeChat(chatId: string): void {
  // If this was a pending (intent-only) chat in a project, drop the
  // persistence row so the next open of that project doesn't re-spawn it.
  // Resumed chats (with a sessionId) keep their session_project_map row —
  // the user can re-resume from History anytime.
  const chat = _chats().find((c) => c.id === chatId);
  if (chat && chat.projectId && !chat.sessionId) {
    void invoke<undefined>(IPC.RemovePendingChat, { id: chatId }).catch(() => undefined);
  }
  _setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, closed: true } : c)));
  schedulePersistOpenChats();
  // Prune closed chats after a tick so TerminalView has a chance to run its cleanup.
  setTimeout(() => {
    _setChats((prev) => prev.filter((c) => !c.closed || c.id !== chatId));
    _lastActiveAtById.delete(chatId);
    const remaining = _chats().filter((c) => !c.closed);
    if (_activeChatId() === chatId) {
      _setActiveChatId(remaining[remaining.length - 1]?.id ?? null);
    }
    schedulePersistOpenChats();
  }, 50);
}

/**
 * Branch an open chat: spawn a sibling tile that runs the SAME claude
 * session with `--fork-session`, so they share context up to the moment
 * of the fork and diverge afterwards into their own JSONLs. The new
 * tile is inserted directly after the original in `_chats`, gets a
 * "<orig> • branch" title, and becomes active.
 *
 * Requires the source chat to have a sessionId (otherwise there's no
 * conversation to fork — returns null and logs).
 */
export function branchChat(chatId: string): Chat | null {
  const src = _chats().find((c) => c.id === chatId && !c.closed);
  if (!src) {
    console.warn('[branchChat] source chat not found:', chatId);
    return null;
  }
  if (!src.sessionId) {
    console.warn('[branchChat] source chat has no sessionId — nothing to fork');
    return null;
  }
  const baseAgent = resolveAgent(src.agentDefId);
  if (!baseAgent) {
    console.error('[branchChat] no agent for', src.agentDefId);
    return null;
  }

  const args = [
    '--resume',
    src.sessionId,
    '--fork-session',
    ...(src.settings.skipPermissions ? baseAgent.skip_permissions_args : []),
    ...src.settings.extraFlags,
  ];

  const now = Date.now();
  const baseTitle = _titleOverrides().get(src.id) ?? src.title;
  const branched: Chat = {
    id: crypto.randomUUID(),
    sessionId: src.sessionId,
    title: `${baseTitle} • branch`,
    cwd: src.cwd,
    agentDefId: baseAgent.id,
    command: baseAgent.command,
    args,
    env: {},
    settings: { ...src.settings },
    projectId: src.projectId,
    createdAt: now,
    lastActiveAt: now,
    closed: false,
  };

  // Insert right after the source so the two tiles sit side-by-side in
  // the grid — easier to compare than appending to the end.
  _setChats((prev) => {
    const idx = prev.findIndex((c) => c.id === src.id);
    if (idx < 0) return [...prev, branched];
    const next = prev.slice();
    next.splice(idx + 1, 0, branched);
    return next;
  });
  _lastActiveAtById.set(branched.id, now);
  _setActiveChatId(branched.id);
  schedulePersistOpenChats();
  return branched;
}

/**
 * Branch directly from a History session — same semantics as branchChat
 * but the source isn't required to be an already-open tile. Bypasses
 * the openChatFromSession dedup (the whole point of a branch is to get
 * a SECOND tile sharing context).
 */
export function branchChatFromSession(
  session: SessionItem,
  settings: ChatLaunchSettings,
  options: { projectId?: string | null } = {},
): Chat | null {
  const baseAgent = resolveAgent(settings.agentId);
  if (!baseAgent) {
    console.error('[branchChatFromSession] no agent for', settings.agentId);
    return null;
  }
  const args = [
    '--resume',
    session.sessionId,
    '--fork-session',
    ...(settings.skipPermissions ? baseAgent.skip_permissions_args : []),
    ...settings.extraFlags,
  ];
  return buildChat({
    id: crypto.randomUUID(),
    sessionId: session.sessionId,
    title: `${session.title || session.sessionId.slice(0, 8)} • branch`,
    cwd: session.projectPath,
    baseAgent,
    args,
    settings,
    projectId: options.projectId ?? null,
  });
}

export function renameChat(chatId: string, title: string): void {
  // Create a NEW Map so the signal sees a fresh reference and notifies
  // subscribers. Solid's `===` equality check on signals would skip
  // notifications if we mutated the existing Map in place.
  _setTitleOverrides((prev) => {
    const next = new Map(prev);
    next.set(chatId, title);
    return next;
  });
  // Also write the new title onto the chat object in the array so
  // persistence (and any non-titleFor reader) sees it.
  _setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title } : c)));
  schedulePersistOpenChats();
}

// ---------------------------------------------------------------------------
// Persistence — non-project chats survive app restart
// ---------------------------------------------------------------------------
//
// Project chats already persist via SQLite project_pending_chats (and the
// session→project map for resumed ones). Non-project chats had no
// persistence — closing the app threw them away. The user reported this
// as "когда я открываю приложение, мои чаты пропадают, должно быть как
// перед закрытием".
//
// Approach: dump openChats() with projectId === null into localStorage on
// every change, debounced. On startup, the App calls restoreOpenChats()
// after loadAgents() (so resolveAgent works) and we recreate each chat
// via openChatFromSession (if sessionId known) or openFreshChat.
//
// We deliberately use localStorage rather than the persistence.ts JSON
// file: it's a fast, sync read/write per chat update, no IPC round-trip.

const PERSIST_KEY = 'claudedesk.openChats';
const MAX_PERSISTED = 20;

interface PersistedChat {
  id: string;
  sessionId?: string;
  title: string;
  cwd: string;
  agentDefId: string;
  extraFlags: string[];
  skipPermissions: boolean;
  lastActiveAt: number;
  createdAt: number;
  /** Position in the grid at persist time. Restored in this order so
   *  tiles come back where the user left them — sorting by lastActiveAt
   *  alone scrambled the layout (bug #34). Older snapshots without this
   *  field fall back to lastActiveAt-ascending. */
  gridIndex?: number;
}

/** Snapshot non-project chats to localStorage. Debounced via the createEffect
 *  that calls this — Solid batches setSignal calls per microtask, so the
 *  effect runs once per batch. */
function persistOpenChats(): void {
  try {
    // Preserve grid order: index in the openChats() array IS the visible
    // tile position. We sort by gridIndex on restore so tiles land back
    // exactly where the user had them.
    const visible = openChats().filter((c) => c.projectId === null);
    const snapshot: PersistedChat[] = visible
      .map((c, i) => ({
        id: c.id,
        ...(c.sessionId ? { sessionId: c.sessionId } : {}),
        title: c.title,
        cwd: c.cwd,
        agentDefId: c.agentDefId,
        extraFlags: c.settings.extraFlags,
        skipPermissions: c.settings.skipPermissions,
        lastActiveAt: lastActiveAtFor(c),
        createdAt: c.createdAt,
        gridIndex: i,
      }))
      .slice(0, MAX_PERSISTED);
    localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage full or unavailable */
  }
}

// Debounce localStorage writes — bursts of rename/recency/close updates
// don't need a separate JSON.stringify pass each. 500ms trailing edge is
// well below "how fast a user clicks something else and quits the app",
// so we never lose a meaningful change on shutdown.
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersistOpenChats(): void {
  if (_persistTimer !== null) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persistOpenChats();
  }, 500);
}

// Visible to tests so they can assert the debounce window — and to App.tsx
// `beforeunload` flush so a quick quit doesn't drop the last change.
export function flushPersistOpenChatsForTest(): void {
  if (_persistTimer !== null) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  persistOpenChats();
}

// Drain the pending debounce when the app is being closed. Without this,
// any chat mutation in the last ~500 ms before quit is silently lost —
// reopen the app and yesterday's tabs are missing. localStorage.setItem
// runs synchronously, so it completes before the unload finishes.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    flushPersistOpenChatsForTest();
  });
  // pagehide fires on Electron quit in cases where beforeunload doesn't —
  // belt-and-braces, same flush.
  window.addEventListener('pagehide', () => {
    flushPersistOpenChatsForTest();
  });
}

// Mutation sites call schedulePersistOpenChats() directly. A previous
// createEffect-based auto-persist was unreliable in Node test envs and
// duplicated the bookkeeping each mutation already does.

/**
 * Restore non-project chats persisted from the previous session. Called
 * from App.tsx after loadAgents() — must run AFTER agent defs are loaded
 * so resolveAgent doesn't fall back to a wrong default.
 *
 * Sessions with a known sessionId are resumed via openChatFromSession
 * (same path as clicking ▶ in History). Fresh chats without a sessionId
 * are re-spawned via openFreshChat — they lose conversation history but
 * the workspace shape (cwd, agent, flags) is preserved.
 */
export function restoreOpenChats(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PERSIST_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let list: PersistedChat[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    list = parsed.filter(
      (p): p is PersistedChat =>
        p &&
        typeof p === 'object' &&
        typeof p.id === 'string' &&
        typeof p.cwd === 'string' &&
        typeof p.agentDefId === 'string',
    );
  } catch {
    return;
  }
  if (list.length === 0) return;
  // Restore tiles in their original grid order, not by recency.
  // gridIndex was added in #34; older snapshots without it fall back to
  // lastActiveAt-ascending so behaviour doesn't regress for upgrade.
  list.sort((a, b) => {
    const ai = a.gridIndex;
    const bi = b.gridIndex;
    if (typeof ai === 'number' && typeof bi === 'number') return ai - bi;
    return a.lastActiveAt - b.lastActiveAt;
  });
  // Pick the most-recently-active chat to focus after the loop. The loop
  // itself sets active on each open, but we override at the end so grid
  // order isn't tied to "which one we want focused".
  const mruId = [...list].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id;
  for (const p of list) {
    const settings: ChatLaunchSettings = {
      agentId: p.agentDefId,
      extraFlags: p.extraFlags ?? [],
      skipPermissions: p.skipPermissions ?? false,
    };
    if (p.sessionId) {
      // Synthesize the minimal SessionItem shape openChatFromSession wants.
      // We don't have the full original record (folderIds, date, etc.)
      // — those don't matter for resume.
      const fakeSession: SessionItem = {
        sessionId: p.sessionId,
        projectPath: p.cwd,
        title: p.title,
        date: new Date(p.createdAt).toISOString(),
        filePath: '',
        folderIds: [],
      };
      openChatFromSession(fakeSession, settings);
    } else {
      openFreshChat({
        id: p.id,
        cwd: p.cwd,
        agentId: p.agentDefId,
        title: p.title,
        extraFlags: p.extraFlags ?? [],
        skipPermissions: p.skipPermissions ?? false,
      });
    }
  }
  // Restore focus to the most-recently-used chat — independent of grid
  // order. openFreshChat preserves the persisted id; openChatFromSession
  // mints a new chat id but carries sessionId forward, so we look up
  // restored chats by whichever key the persisted record had.
  const mru = list.find((p) => p.id === mruId);
  if (mru) {
    const restored = _chats().find((c) => {
      if (c.closed) return false;
      if (mru.sessionId) return c.sessionId === mru.sessionId;
      return c.id === mru.id;
    });
    if (restored) setActiveChatId(restored.id);
  }
}
