/**
 * agent-output-analyzer.test.ts
 *
 * Pure unit tests for the analyzer functions extracted from
 * src/store/taskStatus.ts during Phase-2 B2. The taskStatus.test.ts
 * suite already exercises these functions transitively (since taskStatus
 * re-exports them); this file targets them directly with no SolidJS or
 * store mocking, so they can be reasoned about as plain functions.
 *
 * Each case is cherry-picked from a representative scenario in the
 * existing taskStatus suite so a regression in the pure layer fires here
 * before bubbling into the store-coupled tests.
 */

import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  normalizeForComparison,
  looksLikeQuestion,
  isTrustQuestionAutoHandled,
} from './agent-output-analyzer';

describe('stripAnsi', () => {
  it('removes CSI sequences without altering visible text', () => {
    const input = '\x1b[31mhello\x1b[0m world';
    expect(stripAnsi(input)).toBe('hello world');
  });

  it('removes OSC sequences (e.g. window-title escape)', () => {
    const input = '\x1b]0;my title\x07prompt$ ';
    expect(stripAnsi(input)).toBe('prompt$ ');
  });

  it('returns the original string when no escapes are present', () => {
    expect(stripAnsi('plain text — with em dash')).toBe('plain text — with em dash');
  });
});

describe('normalizeForComparison', () => {
  it('strips ANSI + control chars (including \\t/\\n) THEN collapses spaces', () => {
    // \t and \n are control chars (0x00-0x1f) so they're removed before the
    // whitespace-collapse pass — Hello\tworld therefore becomes "Helloworld".
    const input = '\x1b[2J\x1b[H  Hello world\x07  more  text  ';
    expect(normalizeForComparison(input)).toBe('Hello world more text');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeForComparison('   \t\n  ')).toBe('');
  });
});

describe('looksLikeQuestion', () => {
  it('detects a Y/n confirmation prompt at end of buffer', () => {
    const tail = 'About to delete five files [Y/n] ';
    expect(looksLikeQuestion(tail)).toBe(true);
  });

  it('returns false when the agent is sitting at a bare ❯ main prompt', () => {
    // Last line is a bare ❯ — earlier question text is stale.
    const tail = 'Do you want to proceed?\nyes / no\n❯ ';
    expect(looksLikeQuestion(tail)).toBe(false);
  });

  it('detects a TUI trust dialog by raw-text fast path', () => {
    const tail = 'Confirm folder trust\nDo you trust the files in this folder?';
    expect(looksLikeQuestion(tail)).toBe(true);
  });

  it('returns false for plain output with no prompts', () => {
    const tail = 'Building project... done in 4.2s\nNo errors.';
    expect(looksLikeQuestion(tail)).toBe(false);
  });
});

describe('isTrustQuestionAutoHandled', () => {
  it('returns false when autoTrustEnabled=false even on a clear trust dialog', () => {
    const tail = 'Confirm folder trust\nDo you trust this folder?';
    expect(isTrustQuestionAutoHandled(tail, false)).toBe(false);
  });

  it('returns true for a pure trust dialog with autoTrustEnabled=true', () => {
    const tail = 'Confirm folder trust\nDo you trust the files in this folder?';
    expect(isTrustQuestionAutoHandled(tail, true)).toBe(true);
  });

  it('rejects auto-handle when an exclusion keyword (delete) is present', () => {
    // Trust pattern + dangerous keyword — must not be silently accepted.
    const tail = 'Confirm folder trust\nDo you trust this folder? It will delete files.\n[Y/n] ';
    expect(isTrustQuestionAutoHandled(tail, true)).toBe(false);
  });

  it('rejects auto-handle when an unrelated [Y/n] question is mixed in', () => {
    // Trust pattern present, but a non-trust [Y/n] question is also asked —
    // user must answer manually so the non-trust question isn't auto-yessed.
    const tail = 'trust this folder?\nOverwrite local changes? [Y/n] ';
    expect(isTrustQuestionAutoHandled(tail, true)).toBe(false);
  });
});
