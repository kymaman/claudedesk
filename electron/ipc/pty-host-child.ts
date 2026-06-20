import { utilityProcess } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PtyHostChild, PtyHostChildFactory } from './pty-host-manager.js';
import type { PtyMessage } from './pty-protocol.js';

// Real PtyHostChild factory: forks the node-pty host as an Electron
// utilityProcess. The manager calls this to (re)create the host. Untested in
// unit (Electron-only); the manager's crash/restart logic is tested with a fake
// child, and this wiring is exercised at runtime behind the CLAUDEDESK_PTY_HOST
// flag.

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // dist-electron/ipc
// The compiled entry sits one level up, next to main.js.
const ENTRY = path.join(__dirname, '..', 'pty-host-entry.js');

export const forkPtyHostChild: PtyHostChildFactory = (): PtyHostChild => {
  const proc = utilityProcess.fork(ENTRY, [], {
    serviceName: 'claudedesk-pty-host',
    // node-pty needs a real environment (PATH etc.) to spawn shells/claude.
    env: process.env as Record<string, string>,
  });

  return {
    postMessage: (msg) => proc.postMessage(msg),
    onMessage: (cb) => proc.on('message', (msg: PtyMessage) => cb(msg)),
    onExit: (cb) => proc.on('exit', () => cb()),
    kill: () => {
      proc.kill();
    },
  };
};
