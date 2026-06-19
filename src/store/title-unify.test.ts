/**
 * title-unify.test.ts — the tile header / History title precedence.
 *
 * titleFor must resolve: manual rename override > live disk/session title
 * (setDiskTitleForChat, fed by App's sessions effect) > the chat's own base
 * title. The disk tier is what makes «название слева в истории и сверху над
 * терминалом» one and the same for an open chat.
 */
import { describe, expect, it } from 'vitest';
import { titleFor, setDiskTitleForChat } from './chats';

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
