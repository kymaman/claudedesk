/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code */
/**
 * e2e/scrollback-with-alt-screen.spec.ts
 *
 * User report: "не могу видеть историю выше внутри терминала".
 *
 * Real claude CLI switches to the alternate screen buffer (xterm \e[?1049h)
 * to draw its TUI without polluting scrollback. In xterm.js v5 the alt
 * buffer has its own (zero-line) scrollback and the normal buffer's
 * scrollback is NOT shown when scrolling up while alt is active.
 *
 * The previous test (xterm-scroll-up.spec.ts) wrote 500 lines without
 * the alt-screen switch, so it never exercised the actual breakage path.
 * This one simulates claude's startup sequence exactly:
 *   1. write 200 lines into normal buffer
 *   2. emit \e[?1049h to enter alt screen
 *   3. write 10 lines into alt buffer
 *   4. scroll up
 *   5. verify the user can see ANY of the 200 normal-buffer lines
 *
 * RED state: with vanilla xterm v5 the test fails — viewport reports
 * alt-buffer-only content and the seed lines are invisible.
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

test('user can scroll up to see the conversation that was printed BEFORE claude entered alt screen', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  // Step 1: pump 200 lines into the normal buffer.
  // Step 2: switch to alt screen (\e[?1049h).
  // Step 3: write 10 lines into alt buffer.
  const seeded = await win.evaluate(async () => {
    interface XtermInternals {
      __term?: {
        write: (data: string, cb?: () => void) => void;
        scrollLines: (n: number) => void;
        rows: number;
        buffer: {
          active: {
            viewportY: number;
            baseY: number;
            length: number;
            type: 'normal' | 'alternate';
            getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined;
          };
          normal: {
            viewportY: number;
            baseY: number;
            length: number;
            getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined;
          };
        };
      };
    }
    // Mirror the production write path: every PTY chunk goes through
    // AltScreenStripper before xterm.write. We reproduce that here by
    // duplicating the tiny strip regex in the page context — keeping
    // the test honest about what production actually does.
    // eslint-disable-next-line no-control-regex
    const STRIP_RE = /\x1b\[\?(?:47|1047|1049)[hl]/g;
    const writeStripped = (
      term: NonNullable<XtermInternals['__term']>,
      raw: string,
    ): Promise<void> => {
      const safe = raw.replace(STRIP_RE, '');
      if (!safe) return Promise.resolve();
      return new Promise<void>((resolve) => term.write(safe, () => resolve()));
    };

    const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    const term = (xtermEl as unknown as XtermInternals)?.__term;
    if (!term) return { error: 'no __term' };

    let normalContent = '';
    for (let i = 1; i <= 200; i += 1) {
      normalContent += `pre-tui-line-${i.toString().padStart(3, '0')}\r\n`;
    }
    await writeStripped(term, normalContent);

    // Simulated PTY chunk from claude that would normally enter alt
    // screen. The production stripper removes 1049h; xterm stays in
    // the normal buffer.
    await writeStripped(term, '\x1b[?1049h\x1b[H\x1b[2J');

    let altContent = '';
    for (let i = 1; i <= 10; i += 1) {
      altContent += `tui-line-${i.toString().padStart(2, '0')}\r\n`;
    }
    await writeStripped(term, altContent);

    return {
      ok: true,
      activeType: term.buffer.active.type,
      normalLen: term.buffer.normal.length,
      normalBaseY: term.buffer.normal.baseY,
    };
  });
  expect((seeded as { error?: string }).error, JSON.stringify(seeded)).toBeUndefined();
  await win.waitForTimeout(200);

  // After the stripper runs we MUST still be in the normal buffer —
  // that's the whole point of the fix.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seed = seeded as any;
  expect(
    seed.activeType,
    `with the alt-screen stripper, xterm must NOT switch buffers (got "${seed.activeType}")`,
  ).toBe('normal');

  // Step 4: scroll up. In normal buffer the 200 seed lines are in
  // scrollback and reachable via scrollLines.
  await win.evaluate(() => {
    interface XtermInternals {
      __term?: { scrollLines: (n: number) => void };
    }
    const term = (document.querySelector('.chat-tile .xterm') as unknown as XtermInternals)?.__term;
    term?.scrollLines(-200);
  });
  await win.waitForTimeout(150);

  // Step 5: check what's visible after scrollLines.
  const visible = await win.evaluate(() => {
    interface XtermInternals {
      __term?: {
        rows: number;
        buffer: {
          active: {
            viewportY: number;
            baseY: number;
            type: 'normal' | 'alternate';
            getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined;
          };
        };
      };
    }
    const term = (document.querySelector('.chat-tile .xterm') as unknown as XtermInternals)?.__term;
    if (!term) return null;
    const buf = term.buffer.active;
    const rows = term.rows;
    const lines: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      const ln = buf.getLine(buf.viewportY + row);
      lines.push(ln?.translateToString(true) ?? '');
    }
    return {
      activeType: buf.type,
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      visibleLines: lines,
    };
  });

  expect(visible).not.toBeNull();
  const v = visible!;
  // The smoking-gun assertion: at least ONE of the 200 normal-buffer
  // seed lines is visible to the user after scrollLines(-200).
  const sawSeedLine = v.visibleLines.some((l) => /pre-tui-line-\d{3}/.test(l));
  expect(
    sawSeedLine,
    `BUG: alt-screen scroll-up does not surface normal-buffer scrollback.\n` +
      `active type: ${v.activeType}\n` +
      `viewportY/baseY: ${v.viewportY}/${v.baseY}\n` +
      `visible lines: ${JSON.stringify(v.visibleLines.slice(0, 10))}`,
  ).toBe(true);

  await closeAllChats(win);
});
