/**
 * session-hide.ts
 * Client-side list of session ids the user chose to hide from History.
 * Physical removal happens via a separate IPC (delete_session_file) that the
 * renderer can invoke after confirmation.
 */

import { createPersistedSignal } from '../lib/persisted-signal';

const [_hidden, setHidden] = createPersistedSignal<Set<string>>(
  'claudedesk.hiddenSessions',
  new Set(),
  {
    serialize: (s) => [...s],
    deserialize: (raw) =>
      Array.isArray(raw) ? new Set(raw.filter((x): x is string => typeof x === 'string')) : null,
  },
);

export const hiddenSessions = _hidden;

export function isSessionHidden(sessionId: string): boolean {
  return _hidden().has(sessionId);
}

export function hideSession(sessionId: string): void {
  const next = new Set(_hidden());
  next.add(sessionId);
  setHidden(next);
}

export function unhideSession(sessionId: string): void {
  const next = new Set(_hidden());
  next.delete(sessionId);
  setHidden(next);
}

export function clearAllHidden(): void {
  setHidden(new Set<string>());
}
