import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

interface TerminalEntry {
  container: HTMLElement;
  fitAddon: FitAddon;
  term: Terminal;
  dirty: boolean;
}

const entries = new Map<string, TerminalEntry>();
let rafId: number | undefined;
let trailingTimer: number | undefined;
let lastFlushTime = 0;
const THROTTLE_MS = 150;
/** When the container is reported invisible (clientWidth=0, parent
 *  display:none) we keep the entry dirty and retry later. This is the
 *  delay between retries — short enough that the user doesn't perceive
 *  a flash of stale text when they switch back into the view. */
const HIDDEN_RETRY_MS = 80;

const resizeObserver = new ResizeObserver((resizeEntries) => {
  for (const re of resizeEntries) {
    for (const [, entry] of entries) {
      if (entry.container === re.target || entry.container.contains(re.target as Node)) {
        entry.dirty = true;
      }
    }
  }
  scheduleFlush();
});

const intersectionObserver = new IntersectionObserver((ioEntries) => {
  for (const ioe of ioEntries) {
    if (!ioe.isIntersecting) continue;
    for (const [, entry] of entries) {
      if (entry.container === ioe.target) {
        entry.dirty = true;
      }
    }
  }
  scheduleFlush();
});

function flush() {
  let didWork = false;
  let deferredHidden = false;
  for (const [, entry] of entries) {
    if (!entry.dirty) continue;

    // CRITICAL: if the container has zero width, fit() would compute
    // cols=1 (or some tiny number) and lock the terminal in that state
    // until the next ResizeObserver fire — which may never come if the
    // parent toggles display:none synchronously. Keep dirty=true and
    // retry shortly; xterm stays at its previous valid cols meanwhile.
    if (entry.container.clientWidth <= 0 || entry.container.clientHeight <= 0) {
      deferredHidden = true;
      continue;
    }
    entry.dirty = false;

    // xterm.js scroll position workaround (xtermjs/xterm.js#5096):
    // fit() → resize() → Viewport._sync() can reset scrollTop to 0 when
    // it encounters a transient dimension mismatch. Save the viewport
    // scroll position before fitting and restore it if clobbered.
    const buf = entry.term.buffer.active;
    const wasScrolledUp = buf.viewportY < buf.baseY;
    const savedViewportY = buf.viewportY;

    entry.fitAddon.fit();

    if (wasScrolledUp && buf.viewportY !== savedViewportY) {
      entry.term.scrollToLine(Math.min(savedViewportY, buf.baseY));
    }

    didWork = true;
  }
  // Only update throttle timestamp when we actually fitted something —
  // a no-op flush should not delay the next real fit.
  if (didWork) lastFlushTime = performance.now();

  // Re-schedule for hidden tiles. They'll get measured the moment their
  // parent stops being display:none.
  if (deferredHidden) {
    if (trailingTimer !== undefined) clearTimeout(trailingTimer);
    trailingTimer = window.setTimeout(() => {
      trailingTimer = undefined;
      if (rafId !== undefined) return;
      rafId = requestAnimationFrame(() => {
        rafId = undefined;
        flush();
      });
    }, HIDDEN_RETRY_MS);
  }
}

function scheduleFlush() {
  // Leading edge: fit immediately if enough time has passed since last fit
  if (performance.now() - lastFlushTime >= THROTTLE_MS) {
    if (rafId === undefined) {
      rafId = requestAnimationFrame(() => {
        rafId = undefined;
        flush();
      });
    }
  }

  // Trailing edge: always schedule a delayed fit so the final resize is captured
  if (trailingTimer !== undefined) clearTimeout(trailingTimer);
  trailingTimer = window.setTimeout(() => {
    trailingTimer = undefined;
    if (rafId !== undefined) return;
    rafId = requestAnimationFrame(() => {
      rafId = undefined;
      flush();
    });
  }, THROTTLE_MS);
}

export function registerTerminal(
  id: string,
  container: HTMLElement,
  fitAddon: FitAddon,
  term: Terminal,
): void {
  entries.set(id, { container, fitAddon, term, dirty: false });
  resizeObserver.observe(container);
  intersectionObserver.observe(container);
  // Force a refit on every other terminal too — adding a tile to the
  // grid changes everyone else's column count. Without this, the FIRST
  // tile stays at its solo-mode wide cols while subsequent tiles get
  // the narrower 2-col-grid size. Mark global dirty so the next flush
  // touches them all.
  for (const [otherId, otherEntry] of entries) {
    if (otherId !== id) otherEntry.dirty = true;
  }
  scheduleFlush();
}

export function unregisterTerminal(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  resizeObserver.unobserve(entry.container);
  intersectionObserver.unobserve(entry.container);
  entries.delete(id);
  // Removing a tile also changes the grid size for everyone else.
  for (const otherEntry of entries.values()) otherEntry.dirty = true;
  scheduleFlush();
}

export function markDirty(id: string): void {
  const entry = entries.get(id);
  if (entry) {
    entry.dirty = true;
    scheduleFlush();
  }
}

/**
 * Force every registered terminal to refit on the next frame. Useful when
 * the parent layout changes in a way ResizeObserver doesn't notice — e.g.
 * Chats ↔ History tab toggles where the xterm container's bounding box stays
 * within the same parent but the surrounding chrome reflows. Without this,
 * terminals end up rendered at a stale width and look "shifted left" until
 * the user resizes the window.
 */
export function refitAll(): void {
  for (const entry of entries.values()) entry.dirty = true;
  scheduleFlush();
}
