import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerDrainControl,
  unregisterDrainControl,
  noteHeavyOutput,
  __setDrainSliceMsForTests,
  __resetDrainSchedulerForTests,
  __getDrainStateForTests,
} from './output-scheduler.js';

/**
 * Cross-terminal output-drain serialiser (5th branch-crash trigger: `/compact`
 * in two terminals at once). When several PTYs emit heavy output concurrently,
 * node-pty's per-PTY reader threads hammer conpty.node's allocator at the same
 * time → c0000374 heap corruption. We can't serialise those native threads, but
 * pause() backpressures a PTY's pipe so conpty.node stops reading it. The
 * scheduler grants a short "drain token" to ONE agent and pauses the rest,
 * round-robining the token so no two agents drain a burst simultaneously while
 * every terminal still makes progress.
 *
 * These tests pin the serialisation invariant with spy pause/resume controls and
 * fake timers — no node-pty, no real delay.
 */

function makeControl() {
  return { pause: vi.fn(), resume: vi.fn() };
}

describe('output-scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDrainSchedulerForTests();
    // Deterministic, OS-independent slice for assertions.
    __setDrainSliceMsForTests(20);
  });

  afterEach(() => {
    __resetDrainSchedulerForTests();
    vi.useRealTimers();
  });

  it('disabled (slice=0, the POSIX path): never pauses anyone', () => {
    __setDrainSliceMsForTests(0);
    const a = makeControl();
    const b = makeControl();
    registerDrainControl('a', a);
    registerDrainControl('b', b);

    noteHeavyOutput('a');
    noteHeavyOutput('b');
    noteHeavyOutput('a');

    expect(a.pause).not.toHaveBeenCalled();
    expect(b.pause).not.toHaveBeenCalled();
    expect(__getDrainStateForTests().holder).toBeNull();
  });

  it('first burster holds the token and is NOT paused; single terminal is untouched', () => {
    const a = makeControl();
    registerDrainControl('a', a);

    noteHeavyOutput('a');
    expect(__getDrainStateForTests().holder).toBe('a');
    expect(a.pause).not.toHaveBeenCalled();

    // Keep bursting alone → still never paused.
    noteHeavyOutput('a');
    noteHeavyOutput('a');
    expect(a.pause).not.toHaveBeenCalled();

    // Token frees once nobody else is waiting and the slice elapses.
    vi.advanceTimersByTime(20);
    expect(__getDrainStateForTests().holder).toBeNull();
    expect(a.resume).not.toHaveBeenCalled(); // never paused → never resumed
  });

  it('a second concurrent burster is paused, then resumed on the next slice (round-robin)', () => {
    const a = makeControl();
    const b = makeControl();
    registerDrainControl('a', a);
    registerDrainControl('b', b);

    noteHeavyOutput('a'); // a holds
    noteHeavyOutput('b'); // b bursts while a holds → b paused

    expect(b.pause).toHaveBeenCalledTimes(1);
    expect(a.pause).not.toHaveBeenCalled();
    expect(__getDrainStateForTests().holder).toBe('a');
    expect(__getDrainStateForTests().paused).toEqual(['b']);

    // Slice elapses → token rotates to b: b resumed and becomes holder.
    vi.advanceTimersByTime(20);
    expect(b.resume).toHaveBeenCalledTimes(1);
    expect(__getDrainStateForTests().holder).toBe('b');
    expect(__getDrainStateForTests().paused).toEqual([]);
  });

  it('idempotent: re-bursting a paused agent does not pause it twice; holder never pauses itself', () => {
    const a = makeControl();
    const b = makeControl();
    registerDrainControl('a', a);
    registerDrainControl('b', b);

    noteHeavyOutput('a');
    noteHeavyOutput('a'); // holder re-bursts
    noteHeavyOutput('b');
    noteHeavyOutput('b'); // already paused
    noteHeavyOutput('b');

    expect(a.pause).not.toHaveBeenCalled();
    expect(b.pause).toHaveBeenCalledTimes(1);
  });

  it('three concurrent bursters drain one at a time and ALL get resumed within bounded time', () => {
    const a = makeControl();
    const b = makeControl();
    const c = makeControl();
    registerDrainControl('a', a);
    registerDrainControl('b', b);
    registerDrainControl('c', c);

    noteHeavyOutput('a'); // a holds
    noteHeavyOutput('b'); // b paused
    noteHeavyOutput('c'); // c paused

    expect(__getDrainStateForTests().holder).toBe('a');
    expect(__getDrainStateForTests().paused).toEqual(['b', 'c']);

    vi.advanceTimersByTime(20); // a → b
    expect(b.resume).toHaveBeenCalledTimes(1);
    expect(__getDrainStateForTests().holder).toBe('b');

    vi.advanceTimersByTime(20); // b → c
    expect(c.resume).toHaveBeenCalledTimes(1);
    expect(__getDrainStateForTests().holder).toBe('c');

    vi.advanceTimersByTime(20); // c → free
    expect(__getDrainStateForTests().holder).toBeNull();

    // No agent is left paused — the core safety property.
    expect(__getDrainStateForTests().paused).toEqual([]);
    expect(a.resume).not.toHaveBeenCalled(); // a was holder, never paused
    expect(b.resume).toHaveBeenCalledTimes(1);
    expect(c.resume).toHaveBeenCalledTimes(1);
  });

  it('unregistering the holder frees the token and resumes the next waiter immediately', () => {
    const a = makeControl();
    const b = makeControl();
    registerDrainControl('a', a);
    registerDrainControl('b', b);

    noteHeavyOutput('a');
    noteHeavyOutput('b'); // b paused behind a

    unregisterDrainControl('a'); // a (holder) exits/killed

    expect(b.resume).toHaveBeenCalledTimes(1);
    expect(__getDrainStateForTests().holder).toBe('b');
    expect(__getDrainStateForTests().paused).toEqual([]);
  });

  it('unregistering a paused agent drops it WITHOUT calling resume on the dead pty', () => {
    const a = makeControl();
    const b = makeControl();
    registerDrainControl('a', a);
    registerDrainControl('b', b);

    noteHeavyOutput('a');
    noteHeavyOutput('b'); // b paused

    unregisterDrainControl('b'); // b exits while paused

    expect(b.resume).not.toHaveBeenCalled(); // never resume a removed/dead pty
    expect(__getDrainStateForTests().paused).toEqual([]);

    // Slice elapses → token frees cleanly, no throw, no stray resume.
    vi.advanceTimersByTime(20);
    expect(__getDrainStateForTests().holder).toBeNull();
  });

  it('noteHeavyOutput for an unregistered agent is a no-op (race: data after exit)', () => {
    expect(() => noteHeavyOutput('ghost')).not.toThrow();
    expect(__getDrainStateForTests().holder).toBeNull();
  });
});
