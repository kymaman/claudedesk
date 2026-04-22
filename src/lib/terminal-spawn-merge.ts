/**
 * terminal-spawn-merge.ts
 * Pure helpers that merge global Terminal Defaults (from Agents view) with
 * task-specific args/env before we hand them to the SpawnAgent IPC.
 *
 * Extracted from TerminalView so the merge rules can be unit-tested without
 * standing up an xterm instance.
 */

import type { TerminalDefaults } from '../store/terminal-defaults';

/**
 * Merge args for SpawnAgent.
 *
 * Order is `[...taskArgs, ...defaultFlags, ...autoFlags]` so that:
 *  - agent-level args (e.g. `--resume <id>`) come first — Claude requires them
 *    near the front to correctly identify the action,
 *  - user global defaults come after, and
 *  - auto-trust etc. are appended last so they're easy to reason about and
 *    duplicates are de-duped at the edge.
 *
 * Late duplicates are silently dropped — some Claude subcommands choke on
 * `--flag --flag`.
 */
export function mergeSpawnArgs(
  taskArgs: readonly string[] | undefined,
  defaultFlags: readonly string[] | undefined,
  autoFlags: readonly string[] | undefined = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const flag = raw.trim();
    if (!flag) return;
    // Only dedupe boolean-style flags (those starting with `--`). Positional
    // args like `--resume <id>` are two separate tokens and must not be
    // dropped just because the value was seen elsewhere.
    if (flag.startsWith('--') && seen.has(flag)) return;
    if (flag.startsWith('--')) seen.add(flag);
    out.push(flag);
  };
  for (const a of taskArgs ?? []) push(a);
  for (const a of defaultFlags ?? []) push(a);
  for (const a of autoFlags ?? []) push(a);
  return out;
}

/**
 * Keys we refuse to forward from the renderer. PATH/HOME/USER/SHELL replacement
 * would break the claude CLI; LD_PRELOAD and NODE_OPTIONS are loader-hijack
 * vectors. Mirrored in electron/ipc/pty.ts — exported here so tests and the
 * renderer can surface a warning before the user even hits Save.
 */
export const ENV_BLOCK_LIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
]);

/**
 * Merge env for SpawnAgent.
 *
 * `defaults.env` is the base (global proxy, API keys), `taskEnv` wins over
 * defaults (per-session overrides). Keys in ENV_BLOCK_LIST are silently
 * dropped on both sides — defence in depth; pty.ts also filters at spawn
 * time but this keeps the IPC payload clean.
 *
 * Values are preserved as-is (not trimmed) because HTTPS_PROXY values can
 * legitimately contain leading/trailing whitespace inside e.g. a bracketed
 * IPv6 host. Keys are trimmed because textarea input can leave stray space.
 */
export function mergeSpawnEnv(
  defaults: Pick<TerminalDefaults, 'env'> | undefined,
  taskEnv: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (k: string, v: string) => {
    const key = k.trim();
    if (!key) return;
    if (ENV_BLOCK_LIST.has(key)) return;
    out[key] = v;
  };
  for (const [k, v] of Object.entries(defaults?.env ?? {})) add(k, v);
  for (const [k, v] of Object.entries(taskEnv ?? {})) add(k, v);
  return out;
}
