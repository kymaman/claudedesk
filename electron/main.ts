import { app, BrowserWindow, crashReporter, session, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { registerAllHandlers } from './ipc/register.js';
import { killAllAgents, usePtyHostBackend } from './ipc/pty.js';
import { PtyHostManager } from './ipc/pty-host-manager.js';
import { forkPtyHostChild } from './ipc/pty-host-child.js';
import { stopAllPlanWatchers } from './ipc/plans.js';
import { stopAllStepsWatchers } from './ipc/steps.js';
import { IPC } from './ipc/channels.js';
import { resolveUserShell } from './user-shell.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Crash diagnostics
// ---------------------------------------------------------------------------
//
// The app previously captured NOTHING when it died: no crashReporter, no file
// log. A native heap-corruption crash (Windows c0000374) on "branch" therefore
// left only an opaque WER StackHash with no faulting module. We now:
//   1. start the local crashReporter so a minidump (.dmp) lands in
//      app.getPath('crashDumps') with the real faulting module/stack;
//   2. append a human-readable line to <userData>/crash.log on every
//      render/child-process death and uncaught main-process exception, so the
//      next reproduction is diagnosable without a debugger.
// Must run as early as possible — crashReporter.start has to precede the
// process work it instruments.

function crashLogPath(): string {
  try {
    return path.join(app.getPath('userData'), 'crash.log');
  } catch {
    return path.join(os.tmpdir(), 'claudedesk-crash.log');
  }
}

function appendCrashLog(line: string): void {
  try {
    fs.appendFileSync(crashLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best-effort: never let logging throw in a crash path */
  }
}

function setupCrashDiagnostics(): void {
  try {
    crashReporter.start({ submitURL: '', uploadToServer: false, compress: true });
  } catch (err) {
    appendCrashLog(`crashReporter.start failed: ${String(err)}`);
  }
  // A child process (GPU, utility, PID host for ConPTY, renderer host) dying
  // is exactly what a node-pty heap corruption looks like from the main side.
  app.on('child-process-gone', (_e, details) => {
    appendCrashLog(
      `child-process-gone type=${details.type} reason=${details.reason} ` +
        `exitCode=${details.exitCode}${details.name ? ` name=${details.name}` : ''}` +
        `${details.serviceName ? ` service=${details.serviceName}` : ''}`,
    );
  });
  app.on('render-process-gone', (_e, _wc, details) => {
    appendCrashLog(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  process.on('uncaughtException', (err) => {
    appendCrashLog(`uncaughtException: ${err?.stack ?? String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    appendCrashLog(`unhandledRejection: ${String(reason)}`);
  });
}

setupCrashDiagnostics();

// When launched from a .desktop file (e.g. AppImage), the environment is
// minimal — often just PATH=/usr/bin:/bin. Resolve the user's full
// login-interactive shell environment and merge it into process.env so
// spawned PTYs can find CLI tools (claude, codex, gemini, etc.) and
// inherit other expected variables (SSH_AGENT_LAUNCHER, KUBECONFIG, etc.).
//
// Uses -ilc (interactive + login) to source both .zprofile/.profile AND
// .zshrc/.bashrc, where version managers (nvm, volta, fnm) add to PATH.
// A perl one-liner dumps every env var as null-delimited key=value pairs,
// bounded by sentinel markers to isolate the data from noisy shell init.
//
// Trade-off: -i (interactive) triggers .zshrc side effects (compinit, conda,
// welcome messages). Login-only (-lc) would be quieter but would miss tools
// that are only added to PATH in .bashrc/.zshrc (e.g. nvm). We accept the
// side effects since the sentinel-based parsing discards all other output.
// Another trade-off: inheriting the *full* environment (rather than just PATH)
// can pull in large variables (certificates, tokens, kubeconfig). We set a
// generous maxBuffer and fall back to the original environment on failure.
//
// Skip vars that would alter Electron/Node runtime behavior if a user's shell
// rc sets them — those belong to our process, not the login shell.
const PROTECTED_ENV_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

function fixEnv(): void {
  if (process.platform === 'win32') return;
  try {
    const loginShell = resolveUserShell();
    const sentinel = '__PCODE_ENV__';
    const result = execFileSync(
      loginShell,
      [
        '-ilc',
        `printf '${sentinel}' && perl -e 'print "$_=$ENV{$_}\\0" for keys %ENV' && printf '${sentinel}'`,
      ],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
    );
    const startIdx = result.indexOf(sentinel);
    const endIdx = result.lastIndexOf(sentinel);
    if (startIdx === -1 || endIdx === -1 || startIdx === endIdx) return;

    const envBlock = result.slice(startIdx + sentinel.length, endIdx);
    for (const entry of envBlock.split('\0')) {
      if (!entry) continue;
      const eqIdx = entry.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = entry.slice(0, eqIdx);
      if (PROTECTED_ENV_KEYS.has(key)) continue;
      process.env[key] = entry.slice(eqIdx + 1);
    }
  } catch (err) {
    console.warn('[fixEnv] Failed to resolve login shell environment:', err);
  }
}

fixEnv();

// E2E isolation: Playwright launches set CLAUDEDESK_E2E=1. Point
// userData at a throwaway temp dir so test runs NEVER touch the real
// app state (open-chat persistence, aliases DB, workspaces DB,
// localStorage). Without this, every e2e spec leaked its open chats
// into the user's real app AND into the next spec's launch — tiles
// accumulated across launches until the 12-per-window cap, after which
// "Resume" opened a second window and specs failed with ".chat-tile
// never appeared". Must run before app.getPath('userData') is read.
if (process.env.CLAUDEDESK_E2E === '1') {
  const e2eUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedesk-e2e-'));
  app.setPath('userData', e2eUserData);
  app.on('quit', () => {
    try {
      fs.rmSync(e2eUserData, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is best-effort */
    }
  });
}

// Verify that preload.cjs ALLOWED_CHANNELS stays in sync with the IPC enum.
// Logs a warning in dev if they drift — catches mismatches before they hit users.
function verifyPreloadAllowlist(): void {
  try {
    const preloadPath = path.join(__dirname, '..', 'electron', 'preload.cjs');
    const preloadSrc = fs.readFileSync(preloadPath, 'utf8');
    const enumValues = new Set(Object.values(IPC));
    const hasChannel = (channel: string) =>
      preloadSrc.includes(`'${channel}'`) || preloadSrc.includes(`"${channel}"`);
    const missing = [...enumValues].filter((v) => !hasChannel(v));
    if (missing.length > 0) {
      console.warn(
        `[preload-sync] IPC channels missing from preload.cjs ALLOWED_CHANNELS: ${missing.join(', ')}`,
      );
    }
  } catch {
    // Preload file may not be readable in packaged app — skip check
  }
}

if (!app.isPackaged) verifyPreloadAllowlist();

let mainWindow: BrowserWindow | null = null;

function getIconPath(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png');
  }
  return path.join(__dirname, '..', 'build', 'icon.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: getIconPath(),
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerAllHandlers(mainWindow);

  // Open links in external browser instead of inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell
        .openExternal(url)
        .catch((e: unknown) => console.warn('[main] Failed to open external URL:', e));
    }
    return { action: 'deny' };
  });

  const devOrigin = process.env.VITE_DEV_SERVER_URL;
  let allowedOrigin: string | undefined;
  try {
    if (devOrigin) allowedOrigin = new URL(devOrigin).origin;
  } catch {
    // Malformed dev URL — skip origin allowlist
  }

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (allowedOrigin && url.startsWith(allowedOrigin)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell
        .openExternal(url)
        .catch((e: unknown) => console.warn('[main] Failed to open external URL:', e));
    }
  });

  // Inject CSS to make data-tauri-drag-region work in Electron
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.insertCSS(`
      [data-tauri-drag-region] { -webkit-app-region: drag; }
      [data-tauri-drag-region] button,
      [data-tauri-drag-region] input,
      [data-tauri-drag-region] select,
      [data-tauri-drag-region] textarea { -webkit-app-region: no-drag; }
    `);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    // Auto-open DevTools in development so renderer errors are visible.
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Surface renderer-side crashes and console errors in the main log.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer-gone]', details);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer][${level}] ${message} (${sourceId}:${line})`);
    }
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Process isolation (opt-in via CLAUDEDESK_PTY_HOST=1): run node-pty in a child
// utilityProcess so a conpty.node heap corruption kills only that process — the
// PtyHostManager reports the dead terminals and forks a fresh host, the app
// survives. Default (flag unset) keeps node-pty in-process, unchanged.
let ptyHostManager: PtyHostManager | null = null;
function initPtyHostIfEnabled(): void {
  if (process.env['CLAUDEDESK_PTY_HOST'] !== '1') return;
  try {
    ptyHostManager = new PtyHostManager(forkPtyHostChild);
    usePtyHostBackend(ptyHostManager);
    console.warn('[pty-host] process isolation ENABLED (node-pty in utilityProcess)');
  } catch (err) {
    console.error('[pty-host] failed to start; falling back to in-process node-pty:', err);
    ptyHostManager = null;
  }
}

app.whenReady().then(() => {
  // Run node-pty out of process BEFORE any agent spawns, when enabled.
  initPtyHostIfEnabled();

  // Grant microphone and clipboard access (deny camera/video)
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
        return callback(true);
      }
      if (permission === 'media') {
        const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
        return callback(types.every((t) => t === 'audio'));
      }
      callback(false);
    },
  );

  createWindow();
});

app.on('before-quit', () => {
  killAllAgents();
  // Tear the PTY host child down WITHOUT triggering a restart.
  ptyHostManager?.shutdown();
  stopAllPlanWatchers();
  stopAllStepsWatchers();
});

app.on('window-all-closed', () => {
  app.quit();
});
