/**
 * title-unify.test.ts — the tile header / History title precedence.
 *
 * titleFor must resolve: manual rename override > live disk/session title
 * (setDiskTitleForChat, fed by App's sessions effect) > the chat's own base
 * title. The disk tier is what makes «название слева в истории и сверху над
 * терминалом» one and the same for an open chat.
 */
import { describe, expect, it } from 'vitest';
import {
  titleFor,
  setDiskTitleForChat,
  titleOverrideFor,
  renameChat,
  openChatFromSession,
  openFreshChat,
  closeChat,
} from './chats';
import { setStore } from './core';
import { setSessions, filteredSessions, type SessionItem } from './sessions-history';
import type { AgentDef } from '../ipc/types';

const TEST_AGENT: AgentDef = {
  id: 'claude-parity-test',
  name: 'Parity Test',
  command: 'claude',
  args: [],
  resume_args: [],
  skip_permissions_args: [],
  description: '',
};

describe('titleFor precedence', () => {
  it('falls back to the base chat.title when nothing else is set', () => {
    expect(titleFor({ id: 'unify-a', title: 'base-a' })).toBe('base-a');
  });

  it('prefers the live disk/session title over the base title', () => {
    setDiskTitleForChat('unify-b', 'disk-b');
    expect(titleFor({ id: 'unify-b', title: 'base-b' })).toBe('disk-b');
  });

  it('updates reactively when the disk title changes (and no-ops on same value)', () => {
    setDiskTitleForChat('unify-c', 'first');
    expect(titleFor({ id: 'unify-c', title: 'base-c' })).toBe('first');
    setDiskTitleForChat('unify-c', 'second');
    expect(titleFor({ id: 'unify-c', title: 'base-c' })).toBe('second');
    // Idempotent: setting the same value again keeps it.
    setDiskTitleForChat('unify-c', 'second');
    expect(titleFor({ id: 'unify-c', title: 'base-c' })).toBe('second');
  });

  it('keeps chats independent (disk title for one does not leak to another)', () => {
    setDiskTitleForChat('unify-d', 'disk-d');
    expect(titleFor({ id: 'unify-e', title: 'base-e' })).toBe('base-e');
  });
});

describe('title parity — tile header === History row', () => {
  /**
   * When the user renames a tile, BOTH rendering paths must show the same
   * text:
   *   - Tile header: titleFor(chat) = _titleOverrides.get(id) ?? _diskTitles.get(id) ?? chat.title
   *   - History row: sessionsWithOpenChats overlays titleOverrideFor(c.id)
   *     onto the disk session's title → override ?? s.title
   *
   * The invariant: when an override exists it is the FIRST pick in both
   * paths, so they agree.
   */
  it('rename: titleFor (tile) and titleOverrideFor (History overlay) both return the renamed title', () => {
    const chatId = 'parity-rename-1';
    const chat = { id: chatId, title: 'old title' };

    renameChat(chatId, 'renamed title');

    // Tile header path.
    expect(titleFor(chat)).toBe('renamed title');
    // History row path: sessionsWithOpenChats uses titleOverrideFor(c.id) as
    // the override applied on top of the disk session's title field.
    expect(titleOverrideFor(chatId)).toBe('renamed title');
    // They are equal — parity holds.
    expect(titleFor(chat)).toBe(titleOverrideFor(chatId));
  });

  it('disk-title update: titleFor (tile) and disk session title (History) stay in sync', () => {
    const chatId = 'parity-disk-1';
    const chat = { id: chatId, title: 'base title' };

    // App.tsx effect calls setDiskTitleForChat when sessions() changes.
    setDiskTitleForChat(chatId, 'disk title from session');

    // Tile header path (no override).
    expect(titleFor(chat)).toBe('disk title from session');
    // History row shows the same disk title directly from the sessions() list.
    // No override is set, so titleOverrideFor is undefined and the disk title wins.
    expect(titleOverrideFor(chatId)).toBeUndefined();
    // Both resolve to the same value: the disk title.
    expect(titleFor(chat)).toBe('disk title from session');
  });

  /**
   * REAL divergence reproduction (the bug behind «в истории один заголовок, в
   * открытой плитке другой»).
   *
   * The History list renders `session.title` (from sessionsWithOpenChats),
   * while the tile/chip render `titleFor(chat)`. Before the fix these were two
   * SEPARATE precedence chains:
   *   - History overlay: override ?? s.title  (the raw disk row title)
   *   - Tile:            override ?? _diskTitles ?? chat.title
   * They only agreed when _diskTitles happened to equal s.title. A tile whose
   * live title is fed via setDiskTitleForChat to a value DIFFERENT from the
   * disk row it was opened from (e.g. the tile advanced onto a freshly-minted
   * --resume continuation, or a healed/AI title not yet on the row the user
   * sees) made the tile show one string while the History row still showed the
   * original disk title — exactly the reported mismatch.
   *
   * The fix overlays titleFor(c) onto the disk row, so the History row renders
   * the SAME resolver as the tile. This test fails on the old code (row =
   * disk title) and passes on the new code (row = titleFor = tile title).
   */
  it('open chat: the History row renders the EXACT title the tile shows (titleFor), even when it diverges from the raw disk row', () => {
    const agent: AgentDef = {
      id: 'claude-parity-test',
      name: 'Parity Test',
      command: 'claude',
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: '',
    };
    setStore('availableAgents', [agent]);

    const sessionId = 'parity-open-52b34330';
    const diskRowTitle = 'Упакуй до 4000 и сделай /goal';
    const session: SessionItem = {
      sessionId,
      filePath: '/p/x.jsonl',
      projectPath: '/p',
      title: diskRowTitle,
      date: '2026-06-29',
      folderIds: [],
    };
    // History first knows the session only by its disk title.
    setSessions([session]);

    // User opens it as a tile.
    const chat = openChatFromSession(session, {
      agentId: agent.id,
      extraFlags: [],
      skipPermissions: false,
    });
    if (!chat) throw new Error('openChatFromSession returned null (no agent resolved)');
    const chatId = chat.id;

    // App's sessions→tile effect resolves a DIFFERENT freshest title for the
    // tile than the raw disk row (live continuation / healed / AI title).
    const liveTileTitle = 'live continuation title';
    setDiskTitleForChat(chatId, liveTileTitle);

    // Tile shows the live title.
    expect(titleFor(chat)).toBe(liveTileTitle);

    // History row for the SAME session must show the SAME text as the tile.
    const row = filteredSessions().find((s) => s.sessionId === sessionId);
    if (!row) throw new Error('session row missing from History');
    expect(row.title, 'History row title must equal the tile title (titleFor)').toBe(
      titleFor(chat),
    );
    expect(row.title).toBe(liveTileTitle);

    closeChat(chatId);
  });
});

