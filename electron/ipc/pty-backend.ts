import * as pty from 'node-pty';

// --- The PTY backend seam (process-isolation Phase 1) ---
//
// Today node-pty runs in the Electron MAIN process, so a heap corruption inside
// conpty.node (the recurring Windows c0000374 branch crash) takes down every
// window — it's a native, uncatchable crash of the main process.
//
// This interface is the seam we need to fix that for good: it captures EVERY
// operation that touches node-pty (spawn / write / resize / pause / resume /
// kill) plus the data/exit callbacks, keyed by agentId. Session management
// (batching, scrollback, lifecycle guards, the output-drain scheduler) lives
// ABOVE this seam and only ever talks to a PtyBackend.
//
// Phase 1 (this commit): `LocalPtyBackend` runs node-pty in-process — identical
// behaviour to before, just routed through the seam.
// Phase 2 (next): a `UtilityPtyBackend` will implement the same interface by
// forwarding to an Electron utilityProcess that hosts node-pty, so a conpty.node
// crash kills only that child process (auto-restartable) and the app survives.
// Because both implement PtyBackend, the session layer doesn't change.

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface PtySpawnOpts {
  agentId: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyBackend {
  /** Create a native pty for an agentId. Replaces any existing one. */
  spawn(opts: PtySpawnOpts): void;
  write(agentId: string, data: string): void;
  resize(agentId: string, cols: number, rows: number): void;
  pause(agentId: string): void;
  resume(agentId: string): void;
  kill(agentId: string): void;
  /** Current column count (xterm queries it); 80 if the agent is unknown. */
  cols(agentId: string): number;
  /** True while a live native handle exists for this agent. */
  has(agentId: string): boolean;
  /** Register the single data sink. Raw chunks arrive tagged by agentId. */
  setOnData(cb: (agentId: string, data: string) => void): void;
  /** Register the single exit sink. Fires once per agent when its pty exits. */
  setOnExit(cb: (agentId: string, ev: PtyExitEvent) => void): void;
}

/** Minimal shape of node-pty's spawn so the backend can be unit-tested with a
 *  fake (no real ConPTY) and so the real `pty.spawn` slots in unchanged. */
export type PtySpawnFn = (
  command: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd?: string; env: Record<string, string> },
) => pty.IPty;

/** In-process backend: node-pty runs in the main process (current behaviour). */
export class LocalPtyBackend implements PtyBackend {
  private readonly procs = new Map<string, pty.IPty>();
  private onData: (agentId: string, data: string) => void = () => {};
  private onExit: (agentId: string, ev: PtyExitEvent) => void = () => {};

  constructor(private readonly spawnFn: PtySpawnFn = pty.spawn) {}

  setOnData(cb: (agentId: string, data: string) => void): void {
    this.onData = cb;
  }

  setOnExit(cb: (agentId: string, ev: PtyExitEvent) => void): void {
    this.onExit = cb;
  }

  spawn(opts: PtySpawnOpts): void {
    const proc = this.spawnFn(opts.command, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    this.procs.set(opts.agentId, proc);
    // Only surface events from the CURRENT proc for an agentId. After a
    // replace-on-respawn (same agentId, new handle) the old proc may still emit
    // a late data chunk or its exit — those must be swallowed, exactly as the
    // session layer's identity guard did before, so the old handle can't feed
    // or tear down the fresh session.
    proc.onData((data: string) => {
      if (this.procs.get(opts.agentId) === proc) this.onData(opts.agentId, data);
    });
    proc.onExit((ev: { exitCode: number; signal?: number }) => {
      if (this.procs.get(opts.agentId) !== proc) return; // replaced — old exit is a no-op
      this.procs.delete(opts.agentId);
      this.onExit(opts.agentId, { exitCode: ev.exitCode, signal: ev.signal });
    });
  }

  write(agentId: string, data: string): void {
    this.procs.get(agentId)?.write(data);
  }

  resize(agentId: string, cols: number, rows: number): void {
    this.procs.get(agentId)?.resize(cols, rows);
  }

  pause(agentId: string): void {
    this.procs.get(agentId)?.pause();
  }

  resume(agentId: string): void {
    this.procs.get(agentId)?.resume();
  }

  kill(agentId: string): void {
    this.procs.get(agentId)?.kill();
  }

  cols(agentId: string): number {
    return this.procs.get(agentId)?.cols ?? 80;
  }

  has(agentId: string): boolean {
    return this.procs.has(agentId);
  }
}
