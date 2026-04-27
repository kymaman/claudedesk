/**
 * e2e/projects-pending-chats.spec.ts
 *
 * Pins down the "pending chat" persistence — the new SQLite-backed intent
 * store that lets fresh chats inside a project survive an app restart.
 * The Electron build is reused across tests; each case talks to the
 * workspaces.db via the existing IPC surface so we don't have to spawn
 * actual claude PTYs.
 *
 * Behavioural contract:
 *   - addPendingChat persists a row keyed by chat id
 *   - listPendingChats(projectId) returns every persisted row, ordered by
 *     creation time
 *   - removePendingChat drops the row
 *   - deleteProject cascades — pending rows for that project disappear
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

  // Clean any e2e-prefixed projects from previous runs so stale pending
  // rows don't pollute the assertions below.
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
      if (p.name.startsWith('e2e-pending-')) {
        await bridge.ipcRenderer.invoke('delete_project_ws', { id: p.id });
      }
    }
  });
});

test.afterAll(async () => {
  if (app) await app.close();
});

interface IpcBridge {
  ipcRenderer: { invoke: (ch: string, args?: unknown) => Promise<unknown> };
}

type WindowWithBridge = Window & { electron?: IpcBridge };

test('add → list returns the persisted intent row', async () => {
  const result = await win.evaluate(async () => {
    const bridge = (window as unknown as WindowWithBridge).electron;
    if (!bridge) throw new Error('electron bridge missing');
    const project = (await bridge.ipcRenderer.invoke('create_project_ws', {
      name: `e2e-pending-add-${Date.now().toString().slice(-5)}`,
    })) as { id: string };
    await bridge.ipcRenderer.invoke('add_pending_chat', {
      id: 'chat-uuid-1',
      projectId: project.id,
      cwd: 'D:/some/path',
      agentId: 'claude-opus-4-7',
      title: 'My pending',
      extraFlags: ['--model=opus'],
      skipPermissions: true,
    });
    const rows = (await bridge.ipcRenderer.invoke('list_pending_chats', {
      projectId: project.id,
    })) as Array<{
      id: string;
      cwd: string;
      agentId: string;
      title: string;
      extraFlags: string[];
      skipPermissions: boolean;
    }>;
    // Cleanup the test project (cascades to pending rows).
    await bridge.ipcRenderer.invoke('delete_project_ws', { id: project.id });
    return rows;
  });

  expect(result).toHaveLength(1);
  expect(result[0].id).toBe('chat-uuid-1');
  expect(result[0].cwd).toBe('D:/some/path');
  expect(result[0].agentId).toBe('claude-opus-4-7');
  expect(result[0].title).toBe('My pending');
  expect(result[0].extraFlags).toEqual(['--model=opus']);
  expect(result[0].skipPermissions).toBe(true);
});

test('remove drops the row but leaves siblings', async () => {
  const result = await win.evaluate(async () => {
    const bridge = (window as unknown as WindowWithBridge).electron;
    if (!bridge) throw new Error('electron bridge missing');
    const project = (await bridge.ipcRenderer.invoke('create_project_ws', {
      name: `e2e-pending-remove-${Date.now().toString().slice(-5)}`,
    })) as { id: string };
    for (const id of ['p1', 'p2', 'p3']) {
      await bridge.ipcRenderer.invoke('add_pending_chat', {
        id,
        projectId: project.id,
        cwd: '/tmp',
        agentId: 'claude-opus-4-7',
        title: id,
      });
    }
    await bridge.ipcRenderer.invoke('remove_pending_chat', { id: 'p2' });
    const rows = (await bridge.ipcRenderer.invoke('list_pending_chats', {
      projectId: project.id,
    })) as Array<{ id: string }>;
    await bridge.ipcRenderer.invoke('delete_project_ws', { id: project.id });
    return rows.map((r) => r.id).sort();
  });

  expect(result).toEqual(['p1', 'p3']);
});

test('deleteProject cascades — every pending row for that project goes away', async () => {
  const result = await win.evaluate(async () => {
    const bridge = (window as unknown as WindowWithBridge).electron;
    if (!bridge) throw new Error('electron bridge missing');
    const project = (await bridge.ipcRenderer.invoke('create_project_ws', {
      name: `e2e-pending-cascade-${Date.now().toString().slice(-5)}`,
    })) as { id: string };
    await bridge.ipcRenderer.invoke('add_pending_chat', {
      id: 'cascade-1',
      projectId: project.id,
      cwd: '/tmp',
      agentId: 'claude-opus-4-7',
      title: 'doomed',
    });
    await bridge.ipcRenderer.invoke('delete_project_ws', { id: project.id });
    const rows = (await bridge.ipcRenderer.invoke('list_pending_chats', {
      projectId: project.id,
    })) as unknown[];
    return rows.length;
  });

  expect(result).toBe(0);
});
