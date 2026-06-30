/**
 * paperclip-folder.test.ts
 *
 * Tests for the Paperclip auto-folder feature in session-history.ts:
 *   1. isPaperclipSession — pure detection helper
 *   2. autoAssignPaperclipSessions — creates exactly one folder, maps sessions
 *   3. Idempotency — re-running never creates duplicates
 *
 * NOTE: better-sqlite3 in this project is rebuilt against Electron's ABI, so
 * vitest (plain Node) can't load the native binary.  The auto-assign logic is
 * tested here through injectable `PaperclipFolderOps` fakes instead.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { isPaperclipSession, autoAssignPaperclipSessions } from './session-history.js';
import type { PaperclipFolderOps } from './session-history.js';

// ---------------------------------------------------------------------------
// Fake ops — in-memory stand-in for the SQLite-backed folder operations
// ---------------------------------------------------------------------------

function makeFakeOps(): PaperclipFolderOps & {
  folders: Map<string, string>; // name → id
  memberships: Set<string>; // "${sessionId}:${folderId}"
  createCallCount: number;
} {
  const folders = new Map<string, string>();
  const memberships = new Set<string>();
  let nextId = 1;
  let createCallCount = 0;

  return {
    folders,
    memberships,
    get createCallCount() {
      return createCallCount;
    },
    getFolderByName(name) {
      const id = folders.get(name);
      return id ? { id } : null;
    },
    createFolderByName(name) {
      createCallCount++;
      const id = `folder-${nextId++}`;
      folders.set(name, id);
      return { id };
    },
    addToFolder(sessionId, folderId) {
      memberships.add(`${sessionId}:${folderId}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. isPaperclipSession — pure detection helper
// ---------------------------------------------------------------------------

describe('isPaperclipSession', () => {
  it('returns true for a potok-marketing file path (encoded folder name)', () => {
    expect(
      isPaperclipSession({
        filePath:
          'C:\\Users\\burmistrov\\.claude\\projects\\C--Users-burmistrov-potok-marketing\\abc123.jsonl',
      }),
    ).toBe(true);
  });

  it('returns true for a .paperclip encoded folder path', () => {
    expect(
      isPaperclipSession({
        filePath:
          'C:\\Users\\burmistrov\\.claude\\projects\\C--Users-burmistrov--paperclip-instances-default-projects-2b021542-e720\\abc123.jsonl',
      }),
    ).toBe(true);
  });

  it('returns true for a real cwd containing .paperclip', () => {
    expect(
      isPaperclipSession({
        cwd: 'C:\\Users\\burmistrov\\.paperclip\\instances\\default\\projects\\2b021542-e720-46b1-bb06-3b2858903176',
      }),
    ).toBe(true);
  });

  it('returns true for a real cwd containing potok-marketing', () => {
    expect(
      isPaperclipSession({
        cwd: 'C:\\Users\\burmistrov\\potok-marketing',
      }),
    ).toBe(true);
  });

  it('returns true when projectPath contains paperclip', () => {
    expect(
      isPaperclipSession({
        projectPath: 'C:/Users/burmistrov/.paperclip/instances/default/workspaces/abc',
      }),
    ).toBe(true);
  });

  it('returns false for a regular project', () => {
    expect(
      isPaperclipSession({
        filePath:
          'D:\\YandexDisk\\Antigravity\\ClaudeDesk\\.claude\\projects\\D--YandexDisk-Antigravity-EasyTable\\abc.jsonl',
        cwd: 'D:\\YandexDisk\\Antigravity\\EasyTable',
        projectPath: 'D:/YandexDisk/Antigravity/EasyTable',
      }),
    ).toBe(false);
  });

  it('returns false when all args are null/undefined', () => {
    expect(isPaperclipSession({})).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isPaperclipSession({ filePath: '/home/user/POTOK-MARKETING/session.jsonl' })).toBe(true);
    expect(isPaperclipSession({ cwd: '/home/user/PAPERCLIP/projects' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. autoAssignPaperclipSessions — creates the folder and maps sessions
// ---------------------------------------------------------------------------

describe('autoAssignPaperclipSessions', () => {
  let ops: ReturnType<typeof makeFakeOps>;

  beforeEach(() => {
    ops = makeFakeOps();
  });

  it('creates exactly ONE "Paperclip" folder when none exists', () => {
    autoAssignPaperclipSessions(
      [
        {
          sessionId: 'session-1',
          filePath: '...\\C--Users-burmistrov-potok-marketing\\session-1.jsonl',
        },
        {
          sessionId: 'session-2',
          filePath:
            '...\\C--Users-burmistrov--paperclip-instances-default-projects-abc\\session-2.jsonl',
        },
      ],
      ops,
    );

    expect(ops.createCallCount).toBe(1);
    expect(ops.folders.has('Paperclip')).toBe(true);
  });

  it('maps all detected Paperclip sessions to the folder', () => {
    const sessions = [
      {
        sessionId: 'ppclip-1',
        filePath: '...\\C--Users-burmistrov-potok-marketing\\ppclip-1.jsonl',
      },
      {
        sessionId: 'ppclip-2',
        filePath:
          '...\\C--Users-burmistrov--paperclip-instances-default-projects-abc\\ppclip-2.jsonl',
      },
      {
        sessionId: 'normal-1',
        filePath: '...\\D--YandexDisk-Antigravity-EasyTable\\normal-1.jsonl',
      },
    ];

    autoAssignPaperclipSessions(sessions, ops);

    const folderId = ops.folders.get('Paperclip');
    expect(folderId).toBeDefined();
    expect(ops.memberships.has(`ppclip-1:${folderId}`)).toBe(true);
    expect(ops.memberships.has(`ppclip-2:${folderId}`)).toBe(true);
    // Non-Paperclip session must NOT be added
    expect(ops.memberships.has(`normal-1:${folderId}`)).toBe(false);
  });

  it('does nothing when there are no Paperclip sessions', () => {
    autoAssignPaperclipSessions(
      [
        {
          sessionId: 'normal-1',
          filePath: '...\\D--YandexDisk-Antigravity-EasyTable\\normal-1.jsonl',
        },
      ],
      ops,
    );

    expect(ops.createCallCount).toBe(0);
    expect(ops.folders.size).toBe(0);
    expect(ops.memberships.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotency — re-running never duplicates folder or membership
// ---------------------------------------------------------------------------

describe('autoAssignPaperclipSessions — idempotency', () => {
  it('does not create a second folder when "Paperclip" already exists', () => {
    const ops = makeFakeOps();
    const sessions = [
      {
        sessionId: 'ppclip-1',
        filePath: '...\\C--Users-burmistrov-potok-marketing\\ppclip-1.jsonl',
      },
    ];

    autoAssignPaperclipSessions(sessions, ops);
    autoAssignPaperclipSessions(sessions, ops);

    // createFolderByName must have been called exactly once despite two runs
    expect(ops.createCallCount).toBe(1);
    expect(ops.folders.size).toBe(1);
  });

  it('does not duplicate membership when a session is already mapped', () => {
    // The fake ops.addToFolder uses a Set with composite key, mirroring
    // SQLite's INSERT OR IGNORE / PRIMARY KEY constraint.
    const ops = makeFakeOps();
    const sessions = [
      {
        sessionId: 'ppclip-1',
        filePath: '...\\C--Users-burmistrov-potok-marketing\\ppclip-1.jsonl',
      },
      {
        sessionId: 'ppclip-2',
        filePath: '...\\C--Users-burmistrov-potok-marketing\\ppclip-2.jsonl',
      },
    ];

    autoAssignPaperclipSessions(sessions, ops);
    autoAssignPaperclipSessions(sessions, ops);

    const folderId = ops.folders.get('Paperclip');
    // Memberships are unique (Set)
    expect(ops.memberships.has(`ppclip-1:${folderId}`)).toBe(true);
    expect(ops.memberships.has(`ppclip-2:${folderId}`)).toBe(true);
    // Still exactly 2 unique memberships
    expect(ops.memberships.size).toBe(2);
  });
});
