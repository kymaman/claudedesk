/**
 * Unit: makeBranchTitle — pins the "X • branch HH:MM" naming so future
 * tweaks can't silently regress the format the user reads to identify
 * a branch's parent + when it was made.
 */
import { describe, it, expect } from 'vitest';
import { makeBranchTitle } from './chats.js';

describe('makeBranchTitle', () => {
  it('appends " • branch HH:MM" with the local-time of the fork', () => {
    // 2026-06-09 13:42:11 local
    const at = new Date(2026, 5, 9, 13, 42, 11).getTime();
    expect(makeBranchTitle('Fix scroll bug', at)).toBe('Fix scroll bug • branch 13:42');
  });

  it('zero-pads single-digit hours and minutes', () => {
    const at = new Date(2026, 5, 9, 3, 5, 0).getTime();
    expect(makeBranchTitle('A', at)).toBe('A • branch 03:05');
  });

  it('stacks suffixes so a chain of forks reads as a chain', () => {
    const first = makeBranchTitle('Parent', new Date(2026, 5, 9, 13, 42).getTime());
    const second = makeBranchTitle(first, new Date(2026, 5, 9, 14, 15).getTime());
    expect(second).toBe('Parent • branch 13:42 • branch 14:15');
  });
});
