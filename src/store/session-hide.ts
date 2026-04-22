/* eslint-disable solid/reactivity -- createRoot(() => createSignal(...)) is an intentional HMR-safe pattern; the tuple is destructured at the outer call site, which the linter can't see through the closure. */
/**
 * session-hide.ts
 * Client-side list of session ids the user chose to hide from History.
 * Physical removal happens via a separate IPC (delete_session_file) that the
 * renderer can invoke after confirmation.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';

const KEY = 'claudedesk.hiddenSessions';

function loadInitial(): Set<string> {
  try {
    if (typeof localStorage === 'undefined') return new Set();
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

type RootSig<T> = [Accessor<T>, Setter<T>];

const [_hidden, _setHidden] = createRoot<RootSig<Set<string>>>(() =>
  createSignal<Set<string>>(loadInitial()),
);

export const hiddenSessions = _hidden;

function persist(set: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

export function isSessionHidden(sessionId: string): boolean {
  return _hidden().has(sessionId);
}

export function hideSession(sessionId: string): void {
  const next = new Set(_hidden());
  next.add(sessionId);
  _setHidden(next);
  persist(next);
}

export function unhideSession(sessionId: string): void {
  const next = new Set(_hidden());
  next.delete(sessionId);
  _setHidden(next);
  persist(next);
}

export function clearAllHidden(): void {
  const empty = new Set<string>();
  _setHidden(empty);
  persist(empty);
}
