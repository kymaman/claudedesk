/**
 * e2e/pty-host-isolation.spec.ts
 *
 * Runtime proof for process isolation (CLAUDEDESK_PTY_HOST=1): node-pty runs in
 * an Electron utilityProcess, not the main process. The unit tests prove the
 * manager/protocol/backend logic; THIS proves the real thing end-to-end:
 *  1. a terminal spawned through the child streams its output to the renderer;
 *  2. killing the host child (simulating the conpty.node heap corruption that
 *     used to take down every window) leaves the APP ALIVE — the manager reports
 *     the dead terminals and forks a fresh host, and a new terminal works.
 *
 * The "host child exited unexpectedly — contained" log (emitted mid-test, so it
 * is reliably captured) is the authoritative signal that isolation is REAL and
 * not silently fallen back to the in-process backend.
 */

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import fs from 'fs';
import { ROOT, MAIN, openOneChat, closeAllChats, type BridgeWindow } from './helpers.js';

let app: ElectronApplication;
let win: Page;
const mainLogs: string[] = [];

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  if (!fs.existsSync(MAIN)) throw new Error(`build missing at ${MAIN}`);
  app = await electron.launch({
    args: [MAIN, '--no-sandbox'],
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: '',
      CLAUDEDESK_E2E: '1',
      CLAUDEDESK_PTY_HOST: '1', // <-- the whole point: run node-pty out of process
    },
    timeout: 45_000,
  });
  app.process().stdout?.on('data', (d: Buffer) => mainLogs.push(d.toString()));
  app.process().stderr?.on('data', (d: Buffer) => mainLogs.push(d.toString()));
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(800);
});

test.afterAll(async () => {
  if (app) await app.close();
});

/** Does any visible chat terminal hold non-empty output? */
async function anyTerminalHasOutput(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    interface XtermInternals {
      __term?: {
        buffer: {
          active: {
            length: number;
            getLine(i: number): { translateToString(t: boolean): string } | undefined;
          };
        };
      };
    }
    const els = Array.from(
      document.querySelectorAll('.chat-tile .xterm'),
    ) as unknown as XtermInternals[];
    for (const el of els) {
      const term = el.__term;
      if (!term) continue;
      for (let i = 0; i < term.buffer.active.length; i++) {
        const line = term.buffer.active.getLine(i);
        if (line && line.translateToString(true).trim().length > 0) return true;
      }
    }
    return false;
  });
}

/** Poll until a chat terminal streams output (a resumed CLI takes a few seconds
 *  to print — an instantaneous check flakes). */
async function waitForTerminalOutput(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await anyTerminalHasOutput(page)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/** Warm the History panel and wait for session rows to populate (reduces the
 *  "no sessions yet" skip race). Returns false if truly none on disk. */
async function ensureSessions(page: Page): Promise<boolean> {
  await page.locator('.ts-nav', { hasText: 'History' }).click();
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if ((await page.locator('.session-item').count()) > 0) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function appAlive(): Promise<boolean> {
  try {
    if (app.windows().length === 0) return false;
    return await win.evaluate(() => typeof document !== 'undefined' && !!document.body);
  } catch {
    return false;
  }
}

test('a terminal streams output through the utilityProcess host', async () => {
  test.skip(!(await ensureSessions(win)), 'no sessions on disk to resume');
  await openOneChat(win);
  expect(
    await waitForTerminalOutput(win),
    'no PTY output reached the renderer → utilityProcess wire is broken',
  ).toBe(true);
  expect(await appAlive()).toBe(true);
});

test('a host crash is CONTAINED — app survives, host restarts, a fresh terminal works', async () => {
  // Simulate the conpty.node heap corruption: kill the host child. In the old
  // in-process design this c0000374 took down every window.
  await win.evaluate(async () => {
    const b = (
      window as unknown as {
        electron?: { ipcRenderer: { invoke: (c: string) => Promise<unknown> } };
      }
    ).electron;
    await b?.ipcRenderer.invoke('__pty_host_crash_test');
  });
  await win.waitForTimeout(1000);

  // THE point: the main process is still alive after the host died.
  expect(await appAlive(), 'app died on host crash → containment FAILED').toBe(true);
  const n = await win.evaluate(async () => {
    const b = (window as unknown as BridgeWindow).electron;
    const list = (await b?.ipcRenderer.invoke('list_claude_sessions')) as unknown[];
    return Array.isArray(list) ? list.length : -1;
  });
  expect(n, 'IPC dead after host crash → main process died').toBeGreaterThanOrEqual(0);

  // Authoritative: the manager actually contained a real child crash (this log
  // is impossible if isolation silently fell back to the in-process backend).
  expect(mainLogs.join('\n')).toContain('host child exited unexpectedly — contained');

  // Recovery: the host restarted, so a brand-new terminal still streams.
  await closeAllChats(win);
  test.skip(!(await ensureSessions(win)), 'no sessions on disk to resume');
  await openOneChat(win);
  expect(await waitForTerminalOutput(win), 'no output after host restart → recovery FAILED').toBe(
    true,
  );
});
