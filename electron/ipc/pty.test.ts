import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileSync, mockExecFile, mockChildProcessSpawn, mockPtySpawn } = vi.hoisted(() => {
  const mockExecFileSync = vi.fn((command: string, args?: string[]) => {
    const isLookupTool = command === 'which' || command === 'where.exe';
    if (isLookupTool && args?.[0] === 'nonexistent-binary-xyz') {
      throw new Error('not found');
    }
    return '';
  });

  const mockExecFile = vi.fn();
  const mockChildProcessSpawn = vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  }));

  const mockPtySpawn = vi.fn(
    (_command: string, _args: string[], options: { cols: number; rows: number }) => {
      let onDataHandler: ((data: string) => void) | undefined;
      let onExitHandler:
        | ((event: { exitCode: number; signal: number | undefined }) => void)
        | undefined;

      const proc = {
        cols: options.cols,
        rows: options.rows,
        write: vi.fn(),
        resize: vi.fn((cols: number, rows: number) => {
          proc.cols = cols;
          proc.rows = rows;
        }),
        pause: vi.fn(),
        resume: vi.fn(),
        kill: vi.fn(() => {
          onExitHandler?.({ exitCode: 0, signal: 15 });
        }),
        onData: vi.fn((handler: (data: string) => void) => {
          onDataHandler = handler;
        }),
        onExit: vi.fn(
          (handler: (event: { exitCode: number; signal: number | undefined }) => void) => {
            onExitHandler = handler;
          },
        ),
        emitData(data: string) {
          onDataHandler?.(data);
        },
        emitExit(event: { exitCode: number; signal: number | undefined }) {
          onExitHandler?.(event);
        },
      };

      return proc;
    },
  );

  return { mockExecFileSync, mockExecFile, mockChildProcessSpawn, mockPtySpawn };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: mockExecFileSync,
    execFile: mockExecFile,
    spawn: mockChildProcessSpawn,
  };
});

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn,
}));

import {
  __setLifecycleGuardMsForTests,
  __setSpawnStaggerMsForTests,
  buildDockerImage,
  DOCKER_CONTAINER_HOME,
  dockerImageExists,
  hashDockerfile,
  killAgent,
  killAllAgents,
  projectImageTag,
  resizeAgent,
  resolveProjectDockerfile,
  spawnAgent,
  spawnAgentSerialized,
  validateCommand,
  writeToAgent,
} from './pty.js';

let tempPaths: string[] = [];
let agentCounter = 0;

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  } as unknown as BrowserWindow;
}

function nextAgentId(): string {
  agentCounter += 1;
  return `agent-${agentCounter}`;
}

function buildSpawnArgs(
  overrides: Partial<Parameters<typeof spawnAgent>[1]> = {},
): Parameters<typeof spawnAgent>[1] {
  return {
    taskId: 'task-1',
    agentId: nextAgentId(),
    command: 'claude',
    args: ['--print', 'hello'],
    cwd: '/workspace/project',
    env: {},
    cols: 120,
    rows: 40,
    dockerMode: true,
    dockerImage: 'parallel-code-agent:test',
    onOutput: { __CHANNEL_ID__: 'channel-1' },
    ...overrides,
  };
}

function getLastSpawnCall(): {
  command: string;
  args: string[];
  options: {
    cols: number;
    rows: number;
    cwd?: string;
    env: Record<string, string>;
    name: string;
  };
} {
  const lastCall = mockPtySpawn.mock.lastCall;
  expect(lastCall).toBeTruthy();
  const [command, args, options] = lastCall as [
    string,
    string[],
    { cols: number; rows: number; cwd?: string; env: Record<string, string>; name: string },
  ];
  return { command, args, options };
}

function getFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === flag) {
      values.push(args[i + 1]);
    }
  }
  return values;
}

function makeTempHome(entries: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-docker-home-'));
  tempPaths.push(home);

  for (const entry of entries) {
    const target = path.join(home, entry);
    if (entry.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'test');
    }
  }

  return home;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  tempPaths = [];
});

afterEach(() => {
  killAllAgents();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const tempPath of tempPaths) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
  tempPaths = [];
});

