import { IS_WINDOWS } from '../platform.js';

// --- Cross-terminal output-drain serialiser (branch-crash 5th trigger) ---
//
// Trigger: `/compact` (or any big burst) in TWO terminals at once → app dies
// with c0000374 heap corruption. A crash dump showed 187 pointers into
// conpty.node: node-pty runs a reader thread per PTY, and when several flood at
// once they race in ConPTY's pseudo-console allocator. The earlier guards
// (spawn serialisation, resize deferral, rename ref-stability) only cover
// spawn/resize/kill — this path is pure concurrent READ, which we never call.
//
// We can't serialise node-pty's internal threads, but `proc.pause()` pauses the
// libuv pipe socket, so the OS pipe fills and conpty.node stops reading THAT
// PTY (backpressure). So we grant a short "drain token" to one agent at a time
// and pause the others, round-robining the token so no two agents drain a heavy
// burst concurrently while every terminal still makes progress.
//
// Windows-only: `drainSliceMs` is 0 elsewhere, which disables the scheduler
// (POSIX ptys have no ConPTY allocator race). Honest scope: this REDUCES
// concurrent native read pressure; it can't serialise the lib's own threads, so
// the definitive fix remains process isolation or a pty-backend swap.

export interface DrainControl {
  pause(): void;
  resume(): void;
}

// How long one agent may hold the drain token before it rotates to the next
// waiter. Small enough that the added latency under concurrent bursts is
// imperceptible (~one slice per other busy terminal), large enough that a PTY
// makes real progress each turn. 0 disables the scheduler (non-Windows).
let drainSliceMs = IS_WINDOWS ? 24 : 0;

const controls = new Map<string, DrainControl>();
/** Agent currently allowed to drain heavy output; null when the token is free. */
let holder: string | null = null;
/** FIFO of agents we have paused, waiting for the token. */
const pausedOrder: string[] = [];
const pausedSet = new Set<string>();
let sliceTimer: ReturnType<typeof setTimeout> | null = null;

function armSlice(): void {
  if (sliceTimer !== null) return;
  sliceTimer = setTimeout(rotate, drainSliceMs);
}

function clearSlice(): void {
  if (sliceTimer !== null) {
    clearTimeout(sliceTimer);
    sliceTimer = null;
  }
}

/** Resume a paused agent: drop it from the wait queue and un-pause its pipe. */
function resumePaused(agentId: string): void {
  pausedSet.delete(agentId);
  const i = pausedOrder.indexOf(agentId);
  if (i >= 0) pausedOrder.splice(i, 1);
  controls.get(agentId)?.resume();
}

/** Token slice elapsed: hand it to the next waiter (resuming it), or free it. */
function rotate(): void {
  sliceTimer = null;
  const next = pausedOrder[0];
  if (next === undefined) {
    holder = null;
    return;
  }
  resumePaused(next);
  holder = next;
  armSlice();
}

/** Register an agent's pause/resume controls. Call once per spawned PTY. */
export function registerDrainControl(agentId: string, control: DrainControl): void {
  controls.set(agentId, control);
}

/** Forget an agent (exit/kill/replace). A paused agent is dropped WITHOUT
 *  resume — its pty is gone; resuming a dead handle is the very crash we guard
 *  against. If it held the token, free it and hand off to the next waiter so
 *  nobody is left paused. */
export function unregisterDrainControl(agentId: string): void {
  pausedSet.delete(agentId);
  const i = pausedOrder.indexOf(agentId);
  if (i >= 0) pausedOrder.splice(i, 1);
  controls.delete(agentId);

  if (holder === agentId) {
    clearSlice();
    holder = null;
    if (pausedOrder.length > 0) rotate();
  }
}

/** Note that an agent just emitted a heavy chunk. If another agent holds the
 *  drain token, this one is paused until its turn; the first burster takes the
 *  token and is never paused (single-terminal output is untouched). */
export function noteHeavyOutput(agentId: string): void {
  if (drainSliceMs <= 0) return; // disabled (non-Windows)
  if (!controls.has(agentId)) return; // unknown/exited agent (data after exit race)
  if (holder === null) {
    holder = agentId;
    armSlice();
    return;
  }
  if (holder === agentId) return; // keep draining; never pause the holder
  if (pausedSet.has(agentId)) return; // already paused
  pausedSet.add(agentId);
  pausedOrder.push(agentId);
  controls.get(agentId)?.pause();
}

/** TEST-ONLY: set the token slice (and enable/disable via 0) deterministically. */
export function __setDrainSliceMsForTests(ms: number): void {
  drainSliceMs = ms;
}

/** TEST-ONLY: clear all scheduler state between cases. */
export function __resetDrainSchedulerForTests(): void {
  clearSlice();
  holder = null;
  pausedOrder.length = 0;
  pausedSet.clear();
  controls.clear();
}

/** TEST-ONLY: snapshot the token holder and the paused wait-queue. */
export function __getDrainStateForTests(): { holder: string | null; paused: string[] } {
  return { holder, paused: [...pausedOrder] };
}
