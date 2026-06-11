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

/** One row of the indented outline: the node + its depth from the root. */
export interface OutlineRow {
  node: TreeNode;
  /** 0 = root, +1 per generation — drives left indentation. */
  depth: number;
  /** true when this node has children in the family (for connector guides). */
  hasChildren: boolean;
  /** true when this is the last child of its parent (collapses the guide). */
  isLastChild: boolean;
}

/**
 * Depth-first outline of a family — root, then each child and its
 * descendants, siblings ordered by mtime. This is the Obsidian / iPhone
 * Notes style: every generation indents one step further right. Pure /
 * DOM-free so it unit-tests cleanly.
 */
export function outlineFamily(members: TreeNode[]): OutlineRow[] {
  const byId = new Map(members.map((m) => [m.sessionId, m]));
  const children = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  for (const m of members) {
    const pid = m.parentSessionId;
    if (pid && byId.has(pid)) {
      const arr = children.get(pid) ?? [];
      arr.push(m);
      children.set(pid, arr);
    } else {
      roots.push(m);
    }
  }
  const byMtime = (a: TreeNode, b: TreeNode): number =>
    a.mtimeMs - b.mtimeMs || a.sessionId.localeCompare(b.sessionId);
  roots.sort(byMtime);

  const out: OutlineRow[] = [];
  const visit = (n: TreeNode, depth: number, isLastChild: boolean): void => {
    const kids = (children.get(n.sessionId) ?? []).slice().sort(byMtime);
    out.push({ node: n, depth, hasChildren: kids.length > 0, isLastChild });
    kids.forEach((k, i) => visit(k, depth + 1, i === kids.length - 1));
  };
  roots.forEach((r, i) => visit(r, 0, i === roots.length - 1));
  return out;
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
