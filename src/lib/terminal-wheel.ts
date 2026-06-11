/**
 * terminal-wheel.ts — wheel-to-scroll policy for the xterm terminal.
 *
 * The bug («терминал Cd кода не скролится»): Claude Code's TUI runs in the
 * NORMAL buffer but turns on mouse tracking, so xterm forwards wheel ticks
 * to the app as mouse events instead of scrolling its own scrollback — you
 * can't scroll up to re-read code. Stripping claude's escape sequences was
 * tried before and reverted (it garbled the TUI). Instead we take the wheel
 * over ourselves in the renderer, never touching claude's stream.
 *
 * Behaviour the owner asked for: NO smooth animation, every wheel notch
 * moves a fixed number of WHOLE lines so nothing is skipped or half-shown.
 *
 * This module is the pure decision — DOM-free so it unit-tests cleanly.
 */

export interface WheelInput {
  /** WheelEvent.deltaY — sign gives the direction, magnitude is ignored. */
  deltaY: number;
  /** true while the alternate screen buffer is active (vim/less/etc.). */
  altScreen: boolean;
  /** Ctrl held = zoom gesture; leave it for the global zoom handler. */
  ctrlKey: boolean;
  /** Whole lines to move per wheel notch. */
  linesPerNotch: number;
}

export interface WheelPlan {
  /** Lines to scroll (negative = up / back in history, positive = down). */
  scrollLines: number;
  /** When true the caller scrolls xterm itself and stops the event so it
   *  is NOT also forwarded to the app as a mouse-wheel event. */
  hijack: boolean;
}

const NO_OP: WheelPlan = { scrollLines: 0, hijack: false };

/**
 * Decide what a wheel tick over the terminal should do.
 * - Ctrl+wheel → hands off (zoom).
 * - alternate screen → hands off (the full-screen app owns the wheel).
 * - otherwise → scroll a fixed number of whole lines and hijack the event
 *   so mouse-tracking mode can't swallow it.
 */
export function planWheelScroll(input: WheelInput): WheelPlan {
  if (input.ctrlKey || input.altScreen) return NO_OP;
  if (input.deltaY === 0) return NO_OP;
  const dir = input.deltaY > 0 ? 1 : -1;
  return { scrollLines: dir * input.linesPerNotch, hijack: true };
}
