/**
 * session-filters.ts
 * User filters for the History list: sort order, hidden projects,
 * minimum size / duration heuristics. Everything persisted in localStorage.
 */

import { createPersistedSignal } from '../lib/persisted-signal';

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

const DEFAULT_STATE: FilterState = {
  sort: 'newest',
  hiddenProjects: [],
  minDurationSec: 0,
  minSizeKb: 0,
  extraFolders: [],
};

const SORT_VALUES: ReadonlySet<SortOrder> = new Set(['newest', 'oldest', 'project', 'title']);

function normalize(raw: unknown): FilterState | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<FilterState>;
  return {
    sort:
      typeof p.sort === 'string' && SORT_VALUES.has(p.sort as SortOrder)
        ? (p.sort as SortOrder)
        : 'newest',
    hiddenProjects: Array.isArray(p.hiddenProjects)
      ? p.hiddenProjects.filter((x): x is string => typeof x === 'string')
      : [],
    minDurationSec: typeof p.minDurationSec === 'number' ? p.minDurationSec : 0,
    minSizeKb: typeof p.minSizeKb === 'number' ? p.minSizeKb : 0,
    extraFolders: Array.isArray(p.extraFolders)
      ? p.extraFolders.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

const [_state, setState] = createPersistedSignal<FilterState>('claudedesk.filters', DEFAULT_STATE, {
  validate: normalize,
});

export const filterState = _state;

export function setSortOrder(sort: SortOrder): void {
  setState({ ..._state(), sort });
}

export function toggleHiddenProject(projectPath: string): void {
  const curr = _state();
  const already = curr.hiddenProjects.includes(projectPath);
  const hiddenProjects = already
    ? curr.hiddenProjects.filter((p) => p !== projectPath)
    : [...curr.hiddenProjects, projectPath];
  setState({ ...curr, hiddenProjects });
}

export function setMinSizeKb(minSizeKb: number): void {
  setState({ ..._state(), minSizeKb: Math.max(0, minSizeKb) });
}

export function setMinDurationSec(minDurationSec: number): void {
  setState({ ..._state(), minDurationSec: Math.max(0, minDurationSec) });
}

export function setExtraFolders(extraFolders: string[]): void {
  setState({ ..._state(), extraFolders: extraFolders.filter(Boolean) });
}
