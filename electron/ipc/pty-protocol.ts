import type { PtySpawnOpts } from './pty-backend.js';

// --- PTY host wire protocol (process-isolation Phase 2) ---
//
// The messages exchanged between the MAIN process (which runs session
// management) and the PTY HOST (an Electron utilityProcess that runs node-pty).
// Commands flow main -> host; events flow host -> main. Keeping this a tiny,
// explicit union means the same protocol can ride any transport: a real
// utilityProcess MessagePort in production, or an in-memory loopback in tests.

export type PtyCommand =
  | { type: 'spawn'; opts: PtySpawnOpts }
  | { type: 'write'; agentId: string; data: string }
  | { type: 'resize'; agentId: string; cols: number; rows: number }
  | { type: 'pause'; agentId: string }
  | { type: 'resume'; agentId: string }
  | { type: 'kill'; agentId: string };

export type PtyEvent =
  | { type: 'data'; agentId: string; data: string }
  | { type: 'exit'; agentId: string; exitCode: number; signal?: number };

export type PtyMessage = PtyCommand | PtyEvent;

/** A bidirectional message channel. Each side posts and listens; the concrete
 *  transport (utilityProcess port / loopback) decides delivery. */
export interface MessageTransport {
  post(msg: PtyMessage): void;
  onMessage(cb: (msg: PtyMessage) => void): void;
}
