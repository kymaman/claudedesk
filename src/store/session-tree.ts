/**
 * session-tree.ts
 * Renderer-side cache of session FAMILIES (lineage trees) for the
 * inline tree expansion in History. Loaded lazily once per app run —
 * the main-process scan reads every JSONL head, so we don't refetch
 * on every History open. `refreshSessionTree()` forces a re-scan
 * (e.g. after a branch was created).
 */

import { createSignal } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { TreeFamily } from '../lib/session-tree-layout';

const [families, setFamilies] = createSignal<TreeFamily[]>([]);
const [familyIndex, setFamilyIndex] = createSignal<Map<string, TreeFamily>>(new Map());
const [treeLoading, setTreeLoading] = createSignal(false);

let loadedOnce = false;
let inFlight: Promise<void> | null = null;

export { families as sessionFamilies, treeLoading as sessionTreeLoading };

/** Family containing this session, or undefined for singletons. */
export function familyFor(sessionId: string): TreeFamily | undefined {
  return familyIndex().get(sessionId);
}

export function loadSessionTree(force = false): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (inFlight) return inFlight;
  if (loadedOnce && !force) return Promise.resolve();
  setTreeLoading(true);
  inFlight = invoke<TreeFamily[]>(IPC.ListSessionTree, {})
    .then((list) => {
      const fams = list ?? [];
      const idx = new Map<string, TreeFamily>();
      for (const f of fams) {
        for (const m of f.members) idx.set(m.sessionId, f);
      }
      setFamilies(fams);
      setFamilyIndex(idx);
      loadedOnce = true;
    })
    .catch((err) => {
      console.warn('[session-tree] lineage scan failed:', err);
    })
    .finally(() => {
      setTreeLoading(false);
      inFlight = null;
    });
  return inFlight;
}

export function refreshSessionTree(): Promise<void> {
  return loadSessionTree(true);
}
