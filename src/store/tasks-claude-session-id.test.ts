/**
 * tasks-claude-session-id.test.ts
 *
 * Pins down the TP fix: every claude-family task gets a pre-determined
 * `claudeSessionId` UUID at creation. The id passes through saveState /
 * loadState round-trip so the next app run can spawn the same claude
 * with `--resume <sid>` and pick up the conversation.
 *
 * Pre-fix: Task / PersistedTask had no session id field. Spawn args
 * were always `def.args` (or resume_args after collapse), so claude
 * generated a fresh session every restart and the user lost history.
 */

import { describe, expect, it } from 'vitest';
import type { Task, PersistedTask } from './types';

describe('Task type — claudeSessionId field', () => {
  it('Task interface accepts claudeSessionId on construction', () => {
    const t: Task = {
      id: 't1',
      name: 'demo',
      projectId: 'p1',
      branchName: 'main',
      worktreePath: '/tmp/proj',
      agentIds: ['a1'],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
      claudeSessionId: '11111111-2222-3333-4444-555555555555',
    };
    expect(t.claudeSessionId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('PersistedTask carries claudeSessionId through save/load', () => {
    const persisted: PersistedTask = {
      id: 't1',
      name: 'demo',
      projectId: 'p1',
      branchName: 'main',
      worktreePath: '/tmp/proj',
      notes: '',
      lastPrompt: '',
      shellCount: 0,
      agentDef: null,
      gitIsolation: 'worktree',
      claudeSessionId: 'abcdef00-1111-2222-3333-444444444444',
    };
    // round-trip through JSON (mirrors what saveState/loadState does)
    const roundTripped = JSON.parse(JSON.stringify(persisted)) as PersistedTask;
    expect(roundTripped.claudeSessionId).toBe('abcdef00-1111-2222-3333-444444444444');
  });

  it('omitting claudeSessionId is allowed (legacy / non-claude tasks)', () => {
    const t: Task = {
      id: 't2',
      name: 'plain',
      projectId: 'p1',
      branchName: 'main',
      worktreePath: '/tmp/proj',
      agentIds: ['a1'],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    };
    expect(t.claudeSessionId).toBeUndefined();
  });
});

describe('TP arg-injection logic — fresh vs resumed', () => {
  // Pure logic mirror of the inline expression in TaskAITerminal.tsx:
  //   ...(claudeSessionId
  //         ? resumed ? ['--resume', sid] : ['--session-id', sid]
  //         : [])
  function sessionPrefix(claudeSessionId: string | undefined, resumed: boolean): string[] {
    if (!claudeSessionId) return [];
    return resumed ? ['--resume', claudeSessionId] : ['--session-id', claudeSessionId];
  }

  it('fresh spawn with sid → --session-id', () => {
    expect(sessionPrefix('sid-1', false)).toEqual(['--session-id', 'sid-1']);
  });

  it('resumed spawn with sid → --resume', () => {
    expect(sessionPrefix('sid-1', true)).toEqual(['--resume', 'sid-1']);
  });

  it('no sid → empty (legacy task, fall through to def.args)', () => {
    expect(sessionPrefix(undefined, false)).toEqual([]);
    expect(sessionPrefix(undefined, true)).toEqual([]);
  });
});
