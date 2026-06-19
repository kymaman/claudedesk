#!/usr/bin/env bash
# RED (prefill on) → restore → GREEN reconfirm, for the variant-A IPC-spy test.
# Single sequential process. trap guarantees the flag ends at `return false;`.
cd "$(dirname "$0")/.." || exit 99
FILE="src/lib/transcript-prefill.ts"
LOG=/tmp/variant_a_red.log
: > "$LOG"
restore_flag() { sed -i 's/^  return true;/  return false;/' "$FILE"; }
trap restore_flag EXIT
say() { echo "$@" | tee -a "$LOG"; }
SPEC="e2e/transcript-native-render.spec.ts"

# --- RED: flag=true, run the FULL spec (test 1 warms History first) ---
sed -i 's/^  return false;/  return true;/' "$FILE"
say "FLAG(red): $(grep -nE 'return (true|false);' "$FILE")"
npm run build:frontend >>"$LOG" 2>&1 && say "red build OK" || say "red build FAIL"
say "=== RED: full spec (VARIANT A spy test must FAIL) ==="
npx playwright test "$SPEC" --workers=1 >>"$LOG" 2>&1
say "RED playwright exit=$? (nonzero = RED captured)"
grep -E '(ok|not ok|passed|failed|skipped|VARIANT A|load_session_transcript|✘|✓|›)' "$LOG" | tail -25 | sed 's/^/[red] /'

# --- RESTORE + GREEN reconfirm ---
restore_flag
say "FLAG(green): $(grep -nE 'return (true|false);' "$FILE")"
npm run build:frontend >>"$LOG" 2>&1 && say "green build OK" || say "green build FAIL"
say "=== GREEN reconfirm: full spec (all pass) ==="
npx playwright test "$SPEC" --workers=1 >>"$LOG" 2>&1
say "GREEN playwright exit=$?"
grep -E '(ok|not ok|passed|failed|skipped|VARIANT A|›)' "$LOG" | tail -25 | sed 's/^/[green] /'

# --- final verification ---
say "FLAG(final): $(grep -nE 'return (true|false);' "$FILE")"
say "true-count: $(grep -c 'return true;' "$FILE")  false-count: $(grep -c 'return false;' "$FILE")"
say "DONE. Full log: $LOG"
