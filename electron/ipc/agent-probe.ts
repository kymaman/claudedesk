/**
 * agent-probe.ts
 *
 * Probes a claude binary for the flags + version it currently supports
 * by parsing `claude --help` and `claude --version`. ClaudeDesk uses
 * this to FILTER args before spawning, so that when Anthropic ships a
 * new CLI that drops or renames a flag (e.g. removes --remote-control,
 * renames --fork-session), we don't pass it blindly and crash the
 * spawn. The probe runs once per (binary path, mtime) and is cached
 * for the lifetime of the process.
 *
 * Why parse help text instead of trying flags speculatively: trying
 * `claude --remote-control` against a binary that doesn't recognise it
 * costs a real process spawn AND can hang in interactive mode (claude
 * is a TUI). Reading --help is a one-shot stdout read.
 */
import fs from 'fs';
import { execFile } from 'child_process';

export interface ClaudeCapabilities {
  /** Raw version string e.g. "2.1.162". Null if --version failed. */
  version: string | null;
  /** Long-form flags we found in `--help` (e.g. "--remote-control",
   *  "--fork-session"). Lookup is exact match on the long name. */
  flags: ReadonlySet<string>;
}

interface CacheEntry {
  mtimeMs: number;
  caps: ClaudeCapabilities;
}

const _cache = new Map<string, CacheEntry>();

const PROBE_TIMEOUT_MS = 5_000;

function execText(bin: string, arg: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [arg],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        // commander.js writes --help to stdout, --version to stdout; some
        // builds split to stderr. Concatenate so we don't miss either.
        if (err && !stdout && !stderr) {
          resolve('');
          return;
        }
        resolve((stdout || '') + (stderr || ''));
      },
    );
  });
}

/** Extract `--long-flag-name` tokens from --help output. Matches only
 *  the canonical "  --flag" left-column form so we don't pick up flag
 *  mentions embedded in help-text prose. */
export function parseFlags(helpText: string): Set<string> {
  const flags = new Set<string>();
  // Multi-line; flag MUST be at the start of its column (allow leading
  // whitespace) OR follow a short-flag alias like "-r, ". Long flag
  // form only: --kebab-case. The short-alias case matters because
  // claude's help formats some options as "  -r, --resume [value]"
  // and the long flag still represents the real option name.
  const re = /(?:^|\n)(?:\s{2,}|\s+-[a-z],\s+)(--[a-z][a-z0-9-]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(helpText)) !== null) {
    flags.add(m[1]);
  }
  return flags;
}

/** Extract a semver-ish "X.Y.Z" from --version output. */
export function parseVersion(versionText: string): string | null {
  const m = versionText.match(/\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/);
  return m ? m[1] : null;
}

export async function probeClaudeBin(binPath: string): Promise<ClaudeCapabilities> {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(binPath).mtimeMs;
  } catch {
    // Binary doesn't exist — return an empty capability set so the
    // caller can decide. We don't cache misses; next call retries.
    return { version: null, flags: new Set() };
  }
  const cached = _cache.get(binPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.caps;

  const [helpText, versionText] = await Promise.all([
    execText(binPath, '--help'),
    execText(binPath, '--version'),
  ]);
  const caps: ClaudeCapabilities = {
    version: parseVersion(versionText),
    flags: parseFlags(helpText),
  };
  _cache.set(binPath, { mtimeMs, caps });
  return caps;
}

/** Test hook: clear the cache so unit tests don't see entries from
 *  earlier in the same process. */
export function _clearProbeCache(): void {
  _cache.clear();
}
