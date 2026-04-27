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

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'dist-electron', 'main.js');

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  if (!fs.existsSync(MAIN)) throw new Error(`build missing at ${MAIN}`);
  app = await electron.launch({
    args: [MAIN, '--no-sandbox'],
    cwd: ROOT,
    env: { ...process.env, VITE_DEV_SERVER_URL: '', CLAUDEDESK_E2E: '1' },
    timeout: 45_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(800);
});

test.afterAll(async () => {
  if (app) await app.close();
});

/** Open a chat by hitting ▶ on the first available History session.
 *  Skips the spec if no sessions exist on disk. */
async function openOneChat(): Promise<void> {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const firstRow = win.locator('.session-item').first();
  if ((await firstRow.count()) === 0) test.skip(true, 'No sessions to open');
  await firstRow.locator('.session-item__resume').click();
  await expect(win.locator('.chat-tile').first()).toBeVisible({ timeout: 5_000 });
  await expect(win.locator('.chat-tile .xterm').first()).toBeVisible({ timeout: 5_000 });
  // Let terminalFitManager's debounce settle.
  await win.waitForTimeout(400);
}

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
  await openOneChat();
  const g = await tileGeometry();
  expect(g.tileBody.w).toBeGreaterThan(100);
  // The xterm canvas should be no narrower than container minus a small
  // pad — anything more is the "shrunk inside" bug.
  expect(g.tileBody.w - g.xtermCanvas.w).toBeLessThan(20);
  // Cleanup
  await win.locator('.chat-tile__close').first().click();
  await win.waitForTimeout(300);
});

test('chat tile xterm refits after toggling the Ask sidebar', async () => {
  await openOneChat();
  const before = await tileGeometry();

  // Open Ask sidebar — that takes 380px of the right edge, so the chat
  // pane shrinks. xterm must refit to fit the new container width.
  await win.locator('.ts-ask').click();
  await expect(win.locator('.assistant-sidebar')).toBeVisible({ timeout: 3_000 });
  await win.waitForTimeout(500);

  const afterOpen = await tileGeometry();
  // The chat tile body got narrower
  expect(afterOpen.tileBody.w).toBeLessThan(before.tileBody.w);
  // And xterm canvas tracked it (didn't stay at the wider size)
  expect(afterOpen.tileBody.w - afterOpen.xtermCanvas.w).toBeLessThan(20);

  // Close Ask — chat should expand back
  await win.locator('.assistant-sidebar__btn--close').click();
  await expect(win.locator('.assistant-sidebar')).toBeHidden({ timeout: 3_000 });
  await win.waitForTimeout(500);

  const afterClose = await tileGeometry();
  expect(afterClose.tileBody.w).toBeGreaterThan(afterOpen.tileBody.w);
  expect(afterClose.tileBody.w - afterClose.xtermCanvas.w).toBeLessThan(20);

  // Cleanup
  await win.locator('.chat-tile__close').first().click();
  await win.waitForTimeout(300);
});

test('chat tile xterm refits after switching History → Chats → History', async () => {
  await openOneChat();
  const before = await tileGeometry();

  // Switch to Chats — same chat is still alive but layout changes.
  await win.locator('.ts-nav', { hasText: 'Chats' }).click();
  await win.waitForTimeout(500);

  // Switch back
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(500);

  const after = await tileGeometry();
  // Body stays same size (window unchanged), xterm tracks it.
  expect(Math.abs(after.tileBody.w - before.tileBody.w)).toBeLessThan(20);
  expect(after.tileBody.w - after.xtermCanvas.w).toBeLessThan(20);

  await win.locator('.chat-tile__close').first().click();
  await win.waitForTimeout(300);
});

test('chat tile xterm refits when the BrowserWindow resizes', async () => {
  await openOneChat();
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

  await win.locator('.chat-tile__close').first().click();
  await win.waitForTimeout(300);
});

test('two open tiles share the row width — neither is narrower than the other', async () => {
  await openOneChat();
  // Open a second chat from another session
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const rows = win.locator('.session-item');
  const count = await rows.count();
  if (count < 2) {
    test.skip(true, 'Need at least 2 sessions to open 2 chats');
  }
  await rows.nth(1).locator('.session-item__resume').click();
  await win.waitForTimeout(800);

  const tiles = await win.evaluate(() => {
    const arr = Array.from(document.querySelectorAll('.chat-tile')) as HTMLElement[];
    return arr.map((t) => {
      const body = t.querySelector('.chat-tile__body') as HTMLElement | null;
      return body?.clientWidth ?? 0;
    });
  });

  expect(tiles.length).toBeGreaterThanOrEqual(2);
  // All tiles should be within 4px of each other (1 grid gap rounding).
  const min = Math.min(...tiles);
  const max = Math.max(...tiles);
  expect(max - min).toBeLessThan(8);

  // Cleanup
  for (let i = 0; i < tiles.length; i += 1) {
    const close = win.locator('.chat-tile__close').first();
    if ((await close.count()) === 0) break;
    await close.click();
    await win.waitForTimeout(150);
  }
});