describe('DOCKER_CONTAINER_HOME', () => {
  it('uses a home directory writable by arbitrary host-mapped docker users', () => {
    expect(DOCKER_CONTAINER_HOME).toBe('/tmp');
  });
});

describe('spawnAgent docker mode', () => {
  it('injects HOME=/tmp into docker run args', () => {
    vi.stubEnv('HOME', '/Users/tester');

    spawnAgent(createMockWindow(), buildSpawnArgs());

    const { command, args } = getLastSpawnCall();
    expect(command).toBe('docker');
    expect(getFlagValues(args, '-e')).toContain(`HOME=${DOCKER_CONTAINER_HOME}`);
  });

  it('does not forward host or renderer HOME as a generic docker env flag', () => {
    const hostHome = '/Users/host-home';
    const rendererHome = '/Users/renderer-home';
    vi.stubEnv('HOME', hostHome);

    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        env: {
          API_KEY: 'secret',
          HOME: rendererHome,
        },
      }),
    );

    const envFlags = getFlagValues(getLastSpawnCall().args, '-e');
    expect(envFlags).toContain('API_KEY=secret');
    expect(envFlags.filter((value) => value.startsWith('HOME='))).toEqual([
      `HOME=${DOCKER_CONTAINER_HOME}`,
    ]);
    expect(envFlags).not.toContain(`HOME=${hostHome}`);
    expect(envFlags).not.toContain(`HOME=${rendererHome}`);
  });

  it('redirects credential mounts under /tmp inside the container', () => {
    const home = makeTempHome(['.ssh/', '.gitconfig', '.config/gh/']);
    vi.stubEnv('HOME', home);

    spawnAgent(createMockWindow(), buildSpawnArgs());

    const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
    expect(volumeFlags).toContain(`${home}/.ssh:${DOCKER_CONTAINER_HOME}/.ssh:ro`);
    expect(volumeFlags).toContain(`${home}/.gitconfig:${DOCKER_CONTAINER_HOME}/.gitconfig:ro`);
    expect(volumeFlags).toContain(`${home}/.config/gh:${DOCKER_CONTAINER_HOME}/.config/gh:ro`);
  });
});

/** Spawn a non-docker agent and return its id + the mock pty proc. */
function spawnLocalAgent(): { agentId: string; proc: ReturnType<typeof mockPtySpawn> } {
  const agentId = nextAgentId();
  spawnAgent(createMockWindow(), buildSpawnArgs({ agentId, dockerMode: false }));
  const results = mockPtySpawn.mock.results;
  const last = results[results.length - 1];
  expect(last).toBeTruthy();
  const proc = (last as { value: ReturnType<typeof mockPtySpawn> }).value;
  return { agentId, proc };
}

describe('resize/write native-call guards (heap-corruption hardening)', () => {
  // Close the post-lifecycle guard window so these assert the IMMEDIATE
  // resize path deterministically on any host OS (Windows defaults to 150ms).
  beforeEach(() => __setLifecycleGuardMsForTests(0));

  const spawnLocal = spawnLocalAgent;

  it('does NOT resize a PTY after its process has exited', () => {
    const { agentId, proc } = spawnLocal();
    proc.emitExit({ exitCode: 0, signal: undefined });
    // Session is deleted on exit, so resize throws "not found" — the point is
    // the native resize is never called on a dead handle.
    expect(() => resizeAgent(agentId, 100, 40)).toThrow(/not found/i);
    expect(proc.resize).not.toHaveBeenCalled();
  });

  it('drops a bogus 0×0 resize snapshot instead of forwarding it', () => {
    const { agentId, proc } = spawnLocal();
    resizeAgent(agentId, 0, 0);
    resizeAgent(agentId, 0, 40);
    resizeAgent(agentId, 120, 0);
    expect(proc.resize).not.toHaveBeenCalled();
  });

  it('drops non-finite / negative dims', () => {
    const { agentId, proc } = spawnLocal();
    resizeAgent(agentId, Number.NaN, 40);
    resizeAgent(agentId, -5, 40);
    resizeAgent(agentId, 120, Infinity);
    expect(proc.resize).not.toHaveBeenCalled();
  });

  it('forwards a valid resize, flooring fractional dims', () => {
    const { agentId, proc } = spawnLocal();
    resizeAgent(agentId, 120.9, 40.2);
    expect(proc.resize).toHaveBeenCalledWith(120, 40);
  });

  it('clamps absurdly large dims to a sane ceiling', () => {
    const { agentId, proc } = spawnLocal();
    resizeAgent(agentId, 99999, 40);
    expect(proc.resize).toHaveBeenCalledWith(4000, 40);
  });

  it('does NOT write to a PTY after exit (no throw, just a no-op)', () => {
    const { agentId, proc } = spawnLocal();
    // Re-fetch via map indirectly: writeToAgent on a live session writes.
    writeToAgent(agentId, 'hello');
    expect(proc.write).toHaveBeenCalledTimes(1);
    proc.emitExit({ exitCode: 0, signal: undefined });
    // After exit the session is gone → writeToAgent throws not-found rather
    // than touching the freed handle.
    expect(() => writeToAgent(agentId, 'world')).toThrow(/not found/i);
    expect(proc.write).toHaveBeenCalledTimes(1);
  });
});

