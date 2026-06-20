import * as pty from 'node-pty';
import { execFileSync, execFile, spawn as cpSpawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BrowserWindow } from 'electron';
import { RingBuffer } from '../remote/ring-buffer.js';
import { resolveUserShell } from '../user-shell.js';
import { ensureClaudeSandboxFiles, ensureSandboxExcludes } from './git.js';
import {
  IS_WINDOWS,
  isAbsolutePath,
  homeDir,
  containsShellMetachars,
  validateCommandOnPath,
} from '../platform.js';
import {
  registerDrainControl,
  unregisterDrainControl,
  noteHeavyOutput,
} from './output-scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PtySession {
  proc: pty.IPty;
  channelId: string;
  taskId: string;
  agentId: string;
  isShell: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<(encoded: string) => void>;
  scrollback: RingBuffer;
  /** Assigned container name when running in Docker mode, null otherwise. */
  containerName: string | null;
  /** Set true the moment the underlying process exits. Native node-pty
   *  calls (resize/write) against an exited ConPTY can corrupt the heap and
   *  crash the whole main process (Windows c0000374) — which is NOT
   *  catchable in JS. We must SKIP the native call, not try/catch it. The
   *  coalesced resize burst on a grid reflow (e.g. branching a chat) is the
   *  classic way a late resize reaches a just-exited PTY. */
  exited: boolean;
  /** Pause intent from the renderer's per-terminal flow control (xterm behind).
   *  The PTY's pipe is paused when EITHER this or schedulerPaused is set, so the
   *  two controllers compose instead of fighting over the same socket. */
  rendererPaused: boolean;
  /** Pause intent from the cross-terminal output-drain scheduler (it holds the
   *  pipe while another terminal drains a heavy burst — 5th branch-crash fix). */
  schedulerPaused: boolean;
  /** The pause state we have actually applied to the native socket, so we only
   *  call proc.pause()/resume() on an EDGE (never redundantly). */
  nativePaused: boolean;
}

const sessions = new Map<string, PtySession>();

// --- PTY event bus for spawn/exit notifications ---
//
// We expose a thin `onPtyEvent` wrapper around Node's EventEmitter so callers
// get a consistent unsubscribe-function return (EventEmitter only offers
// imperative .off()). The previous hand-rolled Map<event, Set<listener>>
// did the same thing in 22 lines.

import { EventEmitter } from 'node:events';

type PtyEventType = 'spawn' | 'exit' | 'list-changed';
type PtyEventListener = (agentId: string, data?: unknown) => void;

const ptyEvents = new EventEmitter();
// PTY lifecycle has no fan-in cap; raise the warning threshold so spawning
// many agents doesn't trigger Node's "possible memory leak" message.
ptyEvents.setMaxListeners(0);

/** Register a listener for PTY lifecycle events. Returns an unsubscribe function. */
export function onPtyEvent(event: PtyEventType, listener: PtyEventListener): () => void {
  ptyEvents.on(event, listener);
  return () => {
    ptyEvents.off(event, listener);
  };
}

function emitPtyEvent(event: PtyEventType, agentId: string, data?: unknown): void {
  ptyEvents.emit(event, agentId, data);
}

/** Notify listeners that the agent list has changed (e.g. task deleted). */
export function notifyAgentListChanged(): void {
  emitPtyEvent('list-changed', '');
}

const BATCH_MAX = 64 * 1024;
const BATCH_INTERVAL = 8; // ms
const TAIL_CAP = 8 * 1024;
const MAX_LINES = 50;
// A single read at least this big counts as a "burst" for the cross-terminal
// drain scheduler. Interactive echo/prompt reads are tiny (<1KB); a /compact or
// other flood arrives in large chunks. Above this we ask the scheduler whether
// to keep draining or yield to a sibling terminal (Windows ConPTY race only).
const HEAVY_OUTPUT_BYTES = 4 * 1024;

