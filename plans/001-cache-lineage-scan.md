# Plan 001: Cache and parallelize the session-lineage scan so the Tree tab opens instantly

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0d7fc92..HEAD -- electron/ipc/session-lineage.ts electron/ipc/session-lineage.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `0d7fc92`, 2026-06-11

## Why this matters

Opening the Tree tab calls `listSessionFamilies()`, which reads EVERY `.jsonl`
session file under `~/.claude/projects` (500+ files on this machine, some

> 10 MB) **fully, serially, with no cache**. Every re-open repeats the whole
> scan. All of it runs on the Electron MAIN process, so heavy scans also make
> every window stutter. An mtime-keyed in-memory cache plus bounded-concurrency
> reads makes the first open several times faster and re-opens near-instant.

## Current state

- `electron/ipc/session-lineage.ts` — the lineage module. Three relevant facts:

1. `readFileMeta` (lines 72–115) reads a whole file via readline into a
   `FileMeta` (`rootUuid` + up to 20 000 message uuids + `mtimeMs`). It has NO
   cache — every call re-reads the file:

```ts
async function readFileMeta(filePath: string): Promise<FileMeta | null> {
  const base = path.basename(filePath).replace(/\.jsonl$/i, '');
  if (!UUID_RE.test(base)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  // ... readline over the whole file, collects meta.uuids ...
```

2. `listSessionFamilies` (lines 200–213) calls it **serially** in a loop:

```ts
const root = opts?.projectsDir ?? getClaudeProjectsDir();
const files = listJsonlFiles(root);
const metas: FileMeta[] = [];
for (const f of files) {
  const m = await readFileMeta(f);
  if (m) metas.push(m);
}
```

3. Session files are APPEND-ONLY (claude only appends records), so
   `(mtimeMs, size)` is a valid cache key: if both are unchanged, the parsed
   meta is still valid.

- Repo conventions: ESM with `.js` import suffixes in `electron/`; tests use
  vitest with `vi.mock('electron', ...)` — see the existing
  `electron/ipc/session-lineage.test.ts` for the exact pattern. Pre-commit
  hook runs `eslint --max-warnings 0` — do not use non-null assertions (`x!`),
  write guards instead.

## Commands you will need

| Purpose   | Command                                                                                            | Expected on success |
| --------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| Typecheck | `npm run typecheck` (in `D:\YandexDisk\Antigravity\ClaudeDesk`)                                    | exit 0              |
| Tests     | `npx vitest run electron/ipc/session-lineage.test.ts`                                              | all pass            |
| Lint      | `npx eslint electron/ipc/session-lineage.ts electron/ipc/session-lineage.test.ts --max-warnings 0` | exit 0              |

Note: do NOT run the full unit suite while anything CPU-heavy (vite build,
e2e) is running — tests on this machine time out under load.

## Scope

**In scope** (the only files you should modify):

- `electron/ipc/session-lineage.ts`
- `electron/ipc/session-lineage.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `electron/ipc/session-history.ts` — has its own mtime cache already (sqlite).
- `electron/ipc/register.ts`, `src/components/SessionTreeView.tsx` — the IPC
  surface and UI do not change.
- `resolveLiveSessionId` and its polling loop — separate concern, separate plan.

## Git workflow

- Work on the current branch (`revert-opus-4-8-selection`); commit message
  style: `perf: ...` one-liner + body (see `git log --oneline -5` for examples).
- Do NOT push.

## Steps

### Step 1: Add an mtime+size-keyed in-memory cache to readFileMeta

In `session-lineage.ts`, add a module-level cache above `readFileMeta`:

```ts
/** Session JSONLs are append-only, so (mtimeMs, size) keys a valid cache. */
const metaCache = new Map<string, { mtimeMs: number; size: number; meta: FileMeta }>();
const META_CACHE_MAX = 2_000;
```

In `readFileMeta`, after the existing `statSync` succeeds, return the cached
meta when `cached.mtimeMs === st.mtimeMs && cached.size === st.size`. After a
successful parse (`meta.rootUuid` set), store it in the cache; if
`metaCache.size > META_CACHE_MAX`, delete the oldest entry (first key from
`metaCache.keys()`). Do not cache `null` results.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Parallelize the scan with a small concurrency pool

Replace the serial loop in `listSessionFamilies` with a bounded pool
(concurrency 8). Implement a tiny local helper in the same file (do not import
from session-history):

```ts
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
```

Then: `const metas = (await mapPool(files, 8, readFileMeta)).filter((m): m is FileMeta => m !== null);`

**Verify**: `npx vitest run electron/ipc/session-lineage.test.ts` → all
existing tests pass (they cover family grouping and parent resolution, so they
prove the refactor didn't change results).

### Step 3: Add cache-behavior tests

In `session-lineage.test.ts`, add a describe block "meta cache":

1. **cache hit**: write a synthetic family (use the existing `writeJsonl`
   helper), call `listSessionFamilies` twice; spy with
   `const spy = vi.spyOn(fs, 'createReadStream')` between the calls and assert
   the second call did NOT open the unchanged files (`spy` not called for those
   paths — simplest: assert `spy.mock.calls.length === 0` when no file changed).
2. **invalidation**: append a line to one file (this changes its size and
   mtime; use `fs.appendFileSync` then `fs.utimesSync` with a strictly newer
   mtime to be robust on coarse-grained clocks), call again, assert the changed
   file IS re-read and the family result reflects it.

Model the structure after the existing "listSessionFamilies /
resolveLiveSessionId (synthetic)" describe block in the same file.

**Verify**: `npx vitest run electron/ipc/session-lineage.test.ts` → all pass,
including 2 new tests.

### Step 4: Rebuild

`npm run compile` (electron/ changed) → exit 0. Frontend rebuild is not needed
(no src/ changes).

## Test plan

Covered by Step 3: cache hit (no re-read), cache invalidation on append, plus
the pre-existing synthetic + REAL Wispr-family regression tests proving
identical results after parallelization.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npx vitest run electron/ipc/session-lineage.test.ts` exits 0 with 2 new tests
- [ ] `listSessionFamilies` no longer awaits `readFileMeta` serially (no `for ... await readFileMeta` loop)
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live code (drift).
- The REAL-sweep test (`REAL: Wispr Flow family on this machine`) starts
  failing — the parallel scan must produce byte-identical family results.
- You find yourself wanting to change `resolveLiveSessionId` or the IPC
  handlers — out of scope.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If a future change makes session files NOT append-only (e.g. rewriting
  history in place with same length), the `(mtimeMs, size)` key must gain a
  content hash — leave a comment near the cache pointing here.
- Reviewer should scrutinize: cache eviction (no unbounded growth) and that
  `null` results are never cached (a file mid-write may parse as null once).