describe('unified user-name override (creation + History rename)', () => {
  // BUG 2: a name the user TYPES at creation must win over claude's auto
  // first-message/AI disk title (which is fed into _diskTitles later).
  it('(a) a user-typed creation title beats a later disk title', () => {
    setStore('availableAgents', [TEST_AGENT]);
    const chat = openFreshChat({
      cwd: '/p-create-a',
      agentId: TEST_AGENT.id,
      title: 'cross posting',
      titleIsUserTitle: true,
    });
    if (!chat) throw new Error('openFreshChat returned null');
    // Shows the typed name immediately…
    expect(titleFor(chat)).toBe('cross posting');
    // …and KEEPS it after claude derives a first-message/AI disk title.
    setDiskTitleForChat(chat.id, 'Help me set up cross-posting to socials');
    expect(titleFor(chat)).toBe('cross posting');
    expect(titleOverrideFor(chat.id)).toBe('cross posting');
    closeChat(chat.id);
  });

  // A fresh chat with NO user name (default 'New chat') must NOT get an
  // override, so it adopts the nicer auto disk title once one is derived.
  it('(b) a default New chat (no override) shows the auto disk title once set', () => {
    setStore('availableAgents', [TEST_AGENT]);
    const chat = openFreshChat({ cwd: '/p-create-b', agentId: TEST_AGENT.id });
    if (!chat) throw new Error('openFreshChat returned null');
    expect(titleFor(chat)).toBe('New chat');
    expect(titleOverrideFor(chat.id)).toBeUndefined();
    setDiskTitleForChat(chat.id, 'Implement the login page');
    expect(titleFor(chat)).toBe('Implement the login page');
    closeChat(chat.id);
  });

  // BUG 1: renaming an OPEN chat from the History list routes through
  // renameChat (the override), so the tile header (titleFor) AND the History
  // row end up equal to the new name — History rename is no longer a no-op.
  it('(c) History-path rename of an OPEN chat updates titleFor and the History row equally', () => {
    setStore('availableAgents', [TEST_AGENT]);
    const sessionId = 'hist-rename-open-1';
    const session: SessionItem = {
      sessionId,
      filePath: '/p/x.jsonl',
      projectPath: '/p',
      title: 'auto first-message title',
      date: '2026-06-29',
      folderIds: [],
    };
    setSessions([session]);
    const chat = openChatFromSession(session, {
      agentId: TEST_AGENT.id,
      extraFlags: [],
      skipPermissions: false,
    });
    if (!chat) throw new Error('openChatFromSession returned null');

    // This is exactly what SessionsHistoryPanel.commitEdit now does for an
    // open-chat row: renameChat(openChat.id, value).
    renameChat(chat.id, 'Quarterly report');

    // Tile header resolver.
    expect(titleFor(chat)).toBe('Quarterly report');
    // History row for the same session renders the SAME text (via titleFor).
    const row = filteredSessions().find((s) => s.sessionId === sessionId);
    if (!row) throw new Error('session row missing from History');
    expect(row.title).toBe(titleFor(chat));
    expect(row.title).toBe('Quarterly report');

    closeChat(chat.id);
  });
});
