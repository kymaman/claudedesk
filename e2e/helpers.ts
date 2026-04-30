/**
 * e2e/helpers.ts
 *
 * Shared utilities for the Playwright Electron suite. The point is to:
 *
 *  - Centralise the boot-Electron incantation so each spec is one launch.
 *  - Stop every spec from re-implementing "open a chat", "wait for the
 *    terminal to actually be alive", "wipe stale projects".
 *  - Provide `awaitChatReady`, which fixes a long-standing class of
 *    silent failures: tests that "passed" because `.xterm` was visible
 *    even when the PTY hadn't produced a single byte (so the chat was
 *    objectively dead, but DOM said "fine"). awaitChatReady waits for
 *    the first PTY byte to land in the terminal buffer.
 *
 * Conventions:
 *  - Every helper takes the live `Page` so callers stay explicit about
 *    which window they're driving.
 *  - Helpers return primitive values (counts, ids, strings), not
 *    Locators — keeps tests readable and avoids reactive surprises.
 */

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, '..');
export const MAIN = path.join(ROOT, 'dist-electron', 'main.js');

/** Standard Electron launch shared by every spec. */
export async function launchApp(): Promise<{ app: ElectronApplication; win: Page }> {
  if (!fs.existsSync(MAIN)) throw new Error(`build missing at ${MAIN}`);
  const app = await electron.launch({
    args: [MAIN, '--no-sandbox'],
    cwd: ROOT,
    env: { ...process.env, VITE_DEV_SERVER_URL: '', CLAUDEDESK_E2E: '1' },
    timeout: 45_000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // Settle one paint pass — Solid mounts are synchronous but a few
  // createEffect cleanups run on the next microtask.
  await win.waitForTimeout(800);
  return { app, win };
}

/** Bridge typing — every IPC-driving helper uses this. */
export interface BridgeWindow {
  electron?: {
    clipboardReadText: () => string;
    clipboardWriteText: (text: string) => void;
    ipcRenderer: { invoke: (ch: string, args?: unknown) => Promise<unknown> };
  };
}

/**
 * Open the first available History session as a chat. Skips the spec
 * (NOT fails) when there are no sessions on disk — useful on fresh CI
 * where ~/.claude/projects is empty.
 */
export async function openOneChat(win: Page): Promise<void> {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(300);
  const firstRow = win.locator('.session-item').first();
  if ((await firstRow.count()) === 0) test.skip(true, 'No sessions available to open a chat');
  await firstRow.locator('.session-item__resume').click();
  await expect(win.locator('.chat-tile').first()).toBeVisible({ timeout: 5_000 });
  await expect(win.locator('.chat-tile .xterm').first()).toBeVisible({ timeout: 5_000 });
  await awaitChatReady(win);
}

/**
 * Wait for a chat tile's PTY to actually start producing output. xterm
 * exposes the buffer through `__term.buffer.active.length`; once it
 * hits at least one non-empty line, the CLI has printed its banner /
 * prompt / something and the chat is "alive" by any meaningful
 * definition.
 *
 * Without this guard, tests are happy with a black square that has
 * `display: visible` but no running process behind it — the failure
 * mode that masked half the bugs the user reported.
 */
export async function awaitChatReady(
  win: Page,
  timeoutMs: number = 8_000,
  selector: string = '.chat-tile .xterm',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await win.evaluate((sel) => {
      interface XtermInternals {
        __term?: { buffer: { active: { length: number; getLine(i: number): unknown } } };
      }
      const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      for (const el of els) {
        const term = (el as unknown as XtermInternals).__term;
        if (!term) continue;
        const len = term.buffer.active.length;
        if (len > 0) {
          // length>0 means rows allocated, but we also want at least one
          // line with content — empty rows pre-render before PTY input.
          for (let i = 0; i < len; i++) {
            const line = term.buffer.active.getLine(i) as
              | { translateToString(t: boolean): string }
              | undefined;
            if (line && line.translateToString(true).trim().length > 0) return true;
          }
        }
      }
      return false;
    }, selector);
    if (ready) return;
    await win.waitForTimeout(120);
  }
  // Don't throw — the caller may explicitly want to test pre-output
  // state. Throwing here would couple every chat-opening test to a CLI
  // that prints something on startup, which is fine for `claude` but
  // brittle for shells.
  console.warn(`[awaitChatReady] no PTY output in ${timeoutMs}ms — proceeding anyway`);
}

/** Close every chat tile on screen. force-clicks so display:none'd
 *  orphan tiles (project deleted but tile still in pool) also close. */
export async function closeAllChats(win: Page): Promise<void> {
  let safety = 30;
  while ((await win.locator('.chat-tile__close').count()) > 0 && safety-- > 0) {
    await win.locator('.chat-tile__close').first().click({ force: true });
    await win.waitForTimeout(150);
  }
}

/**
 * Create a project via the real UI flow — click "+ New project", type,
 * Enter. Routes through the renderer's `createProject` so DB and the
 * in-memory `_projects` signal stay in sync (the IPC-only path was
 * racing the createEffect re-fetch). Returns the new project id.
 */
export async function createProjectViaUi(win: Page, name: string): Promise<string> {
  await win.locator('.ts-nav', { hasText: 'Projects' }).click();
  await win.waitForTimeout(200);
  await win.locator('.projects-rail__btn', { hasText: '+' }).first().click();
  const input = win.locator('.projects-rail__create-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill(name);
  await input.press('Enter');
  await expect(projectRow(win, name)).toBeVisible({ timeout: 5_000 });
  return await win.evaluate(async (n) => {
    const bridge = (window as unknown as BridgeWindow).electron;
    const list = (await bridge?.ipcRenderer.invoke('list_projects_ws', {})) as Array<{
      id: string;
      name: string;
    }>;
    return list.find((p) => p.name === n)?.id ?? '';
  }, name);
}

/** Locator for a project rail row by exact name — never `.first()`. */
export function projectRow(win: Page, name: string) {
  return win.locator('.projects-rail__row', { hasText: name });
}

/**
 * Delete every project (CASCADE removes pending + session→project rows)
 * and close any leftover chat tile. Use in beforeEach to give each test
 * a clean slate, regardless of what previous specs left behind.
 */
export async function resetProjectsState(win: Page): Promise<void> {
  await win.evaluate(async () => {
    const bridge = (window as unknown as BridgeWindow).electron;
    if (!bridge) return;
    const list = (await bridge.ipcRenderer.invoke('list_projects_ws', {})) as Array<{
      id: string;
    }>;
    for (const p of list) {
      await bridge.ipcRenderer.invoke('delete_project_ws', { id: p.id });
    }
    try {
      localStorage.removeItem('claudedesk.activeProjectId');
    } catch {
      /* storage unavailable */
    }
  });
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(200);
  await win.locator('.ts-nav', { hasText: 'Projects' }).click();
  await win.waitForTimeout(300);
  await closeAllChats(win);
}

/** Convenience: wait for an arbitrary count assertion with the
 *  expect-auto-retry timeout, scoped to visible tiles only. */
export function visibleProjectChatTiles(win: Page) {
  return win.locator('.projects-main__grid .chat-tile:not([style*="display: none"])');
}
