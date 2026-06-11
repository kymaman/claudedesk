/**
 * SessionTreeView.tsx — вкладка Tree (вариант 1В).
 *
 * Git-style graph of session FAMILIES: time flows top→bottom, the root
 * session runs down the left rail, branches curve out to their own
 * columns. Lineage comes from the main process (list_session_tree IPC):
 * family membership by shared first-message uuid, parent edges by
 * uuid-overlap heuristics + exact edges ClaudeDesk recorded at branch
 * time. Titles/dates join against the History sessions store.
 *
 * Node actions: click / ▶ resumes the session as a chat tile,
 * ⑂ branches a NEW fork from that exact node.
 */

import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store } from '../store/core';
import { sessions, loadSessions, type SessionItem } from '../store/sessions-history';
import { openChatFromSession, branchChatFromSession } from '../store/chats';
import { setMainView } from '../store/mainView';
import { loadLaunchSettings } from '../store/launch-settings';
import { layoutFamily, type TreeFamily, type TreeNode } from '../lib/session-tree-layout';
import './SessionTreeView.css';

const COL_W = 26;
const ROW_H = 46;
const PAD_X = 22;
const PAD_Y = 26;

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

function defaultAgentId(): string {
  const claude = store.availableAgents.filter(
    (a) => a.id.startsWith('claude-') && a.available !== false,
  );
  return claude[0]?.id ?? store.availableAgents[0]?.id ?? 'claude';
}

export function SessionTreeView() {
  const [filter, setFilter] = createSignal('');
  const [families, { refetch }] = createResource(async () => {
    // Titles join against the History list — make sure it's loaded.
    if (sessions().length === 0) await loadSessions().catch(() => undefined);
    return await invoke<TreeFamily[]>(IPC.ListSessionTree, {});
  });

  const titleById = createMemo(() => {
    const m = new Map<string, SessionItem>();
    for (const s of sessions()) m.set(s.sessionId, s);
    return m;
  });

  function displayTitle(node: TreeNode): string {
    const s = titleById().get(node.sessionId);
    return s?.title ?? `сессия ${node.sessionId.slice(0, 8)}`;
  }

  const visibleFamilies = createMemo(() => {
    const all = families() ?? [];
    const q = filter().trim().toLowerCase();
    if (!q) return all;
    return all.filter((f) =>
      f.members.some(
        (m) => displayTitle(m).toLowerCase().includes(q) || m.sessionId.toLowerCase().startsWith(q),
      ),
    );
  });

  function toSessionItem(node: TreeNode): SessionItem {
    return (
      titleById().get(node.sessionId) ?? {
        sessionId: node.sessionId,
        filePath: node.filePath,
        projectPath: node.projectDir,
        title: displayTitle(node),
        date: new Date(node.mtimeMs).toISOString().slice(0, 10),
        folderIds: [],
      }
    );
  }

  async function settingsFor(sessionId: string) {
    const stored = await loadLaunchSettings(sessionId).catch(() => null);
    return stored ?? { agentId: defaultAgentId(), extraFlags: [], skipPermissions: false };
  }

  async function openNode(node: TreeNode) {
    const s = await settingsFor(node.sessionId);
    openChatFromSession(toSessionItem(node), s);
    setMainView('history');
  }

  async function branchNode(node: TreeNode) {
    const s = await settingsFor(node.sessionId);
    branchChatFromSession(toSessionItem(node), s);
    setMainView('history');
  }

  return (
    <div class="tree-view">
      <div class="tree-view__header">
        <span class="tree-view__title">Дерево сессий</span>
        <input
          class="tree-view__search"
          placeholder="Поиск по семьям…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <button
          class="tree-view__refresh"
          onClick={() => void refetch()}
          title="Перечитать семьи с диска"
        >
          ⟳
        </button>
      </div>

      <div class="tree-view__body">
        <Show when={!families.loading} fallback={<div class="tree-view__empty">Строю дерево…</div>}>
          <Show
            when={visibleFamilies().length > 0}
            fallback={
              <div class="tree-view__empty">
                Семей с ветками пока нет — Branch на тайле или ⑂ на узле создаст первую.
              </div>
            }
          >
            <For each={visibleFamilies()}>
              {(family) => (
                <FamilyGraph
                  family={family}
                  display={displayTitle}
                  onOpen={openNode}
                  onBranch={branchNode}
                />
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function FamilyGraph(props: {
  family: TreeFamily;
  display: (n: TreeNode) => string;
  onOpen: (n: TreeNode) => Promise<void>;
  onBranch: (n: TreeNode) => Promise<void>;
}) {
  const laid = createMemo(() => layoutFamily(props.family.members));
  const maxCol = createMemo(() => laid().reduce((m, n) => Math.max(m, n.col), 0));
  const width = 920;
  const height = createMemo(() => PAD_Y * 2 + laid().length * ROW_H);
  const x = (col: number) => PAD_X + col * COL_W;
  const y = (row: number) => PAD_Y + row * ROW_H + ROW_H / 2;
  const labelX = createMemo(() => x(maxCol()) + 30);

  const newest = createMemo(() =>
    laid().reduce((best, n) => (n.mtimeMs > best.mtimeMs ? n : best), laid()[0]),
  );

  return (
    <div class="tree-family">
      <div class="tree-family__head">
        <span class="tree-family__name">{props.display(props.family.members[0])}</span>
        <span class="tree-family__count">⑂ {props.family.members.length}</span>
      </div>
      <svg
        class="tree-family__svg"
        width={width}
        height={height()}
        viewBox={`0 0 ${width} ${height()}`}
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
            <g class="tree-node" onClick={() => void props.onOpen(n)} role="button" tabIndex={0}>
              {/* row hit-area so clicks on the label work too */}
              <rect
                class="tree-node__hit"
                x={0}
                y={y(n.row) - ROW_H / 2}
                width={width}
                height={ROW_H}
              />
              <circle
                class={`tree-node__dot${n.sessionId === newest().sessionId ? ' tree-node__dot--live' : ''}`}
                cx={x(n.col)}
                cy={y(n.row)}
                r={n.parent ? 5.5 : 7}
              />
              <text class="tree-node__label" x={labelX()} y={y(n.row) - 3}>
                {props.display(n).slice(0, 72)}
              </text>
              <text class="tree-node__meta" x={labelX()} y={y(n.row) + 13}>
                {fmtDate(n.mtimeMs)} · {n.messageCount} зап. · {n.sessionId.slice(0, 8)}
              </text>
              {/* per-node branch button (stops propagation so it doesn't open) */}
              <text
                class="tree-node__branch"
                x={width - 28}
                y={y(n.row) + 4}
                onClick={(e) => {
                  e.stopPropagation();
                  void props.onBranch(n);
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
