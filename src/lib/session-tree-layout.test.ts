/**
 * session-tree-layout.test.ts — lane assignment for the Tree view.
 *
 * Pins the git-graph invariants:
 *  - root takes lane 0;
 *  - the FIRST child continues its parent's lane (a linear resume chain
 *    stays a straight vertical line);
 *  - every further child opens a new lane to the right (a ⑂ fork is
 *    visually a split);
 *  - orphans (parent outside the slice) behave like roots, not crashes.
 */

import { describe, expect, it } from 'vitest';
import { layoutFamily, type TreeNode } from './session-tree-layout';

function node(id: string, parent: string | null, mtimeMs: number): TreeNode {
  return {
    sessionId: id,
    filePath: `/fake/${id}.jsonl`,
    projectDir: '/fake',
    rootUuid: 'root-uuid',
    parentSessionId: parent,
    messageCount: 1,
    mtimeMs,
  };
}

describe('layoutFamily', () => {
  it('linear resume chain stays in one lane', () => {
    const laid = layoutFamily([node('A', null, 1), node('B', 'A', 2), node('C', 'B', 3)]);
    expect(laid.map((n) => n.col)).toEqual([0, 0, 0]);
    expect(laid.map((n) => n.row)).toEqual([0, 1, 2]);
  });

  it('second child of the same parent opens a new lane (the ⑂ split)', () => {
    const laid = layoutFamily([
      node('A', null, 1),
      node('B', 'A', 2), // continues lane 0
      node('C', 'A', 3), // fork → lane 1
      node('D', 'A', 4), // another fork → lane 2
    ]);
    const byId = new Map(laid.map((n) => [n.sessionId, n]));
    expect(byId.get('A')?.col).toBe(0);
    expect(byId.get('B')?.col).toBe(0);
    expect(byId.get('C')?.col).toBe(1);
    expect(byId.get('D')?.col).toBe(2);
  });

  it('fork-of-fork branches off the MIDDLE lane, not the root lane', () => {
    const laid = layoutFamily([
      node('A', null, 1),
      node('B', 'A', 2), // lane 0 (first child)
      node('C', 'A', 3), // lane 1 (fork)
      node('D', 'C', 4), // first child of C → continues lane 1
      node('E', 'C', 5), // second child of C → new lane 2
    ]);
    const byId = new Map(laid.map((n) => [n.sessionId, n]));
    expect(byId.get('D')?.col).toBe(1);
    expect(byId.get('D')?.parent?.sessionId).toBe('C');
    expect(byId.get('E')?.col).toBe(2);
  });

  it('orphan parents do not crash — node opens its own lane like a root', () => {
    const laid = layoutFamily([node('A', null, 1), node('X', 'missing', 2)]);
    const byId = new Map(laid.map((n) => [n.sessionId, n]));
    expect(byId.get('X')?.col).toBe(1);
    expect(byId.get('X')?.parent).toBeUndefined();
  });
});
