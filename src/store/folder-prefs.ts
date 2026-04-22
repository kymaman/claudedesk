import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';

const KEY = 'claudedesk.folderPrefs';
const initial = (() => {
  try {
    if (typeof localStorage === 'undefined') return { hideEmpty: false };
    const raw = localStorage.getItem(KEY);
    if (!raw) return { hideEmpty: false };
    const p = JSON.parse(raw) as { hideEmpty?: boolean };
    return { hideEmpty: !!p.hideEmpty };
  } catch {
    return { hideEmpty: false };
  }
})();

type RootSig<T> = [Accessor<T>, Setter<T>];

const [_hide, _setHide] = createRoot<RootSig<boolean>>(() =>
  createSignal<boolean>(initial.hideEmpty),
);

export const hideEmptyFolders = _hide;

export function setHideEmptyFolders(v: boolean): void {
  _setHide(v);
  try {
    localStorage.setItem(KEY, JSON.stringify({ hideEmpty: v }));
  } catch {
    /* ignore */
  }
}
