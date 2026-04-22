import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

vi.mock('child_process', () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: unknown,
    args: unknown,
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockExecFile(file, args, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return { execFile: mockExecFile };
});

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void {}
    show(): void {}
    close(): void {}
  },
}));

import { execFile } from 'child_process';
import {
  summarize,
  rollupBucket,
  isPrUrl,
  fetchPrStatus,
  __resetForTests,
  __getStateForTests,
  startPrChecksWatcher,
  type PrCheckRun,
} from './pr-checks.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
type GhHandler = (args: string[], cb: ExecCb) => void;

function stubGh(handler: GhHandler): string[][] {
  const calls: string[][] = [];
  const impl = (_cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
    calls.push(args);
    handler(args, cb);
  };
  vi.mocked(execFile).mockImplementation(impl as unknown as typeof execFile);
  return calls;
}

const run = (name: string, bucket: PrCheckRun['bucket']): PrCheckRun => ({
  name,
  bucket,
});

describe('summarize', () => {
  it('empty list is none with zero counts', () => {
    expect(summarize([])).toEqual({ overall: 'none', passing: 0, pending: 0, failing: 0 });
  });
  it('any pending wins over fail', () => {
    expect(summarize([run('a', 'pending'), run('b', 'fail')])).toEqual({
      overall: 'pending',
      passing: 0,
      pending: 1,
      failing: 1,
    });
  });
  it('fail without pending is failure', () => {
    expect(summarize([run('a', 'pass'), run('b', 'fail')])).toEqual({
      overall: 'failure',
      passing: 1,
      pending: 0,
      failing: 1,
    });
  });
  it('cancel counts as failure', () => {
    expect(summarize([run('a', 'pass'), run('b', 'cancel')])).toEqual({
      overall: 'failure',
      passing: 1,
      pending: 0,
      failing: 1,
    });
  });
  it('all pass is success', () => {
    expect(summarize([run('a', 'pass'), run('b', 'pass')])).toEqual({
      overall: 'success',
      passing: 2,
      pending: 0,
      failing: 0,
    });
  });
  it('skipping counts as passing', () => {
    expect(summarize([run('a', 'pass'), run('b', 'skipping')])).toEqual({
      overall: 'success',
      passing: 2,
      pending: 0,
      failing: 0,
    });
  });
});

describe('rollupBucket', () => {
  it('maps CheckRun conclusions', () => {
    expect(rollupBucket('COMPLETED', 'SUCCESS', undefined)).toBe('pass');
    expect(rollupBucket('COMPLETED', 'FAILURE', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'TIMED_OUT', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'STARTUP_FAILURE', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'ACTION_REQUIRED', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'STALE', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'CANCELLED', undefined)).toBe('cancel');
    expect(rollupBucket('COMPLETED', 'SKIPPED', undefined)).toBe('skipping');
    expect(rollupBucket('COMPLETED', 'NEUTRAL', undefined)).toBe('skipping');
  });
  it('treats non-completed status as pending', () => {
    expect(rollupBucket('IN_PROGRESS', null as unknown as undefined, undefined)).toBe('pending');
    expect(rollupBucket('QUEUED', undefined, undefined)).toBe('pending');
    expect(rollupBucket('WAITING', undefined, undefined)).toBe('pending');
  });
  it('treats unknown conclusions as fail (safe default)', () => {
    expect(rollupBucket('COMPLETED', 'SOMETHING_NEW', undefined)).toBe('fail');
  });
  it('maps legacy status-context state', () => {
    expect(rollupBucket(undefined, undefined, 'SUCCESS')).toBe('pass');
    expect(rollupBucket(undefined, undefined, 'PENDING')).toBe('pending');
    expect(rollupBucket(undefined, undefined, 'FAILURE')).toBe('fail');
    expect(rollupBucket(undefined, undefined, 'ERROR')).toBe('fail');
    expect(rollupBucket(undefined, undefined, 'GARBAGE')).toBe('fail');
  });
  it('returns null when nothing useful is present', () => {
    expect(rollupBucket(undefined, undefined, undefined)).toBe(null);
  });
});

