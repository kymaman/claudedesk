/**
 * injected-text.test.ts
 *
 * Pins the delivery decision for textarea-polled injected text. The
 * critical invariant: MULTI-LINE injected text must be classified as
 * 'paste' (→ bracketed paste), never 'type' (→ raw enqueue). Raw
 * multi-line delivery is what caused the "paste erases previous
 * block" bug — embedded newlines reached claude as Enter keypresses,
 * submitting the first line and wiping the rest.
 */

import { describe, it, expect } from 'vitest';
import { classifyInjectedText } from './injected-text';

describe('classifyInjectedText', () => {
  it('ignores empty and single-char residue (xterm leftover)', () => {
    expect(classifyInjectedText('')).toBe('ignore');
    expect(classifyInjectedText('a')).toBe('ignore');
    expect(classifyInjectedText(' ')).toBe('ignore');
  });

  it('types single-line dictation raw', () => {
    expect(classifyInjectedText('привет как дела')).toBe('type');
    expect(classifyInjectedText('hello world')).toBe('type');
    expect(classifyInjectedText('ab')).toBe('type');
  });

  it('PASTES multi-line text (the erase-bug guard)', () => {
    // The exact shape that broke: a multi-line block injected into the
    // textarea. If this returns anything but 'paste', raw newlines hit
    // claude as Enter and the previous block is wiped.
    expect(classifyInjectedText('first line\nsecond line')).toBe('paste');
    expect(classifyInjectedText('a\r\nb')).toBe('paste');
    expect(classifyInjectedText('line1\rline2')).toBe('paste');
  });

  it('treats a large single-line block as type (no newline → safe raw)', () => {
    // A 5KB single-line block has no Enter, so raw delivery can't
    // prematurely submit. Only newline content needs bracketing.
    const big = 'x'.repeat(5_000);
    expect(classifyInjectedText(big)).toBe('type');
  });

  it('classifies a multi-line block that ends with a trailing newline as paste', () => {
    expect(classifyInjectedText('block of text\nwith two lines\n')).toBe('paste');
  });
});
