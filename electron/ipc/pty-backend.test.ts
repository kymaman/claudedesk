/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures index into known-shaped spawn results */
import { describe, it, expect, vi } from 'vitest';
import type * as pty from 'node-pty';
import { LocalPtyBackend, type PtySpawnFn } from './pty-backend.js';

/**
 * LocalPtyBackend is the in-process node-pty seam (process-isolation Phase 1).
 * These pin that every operation routes to the right native handle, that data/
 * exit events are tagged by agentId, and — critically — that the replace-on-
 * respawn path doesn't let an old proc's late exit delete the fresh handle
 * (the same agentId-reuse race the session layer guards against).
 */

interface FakeProc {
  cols: number;
  rows: number;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData(cb: (d: string) => void): void;
  onExit(cb: (ev: { exitCode: number; signal?: number }) => void): void;
  emitData(d: string): void;
  emitExit(ev: { exitCode: number; signal?: number }): void;
}

function makeFakeProc(cols = 80, rows = 24): FakeProc {
  let dataCb: ((d: string) => void) | undefined;
  let exitCb: ((ev: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    cols,
    rows,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    emitData: (d) => dataCb?.(d),
    emitExit: (ev) => exitCb?.(ev),
  };
}

function makeBackend() {
  const procs: FakeProc[] = [];
  const spawnFn: PtySpawnFn = vi.fn((_cmd, _args, opts) => {
    const p = makeFakeProc(opts.cols, opts.rows);
    procs.push(p);
    return p as unknown as pty.IPty;
  });
  const backend = new LocalPtyBackend(spawnFn);
  return { backend, procs, spawnFn };
}

const baseSpawn = (agentId: string, cols = 100, rows = 30) => ({
  agentId,
  command: 'claude',
  args: ['--print'],
  cwd: '/work',
  env: {},
  cols,
  rows,
});

describe('LocalPtyBackend', () => {
  it('spawn registers a handle; has()/cols() reflect it', () => {
    const { backend, procs } = makeBackend();
    expect(backend.has('a')).toBe(false);
    backend.spawn(baseSpawn('a', 120, 40));
    expect(backend.has('a')).toBe(true);
    expect(backend.cols('a')).toBe(120);
    expect(procs).toHaveLength(1);
  });

  it('cols()/has() are safe for unknown agents', () => {
    const { backend } = makeBackend();
    expect(backend.has('ghost')).toBe(false);
    expect(backend.cols('ghost')).toBe(80);
  });

  it('write/resize/pause/resume/kill delegate to the agent’s handle', () => {
    const { backend, procs } = makeBackend();
    backend.spawn(baseSpawn('a'));
    const p = procs[0]!;
    backend.write('a', 'hi');
    backend.resize('a', 90, 25);
    backend.pause('a');
    backend.resume('a');
    backend.kill('a');
    expect(p.write).toHaveBeenCalledWith('hi');
    expect(p.resize).toHaveBeenCalledWith(90, 25);
    expect(p.pause).toHaveBeenCalledTimes(1);
    expect(p.resume).toHaveBeenCalledTimes(1);
    expect(p.kill).toHaveBeenCalledTimes(1);
  });

  it('ops on an unknown agent are silent no-ops (data-after-exit race)', () => {
    const { backend } = makeBackend();
    expect(() => {
      backend.write('ghost', 'x');
      backend.resize('ghost', 1, 1);
      backend.pause('ghost');
      backend.resume('ghost');
      backend.kill('ghost');
    }).not.toThrow();
  });

  it('routes data and exit tagged by agentId', () => {
    const { backend, procs } = makeBackend();
    const data: Array<[string, string]> = [];
    const exits: Array<[string, number]> = [];
    backend.setOnData((id, d) => data.push([id, d]));
    backend.setOnExit((id, ev) => exits.push([id, ev.exitCode]));

    backend.spawn(baseSpawn('a'));
    backend.spawn(baseSpawn('b'));
    procs[0]!.emitData('from-a');
    procs[1]!.emitData('from-b');
    expect(data).toEqual([
      ['a', 'from-a'],
      ['b', 'from-b'],
    ]);

    procs[0]!.emitExit({ exitCode: 7 });
    expect(exits).toEqual([['a', 7]]);
    expect(backend.has('a')).toBe(false);
    expect(backend.has('b')).toBe(true);
  });

  it('replace-on-respawn: an old proc’s late exit/data are swallowed (no-op)', () => {
    const { backend, procs } = makeBackend();
    const exits: string[] = [];
    const data: string[] = [];
    backend.setOnExit((id) => exits.push(id));
    backend.setOnData((id, d) => data.push(`${id}:${d}`));

    backend.spawn(baseSpawn('a')); // procs[0]
    backend.spawn(baseSpawn('a')); // procs[1] replaces it under the same id
    expect(backend.has('a')).toBe(true);

    procs[0]!.emitData('stale'); // old handle, late data
    procs[0]!.emitExit({ exitCode: 0, signal: 15 }); // old handle exits late
    expect(backend.has('a')).toBe(true); // new handle survives
    expect(exits).toEqual([]); // old exit did NOT fire (would tear down new session)
    expect(data).toEqual([]); // old data did NOT leak into the new session

    procs[1]!.emitData('live');
    procs[1]!.emitExit({ exitCode: 0 }); // the current handle exits
    expect(backend.has('a')).toBe(false);
    expect(exits).toEqual(['a']);
    expect(data).toEqual(['a:live']);
  });
});
