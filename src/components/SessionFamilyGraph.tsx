/**
 * SessionFamilyGraph.tsx — git-style graph of ONE session family.
 *
 * Embedded inline in History (a row's ▸ toggle expands it right under
 * the row — «одна входит в другую»). Time flows top→bottom, the root
 * session runs down the left rail, branches curve out to their own
 * columns. Click a node → resume that session; ⑂ → fork from it.
 *
 * Extracted from the former SessionTreeView (the separate Tree tab was
 * removed 2026-06-11 per the owner's request — the tree now lives
 * inside History).
 */

import { For, Show, createMemo } from 'solid-js';
import { layoutFamily, type TreeFamily, type TreeNode } from '../lib/session-tree-layout';
import './SessionFamilyGraph.css';

const COL_W = 26;
const ROW_H = 46;
const PAD_X = 22;
const PAD_Y = 14;
const WIDTH = 760;

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
  const laid = createMemo(() => layoutFamily(props.family.members));
  const maxCol = createMemo(() => laid().reduce((m, n) => Math.max(m, n.col), 0));
  const height = createMemo(() => PAD_Y * 2 + laid().length * ROW_H);
  const x = (col: number) => PAD_X + col * COL_W;
  const y = (row: number) => PAD_Y + row * ROW_H + ROW_H / 2;
  const labelX = createMemo(() => x(maxCol()) + 30);

  const newest = createMemo(() =>
    laid().reduce((best, n) => (n.mtimeMs > best.mtimeMs ? n : best), laid()[0]),
  );

  return (
    <div class="tree-family">
      <svg
        class="tree-family__svg"
        width={WIDTH}
        height={height()}
        viewBox={`0 0 ${WIDTH} ${height()}`}
      >
        {/* edges first, under the nodes */}
        <For each={laid()}>
          {(n) => (
            <Show when={n.parent}>
              {(p) => {
                const px = x(p().col);
                const py = y(p().row);
                const cx = x(n.col);
                const cy = y(n.row);
                const d =
                  n.col === p().col
                    ? `M ${px} ${py} L ${cx} ${cy}`
                    : `M ${px} ${py} C ${px} ${py + ROW_H * 0.7}, ${cx} ${cy - ROW_H * 0.7}, ${cx} ${cy}`;
                return <path class="tree-edge" d={d} />;
              }}
            </Show>
          )}
        </For>
        <For each={laid()}>
          {(n) => (
            <g class="tree-node" onClick={() => props.onOpen(n)} role="button" tabIndex={0}>
              {/* row hit-area so clicks on the label work too */}
              <rect
                class="tree-node__hit"
                x={0}
                y={y(n.row) - ROW_H / 2}
                width={WIDTH}
                height={ROW_H}
              />
              <circle
                class={`tree-node__dot${n.sessionId === newest().sessionId ? ' tree-node__dot--live' : ''}`}
                cx={x(n.col)}
                cy={y(n.row)}
                r={n.parent ? 5.5 : 7}
              />
              <text class="tree-node__label" x={labelX()} y={y(n.row) - 3}>
                {props.display(n).slice(0, 64)}
              </text>
              <text class="tree-node__meta" x={labelX()} y={y(n.row) + 13}>
                {fmtDate(n.mtimeMs)} · {n.messageCount} зап. · {n.sessionId.slice(0, 8)}
              </text>
              {/* per-node branch button (stops propagation so it doesn't open) */}
              <text
                class="tree-node__branch"
                x={WIDTH - 28}
                y={y(n.row) + 4}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onBranch(n);
                }}
              >
                ⑂
              </text>
              <title>{`${props.display(n)}\nоткрыть — клик · ветвиться — ⑂ справа`}</title>
            </g>
          )}
        </For>
      </svg>
    </div>
  );
}