describe('branch resize-storm de-confliction (ConPTY heap-corruption fix)', () => {
  // A crash dump (c0000374) proved a *branch* corrupts the ConPTY heap: the
  // new tile's `pty.spawn` (a ConPTY connect on a background thread) races the
  // grid-reflow resize storm firing into conpty.node from other threads. The
  // fix opens a guard window after every spawn/kill during which sibling
  // resizes are DEFERRED + coalesced, then drained one at a time — so they
  // never re-enter conpty.node alongside a spawn/teardown. These tests assert
  // exactly that scheduling. Use a small, explicit window for determinism.
  beforeEach(() => __setLifecycleGuardMsForTests(60));
  afterEach(async () => {
    // Drain any staggered timers, then restore the default so later describes
    // are untouched.
    await new Promise((r) => setTimeout(r, 200));
    __setLifecycleGuardMsForTests(0);
  });

  it('defers a sibling resize fired during the post-spawn guard window', async () => {
    const sib = spawnLocalAgent(); // alive before the branch
    sib.proc.resize.mockClear();
    spawnLocalAgent(); // the branch spawn → opens the guard window
    // The reflow resizes the sibling — must NOT touch conpty.node yet.
    resizeAgent(sib.agentId, 100, 30);
    expect(sib.proc.resize).not.toHaveBeenCalled();
    // After the window the deferred resize drains through.
    await new Promise((r) => setTimeout(r, 130));
    expect(sib.proc.resize).toHaveBeenCalledWith(100, 30);
  });

  it('coalesces to the LATEST dims per agent while deferred', async () => {
    const sib = spawnLocalAgent();
    sib.proc.resize.mockClear();
    spawnLocalAgent(); // open window
    resizeAgent(sib.agentId, 80, 24);
    resizeAgent(sib.agentId, 100, 30);
    resizeAgent(sib.agentId, 120, 40); // latest wins
    expect(sib.proc.resize).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 130));
    expect(sib.proc.resize).toHaveBeenCalledTimes(1);
    expect(sib.proc.resize).toHaveBeenCalledWith(120, 40);
  });

  it('drains multiple agents (not all in one synchronous burst)', async () => {
    const a = spawnLocalAgent();
    const b = spawnLocalAgent();
    a.proc.resize.mockClear();
    b.proc.resize.mockClear();
    spawnLocalAgent(); // freshest spawn → open window
    resizeAgent(a.agentId, 100, 30);
    resizeAgent(b.agentId, 110, 35);
    expect(a.proc.resize).not.toHaveBeenCalled();
    expect(b.proc.resize).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 220));
    expect(a.proc.resize).toHaveBeenCalledWith(100, 30);
    expect(b.proc.resize).toHaveBeenCalledWith(110, 35);
  });

  it('kill also opens the guard window (resize deferred during teardown)', async () => {
    const sib = spawnLocalAgent();
    const victim = spawnLocalAgent();
    sib.proc.resize.mockClear();
    killAgent(victim.agentId); // ConPTY teardown → opens window
    resizeAgent(sib.agentId, 90, 28);
    expect(sib.proc.resize).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 130));
    expect(sib.proc.resize).toHaveBeenCalledWith(90, 28);
  });

  it('still drops a bogus 0×0 snapshot even inside the guard window', async () => {
    const sib = spawnLocalAgent();
    sib.proc.resize.mockClear();
    spawnLocalAgent(); // open window
    resizeAgent(sib.agentId, 0, 0);
    await new Promise((r) => setTimeout(r, 130));
    expect(sib.proc.resize).not.toHaveBeenCalled();
  });

  it('never resizes a sibling that exited before the deferred drain ran', async () => {
    const sib = spawnLocalAgent();
    sib.proc.resize.mockClear();
    spawnLocalAgent(); // open window
    resizeAgent(sib.agentId, 100, 30); // deferred
    sib.proc.emitExit({ exitCode: 0, signal: undefined }); // sibling dies first
    await new Promise((r) => setTimeout(r, 130));
    expect(sib.proc.resize).not.toHaveBeenCalled();
  });
});

