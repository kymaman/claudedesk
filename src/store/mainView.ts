/**
 * mainView.ts
 * Global signal for the currently displayed main view.
 * Isolated from the parallel-code persisted store to avoid schema churn.
 */

import { createPersistedSignal } from '../lib/persisted-signal';

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