/** Verify that a command exists in PATH. Throws a descriptive error if not found. */
export function validateCommand(command: string): void {
  if (!command || !command.trim()) {
    throw new Error('Command must not be empty.');
  }
  // Absolute paths: check directly via filesystem
  if (isAbsolutePath(command)) {
    try {
      // On Windows, node's X_OK check is flaky; fall back to F_OK (exists).
      fs.accessSync(command, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
      return;
    } catch {
      throw new Error(
        `Command '${command}' not found or not executable. Check that it is installed.`,
      );
    }
  }
  // Bare names: resolve via `which` on Unix, `where.exe` on Windows.
  validateCommandOnPath(command);
}

export function spawnAgent(
  win: BrowserWindow,
  args: {
    taskId: string;
    agentId: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    isShell?: boolean;
    dockerMode?: boolean;
    dockerImage?: string;
    onOutput: { __CHANNEL_ID__: string };
  },
): void {
  const channelId = args.onOutput.__CHANNEL_ID__;
  const command = args.command || resolveUserShell();
  const cwd = args.cwd || homeDir();

  // Reject commands with shell metacharacters (node-pty uses execvp, but
  // guard against accidental misuse). Allow bare names (resolved via PATH)
  // and absolute paths — Windows paths can legitimately contain `()`.
  if (containsShellMetachars(command)) {
    throw new Error(`Command contains disallowed characters: ${command}`);
  }

  // In Docker mode, we validate `docker` exists rather than the inner command
  if (!args.dockerMode) {
    validateCommand(command);
  } else {
    validateCommand('docker');
  }

  // Kill any existing session with the same agentId to prevent PTY leaks
  const existing = sessions.get(args.agentId);
  if (existing) {
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    existing.subscribers.clear();
    // Tearing down a ConPTY: open the guard window so a resize doesn't race
    // the teardown (the same heap-corruption class as spawn-vs-resize).
    markLifecycle();
    existing.proc.kill();
    sessions.delete(args.agentId);
    // Drop any stale scheduler state for this agentId before the fresh spawn
    // re-registers it (the replaced session's async onExit will early-return).
    unregisterDrainControl(args.agentId);
  }

  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) filteredEnv[k] = v;
  }

  // Only allow safe env overrides from renderer. Reject vars that could
  // alter process loading or execution behavior.
  const ENV_BLOCK_LIST = new Set([
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
  ]);
  const safeEnvOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.env ?? {})) {
    if (!ENV_BLOCK_LIST.has(k)) safeEnvOverrides[k] = v;
  }

  const spawnEnv: Record<string, string> = {
    ...filteredEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...safeEnvOverrides,
  };

  // Clear env vars that prevent nested agent sessions
  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.CLAUDE_CODE_SESSION;
  delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

  // Backfill sandbox placeholders for pre-existing worktrees (and anywhere
  // Claude Code may launch). See ensureClaudeSandboxFiles for the why.
  if (!args.dockerMode && fs.existsSync(cwd)) {
    ensureClaudeSandboxFiles(cwd);
    ensureSandboxExcludes(cwd);
  }

  let spawnCommand: string;
  let spawnArgs: string[];

  // Derive a predictable, unique container name from the agentId so we can
  // reliably stop it later without having to parse docker inspect output.
  const containerName = args.dockerMode ? `parallel-code-${args.agentId.slice(0, 12)}` : null;

  if (args.dockerMode) {
    const name = containerName as string;
    const image = args.dockerImage || DOCKER_DEFAULT_IMAGE;
    spawnCommand = 'docker';
    spawnArgs = [
      'run',
      '--rm',
      '-it',
      // Predictable name so we can stop the container on kill
      '--name',
      name,
      // Label so we can identify all containers owned by this app
      '--label',
      'parallel-code=true',
      // Host networking — agents need internet access for API calls and package installs.
      // Filesystem isolation (volume mounts) is the primary safety goal, not network isolation.
      '--network',
      'host',
      // Resource limits to prevent runaway containers
      '--memory',
      '8g',
      '--pids-limit',
      '512',
      // Run as host user so container files are owned by the host user
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      // Mount the project directory as the only writable volume
      '-v',
      `${cwd}:${cwd}`,
      '-w',
      cwd,
      // Forward env vars the agent needs (API keys, git config, etc.)
      ...buildDockerEnvFlags(spawnEnv),
      // Writable HOME for agent config files (host HOME is blocked above)
      '-e',
      `HOME=${DOCKER_CONTAINER_HOME}`,
      // Mount SSH and git config read-only for git operations
      ...buildDockerCredentialMounts(),
      image,
      command,
      ...args.args,
    ];
  } else {
    spawnCommand = command;
    spawnArgs = args.args;
  }

  const proc = pty.spawn(spawnCommand, spawnArgs, {
    name: 'xterm-256color',
    cols: args.cols,
    rows: args.rows,
    cwd: args.dockerMode ? undefined : cwd,
    env: args.dockerMode ? filteredEnv : spawnEnv,
  });

  const session: PtySession = {
    proc,
    channelId,
    taskId: args.taskId,
    agentId: args.agentId,
    isShell: args.isShell ?? false,
    flushTimer: null,
    subscribers: new Set(),
    scrollback: new RingBuffer(),
    containerName,
    exited: false,
    rendererPaused: false,
    schedulerPaused: false,
    nativePaused: false,
  };
  sessions.set(args.agentId, session);
  // A ConPTY connect just started on a background thread — open the guard
  // window so the grid-reflow resize storm defers instead of racing it.
  markLifecycle();
  // Register pause/resume so the cross-terminal drain scheduler can hold this
  // PTY's pipe while a sibling drains a heavy burst (composes with the
  // renderer's own flow control via applyPauseState).
  registerDrainControl(args.agentId, {
    pause: () => {
      session.schedulerPaused = true;
      applyPauseState(session);
    },
    resume: () => {
      session.schedulerPaused = false;
      applyPauseState(session);
    },
  });

  // Batching strategy matching the Rust implementation
  let batchChunks: Buffer[] = [];
  let batchSize = 0;
  let tailChunks: Buffer[] = [];
  let tailSize = 0;

  const send = (msg: unknown) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  // In Docker mode, write a diagnostic banner to the terminal so the user
  // can see what command is being run (and debug when nothing else appears).
  if (args.dockerMode) {
    const image = args.dockerImage || DOCKER_DEFAULT_IMAGE;
    const innerCmd = [command, ...args.args].join(' ');
    const banner =
      `\x1b[2m[docker] container: ${containerName}\r\n` +
      `[docker] image: ${image}\r\n` +
      `[docker] command: ${innerCmd}\r\n` +
      `[docker] waiting for container to start…\x1b[0m\r\n\r\n`;
    console.warn(`[docker] spawning container ${containerName} — image=${image} cmd=${innerCmd}`);
    send({ type: 'Data', data: Buffer.from(banner, 'utf8').toString('base64') });
  }

  const flush = () => {
    if (batchSize === 0) return;
    const batch = Buffer.concat(batchChunks);
    const encoded = batch.toString('base64');
    send({ type: 'Data', data: encoded });
    session.scrollback.write(batch);
    for (const sub of session.subscribers) {
      sub(encoded);
    }
    batchChunks = [];
    batchSize = 0;
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
  };

  proc.onData((data: string) => {
    const chunk = Buffer.from(data, 'utf8');

    // A heavy read means this PTY is bursting — let the scheduler decide whether
    // it keeps the drain token or yields, so two terminals never flood
    // conpty.node's allocator at once (Windows c0000374 heap-corruption fix).
    if (chunk.length >= HEAVY_OUTPUT_BYTES) noteHeavyOutput(session.agentId);

    // Maintain tail buffer for exit diagnostics
    tailChunks.push(chunk);
    tailSize += chunk.length;
    if (tailSize > TAIL_CAP) {
      const combined = Buffer.concat(tailChunks);
      const trimmed = combined.subarray(combined.length - TAIL_CAP);
      tailChunks = [trimmed];
      tailSize = trimmed.length;
    }

    batchChunks.push(chunk);
    batchSize += chunk.length;

    // Flush large batches immediately
    if (batchSize >= BATCH_MAX) {
      flush();
      return;
    }

    // Small read = likely interactive prompt, flush immediately
    if (chunk.length < 1024) {
      flush();
      return;
    }

    // Otherwise schedule flush on timer
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(flush, BATCH_INTERVAL);
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    // Mark exited FIRST (before any early return) so resize/write guards stop
    // touching the dead native handle — even for a session that was already
    // replaced by a newer spawn under the same agentId.
    session.exited = true;

    // If this session was replaced by a new spawn with the same agentId,
    // skip cleanup — the new session owns the map entry now.
    if (sessions.get(args.agentId) !== session) return;

    if (containerName) {
      console.warn(
        `[docker] container ${containerName} exited — code=${exitCode} signal=${signal ?? 'none'}`,
      );
    }

    // Flush any remaining buffered data
    flush();

    // Parse tail buffer into last N lines for exit diagnostics
    const tailBuf = Buffer.concat(tailChunks);
    const tailStr = tailBuf.toString('utf8');
    const lines = tailStr
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0)
      .slice(-MAX_LINES);

    send({
      type: 'Exit',
      data: {
        exit_code: exitCode,
        signal: signal !== undefined ? String(signal) : null,
        last_output: lines,
      },
    });

    emitPtyEvent('exit', args.agentId, { exitCode, signal });
    sessions.delete(args.agentId);
    // Free the scheduler's reference so it never resumes a dead pipe and hands
    // the drain token on to a live sibling if this one held it.
    unregisterDrainControl(args.agentId);
  });

  emitPtyEvent('spawn', args.agentId);
}

