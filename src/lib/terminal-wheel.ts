/**
 * terminal-wheel.ts — wheel-to-scroll policy for the xterm terminal.
 *
 * The bug («терминал Cd кода не скролится»): Claude Code's TUI runs in the
 * NORMAL buffer but turns on mouse tracking, so xterm forwards wheel ticks
 * to the app as mouse events instead of scrolling its own scrollback — you
 * can't scroll up to re-read code. Stripping claude's escape sequences was
 * tried before and reverted (it garbled the TUI). Instead we take the wheel
 * over in the renderer, never touching claude's stream.
 *
 * Behaviour the owner asked for: NO smooth animation — every tick moves
 * WHOLE lines so nothing is half-shown or "skipped" by a blur. The amount
 * scales with how hard the wheel is spun (a gentle notch nudges a few
 * lines, a fast flick moves more), always quantised to whole lines.
 *
 * Pure / DOM-free so it unit-tests cleanly.
 */

/** WheelEvent.deltaMode values (PIXEL = 0 is the default / fallthrough). */
const DELTA_MODE_LINE = 1;
const DELTA_MODE_PAGE = 2;

/** Roughly how much one physical wheel notch reports, per delta mode. */
const PIXELS_PER_NOTCH = 100; // Chromium on Windows reports ~100–120px/notch
const LINES_PER_NOTCH_DELTA = 3; // line-mode events report ~3 lines/notch

export interface WheelInput {
  /** WheelEvent.deltaY. */
  deltaY: number;
  /** WheelEvent.deltaMode (0 pixel, 1 line, 2 page). */
  deltaMode: number;
  /** true while the alternate screen buffer is active (vim/less/etc.). */
  altScreen: boolean;
  /** Ctrl held = zoom gesture; leave it for the global zoom handler. */
  ctrlKey: boolean;
  /** Whole lines to move per ~one wheel notch. */
  linesPerNotch: number;
}

export interface WheelPlan {
  /** Whole lines to scroll (negative = up / back in history). */
  scrollLines: number;
  /** When true the caller scrolls xterm itself and stops the event so it
   *  is NOT also forwarded to the app as a mouse-wheel event. */
  hijack: boolean;
}

const NO_OP: WheelPlan = { scrollLines: 0, hijack: false };

/** How many wheel "notches" this event represents (can be fractional). */
function notchesOf(deltaY: number, deltaMode: number): number {
  if (deltaMode === DELTA_MODE_LINE) return deltaY / LINES_PER_NOTCH_DELTA;
  if (deltaMode === DELTA_MODE_PAGE) return deltaY; // 1 page ≈ 1 notch
  return deltaY / PIXELS_PER_NOTCH; // DELTA_MODE_PIXEL (default)
}

/**
 * Decide what a wheel tick over the terminal should do.
 * - Ctrl+wheel → hands off (zoom).
 * - alternate screen → hands off (the full-screen app owns the wheel).
 * - otherwise → scroll a whole number of lines (scaled by spin strength,
 *   at least one line) and hijack the event so mouse-tracking mode can't
 *   swallow it.
 */
export function planWheelScroll(input: WheelInput): WheelPlan {
  if (input.ctrlKey || input.altScreen) return NO_OP;
  if (input.deltaY === 0) return NO_OP;
  const notches = notchesOf(input.deltaY, input.deltaMode);
  const dir = notches > 0 ? 1 : -1;
  const lines = Math.max(1, Math.round(Math.abs(notches) * input.linesPerNotch));
  return { scrollLines: dir * lines, hijack: true };
}
