/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures index into known-shaped child arrays */
import { describe, it, expect } from 'vitest';
import { PtyHostManager, type PtyHostChild } from './pty-host-manager.js';
import type { PtyMessage } from './pty-protocol.js';

/**
 * PtyHostManager is the crash-containment heart of process isolation: it owns
 * the node-pty host child and, when that child dies (the conpty.node heap
 * corruption, now non-fatal to the app), reports every live terminal as exited
 * and forks a fresh host. These pin that behaviour with a fake child — no real
 * utilityProcess.
 */

interface FakeChild extends PtyHostChild {
  posted: PtyMessage[];
  killed: boolean;
  emit(msg: PtyMessage): void;
  crash(): void;
}

function makeFakeChild(): FakeChild {
  let msgCb: ((m: PtyMessage) => void) | undefined;
  let exitCb: (() => void) | undefined;
  const child: FakeChild = {
    posted: [],
    killed: false,
    postMessage: (m) => child.posted.push(m),
    onMessage: (cb) => {
      msgCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: () => {
      child.killed = true;
    },
    emit: (m) => msgCb?.(m),
    crash: () => exitCb?.(),
  };
  return child;
}

function makeManager() {
  const children: FakeChild[] = [];
  const manager = new PtyHostManager(() => {
    const c = makeFakeChild();
    children.push(c);
    return c;
  });
  const fromHost: PtyMessage[] = [];
  manager.onMessage((m) => fromHost.push(m));
  return { manager, children, fromHost };
}

const spawn = (agentId: string): PtyMessage => ({
  type: 'spawn',
  opts: { agentId, command: 'claude', args: [], env: {}, cols: 80, rows: 24 },
});

describe('PtyHostManager', () => {
  it('forks a child up front and forwards posts to it', () => {
    const { manager, children } = makeManager();
    expect(children).toHaveLength(1);
    manager.post(spawn('a'));
    manager.post({ type: 'write', agentId: 'a', data: 'x' });
    expect(children[0]!.posted).toEqual([spawn('a'), { type: 'write', agentId: 'a', data: 'x' }]);
  });

  it('routes child messages to the registered sink', () => {
    const { manager, children, fromHost } = makeManager();
    manager.post(spawn('a'));
    children[0]!.emit({ type: 'data', agentId: 'a', data: 'hi' });
    expect(fromHost).toEqual([{ type: 'data', agentId: 'a', data: 'hi' }]);
  });

  it('on crash: reports every LIVE agent as exited, then forks a fresh child', () => {
    const { manager, children, fromHost } = makeManager();
    manager.post(spawn('a'));
    manager.post(spawn('b'));
    children[0]!.crash();

    // Both live agents get a synthetic exit so the session layer cleans up.
    expect(fromHost).toEqual([
      { type: 'exit', agentId: 'a', exitCode: -1 },
      { type: 'exit', agentId: 'b', exitCode: -1 },
    ]);
    expect(manager.restarts).toBe(1);
    expect(children).toHaveLength(2); // a fresh host is up

    // New spawns route to the NEW child, not the dead one.
    manager.post(spawn('c'));
    expect(children[1]!.posted).toEqual([spawn('c')]);
    expect(children[0]!.posted).toEqual([spawn('a'), spawn('b')]);
  });

  it('an agent that already exited is NOT re-reported on a later crash', () => {
    const { manager, children, fromHost } = makeManager();
    manager.post(spawn('a'));
    manager.post(spawn('b'));
    children[0]!.emit({ type: 'exit', agentId: 'a', exitCode: 0 }); // a exits normally
    fromHost.length = 0; // ignore the normal exit for this assertion

    children[0]!.crash();
    // Only b was still live.
    expect(fromHost).toEqual([{ type: 'exit', agentId: 'b', exitCode: -1 }]);
  });

  it('replace-on-respawn keeps a single live entry per agentId', () => {
    const { manager, children, fromHost } = makeManager();
    manager.post(spawn('a'));
    manager.post(spawn('a')); // respawn same id
    children[0]!.crash();
    expect(fromHost).toEqual([{ type: 'exit', agentId: 'a', exitCode: -1 }]); // once, not twice
  });

  it('crash with no live agents still restarts cleanly', () => {
    const { manager, children, fromHost } = makeManager();
    children[0]!.crash();
    expect(fromHost).toEqual([]);
    expect(manager.restarts).toBe(1);
    expect(children).toHaveLength(2);
  });

  it('shutdown kills the child and does NOT restart on its exit', () => {
    const { manager, children } = makeManager();
    manager.shutdown();
    expect(children[0]!.killed).toBe(true);
    children[0]!.crash(); // the kill triggers onExit
    expect(children).toHaveLength(1); // no resurrection
    expect(manager.restarts).toBe(0);
  });
});