// --- Mass-spawn de-confliction (startup / project-open crash fix) ---
//
// When many tiles restore at once (app launch) or a project with many chats
// opens, every TerminalView mounts in the same tick and fires SpawnAgent in
// parallel. N concurrent ConPTY connects into conpty.node from N background
// threads is the SAME Windows heap-corruption race as a branch — a crash dump
// from a launch crash showed 17 threads inside conpty.node at once
// (c0000374). We serialise the native spawn: one ConPTY connect at a time with
// a small gap, so conpty.node is never initialising several pseudo-consoles
// concurrently. `spawnAgent` itself stays synchronous (its unit tests call it
// directly); the IPC handler awaits this queue instead.
let spawnChain: Promise<void> = Promise.resolve();
let spawnStaggerMs = IS_WINDOWS ? 90 : 0;

/** TEST-ONLY: override the inter-spawn gap so unit tests can assert the
 *  serialisation/stagger deterministically without a real OS delay. */
export function __setSpawnStaggerMsForTests(ms: number): void {
  spawnStaggerMs = ms;
}

/** Serialised spawn: chains onto the previous spawn so ConPTY connects never
 *  overlap, then waits `spawnStaggerMs` before the next one starts. Rejections
 *  are isolated (a bad command must not wedge later spawns) but still surface
 *  to THIS caller's awaited promise. */
