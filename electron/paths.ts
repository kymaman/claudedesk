/**
 * paths.ts
 * Single place that resolves user-facing filesystem locations. Until this
 * module existed, modules used a mix of `os.homedir()`, `process.env.HOME`,
 * `app.getPath('userData')`, and the older `homeDir()` helper from
 * platform.ts — and they sometimes disagreed (a documented footgun on
 * Windows where USERPROFILE != HOME).
 *
 * The canonical entries:
 *   getHomeDir()            — user's home (cross-platform)
 *   getUserDataDir()        — Electron's per-user app dir
 *   getClaudeProjectsDir()  — ~/.claude/projects
 *   getAssistantDir()       — userData/assistant
 *   getWorkspacesDbPath()   — userData/workspaces.db
 *   getSessionAliasesDbPath() — userData/session-aliases.db
 *
 * Modules outside `electron/paths.ts` should NOT call os.homedir() or
 * app.getPath() directly — go through here. That keeps any future schema
 * migration (e.g. moving DBs to a sub-folder) a one-line change.
 */

import { app } from 'electron';
import os from 'os';
import path from 'path';

export function getHomeDir(): string {
  return os.homedir();
}

export function getUserDataDir(): string {
  return app.getPath('userData');
}

/** ~/.claude/projects — where the official Claude CLI stores session JSONLs. */
export function getClaudeProjectsDir(): string {
  return path.join(getHomeDir(), '.claude', 'projects');
}

/** userData/assistant — cwd of the "Ask" sidebar's spawned Claude. */
export function getAssistantDir(): string {
  return path.join(getUserDataDir(), 'assistant');
}

export function getWorkspacesDbPath(): string {
  return path.join(getUserDataDir(), 'workspaces.db');
}

export function getSessionAliasesDbPath(): string {
  return path.join(getUserDataDir(), 'session-aliases.db');
}
