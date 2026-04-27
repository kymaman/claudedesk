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
  /** Marked true when user closes the tab — kept in the array briefly so we
   *  can animate out, then pruned. */
  closed: boolean;
}

type RootSig<T> = [Accessor<T>, Setter<T>];

const [_chats, _setChats] = createRoot<RootSig<Chat[]>>(() => createSignal<Chat[]>([]));
const [_activeChatId, _setActiveChatId] = createRoot<RootSig<string | null>>(() =>
  createSignal<string | null>(null),
);

export const chats = _chats;
export const activeChatId = _activeChatId;
export const setActiveChatId = _setActiveChatId;

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
    createdAt: Date.now(),
    closed: false,
  };
  _setChats((prev) => [...prev, chat]);
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
    projectId: options.projectId ?? null,
  });
}

export function openFreshChat(params: {
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
    id: crypto.randomUUID(),
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
    const remaining = _chats().filter((c) => !c.closed);
    if (_activeChatId() === chatId) {
      _setActiveChatId(remaining[remaining.length - 1]?.id ?? null);
    }
  }, 50);
}

export function renameChat(chatId: string, title: string): void {
  _setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title } : c)));
}