export function spawnAgentSerialized(
  win: BrowserWindow,
  args: Parameters<typeof spawnAgent>[1],
): Promise<void> {
  const run = spawnChain.then(() => {
    spawnAgent(win, args);
  });
  const gap = (): Promise<void> => new Promise((r) => setTimeout(r, spawnStaggerMs));
  spawnChain = run.then(gap, gap);
  return run;
}

export function writeToAgent(agentId: string, data: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  // Writing to an exited PTY touches a freed native handle — skip silently
  // (the tile is on its way out; the bytes have nowhere to go).
  if (session.exited) return;
  session.proc.write(data);
}

/** Clamp a proposed terminal dimension to a sane positive integer. node-pty's
 *  native resize is unforgiving: 0, NaN, fractional, or absurdly large values
 *  can corrupt the ConPTY heap (an uncatchable c0000374 that kills the whole
 *  main process). xterm normally reports ≥1, but a 0×0 layout snapshot during
 *  a grid reflow can leak a 0 through — so we sanitise at the boundary. */
function sanitizeDim(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const n = Math.floor(value);
  if (n < 1) return null;
  // 4000 cols/rows is far beyond any real terminal; treat larger as bogus.
  return Math.min(n, 4000);
}

// --- ConPTY lifecycle / resize de-confliction (Windows heap-corruption fix) ---
//
// A crash dump (c0000374, NONCONTINUABLE) proved the corruption is inside
// conpty.node: the faulting thread sat 61 frames deep in node-pty's ConPTY
// code while a *branch* spawned a fresh PTY. Branching inserts a tile mid-grid,
// so the new `pty.spawn` (a ConPTY connect that runs on a background thread)
// fires at the same instant the grid reflow resizes every sibling PTY. Those
// concurrent entries into conpty.node from different threads race in the
// pseudo-console allocator and corrupt the heap — an uncatchable native crash
// that kills the whole main process.
//
// We can't serialise conpty.node's own internal threads, but we CAN stop
// ISSUING a resize storm while a spawn/kill is still settling. After each
// lifecycle op we open a short guard window; resizes that arrive inside it are
// deferred and coalesced (latest dims per agent win), then drained one at a
// time with a small gap so they never re-enter conpty.node in a single burst.
// Outside the window resize stays fully synchronous — so non-Windows and the
// steady state are unchanged.
let lastLifecycleAt = -Infinity;
// Guard window after a spawn/kill during which sibling resizes are deferred.
// 0 on non-Windows: only ConPTY has the race; POSIX ptys resize safely.
let lifecycleGuardMs = IS_WINDOWS ? 150 : 0;

