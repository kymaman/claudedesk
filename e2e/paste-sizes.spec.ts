/**
 * e2e/paste-sizes.spec.ts
 *
 * Empirical proof that the synchronous clipboard read path doesn't truncate
 * pasted content at any practical size. The user reported "pasted text is
 * missing characters" — the suspected culprits were:
 *   (a) navigator.clipboard.readText()'s permission flow returning partial
 *       content before resolving (we already replaced this with the sync
 *       Electron path in preload — see fix commit 61771a2).
 *   (b) some implicit cap inside our enqueue / xterm.paste pipeline.
 *
 * This spec covers (a) end-to-end: write a known payload to the system
 * clipboard via Electron's main-process `clipboard.writeText`, then read it
 * back through the preload bridge that the xterm Ctrl+V handler uses, and
 * assert byte-exact match for sizes the user might realistically paste
 * (config files, JSON dumps, base64 blobs).
 *
 * Running this against the live Electron build is the only meaningful check
 * — a unit-level test can't see clipboard quirks specific to Windows / macOS.
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

interface BridgeWindow {
  electron?: {
    clipboardReadText: () => string;
    clipboardWriteText: (text: string) => void;
  };
}

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

// Playwright has no test.each — declare each size as its own test so a
// failure surfaces the exact threshold instead of bundling everything.
for (const [label, size] of [
  ['1 KB', 1024],
  ['10 KB', 10 * 1024],
  ['100 KB', 100 * 1024],
  ['500 KB', 500 * 1024],
] as const) {
  test(`clipboard sync read returns the full ${label} payload byte-exact`, async () => {
    const payload = makePayload(size);

    const result = await win.evaluate(
      ({ p }) => {
        const bridge = (window as unknown as BridgeWindow).electron;
        if (!bridge) throw new Error('electron bridge missing');
        bridge.clipboardWriteText(p);
        const back = bridge.clipboardReadText();
        return {
          wroteLength: p.length,
          readLength: back.length,
          // Sample three points so we can spot truncation pattern without
          // shipping 500 KB through the Playwright protocol.
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
}

test('multiline payload preserves every newline (no Enter-stripping)', async () => {
  // The user reported "after I paste then Enter, Enter doesn't fire right
  // away." Adjacent worry: the paste might also strip embedded newlines.
  // Bracketed paste mode wraps the whole block, but each \n inside should
  // survive. This test pastes through the same sync bridge to confirm.
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${'x'.repeat(40)}`);
  const payload = lines.join('\n');

  const back = await win.evaluate((p) => {
    const bridge = (window as unknown as BridgeWindow).electron;
    if (!bridge) throw new Error('electron bridge missing');
    bridge.clipboardWriteText(p);
    return bridge.clipboardReadText();
  }, payload);

  expect(back).toBe(payload);
  // Newline count must match exactly — nothing is collapsed or merged.
  expect((back.match(/\n/g) ?? []).length).toBe(lines.length - 1);
});
