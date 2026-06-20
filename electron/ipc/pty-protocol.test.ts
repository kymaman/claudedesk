/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures index into known-shaped spawn results */
import { describe, it, expect, vi } from 'vitest';
import type * as pty from 'node-pty';
import type { PtySpawnFn } from './pty-backend.js';
import type { MessageTransport, PtyMessage } from './pty-protocol.js';
import { createPtyHost } from './pty-host.js';
import { RemotePtyBackend } from './pty-backend-remote.js';

/**
 * End-to-end protocol round-trip (process-isolation Phase 2a): a RemotePtyBackend
 * on the "main" side and a createPtyHost on the "host" side, wired by an in-memory
 * loopback. Proves commands reach a (fake) pty, events come back tagged by
 * agentId, the local cols/has mirror stays exact, and the replace-on-respawn
 * safety survives the wire — all without a real utilityProcess or ConPTY.
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

/** Two transports that deliver each other's posts synchronously. */
function makeLoopback(): { main: MessageTransport; host: MessageTransport } {
  let mainCb: ((m: PtyMessage) => void) | undefined;
  let hostCb: ((m: PtyMessage) => void) | undefined;
  const main: MessageTransport = {
    post: (m) => hostCb?.(m),
    onMessage: (cb) => {
      mainCb = cb;
    },
  };
  const host: MessageTransport = {
    post: (m) => mainCb?.(m),
    onMessage: (cb) => {
      hostCb = cb;
    },
  };
  return { main, host };
}

function setup() {
  const procs: FakeProc[] = [];
  const spawnFn: PtySpawnFn = vi.fn((_cmd, _args, opts) => {
    const p = makeFakeProc(opts.cols, opts.rows);
    procs.push(p);
    return p as unknown as pty.IPty;
  });
  const { main, host } = makeLoopback();
  createPtyHost(host, spawnFn); // host side: real LocalPtyBackend + fake pty
  const remote = new RemotePtyBackend(main); // main side
  const data: Array<[string, string]> = [];
  const exits: Array<[string, number]> = [];
  remote.setOnData((id, d) => data.push([id, d]));
  remote.setOnExit((id, ev) => exits.push([id, ev.exitCode]));
  return { remote, procs, data, exits };
}

const spawnOpts = (agentId: string, cols = 100) => ({
  agentId,
  command: 'claude',
  args: ['--print'],
  cwd: '/work',
  env: {},
  cols,
  rows: 30,
});

describe('PTY host protocol round-trip', () => {
  it('spawn reaches the host pty; remote has()/cols() mirror it synchronously', () => {
    const { remote, procs } = setup();
    expect(remote.has('a')).toBe(false);
    remote.spawn(spawnOpts('a', 120));
    expect(procs).toHaveLength(1);
    expect(remote.has('a')).toBe(true);
    expect(remote.cols('a')).toBe(120);
  });

  it('write/resize/pause/resume/kill ride the wire to the pty', () => {
    const { remote, procs } = setup();
    remote.spawn(spawnOpts('a'));
    const p = procs[0]!;
    remote.write('a', 'hello');
    remote.resize('a', 90, 25);
    remote.pause('a');
    remote.resume('a');
    remote.kill('a');
    expect(p.write).toHaveBeenCalledWith('hello');
    expect(p.resize).toHaveBeenCalledWith(90, 25);
    expect(p.pause).toHaveBeenCalledTimes(1);
    expect(p.resume).toHaveBeenCalledTimes(1);
    expect(p.kill).toHaveBeenCalledTimes(1);
  });

  it('resize updates the local cols mirror', () => {
    const { remote } = setup();
    remote.spawn(spawnOpts('a', 100));
    expect(remote.cols('a')).toBe(100);
    remote.resize('a', 140, 40);
    expect(remote.cols('a')).toBe(140);
  });

  it('data and exit come back tagged by agentId; exit clears the mirror', () => {
    const { remote, procs, data, exits } = setup();
    remote.spawn(spawnOpts('a'));
    remote.spawn(spawnOpts('b'));
    procs[0]!.emitData('from-a');
    procs[1]!.emitData('from-b');
    expect(data).toEqual([
      ['a', 'from-a'],
      ['b', 'from-b'],
    ]);

    procs[0]!.emitExit({ exitCode: 3 });
    expect(exits).toEqual([['a', 3]]);
    expect(remote.has('a')).toBe(false);
    expect(remote.has('b')).toBe(true);
  });

  it('replace-on-respawn: the old handle’s late exit/data never reach main', () => {
    const { remote, procs, data, exits } = setup();
    remote.spawn(spawnOpts('a')); // procs[0]
    remote.spawn(spawnOpts('a')); // procs[1] replaces under the same id
    expect(remote.has('a')).toBe(true);

    procs[0]!.emitData('stale');
    procs[0]!.emitExit({ exitCode: 0, signal: 15 }); // old, swallowed by host
    expect(data).toEqual([]);
    expect(exits).toEqual([]);
    expect(remote.has('a')).toBe(true);

    procs[1]!.emitData('live');
    procs[1]!.emitExit({ exitCode: 0 });
    expect(data).toEqual([['a', 'live']]);
    expect(exits).toEqual([['a', 0]]);
    expect(remote.has('a')).toBe(false);
  });

  it('unknown-agent cols/has are safe defaults', () => {
    const { remote } = setup();
    expect(remote.has('ghost')).toBe(false);
    expect(remote.cols('ghost')).toBe(80);
  });
});
