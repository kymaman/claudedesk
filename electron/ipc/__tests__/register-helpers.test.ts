/**
 * register-helpers.test.ts
 *
 * Unit tests for the schema validation helper introduced in Phase-2 B1.
 * Locks the contract that:
 *   - error messages match the existing assert*-prefixed text (so any
 *     consumer matching on them keeps working);
 *   - every supported FieldKind branch is reachable;
 *   - extra keys present on `args` but not in `schema` are dropped from
 *     the typed output (so handlers can't accidentally trust unvalidated
 *     fields).
 */

import { describe, expect, it } from 'vitest';
import { validateArgs, validatePath, type FieldKind } from '../register-helpers.js';

describe('validateArgs — FieldKind coverage', () => {
  it('accepts all-good args and strips fields not declared in the schema', () => {
    const out = validateArgs<{ id: string; cols: number }>(
      { id: 'abc', cols: 80, rogue: 'unwanted' },
      { id: 'string', cols: 'int' },
    );
    expect(out).toEqual({ id: 'abc', cols: 80 });
    expect('rogue' in out).toBe(false);
  });

  it("rejects wrong types with the same '${label} must be …' shape as validate.ts", () => {
    expect(() => validateArgs({ id: 42 }, { id: 'string' })).toThrow('id must be a string');
    expect(() => validateArgs({ count: 'one' }, { count: 'int' })).toThrow(
      'count must be an integer',
    );
    expect(() => validateArgs({ enabled: 'true' }, { enabled: 'boolean' })).toThrow(
      'enabled must be a boolean',
    );
    expect(() => validateArgs({ tags: ['ok', 7] }, { tags: 'string[]' })).toThrow(
      'tags must be a string array',
    );
  });

  it('passes optional fields when undefined and rejects them when wrong type', () => {
    const ok = validateArgs<{ alias?: string; debug?: boolean }>(
      {},
      { alias: 'optionalString', debug: 'optionalBoolean' },
    );
    expect(ok).toEqual({ alias: undefined, debug: undefined });
    expect(() => validateArgs({ alias: 7 }, { alias: 'optionalString' })).toThrow(
      'alias must be a string or undefined',
    );
    expect(() => validateArgs({ debug: 'yes' }, { debug: 'optionalBoolean' })).toThrow(
      'debug must be a boolean or undefined',
    );
  });

  it('treats a null/undefined args object as an empty object (no fields required to be set)', () => {
    const out = validateArgs<{ alias?: string }>(undefined, { alias: 'optionalString' });
    expect(out).toEqual({ alias: undefined });
  });

  it('compile-time guards: unknown FieldKind throws at runtime', () => {
    // Cast around the type system to exercise the default branch.
    const bogus = { x: 'mystery' as unknown as FieldKind };
    expect(() => validateArgs({ x: 1 }, bogus)).toThrow('unknown FieldKind');
  });
});

describe('validatePath', () => {
  it('accepts an absolute path with no traversal', () => {
    // Cross-platform: pick a path that's absolute on whichever OS runs the test.
    const abs = process.platform === 'win32' ? 'C:\\Users\\me\\proj' : '/home/me/proj';
    expect(() => validatePath(abs, 'cwd')).not.toThrow();
  });

  it('rejects a non-string', () => {
    expect(() => validatePath(42, 'cwd')).toThrow('cwd must be a string');
  });

  it('rejects a relative path', () => {
    expect(() => validatePath('subdir/file', 'cwd')).toThrow('cwd must be absolute');
  });

  it('rejects any path containing ".." (defends against traversal)', () => {
    const trav = process.platform === 'win32' ? 'C:\\foo\\..\\bar' : '/foo/../bar';
    expect(() => validatePath(trav, 'cwd')).toThrow('cwd must not contain ".."');
  });
});

describe('validateArgs — `path` field kind', () => {
  it('accepts an absolute non-traversal path', () => {
    const abs = process.platform === 'win32' ? 'D:\\projects\\x' : '/var/x';
    const out = validateArgs<{ cwd: string }>({ cwd: abs }, { cwd: 'path' });
    expect(out.cwd).toBe(abs);
  });

  it('rejects a relative path with the correct label', () => {
    expect(() => validateArgs({ cwd: 'rel/path' }, { cwd: 'path' })).toThrow(
      'cwd must be absolute',
    );
  });
});
