/**
 * terminal-wheel.ts — wheel-to-scroll policy for the xterm terminal.
 *
 * ROOT CAUSE (2026-06-18, proven by e2e diagnostics — «не могу прокрутить
 * вверх в claude»):
 *   - claude runs in the NORMAL buffer and repaints its whole conversation
 *     in place, so xterm's own scrollback stays EMPTY (baseY=0) — there is
 *     nothing above for the wheel to reach.
 *   - claude does NOT enable mouse tracking (mouseTrackingMode stayed 'none'
 *     across every sample), so xterm can never forward the wheel to claude
 *     as a mouse event.
 *   - claude DOES scroll its transcript on PageUp / PageDown (verified: the
 *     view scrolled to earlier messages and PageDown restored it exactly).
 *
 * So for a claude terminal the ONLY thing that scrolls is sending PageUp /
 * PageDown to the PTY. The previous hijack here scrolled xterm's always-empty
 * scrollback and ate the wheel — nothing moved. The fix: for a claude TUI,
 * translate each wheel notch into PageUp/PageDown and send it to the PTY.
 * For a plain shell (which fills xterm's own scrollback) we keep the old
 * whole-line, nothing-skipped scrollback scrolling.
 *
 * Pure / DOM-free so it unit-tests cleanly (the caller performs the side
 * effect — scrollLines for a shell, or writing the keys to the PTY).
 */

/** WheelEvent.deltaMode values (PIXEL = 0 is the default / fallthrough). */
const DELTA_MODE_LINE = 1;
const DELTA_MODE_PAGE = 2;

/** Roughly how much one physical wheel notch reports, per delta mode. */
const PIXELS_PER_NOTCH = 100; // Chromium on Windows reports ~100–120px/notch
const LINES_PER_NOTCH_DELTA = 3; // line-mode events report ~3 lines/notch

/** Keys claude scrolls its transcript by (verified empirically). */
export const PAGE_UP = '\x1b[5~';
export const PAGE_DOWN = '\x1b[6~';

export interface WheelInput {
  /** WheelEvent.deltaY. */
  deltaY: number;
  /** WheelEvent.deltaMode (0 pixel, 1 line, 2 page). */
  deltaMode: number;
  /** true while the alternate screen buffer is active (vim/less/etc.). */
  altScreen: boolean;
  /** true for a claude TUI terminal: it has no usable xterm scrollback and
   *  no mouse tracking, but scrolls its transcript on PageUp/PageDown. When
   *  set we translate the wheel into those keys for the PTY. */
  claudeTui: boolean;
  /** Ctrl held = zoom gesture; leave it for the global zoom handler. */
  ctrlKey: boolean;
  /** Whole lines to move per ~one wheel notch (shell scrollback case). */
  linesPerNotch: number;
}

export type WheelPlan =
  /** Let the event bubble untouched (zoom, alternate screen). */
  | { action: 'ignore' }
  /** Caller scrolls xterm's own scrollback by this many whole lines (negative
   *  = up) and stops the event. For plain shells. */
  | { action: 'scrollback'; scrollLines: number }
  /** Caller writes this string to the PTY (PageUp/PageDown sequences) and
   *  stops the event. For claude terminals. */
  | { action: 'ptyKeys'; data: string };

const IGNORE: WheelPlan = { action: 'ignore' };

/** How many wheel "notches" this event represents (can be fractional). */
function notchesOf(deltaY: number, deltaMode: number): number {
  if (deltaMode === DELTA_MODE_LINE) return deltaY / LINES_PER_NOTCH_DELTA;
  if (deltaMode === DELTA_MODE_PAGE) return deltaY; // 1 page ≈ 1 notch
  return deltaY / PIXELS_PER_NOTCH; // DELTA_MODE_PIXEL (default)
}

/**
 * Decide what a wheel tick over the terminal should do.
 * - Ctrl+wheel → ignore (zoom).
 * - alternate screen → ignore (the full-screen app owns the wheel).
 * - claude TUI → translate to PageUp/PageDown for the PTY (claude scrolls
 *   its own transcript on those keys; it has no xterm scrollback to move).
 * - otherwise (a plain shell) → scroll a whole number of xterm scrollback
 *   lines (scaled by spin strength, at least one line).
 */
export function planWheelScroll(input: WheelInput): WheelPlan {
  if (input.ctrlKey || input.altScreen) return IGNORE;
  if (input.deltaY === 0) return IGNORE;

  const notches = notchesOf(input.deltaY, input.deltaMode);
  const dir = notches > 0 ? 1 : -1; // +1 = wheel down (toward newest), -1 = up

  if (input.claudeTui) {
    // One page per notch, scaled by spin strength, at least one page.
    const pages = Math.max(1, Math.round(Math.abs(notches)));
    const key = dir < 0 ? PAGE_UP : PAGE_DOWN;
    return { action: 'ptyKeys', data: key.repeat(pages) };
  }

  const lines = Math.max(1, Math.round(Math.abs(notches) * input.linesPerNotch));
  return { action: 'scrollback', scrollLines: dir * lines };
}