/** TEST-ONLY: override the post-lifecycle resize guard window so unit tests
 *  can assert both the immediate (window=0) and deferred (window>0) paths
 *  deterministically, regardless of host OS. */
export function __setLifecycleGuardMsForTests(ms: number): void {
  lifecycleGuardMs = ms;
}
// Gap between drained native resizes, so a coalesced burst trickles into
// conpty.node instead of hitting it all in one tick.
const RESIZE_STAGGER_MS = 8;
const deferredResize = new Map<string, { cols: number; rows: number }>();
let resizeDrainTimer: ReturnType<typeof setTimeout> | null = null;

function markLifecycle(): void {
  lastLifecycleAt = Date.now();
}

/** Apply the latest deferred resize for one agent, then reschedule for the
 *  rest of the queue — staggered so conpty.node sees one resize at a time. */
function drainDeferredResizes(): void {
  resizeDrainTimer = null;
  const next = deferredResize.entries().next();
  if (next.done) return;
  const [agentId, dims] = next.value;
  deferredResize.delete(agentId);
  const session = sessions.get(agentId);
  if (session && !session.exited) {
    try {
      session.proc.resize(dims.cols, dims.rows);
    } catch (err) {
      console.warn(`[pty] deferred resize(${dims.cols}, ${dims.rows}) failed for ${agentId}:`, err);
    }
  }
  if (deferredResize.size > 0) {
    resizeDrainTimer = setTimeout(drainDeferredResizes, RESIZE_STAGGER_MS);
  }
}

export function resizeAgent(agentId: string, cols: number, rows: number): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  // Never resize a PTY whose process has exited: the native handle is gone
  // and resizing it can corrupt the heap (uncatchable native crash).
  if (session.exited) return;
  const c = sanitizeDim(cols);
  const r = sanitizeDim(rows);
  if (c === null || r === null) return; // drop a bogus (e.g. 0×0) snapshot

  // Inside the post-lifecycle guard window (a branch grid reflow is the
  // canonical case): defer + coalesce so we don't fire native resizes into
  // conpty.node while a fresh PTY is mid-connect on a background thread.
  if (Date.now() - lastLifecycleAt < lifecycleGuardMs) {
    deferredResize.set(agentId, { cols: c, rows: r });
    if (resizeDrainTimer === null) {
      resizeDrainTimer = setTimeout(drainDeferredResizes, lifecycleGuardMs);
    }
    return;
  }

  // Defensive try/catch catches node-pty's OWN guard throws (e.g. "cannot
  // resize a closed pty"); it does NOT catch native heap corruption — the
  // exited/dim guards above are what prevent that.
  try {
    session.proc.resize(c, r);
  } catch (err) {
    console.warn(`[pty] resize(${c}, ${r}) failed for ${agentId}:`, err);
  }
}

/** Apply the combined pause intent (renderer flow-control OR drain scheduler) to
 *  the native pipe, but only on a real edge so we never call pause()/resume()
 *  redundantly. Skips exited sessions — touching a dead ConPTY handle is the
 *  uncatchable c0000374 we guard against everywhere else. */
function applyPauseState(session: PtySession): void {
  if (session.exited) return;
  const shouldPause = session.rendererPaused || session.schedulerPaused;
  if (shouldPause === session.nativePaused) return;
  try {
    if (shouldPause) session.proc.pause();
    else session.proc.resume();
    session.nativePaused = shouldPause;
  } catch (err) {
    console.warn(`[pty] pause/resume failed for ${session.agentId}:`, err);
  }
}

export function pauseAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  // Renderer-driven pause (xterm fell behind). Composes with any scheduler pause.
  session.rendererPaused = true;
  applyPauseState(session);
}

export function resumeAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  // Renderer caught up; the PTY only actually resumes if the scheduler also
  // isn't holding it back.
  session.rendererPaused = false;
  applyPauseState(session);
}

