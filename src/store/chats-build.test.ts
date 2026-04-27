/**
 * chats-build.test.ts
 *
 * Locks the buildChat() invariant introduced when openFreshChat and
 * openChatFromSession were deduped. Both code paths must produce a Chat
 * record with the exact same shape — including:
 *   - projectId carrying through from the caller
 *   - args ordering for resume:  ['--resume', <sessionId>, ...skipFlags?, ...extraFlags]
 *   - args ordering for fresh:                            [...skipFlags?, ...extraFlags]
 *   - sessionId is undefined for fresh chats (only present when resuming)
 *
 * These properties are how downstream code (TerminalView, isolation tests)
 * tells fresh from resumed chats; if buildChat() ever drops a key, the bug
 * surfaces here before users see it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionItem } from './sessions-history';

// Minimal localStorage polyfill — vitest is Node, no DOM by default.
{
  const s = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => s.get(k) ?? null,
      setItem: (k: string, v: string) => void s.set(k, String(v)),
      removeItem: (k: string) => void s.delete(k),
      clear: () => void s.clear(),
      key: (i: number) => Array.from(s.keys())[i] ?? null,
      get length() {
        return s.size;
      },
    },
  });
}

vi.mock('./core', () => ({
  store: {
    availableAgents: [
      {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        command: 'claude',
        args: [],
        skip_permissions_args: ['--dangerously-skip-permissions'],
        available: true,
      },
    ],
  },
}));

async function importChats() {
  vi.resetModules();
  return await import('./chats');
}

const SESSION: SessionItem = {
  sessionId: 'sess-1234-5678',
  filePath: '/var/sessions/sess-1234-5678.jsonl',
  projectPath: '/tmp/proj',
  title: 'Resumed thread',
  date: '2026-04-27',
  folderIds: [],
};

describe('buildChat — fresh path (openFreshChat)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('produces a Chat with no sessionId, default title, and skip-perms before extraFlags', async () => {
    const { openFreshChat } = await importChats();
    const chat = openFreshChat({
      cwd: '/tmp/work',
      skipPermissions: true,
      extraFlags: ['--verbose', '--model', 'opus'],
      projectId: 'proj-A',
    });
    expect(chat).toBeTruthy();
    if (!chat) return;
    expect(chat.sessionId).toBeUndefined();
    expect(chat.title).toBe('New chat');
    expect(chat.cwd).toBe('/tmp/work');
    expect(chat.agentDefId).toBe('claude-opus-4-7');
    expect(chat.command).toBe('claude');
    // skip-perms flag must come BEFORE extraFlags
    expect(chat.args).toEqual(['--dangerously-skip-permissions', '--verbose', '--model', 'opus']);
    expect(chat.projectId).toBe('proj-A');
    expect(chat.env).toEqual({});
    expect(chat.closed).toBe(false);
    expect(chat.settings).toEqual({
      agentId: 'claude-opus-4-7',
      extraFlags: ['--verbose', '--model', 'opus'],
      skipPermissions: true,
    });
    expect(typeof chat.id).toBe('string');
    expect(chat.id.length).toBeGreaterThan(0);
    expect(typeof chat.createdAt).toBe('number');
  });

  it('omits skip-perms flags when skipPermissions=false, keeps extraFlags only', async () => {
    const { openFreshChat } = await importChats();
    const chat = openFreshChat({
      cwd: '/tmp/work',
      skipPermissions: false,
      extraFlags: ['--debug'],
    });
    expect(chat?.args).toEqual(['--debug']);
  });

  it('uses null projectId when caller omits it', async () => {
    const { openFreshChat } = await importChats();
    const chat = openFreshChat({ cwd: '/tmp/x' });
    expect(chat?.projectId).toBeNull();
  });
});

describe('buildChat — resume path (openChatFromSession)', () => {
  beforeEach(() => localStorage.clear());

  it('produces a Chat with sessionId set, title from session, --resume first then skip-perms then extraFlags', async () => {
    const { openChatFromSession } = await importChats();
    const chat = openChatFromSession(
      SESSION,
      {
        agentId: 'claude-opus-4-7',
        extraFlags: ['--continue', '--model', 'opus'],
        skipPermissions: true,
      },
      { projectId: 'proj-B' },
    );
    expect(chat).toBeTruthy();
    if (!chat) return;
    expect(chat.sessionId).toBe('sess-1234-5678');
    expect(chat.title).toBe('Resumed thread');
    expect(chat.cwd).toBe('/tmp/proj');
    // --resume <sid> must lead, then skip-perms, then extraFlags
    expect(chat.args).toEqual([
      '--resume',
      'sess-1234-5678',
      '--dangerously-skip-permissions',
      '--continue',
      '--model',
      'opus',
    ]);
    expect(chat.projectId).toBe('proj-B');
    expect(chat.env).toEqual({});
    expect(chat.closed).toBe(false);
  });

  it('falls back to first 8 chars of sessionId when session.title is empty', async () => {
    const { openChatFromSession } = await importChats();
    const chat = openChatFromSession(
      { ...SESSION, title: '' },
      { agentId: 'claude-opus-4-7', extraFlags: [], skipPermissions: false },
    );
    expect(chat?.title).toBe('sess-123');
  });

  it('preserves the caller-supplied settings object verbatim', async () => {
    const { openChatFromSession } = await importChats();
    const settings = {
      agentId: 'claude-opus-4-7',
      extraFlags: ['--x'],
      skipPermissions: false,
    };
    const chat = openChatFromSession(SESSION, settings);
    expect(chat?.settings).toBe(settings);
  });

  it('uses null projectId when options.projectId is omitted', async () => {
    const { openChatFromSession } = await importChats();
    const chat = openChatFromSession(SESSION, {
      agentId: 'claude-opus-4-7',
      extraFlags: [],
      skipPermissions: false,
    });
    expect(chat?.projectId).toBeNull();
  });
});
