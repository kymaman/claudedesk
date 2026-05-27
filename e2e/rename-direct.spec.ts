/**
 * e2e/rename-direct.spec.ts
 *
 * Pinpoint diagnostic: skips the right-click → prompt UI flow entirely
 * and calls renameChat() straight through `win.evaluate` against the
 * already-loaded chats module. If the title in the DOM still doesn't
 * change, the bug is downstream of the store — Solid's `<For>` /
 * `titleFor` chain isn't propagating. If the title DOES change, the
 * earlier failing test was a UI-flow issue (window.prompt + Playwright
 * dialog handler), not a reactivity bug.
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

test('renameChat() updates the tile head DOM without going through the prompt', async () => {
  await openOneChat(win);
  await awaitChatReady(win);

  const tile = win.locator('.chat-tile').first();
  const titleEl = tile.locator('.chat-tile__title');
  const before = (await titleEl.textContent())?.trim() ?? '';
  expect(before.length, 'tile must have a visible title before rename').toBeGreaterThan(0);

  const newTitle = `direct-rename-${Date.now().toString().slice(-5)}`;

  // Walk the renderer-side store directly: find the chat id, then call
  // renameChat. The store module is the same one TopSwitcher uses, so
  // this writes to the real reactive system — no UI mocks.
  const result = await win.evaluate(async (tt) => {
    interface ChatsHook {
      chats: () => Array<{ id: string; title: string }>;
      renameChat: (id: string, title: string) => void;
      titleFor: (chat: { id: string; title: string }) => string;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook = (window as any).__claudedeskChats as ChatsHook | undefined;
    if (!hook) return { error: 'no __claudedeskChats hook on window' };
    const all = hook.chats();
    if (all.length === 0) return { error: 'no chats in store' };
    const firstId = all[0].id;
    const titleBefore = hook.titleFor(all[0]);
    hook.renameChat(firstId, tt);
    // Inspect the store directly so we can prove the store update
    // succeeded independent of any DOM observation later.
    const all2 = hook.chats();
    const storeTitle = all2.find((c) => c.id === firstId)?.title ?? null;
    const titleAfter = hook.titleFor({ id: firstId, title: storeTitle ?? '' });
    return { ok: true, renamedId: firstId, titleBefore, titleAfter, storeTitle };
  }, newTitle);

  // Print store-side observations regardless of DOM result so we can
  // tell store-not-updating from DOM-not-reactive.
  console.warn('[rename-direct] store result:', JSON.stringify(result));

  if ((result as { error?: string }).error) {
    test.skip(true, `cannot reach store from test: ${(result as { error: string }).error}`);
  }

  // Give Solid a frame to propagate the update through the effects.
  await win.waitForTimeout(300);

  const after = (await titleEl.textContent())?.trim() ?? '';
  expect(
    after,
    `BUG: direct renameChat() call did not update the tile head DOM.\n` +
      `Before: ${JSON.stringify(before)}\n` +
      `After:  ${JSON.stringify(after)}\n` +
      `If this fails, the chats store + Solid <For> are not reconciling.`,
  ).toContain(newTitle);

  await closeAllChats(win);
});
