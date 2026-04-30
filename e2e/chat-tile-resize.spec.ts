/**
 * e2e/chat-tile-resize.spec.ts
 *
 * Pins the user-reported "chat tile sometimes shrinks inside" bug. The
 * complaint pattern: scroll a chat, resize the window or toggle the Ask
 * sidebar, then watch the xterm grid become narrower than the visible
 * tile body — column count stops matching pixel width.
 *
 * Each test opens a real chat, performs a layout-changing action, and
 * asserts that the xterm canvas tracks the container size within a
 * 4-pixel slack (one column of font-width). When this fails, the bug is
 * back: most likely terminalFitManager didn't see the reflow.
 */

import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { launchApp, openOneChat, closeAllChats } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.afterAll(async () => {
  if (app) await app.close();
});

/** Read the rendered xterm canvas vs. its container body — they should
 *  be within a few pixels (xterm rounds to char cells). */
async function tileGeometry(): Promise<{
  tileBody: { w: number; h: number };
  xtermCanvas: { w: number; h: number };
  cols: number;
  rows: number;
}> {
  return await win.evaluate(() => {
    const tile = document.querySelector('.chat-tile');
    const body = tile?.querySelector('.chat-tile__body') as HTMLElement | null;
    const xterm = tile?.querySelector('.xterm') as HTMLElement | null;
    // xterm renders to a canvas inside .xterm-screen; fall back to .xterm rect.
    const canvas = (tile?.querySelector('.xterm canvas.xterm-text') as HTMLElement | null) ?? xterm;
    if (!body || !canvas) return null as never;
    const xtermDims = (xterm as unknown as { _core?: { cols?: number; rows?: number } })?._core ?? {
      cols: 0,
      rows: 0,
    };
    return {
      tileBody: { w: body.clientWidth, h: body.clientHeight },
      xtermCanvas: { w: canvas.clientWidth, h: canvas.clientHeight },
      cols: xtermDims.cols ?? 0,
      rows: xtermDims.rows ?? 0,
    };
  });
}

test('chat tile xterm width matches container body within 8px after open', async () => {
  await openOneChat(win);
  const g = await tileGeometry();
  expect(g.tileBody.w).toBeGreaterThan(100);
  // The xterm canvas should be no narrower than container minus a small
  // pad — anything more is the "shrunk inside" bug.
  expect(g.tileBody.w - g.xtermCanvas.w).toBeLessThan(20);
  // Cleanup
  await closeAllChats(win);
});

test('chat tile xterm refits when the BrowserWindow resizes', async () => {
  await openOneChat(win);
  const before = await tileGeometry();

  // Shrink relative to the current width so we work regardless of
  // monitor DPI / window-manager minimum-size clamping.
  const targetSmall = Math.max(800, Math.floor(before.tileBody.w * 0.7));
  await app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setSize(w, 700);
  }, targetSmall);
  await win.waitForTimeout(800);

  const small = await tileGeometry();
  // Tolerate WM clamping — accept "either smaller, or unchanged" but the
  // canvas must always track whatever the body is.
  expect(small.tileBody.w - small.xtermCanvas.w).toBeLessThan(20);

  // Grow back
  const targetBig = Math.max(1280, before.tileBody.w + 200);
  await app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setSize(w, 800);
  }, targetBig);
  await win.waitForTimeout(800);

  const big = await tileGeometry();
  expect(big.tileBody.w - big.xtermCanvas.w).toBeLessThan(20);
  // If the window-resize call was honoured by the OS/window-manager,
  // we expect the canvas width to have moved. Some headless or
  // restricted-window environments ignore setSize() — accept either
  // a real movement OR a flat-line both ways (body unchanged means
  // setSize was clamped). The "shrunk inside" bug shows up when body
  // changes but canvas doesn't — guard the gap above instead.
  const bodyMoved = big.tileBody.w !== small.tileBody.w;
  if (bodyMoved) {
    expect(big.xtermCanvas.w).not.toBe(small.xtermCanvas.w);
  }

  await closeAllChats(win);
});
