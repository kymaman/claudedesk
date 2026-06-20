import { describe, it, expect } from 'vitest';
import { pickDiskTitle } from './title-sync.js';

/**
 * Pins the title-parity fix: a tile must inherit the on-disk title even right
 * after it advances to a freshly-minted live sessionId that the disk scan hasn't
 * indexed yet — otherwise the tile shows its stale base title while History
 * shows the fresh one (the divergence the user reported).
 */
describe('pickDiskTitle', () => {
  it('uses the current sessionId when it is on disk', () => {
    const byId = new Map([['live-1', 'Fix scroll bug']]);
    expect(pickDiskTitle({ sessionId: 'live-1' }, byId)).toBe('Fix scroll bug');
  });

  it('falls back to the newest past sessionId when the current id is not on disk yet', () => {
    // Tile advanced live-1 -> live-2; the scan only has live-1 so far.
    const byId = new Map([['live-1', 'Fix scroll bug']]);
    expect(pickDiskTitle({ sessionId: 'live-2', pastSessionIds: ['live-0', 'live-1'] }, byId)).toBe(
      'Fix scroll bug',
    );
  });

  it('prefers the current id over past ids when both are on disk', () => {
    const byId = new Map([
      ['live-1', 'Old title'],
      ['live-2', 'New title'],
    ]);
    expect(pickDiskTitle({ sessionId: 'live-2', pastSessionIds: ['live-1'] }, byId)).toBe(
      'New title',
    );
  });

  it('scans past ids newest-first', () => {
    const byId = new Map([
      ['live-0', 'Oldest'],
      ['live-1', 'Middle'],
    ]);
    expect(pickDiskTitle({ sessionId: 'live-3', pastSessionIds: ['live-0', 'live-1'] }, byId)).toBe(
      'Middle',
    );
  });

  it('returns undefined when nothing matches (no premature title)', () => {
    const byId = new Map([['other', 'X']]);
    expect(
      pickDiskTitle({ sessionId: 'live-9', pastSessionIds: ['p1', 'p2'] }, byId),
    ).toBeUndefined();
    expect(pickDiskTitle({ sessionId: 'live-9' }, byId)).toBeUndefined();
  });

  it('returns undefined for a fresh chat with no sessionId', () => {
    expect(pickDiskTitle({}, new Map([['x', 'Y']]))).toBeUndefined();
  });
});
