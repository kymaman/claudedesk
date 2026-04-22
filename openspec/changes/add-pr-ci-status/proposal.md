# Add PR CI Status

## Why

Tasks can already be linked to a GitHub pull request via `task.githubUrl`,
but the app surfaces nothing about the state of that PR's CI checks. A
user who pushes from a task and opens the PR has to keep tabbing to
GitHub to see whether the workflow finished. The ask is for the app to
watch the PR's CI and report back when it settles, so the user can work
on something else in the meantime.

## What changes

- Tasks whose `githubUrl` is a PR URL (`/pull/<n>`) get a live CI status
  indicator next to the existing GitHub link.
- The app fires one OS-level notification per `pending → settled`
  transition, naming the task and summarising pass/fail.
- Polling is driven by the main process via the user's existing `gh` CLI
  login; no new token configuration is introduced.
- If `gh` is missing or unauthenticated the feature silently stays off
  for the session.

## Impact

- New capability `pr-ci-status`.
- New IPC channels `StartPrChecksWatcher`, `StopPrChecksWatcher`,
  `PrChecksUpdate`.
- Additions to `TaskBranchInfoBar` (dot indicator) and a new
  non-persisted renderer store slice.
- Main-process polling adds outbound network traffic via `gh`; one call
  per active PR-linked task every 30 s while checks are pending, every
  5 min once settled, paused when the window is hidden.
