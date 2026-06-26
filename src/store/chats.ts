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
  /** Fork lineage: when this chat was created via branch/fork (claude
   *  `--fork-session`), records the session it was forked FROM so the
   *  user can see "⑂ from <parent>" and understand the relationship.
   *  Absent for non-forked chats. Captured deterministically at branch
   *  time (we know the parent then) and persisted across restarts. */
  forkParent?: { sessionId: string; title: string };
  /** Earlier session ids this tile lived under. claude mints a NEW
   *  session file on every --resume; watchLiveSession() moves
   *  `sessionId` to the live file and parks the old id here so History
   *  dedup still recognises the tile when the user clicks a stale row. */
  pastSessionIds?: string[];
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

// Reactive map chatId → the freshest DISK/alias title of the chat's session.
// Kept in sync by an effect in App.tsx that watches the sessions() list, so an
// open tile's header always shows the SAME title as the History row for that
// session (the user's «название слева в истории и сверху над терминалом — одни
// задачи»). It's a separate signal from chat.title (a stale plain field) so
// updating it re-renders titleFor WITHOUT replacing the chat object — replacing
// it would remount the tile and KillAgent the PTY (see renameChat). Fed from
// chats.ts's side of the dependency (sessions-history already imports chats, so
// chats must NOT import sessions — the effect lives in App.tsx, which imports
// both, and calls setDiskTitleForChat).
const [_diskTitles, _setDiskTitles] = createRoot<RootSig<Map<string, string>>>(() =>
  createSignal(new Map<string, string>()),
);

/** Sync a chat's live disk/session title (called by App.tsx's sessions effect). */
export function setDiskTitleForChat(chatId: string, title: string): void {
  const cur = _diskTitles().get(chatId);
  if (cur === title) return; // no-op — don't churn the signal
  _setDiskTitles((prev) => {
    const next = new Map(prev);
    next.set(chatId, title);
    return next;
  });
}

export const chats = _chats;
export const activeChatId = _activeChatId;

/**
 * Returns the latest title for a chat. Reactive: re-runs when a manual rename
 * (`_titleOverrides`) or a live disk/session title (`_diskTitles`) changes.
 * Precedence: manual rename > live disk/alias title > the chat's own (possibly
 * stale) base title. The disk tier is what keeps the tile header and the
 * History row showing the same thing. Use this everywhere the title is
 * rendered — `chat.title` directly is a stale read.
 */
export function titleFor(chat: Pick<Chat, 'id' | 'title'>): string {
  return _titleOverrides().get(chat.id) ?? _diskTitles().get(chat.id) ?? chat.title;
}

/**
 * Returns ONLY a manual rename override for a chat, or undefined when
 * the chat has never been renamed. Reactive. Used by the History
 * overlay so a user's explicit rename — but NOT a possibly-stale base
 * title — wins over the freshly-parsed disk title.
 */
