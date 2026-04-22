# PR CI Status Specification

## ADDED Requirements

### Requirement: Watcher lifecycle is driven by the renderer

The app SHALL track the CI status of a task's linked pull request only
while the renderer has an active watcher for that task. The renderer is
responsible for starting a watcher when a task loads with a PR
`githubUrl`, updating it when the URL changes, and stopping it when the
task is removed.

#### Scenario: Start a watcher

- **WHEN** the renderer sends `StartPrChecksWatcher` with a `taskId`,
  `prUrl`, and `taskName`
- **AND** `prUrl` parses as a GitHub PR URL (`type === 'pull'` and
  `number` present)
- **THEN** the main process registers the task in its watcher map
- **AND** triggers an immediate refresh for that task
- **AND** a subsequent `StartPrChecksWatcher` with the same `taskId`
  and a new `prUrl` discards the previous state (counts, head SHA,
  notification dedupe) so the new PR is treated as a fresh subscription
- **AND** a subsequent `StartPrChecksWatcher` with the same `taskId`
  and the same `prUrl` but a different `taskName` updates only the
  display name without restarting the poller

#### Scenario: Stop a watcher

- **WHEN** the renderer sends `StopPrChecksWatcher` for a `taskId`
- **THEN** the main process removes the entry from the watcher map
- **AND** a second `StopPrChecksWatcher` for the same `taskId` is a
  no-op

#### Scenario: Non-PR URLs are ignored

- **WHEN** the renderer sends `StartPrChecksWatcher` with a URL whose
  parsed `type` is not `pull`
- **THEN** the main process does not register a watcher
- **AND** no `PrChecksUpdate` is emitted for that task

### Requirement: Polling cadence and backoff

The watcher SHALL refresh every registered task on a shared 30 s
interval, with per-task backoff so settled PRs cost little.

#### Scenario: Pending checks refresh on every tick

- **WHEN** a task's most recent overall state is `pending`
- **THEN** the poller refreshes that task on the next 30 s tick

#### Scenario: Settled checks refresh every 5 minutes

- **WHEN** a task's most recent overall state is `success`, `failure`,
  or `none`
- **THEN** the poller refreshes that task at most once per 5 minutes
- **AND** if the refresh reveals a new `headRefOid` the task is treated
  as pending again on the next tick

#### Scenario: Merged or closed PRs stop polling

- **WHEN** a refresh reports the PR's `state` is `MERGED` or `CLOSED`
- **THEN** one final `PrChecksUpdate` with `overall: 'none'`, zero
  counts, and `cleared: true` is pushed
- **AND** the watcher map entry for that task is removed
- **AND** no further `gh` calls are made for that task until the
  renderer starts a new watcher
- **AND** the renderer drops its subscription bookkeeping on receipt
  of `cleared: true`, so if the task's linked PR later reopens the
  watcher can be restarted cleanly

### Requirement: Window hidden/minimised state gates polling

The watcher SHALL pause its interval when the main window is hidden
(minimised or explicitly hidden via `cmd-H` / `hide()`) and resume on
show/restore, running an immediate tick on resume. The watcher SHALL
NOT pause merely because the window lost focus (`blur`) — the
user-facing value of the feature is to notify while the user is in
another app.

#### Scenario: Window is hidden or minimised

- **WHEN** the main window emits `hide` or `minimize` and the watcher
  map is non-empty
- **THEN** the poller clears its interval
- **AND** no `gh` calls are made until the window is shown again

#### Scenario: Window is shown or restored

- **WHEN** the main window emits `show` or `restore` and the watcher
  map is non-empty
- **THEN** the poller runs an immediate tick
- **AND** re-establishes the 30 s interval

#### Scenario: Window loses focus without hiding

- **WHEN** the main window emits `blur` while still visible
- **THEN** the poller continues its interval
- **AND** transitions to settled still fire their notification

### Requirement: Overall state aggregation

The poller SHALL reduce the list of check runs returned by `gh pr
checks` to a single overall state per task.

#### Scenario: Any check still pending

- **WHEN** at least one check has bucket `pending`
- **THEN** the overall state is `pending`

#### Scenario: Any check failed or was cancelled

- **WHEN** no check is `pending` and at least one has bucket `fail` or
  `cancel`
- **THEN** the overall state is `failure`

