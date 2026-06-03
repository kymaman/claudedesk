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

import { createRoot, createEffect, createSignal, type Accessor, type Setter } from 'solid-js';
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

export const chats = _chats;
export const activeChatId = _activeChatId;

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
    persistOpenChats();
  }
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
  const baseAgent = resolveAgent(params.agentId ?? 'claude-opus-4-7');
  if (!baseAgent) {
    console.error('[chats] no Claude agent available');
    return null;
  }
  const args = [
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
  // Prune closed chats after a tick so TerminalView has a chance to run its cleanup.
  setTimeout(() => {
    _setChats((prev) => prev.filter((c) => !c.closed || c.id !== chatId));
    _lastActiveAtById.delete(chatId);
    const remaining = _chats().filter((c) => !c.closed);
    if (_activeChatId() === chatId) {
      _setActiveChatId(remaining[remaining.length - 1]?.id ?? null);
    }
  }, 50);
}

export function renameChat(chatId: string, title: string): void {
  _setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title } : c)));
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
}

/** Snapshot non-project chats to localStorage. Debounced via the createEffect
 *  that calls this — Solid batches setSignal calls per microtask, so the
 *  effect runs once per batch. */
function persistOpenChats(): void {
  try {
    const snapshot: PersistedChat[] = openChats()
      .filter((c) => c.projectId === null)
      .map((c) => ({
        id: c.id,
        ...(c.sessionId ? { sessionId: c.sessionId } : {}),
        title: c.title,
        cwd: c.cwd,
        agentDefId: c.agentDefId,
        extraFlags: c.settings.extraFlags,
        skipPermissions: c.settings.skipPermissions,
        lastActiveAt: lastActiveAtFor(c),
        createdAt: c.createdAt,
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, MAX_PERSISTED);
    localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage full or unavailable */
  }
}

// One-shot effect attached at module init so we don't accumulate effects.
createRoot(() => {
  createEffect(() => {
    void _chats();
    persistOpenChats();
  });
});

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
  // Sort ascending so the LAST one we open ends up active (matches
  // "most-recently-used is active and on top").
  list.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
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
}
