import type { MessageTransport, PtyMessage } from './pty-protocol.js';

// --- PTY host manager: crash-contained transport (process-isolation Phase 2b) ---
//
// Owns the child process that hosts node-pty and presents a STABLE
// MessageTransport to RemotePtyBackend. The whole point of process isolation:
// when conpty.node corrupts the heap, only the child dies (c0000374 there is no
// longer fatal to the app). The manager catches that exit, tells the session
// layer every live terminal "exited" (so the renderer flushes + cleans up
// instead of the whole window vanishing), then forks a fresh host so new
// terminals work again.
//
// The child is injected as a factory so this is unit-testable with a fake child
// — no real utilityProcess. The real factory (utilityProcess.fork) is wired in
// main.ts behind a flag.

export interface PtyHostChild {
  postMessage(msg: PtyMessage): void;
  onMessage(cb: (msg: PtyMessage) => void): void;
  /** Fires when the child process dies (crash OR intentional kill). */
  onExit(cb: () => void): void;
  kill(): void;
}

export type PtyHostChildFactory = () => PtyHostChild;

export class PtyHostManager implements MessageTransport {
  private child: PtyHostChild;
  private mainCb: (msg: PtyMessage) => void = () => {};
  /** Agents with a live pty in the current child (tracked by snooping the wire
   *  so we know whom to "exit" if the child crashes). */
  private readonly live = new Set<string>();
  private shuttingDown = false;
  /** Crash counter (diagnostics / tests). */
  restarts = 0;

  constructor(private readonly fork: PtyHostChildFactory) {
    this.child = this.start();
  }

  private start(): PtyHostChild {
    const child = this.fork();
    child.onMessage((msg) => {
      // An exit clears the agent from the live set before the session layer sees
      // it, so a later crash won't double-report it.
      if (msg.type === 'exit') this.live.delete(msg.agentId);
      this.mainCb(msg);
    });
    child.onExit(() => this.handleChildExit());
    return child;
  }

  private handleChildExit(): void {
    if (this.shuttingDown) return; // intentional teardown — don't resurrect
    // The host (and every claude process it owned) is gone. Synthesize an exit
    // for each still-live agent so the session layer flushes, notifies the
    // renderer, and cleans up — the terminals die, but the APP stays alive.
    const dead = [...this.live];
    this.live.clear();
    this.restarts += 1;
    console.warn(
      `[pty-host] host child exited unexpectedly — contained; reporting ${dead.length} terminal(s) as exited and restarting (restart #${this.restarts})`,
    );
    for (const agentId of dead) {
      this.mainCb({ type: 'exit', agentId, exitCode: -1 });
    }
    // Fork a fresh host so new spawns work again.
    this.child = this.start();
  }

  post(msg: PtyMessage): void {
    if (msg.type === 'spawn') this.live.add(msg.opts.agentId);
    this.child.postMessage(msg);
  }

  onMessage(cb: (msg: PtyMessage) => void): void {
    this.mainCb = cb;
  }

  /** Intentional shutdown (app quit): kill the child and do NOT restart it. */
  shutdown(): void {
    this.shuttingDown = true;
    this.child.kill();
  }

  /** TEST-ONLY: kill the host child WITHOUT the shutdown flag, so its exit runs
   *  the crash path (synthesize exits + restart). Lets an e2e prove real
   *  containment by simulating a host crash. */
  crashForTest(): void {
    this.child.kill();
  }
}
