/**
 * terminal-resize-coalescer.ts
 *
 * Coalesces xterm resize events before they reach the PTY.
 *
 * Why this exists: Claude Code's TUI re-renders the visible transcript on
 * EVERY terminal resize. The previous frame doesn't disappear — it scrolls
 * up into xterm's scrollback. With the old 33 ms flush, a tile drag-resize
 * (or a grid reflow when any tile opens/closes) streamed every intermediate
 * size to claude, and each one deposited a stale copy of the transcript
 * into scrollback at that width. Over a long session the history filled
 * with duplicated paragraphs wrapped at different widths — the "скомканная
 * история" the user reported.
 *
 * Strategy: leading edge when idle (a lone resize — tile open, grid step —
 * reaches the PTY instantly, so freshly-opened tiles size up without lag),
 * then trailing-edge settle debounce for the rest of the burst (the PTY
 * only hears the FINAL size of a drag) plus a max-wait cap so a
 * *continuous* drag still updates claude about once a second.
 */

export interface ResizeCoalescerOptions {
  /** Quiet period after the last resize before the size is sent. */
  settleMs?: number;
  /** Upper bound: send the freshest pending size at least this often
   *  during a continuous resize, so the TUI doesn't look frozen. */
  maxWaitMs?: number;
}

export interface ResizeCoalescer {
  /** Record a new candidate size (called from term.onResize). */
  push(cols: number, rows: number): void;
  /** Send the pending size immediately (e.g. on unmount, so a PTY that
   *  outlives the tile keeps the final correct dimensions). */
  flush(): void;
  /** Cancel timers without sending. */
  dispose(): void;
  /** Test/diagnostic hook: dims last delivered to the sender. */
  readonly lastSent: { cols: number; rows: number } | null;
}

const DEFAULT_SETTLE_MS = 250;
const DEFAULT_MAX_WAIT_MS = 1000;

export function createResizeCoalescer(
  send: (cols: number, rows: number) => void,
  options: ResizeCoalescerOptions = {},
): ResizeCoalescer {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  let pending: { cols: number; rows: number } | null = null;
  let lastSent: { cols: number; rows: number } | null = null;
  let lastSendAt = -Infinity;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimers(): void {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    if (maxWaitTimer !== undefined) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = undefined;
    }
  }

  function deliver(): void {
    clearTimers();
    if (!pending) return;
    const { cols, rows } = pending;
    pending = null;
    lastSendAt = Date.now();
    // Dedupe: dragging out and back to the same size must not repaint.
    if (lastSent && lastSent.cols === cols && lastSent.rows === rows) return;
    lastSent = { cols, rows };
    send(cols, rows);
  }

  return {
    push(cols: number, rows: number): void {
      pending = { cols, rows };
      // Leading edge: an isolated resize (no burst in flight, nothing sent
      // recently) goes out immediately — a freshly-opened tile must not
      // wait out the settle period to get its real size.
      if (
        settleTimer === undefined &&
        maxWaitTimer === undefined &&
        Date.now() - lastSendAt >= settleMs
      ) {
        deliver();
        return;
      }
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(deliver, settleMs);
      // Max-wait starts on the FIRST queued push of a burst and is not
      // reset by subsequent pushes — that's what caps the latency of a
      // long drag.
      if (maxWaitTimer === undefined) {
        maxWaitTimer = setTimeout(deliver, maxWaitMs);
      }
    },
    flush(): void {
      deliver();
    },
    dispose(): void {
      clearTimers();
      pending = null;
    },
    get lastSent() {
      return lastSent;
    },
  };
}
