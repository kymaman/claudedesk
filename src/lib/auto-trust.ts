/**
 * auto-trust.ts
 *
 * Decides whether to auto-press Enter on Claude Code's interactive
 * "Trust this folder?" prompt.
 *
 * Why this exists: on `--resume`, every restored tile spawns `claude
 * --resume <sid>` in its old cwd. If that folder isn't on Claude's trust
 * list, Claude shows a blocking "Is this a project you trust? 1. Yes …"
 * prompt and IDLES waiting for input. The result the user reported: open an
 * old dialog → you see Claude's trust prompt + blank space, the actual
 * conversation is stuck up in scrollback, and nothing continues — "история
 * замирает и её не видно". With many tiles restored at once (after a crash
 * restart) every one of them freezes like this.
 *
 * The fix: for a RESUMED session, auto-confirm the folder-trust prompt even
 * when the global `autoTrustFolders` toggle is off — resuming a session
 * inherently means the user already worked in (and trusts) that folder.
 * This ONLY confirms the folder-trust prompt; it does NOT add
 * `--dangerously-skip-permissions` (that stays behind the toggle), so
 * per-tool permission prompts are unaffected.
 *
 * Safety: a small exclusion list prevents auto-pressing Enter when the
 * recent output looks like a destructive confirmation (delete / credential
 * / format / drop …) that merely happens to contain the word "trust".
 */

/** Recent-output patterns that identify Claude's folder-trust prompt. */
export const TRUST_PATTERNS: readonly RegExp[] = [
  /\btrust\b.*\?/i,
  /trust.*folder/i,
  /confirm.*folder.*trust/i,
];

/** If any of these appear, never auto-press Enter — the prompt may be a
 *  destructive confirmation rather than the benign folder-trust dialog. */
export const TRUST_EXCLUSIONS =
  /\b(delet|remov|credential|secret|password|key|token|destro|format|drop)/i;

export interface AutoTrustInput {
  /** ANSI-stripped tail of recent terminal output. */
  text: string;
  /** True when the spawned command is a Claude binary. */
  commandLooksClaude: boolean;
  /** True when this tile was spawned with `--resume` (restored / branched). */
  isResume: boolean;
  /** The global "auto-trust folders" preference. */
  autoTrustEnabled: boolean;
}

/**
 * Should we auto-press Enter to confirm the folder-trust prompt now?
 *
 * - Non-Claude commands: never.
 * - Destructive-looking output: never (safety exclusion wins).
 * - Resumed session: yes when the trust prompt is present (regardless of the
 *   toggle) — this is what unfreezes restored tiles.
 * - Fresh session: only when the user enabled `autoTrustFolders`.
 */
export function shouldAutoConfirmFolderTrust(input: AutoTrustInput): boolean {
  if (!input.commandLooksClaude) return false;
  if (TRUST_EXCLUSIONS.test(input.text)) return false;
  if (!input.autoTrustEnabled && !input.isResume) return false;
  return TRUST_PATTERNS.some((rx) => rx.test(input.text));
}
