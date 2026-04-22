/**
 * launch-settings.ts
 * Per-session launch options (agent version, extra flags, skip-permissions).
 * Persisted in SQLite via IPC and applied automatically on every resume.
 */

import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

export interface LaunchSettings {
  agentId: string;
  extraFlags: string[];
  skipPermissions: boolean;
}

export async function loadLaunchSettings(sessionId: string): Promise<LaunchSettings | null> {
  try {
    return await invoke<LaunchSettings | null>(IPC.GetLaunchSettings, { sessionId });
  } catch (err) {
    console.warn('[launch-settings] load failed:', err);
    return null;
  }
}

export async function saveLaunchSettings(
  sessionId: string,
  settings: LaunchSettings,
): Promise<void> {
  try {
    await invoke<undefined>(IPC.SetLaunchSettings, {
      sessionId,
      agentId: settings.agentId,
      extraFlags: settings.extraFlags,
      skipPermissions: settings.skipPermissions,
    });
  } catch (err) {
    console.warn('[launch-settings] save failed:', err);
  }
}
