/**
 * transcript-prefill.test.ts
 *
 * Pins the «не могу прокрутить вверх» regression fix: the resumed-tile
 * transcript must be written whenever it loaded and the term is alive —
 * INDEPENDENT of whether the 3s safety gate already opened. The old code
 * suppressed the write once the gate opened, dropping the scrollback.
 */

import { describe, expect, it } from 'vitest';
import { shouldWriteTranscript } from './transcript-prefill.js';

describe('shouldWriteTranscript', () => {
  it('writes a non-empty transcript when the term is alive', () => {
    expect(shouldWriteTranscript({ transcript: '● old message\n❯ reply', termAlive: true })).toBe(
      true,
    );
  });

  it('REGRESSION: writes even when the gate already opened (slow IPC) — gate state is not an input', () => {
    // The whole point of the fix: the decision does NOT depend on the
    // prePtyGate. A late transcript (IPC stalled past 3s) is still written.
    expect(shouldWriteTranscript({ transcript: 'a real transcript', termAlive: true })).toBe(true);
  });

  it('does not write when the terminal was disposed mid-load', () => {
    expect(shouldWriteTranscript({ transcript: 'something', termAlive: false })).toBe(false);
  });

  it('does not write an empty or missing transcript', () => {
    expect(shouldWriteTranscript({ transcript: '', termAlive: true })).toBe(false);
    expect(shouldWriteTranscript({ transcript: null, termAlive: true })).toBe(false);
    expect(shouldWriteTranscript({ transcript: undefined, termAlive: true })).toBe(false);
  });
});
