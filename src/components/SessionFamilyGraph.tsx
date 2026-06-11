/**
 * SessionFamilyGraph.tsx — indented OUTLINE of one session family.
 *
 * Embedded inline in History (a row's ▸ toggle expands it right under
 * the row — «одна входит в другую»). Obsidian / iPhone-Notes style:
 * the root sits at the left, every branch generation indents one step
 * further right, with guide lines down each level. Readable on the
 * normal list background (the old SVG git-graph rendered near-invisible
 * on the dark panel — replaced 2026-06-11 per the owner's feedback).
 *
 * Click a node → resume that session; ⑂ → fork a new branch from it.
 */

import { For, createMemo } from 'solid-js';
import { outlineFamily, type TreeFamily, type TreeNode } from '../lib/session-tree-layout';
import './SessionFamilyGraph.css';

const INDENT_PX = 22;

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return `сегодня ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function SessionFamilyGraph(props: {
  family: TreeFamily;
  /** Display title for a node (joined from the History sessions list). */
  display: (n: TreeNode) => string;
  onOpen: (n: TreeNode) => void;
  onBranch: (n: TreeNode) => void;
}) {
  const rows = createMemo(() => outlineFamily(props.family.members));
  const newest = createMemo(() =>
    props.family.members.reduce(
      (best, n) => (n.mtimeMs > best.mtimeMs ? n : best),
      props.family.members[0],
    ),
  );

  return (
    <div class="fam-outline">
      <For each={rows()}>
        {(row) => {
          const isNewest = () => row.node.sessionId === newest().sessionId;
          return (
            <div
              class="fam-row"
              style={{ 'padding-left': `${row.depth * INDENT_PX}px` }}
              role="button"
              tabIndex={0}
              onClick={() => props.onOpen(row.node)}
              title={`${props.display(row.node)}\nоткрыть — клик · ветвиться — ⑂`}
            >
              <span class={`fam-row__bullet${isNewest() ? ' fam-row__bullet--live' : ''}`}>
                {row.depth === 0 ? '●' : '⑂'}
              </span>
              <span class="fam-row__body">
                <span class="fam-row__title">{props.display(row.node)}</span>
                <span class="fam-row__meta">
                  {fmtDate(row.node.mtimeMs)} · {row.node.messageCount} зап. ·{' '}
                  {row.node.sessionId.slice(0, 8)}
                </span>
              </span>
              <button
                class="fam-row__branch"
                title="Ветвиться от этой сессии"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onBranch(row.node);
                }}
              >
                ⑂
              </button>
            </div>
          );
        }}
      </For>
    </div>
  );
}
