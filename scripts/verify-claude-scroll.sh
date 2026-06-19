#!/usr/bin/env bash
# RED→restore→GREEN for the claude wheel-scroll fix. Single sequential
# process. trap guarantees the source is restored even on interrupt.
cd "$(dirname "$0")/.." || exit 99
FILE="src/lib/terminal-wheel.ts"
LOG=/tmp/claude_scroll_verify.log
: > "$LOG"
say() { echo "$@" | tee -a "$LOG"; }
restore() { sed -i 's/^  if (false) {  \/\/ RED-DISABLED claudeTui/  if (input.claudeTui) {/' "$FILE"; }
trap restore EXIT
SPEC="e2e/claude-live-scroll.spec.ts"

# --- RED: disable the claude branch so the wheel falls back to (empty)
#     scrollback — the old broken behaviour. The test must FAIL.
sed -i 's/^  if (input.claudeTui) {/  if (false) {  \/\/ RED-DISABLED claudeTui/' "$FILE"
say "FLAG(red): $(grep -nE 'if \((false|input.claudeTui)\)' "$FILE" | head -1)"
npm run build:frontend >>"$LOG" 2>&1 && say "red build OK" || say "red build FAIL"
npx playwright test "$SPEC" --workers=1 --reporter=line >>"$LOG" 2>&1
say "RED playwright exit=$? (nonzero = RED captured, as expected)"
grep -iE "passed|failed|skipped|did not|✘|✓" "$LOG" | tail -4 | sed 's/^/[red] /'

# --- RESTORE + GREEN ---
restore
say "FLAG(green): $(grep -nE 'if \((false|input.claudeTui)\)' "$FILE" | head -1)"
npm run build:frontend >>"$LOG" 2>&1 && say "green build OK" || say "green build FAIL"
npx playwright test "$SPEC" --workers=1 --reporter=line >>"$LOG" 2>&1
say "GREEN playwright exit=$? (zero = GREEN)"
grep -iE "passed|failed|skipped|✘|✓" "$LOG" | tail -4 | sed 's/^/[green] /'

say "FLAG(final): $(grep -nE 'if \((false|input.claudeTui)\)' "$FILE" | head -1)"
say "DONE. Full log: $LOG"
