/**
 * chats.ts
 * History chats are independent of parallel-code's worktree/task system.
 * A Chat is a lightweight wrapper around a spawned Claude terminal — no git
 * worktree, no branch, no hasDirectTask collision. Multiple chats run in
 * parallel; closing one doesn't affect the others.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';
import { produce } from 'solid-js/store';
import { setStore } from './core';
import type { Agent, Task } from './types';
import { terminalDefaults } from './terminal-defaults';
import { addProject } from './projects';
import { store } from './core';
import type { SessionItem } from './sessions-history';

export interface ChatLaunchSettings {
  agentId: string;
  extraFlags: string[];
  skipPermissions: boolean;
}

export interface Chat {
  /** UUID identifying this chat slot */
  id: string;
  /** UUID identifying the spawned agent process */
  agentId: string;
  /** UUID of the Claude Code session being resumed (absent for fresh chats) */
  sessionId?: string;
  /** Short display name shown in tabs */
  title: string;
  /** Project path (cwd) the CLI runs from */
  cwd: string;
  /** Agent id used to start the chat (e.g. claude-opus-4-7) */
  agentDefId: string;
  /** Resolved settings that produced this chat */
  settings: ChatLaunchSettings;
  createdAt: number;
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

export function activeChat(): Chat | null {
  const id = _activeChatId();
  if (!id) return null;
  return _chats().find((c) => c.id === id) ?? null;
}

export function openChats(): Chat[] {
  return _chats().filter((c) => !c.closed);
}

/**
 * Create a Chat and spawn its terminal. The actual terminal wiring lives in
 * ChatPanel.tsx which mounts an xterm that invokes SpawnAgent — this function
 * only sets up the data structure and registers the agent in the parallel-code
 * store so TerminalView's existing code path keeps working.
 *
 * Returns the created Chat. Caller should switch mainView to 'chats'.
 */
export function openChatFromSession(
  session: SessionItem,
  settings: ChatLaunchSettings,
): Chat {
  // Ensure a project record exists for the cwd so TerminalView can derive a
  // "chat" task shell. We piggy-back on `tasks` because TerminalView reads
  // its props from there; the task is never persisted via createTask IPC
  // (no worktree gets created), so it bypasses parallel-code's hasDirectTask
  // guard.
  let project = store.projects.find((p) => p.path === session.projectPath);
  if (!project) {
    const basename =
      session.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? session.projectPath;
    const id = addProject(basename, session.projectPath);
    project = store.projects.find((p) => p.id === id);
  }
  const projectId = project?.id ?? '';

  const baseAgent =
    store.availableAgents.find((a) => a.id === settings.agentId) ??
    store.availableAgents.find((a) => a.id.startsWith('claude-')) ??
    store.availableAgents[0];
  if (!baseAgent) throw new Error('No Claude agent available');

  const args = [
    '--resume',
    session.sessionId,
    ...(settings.skipPermissions ? baseAgent.skip_permissions_args : []),
    ...settings.extraFlags,
  ];

  const chatId = crypto.randomUUID();
  const agentId = crypto.randomUUID();

  // Register an in-memory shell-like task + agent in the parallel-code store
  // so TerminalView can resolve them. We do NOT call createTask IPC (which
  // creates worktrees and checks hasDirectTask). The task is fully in-process.
  const task: Task = {
    id: chatId,
    name: session.title.slice(0, 60) || session.sessionId.slice(0, 8),
    projectId,
    branchName: 'history-chat',
    worktreePath: session.projectPath,
    gitIsolation: 'direct',
    agentIds: [agentId],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
  };
  const agent: Agent = {
    id: agentId,
    taskId: chatId,
    def: { ...baseAgent, args },
    resumed: true,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };
  setStore(
    produce((s) => {
      s.tasks[chatId] = task;
      s.agents[agentId] = agent;
    }),
  );

  const defaults = terminalDefaults();
  const chat: Chat = {
    id: chatId,
    agentId,
    sessionId: session.sessionId,
    title: session.title || session.sessionId.slice(0, 8),
    cwd: session.projectPath,
    agentDefId: baseAgent.id,
    settings,
    createdAt: Date.now(),
    closed: false,
  };
  _setChats((prev) => [...prev, chat]);
  _setActiveChatId(chat.id);

  // Apply defaults into env via the shared TerminalView path (reads terminalDefaults directly)
  void defaults; // ref to silence unused
  return chat;
}

/** Open a fresh chat (no --resume) in the given cwd with the given agent. */
export function openFreshChat(params: {
  cwd: string;
  agentId?: string;
  extraFlags?: string[];
  skipPermissions?: boolean;
  title?: string;
}): Chat {
  const baseAgent =
    store.availableAgents.find((a) => a.id === (params.agentId ?? 'claude-opus-4-7')) ??
    store.availableAgents.find((a) => a.id.startsWith('claude-')) ??
    store.availableAgents[0];
  if (!baseAgent) throw new Error('No Claude agent available');

  let project = store.projects.find((p) => p.path === params.cwd);
  if (!project) {
    const basename = params.cwd.split(/[\\/]/).filter(Boolean).pop() ?? params.cwd;
    const id = addProject(basename, params.cwd);
    project = store.projects.find((p) => p.id === id);
  }
  const projectId = project?.id ?? '';

  const args = [
    ...(params.skipPermissions ? baseAgent.skip_permissions_args : []),
    ...(params.extraFlags ?? []),
  ];

  const chatId = crypto.randomUUID();
  const agentId = crypto.randomUUID();

  const task: Task = {
    id: chatId,
    name: params.title ?? 'New chat',
    projectId,
    branchName: 'history-chat',
    worktreePath: params.cwd,
    gitIsolation: 'direct',
    agentIds: [agentId],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
  };
  const agent: Agent = {
    id: agentId,
    taskId: chatId,
    def: { ...baseAgent, args },
    resumed: false,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
  };
  setStore(
    produce((s) => {
      s.tasks[chatId] = task;
      s.agents[agentId] = agent;
    }),
  );

  const chat: Chat = {
    id: chatId,
    agentId,
    title: params.title ?? 'New chat',
    cwd: params.cwd,
    agentDefId: baseAgent.id,
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
  _setChats((prev) =>
    prev.map((c) => (c.id === chatId ? { ...c, closed: true } : c)),
  );
  // If closing the active one, switch to another open chat (most recent)
  const remaining = openChats().filter((c) => c.id !== chatId);
  if (_activeChatId() === chatId) {
    _setActiveChatId(remaining[remaining.length - 1]?.id ?? null);
  }
  // Remove the phantom task + agent from the parallel-code store so TilingLayout
  // doesn't render it in Branches.
  setStore(
    produce((s) => {
      const t = s.tasks[chatId];
      if (t) {
        for (const aid of t.agentIds) delete s.agents[aid];
        delete s.tasks[chatId];
      }
    }),
  );
}
