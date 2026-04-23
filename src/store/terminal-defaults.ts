/* eslint-disable solid/reactivity -- createRoot(() => createSignal(...)) is an intentional HMR-safe pattern; the tuple is destructured at the outer call site, which the linter can't see through the closure. */
/**
 * terminal-defaults.ts
 * Global per-launch defaults applied to every new Claude terminal:
 *   - default flags (e.g. --dangerously-skip-permissions)
 *   - environment variables (e.g. HTTPS_PROXY)
 *   - default cwd fallback
 * Persisted in localStorage (simple JSON). Not in the main parallel-code
 * persisted store to avoid schema churn.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';

export interface TerminalDefaults {
  flags: string[];
  env: Record<string, string>;
  cwd?: string;
}

const STORAGE_KEY = 'claudedesk.terminalDefaults';

const INITIAL: TerminalDefaults = {
  flags: [],
  env: {},
};

function loadInitial(): TerminalDefaults {
  if (typeof localStorage === 'undefined') return INITIAL;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL;
    const parsed = JSON.parse(raw) as Partial<TerminalDefaults>;
    return {
      flags: Array.isArray(parsed.flags) ? parsed.flags.filter((f) => typeof f === 'string') : [],
      env:
        parsed.env && typeof parsed.env === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.env).filter(
                ([k, v]) => typeof k === 'string' && typeof v === 'string',
              ),
            )
          : {},
      ...(typeof parsed.cwd === 'string' && parsed.cwd ? { cwd: parsed.cwd } : {}),
    };
  } catch {
    return INITIAL;
  }
}

const [_terminalDefaults, _setTerminalDefaults] = createRoot<
  [Accessor<TerminalDefaults>, Setter<TerminalDefaults>]
>(() => createSignal<TerminalDefaults>(loadInitial()));

export const terminalDefaults = _terminalDefaults;

function persist(next: TerminalDefaults): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage quota / private mode */
  }
}

export function setTerminalFlags(flags: string[]): void {
  const next: TerminalDefaults = { ...terminalDefaults(), flags };
  _setTerminalDefaults(next);
  persist(next);
}

export function setTerminalEnv(env: Record<string, string>): void {
  const next: TerminalDefaults = { ...terminalDefaults(), env };
  _setTerminalDefaults(next);
  persist(next);
}

export function setTerminalCwd(cwd: string | undefined): void {
  const curr = terminalDefaults();
  const next: TerminalDefaults = cwd ? { ...curr, cwd } : { flags: curr.flags, env: curr.env };
  _setTerminalDefaults(next);
  persist(next);
}

/** Parse a flags textarea value — each non-empty line is one argument. */
export function parseFlagsInput(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse env textarea — "KEY=VALUE" per line.
 *  Accepts common shell-paste prefixes/quoting so a user can copy a line
 *  from their PowerShell/bash profile and have it Just Work:
 *    $env:FOO="bar"   (PowerShell)
 *    export FOO="bar" (bash/zsh)
 *    set FOO=bar      (cmd.exe)
 *  Matching outer quotes (both " and ') are stripped from the value.
 */
export function parseEnvInput(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    let t = line.trim();
    if (!t || t.startsWith('#')) continue;

    // Strip shell prefixes: PowerShell ($env:), bash/zsh (export), cmd (set).
    t = t.replace(/^\$env:/i, '');
    t = t.replace(/^(?:export|set)\s+/i, '');

    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();

    // Strip matching outer quotes from the value. Only if both ends match —
    // otherwise the quotes are meaningful content.
    if (v.length >= 2) {
      const first = v[0];
      const last = v[v.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        v = v.slice(1, -1);
      }
    }

    if (k) out[k] = v;
  }
  return out;
}

export function stringifyFlags(flags: string[]): string {
  return flags.join('\n');
}

export function stringifyEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}
