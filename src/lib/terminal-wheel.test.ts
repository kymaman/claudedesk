/**
 * terminal-wheel.test.ts
 *
 * Pins the «терминал не скролится» fix: in the normal buffer a wheel tick
 * must scroll whole lines and hijack the event (so mouse-tracking mode
 * can't swallow it), while Ctrl (zoom) and the alternate screen are left
 * untouched.
 */

import { describe, expect, it } from 'vitest';
import { planWheelScroll } from './terminal-wheel.js';

const base = { altScreen: false, ctrlKey: false, linesPerNotch: 3 };

describe('planWheelScroll', () => {
  it('REGRESSION: a wheel tick in the normal buffer scrolls whole lines and hijacks', () => {
    expect(planWheelScroll({ ...base, deltaY: 100 })).toEqual({ scrollLines: 3, hijack: true });
    expect(planWheelScroll({ ...base, deltaY: -100 })).toEqual({ scrollLines: -3, hijack: true });
  });

  it('moves exactly linesPerNotch regardless of delta magnitude (no skipping, no smoothing)', () => {
    expect(planWheelScroll({ ...base, deltaY: 4 }).scrollLines).toBe(3);
    expect(planWheelScroll({ ...base, deltaY: 9999 }).scrollLines).toBe(3);
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
