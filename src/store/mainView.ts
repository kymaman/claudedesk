/**
 * mainView.ts
 * Global signal for the currently displayed main view.
 * Isolated from the parallel-code persisted store to avoid schema churn.
 */

import { createPersistedSignal } from '../lib/persisted-signal';

// 'tree' was a top-level tab 2026-06-10..11; the tree now expands inline
// inside History (▸ on a session row). A persisted 'tree' value fails
// validation below and falls back to 'history' — intentional.
export type MainView = 'history' | 'branches' | 'agents' | 'chats' | 'projects';

const VALID: ReadonlySet<MainView> = new Set([
  'history',
  'branches',
  'agents',
  'chats',
  'projects',
]);

const [_mainView, setMainViewInternal] = createPersistedSignal<MainView>(
  'claudedesk.mainView',
  'history',
  {
    validate: (raw) =>
      typeof raw === 'string' && VALID.has(raw as MainView) ? (raw as MainView) : null,
  },
);

export const mainView = _mainView;
export const setMainView = setMainViewInternal;
