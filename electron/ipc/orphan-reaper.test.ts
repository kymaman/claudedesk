/**
 * orphan-reaper.test.ts
 *
 * The reaper must kill ONLY conhost.exe hosts whose parent is dead — leaked
 * pseudoconsoles from crashed/previous app instances. It must NEVER touch a
 * conhost with a live parent (the running app's own terminals), nor any
 * non-conhost process. The selection is the safety-critical core.
 */

import { describe, it, expect, vi } from 'vitest';
import { selectOrphanConhostPids, reapOrphanConhosts, type ProcInfo } from './orphan-reaper.js';

describe('selectOrphanConhostPids', () => {
  it('selects conhost whose parent is NOT alive, leaves live-parent ones', () => {
    const procs: ProcInfo[] = [
      { name: 'electron.exe', pid: 100, ppid: 1 }, // live app
      { name: 'conhost.exe', pid: 200, ppid: 100 }, // parent alive → KEEP
      { name: 'conhost.exe', pid: 201, ppid: 999 }, // parent dead → KILL
      { name: 'conhost.exe', pid: 202, ppid: 888 }, // parent dead → KILL
    ];
    expect(selectOrphanConhostPids(procs).sort()).toEqual([201, 202]);
  });

  it('never selects a non-conhost process even with a dead parent', () => {
    const procs: ProcInfo[] = [
      { name: 'claude.exe', pid: 300, ppid: 777 }, // dead parent but NOT conhost
      { name: 'node.exe', pid: 301, ppid: 777 },
    ];
    expect(selectOrphanConhostPids(procs)).toEqual([]);
  });

  it('ignores a zero/invalid parent pid (system idle)', () => {
    const procs: ProcInfo[] = [{ name: 'conhost.exe', pid: 400, ppid: 0 }];
    expect(selectOrphanConhostPids(procs)).toEqual([]);
  });

  it('is case-insensitive on the process name', () => {
    const procs: ProcInfo[] = [{ name: 'ConHost.exe', pid: 500, ppid: 12345 }];
    expect(selectOrphanConhostPids(procs)).toEqual([500]);
  });
});

describe('reapOrphanConhosts', () => {
  it('no-ops on non-Windows platforms', async () => {
    const kill = vi.fn();
    const n = await reapOrphanConhosts({ platform: 'darwin', list: async () => [], kill });
    expect(n).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills exactly the orphaned conhost pids on win32', async () => {
    const kill = vi.fn();
    const procs: ProcInfo[] = [
      { name: 'electron.exe', pid: 10, ppid: 1 },
      { name: 'conhost.exe', pid: 11, ppid: 10 }, // live parent
      { name: 'conhost.exe', pid: 12, ppid: 9999 }, // orphan
    ];
    const n = await reapOrphanConhosts({ platform: 'win32', list: async () => procs, kill });
    expect(n).toBe(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(12);
  });

  it('survives a lister failure without throwing', async () => {
    const kill = vi.fn();
    const n = await reapOrphanConhosts({
      platform: 'win32',
      list: async () => {
        throw new Error('wmi down');
      },
      kill,
    });
    expect(n).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});
