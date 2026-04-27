import { createSignal } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import type { WorktreeStatus } from '../ipc/types';
import {
  TRUST_EXCLUSION_KEYWORDS,
  stripAnsi,
  looksLikePrompt,
  chunkContainsAgentPrompt,
  normalizeForComparison,
  normalizeCurrentFrame,
  looksLikeQuestion,
  looksLikeTrustDialog,
  isTrustQuestionAutoHandled as isTrustQuestionAutoHandledPure,
} from '../lib/agent-output-analyzer';

// Re-export the pure analyzer functions so existing import sites
// (`./taskStatus` or `./store`) continue to work unchanged.
export { stripAnsi, normalizeForComparison, normalizeCurrentFrame, looksLikeQuestion };

// --- Consolidated per-agent tracking state ---
// Groups all per-agent Maps into one to prevent cleanup leaks.
interface AgentTrackingState {
  autoTrustTimer?: ReturnType<typeof setTimeout>;
  autoTrustCooldown?: ReturnType<typeof setTimeout>;
  lastAutoTrustCheckAt?: number;
  autoTrustAcceptedAt?: number;
  lastDataAt?: number;
  lastIdleResetAt?: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  outputTailBuffer: string;
  decoder: TextDecoder;
  lastAnalysisAt?: number;
  pendingAnalysis?: ReturnType<typeof setTimeout>;
  pendingAnalysisDueAt?: number;
}

const agentStates = new Map<string, AgentTrackingState>();

function getAgentState(agentId: string): AgentTrackingState {
  let state = agentStates.get(agentId);
  if (!state) {
    state = { outputTailBuffer: '', decoder: new TextDecoder() };
    agentStates.set(agentId, state);
  }
  return state;
}

const POST_AUTO_TRUST_SETTLE_MS = 1_000;

function isAutoTrustPending(agentId: string): boolean {
  const state = agentStates.get(agentId);
  if (!state) return false;
  return state.autoTrustTimer !== undefined || state.autoTrustCooldown !== undefined;
}

/** True while auto-trust is handling or settling a dialog for this agent.
 *  Covers both the pending phase (timer scheduled, Enter not yet sent) and
 *  the settling phase (Enter sent, agent still initializing).
 *  Auto-send should wait until this returns false.
 *  Note: cleans up expired entries as a side effect to avoid a separate timer. */
export function isAutoTrustSettling(agentId: string): boolean {
  if (isAutoTrustPending(agentId)) return true;
  const state = agentStates.get(agentId);
  if (!state?.autoTrustAcceptedAt) return false;
  if (Date.now() - state.autoTrustAcceptedAt >= POST_AUTO_TRUST_SETTLE_MS) {
    state.autoTrustAcceptedAt = undefined;
    return false;
  }
  return true;
}

function clearAutoTrustState(agentId: string): void {
  const state = agentStates.get(agentId);
  if (!state) return;
  state.lastAutoTrustCheckAt = undefined;
  state.autoTrustAcceptedAt = undefined;
  if (state.autoTrustTimer !== undefined) {
    clearTimeout(state.autoTrustTimer);
    state.autoTrustTimer = undefined;
  }
  if (state.autoTrustCooldown !== undefined) {
    clearTimeout(state.autoTrustCooldown);
    state.autoTrustCooldown = undefined;
  }
}

export type TaskDotStatus = 'busy' | 'waiting' | 'ready' | 'review';
export type TaskAttentionState = 'idle' | 'active' | 'needs_input' | 'error' | 'ready';

// --- Agent ready event callbacks ---
// Fired from markAgentOutput when a main prompt is detected in a PTY chunk.
const agentReadyCallbacks = new Map<string, () => void>();

/** Register a callback that fires once when the agent's main prompt is detected. */
export function onAgentReady(agentId: string, callback: () => void): void {
  agentReadyCallbacks.set(agentId, callback);
}

/** Remove a pending agent-ready callback. */
export function offAgentReady(agentId: string): void {
  agentReadyCallbacks.delete(agentId);
}

