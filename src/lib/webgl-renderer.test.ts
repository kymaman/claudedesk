/**
 * webgl-renderer.test.ts
 *
 * Pins the fix for the "каша" (stale-frame overlap) bug: when the WebGL
 * context is lost after the machine idles, the renderer must NOT leave a dead
 * GPU frame on screen. It must recreate the WebGL renderer (preferred) or,
 * failing that, force a full term.refresh() so the DOM renderer repaints the
 * whole viewport.
 */
import { describe, it, expect } from 'vitest';
import {
  attachSelfHealingWebgl,
  type RefreshableTerminal,
  type DisposableWebglAddon,
} from './webgl-renderer.js';

/** Fake WebglAddon: captures its onContextLoss callback so the test can fire
 *  a "GPU went to sleep" event on demand — never synchronously during wiring
 *  (a real GPU loss is always an async event after the addon is live). */
class FakeAddon implements DisposableWebglAddon {
  lossCb: (() => void) | undefined;
  disposed = false;
  onContextLoss(cb: () => void): void {
    this.lossCb = cb;
  }
  dispose(): void {
    this.disposed = true;
  }
  /** Simulate Chromium dropping the WebGL context. */
  loseContext(): void {
    this.lossCb?.();
  }
}

function fakeTerm(): RefreshableTerminal & { refreshCalls: number } {
  return {
    rows: 24,
    refreshCalls: 0,
    loadAddon(): void {
      /* no-op */
    },
    refresh(): void {
      this.refreshCalls++;
    },
  };
}

// Synchronous scheduler so the recreate runs inline (no rAF in Node).
const syncSchedule = (cb: () => void): void => cb();

describe('attachSelfHealingWebgl', () => {
  it('attaches a WebGL addon on creation', () => {
    const term = fakeTerm();
    const addon = new FakeAddon();
    const handle = attachSelfHealingWebgl(term, () => addon, { schedule: syncSchedule });
    expect(handle.current()).toBe(addon);
    expect(handle.retries()).toBe(0);
  });

  it('recreates the renderer when the context is lost (GPU wakes back up)', () => {
    const term = fakeTerm();
    const made: FakeAddon[] = [];
    const handle = attachSelfHealingWebgl(
      term,
      () => {
        const a = new FakeAddon();
        made.push(a);
        return a;
      },
      { schedule: syncSchedule },
    );
    const first = made[0];
    // Machine idled → context lost.
    first.loseContext();
    // Dead addon disposed, a fresh one created and now active.
    expect(first.disposed).toBe(true);
    expect(made.length).toBe(2);
    expect(handle.current()).toBe(made[1]);
    expect(handle.retries()).toBe(1);
  });

  it('forces a repaint (kills "каша") when recreation fails → DOM fallback', () => {
    const term = fakeTerm();
    const made: FakeAddon[] = [];
    let failRecreate = false;
    const handle = attachSelfHealingWebgl(
      term,
      () => {
        if (failRecreate) throw new Error('no webgl2'); // context permanently gone
        const a = new FakeAddon();
        made.push(a);
        return a;
      },
      { schedule: syncSchedule, maxRetries: 3 },
    );
    expect(handle.current()).toBe(made[0]); // first addon active
    // Now the GPU dies for good: every recreate attempt throws.
    failRecreate = true;
    made[0].loseContext();
    // Fell back to DOM (no live addon) and forced a repaint to clear the
    // frozen frame — this is what removes the "каша".
    expect(handle.current()).toBeUndefined();
    expect(term.refreshCalls).toBeGreaterThan(0);
    expect(handle.retries()).toBe(1); // one attempt, it threw → stop, no spin
  });

  it('stops retrying after maxRetries consecutive losses and repaints', () => {
    const term = fakeTerm();
    // Every addon loses its context on the very next loseContext() the test
    // fires. We drive repeated losses to exhaust maxRetries.
    const made: FakeAddon[] = [];
    const handle = attachSelfHealingWebgl(
      term,
      () => {
        const a = new FakeAddon();
        made.push(a);
        return a;
      },
      { schedule: syncSchedule, maxRetries: 3 },
    );
    // Lose context repeatedly; each loss recreates until the cap is hit.
    // Drive the loss through the concrete fake (current() is typed to the
    // narrow interface, which has no loseContext).
    for (let i = 0; i < 5; i++) {
      if (!handle.current()) break;
      made[made.length - 1].loseContext();
    }
    // Bounded by maxRetries.
    expect(handle.retries()).toBe(3);
    expect(term.refreshCalls).toBeGreaterThan(0);
  });

  it('falls back to DOM + repaint when WebGL2 is unsupported from the start', () => {
    const term = fakeTerm();
    const handle = attachSelfHealingWebgl(
      term,
      () => {
        throw new Error('WebGL2 not supported');
      },
      { schedule: syncSchedule },
    );
    expect(handle.current()).toBeUndefined();
    expect(term.refreshCalls).toBe(1);
  });

  it('dispose() tears down the live addon and stops healing', () => {
    const term = fakeTerm();
    const addon = new FakeAddon();
    const handle = attachSelfHealingWebgl(term, () => addon, { schedule: syncSchedule });
    handle.dispose();
    expect(addon.disposed).toBe(true);
    expect(handle.current()).toBeUndefined();
    // A late context-loss event after dispose must be a no-op (no recreate).
    const before = term.refreshCalls;
    addon.loseContext();
    expect(term.refreshCalls).toBe(before);
  });
});
