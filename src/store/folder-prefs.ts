import { createPersistedSignal } from '../lib/persisted-signal';

const [_hide, setHide] = createPersistedSignal<boolean>('claudedesk.folderPrefs', false, {
  // The previous module persisted as `{ hideEmpty: boolean }` rather than a
  // raw boolean — keep that shape so existing users' settings survive.
  serialize: (v) => ({ hideEmpty: v }),
  deserialize: (raw) =>
    raw && typeof raw === 'object' && 'hideEmpty' in raw
      ? Boolean((raw as { hideEmpty: unknown }).hideEmpty)
      : null,
});

export const hideEmptyFolders = _hide;
export const setHideEmptyFolders = setHide;