/** Fire the one-shot agentReady callback if the tail buffer shows a known agent prompt. */
function tryFireAgentReadyCallback(agentId: string): void {
  if (!agentReadyCallbacks.has(agentId)) return;
  const state = agentStates.get(agentId);
  const rawTail = state?.outputTailBuffer ?? '';
  const tailStripped = stripAnsi(rawTail)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (chunkContainsAgentPrompt(tailStripped)) {
    const cb = agentReadyCallbacks.get(agentId);
    agentReadyCallbacks.delete(agentId);
    if (cb) cb();
  }
}

/** True when the tail buffer's question patterns are entirely from trust/allow
 *  dialogs that auto-trust will handle. Thin wrapper around the pure helper
 *  in agent-output-analyzer.ts that supplies the `store.autoTrustFolders` flag. */
export function isTrustQuestionAutoHandled(tail: string): boolean {
  return isTrustQuestionAutoHandledPure(tail, store.autoTrustFolders);
}

// --- Agent question tracking ---
// Reactive set of agent IDs that currently have a question/dialog in their terminal.
const [questionAgents, setQuestionAgents] = createSignal<Set<string>>(new Set());

/** True when the agent's terminal is showing a question or confirmation dialog. */
export function isAgentAskingQuestion(agentId: string): boolean {
  return questionAgents().has(agentId);
}

function updateQuestionState(agentId: string, hasQuestion: boolean): void {
  setQuestionAgents((prev) => {
    if (hasQuestion === prev.has(agentId)) return prev;
    const next = new Set(prev);
    if (hasQuestion) next.add(agentId);
    else next.delete(agentId);
    return next;
  });
}

// --- Agent activity tracking ---
// Reactive set of agent IDs considered "active" (updated on coarser schedule).
const [activeAgents, setActiveAgents] = createSignal<Set<string>>(new Set());

// How long after the last data event before transitioning back to idle.
// AI agents routinely go silent for 10-30s during normal work (thinking,
// API calls, tool use), so this needs to be long enough to cover those pauses.
const IDLE_TIMEOUT_MS = 15_000;
// Throttle reactive updates while already active.
const THROTTLE_MS = 1_000;

// Tail buffer per agent — keeps the last N bytes of PTY output for prompt matching.
// Must be large enough to hold a full TUI dialog render (with ANSI codes) so that
// question text at the top of the dialog isn't truncated away.  16 KB is
// comfortable for multi-frame Ink TUI renders (~1.5 KB/frame) plus any startup
// banner that Copilot CLI emits before entering the alternate screen.
const TAIL_BUFFER_MAX = 16_384;

// Throttle for background (non-active) auto-trust checks so we don't run
// ANSI strip + regex on every PTY chunk from every agent.
const AUTO_TRUST_BG_THROTTLE_MS = 500;

// Per-agent timestamp of last expensive analysis (question/prompt detection).
const ACTIVE_ANALYSIS_INTERVAL_MS = 200;
const BACKGROUND_ANALYSIS_INTERVAL_MS = 1_200;

function addToActive(agentId: string): void {
  setActiveAgents((s) => {
    if (s.has(agentId)) return s;
    const next = new Set(s);
    next.add(agentId);
    return next;
  });
}

function removeFromActive(agentId: string): void {
  setActiveAgents((s) => {
    if (!s.has(agentId)) return s;
    const next = new Set(s);
    next.delete(agentId);
    return next;
  });
}

function resetIdleTimer(agentId: string): void {
  const state = getAgentState(agentId);
  state.lastIdleResetAt = Date.now();
  if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    removeFromActive(agentId);
    state.idleTimer = undefined;
  }, IDLE_TIMEOUT_MS);
}

function cancelPendingAnalysis(state: AgentTrackingState): void {
  if (state.pendingAnalysis !== undefined) {
    clearTimeout(state.pendingAnalysis);
    state.pendingAnalysis = undefined;
  }
  state.pendingAnalysisDueAt = undefined;
}

