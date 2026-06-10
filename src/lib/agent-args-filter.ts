/**
 * agent-args-filter.ts
 *
 * Strip flags from a claude args list when the target binary's `--help`
 * doesn't list them. Prevents "unknown option" failures when Anthropic
 * ships a CLI build that removes/renames flags ClaudeDesk has been
 * passing by default (e.g. --remote-control disappearing in a future
 * 2.x release).
 *
 * Conservative by design:
 *   1. If `supportedFlags` is empty/undefined, return args unchanged
 *      (no probe data — don't risk breaking what already works).
 *   2. Only filter long flags (`--long`). Positional values, short
 *      flags, and bare strings pass through.
 *   3. If a filtered flag had a value form (`--flag value`), drop the
 *      value too — claude help text uses `[value]` for optional and
 *      `<value>` for required, but at filter time we only know the
 *      flag name. The conservative rule: drop the next arg too IF it
 *      doesn't itself start with `-`.
 */

/** Flags ClaudeDesk owns and may pass by default. These are the only
 *  ones we ever filter — never strip a user-supplied flag we didn't
 *  recognise (extra_flags pass through unchanged so users keep
 *  control). */
const CLAUDEDESK_OWNED_FLAGS = new Set([
  '--remote-control',
  '--fork-session',
  '--dangerously-skip-permissions',
  '--resume',
  '--continue',
  '--model',
]);

export function filterArgsBySupport(
  args: readonly string[],
  supportedFlags: ReadonlySet<string> | undefined,
): string[] {
  // No probe data → pass through. This is the "haven't run yet" / "non-
  // claude agent" path; better to spawn with original args than guess.
  if (!supportedFlags || supportedFlags.size === 0) return [...args];

  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const isOwned = CLAUDEDESK_OWNED_FLAGS.has(token);
    const isUnsupported = isOwned && !supportedFlags.has(token);
    if (isUnsupported) {
      // Drop the flag. If the next token isn't itself a flag, treat it
      // as this flag's value and drop it too. Conservative: most owned
      // flags either are boolean OR take a value (--model X, --resume
      // <sid>, --remote-control [name]).
      const peek: string | undefined = args[i + 1];
      if (peek !== undefined && !peek.startsWith('-')) {
        i += 1;
      }
      continue;
    }
    out.push(token);
  }
  return out;
}