export function killAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    // Clear subscribers before kill so the onExit flush doesn't
    // notify stale listeners. Let onExit handle sessions.delete
    // and emitPtyEvent to avoid the race condition.
    session.subscribers.clear();
    // Stop the Docker container first so it doesn't keep running after the
    // local PTY process (docker run) is killed. Fire-and-forget; the PTY kill
    // below is the authoritative termination signal.
    if (session.containerName) {
      stopDockerContainer(session.containerName);
    }
    // Opening the guard window before tearing the ConPTY down keeps a
    // concurrent grid-reflow resize from racing conpty.node's teardown.
    markLifecycle();
    // Free the drain token now (don't wait for the async onExit) so a sibling
    // that was paused behind this one resumes immediately.
    unregisterDrainControl(agentId);
    session.proc.kill();
  }
}

export function countRunningAgents(): number {
  return sessions.size;
}

export function killAllAgents(): void {
  for (const [, session] of sessions) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.subscribers.clear();
    if (session.containerName) {
      // Use synchronous docker kill with a short timeout so containers are
      // terminated before the Electron process exits. Errors are ignored
      // (container may already be gone).
      try {
        execFileSync('docker', ['kill', session.containerName], { timeout: 3000, stdio: 'pipe' });
      } catch {
        // Intentionally ignore: container may not exist or may have already stopped.
      }
    }
    unregisterDrainControl(session.agentId);
    session.proc.kill();
  }
  // Let onExit handlers clean up sessions individually
}

// --- Subscriber helpers for remote access ---

/** Subscribe to live base64-encoded output from an agent. */
export function subscribeToAgent(agentId: string, cb: (encoded: string) => void): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  session.subscribers.add(cb);
  return true;
}

/** Remove a previously registered output subscriber. */
export function unsubscribeFromAgent(agentId: string, cb: (encoded: string) => void): void {
  sessions.get(agentId)?.subscribers.delete(cb);
}

/** Get the scrollback buffer for an agent as a base64 string. */
export function getAgentScrollback(agentId: string): string | null {
  return sessions.get(agentId)?.scrollback.toBase64() ?? null;
}

/** Return all active agent IDs. */
export function getActiveAgentIds(): string[] {
  return Array.from(sessions.keys());
}

/** Return metadata for a specific agent, or null if not found. */
export function getAgentMeta(
  agentId: string,
): { taskId: string; agentId: string; isShell: boolean } | null {
  const s = sessions.get(agentId);
  return s ? { taskId: s.taskId, agentId: s.agentId, isShell: s.isShell } : null;
}

/** Return the current column width of an agent's PTY. */
export function getAgentCols(agentId: string): number {
  const s = sessions.get(agentId);
  return s ? s.proc.cols : 80;
}

// --- Docker mode helpers ---

/**
 * Writable HOME inside the Docker container.
 *
 * Docker tasks run as the host user's uid/gid so files created in the mounted
 * project worktree stay owned by the host user. On macOS that is often 501:20,
 * which cannot write to the image-owned /home/agent directory. Using /tmp keeps
 * HOME writable for arbitrary host-mapped users and avoids agents hanging
 * during startup while trying to initialize config under an unwritable home.
 */
export const DOCKER_CONTAINER_HOME = '/tmp';

/**
 * Env vars that are desktop/host-specific and must NOT be forwarded into the
 * container. Everything else is forwarded so agents can use arbitrary vars
 * (custom API keys, feature flags, tool config, etc.) without needing an
 * ever-growing allowlist.
 */

const DOCKER_ENV_BLOCK_LIST = new Set([
  // Host PATH must not override the container's PATH — agent CLIs like
  // `claude` are installed at /usr/local/bin inside the image and won't be
  // found if the host PATH (pointing at host-only dirs) is forwarded.
  'PATH',
  // Host HOME points to a non-writable directory inside the container when we
  // run as the host user's uid/gid. Agents need a writable HOME for config
  // files, so Docker mode sets HOME to DOCKER_CONTAINER_HOME explicitly.
  'HOME',
  // Display / desktop session
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'DBUS_SYSTEM_BUS_ADDRESS',
  'DESKTOP_SESSION',
  'XDG_CURRENT_DESKTOP',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_CLASS',
  'XDG_SESSION_ID',
  'XDG_SESSION_TYPE',
  'XDG_VTNR',
  'WINDOWID',
  'XAUTHORITY',
  // Electron / Node host internals
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  // Host-specific paths / linker
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  // Session / PAM
  'LOGNAME',
  'MAIL',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  // Active Claude Code session markers (prevent nested session confusion)
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  // SSH / GPG / k8s — agent sockets and credentials must not leak into container
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
  'KUBECONFIG',
]);

