/**
 * e2e/projects.spec.ts
 *
 * Consolidated suite for all Projects-tab behaviour. Single Electron launch
 * shared across 9 tests via beforeAll/afterAll. beforeEach resets state via
 * resetProjectsState so every test starts with a clean rail.
 *
 * Covers (in order):
 *  1. Projects tab appears in TopSwitcher
 *  2. Creating a project via the UI persists and auto-selects it
 *  3. Assigning a session to a project persists in list_session_project_map
 *  4. Deleting a project cascades and clears session memberships
 *  5. Project header exposes "+ new chat", "▶ open all", "✕" close buttons
 *  6. Switching between projects keeps chat tiles in DOM (display-toggle, no unmount)
 *  7. Projects → History → Projects keeps panel mounted (no PTY kill)
 *  8. Clicking the same project twice does NOT duplicate any tile
 *  9. "▶ open all" repeats are idempotent
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchApp,
  type BridgeWindow,
  createProjectViaUi,
  projectRow,
  resetProjectsState,
  visibleProjectChatTiles,
} from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.afterAll(async () => {
  if (app) await app.close();
});

test.beforeEach(async () => {
  await resetProjectsState(win);
});

// ---------------------------------------------------------------------------
// 1. Basic visibility
// ---------------------------------------------------------------------------

test('Projects tab appears in TopSwitcher', async () => {
  const projectsTab = win.locator('.ts-nav', { hasText: 'Projects' });
  await expect(projectsTab).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Create via UI
// ---------------------------------------------------------------------------

test('Creating a project via the UI persists and auto-selects it', async () => {
  const name = `prj-${Date.now().toString().slice(-6)}`;
  await createProjectViaUi(win, name);

  const row = projectRow(win, name);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await expect(row).toHaveClass(/projects-rail__row--active/);
  await expect(win.locator('.projects-main__title')).toHaveText(name);
});

// ---------------------------------------------------------------------------
// 3. Session-project assignment (IPC-driven; skipped when no sessions)
// ---------------------------------------------------------------------------

test('Assigning a session to a project persists in list_session_project_map', async () => {
  const probe = await win.evaluate(async () => {
    const bridge = (window as unknown as BridgeWindow).electron;
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

// ---------------------------------------------------------------------------
// 4. Delete cascade (IPC-driven; skipped when no sessions)
// ---------------------------------------------------------------------------

test('Deleting a project cascades and clears session memberships', async () => {
  const result = await win.evaluate(async () => {
    const bridge = (window as unknown as BridgeWindow).electron;
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

// ---------------------------------------------------------------------------
// 5. Project header buttons (from projects-isolation.spec.ts)
// ---------------------------------------------------------------------------

test('Project header exposes "+ new chat", "▶ open all", "✕" close buttons', async () => {
  const name = `pi-${Date.now().toString().slice(-6)}`;
  await createProjectViaUi(win, name);

  await projectRow(win, name).click();

  const head = win.locator('.projects-main__head');
  await expect(head).toBeVisible({ timeout: 4_000 });
  await expect(head.locator('button', { hasText: '▶ open all' })).toBeVisible();
  await expect(head.locator('button', { hasText: '+ new chat' })).toBeVisible();
  await expect(head.locator('button', { hasText: '✕' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 6. Display-toggle persistence across project switches (CRITICAL — bug fix)
// ---------------------------------------------------------------------------

test('Switching between projects keeps chat tiles in DOM (display-toggle, no unmount)', async () => {
  const aName = `pa-${Date.now().toString().slice(-5)}`;
  const bName = `pb-${Date.now().toString().slice(-5)}`;
  await createProjectViaUi(win, aName);
  await createProjectViaUi(win, bName);

  // Open project A and create a fresh chat in it.
  await projectRow(win, aName).click();
  await win.waitForTimeout(300);
  await win.locator('.projects-main__head button', { hasText: '+ new chat' }).click();
  await win.waitForTimeout(800);

  const allTiles = () => win.locator('.projects-main__grid .chat-tile');
  await expect(visibleProjectChatTiles(win)).toHaveCount(1, { timeout: 5_000 });
  await expect(allTiles()).toHaveCount(1);

  // Capture the tile's xterm element — same DOM node must survive project switches.
  const handleBefore = await win
    .locator('.projects-main__grid .chat-tile .xterm')
    .first()
    .elementHandle();
  expect(handleBefore).not.toBeNull();

  // Switch to project B — tile from A must stay in DOM (display:none).
  await projectRow(win, bName).click();
  await win.waitForTimeout(400);
  await expect(visibleProjectChatTiles(win)).toHaveCount(0);
  await expect(allTiles()).toHaveCount(1);
  const sameAfterSwitch = await win.evaluate(
    (h) => h === document.querySelector('.projects-main__grid .chat-tile .xterm'),
    handleBefore,
  );
  expect(sameAfterSwitch).toBe(true);

  // Switch back to A — same tile, no duplicate.
  await projectRow(win, aName).click();
  await win.waitForTimeout(400);
  await expect(visibleProjectChatTiles(win)).toHaveCount(1);
  const sameAfterReturn = await win.evaluate(
    (h) => h === document.querySelector('.projects-main__grid .chat-tile .xterm'),
    handleBefore,
  );
  expect(sameAfterReturn).toBe(true);
});

// ---------------------------------------------------------------------------
// 7. ProjectsPanel stays mounted across tab hops (no PTY kill)
// ---------------------------------------------------------------------------

test('Projects → History → Projects keeps panel mounted (no PTY kill)', async () => {
  const aName = `pp-${Date.now().toString().slice(-5)}`;
  await createProjectViaUi(win, aName);

  await projectRow(win, aName).click();
  await win.waitForTimeout(300);
  await win.locator('.projects-main__head button', { hasText: '+ new chat' }).click();
  await win.waitForTimeout(800);

  // Scope to the visible tile so display:none orphans from other tests are skipped.
  const xterm = win
    .locator('.projects-main__grid .chat-tile:not([style*="display: none"]) .xterm')
    .first();
  await expect(xterm).toBeVisible({ timeout: 5_000 });
  const handleBefore = await xterm.elementHandle();

  // Hop to History and back — ProjectsPanel must stay mounted.
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await win.waitForTimeout(400);
  await win.locator('.ts-nav', { hasText: 'Projects' }).click();
  await win.waitForTimeout(400);

  const same = await win.evaluate(
    (h) => h === document.querySelector('.projects-main__grid .chat-tile .xterm'),
    handleBefore,
  );
  expect(same).toBe(true);
});

// ---------------------------------------------------------------------------
// 8. No duplicate tiles on repeated row clicks
// ---------------------------------------------------------------------------

test('Clicking the same project twice does NOT duplicate any tile', async () => {
  const aName = `pdup-${Date.now().toString().slice(-5)}`;
  await createProjectViaUi(win, aName);
  const row = projectRow(win, aName);

  await row.click();
  await win.waitForTimeout(300);
  await win.locator('.projects-main__head button', { hasText: '+ new chat' }).click();
  await win.waitForTimeout(800);
  await expect(visibleProjectChatTiles(win)).toHaveCount(1);

  // Hammer the row — simulates user double/triple clicking.
  await row.click();
  await win.waitForTimeout(200);
  await row.click();
  await win.waitForTimeout(200);
  await row.click();
  await win.waitForTimeout(400);

  await expect(visibleProjectChatTiles(win)).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// 9. "▶ open all" is idempotent
// ---------------------------------------------------------------------------

test('"▶ open all" repeats are idempotent — never adds a second tile for the same chat', async () => {
  const aName = `pall-${Date.now().toString().slice(-5)}`;
  await createProjectViaUi(win, aName);
  await projectRow(win, aName).click();
  await win.waitForTimeout(300);
  await win.locator('.projects-main__head button', { hasText: '+ new chat' }).click();
  await win.waitForTimeout(800);
  await expect(visibleProjectChatTiles(win)).toHaveCount(1);

  const openAll = win.locator('.projects-main__head button', { hasText: '▶ open all' });
  await openAll.click();
  await win.waitForTimeout(400);
  await openAll.click();
  await win.waitForTimeout(400);
  await openAll.click();
  await win.waitForTimeout(400);

  await expect(visibleProjectChatTiles(win)).toHaveCount(1);
});
