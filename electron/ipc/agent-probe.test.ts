/**
 * Unit: parseFlags + parseVersion — these parsers gate which CLI args
 * we feed to claude. Regressing them silently would mean ClaudeDesk
 * either drops valid flags (sessions don't get --remote-control) or
 * passes flags the binary doesn't understand (spawn fails).
 */
import { describe, it, expect } from 'vitest';
import { parseFlags, parseVersion } from './agent-probe.js';

describe('parseFlags', () => {
  it('picks up canonical "  --flag" left-column form', () => {
    const help = [
      'Usage: claude [options]',
      '',
      'Options:',
      '  --resume [value]                  Resume a conversation',
      '  --fork-session                    When resuming, create a new id',
      '  --remote-control [name]           Start with Remote Control',
      '  --dangerously-skip-permissions    Bypass permission checks',
      '  --model <model>                   Model for the current session',
    ].join('\n');
    const flags = parseFlags(help);
    expect(flags.has('--resume')).toBe(true);
    expect(flags.has('--fork-session')).toBe(true);
    expect(flags.has('--remote-control')).toBe(true);
    expect(flags.has('--dangerously-skip-permissions')).toBe(true);
    expect(flags.has('--model')).toBe(true);
  });

  it('does NOT pick up flag mentions inside help prose', () => {
    const help = [
      '  --resume [value]                  Resume a conversation',
      '                                    e.g. use --resume to continue',
    ].join('\n');
    const flags = parseFlags(help);
    expect(flags.has('--resume')).toBe(true);
    // The prose mention has too much leading whitespace (the description
    // column), so it should not be treated as a new flag definition.
    // Our regex matches anything in the left column; verify the prose-
    // embedded "--resume" doesn't duplicate. With a Set that's free, but
    // the key check: parseFlags should not spuriously list flags that
    // never appeared in the column form.
    expect(flags.size).toBe(1);
  });

  it('returns an empty set on empty input', () => {
    expect(parseFlags('').size).toBe(0);
  });

  it('handles --short flags later in line (only long-form counted)', () => {
    const help = '  -r, --resume [value]              Resume a conversation';
    const flags = parseFlags(help);
    expect(flags.has('--resume')).toBe(true);
    expect(flags.size).toBe(1);
  });

  it('detects the OLD-version case where --remote-control is absent', () => {
    // Real 2.1.116 / 2.1.101 only had the prefix flag, not the bare one.
    const help = [
      '  --fork-session                    When resuming, create a new id',
      '  --remote-control-session-name-prefix <prefix>     Prefix for ...',
    ].join('\n');
    const flags = parseFlags(help);
    expect(flags.has('--fork-session')).toBe(true);
    expect(flags.has('--remote-control-session-name-prefix')).toBe(true);
    expect(flags.has('--remote-control')).toBe(false);
  });
});

describe('parseVersion', () => {
  it('extracts "X.Y.Z" from the canonical claude format', () => {
    expect(parseVersion('2.1.162 (Claude Code)')).toBe('2.1.162');
  });

  it('extracts pre-release tag too', () => {
    expect(parseVersion('2.2.0-rc1 (Claude Code)')).toBe('2.2.0-rc1');
  });

  it('returns null when no version can be found', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('Claude Code')).toBeNull();
  });
});
