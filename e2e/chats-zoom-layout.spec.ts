/**
 * chats-zoom-layout.spec.ts
 *
 * Regression guard for the "Chats" tab layout. When the user clicks the Chats
 * nav tab (mainView === 'chats'), the panel enters chats-zoom: the History
 * chrome — folders pane, the collapsed `›` strip, the sessions list and the
 * panel header — must all be hidden, and the open-chats grid must fill the
 * full width. The user reported a regression where History was still visible
 * on the left in the Chats tab; this pins the correct behaviour WITH a real
 * chat open (not just the empty state).
 */
import { test, expect, type Page } from '@playwright/test';
import { launchApp, awaitChatReady, closeAllChats } from './helpers.js';

test.describe.configure({ timeout: 120_000 });

/** Open the first History session as a chat, waiting properly for the async
 *  session list to populate (the shared openOneChat only waits 300ms and
 *  flaked to a skip on a cold disk read). Returns false if there are truly
 *  no sessions on disk (CI) so the caller can skip. */
async function openFirstChat(win: Page): Promise<boolean> {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  const firstRow = win.locator('.session-item').first();
  await firstRow.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  if ((await win.locator('.session-item').count()) === 0) return false;
  await firstRow.locator('.session-item__resume').click();
  await expect(win.locator('.chat-tile').first()).toBeVisible({ timeout: 30_000 });
  await awaitChatReady(win, 20_000).catch(() => undefined);
  return true;
}

function leftChromeReport(win: Page) {
  return win.evaluate(() => {
    const vis = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { present: false, visible: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        present: true,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0,
        x: Math.round(r.x),
        w: Math.round(r.width),
      };
    };
    const tile = document.querySelector('.sessions-panel__chats .chat-tile') as HTMLElement | null;
    return {
      zoom: document
        .querySelector('.sessions-panel')
        ?.classList.contains('sessions-panel--chats-zoom'),
      header: vis('.sessions-panel__header'),
      foldersPane: vis('.folders-pane'),
      foldersExpand: vis('.folders-pane__expand'),
      sessionsList: vis('.sessions-panel__list'),
      chats: vis('.sessions-panel__chats'),
      tileInsideChats: Boolean(tile),
    };
  });
}

test('Chats tab hides all History chrome and shows only the chats grid', async () => {
  const { app, win } = await launchApp();
  try {
    const opened = await openFirstChat(win);
    if (!opened) test.skip(true, 'No History sessions on disk to open a chat');

    // Click the Chats nav tab → chats-zoom.
    await win.locator('.ts-nav', { hasText: 'Chats' }).click();
    await win.waitForTimeout(500);

    const r = await leftChromeReport(win);
    await win.screenshot({ path: 'e2e/__chats-view-open.png' });

    expect(r.zoom, 'panel must carry the chats-zoom class').toBe(true);
    // The whole point: NO History chrome on the left.
    expect(r.header.visible, 'panel header must be hidden').toBe(false);
    expect(r.foldersPane.visible, 'folders pane must be hidden').toBe(false);
    expect(r.foldersExpand.visible, 'collapsed `›` strip must be hidden').toBe(false);
    expect(r.sessionsList.visible, 'sessions list must be hidden').toBe(false);
    // Chats grid fills the full width, flush to the left edge.
    expect(r.chats.visible, 'chats grid must be visible').toBe(true);
    expect(r.chats.x, 'chats grid must start at the left edge').toBeLessThanOrEqual(2);
    // The open chat actually lives inside the chats area.
    expect(r.tileInsideChats, 'the open chat tile must render inside the chats grid').toBe(true);
  } finally {
    await closeAllChats(win).catch(() => undefined);
    await app.close();
  }
});
