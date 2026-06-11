# Plan 005: Replace blind sleeps with condition waits in the four flakiest e2e specs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0d7fc92..HEAD -- e2e/projects.spec.ts e2e/ui-clipboard-and-drag.spec.ts e2e/scrollback-no-hang.spec.ts e2e/smoke.spec.ts e2e/helpers.ts`
> On mismatch with "Current state", STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (touching tests can mask or invent regressions — read each
  assertion's intent before editing)
- **Depends on**: none (better after 004 so CI context exists)
- **Category**: tests
- **Planned at**: commit `0d7fc92`, 2026-06-11

## Why this matters

The e2e suite contains 151 `waitForTimeout` sleeps across 33 specs. Each blind
sleep is a race: too short under load → flake; long enough → minutes of dead
time. Known symptom on this machine: specs fail on first run and pass on
re-run. The four worst offenders hold ~38% of all sleeps:
`projects.spec.ts` (18), `ui-clipboard-and-drag.spec.ts` (15),
`scrollback-no-hang.spec.ts` (12), `smoke.spec.ts` (12). Converting those to
condition-based waits removes the bulk of the flake surface without touching
all 33 files.

## Current state

- Counts above measured at `0d7fc92` via
  `Select-String -Path e2e\*.spec.ts -Pattern 'waitForTimeout'`.
- `e2e/helpers.ts` exports `launchApp()`; specs follow the pattern
  `({ app, win } = await launchApp())` in `beforeAll`.
- **HARD SAFETY RULE (from the repo owner)**: e2e must NEVER run without the
  `CLAUDEDESK_E2E=1` isolation env (set inside the Playwright config/helpers —
  verify it is applied by reading `e2e/helpers.ts` and `playwright.config.ts`
  BEFORE running anything). Running un-isolated pollutes the user's real app
  data. Also never run e2e and the unit suite simultaneously.
- Playwright idioms to use instead of sleeps:
  - element state: `await expect(locator).toBeVisible({ timeout: 10_000 })`
  - data condition: `await expect.poll(() => win.locator('.x').count(), { timeout: 10_000 }).toBeGreaterThan(0)`
  - xterm content: `await expect(win.locator('.xterm-rows')).toContainText('...', { timeout: 10_000 })`
- Some sleeps are legitimate debounce waits for app-internal timers (e.g.
  300 ms layout-stabilisation in TerminalView, Wispr-Flow 200 ms poll). Those
  may stay, but each surviving sleep must gain a one-line comment naming the
  timer it waits for.

## Commands you will need

| Purpose          | Command                                                                                                                       | Expected                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Build before e2e | `npm run build:frontend && npm run compile`                                                                                   | exit 0 (skip if dist is already current) |
| One spec         | `npx playwright test e2e/projects.spec.ts`                                                                                    | pass                                     |
| The four specs   | `npx playwright test e2e/projects.spec.ts e2e/ui-clipboard-and-drag.spec.ts e2e/scrollback-no-hang.spec.ts e2e/smoke.spec.ts` | pass                                     |

Stability proof: run the four-spec command **3 times in a row**; all 3 runs
green.

## Scope

**In scope**:

- `e2e/projects.spec.ts`
- `e2e/ui-clipboard-and-drag.spec.ts`
- `e2e/scrollback-no-hang.spec.ts`
- `e2e/smoke.spec.ts`

**Out of scope**:

- The remaining 29 spec files (follow-up iterations).
- `e2e/helpers.ts`, `playwright.config.ts` — read them, don't change them.
- Application source code — if a test can only be de-flaked by changing app
  code, that's a STOP condition.
- Test INTENT: never weaken an assertion to make it pass.

## Git workflow

- Current branch; commit style `test(e2e): ...`, one commit per spec file is
  fine. Do NOT push.

## Steps

### Step 1: projects.spec.ts (18 sleeps)

For each `waitForTimeout`: identify what the test is actually waiting for
(read the 3–5 lines after the sleep — the next assertion names the condition)
and replace the sleep with an explicit wait for THAT condition. Keep a sleep
only for app-internal debounce timers, with a comment.

**Verify**: `npx playwright test e2e/projects.spec.ts` → pass.

### Step 2: ui-clipboard-and-drag.spec.ts (15 sleeps)

Same procedure. Clipboard writes are async — prefer
`expect.poll(() => win.evaluate(() => navigator.clipboard.readText()))`-style
conditions over sleeps where the spec checks clipboard contents.

**Verify**: `npx playwright test e2e/ui-clipboard-and-drag.spec.ts` → pass.

### Step 3: scrollback-no-hang.spec.ts (12) and smoke.spec.ts (12)

Same procedure. For xterm-content waits use `toContainText` with timeout on
`.xterm-rows` (already the pattern in other specs — grep `xterm-rows` in e2e/
for an exemplar).

**Verify**: `npx playwright test e2e/scrollback-no-hang.spec.ts e2e/smoke.spec.ts` → pass.

### Step 4: Stability run

Run all four specs together 3 times consecutively.

**Verify**: 3/3 runs fully green.

## Test plan

The deliverable IS tests. Success = same assertions, fewer sleeps, 3
consecutive green runs of the four specs.

## Done criteria

- [ ] `Select-String -Path e2e\projects.spec.ts, e2e\ui-clipboard-and-drag.spec.ts, e2e\scrollback-no-hang.spec.ts, e2e\smoke.spec.ts -Pattern 'waitForTimeout'` → ≤ 10 total matches, each with a justifying comment
- [ ] 3 consecutive green runs of the four specs
- [ ] No assertion was weakened or deleted (review the diff)
- [ ] Only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- `CLAUDEDESK_E2E=1` isolation is NOT applied by the config/helpers — stop
  immediately, do not run anything.
- A test keeps flaking after its sleeps became condition waits — that's a real
  app race; report it with the failure output instead of padding timeouts.
- De-flaking seems to require changing app source — out of scope, report.

## Maintenance notes

- Follow-up iterations: the next offenders are `scrollback-1000-lines.spec.ts`
  (9) and `chat-scrollback.spec.ts` (9).
- Reviewers: diff should show sleeps → explicit conditions 1:1; any deleted
  assertion is a red flag.
