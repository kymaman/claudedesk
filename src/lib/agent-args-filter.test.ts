/**
 * Unit: agent args filter — pins the "don't pass unsupported flags"
 * contract so a future claude release that drops e.g. --remote-control
 * gracefully degrades instead of breaking session spawn.
 */
import { describe, it, expect } from 'vitest';
import { filterArgsBySupport } from './agent-args-filter';

describe('filterArgsBySupport', () => {
  it('passes args unchanged when no probe data is available', () => {
    expect(filterArgsBySupport(['--remote-control', '--resume', 'sid'], undefined)).toEqual([
      '--remote-control',
      '--resume',
      'sid',
    ]);
    expect(filterArgsBySupport(['--remote-control'], new Set())).toEqual(['--remote-control']);
  });

  it('strips an unsupported owned flag', () => {
    const supported = new Set(['--resume', '--fork-session']);
    expect(filterArgsBySupport(['--remote-control', '--resume', 'sid'], supported)).toEqual([
      '--resume',
      'sid',
    ]);
  });

  it('also drops the value of a stripped flag (--model claude-opus-4-8)', () => {
    const supported = new Set(['--resume']);
    expect(
      filterArgsBySupport(
        ['--resume', 'sid', '--model', 'claude-opus-4-8', '--remote-control'],
        supported,
      ),
    ).toEqual(['--resume', 'sid']);
  });

  it('does NOT drop the next arg if it itself looks like a flag', () => {
    const supported = new Set(['--resume', '--fork-session']);
    // --remote-control unsupported, next is --fork-session (a real flag) —
    // must not be eaten as a value.
    expect(filterArgsBySupport(['--remote-control', '--fork-session'], supported)).toEqual([
      '--fork-session',
    ]);
  });

  it("never strips user-supplied flags we don't recognise", () => {
    const supported = new Set(['--resume']);
    // --verbose is not in CLAUDEDESK_OWNED_FLAGS — pass through even
    // though the probe says it's unsupported.
    expect(filterArgsBySupport(['--verbose'], supported)).toEqual(['--verbose']);
  });

  it('handles --continue (alternate resume form)', () => {
    const supported = new Set(['--resume']);
    expect(filterArgsBySupport(['--continue'], supported)).toEqual([]);
  });

  it('preserves order of surviving flags', () => {
    const supported = new Set(['--resume', '--fork-session', '--model']);
    expect(
      filterArgsBySupport(
        ['--remote-control', '--resume', 'sid', '--fork-session', '--model', 'opus'],
        supported,
      ),
    ).toEqual(['--resume', 'sid', '--fork-session', '--model', 'opus']);
  });
});