/** Returns true for env var names that should be blocked from Docker forwarding. */
function isBlockedDockerEnvKey(key: string): boolean {
  if (DOCKER_ENV_BLOCK_LIST.has(key)) return true;
  // Block all remaining XDG_* vars not explicitly listed above
  if (key.startsWith('XDG_')) return true;
  // Block all ELECTRON_* vars not explicitly listed above
  if (key.startsWith('ELECTRON_')) return true;
  // Block all SUDO_* vars (e.g. SUDO_USER, SUDO_UID) — host privilege context
  if (key.startsWith('SUDO_')) return true;
  return false;
}

function buildDockerEnvFlags(env: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!isBlockedDockerEnvKey(key) && value !== undefined) {
      flags.push('-e', `${key}=${value}`);
    }
  }
  return flags;
}

function buildDockerCredentialMounts(): string[] {
  const mounts: string[] = [];
  const home = process.env.HOME;
  if (!home) return mounts;

  /** Mount a host path read-only into the container home. Skips if absent. */
  const mountIfExists = (hostPath: string, containerPath: string): void => {
    try {
      fs.accessSync(hostPath, fs.constants.R_OK);
      mounts.push('-v', `${hostPath}:${containerPath}:ro`);
    } catch {
      // Path absent or unreadable — skip
    }
  };

  // SSH keys for git push/pull
  mountIfExists(`${home}/.ssh`, `${DOCKER_CONTAINER_HOME}/.ssh`);

  // Git identity / config
  mountIfExists(`${home}/.gitconfig`, `${DOCKER_CONTAINER_HOME}/.gitconfig`);

  // GitHub CLI auth tokens (~/.config/gh/)
  mountIfExists(`${home}/.config/gh`, `${DOCKER_CONTAINER_HOME}/.config/gh`);

  // npm auth token
  mountIfExists(`${home}/.npmrc`, `${DOCKER_CONTAINER_HOME}/.npmrc`);

  // General HTTP/git HTTPS credentials (used by git credential helper)
  mountIfExists(`${home}/.netrc`, `${DOCKER_CONTAINER_HOME}/.netrc`);

  // Google Application Credentials file (for Vertex AI / gcloud) — mounted
  // at its original path since the env var points there.
  const googleCredsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (googleCredsFile) {
    mountIfExists(googleCredsFile, googleCredsFile);
  }

  return mounts;
}

/**
 * Asynchronously stop a Docker container by name. Fire-and-forget — errors are
 * silently swallowed because the container may have already exited by the time
 * this is called.
 */
function stopDockerContainer(name: string): void {
  execFile('docker', ['stop', name], { timeout: 10_000 }, () => {
    // Intentionally ignore errors: container may not exist or may have already stopped.
  });
}

/** Check if Docker is available on the system. */
export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['info'], { encoding: 'utf8', timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** The default image name for Docker-isolated tasks. */
export const DOCKER_DEFAULT_IMAGE = 'parallel-code-agent:latest';

/** Label key used to stamp the Dockerfile content hash on built images. */
const DOCKERFILE_HASH_LABEL = 'parallel-code-dockerfile-hash';

/**
 * Resolve the path to the bundled Dockerfile.
 * In dev mode it lives at `<repo>/docker/Dockerfile`;
 * in production it's inside the asar resources directory.
 */
function resolveDockerfilePath(): string | null {
  const devDockerDir = path.join(__dirname, '..', '..', 'docker');
  const prodDockerDir = path.join(process.resourcesPath ?? '', 'docker');
  const dockerDir = fs.existsSync(path.join(devDockerDir, 'Dockerfile'))
    ? devDockerDir
    : prodDockerDir;
  const p = path.join(dockerDir, 'Dockerfile');
  return fs.existsSync(p) ? p : null;
}

/** SHA-256 hex digest of an arbitrary Dockerfile, or null if unreadable. */
export function hashDockerfile(dockerfilePath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(dockerfilePath)).digest('hex');
  } catch {
    return null;
  }
}

/** SHA-256 hex digest of the bundled Dockerfile, or null if not found. */
function getDockerfileHash(): string | null {
  const p = resolveDockerfilePath();
  if (!p) return null;
  return hashDockerfile(p);
}

