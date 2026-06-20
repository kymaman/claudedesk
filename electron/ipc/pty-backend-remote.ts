import type { PtyBackend, PtySpawnOpts, PtyExitEvent } from './pty-backend.js';
import type { MessageTransport, PtyEvent } from './pty-protocol.js';

// --- Remote (out-of-process) PTY backend (process-isolation Phase 2) ---
//
// Implements the SAME PtyBackend interface as LocalPtyBackend, but instead of
// touching node-pty it forwards every op as a command over a transport to a PTY
// host running in a child process, and turns the host's events back into the
// onData/onExit callbacks the session layer expects.
//
// cols()/has() are synchronous in PtyBackend, but a child process can't be
// queried synchronously — so we keep a local mirror (live agents -> last known
// cols), updated from spawn/resize/exit. This is exact because EVERY resize goes
// through this backend, so node-pty's actual cols never diverges from what we
// last sent.

export class RemotePtyBackend implements PtyBackend {
  /** Live agents -> last cols we set (spawn or resize). Absence == not live. */
  private readonly liveCols = new Map<string, number>();
  private onData: (agentId: string, data: string) => void = () => {};
  private onExit: (agentId: string, ev: PtyExitEvent) => void = () => {};

  constructor(private readonly transport: MessageTransport) {
    transport.onMessage((msg) => {
      const ev = msg as PtyEvent;
      if (ev.type === 'data') {
        this.onData(ev.agentId, ev.data);
      } else if (ev.type === 'exit') {
        this.liveCols.delete(ev.agentId);
        this.onExit(ev.agentId, { exitCode: ev.exitCode, signal: ev.signal });
      }
    });
  }

  setOnData(cb: (agentId: string, data: string) => void): void {
    this.onData = cb;
  }

  setOnExit(cb: (agentId: string, ev: PtyExitEvent) => void): void {
    this.onExit = cb;
  }

  spawn(opts: PtySpawnOpts): void {
    this.liveCols.set(opts.agentId, opts.cols);
    this.transport.post({ type: 'spawn', opts });
  }

  write(agentId: string, data: string): void {
    this.transport.post({ type: 'write', agentId, data });
  }

  resize(agentId: string, cols: number, rows: number): void {
    // Keep the mirror in step, but don't resurrect a dead agent's entry.
    if (this.liveCols.has(agentId)) this.liveCols.set(agentId, cols);
    this.transport.post({ type: 'resize', agentId, cols, rows });
  }

  pause(agentId: string): void {
    this.transport.post({ type: 'pause', agentId });
  }

  resume(agentId: string): void {
    this.transport.post({ type: 'resume', agentId });
  }

  kill(agentId: string): void {
    this.transport.post({ type: 'kill', agentId });
  }

  cols(agentId: string): number {
    return this.liveCols.get(agentId) ?? 80;
  }

  has(agentId: string): boolean {
    return this.liveCols.has(agentId);
  }
}
