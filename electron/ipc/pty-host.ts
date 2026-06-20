import { LocalPtyBackend, type PtySpawnFn } from './pty-backend.js';
import type { MessageTransport, PtyCommand } from './pty-protocol.js';

// --- PTY host (runs inside the utilityProcess in Phase 2b) ---
//
// Hosts a real LocalPtyBackend (node-pty) and bridges it to a transport:
// inbound commands drive the backend; the backend's data/exit events are posted
// back. This is the ONLY code that will live in the child process, so if
// conpty.node corrupts the heap the crash is contained here — the main process
// (and every window) survives.
//
// `spawnFn` is injectable so this can be unit-tested against a fake pty with no
// real ConPTY; production passes the default (node-pty's spawn).

export function createPtyHost(transport: MessageTransport, spawnFn?: PtySpawnFn): LocalPtyBackend {
  const backend = new LocalPtyBackend(spawnFn);

  backend.setOnData((agentId, data) => transport.post({ type: 'data', agentId, data }));
  backend.setOnExit((agentId, ev) =>
    transport.post({ type: 'exit', agentId, exitCode: ev.exitCode, signal: ev.signal }),
  );

  transport.onMessage((msg) => {
    // Only commands are expected inbound; events are ignored defensively.
    const cmd = msg as PtyCommand;
    switch (cmd.type) {
      case 'spawn':
        backend.spawn(cmd.opts);
        break;
      case 'write':
        backend.write(cmd.agentId, cmd.data);
        break;
      case 'resize':
        backend.resize(cmd.agentId, cmd.cols, cmd.rows);
        break;
      case 'pause':
        backend.pause(cmd.agentId);
        break;
      case 'resume':
        backend.resume(cmd.agentId);
        break;
      case 'kill':
        backend.kill(cmd.agentId);
        break;
      default:
        break;
    }
  });

  return backend;
}
