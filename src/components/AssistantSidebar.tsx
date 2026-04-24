/**
 * AssistantSidebar.tsx
 * Right-docked panel that spawns a small Claude CLI pointed at a dedicated
 * cwd containing a CLAUDE.md + SESSIONS-INDEX.md. The model answers user
 * queries with [[open:<uuid>]] markers which we parse from the terminal
 * stream; each hit becomes a clickable chip under the terminal that opens
 * the matching chat in the main grid.
 */

import { createSignal, createMemo, For, Show, onMount, onCleanup } from 'solid-js';
import { TerminalView } from './TerminalView';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store } from '../store/store';
import { sessions, loadSessions } from '../store/sessions-history';
import { openChatFromSession } from '../store/chats';
import { assistantOpen, setAssistantOpen } from '../store/assistant';
import { extractChatIds } from '../lib/chat-markers';
import './AssistantSidebar.css';

interface AssistantInitRes {
  cwd: string;
  sessionsCount: number;
}

// Keep the decoded tail bounded so pattern matching over a long-running
// terminal doesn't grow unboundedly.
const DECODE_TAIL_BYTES = 32 * 1024;

export function AssistantSidebar() {
  const [cwd, setCwd] = createSignal<string | null>(null);
  const [sessionsCount, setSessionsCount] = createSignal(0);
  const [matchedIds, setMatchedIds] = createSignal<string[]>([]);
  const [refreshing, setRefreshing] = createSignal(false);
  const [launchKey, setLaunchKey] = createSignal(0); // bump → remount terminal

  let decodedTail = '';
  const decoder = new TextDecoder('utf-8', { fatal: false });

  onMount(() => {
    void bootstrap();
    if (sessions().length === 0) void loadSessions();
  });

  async function bootstrap() {
    try {
      const res = await invoke<AssistantInitRes>(IPC.EnsureAssistantCwd, {});
      setCwd(res.cwd);
      setSessionsCount(res.sessionsCount);
    } catch (err) {
      console.error('[assistant] bootstrap failed', err);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await invoke<{ sessionsCount: number }>(IPC.RefreshAssistantIndex, {});
      setSessionsCount(res.sessionsCount);
    } catch (err) {
      console.error('[assistant] refresh failed', err);
    } finally {
      setRefreshing(false);
    }
  }

  function restart() {
    setMatchedIds([]);
    decodedTail = '';
    setLaunchKey((k) => k + 1);
  }

  function handleData(data: Uint8Array) {
    // The TerminalView forwards a capped slice of the raw PTY bytes. Decode
    // and append to a rolling window so we can pattern-match across chunk
    // boundaries without re-scanning the full history on every byte.
    decodedTail = (decodedTail + decoder.decode(data, { stream: true })).slice(-DECODE_TAIL_BYTES);
    const ids = extractChatIds(decodedTail);
    if (ids.length === 0) return;
    // Only add ids that correspond to a session we actually know about —
    // avoids chips for random UUIDs the model hallucinated.
    const known = new Set(sessions().map((s) => s.sessionId.toLowerCase()));
    const filtered = ids.filter((id) => known.has(id));
    if (filtered.length === 0) return;
    setMatchedIds((prev) => {
      const merged = new Set(prev);
      for (const id of filtered) merged.add(id);
      return Array.from(merged);
    });
  }

  const agent = () =>
    store.availableAgents.find((a) => a.id === 'claude-opus-4-7') ??
    store.availableAgents.find((a) => a.id.startsWith('claude-')) ??
    store.availableAgents[0];

  // Each remount gets its own taskId/agentId so the PTY session map doesn't
  // collide with other terminals.
  const terminalIds = createMemo(() => {
    const k = launchKey();
    return {
      key: k,
      taskId: `assistant-task-${k}`,
      agentId: `assistant-agent-${k}`,
    };
  });

  const matchedSessions = createMemo(() => {
    const ids = matchedIds();
    const list = sessions();
    // Preserve click-order (oldest match first).
    return ids
      .map((id) => list.find((s) => s.sessionId.toLowerCase() === id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
  });

  function openMatch(sessionId: string) {
    const s = sessions().find((x) => x.sessionId.toLowerCase() === sessionId.toLowerCase());
    if (!s) return;
    openChatFromSession(s, {
      agentId: agent()?.id ?? 'claude-opus-4-7',
      extraFlags: [],
      skipPermissions: false,
    });
  }

  onCleanup(() => {
    // No explicit kill — TerminalView's cleanup path handles it.
  });

  return (
    <aside class="assistant-sidebar">
      <header class="assistant-sidebar__head">
        <span class="assistant-sidebar__title">Ask</span>
        <span class="assistant-sidebar__meta" title="Chats indexed for search">
          {sessionsCount()} chats
        </span>
        <button
          class="assistant-sidebar__btn"
          onClick={() => void refresh()}
          title="Rebuild the chats index"
          disabled={refreshing()}
        >
          {refreshing() ? '…' : '↻'}
        </button>
        <button
          class="assistant-sidebar__btn"
          onClick={restart}
          title="Restart the Claude terminal"
        >
          ⟲
        </button>
        <button
          class="assistant-sidebar__btn assistant-sidebar__btn--close"
          onClick={() => setAssistantOpen(false)}
          title="Hide sidebar"
        >
          ×
        </button>
      </header>

      <div class="assistant-sidebar__terminal">
        <Show
          when={cwd() && agent()}
          fallback={<div class="assistant-sidebar__boot">Starting…</div>}
        >
          {/* <For each={[key]}> rebuilds the TerminalView when `restart()`
              bumps launchKey — unmount old PTY, mount fresh one. */}
          <For each={[terminalIds()]}>
            {(ids) => {
              const a = agent();
              const c = cwd();
              if (!a || !c) return null;
              return (
                <TerminalView
                  taskId={ids.taskId}
                  agentId={ids.agentId}
                  command={a.command}
                  args={a.args ?? []}
                  cwd={c}
                  onData={handleData}
                />
              );
            }}
          </For>
        </Show>
      </div>

      <Show when={matchedSessions().length > 0}>
        <div class="assistant-sidebar__matches">
          <div class="assistant-sidebar__matches-head">
            <span>Suggested chats</span>
            <button
              class="assistant-sidebar__btn"
              onClick={() => setMatchedIds([])}
              title="Clear chips"
            >
              clear
            </button>
          </div>
          <div class="assistant-sidebar__chips">
            <For each={matchedSessions()}>
              {(s) => (
                <button
                  class="assistant-chip"
                  onClick={() => openMatch(s.sessionId)}
                  title={`Open ${s.title} (${s.date})`}
                >
                  <span class="assistant-chip__title">{s.title}</span>
                  <span class="assistant-chip__date">{s.date}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </aside>
  );
}

// Re-export the store API so App.tsx can mount conditionally without pulling
// two imports.
export { assistantOpen };
