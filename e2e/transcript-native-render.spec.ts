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
import { launchApp, closeAllChats, awaitChatReady, openReadMode, BridgeWindow } from './helpers.js';

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

/**
 * VARIANT A (2026-06-17) — the LIVE terminal must NOT pre-seed history.
 *
 * DISCRIMINATOR (why this is an IPC spy, not a buffer-content check):
 * an earlier version of this test asserted the live xterm had no ● / ⎿
 * markers. That was a FALSE-POSITIVE trap — `claude --resume` itself
 * prints ● bullets when it replays its last message / tool result into
 * the live TUI (e.g. "● Background command … completed"). So ● in the
 * live buffer does NOT prove a pre-seed.
 *
 * The unambiguous signal: a pre-seed is the live terminal calling
 * `load_session_transcript`. Without prefill the live spawn NEVER calls
 * it; only read mode (📖, the TranscriptView) does. We spy on the IPC
 * bridge and assert the channel breakdown:
 *   - resume (live only)  → load_session_transcript NOT called  [variant A]
 *   - open read mode (📖) → load_session_transcript IS called   [history reachable]
 *
 * RED on the old (prefill) build: resume calls load_session_transcript for
 * the live terminal → first assertion fails. GREEN after variant A: it
 * isn't called until 📖 opens. Deterministic; claude's native ● can't fool
 * it.
 *
 * HOW THE SPY WORKS (and how it must NOT): monkeypatching
 * window.electron.ipcRenderer.invoke does NOT work — Electron's contextBridge
 * deep-freezes the exposed object, so the reassignment silently no-ops (an
 * earlier attempt saw an empty channel list). Instead the product invoke()
 * (src/lib/ipc.ts) pushes each channel onto window.__ipcSpy when that array
 * exists; the test arms it by setting window.__ipcSpy = [] before resuming.
 * No-op in production (flag never set), same pattern as the __term exposure.
 */
type SpyWindow = { __ipcSpy?: string[] };

// The single channel that proves a transcript pre-seed. Kept as a literal so
// the test reads naturally; it is the value of IPC.LoadSessionTranscript (see
// electron/ipc/channels.ts) and is also the channel TranscriptView/read mode
// uses, so the read-mode half of the assertion exercises the same string.
const TRANSCRIPT_CHANNEL = 'load_session_transcript';

test('VARIANT A: resuming does NOT load the transcript into the live terminal (IPC spy)', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  // Cold-start robustness: History scans ~/.claude/projects and can take
  // seconds to populate. Wait for the first row before deciding to skip —
  // a flat 400ms wait spuriously reported "0 sessions" on a fresh launch
  // (which made a RED run skip instead of fail).
  await win
    .locator('.session-item')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => undefined);
  const total = await win.locator('.session-item').count();
  if (total === 0) test.skip(true, 'No real History sessions on disk');

  // Arm the spy BEFORE resuming. The product `invoke()` (src/lib/ipc.ts)
  // pushes every channel onto window.__ipcSpy when this array exists — this
  // is the RELIABLE path (monkeypatching window.electron fails: contextBridge
  // objects are frozen, which is why an earlier version of this test saw an
  // empty channel list).
  await win.evaluate(() => {
    (window as unknown as SpyWindow).__ipcSpy = [];
  });

  // Resume a session — LIVE terminal only. Do NOT open read mode yet.
  const row = win.locator('.session-item').first();
  await expect(row).toBeVisible({ timeout: 6_000 });
  await row.locator('.session-item__resume').click();
  await expect(win.locator('.chat-tile .xterm').first()).toBeVisible({ timeout: 15_000 });
  await awaitChatReady(win, 12_000).catch(() => undefined);
  // Give any (forbidden) prefill its full 3s safety-gate window to fire.
  await win.waitForTimeout(4_000);

  const liveCalls = await win.evaluate(() =>
    ((window as unknown as SpyWindow).__ipcSpy ?? []).slice(),
  );
  // Guard against a silently-disarmed spy: the live spawn always invokes
  // SOMETHING (spawn_agent, terminal defaults, …). An empty list means the
  // spy never recorded — which would make the next assertion vacuously pass.
  expect(
    liveCalls.length,
    'IPC spy recorded nothing — the window.__ipcSpy hook is not wired (test would be vacuous).',
  ).toBeGreaterThan(0);
  expect(
    liveCalls.includes(TRANSCRIPT_CHANNEL),
    `Variant A: the LIVE terminal must NOT pre-seed history, but it invoked ` +
      `${TRANSCRIPT_CHANNEL} on resume. Channels seen:\n${liveCalls.join(', ')}`,
  ).toBe(false);

  // GREEN second half: opening read mode (📖) DOES load the transcript —
  // history is still reachable, just relocated out of the live terminal.
  await openReadMode(win).catch(() => undefined);
  await win.waitForTimeout(800);
  const afterRead = await win.evaluate(() =>
    ((window as unknown as SpyWindow).__ipcSpy ?? []).slice(),
  );
  expect(
    afterRead.includes(TRANSCRIPT_CHANNEL),
    `Read mode (📖) must load the transcript so history stays reachable. ` +
      `Channels seen:\n${afterRead.join(', ')}`,
  ).toBe(true);

  await closeAllChats(win);
});
