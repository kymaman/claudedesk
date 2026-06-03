/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code */
/**
 * e2e/xterm-scroll-up.spec.ts
 *
 * Bug: user reports "can't see history above" inside the terminal.
 * Even after bumping TERMINAL_SCROLLBACK_LINES back to 10_000, the
 * complaint persists — which points at scroll BEHAVIOUR (snapping back
 * to bottom on every new output), not buffer SIZE.
 *
 * This test:
 *   1. Writes 500 lines into the xterm directly via __term.write()
 *   2. Calls term.scrollLines(-100) to scroll up
 *   3. Verifies viewportY actually moved up
 *   4. Writes MORE lines after scrolling up
 *   5. Verifies viewportY does NOT snap back to baseY (the user's
 *      scroll position must be respected when more output arrives)
 *
 * xterm's default Viewport already does this — if our code is auto-
 * scrolling on every chunk (e.g. via term.scrollToBottom() in the
 * write callback), the test catches it.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, openOneChat, awaitChatReady, closeAllChats } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.describe.configure({ timeout: 180_000 });
test.afterAll(async () => {
  if (!app) return;
  try {
    await closeAllChats(win).catch(() => undefined);
    await win.waitForTimeout(300);
  } catch {
    /* ignore */
  }
  await app.close();
});

test('user can scroll up in the terminal and the position holds when new output arrives', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  // Pump 500 lines into the terminal directly. We bypass the PTY so the
  // test doesn't depend on whatever claude prints — we just need a
  // populated scrollback buffer.
  const seeded = await win.evaluate(() => {
    interface XtermInternals {
      __term?: {
        write: (data: string) => void;
        scrollLines: (n: number) => void;
        scrollToBottom: () => void;
        buffer: { active: { viewportY: number; baseY: number; cursorY: number } };
        rows: number;
      };
    }
    const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    const term = (xtermEl as unknown as XtermInternals)?.__term;
    if (!term) return { error: 'no __term on .chat-tile .xterm' };
    let lines = '';
    for (let i = 1; i <= 500; i += 1) lines += `seed-line-${i.toString().padStart(3, '0')}\r\n`;
    term.write(lines);
    return {
      ok: true,
      rows: term.rows,
    };
  });
  expect((seeded as { error?: string }).error, JSON.stringify(seeded)).toBeUndefined();
  // Give xterm a frame to finish writing.
  await win.waitForTimeout(200);

  // Step 1: read the state at the bottom (after the seed).
  const before = await win.evaluate(() => {
    interface XtermInternals {
      __term?: {
        buffer: { active: { viewportY: number; baseY: number } };
        scrollLines: (n: number) => void;
      };
    }
    const term = (document.querySelector('.chat-tile .xterm') as unknown as XtermInternals)?.__term;
    if (!term) return null;
    return { viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY };
  });
  expect(before, 'must read xterm buffer state').not.toBeNull();
  expect(before!.viewportY).toBe(before!.baseY); // at bottom — auto-scroll on write

  // Step 2: scroll up 100 lines.
  await win.evaluate(() => {
    interface XtermInternals {
      __term?: { scrollLines: (n: number) => void };
    }
    const term = (document.querySelector('.chat-tile .xterm') as unknown as XtermInternals)?.__term;
    term?.scrollLines(-100);
  });
  await win.waitForTimeout(100);

  const scrolled = await win.evaluate(() => {
    interface XtermInternals {
      __term?: { buffer: { active: { viewportY: number; baseY: number } } };
    }
    const term = (document.querySelector('.chat-tile .xterm') as unknown as XtermInternals)?.__term;
    if (!term) return null;
    return { viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY };
  });
  expect(scrolled, 'must read state after scrollLines').not.toBeNull();
  expect(
    scrolled!.viewportY,
    `viewportY must drop ~100 below baseY after scrollLines(-100): ${JSON.stringify(scrolled)}`,
  ).toBeLessThanOrEqual(scrolled!.baseY - 50);
  const scrolledViewport = scrolled!.viewportY;

  // Step 3: write more output. If our code calls scrollToBottom() after
  // every write, this is when the user gets yanked back to the bottom.
  await win.evaluate(() => {
    interface XtermInternals {
      __term?: { write: (data: string) => void };
    }
    const term = (document.querySelector('.chat-tile .xterm') as unknown as XtermInternals)?.__term;
    if (!term) return;
    let lines = '';
    for (let i = 1; i <= 80; i += 1) lines += `more-line-${i.toString().padStart(3, '0')}\r\n`;
    term.write(lines);
  });
  // Wait through any debounce / flush cycles in our output pipeline.
  await win.waitForTimeout(500);

  const after = await win.evaluate(() => {
    interface XtermInternals {
      __term?: { buffer: { active: { viewportY: number; baseY: number } } };
    }
    const term = (document.querySelector('.chat-tile .xterm') as unknown as XtermInternals)?.__term;
    if (!term) return null;
    return { viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY };
  });
  expect(after, 'must read final state').not.toBeNull();

  // BUG SIGNATURE: if our code snaps the user back to the bottom on
  // new write, after.viewportY === after.baseY. The viewport should
  // instead stay roughly where the user left it (the user already
  // scrolled up — new output may push baseY DOWN, but viewportY must
  // NOT track baseY 1:1).
  expect(
    after!.baseY - after!.viewportY,
    `BUG: viewport snapped back to bottom after new output.\n` +
      `before scroll: ${JSON.stringify(before)}\n` +
      `after scroll up: ${JSON.stringify(scrolled)}\n` +
      `after more writes: ${JSON.stringify(after)}\n` +
      `Expected gap between baseY and viewportY ~= ${before!.baseY - scrolledViewport}.`,
  ).toBeGreaterThanOrEqual(20);

  await closeAllChats(win);
});
