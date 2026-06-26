/**
 * webgl-renderer.ts
 *
 * Self-healing WebGL renderer attachment for xterm terminals.
 *
 * Why this exists — the "каша" (stale-frame overlap) bug:
 * xterm's plain WebglAddon paints the terminal on the GPU (fast). When the
 * machine sits idle the GPU powers down; Chromium/Electron then DROPS the
 * WebGL context and fires `onContextLoss`. The old code merely disposed the
 * addon — but disposing does NOT repaint, so the dead <canvas> kept showing
 * its last frame while fresh output painted via the DOM renderer ON TOP of
 * it. The user saw new text mixed with a frozen old frame ("каша"), and it
 * appeared specifically after the computer had been idle.
 *
 * This wrapper, on context loss:
 *   1. disposes the dead addon,
 *   2. tries to RECREATE a fresh WebGL renderer (the context is normally back
 *      after wake — keeps the terminal fast instead of falling to slow DOM
 *      forever, which was the separate "rendering suffers" complaint),
 *   3. after `maxRetries` consecutive failures gives up and stays on the DOM
 *      renderer,
 *   4. in every fallback path forces a full `term.refresh()` so no stale GPU
 *      frame is left on screen.
 *
 * The xterm types are narrowed to the tiny surface we touch so this module is
 * trivially unit-testable with fakes (real WebGL can't run in jsdom/Node).
 */

/** The slice of xterm's Terminal this module uses. */
export interface RefreshableTerminal {
  loadAddon(addon: unknown): void;
  refresh(start: number, end: number): void;
  readonly rows: number;
}

/** The slice of WebglAddon this module uses. */
export interface DisposableWebglAddon {
  onContextLoss(cb: () => void): void;
  dispose(): void;
}

export interface WebglRendererHandle {
  /** The live addon, or undefined when running on the DOM fallback. */
  current(): DisposableWebglAddon | undefined;
  /** Number of times the context was lost and a recreate was attempted. */
  retries(): number;
  /** Tear down — call from the terminal's onCleanup. */
  dispose(): void;
}

export interface AttachOptions {
  /** Max consecutive recreate attempts before staying on DOM. Default 3. */
  maxRetries?: number;
  /** Defer the recreate (real code uses requestAnimationFrame so the dropped
   *  context has a frame to settle). Tests pass a synchronous scheduler. */
  schedule?: (cb: () => void) => void;
}

/**
 * Attach a self-healing WebGL renderer to `term`. `makeAddon` constructs a
 * fresh WebglAddon (injected so tests can supply a fake and so a missing
 * WebGL2 context surfaces as a throw we catch). Returns a handle whose
 * `dispose()` must be called when the terminal is torn down.
 */
export function attachSelfHealingWebgl(
  term: RefreshableTerminal,
  makeAddon: () => DisposableWebglAddon,
  opts: AttachOptions = {},
): WebglRendererHandle {
  const maxRetries = opts.maxRetries ?? 3;
  const schedule = opts.schedule ?? ((cb): void => void requestAnimationFrame(() => cb()));

  let addon: DisposableWebglAddon | undefined;
  let retries = 0;
  let disposed = false;

  const repaint = (): void => {
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      /* term already disposed — nothing to repaint */
    }
  };

  const attach = (): void => {
    if (disposed) return;
    let made: DisposableWebglAddon;
    try {
      made = makeAddon();
    } catch {
      // WebGL2 unavailable — DOM renderer is active; clear any stale frame.
      addon = undefined;
      repaint();
      return;
    }
    made.onContextLoss(() => {
      try {
        made.dispose();
      } catch {
        /* already gone */
      }
      if (addon === made) addon = undefined;
      if (disposed) return;
      if (retries >= maxRetries) {
        // Give up on WebGL — repaint so the dead frame doesn't linger, then
        // stay on the DOM renderer for the rest of this terminal's life.
        repaint();
        return;
      }
      retries++;
      schedule(() => {
        if (disposed) return;
        attach();
        // Recreate failed → DOM renderer took over; force a repaint so the
        // frozen GPU frame is replaced (this is what kills "каша").
        if (!addon) repaint();
      });
    });
    try {
      term.loadAddon(made);
      addon = made;
    } catch {
      // loadAddon threw (e.g. context died mid-attach) — fall back to DOM.
      try {
        made.dispose();
      } catch {
        /* ok */
      }
      addon = undefined;
      repaint();
    }
  };

  attach();

  return {
    current: () => addon,
    retries: () => retries,
    dispose: (): void => {
      disposed = true;
      try {
        addon?.dispose();
      } catch {
        /* ok */
      }
      addon = undefined;
    },
  };
}
