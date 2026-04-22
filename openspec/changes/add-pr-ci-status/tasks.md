# Tasks — Add PR CI Status

- [ ] Add IPC channels `StartPrChecksWatcher`, `StopPrChecksWatcher`,
      `PrChecksUpdate` to `electron/ipc/channels.ts` and the preload
      allowlist.
- [ ] Add shared payload types to `src/ipc/types.ts`
      (`PrCheckBucket`, `PrCheckRun`, `PrChecksOverall`,
      `PrChecksUpdatePayload`).
- [ ] Implement `electron/ipc/pr-checks.ts`: - `runGhChecks(prUrl)` — promisified `gh pr checks`. - `runGhView(prUrl)` — promisified `gh pr view` (state + SHA). - `aggregateBucket(checks)` — pure state reducer. - `startPrChecksWatcher` / `stopPrChecksWatcher` with a single
      shared interval, per-task state map, window-visibility gating,
      and first-error `gh`-missing degradation. - Transition detection fires `new Notification({...}).show()` and
      `webContents.send(PrChecksUpdate, payload)`.
- [ ] Unit tests in `electron/ipc/pr-checks.test.ts` mirroring
      `electron/ipc/git.test.ts` mock style.
- [ ] Wire watcher start/stop into `registerAllHandlers` in
      `electron/ipc/register.ts`.
- [ ] New renderer store `src/store/pr-checks.ts`; subscribe to
      `PrChecksUpdate` at bootstrap; call Start/Stop when a task with a
      PR `githubUrl` is loaded or removed or changes.
- [ ] Status dot in `src/components/TaskBranchInfoBar.tsx` inside the
      existing `<Show when={task.githubUrl}>` block.
- [ ] `openspec validate --all --strict` and `npm run typecheck`.
