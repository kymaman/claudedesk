/**
 * find-resumable-session.test.ts
 *
 * Pins the heuristic that lets a "pending" project chat re-attach to its
 * actual on-disk Claude session after an app restart. The user wants
 * "open project = same chats as before" — without this matcher, restored
 * pending chats would be fresh respawns with no conversation history.
 *
 * Match rules being asserted:
 *   - cwd matches (path-normalised, case-insensitive)
 *   - session.date is at or after pending.createdAt
 *   - candidates already claimed in this restore pass are skipped
 *   - among the rest, the OLDEST session wins (so consecutive pendings
 *     line up with consecutive sessions in creation order)
 */

import { describe, expect, it } from 'vitest';
import { findResumableSession, type SessionForResume } from './chat-projects';

function s(overrides: Partial<SessionForResume>): SessionForResume {
  return {
    sessionId: 'sess',
    projectPath: '/tmp/proj',
    date: new Date(0).toISOString(),
    title: 't',
    filePath: '/tmp/file.jsonl',
    folderIds: [],
    ...overrides,
  };
}

describe('findResumableSession', () => {
  it('returns the only session in the same cwd that started after the pending row', () => {
    const pending = { cwd: '/tmp/proj', createdAt: 1000 };
    const sessions = [
      s({ sessionId: 'a', date: new Date(2000).toISOString() }),
      s({ sessionId: 'b', projectPath: '/elsewhere', date: new Date(3000).toISOString() }),
    ];
    expect(findResumableSession(sessions, pending, new Set())?.sessionId).toBe('a');
  });

  it('skips sessions that started BEFORE the pending row was created', () => {
    const pending = { cwd: '/tmp/proj', createdAt: 5000 };
    const sessions = [
      s({ sessionId: 'older', date: new Date(2000).toISOString() }),
      s({ sessionId: 'newer', date: new Date(7000).toISOString() }),
    ];
    expect(findResumableSession(sessions, pending, new Set())?.sessionId).toBe('newer');
  });

  it('returns null when no session matches', () => {
    const pending = { cwd: '/tmp/proj', createdAt: 1000 };
    const sessions = [s({ sessionId: 'a', projectPath: '/elsewhere' })];
    expect(findResumableSession(sessions, pending, new Set())).toBeNull();
  });

  it('skips already-claimed sessions', () => {
    const pending = { cwd: '/tmp/proj', createdAt: 1000 };
    const sessions = [
      s({ sessionId: 'a', date: new Date(2000).toISOString() }),
      s({ sessionId: 'b', date: new Date(3000).toISOString() }),
    ];
    expect(findResumableSession(sessions, pending, new Set(['a']))?.sessionId).toBe('b');
  });

  it('picks the oldest match — first pending claims first session', () => {
    const pending = { cwd: '/tmp/proj', createdAt: 1000 };
    const sessions = [
      s({ sessionId: 'mid', date: new Date(3000).toISOString() }),
      s({ sessionId: 'oldest', date: new Date(2000).toISOString() }),
      s({ sessionId: 'newest', date: new Date(4000).toISOString() }),
    ];
    expect(findResumableSession(sessions, pending, new Set())?.sessionId).toBe('oldest');
  });

  it('matches Windows-style backslash paths against forward-slash sessions', () => {
    const pending = { cwd: 'D:\\Code\\My Project', createdAt: 1000 };
    const sessions = [
      s({
        sessionId: 'win',
        projectPath: 'D:/Code/My Project',
        date: new Date(2000).toISOString(),
      }),
    ];
    expect(findResumableSession(sessions, pending, new Set())?.sessionId).toBe('win');
  });

  it('is case-insensitive on the cwd compare (Windows is case-preserving but not -sensitive)', () => {
    const pending = { cwd: 'D:/code/My Project', createdAt: 1000 };
    const sessions = [
      s({
        sessionId: 'caseDiff',
        projectPath: 'd:/Code/my project',
        date: new Date(2000).toISOString(),
      }),
    ];
    expect(findResumableSession(sessions, pending, new Set())?.sessionId).toBe('caseDiff');
  });

  it('rejects sessions with malformed date strings', () => {
    const pending = { cwd: '/tmp/proj', createdAt: 1000 };
    const sessions = [s({ sessionId: 'bad', date: 'not a date' })];
    expect(findResumableSession(sessions, pending, new Set())).toBeNull();
  });
});
