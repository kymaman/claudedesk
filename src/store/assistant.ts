/* eslint-disable solid/reactivity -- createRoot(() => createSignal(...)) is an intentional HMR-safe pattern; the tuple is destructured at the outer call site, which the linter can't see through the closure. */
/**
 * assistant.ts
 * Module-level signal for the "Ask" sidebar visibility. Persisted in
 * localStorage so the sidebar state survives reloads.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';

const KEY = 'claudedesk.assistantOpen';

function loadInitial(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

const [_open, _setOpen] = createRoot<[Accessor<boolean>, Setter<boolean>]>(() =>
  createSignal(loadInitial()),
);

export const assistantOpen = _open;

export function setAssistantOpen(next: boolean): void {
  _setOpen(next);
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    /* storage quota / private mode */
  }
}

export function toggleAssistant(): void {
  setAssistantOpen(!_open());
}
