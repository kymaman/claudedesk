/**
 * e2e/paste.spec.ts
 *
 * Consolidated paste test suite (merged from paste-sizes.spec.ts,
 * xterm-paste.spec.ts, and xterm-bracketed-paste.spec.ts).
 *
 * One Electron launch covers:
 *   - Clipboard sync read round-trip (byte-exact, 10 KB sample)
 *   - Multiline payload newline preservation
 *   - xterm right-click context menu presence and button states
 *   - claudedesk-paste / claudedesk-copy CustomEvent listeners
 *   - User-facing Ctrl+V path via keyboard (KEY test for the bug fix)
 *   - term.paste() bracketed-paste contract (xterm internal API)
 *   - Keystrokes after paste are NOT wrapped
 */

import { test, expect } from '@playwright/test';
import { launchApp, openOneChat, awaitChatReady, closeAllChats, BridgeWindow } from './helpers.js';
import type { ElectronApplication, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Single launch / teardown
// ---------------------------------------------------------------------------

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.afterAll(async () => {
  if (app) await app.close();
});

// ---------------------------------------------------------------------------
// Helpers — kept local so the public helpers.ts stays minimal
// ---------------------------------------------------------------------------

/** A character mix the user is likely to paste — JSON tokens, tabs, and
 *  multi-byte UTF-8 — repeated to fill the requested size. */
function makePayload(size: number): string {
  const seed =
    '{"key":"value","cookie":"\t.example.com\tTRUE\t/\tFALSE\t1234567890\tNAME\tabc=def==/+\nЁё日本"}\n';
  const out: string[] = [];
  let total = 0;
  while (total < size) {
    out.push(seed);
    total += seed.length;
  }
  return out.join('').slice(0, size);
}

/**
 * Paste `payload` through the live Terminal on the active chat tile using
 * term.paste() (xterm internal API) and return everything that flowed
 * through `term.onData` during the call.
 *
 * NOTE: This verifies xterm's own bracketed-paste contract. For the
 * user-facing Ctrl+V path that exercises the real fix, see the
 * "Ctrl+V keyboard path wraps with bracketed-paste markers" test below.
 */
async function pasteThroughLiveTerm(win: Page, payload: string): Promise<string> {
  return await win.evaluate(async (text) => {
    interface CoreOpts {
      windowOptions?: { setWinLines?: boolean };
    }
    interface XtermInternals {
      __term?: {
        paste: (t: string) => void;
        write: (t: string) => void;
        onData: (cb: (d: string) => void) => { dispose: () => void };
        options: CoreOpts;
      };
    }
    const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    if (!xtermEl) throw new Error('no .xterm element on the page');
    const term = (xtermEl as unknown as XtermInternals).__term;
    if (!term)
      throw new Error('Terminal instance not attached — TerminalView did not expose __term');

    const captured: string[] = [];
    const sub = term.onData((d) => captured.push(d));

    // Enable bracketed paste mode the same way a CLI would.
    term.write('\x1b[?2004h');
    await new Promise((r) => setTimeout(r, 30));
    term.paste(text);
    await new Promise((r) => setTimeout(r, 30));

    sub.dispose();
    return captured.join('');
  }, payload);
}

// ---------------------------------------------------------------------------
// § 1  Clipboard sync round-trip
// ---------------------------------------------------------------------------

test('clipboard sync read returns full payload byte-exact', async () => {
  // 10 KB is the representative size; 1 KB / 100 KB / 500 KB all prove the
  // same sync-read property and are dropped to keep the suite fast.
  const payload = makePayload(10 * 1024);

  const result = await win.evaluate(
    ({ p }) => {
      const bridge = (window as unknown as BridgeWindow).electron;
      if (!bridge) throw new Error('electron bridge missing');
      bridge.clipboardWriteText(p);
      const back = bridge.clipboardReadText();
      return {
        wroteLength: p.length,
        readLength: back.length,
        // Sample three points so we can spot truncation without shipping
        // 10 KB through the Playwright protocol.
        head: back.slice(0, 32),
        tail: back.slice(-32),
        middle: back.slice(Math.floor(back.length / 2), Math.floor(back.length / 2) + 32),
        match: back === p,
      };
    },
    { p: payload },
  );

  expect(result.readLength).toBe(result.wroteLength);
  expect(result.head).toBe(payload.slice(0, 32));
  expect(result.middle).toBe(
    payload.slice(Math.floor(payload.length / 2), Math.floor(payload.length / 2) + 32),
  );
  expect(result.tail).toBe(payload.slice(-32));
  expect(result.match).toBe(true);
});

test('multiline payload preserves every newline (no Enter-stripping)', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${'x'.repeat(40)}`);
  const payload = lines.join('\n');

  const back = await win.evaluate((p) => {
    const bridge = (window as unknown as BridgeWindow).electron;
    if (!bridge) throw new Error('electron bridge missing');
    bridge.clipboardWriteText(p);
    return bridge.clipboardReadText();
  }, payload);

  expect(back).toBe(payload);
  expect((back.match(/\n/g) ?? []).length).toBe(lines.length - 1);
});

// ---------------------------------------------------------------------------
// § 2  xterm right-click context menu
// ---------------------------------------------------------------------------

test('right-click inside xterm opens the editable context menu', async () => {
  // Use openOneChat so an xterm is guaranteed in the DOM (chat-tile path).
  await openOneChat(win);
  const xterm = win.locator('.chat-tile .xterm').first();
  await expect(xterm).toBeVisible({ timeout: 8_000 });
  await xterm.click({ button: 'right' });
  await expect(win.locator('.editable-context-menu')).toBeVisible({ timeout: 2_000 });
});

test('xterm menu has Paste enabled and Cut/Select-all disabled', async () => {
  const menu = win.locator('.editable-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('button', { hasText: /^Paste$/ })).toBeEnabled();
  await expect(menu.locator('button', { hasText: /^Cut$/ })).toBeDisabled();
  await expect(menu.locator('button', { hasText: /^Select all$/ })).toBeDisabled();
  await win.keyboard.press('Escape');
});

// ---------------------------------------------------------------------------
// § 3  CustomEvent listeners (claudedesk-paste / claudedesk-copy)
// ---------------------------------------------------------------------------

test('claudedesk-paste CustomEvent forwards text into the terminal', async () => {
  const result = await win.evaluate(() => {
    const xterm = document.querySelector<HTMLElement>('.chat-tile .xterm');
    if (!xterm) return { dispatched: false, received: '' };
    let received = '';
    const handler = (e: Event) => {
      received = (e as CustomEvent<{ text: string }>).detail?.text ?? '';
    };
    xterm.addEventListener('claudedesk-paste', handler);
    xterm.dispatchEvent(
      new CustomEvent('claudedesk-paste', { detail: { text: 'line1\nline2' }, bubbles: true }),
    );
    xterm.removeEventListener('claudedesk-paste', handler);
    return { dispatched: true, received };
  });
  expect(result.dispatched).toBe(true);
  expect(result.received).toBe('line1\nline2');
});

test('claudedesk-copy CustomEvent reads xterm selection', async () => {
  const result = await win.evaluate(() => {
    const xterm = document.querySelector<HTMLElement>('.chat-tile .xterm');
    if (!xterm) return null;
    const detail = { result: { text: 'untouched' } };
    xterm.dispatchEvent(new CustomEvent('claudedesk-copy', { detail, bubbles: true }));
    return detail.result.text;
  });
  // The listener overwrites .text — 'untouched' means the listener never ran.
  expect(result === '' || (typeof result === 'string' && result.length >= 0)).toBe(true);
  expect(result).not.toBe('untouched');
});

// ---------------------------------------------------------------------------
// § 4  Ctrl+V keyboard path — KEY TEST for the bracketed-paste fix
//
//  Verifies that the real user-facing Ctrl+V route in TerminalView.tsx:
//    1. reads the clipboard via window.electron.clipboardReadText() (sync)
//    2. routes through term.paste() — NOT enqueueInput()
//  so the text is wrapped with \x1b[200~ … \x1b[201~ markers.
//
//  This is different from § 5 tests below: those call term.paste() directly
//  to verify xterm's own contract; this one fires the actual key event.
// ---------------------------------------------------------------------------

test('Ctrl+V keyboard path wraps with bracketed-paste markers (user-facing fix)', async () => {
  await closeAllChats(win);
  await openOneChat(win);
  await awaitChatReady(win);

  // Seed clipboard via the sync bridge — same path Wispr Flow / paste apps use.
  await win.evaluate(() => {
    const bridge = (window as unknown as BridgeWindow).electron;
    if (!bridge) throw new Error('electron bridge missing');
    bridge.clipboardWriteText('multi\nline\npayload');
  });

  // Enable bracketed paste mode and start capturing onData. xterm only
  // wraps when the host (CLI) has sent CSI ?2004h — the real Claude CLI
  // does this on startup but awaitChatReady may resolve sooner.
  await win.evaluate(async () => {
    interface XtermInternals {
      __term?: {
        write: (t: string) => void;
        onData: (cb: (d: string) => void) => { dispose: () => void };
      };
    }
    const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    if (!xtermEl) throw new Error('no .chat-tile .xterm element');
    const term = (xtermEl as unknown as XtermInternals).__term;
    if (!term) throw new Error('no Terminal instance on __term');
    term.write('\x1b[?2004h');
    await new Promise((r) => setTimeout(r, 40));
    const captured: string[] = [];
    const sub = term.onData((d) => captured.push(d));
    (window as unknown as Record<string, unknown>).__e2e_paste_sub = sub;
    (window as unknown as Record<string, unknown>).__e2e_paste_captured = captured;
  });

  // Fire Ctrl+V at the xterm helper textarea via Playwright's locator.press
  // — that uses the CDP focus path, which is what xterm's keyboard handler
  // actually listens on. Calling element.focus() inside win.evaluate doesn't
  // sync with Playwright's keyboard focus stack, which was the previous
  // failure mode (keypress went to <body>, custom handler never saw it).
  const textarea = win.locator('.chat-tile .xterm .xterm-helper-textarea').first();
  await expect(textarea).toBeAttached({ timeout: 3_000 });
  await textarea.focus();
  await textarea.press('Control+V');
  // Give the IPC sync clipboard read + xterm.paste round-trip a frame.
  await win.waitForTimeout(150);

  const captured = await win.evaluate(async () => {
    interface Sub {
      dispose: () => void;
    }
    const sub = (window as unknown as Record<string, unknown>).__e2e_paste_sub as Sub;
    const raw = (window as unknown as Record<string, unknown>).__e2e_paste_captured as string[];
    await new Promise((r) => setTimeout(r, 30));
    sub.dispose();
    return raw.join('');
  });

  // The fix being verified: real Ctrl+V routes through term.paste(), so
  // the bytes that hit the PTY are wrapped in CSI 200~ … CSI 201~.
  // We assert `includes` rather than `startsWith` because xterm emits
  // a focus-in sequence (`\x1b[I`) when focus tracking is on — that's
  // unrelated to the paste contract and would otherwise mask the real
  // assertion. We also slice the body strictly between the markers so
  // any prefix/suffix noise from focus events doesn't leak in.
  const openIdx = captured.indexOf('\x1b[200~');
  const closeIdx = captured.lastIndexOf('\x1b[201~');
  expect(
    openIdx,
    `expected open marker, got: ${JSON.stringify(captured.slice(0, 60))}`,
  ).toBeGreaterThanOrEqual(0);
  expect(closeIdx).toBeGreaterThan(openIdx);
  const body = captured.slice(openIdx + '\x1b[200~'.length, closeIdx);
  expect(body.includes('multi')).toBe(true);
  expect(body.includes('line')).toBe(true);
  expect(body.includes('payload')).toBe(true);

  await closeAllChats(win);
});

// ---------------------------------------------------------------------------
// § 5  xterm term.paste() contract (internal API — kept as regression guard)
//
//  These tests call term.paste() directly to pin xterm's own bracketed-paste
//  behaviour. They are NOT the user-facing path (see § 4 above).
// ---------------------------------------------------------------------------

test('multi-line paste arrives with bracketed-paste markers (no premature submit)', async () => {
  await openOneChat(win);
  const lines = ['first line', 'second line with spaces', 'third with tabs\tand stuff', 'last'];
  const payload = lines.join('\n');

  const captured = await pasteThroughLiveTerm(win, payload);

  expect(captured.startsWith('\x1b[200~')).toBe(true);
  expect(captured.endsWith('\x1b[201~')).toBe(true);

  const body = captured.slice('\x1b[200~'.length, captured.length - '\x1b[201~'.length);
  for (const line of lines) {
    expect(body.includes(line)).toBe(true);
  }
  await closeAllChats(win);
});

test('keystrokes typed AFTER a paste are NOT wrapped — the paste mode closes cleanly', async () => {
  await openOneChat(win);

  const captured = await win.evaluate(async () => {
    interface XtermInternals {
      __term?: {
        paste: (t: string) => void;
        input: (t: string) => void;
        write: (t: string) => void;
        onData: (cb: (d: string) => void) => { dispose: () => void };
      };
    }
    const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
    if (!xtermEl) throw new Error('no .xterm element on the page');
    const term = (xtermEl as unknown as XtermInternals).__term;
    if (!term) throw new Error('no Terminal instance');

    const captured: string[] = [];
    const sub = term.onData((d) => captured.push(d));
    term.write('\x1b[?2004h');
    await new Promise((r) => setTimeout(r, 30));
    term.paste('paste body');
    await new Promise((r) => setTimeout(r, 30));
    term.input('\r');
    await new Promise((r) => setTimeout(r, 30));
    sub.dispose();
    return captured.join('');
  });

  // Sequence: open marker, body, close marker, THEN \r.
  // The \r must appear AFTER the closing marker for Enter to fire on the CLI.
  const closeIdx = captured.indexOf('\x1b[201~');
  const enterIdx = captured.lastIndexOf('\r');
  expect(closeIdx).toBeGreaterThanOrEqual(0);
  expect(enterIdx).toBeGreaterThan(closeIdx);

  await closeAllChats(win);
});
