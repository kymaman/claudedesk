/**
 * orphan-reaper.ts
 *
 * Windows ConPTY leaves a conhost.exe pseudoconsole host per terminal.
 * When a previous app instance crashes (the recurring conpty.node
 * c0000374), its conhosts are orphaned — their parent pid is gone but the
 * host lingers, holding handles and memory. Over days of crash→restart
 * cycles hundreds pile up (observed: 125 conhost, app stutters) and only a
 * full reboot clears them. That is exactly why «перезагрузка компа
 * помогает» — it resets this OS-level layer, not anything in our JS.
 *
 * This reaper kills ONLY conhost hosts whose parent process is no longer
 * alive — a conhost with a dead parent owns nothing and is safe to kill.
 * It never touches conhosts of the running app (their parent electron/node
 * is alive), nor any other live process tree. The selection (the safety-
 * critical part) is a pure function so it is fully unit-tested.
 */

import { spawn } from 'child_process';

export interface ProcInfo {
  name: string;
  pid: number;
  ppid: number;
}

/**
 * Pids of conhost.exe whose parent is NOT in the live process set — i.e.
 * leaked hosts from crashed/previous instances. Pure & deterministic.
 */
export function selectOrphanConhostPids(procs: ProcInfo[]): number[] {
  const alive = new Set(procs.map((p) => p.pid));
  return procs
    .filter((p) => /^conhost\.exe$/i.test(p.name) && p.ppid > 0 && !alive.has(p.ppid))
    .map((p) => p.pid);
}

/** List all processes via PowerShell CIM (Windows only). Best-effort. */
function listWindowsProcesses(): Promise<ProcInfo[]> {
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation',
      ],
      { windowsHide: true },
    );
    let out = '';
    ps.stdout.on('data', (d) => (out += d.toString()));
    ps.on('error', () => resolve([]));
    ps.on('close', () => {
      const rows: ProcInfo[] = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"(.*)","(\d+)","(\d*)"$/);
        if (!m) continue; // header / blank
        rows.push({ name: m[1], pid: Number(m[2]), ppid: Number(m[3] || 0) });
      }
      resolve(rows);
    });
  });
}

/**
 * Reap orphaned conhosts. Injectable list/kill for tests; defaults hit the
 * real OS on win32 and no-op elsewhere. Returns how many were killed.
 */
export async function reapOrphanConhosts(opts?: {
  platform?: NodeJS.Platform;
  list?: () => Promise<ProcInfo[]>;
  kill?: (pid: number) => void;
}): Promise<number> {
  const platform = opts?.platform ?? process.platform;
  if (platform !== 'win32') return 0;
  const list = opts?.list ?? listWindowsProcesses;
  const kill =
    opts?.kill ??
    ((pid: number) => {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    });
  let procs: ProcInfo[];
  try {
    procs = await list();
  } catch {
    return 0;
  }
  const pids = selectOrphanConhostPids(procs);
  for (const pid of pids) kill(pid);
  return pids.length;
}
