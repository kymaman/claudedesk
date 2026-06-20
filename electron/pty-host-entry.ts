// Entry point for the PTY host utilityProcess (process-isolation Phase 2b).
//
// This file is the ONLY thing that runs in the child process: it owns node-pty
// (via createPtyHost -> LocalPtyBackend), so a conpty.node heap corruption
// crashes HERE, not the main process. It bridges its parentPort to the host and
// lets the PtyHostManager in main deal with restarts.

import { createPtyHost } from './ipc/pty-host.js';
import type { MessageTransport, PtyMessage } from './ipc/pty-protocol.js';

// In a utilityProcess, process.parentPort is the channel back to main. Guard so
// importing this file outside a utility process (shouldn't happen) is inert.
const parentPort = process.parentPort;

if (parentPort) {
  const transport: MessageTransport = {
    post: (msg) => parentPort.postMessage(msg),
    onMessage: (cb) => parentPort.on('message', (e: { data: PtyMessage }) => cb(e.data)),
  };
  createPtyHost(transport);
}
