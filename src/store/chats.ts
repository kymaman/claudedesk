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

export function openChatFromSession(
  session: SessionItem,
  settings: ChatLaunchSettings,
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

  const chat: Chat = {
    id: crypto.randomUUID(),
    sessionId: session.sessionId,
    title: session.title || session.sessionId.slice(0, 8),
    cwd: session.projectPath,
    agentDefId: baseAgent.id,
    command: baseAgent.command,
    args,
    env: {},
    settings,
    createdAt: Date.now(),
    closed: false,
  };
  _setChats((prev) => [...prev, chat]);
  _setActiveChatId(chat.id);
  return chat;
}

export function openFreshChat(params: {
  cwd: string;
  agentId?: string;
  extraFlags?: string[];
  skipPermissions?: boolean;
  title?: string;
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
  const chat: Chat = {
    id: crypto.randomUUID(),
    title: params.title ?? 'New chat',
    cwd: params.cwd,
    agentDefId: baseAgent.id,
    command: baseAgent.command,
    args,
    env: {},
    settings: {
      agentId: baseAgent.id,
      extraFlags: params.extraFlags ?? [],
      skipPermissions: params.skipPermissions ?? false,
    },
    createdAt: Date.now(),
    closed: false,
  };
  _setChats((prev) => [...prev, chat]);
  _setActiveChatId(chat.id);
  return chat;
}

export function closeChat(chatId: string): void {
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