describe('spawnAgentSerialized (mass-restore startup crash fix)', () => {
  // Restoring many tiles at once must NOT fire N concurrent ConPTY connects.
  // The serialiser runs one native spawn at a time with a gap between.
  beforeEach(() => __setSpawnStaggerMsForTests(50));
  afterEach(() => __setSpawnStaggerMsForTests(0));

  it('runs spawns one at a time: the second waits for the first + the gap', async () => {
    const before = mockPtySpawn.mock.calls.length;
    // Fire two in the SAME tick, as a mass restore does — both must defer.
    const pA = spawnAgentSerialized(
      createMockWindow(),
      buildSpawnArgs({ agentId: nextAgentId(), dockerMode: false }),
    );
    const pB = spawnAgentSerialized(
      createMockWindow(),
      buildSpawnArgs({ agentId: nextAgentId(), dockerMode: false }),
    );
    // Neither native spawn has run yet (both queued onto the microtask chain).
    expect(mockPtySpawn.mock.calls.length).toBe(before);

    await pA;
    // First has spawned; the second is still serving out the stagger gap.
    expect(mockPtySpawn.mock.calls.length).toBe(before + 1);

    await pB;
    expect(mockPtySpawn.mock.calls.length).toBe(before + 2);
  });

  it('a failing spawn does not wedge later spawns in the queue', async () => {
    const before = mockPtySpawn.mock.calls.length;
    // Unresolvable command → validateCommand throws inside spawnAgent → this
    // promise rejects, but the chain must keep flowing for the next spawn.
    const bad = spawnAgentSerialized(
      createMockWindow(),
      buildSpawnArgs({
        agentId: nextAgentId(),
        command: 'nonexistent-binary-xyz',
        dockerMode: false,
      }),
    );
    await expect(bad).rejects.toBeTruthy();
    const good = spawnAgentSerialized(
      createMockWindow(),
      buildSpawnArgs({ agentId: nextAgentId(), dockerMode: false }),
    );
    await good;
    expect(mockPtySpawn.mock.calls.length).toBe(before + 1);
  });
});

describe('validateCommand', () => {
  // `/bin/sh` only exists on POSIX; skip on Windows where absolute paths look like `C:\\...`.
  it.skipIf(process.platform === 'win32')('does not throw for a command found in PATH', () => {
    expect(() => validateCommand('/bin/sh')).not.toThrow();
  });

  it('throws a descriptive error for a missing command', () => {
    expect(() => validateCommand('nonexistent-binary-xyz')).toThrow(/not found in PATH/);
  });

  it('throws a descriptive error naming the command', () => {
    expect(() => validateCommand('nonexistent-binary-xyz')).toThrow(/nonexistent-binary-xyz/);
  });

  it('throws for a nonexistent absolute path', () => {
    expect(() => validateCommand('/nonexistent/path/binary')).toThrow(
      /not found or not executable/,
    );
  });

  it('does not throw for a bare command found in PATH', () => {
    expect(() => validateCommand('sh')).not.toThrow();
  });

  it('throws for an empty command string', () => {
    expect(() => validateCommand('')).toThrow(/must not be empty/);
  });

  it('throws for a whitespace-only command string', () => {
    expect(() => validateCommand('   ')).toThrow(/must not be empty/);
  });
});