/**
 * Check if a project has a local Dockerfile at .parallel-code/Dockerfile.
 * Returns the absolute path if found, null otherwise.
 */
export function resolveProjectDockerfile(projectRoot: string): string | null {
  const p = path.join(projectRoot, '.parallel-code', 'Dockerfile');
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Derive a deterministic image tag for a project Dockerfile.
 * Tag format: parallel-code-project:<first-12-of-sha256>
 */
export function projectImageTag(dockerfilePath: string): string {
  const hash = hashDockerfile(dockerfilePath);
  return `parallel-code-project:${(hash ?? 'unknown').slice(0, 12)}`;
}

/**
 * Check if a Docker image exists locally **and** matches the current Dockerfile.
 * Returns false when the image is missing or was built from a different Dockerfile,
 * so the UI will prompt the user to (re)build.
 *
 * When `opts.dockerfilePath` is provided, hash that file for the staleness check.
 * When the image is not the default and no `dockerfilePath` is given, skip the hash
 * check entirely (just verify the image exists).
 */
export async function dockerImageExists(
  image: string,
  opts?: { dockerfilePath?: string },
): Promise<boolean> {
  const customPath = opts?.dockerfilePath;
  const expectedHash = customPath
    ? hashDockerfile(customPath)
    : image === DOCKER_DEFAULT_IMAGE
      ? getDockerfileHash()
      : null;

  if (customPath && !expectedHash) {
    return false;
  }

  return new Promise((resolve) => {
    execFile(
      'docker',
      [
        'image',
        'inspect',
        '--format',
        `{{index .Config.Labels "${DOCKERFILE_HASH_LABEL}"}}`,
        image,
      ],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        if (!expectedHash) {
          resolve(true);
          return;
        }
        resolve(stdout.trim() === expectedHash);
      },
    );
  });
}

/** Deduplicates concurrent calls to buildDockerImage. Null when no build is in progress. */
let activeBuild: Promise<{ ok: boolean; error?: string }> | null = null;

/**
 * Build a Dockerfile into a Docker image.
 * Streams build output to the renderer via an IPC channel so the user can see progress.
 * Returns a promise that resolves on success, rejects on failure.
 *
 * When no `opts` are given, builds the bundled Dockerfile into the default image
 * (backward compatible). Concurrent calls for the default image share the same
 * in-flight promise; custom builds are never deduplicated.
 */
export function buildDockerImage(
  win: BrowserWindow,
  onOutputChannel: string,
  opts?: { dockerfilePath?: string; buildContext?: string; imageTag?: string },
): Promise<{ ok: boolean; error?: string }> {
  const isDefaultBuild = !opts?.dockerfilePath && !opts?.buildContext && !opts?.imageTag;

  // Only dedup when building the default image
  if (isDefaultBuild && activeBuild !== null) {
    return activeBuild;
  }

  const buildPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const finish = (result: { ok: boolean; error?: string }) => {
      if (isDefaultBuild) {
        activeBuild = null;
      }
      resolve(result);
    };

    const resolvedDockerfilePath = opts?.dockerfilePath ?? resolveDockerfilePath();
    if (!resolvedDockerfilePath) {
      finish({ ok: false, error: 'Dockerfile not found' });
      return;
    }
    const buildContext = opts?.buildContext ?? path.dirname(resolvedDockerfilePath);
    const hash = hashDockerfile(resolvedDockerfilePath) ?? 'unknown';
    const imageTag = opts?.imageTag ?? DOCKER_DEFAULT_IMAGE;

    const send = (text: string) => {
      if (!win.isDestroyed()) {
        win.webContents.send(onOutputChannel, text);
      }
    };

    const proc = cpSpawn(
      'docker',
      [
        'build',
        '-t',
        imageTag,
        '--label',
        `${DOCKERFILE_HASH_LABEL}=${hash}`,
        '-f',
        resolvedDockerfilePath,
        buildContext,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    proc.stdout?.on('data', (chunk: Buffer) => send(chunk.toString('utf8')));
    proc.stderr?.on('data', (chunk: Buffer) => send(chunk.toString('utf8')));

    proc.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, error: `docker build exited with code ${code}` });
      }
    });
  });

  if (isDefaultBuild) {
    activeBuild = buildPromise;
  }

  return buildPromise;
}
