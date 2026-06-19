/**
 * rename-key.test.ts
 *
 * Pins the IME-safe rename key rules that fix the "rename a session in
 * Russian, press Enter → app crashes" bug. The crash came from committing
 * (and unmounting the input) while an IME / dictation composition was
 * still active. Enter/Escape must be ignored until composition ends.
 */

import { describe, it, expect } from 'vitest';
import { isComposing, isCommitKey, isCancelKey } from './rename-key';

describe('rename-key — IME-safe commit/cancel', () => {
  it('commits on a plain Enter (no composition)', () => {
    expect(isCommitKey({ key: 'Enter' })).toBe(true);
    expect(isCommitKey({ key: 'Enter', isComposing: false })).toBe(true);
  });

  it('does NOT commit on Enter while composing (isComposing) — the crash case', () => {
    expect(isCommitKey({ key: 'Enter', isComposing: true })).toBe(false);
  });

  it('does NOT commit on Enter while composing (legacy keyCode 229)', () => {
    expect(isCommitKey({ key: 'Enter', keyCode: 229 })).toBe(false);
  });

  it('cancels on a plain Escape, but not while composing', () => {
    expect(isCancelKey({ key: 'Escape' })).toBe(true);
    expect(isCancelKey({ key: 'Escape', isComposing: true })).toBe(false);
    expect(isCancelKey({ key: 'Escape', keyCode: 229 })).toBe(false);
  });

  it('ignores unrelated keys', () => {
    expect(isCommitKey({ key: 'a' })).toBe(false);
    expect(isCancelKey({ key: 'a' })).toBe(false);
  });

  it('isComposing reports both signals', () => {
    expect(isComposing({ key: 'Enter' })).toBe(false);
    expect(isComposing({ key: 'Enter', isComposing: true })).toBe(true);
    expect(isComposing({ key: 'Enter', keyCode: 229 })).toBe(true);
  });
});