export function titleOverrideFor(chatId: string): string | undefined {
  return _titleOverrides().get(chatId);
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
    summarizeChat: (id: string) => summarizeChat(id),
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

/** Branch-title formatter: appends "• branch HH:MM" so chains of forks
 *  visibly grow ("A • branch 13:42 • branch 14:15") — the user can see at
 *  a glance where the branch came from and when it was made. Local time
 *  (not UTC) so the suffix matches the wall clock the user remembers. */
export function makeBranchTitle(parentTitle: string, at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${parentTitle} • branch ${hh}:${mm}`;
}

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
  forkParent?: { sessionId: string; title: string };
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
    ...(params.forkParent ? { forkParent: params.forkParent } : {}),
  };
  _setChats((prev) => [...prev, chat]);
  _lastActiveAtById.set(chat.id, now);
  _setActiveChatId(chat.id);
  schedulePersistOpenChats();
  if (chat.sessionId) watchLiveSession(chat.id);
  return chat;
}

/**
 * claude mints a NEW session JSONL (new id) every time a tile resumes a
 * session — the tile's recorded sessionId goes stale the moment the
 * user sends the first message. Stale ids caused the «Branch forks from
 * the FIRST session» bug: branching passed the open-time id to
 * --resume, dropping everything said since.
 *
 * This watcher asks the main process to poll the project dir for the
 * live continuation file (a sibling JSONL containing the original's
 * last message uuid) and, once found, moves the chat onto the live id.
 * The main process also records the resume edge + carries the alias
 * over, so History and the family tree stay coherent.
 */
const LIVE_WATCH_MS = 180_000;

/**
 * Session ids currently owned by OTHER open tiles (live + past). A
 * branched tile must never adopt one of these: when you fork session
 * S0, the parent's own continuation AND the fork both copy S0's last
 * message uuid, so the resolver matches BOTH files. Without this
 * exclusion every watcher gets the same newest file and the two tiles
 * glue onto one live session — the user sees "одна и та же переписка в
 * двух окнах". Excluding sibling-owned ids lets each tile land on its
 * OWN distinct continuation.
 */
function siblingSessionIds(exceptChatId: string): string[] {
  const ids = new Set<string>();
  for (const c of _chats()) {
    if (c.closed || c.id === exceptChatId) continue;
    if (c.sessionId) ids.add(c.sessionId);
    for (const p of c.pastSessionIds ?? []) ids.add(p);
  }
  return [...ids];
}

function watchLiveSession(chatId: string): void {
  if (typeof window === 'undefined') return;
  const chat = _chats().find((c) => c.id === chatId);
  if (!chat?.sessionId) return;
  const originalSid = chat.sessionId;
  const sinceMs = Date.now() - 5_000;
  invoke<{ sessionId: string; changed: boolean }>(IPC.ResolveLiveSession, {
    sessionId: originalSid,
    sinceMs,
    waitMs: LIVE_WATCH_MS,
    excludeSessionIds: siblingSessionIds(chatId),
  })
    .then((res) => claimLiveSession(chatId, originalSid, sinceMs, res))
    .catch((err) => {
      console.warn('[chats] watch live session failed:', err);
    });
}

/**
 * Adopt a resolved live session id — but never one a sibling tile
 * already owns. The renderer is single-threaded, so two watchers that
 * both resolve to the same newest continuation run their callbacks in
 * sequence: the first adopts it, the second sees it taken and re-scans
 * with that id excluded, landing on its OWN fork instead of gluing onto
 * its peer. Bounded retry guards against a pathological loop.
 */
async function claimLiveSession(
  chatId: string,
  fromSid: string,
  sinceMs: number,
  res: { sessionId: string; changed: boolean } | undefined,
  depth = 0,
): Promise<void> {
  if (!res?.changed) return;
  const taken = new Set(siblingSessionIds(chatId));
  if (taken.has(res.sessionId)) {
    if (depth >= 3) return; // give up rather than glue onto a peer
    try {
      const next = await invoke<{ sessionId: string; changed: boolean }>(IPC.ResolveLiveSession, {
        sessionId: fromSid,
        sinceMs,
        waitMs: 0,
        excludeSessionIds: [...taken],
      });
      return await claimLiveSession(chatId, fromSid, sinceMs, next, depth + 1);
    } catch (err) {
      console.warn('[chats] claim live session retry failed:', err);
      return;
    }
  }
  adoptLiveSessionId(chatId, fromSid, res.sessionId);
}

/** Move a chat onto its live session id (no-op if the chat moved on). */
function adoptLiveSessionId(chatId: string, fromSid: string, liveSid: string): void {
  const cur = _chats().find((c) => c.id === chatId);
  if (!cur || cur.closed || cur.sessionId !== fromSid || fromSid === liveSid) return;
  // Defensive: never adopt a session another open tile already owns —
  // that glue IS the "same conversation in two tiles" bug. claimLiveSession
  // normally prevents reaching here, but branchChat's last-moment scan
  // calls adopt directly.
  const takenByPeer = _chats().some(
    (c) =>
      c.id !== chatId &&
      !c.closed &&
      (c.sessionId === liveSid || (c.pastSessionIds?.includes(liveSid) ?? false)),
  );
  if (takenByPeer) return;
  _setChats((prev) =>
    prev.map((c) =>
      c.id === chatId
        ? {
            ...c,
            sessionId: liveSid,
            pastSessionIds: [...(c.pastSessionIds ?? []), fromSid].slice(-10),
          }
        : c,
    ),
  );
  schedulePersistOpenChats();
  // Branch tiles: replace the auto-recorded 'resume' edge with the true
  // fork edge so the family tree shows a ⑂ split, not a continuation.
  if (cur.forkParent) {
    invoke(IPC.RecordSessionLineage, {
      childId: liveSid,
      parentId: cur.forkParent.sessionId,
      kind: 'fork',
    }).catch((err) => {
      console.warn('[chats] record lineage failed:', err);
    });
  }
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
  // A tile may have ADVANCED past the clicked session id (claude mints a
  // new id per resume; watchLiveSession moves the tile forward) — match
  // past ids too, or clicking the stale History row would duplicate the
  // tile and resume an outdated snapshot next to the live one.
  const existing = _chats().find(
    (c) =>
      !c.closed &&
      (c.sessionId === session.sessionId ||
        (c.pastSessionIds?.includes(session.sessionId) ?? false)) &&
      (c.projectId ?? null) === targetProjectId,
  );
  if (existing) {
    // Title-sync: the row the user just clicked carries the freshest
    // title (re-parsed from JSONL, alias-aware). A tile opened earlier
    // — especially one restored from persistence — may still show a
    // stale title (old boilerplate, pre-rename). Without this update
    // the user clicks "Fix scroll bug" but the focused tile header
    // still says "session a1b2c3d4" — the exact "I click one session,
    // the top shows another" complaint.
    //
    // We only refresh the BASE title; a user's manual rename lives in
    // _titleOverrides and is intentionally left untouched (titleFor
    // prefers the override).
    if (session.title && existing.title !== session.title) {
      _setChats((prev) =>
        prev.map((c) => (c.id === existing.id ? { ...c, title: session.title } : c)),
      );
      schedulePersistOpenChats();
    }
    setActiveChatId(existing.id);
    // Return the updated reference so callers see the new title.
    return _chats().find((c) => c.id === existing.id) ?? existing;
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
  // No pre-mint: passing `--session-id <uuid>` changed claude's TUI
  // behaviour enough that the user lost the ability to scroll up to
  // see conversation history. Fresh chats now start without that flag
  // — claude mints its own session UUID when the user sends the first
  // message, and we accept the trade-off that fresh chats with no
  // messages yet don't survive an app restart (they would restore as
  // a blank claude anyway because no JSONL exists).
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
    void invoke<undefined>(IPC.RemovePendingChat, { id: chatId }).catch((err) => {
      console.warn('[chats] remove pending chat failed:', err);
    });
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
export async function branchChat(chatId: string): Promise<Chat | null> {
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

  // Last-moment safety net for the «branch forks from the FIRST
  // session» bug: even if watchLiveSession missed the continuation file
  // (claude minted it after the 3-min watch window), a single disk scan
  // right now catches it — so the fork starts from what the user SEES,
  // not from the open-time snapshot.
  let forkFromSid = src.sessionId;
  if (typeof window !== 'undefined') {
    try {
      const res = await invoke<{ sessionId: string; changed: boolean }>(IPC.ResolveLiveSession, {
        sessionId: src.sessionId,
        sinceMs: src.createdAt - 5_000,
        waitMs: 0,
        excludeSessionIds: siblingSessionIds(src.id),
      });
      if (res?.changed) {
        adoptLiveSessionId(src.id, src.sessionId, res.sessionId);
        forkFromSid = res.sessionId;
      }
    } catch (err) {
      console.warn('[chats] branch: resolve live session failed:', err);
    }
  }

  const args = [
    '--resume',
    forkFromSid,
    '--fork-session',
    ...(src.settings.skipPermissions ? baseAgent.skip_permissions_args : []),
    ...src.settings.extraFlags,
  ];

  const now = Date.now();
  const baseTitle = _titleOverrides().get(src.id) ?? src.title;
  const branched: Chat = {
    id: crypto.randomUUID(),
    sessionId: forkFromSid,
    title: makeBranchTitle(baseTitle, now),
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
    forkParent: { sessionId: forkFromSid, title: baseTitle },
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
  watchLiveSession(branched.id);
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
  const parentTitle = session.title || session.sessionId.slice(0, 8);
  return buildChat({
    id: crypto.randomUUID(),
    sessionId: session.sessionId,
    title: makeBranchTitle(parentTitle, Date.now()),
    cwd: session.projectPath,
    baseAgent,
    args,
    settings,
    projectId: options.projectId ?? null,
    forkParent: { sessionId: session.sessionId, title: parentTitle },
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
  // Write the new title onto the chat object so persistence (and any
  // non-titleFor reader) sees it — but MUTATE IN PLACE. We must NOT do
  // `_setChats(prev.map(c => ({...c, title})))`: that creates a NEW chat
  // object, and Solid's `<For>` keys items by reference identity, so the
  // ChatTile → TerminalView subtree unmounts and remounts. onCleanup then
  // fires KillAgent → a ConPTY teardown that races the surrounding native
  // PTY work and corrupts the heap on Windows (c0000374) — confirmed from a
  // crash dump and an e2e that died on rename. Mutating in place keeps the
  // ref stable so the PTY survives — the exact contract _lastActiveAtById
  // relies on. Reactive display is already handled by _setTitleOverrides
  // above; persistOpenChats reads chat.title at flush time.
  const target = _chats().find((c) => c.id === chatId);
  if (target) target.title = title;
  schedulePersistOpenChats();

  // Persist the rename as a session ALIAS so it survives after the
  // chat is closed AND becomes findable in History search. Without
  // this, renaming a tile "миграция HH" only lived in localStorage —
  // History still indexed the stale first-message title, so searching
  // "HH" never matched. Fire-and-forget; the History overlay shows it
  // immediately for open chats, and the alias makes it permanent.
  const chat = _chats().find((c) => c.id === chatId);
  if (chat?.sessionId && typeof window !== 'undefined') {
    invoke(IPC.RenameClaudeSession, { sessionId: chat.sessionId, alias: title }).catch((err) => {
      console.warn('[renameChat] failed to persist session alias:', err);
    });
  }
}

/**
 * Generates a one-line "о чём этот диалог" title for the chat via a
 * headless `claude -p --model haiku` run over the transcript tail
 * (SummarizeSession IPC), then applies it through renameChat — so the
 * new title shows up IMMEDIATELY in the tile header, the History
 * overlay, and search, and persists as the session alias. Returns the
 * generated title or null on failure (chat without sessionId, claude
 * offline, etc.).
 */
export async function summarizeChat(chatId: string): Promise<string | null> {
  const chat = _chats().find((c) => c.id === chatId);
  if (!chat?.sessionId || typeof window === 'undefined') return null;
  try {
    const res = await invoke<{ title: string; skipped: boolean }>(IPC.SummarizeSession, {
      sessionId: chat.sessionId,
      force: true,
    });
    if (!res?.title) return null;
    renameChat(chatId, res.title);
    return res.title;
  } catch (err) {
    console.warn('[summarizeChat] failed:', err);
    return null;
  }
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

/**
 * Delay between restoring consecutive persisted chats on startup. Staggering
 * avoids a synchronous burst of `claude --resume` spawns — a CPU/disk spike
 * that also races the PTY host (the mass-start crash trigger) and, with many
 * tiles, blows past the browser's ~16 WebGL-context cap so xterm falls back to
 * its slow DOM renderer (the "rendering suffers on startup" report). Exported
 * so tests can drive fake timers deterministically.
 */
export const RESTORE_STAGGER_MS = 450;

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
  /** Fork lineage — preserved across restarts so the "⑂ from X" badge
   *  survives a quit/relaunch. */
  forkParent?: { sessionId: string; title: string };
  /** Earlier session ids the tile lived under (see Chat.pastSessionIds). */
  pastSessionIds?: string[];
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
        ...(c.forkParent ? { forkParent: c.forkParent } : {}),
        ...(c.pastSessionIds?.length ? { pastSessionIds: c.pastSessionIds } : {}),
      }))
      .slice(0, MAX_PERSISTED);
    localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('[chats] persist open chats failed:', err);
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
export function restoreOpenChats(opts?: { staggerMs?: number }): void {
  // Interval between consecutive tile spawns. Defaults to RESTORE_STAGGER_MS
  // in production; tests inject 0 so every tile is scheduled in the same tick
  // (still async — drained by a microtask flush) instead of waiting real
  // wall-clock seconds. Grid order is preserved either way: same-delay
  // setTimeout callbacks fire in registration (gridIndex) order.
  const staggerMs = opts?.staggerMs ?? RESTORE_STAGGER_MS;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PERSIST_KEY);
  } catch (err) {
    console.warn('[chats] restore: localStorage unavailable:', err);
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
  } catch (err) {
    console.warn('[chats] restore: parse persisted chats failed:', err);
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
  // Pick the most-recently-active chat to focus at the end. Each open sets
  // active, but we override after the last spawn so grid order isn't tied
  // to "which one we want focused".
  const mruId = [...list].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id;
  // Session ids already taken by a tile restored EARLIER in this pass. A fork
  // tile whose persisted session id collides with one of these must NOT plain
  // --resume it: openChatFromSession would dedup onto the sibling and the
  // branch would either vanish (merged) or glue onto the same live session —
  // the "сделал бранч, перезапустил, в обе плитки подгрузился один и тот же
  // старый чат" bug. Such a fork is re-forked instead so it gets its OWN
  // divergent session. Tracked across the staggered setTimeout callbacks via
  // this closure.
  const claimedSessionIds = new Set<string>();
  const restoreOne = (p: PersistedChat): void => {
    const settings: ChatLaunchSettings = {
      agentId: p.agentDefId,
      extraFlags: p.extraFlags ?? [],
      skipPermissions: p.skipPermissions ?? false,
    };
    let restoredChat: Chat | null = null;
    if (p.sessionId) {
      // Synthesize the minimal SessionItem shape the open helpers want.
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
      // Undiverged branch: never wrote its own JSONL (no message sent before
      // quit), so it still carries the parent's session id verbatim.
      const isUndivergedBranch = p.sessionId === p.forkParent?.sessionId;
      // Collision: a sibling tile restored earlier in THIS pass already owns
      // this session id (e.g. parent + branch both got advanced onto the same
      // continuation before the restart — the glue had already started).
      const collidesWithSibling = claimedSessionIds.has(p.sessionId);
      if (p.forkParent && (isUndivergedBranch || collidesWithSibling)) {
        // Re-fork instead of --resume: bypasses the openChatFromSession dedup
        // and keeps --fork-session, so the branch comes back as a SEPARATE
        // dialog and watchLiveSession splits it onto its own divergent
        // session id. Without this it would merge onto / glue with the
        // sibling that already claimed this id.
        // This restore path only handles non-project (global) chats, so
        // the workspace is always null.
        restoredChat = branchChatFromSession(fakeSession, settings, { projectId: null });
      } else {
        restoredChat = openChatFromSession(fakeSession, settings);
      }
      // Record both the persisted id and whatever id the restored tile now
      // carries, so the NEXT tile in the pass sees this session as taken.
      claimedSessionIds.add(p.sessionId);
      if (restoredChat?.sessionId) claimedSessionIds.add(restoredChat.sessionId);
    } else {
      restoredChat = openFreshChat({
        id: p.id,
        cwd: p.cwd,
        agentId: p.agentDefId,
        title: p.title,
        extraFlags: p.extraFlags ?? [],
        skipPermissions: p.skipPermissions ?? false,
      });
    }
    // Re-apply fork lineage + past session ids so the "⑂ from X" badge
    // and History-row dedup survive restart.
    if (restoredChat && (p.forkParent || p.pastSessionIds?.length)) {
      const fp = p.forkParent;
      const past = p.pastSessionIds;
      _setChats((prev) =>
        prev.map((c) =>
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- restoredChat asserted non-null in caller scope above
          c.id === restoredChat!.id
            ? {
                ...c,
                ...(fp ? { forkParent: fp } : {}),
                ...(past?.length ? { pastSessionIds: past } : {}),
              }
            : c,
        ),
      );
    }
  };
  // Restore focus to the most-recently-used chat — independent of grid
  // order. openFreshChat preserves the persisted id; openChatFromSession
  // mints a new chat id but carries sessionId forward, so we look up
  // restored chats by whichever key the persisted record had.
  const finishFocus = (): void => {
    const mru = list.find((p) => p.id === mruId);
    if (!mru) return;
    const restored = _chats().find((c) => {
      if (c.closed) return false;
      if (mru.sessionId) return c.sessionId === mru.sessionId;
      return c.id === mru.id;
    });
    if (restored) setActiveChatId(restored.id);
  };

  // Stagger the spawns (see RESTORE_STAGGER_MS). Open the first tile
  // immediately for instant feedback, then drip the rest one at a time so the
  // startup spawn burst is spread out instead of hammering CPU/PTY/WebGL all
  // at once.
  restoreOne(list[0]);
  if (list.length === 1) {
    finishFocus();
    return;
  }
  for (let i = 1; i < list.length; i++) {
    const p = list[i];
    setTimeout(() => {
      restoreOne(p);
      if (i === list.length - 1) finishFocus();
    }, i * staggerMs);
  }
}