function runAgentAnalysis(agentId: string, now: number): void {
  const state = getAgentState(agentId);
  cancelPendingAnalysis(state);
  state.lastAnalysisAt = now;
  analyzeAgentOutput(agentId);
}

function scheduleAgentAnalysis(agentId: string, intervalMs: number, now: number): void {
  const state = getAgentState(agentId);
  const lastAnalysis = state.lastAnalysisAt ?? 0;
  if (now - lastAnalysis >= intervalMs) {
    runAgentAnalysis(agentId, now);
    return;
  }

  const delay = intervalMs - (now - lastAnalysis);
  const dueAt = now + delay;
  if (
    state.pendingAnalysis !== undefined &&
    state.pendingAnalysisDueAt !== undefined &&
    state.pendingAnalysisDueAt <= dueAt
  ) {
    return;
  }

  cancelPendingAnalysis(state);
  state.pendingAnalysisDueAt = dueAt;
  state.pendingAnalysis = setTimeout(() => {
    runAgentAnalysis(agentId, Date.now());
  }, delay);
}

/** Mark an agent as active when it is first spawned.
 *  Ensures agents start as "busy" before any PTY data arrives. */
export function markAgentSpawned(agentId: string): void {
  const state = getAgentState(agentId);
  state.outputTailBuffer = '';
  clearAutoTrustState(agentId);
  state.lastAnalysisAt = undefined;
  cancelPendingAnalysis(state);
  state.lastDataAt = Date.now();
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Try to auto-accept trust/permission dialogs for any agent (active or background).
 *  Lightweight check that only runs trust-specific patterns. */
function tryAutoTrust(agentId: string, rawTail: string): boolean {
  if (!store.autoTrustFolders || isAutoTrustPending(agentId)) {
    return false;
  }
  if (!looksLikeTrustDialog(rawTail)) {
    return false;
  }
  if (TRUST_EXCLUSION_KEYWORDS.test(stripAnsi(rawTail))) {
    return false;
  }

  const state = getAgentState(agentId);
  // Short delay to let the TUI finish rendering before sending Enter.
  state.autoTrustTimer = setTimeout(() => {
    state.autoTrustTimer = undefined;
    // Clear stale trust-dialog content (including ❯ selection cursor) so
    // chunkContainsAgentPrompt only fires on the agent's real prompt.
    state.outputTailBuffer = '';
    // Deregister the agent-ready callback so the fast path (immediate ❯
    // detection) is disabled.  The agent may render ❯ before it's fully
    // initialized — the quiescence fallback (1500ms of stable output)
    // is more reliable after trust acceptance.
    agentReadyCallbacks.delete(agentId);
    // Start the settling period — blocks auto-send for POST_AUTO_TRUST_SETTLE_MS
    // to give slow-starting agents (e.g. Claude Code) time to fully initialize.
    state.autoTrustAcceptedAt = Date.now();
    invoke(IPC.WriteToAgent, { agentId, data: '\r' }).catch(() => {});
    // Cooldown: ignore trust patterns for 1s so the same dialog
    // isn't re-matched while the PTY output transitions.
    // (The tail buffer is cleared above, so re-detection is only possible
    // if the agent immediately re-shows a trust dialog.)
    state.autoTrustCooldown = setTimeout(() => {
      state.autoTrustCooldown = undefined;
    }, 1_000);
  }, 50);
  return true;
}

/** Run expensive prompt/question/agent-ready detection on the tail buffer.
 *  Called at most every ANALYSIS_INTERVAL_MS (200ms) per agent. */
function analyzeAgentOutput(agentId: string): void {
  const state = getAgentState(agentId);
  const rawTail = state.outputTailBuffer;
  let hasQuestion = looksLikeQuestion(rawTail);

  // Suppress question state for trust dialogs when auto-trust is enabled —
  // whether we just scheduled auto-trust or it's already pending/in cooldown.
  // Without this, subsequent analysis calls re-detect the stale dialog text in
  // the tail buffer and set hasQuestion=true, which disables the prompt
  // textarea and steals focus to the terminal.
  if (hasQuestion && store.autoTrustFolders) {
    if (looksLikeTrustDialog(rawTail) && !TRUST_EXCLUSION_KEYWORDS.test(stripAnsi(rawTail))) {
      // Auto-trust may not have fired yet if this is the first analysis for
      // an active task that just became visible — trigger it now.
      tryAutoTrust(agentId, rawTail);
      hasQuestion = false;
    }
  }

  updateQuestionState(agentId, hasQuestion);

  // Agent-ready prompt scanning. Uses the tail buffer (always current) so
  // throttled/trailing calls don't miss prompts from intermediate chunks.
  // Guard: don't fire if the tail buffer contains a question — TUI selection
  // UIs (e.g. "trust this folder?") also use ❯ as a cursor.
  // Also skip while auto-trust Enter is scheduled (50ms window) — the ❯ in
  // the selection UI is a false positive.  After the timer fires, the tail
  // buffer is cleared so only the agent's real prompt can trigger this.
  if (!hasQuestion && state.autoTrustTimer === undefined) tryFireAgentReadyCallback(agentId);
}

/** Call this from the TerminalView Data handler with the raw PTY bytes.
 *  Detects prompt patterns to immediately mark agents idle instead of
 *  waiting for the full idle timeout. */
export function markAgentOutput(agentId: string, data: Uint8Array, taskId?: string): void {
  const now = Date.now();
  const state = getAgentState(agentId);
  state.lastDataAt = now;

  const text = state.decoder.decode(data, { stream: true });
  const combined = state.outputTailBuffer + text;
  state.outputTailBuffer =
    combined.length > TAIL_BUFFER_MAX
      ? combined.slice(combined.length - TAIL_BUFFER_MAX)
      : combined;

  // Expensive analysis (regex, ANSI strip) now runs for all task agents, with a
  // slower cadence for background tasks so off-screen attention still updates.
  const isActiveTask = !taskId || taskId === store.activeTaskId;

  // Auto-trust runs for ALL agents (including background tasks) so trust
  // dialogs are accepted immediately without needing to switch to the task.
  // Active-task agents also get full analysis; background agents keep a faster
  // trust-only path plus a slower full analysis path for attention updates.
  if (store.autoTrustFolders && !isAutoTrustPending(agentId) && !isActiveTask) {
    const lastCheck = state.lastAutoTrustCheckAt ?? 0;
    if (now - lastCheck >= AUTO_TRUST_BG_THROTTLE_MS) {
      state.lastAutoTrustCheckAt = now;
      tryAutoTrust(agentId, state.outputTailBuffer);
    }
  }

  scheduleAgentAnalysis(
    agentId,
    isActiveTask ? ACTIVE_ANALYSIS_INTERVAL_MS : BACKGROUND_ANALYSIS_INTERVAL_MS,
    now,
  );

  // Extract last non-empty line from recent output for prompt matching.
  // This check is UNTHROTTLED — it's cheap (single line, 6 patterns) and
  // important for responsive idle detection.
  const tail = combined.slice(-200);
  let lastLine = '';
  let searchEnd = tail.length;
  while (searchEnd > 0) {
    const nlIdx = tail.lastIndexOf('\n', searchEnd - 1);
    const candidate = tail.slice(nlIdx + 1, searchEnd).trim();
    if (candidate.length > 0) {
      lastLine = candidate;
      break;
    }
    searchEnd = nlIdx >= 0 ? nlIdx : 0;
  }

  if (looksLikePrompt(lastLine)) {
    // Prompt detected — agent is idle. Remove from active set immediately.
    //
    // NOTE: do NOT cancel pendingAnalysis here.  TUI agents (Copilot CLI,
    // Codex) use Ink which positions the ❯ selection cursor in a separate
    // PTY chunk BEFORE the surrounding dialog text.  If we cancelled the
    // trailing analyzeAgentOutput call at that point, the trust dialog would
    // never be detected by looksLikeQuestion, tryAutoTrust would never run,
    // isAutoTrustSettling would stay false, and the initial prompt would get
    // sent into the active trust dialog.  Allow the trailing analysis to run
    // so question/trust state is always up-to-date.

    // Preserve real question state even when the prompt arrives inside the
    // analysis throttle window (common for background Y/n confirmations).
    // Without this fast-path check, cancelling the pending analysis would drop
    // the question signal and the task would incorrectly look idle.
    const hasQuestion = looksLikeQuestion(state.outputTailBuffer);
    updateQuestionState(agentId, hasQuestion);

    // Fire the agentReady callback (used by PromptInput auto-send).
    // The chunkContainsAgentPrompt guard inside tryFireAgentReadyCallback
    // ensures shell prompts ($, %) don't trigger it.
    tryFireAgentReadyCallback(agentId);

    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    removeFromActive(agentId);
    return;
  }

  // Non-prompt output — agent is producing real work.
  if (activeAgents().has(agentId)) {
    const lastReset = state.lastIdleResetAt ?? 0;
    if (now - lastReset < THROTTLE_MS) return;
    resetIdleTimer(agentId);
    return;
  }

  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Return the last ~4096 chars of raw PTY output for `agentId`. */
export function getAgentOutputTail(agentId: string): string {
  return agentStates.get(agentId)?.outputTailBuffer ?? '';
}

/** True when the agent is NOT producing output (e.g. sitting at a prompt). */
export function isAgentIdle(agentId: string): boolean {
  return !activeAgents().has(agentId);
}

/** Lightweight busy marker — adds to active set + resets idle timer.
 *  Unlike markAgentSpawned this preserves the output tail buffer. */
export function markAgentBusy(agentId: string): void {
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Clean up timers when an agent exits. */
export function clearAgentActivity(agentId: string): void {
  const state = agentStates.get(agentId);
  if (state) {
    clearAutoTrustState(agentId);
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    cancelPendingAnalysis(state);
  }
  agentStates.delete(agentId);
  agentReadyCallbacks.delete(agentId);
  removeFromActive(agentId);
  updateQuestionState(agentId, false);
}

// --- Derived status ---

function isTaskReady(taskId: string): boolean {
  const git = store.taskGitStatus[taskId];
  return Boolean(git?.has_committed_changes && !git?.has_uncommitted_changes);
}

function hasTaskAgentError(taskId: string): boolean {
  const task = store.tasks[taskId];
  if (!task) return false;
  return task.agentIds.some((id) => {
    const agent = store.agents[id];
    if (agent?.status !== 'exited') return false;
    return agent.exitCode !== 0 || agent.signal !== null;
  });
}

export function getTaskAttentionState(taskId: string): TaskAttentionState {
  const task = store.tasks[taskId];
  if (!task) return 'idle';

  if (hasTaskAgentError(taskId)) return 'error';

  const active = activeAgents(); // reactive read
  const hasQuestion = task.agentIds.some((id) => {
    const agent = store.agents[id];
    return agent?.status === 'running' && isAgentAskingQuestion(id);
  });
  if (hasQuestion) return 'needs_input';

  const hasActive = task.agentIds.some((id) => {
    const agent = store.agents[id];
    return agent?.status === 'running' && active.has(id);
  });
  if (hasActive) return 'active';

  if (isTaskReady(taskId)) return 'ready';
  return 'idle';
}

export function taskNeedsAttention(taskId: string): boolean {
  const attention = getTaskAttentionState(taskId);
  return attention === 'active' || attention === 'needs_input' || attention === 'error';
}

export function getTaskDotStatus(taskId: string): TaskDotStatus {
  const task = store.tasks[taskId];
  if (!task) return 'waiting';
  const active = activeAgents(); // reactive read
  const hasActive = task.agentIds.some((id) => {
    const a = store.agents[id];
    return a?.status === 'running' && active.has(id);
  });
  if (hasActive) return 'busy';

  const steps = task.stepsContent;
  if (steps && steps.length > 0) {
    const latest = steps[steps.length - 1];
    if (latest.status === 'awaiting_review') return 'review';
  }

  if (isTaskReady(taskId)) return 'ready';
  return 'waiting';
}

// --- Git status polling ---

async function refreshTaskGitStatus(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  try {
    const status = await invoke<WorktreeStatus>(IPC.GetWorktreeStatus, {
      worktreePath: task.worktreePath,
      baseBranch: task.baseBranch,
    });
    setStore('taskGitStatus', taskId, status);
  } catch {
    // Worktree may not exist yet or was removed — ignore
  }
}

let isRefreshingAll = false;
let refreshAllStartedAt = 0;

/** Refresh git status for inactive tasks (active task is handled by its own 5s timer).
 *  Limits concurrency to avoid spawning too many parallel git processes. */
export async function refreshAllTaskGitStatus(): Promise<void> {
  if (isRefreshingAll && Date.now() - refreshAllStartedAt < 60_000) return;
  isRefreshingAll = true;
  refreshAllStartedAt = Date.now();
  try {
    const taskIds = store.taskOrder;
    const active = activeAgents();
    const currentTaskId = store.activeTaskId;
    const toRefresh = taskIds.filter((taskId) => {
      // Active task is covered by the faster refreshActiveTaskGitStatus timer
      if (taskId === currentTaskId) return false;
      const task = store.tasks[taskId];
      if (!task) return false;
      return !task.agentIds.some((id) => {
        const a = store.agents[id];
        return a?.status === 'running' && active.has(id);
      });
    });

    // Process in batches of 4 to limit concurrent git processes
    const BATCH_SIZE = 4;
    for (let i = 0; i < toRefresh.length; i += BATCH_SIZE) {
      const batch = toRefresh.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((taskId) => refreshTaskGitStatus(taskId)));
    }
  } finally {
    isRefreshingAll = false;
  }
}

/** Refresh git status for the currently active task only. */
async function refreshActiveTaskGitStatus(): Promise<void> {
  const taskId = store.activeTaskId;
  if (!taskId) return;
  await refreshTaskGitStatus(taskId);
}

/** Refresh git status for a single task (e.g. after agent exits). */
export function refreshTaskStatus(taskId: string): void {
  refreshTaskGitStatus(taskId);
}

let allTasksTimer: ReturnType<typeof setInterval> | null = null;
let activeTaskTimer: ReturnType<typeof setInterval> | null = null;
let lastPollingTaskCount = 0;

function computeAllTasksInterval(): number {
  const taskCount = store.taskOrder.length;
  return Math.min(120_000, 30_000 + Math.max(0, taskCount - 3) * 5_000);
}

export function startTaskStatusPolling(): void {
  if (allTasksTimer || activeTaskTimer) return;
  // Active task polls every 5s for responsive UI
  activeTaskTimer = setInterval(refreshActiveTaskGitStatus, 5_000);
  // Scale interval: 30s base + 5s per additional task beyond 3
  lastPollingTaskCount = store.taskOrder.length;
  allTasksTimer = setInterval(refreshAllTaskGitStatus, computeAllTasksInterval());
  // Run once immediately
  refreshActiveTaskGitStatus();
  refreshAllTaskGitStatus();
}

/** Call when tasks are added/removed to recalculate the all-tasks polling interval. */
export function rescheduleTaskStatusPolling(): void {
  if (!allTasksTimer) return;
  const currentCount = store.taskOrder.length;
  if (currentCount === lastPollingTaskCount) return;
  lastPollingTaskCount = currentCount;
  clearInterval(allTasksTimer);
  allTasksTimer = setInterval(refreshAllTaskGitStatus, computeAllTasksInterval());
}

export function stopTaskStatusPolling(): void {
  if (allTasksTimer) {
    clearInterval(allTasksTimer);
    allTasksTimer = null;
  }
  if (activeTaskTimer) {
    clearInterval(activeTaskTimer);
    activeTaskTimer = null;
  }
  lastPollingTaskCount = 0;
}
