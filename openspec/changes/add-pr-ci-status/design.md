# Design — Add PR CI Status

## Polling topology

One interval, owned by the main process, ticks every 30 s. On each tick
the poller walks its in-memory map of registered tasks and decides
whether to refresh each task:

- Any check in the `pending` bucket → refresh every tick.
- All checks settled → refresh every 5 min to catch CI re-runs on a new
  head SHA.
- PR state is `MERGED` or `CLOSED` → drop the task from the map.

The interval is created with `setInterval(..., 30_000).unref()` (same as
the cache sweeper in `electron/ipc/git.ts:37`) so it never blocks app
shutdown.

When the main window is actually hidden (minimised or `cmd-H`), the
interval is cleared. `show` / `restore` re-establish it and run an
immediate tick. We do NOT pause on `blur` — the whole point of the OS
notification is to reach the user when they are focused on another app,
and pausing on blur would silently delay the ping.

Ticks are guarded by an `isRefreshing` flag so a focus-triggered
immediate tick can't overlap with the interval tick. Refreshes for
individual tasks within a tick run concurrently (`Promise.all`).

## `gh` contract

A single call per refresh, combining state, head SHA, and check-run
statuses in one process fork:

```
gh pr view <url> --json state,headRefOid,statusCheckRollup
```

`statusCheckRollup` is mapped to the same `pass | fail | pending |
skipping | cancel` bucket taxonomy that `gh pr checks --json bucket`
produces, via a pure mapper. Using one call halves subprocess cost per
tick, eliminates the race where the two calls observe different head
SHAs, and reduces rate-limit pressure when many tasks are watched.
`headRefOid` is used to detect "new commit pushed" so we can reset the
notification-dedupe key for a task.

## Overall state aggregation

Pure function `aggregateBucket(checks) -> 'pending' | 'success' |
'failure' | 'none'`:

1. `any bucket === 'pending'` → `pending`
2. else `any bucket === 'fail' || 'cancel'` → `failure`
3. else if list is empty → `none`
4. else → `success`

## IPC contract

- `StartPrChecksWatcher { taskId, prUrl, taskName }` — renderer →
  main, request/response, idempotent.
- `StopPrChecksWatcher { taskId }` — renderer → main, idempotent.
- `PrChecksUpdate { taskId, overall, passing, pending, failing, checks,
checkedAt }` — main → renderer, push.

## Degradation

- `ENOENT` on `gh` → set a session-level `disabled` flag, push no
  updates, log once.
- `gh auth status` non-zero exit (heuristic via stderr string
  `"not logged into"`) → same treatment.
- Transient non-zero exit → keep previous state, retry on next tick,
  log at debug level.

## Notification policy

- Fire once per `(taskId, headRefOid, terminalOutcome)` triple.
- Terminal outcome = `success | failure`. `none` never notifies.
- On `failure`, the body lists up to three failing check names with
  "and N more" when there are more.
- On a new `headRefOid`, the dedupe key resets so a re-run can notify
  again.
- Notifications reuse the same `Notification.isSupported()` guard used
  by the existing `ShowNotification` handler in `register.ts:625`.