describe('resolveProjectDockerfile', () => {
  it('returns absolute path when .parallel-code/Dockerfile exists in project root', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resolve-'));
    tempPaths.push(projectRoot);
    const dockerDir = path.join(projectRoot, '.parallel-code');
    fs.mkdirSync(dockerDir, { recursive: true });
    fs.writeFileSync(path.join(dockerDir, 'Dockerfile'), 'FROM node:20\n');

    const result = resolveProjectDockerfile(projectRoot);
    expect(result).toBe(path.join(projectRoot, '.parallel-code', 'Dockerfile'));
  });

  it('returns null when .parallel-code/Dockerfile does not exist', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resolve-'));
    tempPaths.push(projectRoot);

    const result = resolveProjectDockerfile(projectRoot);
    expect(result).toBeNull();
  });

  it('returns null when project root does not exist', () => {
    const result = resolveProjectDockerfile('/nonexistent/path/to/project');
    expect(result).toBeNull();
  });

  it('returns null when .parallel-code/Dockerfile is a directory', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resolve-'));
    tempPaths.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, '.parallel-code', 'Dockerfile'), { recursive: true });

    const result = resolveProjectDockerfile(projectRoot);
    expect(result).toBeNull();
  });
});

describe('projectImageTag', () => {
  it('returns a tag in the format parallel-code-project:<12-char-hash>', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-tag-'));
    tempPaths.push(tmpDir);
    const dockerfilePath = path.join(tmpDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, 'FROM node:20\nRUN echo hello\n');

    const tag = projectImageTag(dockerfilePath);
    expect(tag).toMatch(/^parallel-code-project:[a-f0-9]{12}$/);
  });

  it('returns parallel-code-project:unknown for non-existent Dockerfile path', () => {
    const tag = projectImageTag('/nonexistent/Dockerfile');
    expect(tag).toBe('parallel-code-project:unknown');
  });
});

describe('hashDockerfile', () => {
  it('returns a SHA-256 hex string for a real file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-hash-'));
    tempPaths.push(tmpDir);
    const dockerfilePath = path.join(tmpDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, 'FROM ubuntu:22.04\n');

    const hash = hashDockerfile(dockerfilePath);
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null for a non-existent file', () => {
    const hash = hashDockerfile('/nonexistent/Dockerfile');
    expect(hash).toBeNull();
  });
});

describe('dockerImageExists', () => {
  it('fails closed when a custom dockerfile path is unreadable', async () => {
    mockExecFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: { encoding: string; timeout: number },
        callback: (err: Error | null, stdout: string) => void,
      ) => callback(null, 'stored-hash'),
    );

    await expect(
      dockerImageExists('parallel-code-project:test', {
        dockerfilePath: '/nonexistent/Dockerfile',
      }),
    ).resolves.toBe(false);
  });
});

describe('buildDockerImage', () => {
  it('uses the provided build context for a project dockerfile', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-build-context-'));
    tempPaths.push(projectRoot);
    const dockerDir = path.join(projectRoot, '.parallel-code');
    fs.mkdirSync(dockerDir, { recursive: true });
    const dockerfilePath = path.join(dockerDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, 'FROM node:20\n');

    buildDockerImage(createMockWindow(), 'channel:build-test', {
      dockerfilePath,
      imageTag: 'parallel-code-project:test',
      buildContext: projectRoot,
    } as unknown as Parameters<typeof buildDockerImage>[2]);

    const lastCall = mockChildProcessSpawn.mock.lastCall;
    expect(lastCall).toBeTruthy();
    const args = ((lastCall as unknown as [string, string[]])?.[1] ?? []) as string[];
    expect(args[args.length - 1]).toBe(projectRoot);
  });
});
