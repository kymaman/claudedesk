/**
 * selection-mirror.test.ts
 *
 * Pins the rule that lets the 200ms helper-textarea poll tell xterm's
 * right-click copy-mirror (fully-selected value) apart from genuine
 * dictation/paste injection (caret collapsed at end). See the "right-click
 * pastes my selection into the terminal" bug in selection-mirror.ts.
 */

import { describe, it, expect } from 'vitest';
import { isSelectionMirror } from './selection-mirror';

describe('isSelectionMirror', () => {
  it('detects a fully-selected non-empty value (xterm right-click copy-mirror)', () => {
    const value = 'npm run build';
    expect(isSelectionMirror({ value, selectionStart: 0, selectionEnd: value.length })).toBe(true);
  });

  it('detects a fully-selected MULTI-LINE value (the actual bug shape)', () => {
    const value = 'error: cannot find module\n  at require (internal)\n  at Object.<anonymous>';
    expect(isSelectionMirror({ value, selectionStart: 0, selectionEnd: value.length })).toBe(true);
  });

  it('does NOT flag dictation: value set with caret collapsed at the end', () => {
    // Wispr Flow / SendInput set value but leave the caret at the end.
    const value = 'привет как дела';
    expect(
      isSelectionMirror({ value, selectionStart: value.length, selectionEnd: value.length }),
    ).toBe(false);
  });

  it('does NOT flag a partial selection (caret not at 0 or not at end)', () => {
    const value = 'some text here';
    expect(isSelectionMirror({ value, selectionStart: 0, selectionEnd: 4 })).toBe(false);
    expect(isSelectionMirror({ value, selectionStart: 5, selectionEnd: value.length })).toBe(false);
  });

  it('never flags an empty value (right-click with nothing selected)', () => {
    expect(isSelectionMirror({ value: '', selectionStart: 0, selectionEnd: 0 })).toBe(false);
  });

  it('treats null selection bounds as not-a-mirror', () => {
    // Defensive: some engines report null; without explicit full-select
    // info we must not suppress (better to forward than to swallow input).
    const value = 'abc';
    expect(isSelectionMirror({ value, selectionStart: null, selectionEnd: null })).toBe(false);
  });
});
