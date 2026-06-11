# Plan 003: Make silent catch blocks observable in the two hottest modules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0d7fc92..HEAD -- src/store/chats.ts electron/ipc/session-history.ts`
> On mismatch with "Current state", STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `0d7fc92`, 2026-06-11

## Why this matters

`src/store/chats.ts` and `electron/ipc/session-history.ts` together contain
13 `catch {` blocks with empty bodies. When branching, renaming, summarizing,
or listing sessions fails, the app shows nothing and logs nothing — debugging
field reports («тайл не открылся», «строки нет в истории») requires attaching
a debugger. Adding a one-line `console.warn` with context to each catch makes
every future bug report diagnosable from the DevTools/terminal log. Behavior
must NOT change — logging only.

## Current state

- Count check (run it yourself to locate them):
  `Select-String -Path src\store\chats.ts, electron\ipc\session-history.ts -Pattern 'catch \{'`
  → 13 matches at commit `0d7fc92`.
- Some catches are intentionally silent fire-and-forget (e.g.
  `invoke(...).catch(() => {})` on best-effort IPC); those still deserve a
  warn — a failed best-effort call is exactly what you want in the log when
  hunting a misbehaving feature.
- Logging convention to follow (already used elsewhere in the repo, e.g.
  `electron/main.ts:112`): a bracketed module tag + short action + the error:
  `console.warn('[chats] branch: resolve live session failed:', err)`.

## Commands you will need

| Purpose   | Command                                                                              | Expected |
| --------- | ------------------------------------------------------------------------------------ | -------- |
| Typecheck | `npm run typecheck`                                                                  | exit 0   |
| Lint      | `npx eslint src/store/chats.ts electron/ipc/session-history.ts --max-warnings 0`     | exit 0   |
| Tests     | `npx vitest run src/store` and `npx vitest run electron/ipc/session-history.test.ts` | all pass |
| Rebuild   | `npm run build:frontend` and `npm run compile`                                       | exit 0   |

## Scope

**In scope**:

- `src/store/chats.ts`
- `electron/ipc/session-history.ts`

**Out of scope**:

- Any behavior change: no rethrows, no new return values, no user-facing
  toasts (deferred — see Maintenance notes), no new error types.
- Other files with empty catches (TerminalView.tsx etc.) — next iteration.
- Catches whose body already logs or returns a meaningful fallback.

## Git workflow

- Current branch; commit style `chore: ...`. Do NOT push.

## Steps

### Step 1: chats.ts

For each `catch {` / `.catch(() => {})` with an empty body in
`src/store/chats.ts`: change to capture the error and `console.warn` with the
`[chats]` tag and a 2–5 word action description taken from the surrounding
function name. Example transformation:

```ts
// before
.catch(() => {});
// after
.catch((err) => console.warn('[chats] record lineage failed:', err));
```

For `catch {` blocks that intentionally swallow (e.g. «terminal disposed»)
keep the swallow but add the warn. Do NOT add warns inside per-frame or
per-keystroke hot loops — if a catch sits in code that runs many times per
second, use a module-level `let warnedX = false` once-guard.

**Verify**: `npm run typecheck` → exit 0;
`npx vitest run src/store` → all pass (proves no behavior change).

### Step 2: session-history.ts

Same treatment with the `[session-history]` tag. Several catches here guard
per-file JSONL parsing inside loops over hundreds of files — for those use the
once-guard pattern or downgrade to nothing if the catch handles an EXPECTED
per-line condition (malformed JSONL line at
`session-history.ts:658` is expected — leave it silent but add the comment
`/* expected: malformed line */` so future audits skip it).

**Verify**: `npx vitest run electron/ipc/session-history.test.ts` → all pass.

### Step 3: Rebuild

`npm run build:frontend` and `npm run compile` → both exit 0 (per repo rule:
the app is launched from built artifacts).

## Test plan

No new tests — logging is intentionally untested. The existing suites for both
files must stay green, which proves observability was added without behavior
change.

## Done criteria

- [ ] `Select-String -Path src\store\chats.ts, electron\ipc\session-history.ts -Pattern 'catch \{\}'` → 0 matches
- [ ] Every remaining silent catch carries either a `console.warn` or an
      `/* expected: ... */` comment
- [ ] Typecheck, lint, both vitest suites, both builds — exit 0
- [ ] Only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- A catch turns out to be load-bearing in a way a log would flood (fires
  per-frame) and the once-guard feels insufficient — report it instead of
  removing the log silently.
- Any existing test fails after your edit — you changed behavior; revert that
  hunk and report.

## Maintenance notes

- Next step (deliberately out of scope): a user-facing toast for FAILED
  user-initiated actions (branch, rename, AI-title). Once a toast/notification
  primitive exists, upgrade the warns at those call sites.
- Reviewers: check no `console.warn` landed inside the PTY output path or
  Wispr-Flow poll (hot loops).