#### Scenario: All checks succeeded or were skipped

- **WHEN** every check has bucket `pass` or `skipping`
- **THEN** the overall state is `success`

#### Scenario: PR has no checks configured

- **WHEN** the `gh` response contains no check runs
- **THEN** the overall state is `none`
- **AND** no notification is fired for that task

### Requirement: Notify once per settled run

The app SHALL fire exactly one OS notification per `(taskId,
headRefOid)` pair when the overall state transitions from `pending` to
`success` or `failure`.

#### Scenario: First settlement notifies

- **WHEN** a task whose previous overall state was `pending` settles to
  `success` or `failure` at head SHA `S`
- **THEN** the main process calls `new Notification({ title, body
}).show()` with a title identifying the task name and outcome
- **AND** records `(taskId, S)` as notified

#### Scenario: Duplicate ticks at the same SHA do not re-notify

- **WHEN** a further tick reports the same overall state at the same
  head SHA `S`
- **THEN** no additional notification is fired

#### Scenario: New push re-arms the notification

- **WHEN** `gh pr view` reports a new `headRefOid` different from the
  last notified SHA for the task
- **THEN** the task becomes eligible to notify again the next time it
  settles

#### Scenario: `none` overall state does not notify

- **WHEN** a task's overall state is `none`
- **THEN** no notification is fired even on state change

#### Scenario: First refresh does not notify

- **WHEN** a freshly registered task's first refresh returns a
  `success` or `failure` overall state
- **THEN** no notification is fired
- **AND** the SHA and outcome are recorded so subsequent transitions
  within the session still notify

### Requirement: Live update push to the renderer

The main process SHALL push `PrChecksUpdate` messages to the renderer
whenever a task's refresh produces new information.

#### Scenario: Update payload shape

- **WHEN** the poller completes a refresh for a task that yielded any
  check data
- **THEN** it sends `PrChecksUpdate` on the window's webContents with
  `{ taskId, overall, passing, pending, failing, checks, checkedAt }`
- **AND** `checks` is the array of check runs as returned by `gh`
  limited to `name`, `bucket`, `state`, `link`, and `workflow`

#### Scenario: No update when nothing changed

- **WHEN** a refresh yields an identical overall state, counts, and
  head SHA to the previous one
- **THEN** no `PrChecksUpdate` is emitted for that task

### Requirement: Renderer surface

The renderer SHALL render a compact status indicator next to the
existing GitHub link on any task that has received at least one
non-`none` `PrChecksUpdate`, and SHALL NOT persist the CI state.

#### Scenario: Indicator colors reflect overall state

- **WHEN** a task's latest overall state is `pending`
- **THEN** the indicator renders as a pulsing yellow dot

- **WHEN** a task's latest overall state is `success`
- **THEN** the indicator renders as a green dot

- **WHEN** a task's latest overall state is `failure`
- **THEN** the indicator renders as a red dot

- **WHEN** a task's latest overall state is `none` or no update has
  arrived
- **THEN** no indicator is rendered

#### Scenario: Indicator tooltip summarises counts

- **WHEN** the indicator is rendered
- **THEN** its `title` attribute reports the passing, pending, and
  failing counts in a single line

#### Scenario: State is not persisted across restart

- **WHEN** the app restarts
- **THEN** the persisted store contains no PR CI status fields
- **AND** status re-populates from `PrChecksUpdate` pushes once
  watchers are restarted

### Requirement: Graceful degradation without `gh`

The app SHALL continue to function when the `gh` CLI is missing or
unauthenticated, disabling PR CI polling for the rest of the session
without surfacing an error to the user.

#### Scenario: `gh` binary is missing

- **WHEN** the first `gh` call fails with `ENOENT`
- **THEN** the poller sets an internal `disabled` flag
- **AND** no further `gh` calls are made in the session
- **AND** no indicator is shown and no notification is fired
- **AND** the main process logs the disabling event once

#### Scenario: `gh` is not authenticated

- **WHEN** a `gh` call exits non-zero with stderr indicating "not
  logged into"
- **THEN** the same `disabled` behavior applies

#### Scenario: Transient `gh` failure

- **WHEN** a `gh` call fails with any other error
- **THEN** the previous overall state is preserved
- **AND** the task is retried on the next tick
