/**
 * session-tree-layout.ts — pure lane/row layout for the Tree view
 * (вариант 1В). Kept free of Solid/DOM so it unit-tests cleanly.
 */

export interface TreeNode {
  sessionId: string;
  filePath: string;
  projectDir: string;
  rootUuid: string;
  parentSessionId: string | null;
  messageCount: number;
  mtimeMs: number;
}

export interface TreeFamily {
  rootUuid: string;
  members: TreeNode[];
}

/** Laid-out node: graph lane (column) + time order (row). */
export interface LaidNode extends TreeNode {
  col: number;
  row: number;
  parent?: LaidNode | undefined;
}

/**
 * Assign lanes git-graph style: members arrive mtime-ordered (root
 * first — guaranteed by the main process). The FIRST child of a node
 * continues its parent's lane; every further child opens the next free
 * lane to the right. Orphans (parent missing from the family slice)
 * open their own lane like roots.
 */
export function layoutFamily(members: TreeNode[]): LaidNode[] {
  const laid = new Map<string, LaidNode>();
  const childCount = new Map<string, number>();
  let nextCol = 0;
  const out: LaidNode[] = [];
  members.forEach((m, row) => {
    const parent = m.parentSessionId ? laid.get(m.parentSessionId) : undefined;
    let col: number;
    if (!parent) {
      col = nextCol;
      nextCol += 1;
    } else {
      const nth = childCount.get(parent.sessionId) ?? 0;
      childCount.set(parent.sessionId, nth + 1);
      if (nth === 0) {
        col = parent.col;
      } else {
        col = nextCol;
        nextCol += 1;
      }
    }
    const node: LaidNode = { ...m, col, row, parent };
    laid.set(m.sessionId, node);
    out.push(node);
  });
  return out;
}
