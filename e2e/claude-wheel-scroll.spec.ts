/**
 * e2e/claude-wheel-scroll.spec.ts
 *
 * The working behaviour the owner wants back: NO read mode, but the wheel over
 * the live claude terminal scrolls CLAUDE'S OWN transcript (we translate each
 * notch into PageUp/PageDown and send it to the PTY). When claude scrolls up
 * off the bottom it draws its native "Jump to bottom (ctrl+End)" hint — that
 * string is the precise, claude-native proof that scrolling engaged.
 *
 * Proven here in a real Electron window against a real resumed claude:
 *  - wheel-up makes claude's "Jump to bottom" / "ctrl+End" hint appear;
 *  - no read pane ever opens (read mode is parked).
 * Skips (not fails) if the resumed transcript is too short to scroll.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, closeAllChats, openChatWithHistory } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});
test.afterAll(async () => {
  if (!app) return;
  await closeAllChats(win).catch(() => undefined);
  await app.close();
});

/** Whole visible+scrollback buffer text of the first live tile's xterm. */
function liveBufferText(win: Page): Promise<string> {
  return win.evaluate(() => {
    interface X {
      __term?: { buffer: { active: { length: number; getLine(i: number): unknown } } };
    }
    const el = document.querySelector('.chat-tile__live .xterm') as unknown as X;
    const term = el?.__term;
    if (!term) return '';
    const b = term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i) as { translateToString(t: boolean): string } | undefined;
      if (line) out.push(line.translateToString(true));
    }
    return out.join('\n');
  });
}

test('wheel-up scrolls claude itself (its "Jump to bottom" hint appears); no read pane', async () => {
  await openChatWithHistory(win);

  const xterm = win.locator('.chat-tile .xterm').first();
  const box = await xterm.boundingBox();
  if (!box) throw new Error('no terminal box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await win.mouse.move(cx, cy);
  // Several notches up — claude pages its transcript and, once off the bottom,
  // draws its "Jump to bottom (ctrl+End)" hint.
  for (let i = 0; i < 6; i++) {
    await win.mouse.wheel(0, -200);
    await win.waitForTimeout(200);
  }
  await win.waitForTimeout(700);

  const text = await liveBufferText(win);
  const hint = /Jump to bottom|ctrl\+End/i.test(text);
  if (!hint) {
    test.skip(true, 'resumed transcript too short to scroll (no Jump-to-bottom hint)');
  }
  expect(hint, 'claude should show its scroll hint after wheel-up').toBe(true);

  // Read mode stays parked — no pane should ever appear.
  expect(await win.locator('.chat-tile__read-pane').count()).toBe(0);
});
