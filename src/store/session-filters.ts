/**
 * session-filters.ts
 * User filters for the History list: sort order, hidden projects,
 * minimum size / duration heuristics. Everything persisted in localStorage.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';

export type SortOrder = 'newest' | 'oldest' | 'project' | 'title';

export interface FilterState {
  sort: SortOrder;
  hiddenProjects: string[];
  /** Hide sessions shorter than this many seconds of wall-clock time. 0 = off. */
  minDurationSec: number;
  /** Hide sessions whose JSONL file is smaller than this many KB. 0 = off. */
  minSizeKb: number;
  /** Extra folders to scan for JSONL beyond ~/.claude/projects. */
  extraFolders: string[];
}

const STORAGE_KEY = 'claudedesk.filters';

const DEFAULT_STATE: FilterState = {
  sort: 'newest',
  hiddenProjects: [],
  minDurationSec: 0,
  minSizeKb: 0,
  extraFolders: [],
};

function loadInitial(): FilterState {
  if (typeof localStorage === 'undefined') return DEFAULT_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<FilterState>;
    return {
      sort: (parsed.sort as SortOrder) ?? 'newest',
      hiddenProjects: Array.isArray(parsed.hiddenProjects)
        ? parsed.hiddenProjects.filter((x): x is string => typeof x === 'string')
        : [],
      minDurationSec: typeof parsed.minDurationSec === 'number' ? parsed.minDurationSec : 0,
      minSizeKb: typeof parsed.minSizeKb === 'number' ? parsed.minSizeKb : 0,
      extraFolders: Array.isArray(parsed.extraFolders)
        ? parsed.extraFolders.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    return DEFAULT_STATE;
  }
}

type RootSig<T> = [Accessor<T>, Setter<T>];

const [_state, _setState] = createRoot<RootSig<FilterState>>(() =>
  createSignal<FilterState>(loadInitial()),
);

export const filterState = _state;

function persist(next: FilterState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function setSortOrder(sort: SortOrder): void {
  const next = { ..._state(), sort };
  _setState(next);
  persist(next);
}

export function toggleHiddenProject(projectPath: string): void {
  const curr = _state();
  const already = curr.hiddenProjects.includes(projectPath);
  const hiddenProjects = already
    ? curr.hiddenProjects.filter((p) => p !== projectPath)
    : [...curr.hiddenProjects, projectPath];
  const next = { ...curr, hiddenProjects };
  _setState(next);
  persist(next);
}

export function setMinSizeKb(minSizeKb: number): void {
  const next = { ..._state(), minSizeKb: Math.max(0, minSizeKb) };
  _setState(next);
  persist(next);
}

export function setMinDurationSec(minDurationSec: number): void {
  const next = { ..._state(), minDurationSec: Math.max(0, minDurationSec) };
  _setState(next);
  persist(next);
}

export function setExtraFolders(extraFolders: string[]): void {
  const next = { ..._state(), extraFolders: extraFolders.filter(Boolean) };
  _setState(next);
  persist(next);
}
