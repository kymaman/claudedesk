import { createEffect, onCleanup } from 'solid-js';
import { createStore, produce, unwrap } from 'solid-js/store';
import { store } from './core';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { parseGitHubUrl } from '../lib/github-url';
import type { PrChecksOverall, PrChecksUpdatePayload, PrCheckRun } from '../ipc/types';

export interface PrChecksState {
  overall: PrChecksOverall;
  passing: number;
  pending: number;
  failing: number;
  checks: PrCheckRun[];
  checkedAt: string;
}

// createStore gives fine-grained per-key reactivity: updating one task's state
// only re-runs accessors that read that task's key, not every PR-aware view.
const [prChecks, setPrChecksStore] = createStore<Record<string, PrChecksState>>({});

export function getPrChecks(taskId: string): PrChecksState | undefined {
  return prChecks[taskId];
}

function setPrChecks(taskId: string, next: PrChecksState): void {
  setPrChecksStore(taskId, next);
}

function removePrChecks(taskId: string): void {
  if (!(taskId in unwrap(prChecks))) return;
  setPrChecksStore(
    produce((s) => {
      delete s[taskId];
    }),
  );
}

function prUrlFor(githubUrl: string | undefined): string | null {
  if (!githubUrl) return null;
  const parsed = parseGitHubUrl(githubUrl);
  if (!parsed || parsed.type !== 'pull' || !parsed.number) return null;
  return githubUrl;
}

export function startPrChecksSubscription(): () => void {
  // Track which tasks we currently have a watcher registered for. Stores both
  // the PR URL and task name so a rename-only change triggers a refresh of
  // the watcher's display name.
  const activeByTaskId = new Map<string, { prUrl: string; taskName: string }>();

  const offUpdate = window.electron.ipcRenderer.on(IPC.PrChecksUpdate, (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const msg = data as Partial<PrChecksUpdatePayload>;
    if (typeof msg.taskId !== 'string') return;
    if (!store.tasks[msg.taskId]) return;
    if (typeof msg.overall !== 'string') return;
    // On a `cleared` update the main process has stopped watching — drop our
    // bookkeeping so a later reopen-and-restart goes through.
    if (msg.cleared) {
      activeByTaskId.delete(msg.taskId);
      removePrChecks(msg.taskId);
      return;
    }
    setPrChecks(msg.taskId, {
      overall: msg.overall as PrChecksOverall,
      passing: typeof msg.passing === 'number' ? msg.passing : 0,
      pending: typeof msg.pending === 'number' ? msg.pending : 0,
      failing: typeof msg.failing === 'number' ? msg.failing : 0,
      checks: Array.isArray(msg.checks) ? (msg.checks as PrCheckRun[]) : [],
      checkedAt: typeof msg.checkedAt === 'string' ? msg.checkedAt : new Date().toISOString(),
    });
  });

  createEffect(() => {
    const seen = new Set<string>();
    const allIds = [...store.taskOrder, ...store.collapsedTaskOrder];
    for (const taskId of allIds) {
      const task = store.tasks[taskId];
      if (!task) continue;
      const prUrl = prUrlFor(task.githubUrl);
      if (!prUrl) continue;
      seen.add(taskId);
      const prev = activeByTaskId.get(taskId);
      if (prev && prev.prUrl === prUrl && prev.taskName === task.name) continue;
      activeByTaskId.set(taskId, { prUrl, taskName: task.name });
      fireAndForget(IPC.StartPrChecksWatcher, {
        taskId,
        prUrl,
        taskName: task.name,
      });
    }
    for (const taskId of [...activeByTaskId.keys()]) {
      if (!seen.has(taskId)) {
        activeByTaskId.delete(taskId);
        removePrChecks(taskId);
        fireAndForget(IPC.StopPrChecksWatcher, { taskId });
      }
    }
  });

  const cleanup = (): void => {
    offUpdate();
    for (const taskId of activeByTaskId.keys()) {
      fireAndForget(IPC.StopPrChecksWatcher, { taskId });
    }
    activeByTaskId.clear();
  };

  onCleanup(cleanup);
  return cleanup;
}
