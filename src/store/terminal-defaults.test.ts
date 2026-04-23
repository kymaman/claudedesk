/**
 * Regression tests for terminal defaults — the feature the user described as
 * "I saved proxy env vars in Settings, started a new chat, and they don't
 *  reach the CLI." Each test pins down a single link in the chain:
 *   1. parseFlagsInput/parseEnvInput — textarea text → store payload
 *   2. setTerminalFlags/setTerminalEnv — payload → localStorage round-trip
 *   3. mergeSpawnArgs/mergeSpawnEnv — payload → what we hand to SpawnAgent
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal in-memory localStorage polyfill — vitest runs under Node so the
// browser API isn't there by default, but the store reads it synchronously.
{
  const store = new Map<string, string>();
  const polyfill = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) ?? null) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: polyfill,
    configurable: true,
  });
}

async function importTerminalDefaults() {
  vi.resetModules();
  return await import('./terminal-defaults.js');
}

async function importMerge() {
  vi.resetModules();
  return await import('../lib/terminal-spawn-merge.js');
}

// ---------------------------------------------------------------------------
// parseFlagsInput
// ---------------------------------------------------------------------------

describe('parseFlagsInput', () => {
  it('splits on newlines and trims whitespace', async () => {
    const { parseFlagsInput } = await importTerminalDefaults();
    expect(parseFlagsInput('  --foo\n --bar \n\t--baz')).toEqual(['--foo', '--bar', '--baz']);
  });

  it('drops empty lines', async () => {
    const { parseFlagsInput } = await importTerminalDefaults();
    expect(parseFlagsInput('--foo\n\n\n--bar')).toEqual(['--foo', '--bar']);
  });

  it('handles CRLF line endings (Windows textarea)', async () => {
    const { parseFlagsInput } = await importTerminalDefaults();
    expect(parseFlagsInput('--foo\r\n--bar')).toEqual(['--foo', '--bar']);
  });

  it('returns an empty array for empty/whitespace input', async () => {
    const { parseFlagsInput } = await importTerminalDefaults();
    expect(parseFlagsInput('')).toEqual([]);
    expect(parseFlagsInput('   \n\t\n  ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseEnvInput — this is the proxy-handling hot spot
// ---------------------------------------------------------------------------

describe('parseEnvInput', () => {
  it('parses a single KEY=VALUE line', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    expect(parseEnvInput('HTTPS_PROXY=http://localhost:7890')).toEqual({
      HTTPS_PROXY: 'http://localhost:7890',
    });
  });

  it('preserves "=" inside the value (first "=" is the separator)', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    // A URL-encoded credential or a base64 chunk legitimately contains "=".
    expect(parseEnvInput('TOKEN=abc=def==')).toEqual({ TOKEN: 'abc=def==' });
  });

  it('parses multiple lines — flags + env together is the common user pattern', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    expect(
      parseEnvInput(
        [
          'HTTP_PROXY=http://127.0.0.1:7890',
          'HTTPS_PROXY=http://127.0.0.1:7890',
          'NO_PROXY=localhost',
        ].join('\n'),
      ),
    ).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost',
    });
  });

  it('skips comments (#) and blank lines', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    expect(parseEnvInput('# proxy\nHTTPS_PROXY=x\n\n#trailing')).toEqual({ HTTPS_PROXY: 'x' });
  });

  it('ignores lines without "="', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    expect(parseEnvInput('HTTPS_PROXY=x\njust-a-label')).toEqual({ HTTPS_PROXY: 'x' });
  });

  it('ignores lines where "=" is the first character (no key)', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    expect(parseEnvInput('=oops\nHTTPS_PROXY=x')).toEqual({ HTTPS_PROXY: 'x' });
  });

  it('handles CRLF (Windows paste)', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    expect(parseEnvInput('A=1\r\nB=2')).toEqual({ A: '1', B: '2' });
  });

  // Regression: a user pasted a PowerShell line straight out of their profile
  // — `$env:HTTPS_PROXY="http://..."` — and the resulting env var was named
  // `$env:HTTPS_PROXY` with a quoted value, so claude never saw any proxy.
  it('strips PowerShell $env: prefix and outer double quotes (the real-world paste)', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    expect(
      parseEnvInput('$env:HTTPS_PROXY="http://srZNTTCu:fKapAXdD@172.120.137.143:63028"'),
    ).toEqual({ HTTPS_PROXY: 'http://srZNTTCu:fKapAXdD@172.120.137.143:63028' });
  });

  it('strips bash/zsh `export` prefix and single quotes', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    expect(parseEnvInput("export HTTPS_PROXY='http://user:pass@host:7890'")).toEqual({
      HTTPS_PROXY: 'http://user:pass@host:7890',
    });
  });

  it('strips cmd.exe `set` prefix (no quotes around value)', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    expect(parseEnvInput('set HTTPS_PROXY=http://host:7890')).toEqual({
      HTTPS_PROXY: 'http://host:7890',
    });
  });

  it('keeps inner quotes when only one side has a quote (not a balanced wrap)', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    // A literal `"something` is unusual but must not be silently chopped.
    expect(parseEnvInput('A="half-open')).toEqual({ A: '"half-open' });
  });

  it('accepts a mix of shell styles in one paste', async () => {
    const { parseEnvInput } = await importTerminalDefaults();
    const input = [
      '$env:HTTPS_PROXY="http://a:1"',
      "export HTTP_PROXY='http://b:2'",
      'NO_PROXY=localhost',
    ].join('\n');
    expect(parseEnvInput(input)).toEqual({
      HTTPS_PROXY: 'http://a:1',
      HTTP_PROXY: 'http://b:2',
      NO_PROXY: 'localhost',
    });
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip — this is where "I clicked Save but nothing stuck"
// bugs would live.
// ---------------------------------------------------------------------------

describe('setTerminalFlags + setTerminalEnv → localStorage → reload', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('setTerminalFlags writes to localStorage', async () => {
    const mod = await importTerminalDefaults();
    mod.setTerminalFlags(['--dangerously-skip-permissions', '--model=sonnet']);
    const raw = localStorage.getItem('claudedesk.terminalDefaults');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.flags).toEqual(['--dangerously-skip-permissions', '--model=sonnet']);
  });

  it('setTerminalEnv writes to localStorage', async () => {
    const mod = await importTerminalDefaults();
    mod.setTerminalEnv({ HTTPS_PROXY: 'http://localhost:7890' });
    const raw = localStorage.getItem('claudedesk.terminalDefaults');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.env).toEqual({ HTTPS_PROXY: 'http://localhost:7890' });
  });

  it('flags and env coexist — saving one does not clobber the other', async () => {
    // Simulate the bug the user described: "я сохранил env, но потом..."
    // Save flags first, then env; both must persist.
    const mod = await importTerminalDefaults();
    mod.setTerminalFlags(['--model=opus']);
    mod.setTerminalEnv({ HTTPS_PROXY: 'http://localhost:7890' });
    const raw = localStorage.getItem('claudedesk.terminalDefaults');
    const parsed = JSON.parse(raw as string);
    expect(parsed.flags).toEqual(['--model=opus']);
    expect(parsed.env).toEqual({ HTTPS_PROXY: 'http://localhost:7890' });
  });

  it('a fresh module load picks up the last saved value (fresh chat scenario)', async () => {
    // User saves env in one "session", then a new TerminalView mounts after
    // Vite HMR (or after an app restart). The fresh module must see it.
    const first = await importTerminalDefaults();
    first.setTerminalEnv({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    first.setTerminalFlags(['--dangerously-skip-permissions']);

    const fresh = await importTerminalDefaults();
    const value = fresh.terminalDefaults();
    expect(value.env).toEqual({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    expect(value.flags).toEqual(['--dangerously-skip-permissions']);
  });

  it('ignores malformed persisted JSON and falls back to empty defaults', async () => {
    localStorage.setItem('claudedesk.terminalDefaults', '{not valid');
    const { terminalDefaults } = await importTerminalDefaults();
    expect(terminalDefaults()).toEqual({ flags: [], env: {} });
  });

  it('strips non-string env values when loading (hand-edited localStorage)', async () => {
    localStorage.setItem(
      'claudedesk.terminalDefaults',
      JSON.stringify({ flags: ['--ok'], env: { A: 'keep', B: 42, C: null } }),
    );
    const { terminalDefaults } = await importTerminalDefaults();
    expect(terminalDefaults().env).toEqual({ A: 'keep' });
    expect(terminalDefaults().flags).toEqual(['--ok']);
  });
});

// ---------------------------------------------------------------------------
// mergeSpawnArgs + mergeSpawnEnv — the final hop into SpawnAgent IPC
// ---------------------------------------------------------------------------

describe('mergeSpawnArgs', () => {
  it('appends default flags after task args', async () => {
    const { mergeSpawnArgs } = await importMerge();
    expect(mergeSpawnArgs(['--resume', 'abc'], ['--dangerously-skip-permissions'])).toEqual([
      '--resume',
      'abc',
      '--dangerously-skip-permissions',
    ]);
  });

  it('appends auto flags (auto-trust) after defaults', async () => {
    const { mergeSpawnArgs } = await importMerge();
    expect(
      mergeSpawnArgs(['--resume', 'abc'], ['--model=opus'], ['--dangerously-skip-permissions']),
    ).toEqual(['--resume', 'abc', '--model=opus', '--dangerously-skip-permissions']);
  });

  it('dedupes repeated --flags (auto-trust vs default already containing it)', async () => {
    const { mergeSpawnArgs } = await importMerge();
    const out = mergeSpawnArgs(
      ['--resume', 'abc'],
      ['--dangerously-skip-permissions'],
      ['--dangerously-skip-permissions'],
    );
    expect(out.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(1);
  });

  it('does NOT dedupe positional arg values like "abc" even if repeated', async () => {
    const { mergeSpawnArgs } = await importMerge();
    // Positional duplicates can be meaningful (e.g. repeated file paths).
    const out = mergeSpawnArgs(['--resume', 'abc', 'abc'], []);
    expect(out).toEqual(['--resume', 'abc', 'abc']);
  });

  it('trims whitespace and drops empty tokens', async () => {
    const { mergeSpawnArgs } = await importMerge();
    expect(mergeSpawnArgs(['  --resume  ', 'abc'], ['', '  ', '--ok  '])).toEqual([
      '--resume',
      'abc',
      '--ok',
    ]);
  });

  it('handles undefined inputs', async () => {
    const { mergeSpawnArgs } = await importMerge();
    expect(mergeSpawnArgs(undefined, undefined)).toEqual([]);
  });
});

describe('mergeSpawnEnv', () => {
  it('merges defaults.env as base, task env as override', async () => {
    const { mergeSpawnEnv } = await importMerge();
    const merged = mergeSpawnEnv(
      { env: { HTTPS_PROXY: 'http://default:7890', API_KEY: 'from-defaults' } },
      { API_KEY: 'from-task' },
    );
    expect(merged).toEqual({ HTTPS_PROXY: 'http://default:7890', API_KEY: 'from-task' });
  });

  it('returns an empty object when both sides are empty/undefined', async () => {
    const { mergeSpawnEnv } = await importMerge();
    expect(mergeSpawnEnv(undefined, undefined)).toEqual({});
    expect(mergeSpawnEnv({ env: {} }, {})).toEqual({});
  });

  it('forwards proxy-like keys — the regression we are protecting against', async () => {
    const { mergeSpawnEnv } = await importMerge();
    const merged = mergeSpawnEnv(
      {
        env: {
          HTTP_PROXY: 'http://127.0.0.1:7890',
          HTTPS_PROXY: 'http://127.0.0.1:7890',
          NO_PROXY: 'localhost,127.0.0.1',
        },
      },
      {},
    );
    expect(merged).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1',
    });
  });

  it('drops renderer-side entries that could hijack the loader (defence in depth)', async () => {
    const { mergeSpawnEnv } = await importMerge();
    const merged = mergeSpawnEnv(
      {
        env: {
          LD_PRELOAD: '/tmp/evil.so',
          NODE_OPTIONS: '--inspect',
          HTTPS_PROXY: 'http://ok:7890',
        },
      },
      {},
    );
    expect(merged).toEqual({ HTTPS_PROXY: 'http://ok:7890' });
  });

  it('does not mutate the inputs', async () => {
    const { mergeSpawnEnv } = await importMerge();
    const defaults = { env: { A: '1' } };
    const task = { B: '2' };
    mergeSpawnEnv(defaults, task);
    expect(defaults).toEqual({ env: { A: '1' } });
    expect(task).toEqual({ B: '2' });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: user types → saves → loads → merges — the whole chain
// ---------------------------------------------------------------------------

describe('End-to-end: textarea input → SpawnAgent payload', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('proxy path: typing HTTPS_PROXY in Settings reaches mergeSpawnEnv output', async () => {
    const mod = await importTerminalDefaults();
    const { mergeSpawnEnv } = await importMerge();

    // 1. User types in the env textarea
    const textarea = 'HTTPS_PROXY=http://localhost:7890\nHTTP_PROXY=http://localhost:7890';
    // 2. Clicks Save
    mod.setTerminalEnv(mod.parseEnvInput(textarea));

    // 3. Later, a new TerminalView mounts and reads defaults + merges for the spawn
    const fresh = await importTerminalDefaults();
    const merged = mergeSpawnEnv(fresh.terminalDefaults(), {});

    expect(merged).toEqual({
      HTTPS_PROXY: 'http://localhost:7890',
      HTTP_PROXY: 'http://localhost:7890',
    });
  });

  it('default flags path: typing --dangerously-skip-permissions appears in mergeSpawnArgs output', async () => {
    const mod = await importTerminalDefaults();
    const { mergeSpawnArgs } = await importMerge();

    mod.setTerminalFlags(mod.parseFlagsInput('--dangerously-skip-permissions\n--model=opus'));

    const fresh = await importTerminalDefaults();
    const merged = mergeSpawnArgs(['--resume', 'abc'], fresh.terminalDefaults().flags);

    expect(merged).toEqual(['--resume', 'abc', '--dangerously-skip-permissions', '--model=opus']);
  });
});