describe('isPrUrl', () => {
  it('accepts PR URLs', () => {
    expect(isPrUrl('https://github.com/acme/app/pull/42')).toBe(true);
    expect(isPrUrl('https://www.github.com/acme/app/pull/1')).toBe(true);
  });
  it('rejects issues, discussions, and non-github', () => {
    expect(isPrUrl('https://github.com/acme/app/issues/42')).toBe(false);
    expect(isPrUrl('https://gitlab.com/acme/app/pull/42')).toBe(false);
    expect(isPrUrl('not a url')).toBe(false);
    expect(isPrUrl('https://github.com/acme/app')).toBe(false);
    expect(isPrUrl('https://github.com/acme/app/pull/abc')).toBe(false);
  });
  it('rejects URLs carrying credentials', () => {
    expect(isPrUrl('https://user:pass@github.com/a/b/pull/1')).toBe(false);
    expect(isPrUrl('https://user@github.com/a/b/pull/1')).toBe(false);
  });
});

describe('fetchPrStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  it('parses statusCheckRollup conclusions into buckets', async () => {
    const payload = {
      state: 'OPEN',
      headRefOid: 'abc123',
      statusCheckRollup: [
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'lint', status: 'IN_PROGRESS', conclusion: null },
        { name: 'flake', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'doc', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { name: 'cancel', status: 'COMPLETED', conclusion: 'CANCELLED' },
        // Legacy status-context shape:
        { context: 'ci/legacy', state: 'SUCCESS' },
      ],
    };
    const calls = stubGh((_args, cb) => cb(null, JSON.stringify(payload), ''));
    const out = await fetchPrStatus('https://github.com/a/b/pull/1');
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('pr');
    expect(calls[0][1]).toBe('view');
    expect(out.state).toBe('OPEN');
    expect(out.headRefOid).toBe('abc123');
    expect(out.checks).toEqual([
      { name: 'build', bucket: 'pass' },
      { name: 'lint', bucket: 'pending' },
      { name: 'flake', bucket: 'fail' },
      { name: 'doc', bucket: 'skipping' },
      { name: 'cancel', bucket: 'cancel' },
      { name: 'ci/legacy', bucket: 'pass' },
    ]);
  });

  it('returns empty checks when response is malformed', async () => {
    stubGh((_args, cb) => cb(null, JSON.stringify(null), ''));
    const out = await fetchPrStatus('https://github.com/a/b/pull/1');
    expect(out).toEqual({ state: 'UNKNOWN', headRefOid: '', checks: [] });
  });
});

describe('startPrChecksWatcher — graceful degradation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  it('ignores non-PR URLs (no task registered)', () => {
    startPrChecksWatcher({
      taskId: 't1',
      prUrl: 'https://github.com/a/b/issues/1',
      taskName: 'test',
    });
    expect(__getStateForTests().taskIds).toEqual([]);
  });

  it('disables session when gh is missing (ENOENT)', async () => {
    stubGh((_args, cb) => {
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      cb(e, '', '');
    });
    startPrChecksWatcher({
      taskId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
    });
    // Allow the fire-and-forget refresh to settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(__getStateForTests().disabled).toBe(true);
    expect(__getStateForTests().disabledReason).toBe('missing');
  });

  it('disables session when gh reports not authenticated', async () => {
    stubGh((_args, cb) => {
      const e = new Error('auth') as Error & { stderr?: string };
      e.stderr = 'You are not logged into any GitHub hosts.';
      cb(e, '', 'You are not logged into any GitHub hosts.');
    });
    startPrChecksWatcher({
      taskId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(__getStateForTests().disabled).toBe(true);
    expect(__getStateForTests().disabledReason).toBe('auth');
  });
});
