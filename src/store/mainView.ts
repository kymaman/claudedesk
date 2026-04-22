/**
 * mainView.ts
 * Global signal for the currently displayed main view.
 * Isolated from the parallel-code persisted store to avoid schema churn.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';

export type MainView = 'history' | 'branches' | 'agents';

const STORAGE_KEY = 'claudedesk.mainView';

function loadInitial(): MainView {
  if (typeof localStorage === 'undefined') return 'history';
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'branches' || v === 'agents' || v === 'history') return v;
  return 'history';
}

// Module-level signal owned by a persistent root so Solid doesn't warn
// about "computations created outside createRoot" on HMR.
const [_mainView, _setMainView] = createRoot<[Accessor<MainView>, Setter<MainView>]>(() =>
  createSignal<MainView>(loadInitial()),
);

export const mainView = _mainView;

export function setMainView(v: MainView): void {
  _setMainView(v);
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* storage quota / private mode — non-fatal */
  }
}
