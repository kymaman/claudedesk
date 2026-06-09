/* eslint-disable @typescript-eslint/no-non-null-assertion -- test asserts presence above */
/**
 * e2e/transcript-native-render.spec.ts
 *
 * REAL end-to-end proof, two ways, against the user's ACTUAL sessions:
 *
 *  TEST 1 (structural correctness, many sessions):
 *    Calls the real `load_session_transcript` IPC for up to 40 real
 *    sessions on disk and asserts the RENDERER never emits the old
 *    hand-rolled structural format — i.e. zero lines that are a bare
 *    `[ USER ]` / `[ ASSISTANT ]` / `[ TOOL RESULT ]` header or a bare
 *    40-dash rule at column 0. (The old renderer emitted one such
 *    block per turn; the native renderer emits none.)
 *
 *    NB: a naive substring check is WRONG here — the user sometimes
 *    PASTES old-format text into their own messages, so that text is
 *    legitimately present as conversation content (rendered under a
 *    `> ` user marker). We therefore check the STRUCTURAL signature
 *    (bare header/rule at column 0) which only the old renderer
 *    produced.
 *
 *  TEST 2 (visual, in the live app):
 *    Opens a real History session in the Electron UI, reads the REAL
 *    xterm buffer, asserts native markers (● / ⎿ / >) are present, and
 *    attaches a screenshot so the rendering can be eyeballed.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, closeAllChats, awaitChatReady, BridgeWindow } from './helpers.js';

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
    rows: number;
    buffer: {
      active: {
        length: number;
        getLine: (i: number) => { translateToString: (t?: boolean) => string } | undefined;
      };
    };
  };
}

// Bare old-renderer structural signature: a line that is EXACTLY a
// header or a 40-dash rule (after ANSI strip + trim of trailing CR).
const STRUCTURAL_OLD = /^(\[ (USER|ASSISTANT|TOOL RESULT) \]|-{40,})$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

// eslint-disable-next-line no-empty-pattern -- need testInfo; fixture is unused
test('renderer never emits old structural format across many REAL sessions (via real IPC)', async ({}, info) => {
  // Pull the real session list from the app, then render each via the
  // real IPC and check the structural signature.
  const sessions = await win.evaluate(async () => {
    const bridge = (
      window as unknown as {
        electron?: { ipcRenderer: { invoke: (c: string, a?: unknown) => Promise<unknown> } };
      }
    ).electron;
    if (!bridge) return [];
    const list = (await bridge.ipcRenderer.invoke('list_claude_sessions')) as Array<{
      sessionId: string;
      title?: string;
    }>;
    return list.slice(0, 40).map((s) => s.sessionId);
  });

  if (sessions.length === 0) test.skip(true, 'No real sessions on disk');

  const offenders: string[] = [];
  let nativeSessions = 0;
  let inspected = 0;

  for (const sid of sessions) {
    const raw = (await win.evaluate(async (sessionId) => {
      const bridge = (window as unknown as BridgeWindow).electron;
      return (await bridge!.ipcRenderer.invoke('load_session_transcript', { sessionId })) as string;
    }, sid)) as string;

    if (!raw) continue;
    inspected += 1;
    const plain = raw.replace(ANSI, '');
    // Model xterm exactly: it returns the cursor to column 0 on BOTH
    // \r and \n. A bare structural header that only appears because a
    // stray \r reset the column is precisely the user-reported bug, so
    // we split on \r AND \n (not just \n) to catch it.
    const lines = plain.split(/\r\n|\r|\n/);

    let structuralHits = 0;
    for (const l of lines) {
      if (STRUCTURAL_OLD.test(l)) structuralHits += 1;
    }
    if (structuralHits > 0) {
      offenders.push(`${sid}: ${structuralHits} bare old-format structural line(s)`);
    }
    if (plain.includes('●') || /(^|\n)❯\s/.test(plain) || plain.includes('⎿')) {
      nativeSessions += 1;
    }
  }

  await info.attach('ipc-render-report.txt', {
    body: Buffer.from(
      [
        `inspected ${inspected} real sessions`,
        `native-format sessions: ${nativeSessions}`,
        `sessions with bare old structural format: ${offenders.length}`,
        '',
        ...offenders,
      ].join('\n'),
      'utf8',
    ),
    contentType: 'text/plain; charset=utf-8',
  });

  expect(
    offenders,
    `Renderer emitted the old structural format for these real sessions:\n${offenders.join('\n')}`,
  ).toEqual([]);
  expect(
    nativeSessions,
    'expected at least one real session to render natively',
  ).toBeGreaterThanOrEqual(1);
});

// eslint-disable-next-line no-empty-pattern -- need testInfo; fixture is unused
test('a real session renders natively in the live xterm (visual + screenshot)', async ({}, info) => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(400);
  const total = await win.locator('.session-item').count();
  if (total === 0) test.skip(true, 'No real History sessions on disk');

  // Open sessions until we land on one that actually has rendered
  // history (length > rows), then assert native markers + screenshot.
  let proven = false;
  for (let i = 0; i < Math.min(total, 6) && !proven; i += 1) {
    await win.locator('.ts-nav', { hasText: 'History' }).click();
    await win.waitForTimeout(300);
    const row = win.locator('.session-item').nth(i);
    await expect(row).toBeVisible({ timeout: 6_000 });
    await row.locator('.session-item__resume').click();
    const xterm = win.locator('.chat-tile .xterm').first();
    await expect(xterm).toBeVisible({ timeout: 15_000 });
    await awaitChatReady(win, 12_000).catch(() => undefined);
    await win.waitForTimeout(4_500);

    const buf = await win.evaluate(() => {
      const el = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
      const t = el ? (el as unknown as XtermInternals).__term : undefined;
      if (!t) return null;
      const b = t.buffer.active;
      const lines: string[] = [];
      for (let k = 0; k < b.length; k += 1) lines.push(b.getLine(k)?.translateToString(true) ?? '');
      return { text: lines.join('\n'), length: b.length, rows: t.rows };
    });

    if (buf && buf.length > buf.rows + 5) {
      await info.attach(`native-session-${i}.png`, {
        body: await xterm.screenshot(),
        contentType: 'image/png',
      });
      await info.attach(`native-session-${i}.txt`, {
        body: Buffer.from(buf.text.slice(-2500), 'utf8'),
        contentType: 'text/plain; charset=utf-8',
      });
      const native = buf.text.includes('●') || buf.text.includes('⎿') || /(^|\n)❯\s/.test(buf.text);
      expect(native, `session #${i} buffer lacks any native marker`).toBe(true);
      proven = true;
    }
    await closeAllChats(win);
    await win.waitForTimeout(400);
  }

  expect(proven, 'no real session had renderable history to verify').toBe(true);
});
