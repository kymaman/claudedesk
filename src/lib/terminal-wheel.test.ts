/**
 * terminal-wheel.test.ts
 *
 * Pins the wheel-scroll policy. Two distinct cases (proven by e2e):
 *  - claude TUI: no xterm scrollback, no mouse tracking → translate the wheel
 *    into PageUp/PageDown for the PTY (claude scrolls its own transcript).
 *  - plain shell: scroll xterm's own scrollback by WHOLE lines, scaled by
 *    spin strength, hijacking the event. Ctrl (zoom) and the alternate screen
 *    are left untouched.
 */

import { describe, expect, it } from 'vitest';
import { planWheelScroll, PAGE_UP, PAGE_DOWN } from './terminal-wheel.js';

const shell = {
  altScreen: false,
  claudeTui: false,
  ctrlKey: false,
  linesPerNotch: 3,
  deltaMode: 0,
};
const claude = { ...shell, claudeTui: true };

describe('planWheelScroll — plain shell (xterm scrollback)', () => {
  it('REGRESSION: a normal wheel notch scrolls whole lines via scrollback', () => {
    expect(planWheelScroll({ ...shell, deltaY: 100 })).toEqual({
      action: 'scrollback',
      scrollLines: 3,
    });
    expect(planWheelScroll({ ...shell, deltaY: -100 })).toEqual({
      action: 'scrollback',
      scrollLines: -3,
    });
  });

  it('scales with spin strength but stays whole lines', () => {
    const plan = planWheelScroll({ ...shell, deltaY: -250 });
    if (plan.action !== 'scrollback') throw new Error('expected scrollback');
    expect(Number.isInteger(plan.scrollLines)).toBe(true);
    expect(plan.scrollLines).toBe(-8);
  });

  it('a tiny delta still moves at least one whole line', () => {
    expect(planWheelScroll({ ...shell, deltaY: 4 })).toEqual({
      action: 'scrollback',
      scrollLines: 1,
    });
    expect(planWheelScroll({ ...shell, deltaY: -4 })).toEqual({
      action: 'scrollback',
      scrollLines: -1,
    });
  });

  it('honours line-mode wheel events (deltaMode 1)', () => {
    expect(planWheelScroll({ ...shell, deltaMode: 1, deltaY: 3 })).toEqual({
      action: 'scrollback',
      scrollLines: 3,
    });
  });
});

describe('planWheelScroll — claude TUI (PageUp/PageDown to PTY)', () => {
  it('REGRESSION (the fix): wheel UP sends PageUp to the PTY, not scrollback', () => {
    expect(planWheelScroll({ ...claude, deltaY: -100 })).toEqual({
      action: 'ptyKeys',
      data: PAGE_UP,
    });
  });

  it('wheel DOWN sends PageDown', () => {
    expect(planWheelScroll({ ...claude, deltaY: 100 })).toEqual({
      action: 'ptyKeys',
      data: PAGE_DOWN,
    });
  });

  it('a hard flick sends multiple pages (one page per notch, min one)', () => {
    // 250px ≈ 2.5 notches → round → 3 pages up.
    expect(planWheelScroll({ ...claude, deltaY: -250 })).toEqual({
      action: 'ptyKeys',
      data: PAGE_UP.repeat(3),
    });
    // A tiny nudge still pages once.
    expect(planWheelScroll({ ...claude, deltaY: -4 })).toEqual({
      action: 'ptyKeys',
      data: PAGE_UP,
    });
  });
});

describe('planWheelScroll — hand-off cases', () => {
  it('hands off to the zoom gesture when Ctrl is held (even for claude)', () => {
    expect(planWheelScroll({ ...claude, deltaY: 100, ctrlKey: true })).toEqual({
      action: 'ignore',
    });
    expect(planWheelScroll({ ...shell, deltaY: 100, ctrlKey: true })).toEqual({ action: 'ignore' });
  });

  it('does not touch the alternate screen (vim/less own the wheel)', () => {
    expect(planWheelScroll({ ...claude, deltaY: 100, altScreen: true })).toEqual({
      action: 'ignore',
    });
    expect(planWheelScroll({ ...shell, deltaY: 100, altScreen: true })).toEqual({
      action: 'ignore',
    });
  });

  it('ignores a zero delta', () => {
    expect(planWheelScroll({ ...claude, deltaY: 0 })).toEqual({ action: 'ignore' });
    expect(planWheelScroll({ ...shell, deltaY: 0 })).toEqual({ action: 'ignore' });
  });
});
