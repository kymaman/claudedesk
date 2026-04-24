/**
 * e2e/projects.spec.ts
 * Locks the new Projects tab (v0.3.7) behavior:
 *   - A Projects tab shows up in TopSwitcher
 *   - Creating a project via Enter adds a row to the rail
 *   - Assigning a session to a project via IPC persists across list reload
 *   - Deleting a project drops its membership rows (FK cascade)
 *
 * We exercise the IPC layer directly for membership because Playwright's
 * HTML5 drag emulation is flaky on Windows Electron — the UI just calls
 * `assignSessionToProject` under the hood.
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

  // Clean up any stale e2e-prefixed projects from prior runs so the tests
  // below see a clean slate (Playwright keeps the userData dir across runs).
  await win.evaluate(async () => {
    const bridge = (
      window as unknown as {
        electron?: {
          ipcRenderer: { invoke: (ch: string, args?: unknown) => Promise<unknown> };
        };
      }
    ).electron;
    if (!bridge) return;
    const list = (await bridge.ipcRenderer.invoke('list_projects_ws', {})) as {
      id: string;
      name: string;
    }[];
    for (const p of list) {
      if (p.name.startsWith('prj-') || p.name.startsWith('e2e-')) {
        await bridge.ipcRenderer.invoke('delete_project_ws', { id: p.id });
      }
    }
  });
});

test.afterAll(async () => {
  if (app) await app.close();
});

test('Projects tab appears in TopSwitcher', async () => {
  const projectsTab = win.locator('.ts-nav', { hasText: 'Projects' });
  await expect(projectsTab).toBeVisible();
});

test('Creating a project from the rail persists and auto-selects it', async () => {
  await win.locator('.ts-nav', { hasText: 'Projects' }).click();
  await win.waitForTimeout(400);
  await expect(win.locator('.projects-panel')).toBeVisible({ timeout: 5_000 });

  const name = `prj-${Date.now().toString().slice(-6)}`;
  // Open the inline create input
  await win.locator('.projects-rail__btn', { hasText: '+' }).first().click();
  const input = win.locator('.projects-rail__create-input');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');

  const row = win.locator('.projects-rail__row', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5_000 });
  // auto-selected after create
  await expect(row).toHaveClass(/projects-rail__row--active/);

  // Header shows the project name
  await expect(win.locator('.projects-main__title')).toHaveText(name);

  // Clean up — use the row's × button
  await row.locator('.projects-rail__row-x').click();
  // Accept the confirm dialog we show
  win.once('dialog', (d) => d.accept().catch(() => undefined));
});

test('Assigning a session to a project is reflected in list_session_project_map', async () => {
  const probe = await win.evaluate(async () => {
    const bridge = (
      window as unknown as {
        electron?: {
          ipcRenderer: { invoke: (ch: string, args?: unknown) => Promise<unknown> };
        };
      }
    ).electron;
    if (!bridge) throw new Error('electron bridge missing');

    const sessions = (await bridge.ipcRenderer.invoke('list_claude_sessions', {})) as {
      sessionId: string;
    }[];
    if (sessions.length === 0) return null;
    const sid = sessions[0].sessionId;

    const project = (await bridge.ipcRenderer.invoke('create_project_ws', {
      name: `e2e-assign-${Date.now().toString().slice(-5)}`,
    })) as { id: string };

    await bridge.ipcRenderer.invoke('assign_session_to_project', {
      sessionId: sid,
      projectId: project.id,
    });

    const map = (await bridge.ipcRenderer.invoke('list_session_project_map', {})) as Record<
      string,
      string
    >;

    const inProject = (await bridge.ipcRenderer.invoke('list_sessions_in_project', {
      projectId: project.id,
    })) as string[];

    // Unassign so we can also validate removal
    await bridge.ipcRenderer.invoke('assign_session_to_project', {
      sessionId: sid,
      projectId: null,
    });
    const mapAfter = (await bridge.ipcRenderer.invoke('list_session_project_map', {})) as Record<
      string,
      string
    >;

    // Clean up
    await bridge.ipcRenderer.invoke('delete_project_ws', { id: project.id });

    return {
      sid,
      projectId: project.id,
      mappedBefore: map[sid] ?? null,
      sessionsInProject: inProject,
      mappedAfter: mapAfter[sid] ?? null,
    };
  });

  test.skip(!probe, 'no sessions on disk to exercise project assignment');
  const p = probe as {
    sid: string;
    projectId: string;
    mappedBefore: string | null;
    sessionsInProject: string[];
    mappedAfter: string | null;
  };
  expect(p.mappedBefore).toBe(p.projectId);
  expect(p.sessionsInProject).toContain(p.sid);
  expect(p.mappedAfter).toBeNull();
});

test('Deleting a project cascades and clears session memberships (FK cascade)', async () => {
  const result = await win.evaluate(async () => {
    const bridge = (
      window as unknown as {
        electron?: {
          ipcRenderer: { invoke: (ch: string, args?: unknown) => Promise<unknown> };
        };
      }
    ).electron;
    if (!bridge) throw new Error('electron bridge missing');

    const sessions = (await bridge.ipcRenderer.invoke('list_claude_sessions', {})) as {
      sessionId: string;
    }[];
    if (sessions.length === 0) return null;
    const sid = sessions[0].sessionId;

    const project = (await bridge.ipcRenderer.invoke('create_project_ws', {
      name: `e2e-cascade-${Date.now().toString().slice(-5)}`,
    })) as { id: string };

    await bridge.ipcRenderer.invoke('assign_session_to_project', {
      sessionId: sid,
      projectId: project.id,
    });

    await bridge.ipcRenderer.invoke('delete_project_ws', { id: project.id });

    // Membership row must have been cascade-deleted
    const map = (await bridge.ipcRenderer.invoke('list_session_project_map', {})) as Record<
      string,
      string
    >;
    return { sid, mapped: map[sid] ?? null };
  });

  test.skip(!result, 'no sessions to exercise cascade on');
  const r = result as { sid: string; mapped: string | null };
  expect(r.mapped).toBeNull();
});
