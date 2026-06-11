/**
 * terminal-wheel.test.ts
 *
 * Pins the «терминал не скролится» fix: in the normal buffer a wheel tick
 * scrolls WHOLE lines and hijacks the event (so mouse-tracking mode can't
 * swallow it). The step scales with spin strength but is always an integer
 * number of lines — no smoothing, no partial lines. Ctrl (zoom) and the
 * alternate screen are left untouched.
 */

import { describe, expect, it } from 'vitest';
import { planWheelScroll } from './terminal-wheel.js';

const base = { altScreen: false, ctrlKey: false, linesPerNotch: 3, deltaMode: 0 };

describe('planWheelScroll', () => {
  it('REGRESSION: a normal wheel notch in the normal buffer scrolls whole lines and hijacks', () => {
    // ~one notch ≈ 100px → 3 whole lines.
    expect(planWheelScroll({ ...base, deltaY: 100 })).toEqual({ scrollLines: 3, hijack: true });
    expect(planWheelScroll({ ...base, deltaY: -100 })).toEqual({ scrollLines: -3, hijack: true });
  });

  it('scales with spin strength but stays whole lines (a fast flick moves more)', () => {
    // 250px ≈ 2.5 notches × 3 = 7.5 → 8 whole lines. (Matches the e2e
    // scrollback regression test: 30 × ~8 ≥ 200 rows.)
    const plan = planWheelScroll({ ...base, deltaY: -250 });
    expect(plan.hijack).toBe(true);
    expect(Number.isInteger(plan.scrollLines)).toBe(true);
    expect(plan.scrollLines).toBe(-8);
  });

  it('a tiny delta still moves at least one whole line', () => {
    expect(planWheelScroll({ ...base, deltaY: 4 }).scrollLines).toBe(1);
    expect(planWheelScroll({ ...base, deltaY: -4 }).scrollLines).toBe(-1);
  });

  it('honours line-mode wheel events (deltaMode 1)', () => {
    // 3 lines reported ≈ one notch → 3 whole lines.
    expect(planWheelScroll({ ...base, deltaMode: 1, deltaY: 3 }).scrollLines).toBe(3);
  });

  it('hands off to the zoom gesture when Ctrl is held', () => {
    expect(planWheelScroll({ ...base, deltaY: 100, ctrlKey: true })).toEqual({
      scrollLines: 0,
      hijack: false,
    });
  });

  it('does not hijack the alternate screen (vim/less own the wheel)', () => {
    expect(planWheelScroll({ ...base, deltaY: 100, altScreen: true })).toEqual({
      scrollLines: 0,
      hijack: false,
    });
  });

  it('ignores a zero delta', () => {
    expect(planWheelScroll({ ...base, deltaY: 0 })).toEqual({ scrollLines: 0, hijack: false });
  });
});
