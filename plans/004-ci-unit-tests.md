# Plan 004: Run unit tests in CI and stop load-induced timeout flakes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0d7fc92..HEAD -- .github/workflows/ci.yml vitest.config.ts vite.config.ts`
> On mismatch with "Current state", STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0d7fc92`, 2026-06-11

## Why this matters

CI currently verifies only typecheck, lint, and formatting — the ~450 unit
tests never run automatically, so a behavioral regression reaches the repo
silently. Separately, the suite flakes under CPU load (observed repeatedly on
the dev machine: a test passes in 0.6 s in isolation but times out at the 5 s
vitest default while a vite build runs). Adding a CI test job plus a more
generous global `testTimeout` fixes both.

## Current state

- `.github/workflows/ci.yml` (entire file at `0d7fc92`):

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 'lts/*'
          cache: npm
      - run: npm ci
      - name: Typecheck
        run: npm run typecheck
      - name: Lint
        run: npm run lint
      - name: Format check
        run: npm run format:check
```

- `package.json` scripts: `"test": "vitest run"`,
  `"postinstall": "electron-rebuild --only better-sqlite3"` (note: postinstall
  runs during `npm ci` — it needs electron downloaded, which `npm ci` installs;
  this already works locally, but if it fails on the runner see STOP
  conditions).
- Vitest config: locate it first — check for `vitest.config.ts` at repo root
  and a `test:` block inside `vite.config.ts` / `electron/vite.config.electron.ts`.
  Whichever exists is the file to edit; if NONE exists, create
  `vitest.config.ts` at the repo root with the standard `defineConfig({ test: {...} })`.
- Several unit tests are guarded with `describe.runIf(...)` on real user data
  (`~/.claude/projects`) — on a CI runner those guards are false and the tests
  skip themselves. That is by design; expect "skipped" in CI output.
- e2e (Playwright) stays OUT of CI in this plan: it launches the real Electron
  app and needs a display server; that is a separate effort.

## Commands you will need

| Purpose     | Command                                         | Expected                                                      |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Unit tests  | `npm test`                                      | exit 0 (with REAL-data tests passing locally, skipping on CI) |
| YAML sanity | `npx prettier --check .github/workflows/ci.yml` | exit 0                                                        |

## Scope

**In scope**:

- `.github/workflows/ci.yml`
- the vitest config file (located per "Current state")

**Out of scope**:

- Adding e2e/Playwright to CI.
- The `release` script and release.yml.
- Any test file content.

## Git workflow

- Current branch; commit style `ci: ...`. Do NOT push (the workflow will be
  exercised whenever the owner pushes).

## Steps

### Step 1: Raise the global vitest testTimeout to 15000 ms

In the vitest config (see "Current state" for location), set
`test.testTimeout: 15_000`. Tests that pass in 0.6 s idle still pass instantly;
the longer ceiling only absorbs load spikes. Do not touch per-test `{ timeout }`
overrides that already exist (some REAL-sweep tests use 120 s+).

**Verify**: `npm test` locally with nothing heavy running → exit 0, and the
config change is picked up (vitest prints no config errors).

### Step 2: Add a unit-test step to ci.yml

Append after the "Format check" step:

```yaml
- name: Unit tests
  run: npm test
```

Keep it inside the same `quality` job (the checkout/setup/npm ci steps are
already paid for).

**Verify**: `npx prettier --check .github/workflows/ci.yml` → exit 0.

## Test plan

The change IS test infrastructure. Local proof: `npm test` exits 0. CI proof
arrives on the owner's next push to main (do not push yourself).

## Done criteria

- [ ] `npm test` exits 0 locally
- [ ] ci.yml contains a "Unit tests" step running `npm test`
- [ ] vitest global `testTimeout` is 15000
- [ ] Only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- No vitest config exists AND tests currently rely on defaults injected some
  other way you can't identify — report before creating one blindly.
- `npm test` fails locally BEFORE your change — the suite has a pre-existing
  red; report which tests, do not "fix" them under this plan.
- You learn that `npm ci` on a GitHub runner fails at the
  `electron-rebuild` postinstall — report; the fix (e.g.
  `ELECTRON_SKIP_BINARY_DOWNLOAD` gymnastics or `--ignore-scripts` + explicit
  rebuild) is a design decision the owner should make.

## Maintenance notes

- Once this is green on a few pushes, the natural follow-up is a nightly e2e
  job with `CLAUDEDESK_E2E=1` and xvfb — deliberately out of scope here.
- If CI minutes become a concern, split tests into a separate job with
  `needs:` so lint failures short-circuit earlier.
