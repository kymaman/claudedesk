/**
 * assistant.ts
 * Module-level signal for the "Ask" sidebar visibility. Persisted in
 * localStorage so the sidebar state survives reloads.
 */

import { createPersistedSignal } from '../lib/persisted-signal';

const [_open, setOpen] = createPersistedSignal<boolean>('claudedesk.assistantOpen', false, {
  // Old format wrote the literal string '1' / '0' (no JSON quoting), so old
  // entries surface here as the number 1 or 0 after JSON.parse. Accept both
  // legacy and the new boolean shape.
  deserialize: (raw) => raw === true || raw === 1 || raw === '1',
});

export const assistantOpen = _open;

export function setAssistantOpen(next: boolean): void {
  setOpen(next);
}

export function toggleAssistant(): void {
  setOpen(!_open());
}
