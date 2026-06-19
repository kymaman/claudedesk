#!/usr/bin/env bash
# One-shot deterministic RED→GREEN→restore for variant A (prefill off).
# Single sequential process — no concurrent flag edits. trap guarantees the
# flag ends at `return false;` even if interrupted; a final rebuild + grep
# verification proves the shipping state.
cd "$(dirname "$0")/.." || exit 99
FILE="src/lib/transcript-prefill.ts"
LOG=/tmp/variant_a_verify.log
: > "$LOG"

restore_flag() { sed -i 's/^  return true;/  return false;/' "$FILE"; }
trap restore_flag EXIT

say() { echo "$@" | tee -a "$LOG"; }

# --- GREEN: flag=false ---
restore_flag
say "FLAG(green): $(grep -nE 'return (true|false);' "$FILE")"
say "=== GREEN build ==="
npm run build:frontend >>"$LOG" 2>&1 && say "green build OK" || say "green build FAIL"
say "=== GREEN: transcript-native-render + read-mode ==="
npx playwright test e2e/transcript-native-render.spec.ts e2e/read-mode.spec.ts --workers=1 >>"$LOG" 2>&1
say "GREEN playwright exit=$?"
tail -45 "$LOG" | sed 's/^/[green] /'

# --- RED: flag=true ---
sed -i 's/^  return false;/  return true;/' "$FILE"
say "FLAG(red): $(grep -nE 'return (true|false);' "$FILE")"
say "=== RED build ==="
npm run build:frontend >>"$LOG" 2>&1 && say "red build OK" || say "red build FAIL"
say "=== RED: VARIANT A spy test (expect FAIL = red) ==="
npx playwright test e2e/transcript-native-render.spec.ts -g "VARIANT A" --workers=1 >>"$LOG" 2>&1
say "RED playwright exit=$? (nonzero = RED captured, as expected)"
tail -45 "$LOG" | sed 's/^/[red] /'

# --- RESTORE: flag=false + final build (trap also covers crash paths) ---
restore_flag
say "FLAG(final): $(grep -nE 'return (true|false);' "$FILE")"
say "true-count: $(grep -c 'return true;' "$FILE")  false-count: $(grep -c 'return false;' "$FILE")"
say "=== FINAL build (variant A) ==="
npm run build:frontend >>"$LOG" 2>&1 && say "final build OK" || say "final build FAIL"
say "DONE. Full log: $LOG"
