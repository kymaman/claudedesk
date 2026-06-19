/**
 * e2e/resume-trust-no-freeze.spec.ts
 *
 * Reproduces "open an old dialog → история замирает и её не видно": a resumed
 * Claude tile in an untrusted folder froze at the blocking "Trust this folder?"
 * prompt, leaving the conversation stuck up in scrollback. The fix
 * (lib/auto-trust.ts) auto-confirms folder-trust for resumed sessions.
 *
 * This opens several real History sessions and asserts NONE is left parked at
 * an unanswered trust prompt a few seconds after opening — i.e. it auto-advanced
 * to the conversation / input box. RED on the pre-fix build (tile frozen at the
 * prompt), GREEN with auto-trust.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, awaitChatReady, closeAllChats } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.describe.configure({ timeout: 240_000 });
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

interface XtermInternals {
  __term?: {
    buffer: {
      active: {
        length: number;
        getLine: (i: number) => { translateToString: (t?: boolean) => string } | undefined;
      };
    };
  };
}

/** The last `n` non-empty lines of the live xterm buffer. */
async function tailLines(n: number): Promise<string[]> {
  return win.evaluate((count) => {
    const el = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    const t = el ? (el as unknown as XtermInternals).__term : undefined;
    if (!t) return [];
    const b = t.buffer.active;
    const out: string[] = [];
    for (let i = b.length - 1; i >= 0 && out.length < count; i -= 1) {
      const s = b.getLine(i)?.translateToString(true)?.trimEnd() ?? '';
      if (s.trim().length > 0) out.push(s);
    }
    return out.reverse();
  }, n);
}

test('resumed sessions do not freeze at the folder-trust prompt', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.locator('.session-item').first().waitFor({ state: 'visible', timeout: 20_000 });
  const total = await win.locator('.session-item').count();
  test.skip(total < 1, 'no real sessions on disk');

  const N = Math.min(total, 5);
  let checked = 0;
  for (let i = 0; i < N; i += 1) {
    await win.locator('.ts-nav', { hasText: 'History' }).click();
    await win.waitForTimeout(300);
    await win.locator('.session-item').nth(i).locator('.session-item__resume').click();
    await expect(win.locator('.chat-tile .xterm').first()).toBeVisible({ timeout: 15_000 });
    await awaitChatReady(win, 12_000).catch(() => undefined);
    // Give auto-trust time to fire (2.5s cooldown + claude redraw) and claude
    // to advance past the prompt.
    await win.waitForTimeout(7_000);

    const tail = (await tailLines(25)).join('\n');
    // The tell-tale of a FROZEN tile: the trust prompt's confirm line is still
    // the bottom-most content (claude is idling, waiting for Enter).
    const frozen =
      /Enter to confirm/i.test(tail) &&
      /(trust this folder|you trust\?)/i.test(tail) &&
      /No, exit/i.test(tail);
    expect(frozen, `session #${i} is FROZEN at the trust prompt:\n${tail}`).toBe(false);
    checked += 1;

    await closeAllChats(win);
    await win.waitForTimeout(300);
  }

  expect(checked, 'at least one session was checked').toBeGreaterThan(0);
});
