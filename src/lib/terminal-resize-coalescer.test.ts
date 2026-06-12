/**
 * Tests for the PTY resize coalescer — the fix for "скомканная история":
 * Claude Code repaints the whole transcript on every PTY resize, and each
 * repaint pushes a stale copy into scrollback. Semantics under test:
 *  - leading edge: an isolated resize (tile open, single grid step) is
 *    delivered IMMEDIATELY — fresh tiles must not lag waiting for settle;
 *  - trailing edge: the rest of a burst delivers only the FINAL size;
 *  - max-wait heartbeat: a continuous drag still updates ~once a second;
 *  - dedupe: a size equal to the last delivered one is never re-sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResizeCoalescer } from './terminal-resize-coalescer.js';

describe('createResizeCoalescer', () => {
  let sent: Array<{ cols: number; rows: number }>;
  const send = (cols: number, rows: number) => sent.push({ cols, rows });
  const opts = { settleMs: 250, maxWaitMs: 1000 };

  beforeEach(() => {
    sent = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers an isolated resize immediately (leading edge)', () => {
    const c = createResizeCoalescer(send, opts);
    c.push(120, 30);
    expect(sent).toEqual([{ cols: 120, rows: 30 }]);
  });

  it('two isolated resizes separated by idle both deliver immediately', () => {
    const c = createResizeCoalescer(send, opts);
    c.push(120, 30);
    vi.advanceTimersByTime(500); // idle > settle
    c.push(100, 30);
    expect(sent).toEqual([
      { cols: 120, rows: 30 },
      { cols: 100, rows: 30 },
    ]);
  });

  it('a burst delivers the first size at once and then only the LAST', () => {
    const c = createResizeCoalescer(send, opts);
    for (let cols = 80; cols <= 87; cols++) {
      c.push(cols, 24);
      vi.advanceTimersByTime(50); // faster than settle — keeps debouncing
    }
    // Only the leading edge has fired so far (total burst < maxWait)
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([
      { cols: 80, rows: 24 },
      { cols: 87, rows: 24 },
    ]);
  });

  it('continuous drag still updates roughly every maxWait', () => {
    const c = createResizeCoalescer(send, opts);
    // 2.4s of nonstop resizing, a push every 100ms
    for (let i = 0; i < 24; i++) {
      c.push(80 + i, 24);
      vi.advanceTimersByTime(100);
    }
    // leading edge + maxWait heartbeats at ~1.1s and ~2.2s
    expect(sent.length).toBe(3);
    vi.advanceTimersByTime(250);
    expect(sent.length).toBe(4);
    expect(sent[3]).toEqual({ cols: 103, rows: 24 });
  });

  it('dedupes when the final size equals the last sent size', () => {
    const c = createResizeCoalescer(send, opts);
    c.push(100, 30); // leading edge
    expect(sent).toEqual([{ cols: 100, rows: 30 }]);
    // Drag out and back to the same size within the settle window
    c.push(140, 30);
    c.push(100, 30);
    vi.advanceTimersByTime(1500);
    expect(sent).toEqual([{ cols: 100, rows: 30 }]); // no repaint-triggering resend
  });

  it('flush() sends the queued size immediately', () => {
    const c = createResizeCoalescer(send, opts);
    c.push(90, 25); // leading edge
    c.push(91, 25); // queued
    c.flush();
    expect(sent).toEqual([
      { cols: 90, rows: 25 },
      { cols: 91, rows: 25 },
    ]);
    // and the settle timer does not double-send afterwards
    vi.advanceTimersByTime(2000);
    expect(sent.length).toBe(2);
  });

  it('dispose() cancels a queued size without sending', () => {
    const c = createResizeCoalescer(send, opts);
    c.push(90, 25); // leading edge
    c.push(91, 25); // queued
    c.dispose();
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([{ cols: 90, rows: 25 }]);
  });

  it('flush() with nothing pending is a no-op', () => {
    const c = createResizeCoalescer(send, opts);
    c.flush();
    expect(sent).toEqual([]);
  });
});
