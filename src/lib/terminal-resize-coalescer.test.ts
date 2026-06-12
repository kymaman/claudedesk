/**
 * Tests for the PTY resize coalescer — the fix for "скомканная история":
 * Claude Code repaints the whole transcript on every PTY resize, and each
 * repaint pushes a stale copy into scrollback. The coalescer must therefore
 * deliver ONLY the final size of a resize interaction (plus a ~1s heartbeat
 * during continuous drags), never the intermediate stream.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResizeCoalescer } from './terminal-resize-coalescer.js';

describe('createResizeCoalescer', () => {
  let sent: Array<{ cols: number; rows: number }>;
  const send = (cols: number, rows: number) => sent.push({ cols, rows });

  beforeEach(() => {
    sent = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a single size after the settle period', () => {
    const c = createResizeCoalescer(send, { settleMs: 250, maxWaitMs: 1000 });
    c.push(120, 30);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(249);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ cols: 120, rows: 30 }]);
  });

  it('a burst of intermediate sizes delivers only the LAST one', () => {
    const c = createResizeCoalescer(send, { settleMs: 250, maxWaitMs: 1000 });
    for (let cols = 80; cols <= 87; cols++) {
      c.push(cols, 24);
      vi.advanceTimersByTime(50); // faster than settle — keeps debouncing
    }
    expect(sent).toEqual([]); // nothing leaked mid-burst (< maxWait total)
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ cols: 87, rows: 24 }]);
  });

  it('continuous drag still updates roughly every maxWait', () => {
    const c = createResizeCoalescer(send, { settleMs: 250, maxWaitMs: 1000 });
    // 2.4s of nonstop resizing, a push every 100ms
    for (let i = 0; i < 24; i++) {
      c.push(80 + i, 24);
      vi.advanceTimersByTime(100);
    }
    // maxWait fired at ~1s and ~2s → exactly two intermediate deliveries
    expect(sent.length).toBe(2);
    vi.advanceTimersByTime(250);
    expect(sent.length).toBe(3);
    expect(sent[2]).toEqual({ cols: 103, rows: 24 });
  });

  it('dedupes when the final size equals the last sent size', () => {
    const c = createResizeCoalescer(send, { settleMs: 250, maxWaitMs: 1000 });
    c.push(100, 30);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ cols: 100, rows: 30 }]);
    // Drag out and back to the same size
    c.push(140, 30);
    c.push(100, 30);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ cols: 100, rows: 30 }]); // no repaint-triggering resend
  });

  it('flush() sends the pending size immediately', () => {
    const c = createResizeCoalescer(send, { settleMs: 250, maxWaitMs: 1000 });
    c.push(90, 25);
    c.flush();
    expect(sent).toEqual([{ cols: 90, rows: 25 }]);
    // and the settle timer does not double-send afterwards
    vi.advanceTimersByTime(2000);
    expect(sent.length).toBe(1);
  });

  it('dispose() cancels without sending', () => {
    const c = createResizeCoalescer(send, { settleMs: 250, maxWaitMs: 1000 });
    c.push(90, 25);
    c.dispose();
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([]);
  });

  it('flush() with nothing pending is a no-op', () => {
    const c = createResizeCoalescer(send, { settleMs: 250, maxWaitMs: 1000 });
    c.flush();
    expect(sent).toEqual([]);
  });
});
