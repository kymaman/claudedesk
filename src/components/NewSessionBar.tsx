/**
 * NewSessionBar.tsx
 * Thin strip under TopSwitcher. Collapsed: a single "+ New session" button.
 * Expanded: inline form with title / cwd / agent / extra flags / skip-perms,
 * runs openFreshChat() without going through parallel-code's worktree flow.
 */

import { For, Show, createSignal } from 'solid-js';
import { store } from '../store/store';
import { openFreshChat } from '../store/chats';
import './NewSessionBar.css';

export function NewSessionBar() {
  const [open, setOpen] = createSignal(false);
  const [title, setTitle] = createSignal('');
  const [cwd, setCwd] = createSignal('');
  const [agentId, setAgentId] = createSignal('claude-opus-4-7');
  const [flags, setFlags] = createSignal('');
  const [skipPerms, setSkipPerms] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const claudeAgents = () => store.availableAgents.filter((a) => a.id.startsWith('claude-'));

  function reset() {
    setTitle('');
    setCwd('');
    setFlags('');
    setSkipPerms(false);
  }

  async function launch(e?: Event) {
    e?.preventDefault();
    if (busy()) return;
    setBusy(true);
    try {
      const extraFlags = flags()
        .split(/\r?\n|\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      // Empty cwd → pty falls back to the user's home dir (see electron/ipc/pty.ts).
      openFreshChat({
        cwd: cwd().trim(),
        agentId: agentId(),
        extraFlags,
        skipPermissions: skipPerms(),
        title: title().trim() || 'New chat',
      });
      reset();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="new-session-bar">
      <Show
        when={!open()}
        fallback={
          <form class="new-session-bar__form" onSubmit={launch}>
            <input
              class="nsb-input nsb-input--title"
              placeholder="Title (optional)"
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
            <input
              class="nsb-input nsb-input--cwd"
              placeholder="cwd — absolute path (optional, defaults to home)"
              value={cwd()}
              onInput={(e) => setCwd(e.currentTarget.value)}
              spellcheck={false}
            />
            <select
              class="nsb-select"
              value={agentId()}
              onChange={(e) => setAgentId(e.currentTarget.value)}
              title="Agent"
            >
              <For each={claudeAgents()}>
                {(a) => <option value={a.id}>{a.name.replace(/^Claude Code\s*/, '')}</option>}
              </For>
            </select>
            <input
              class="nsb-input nsb-input--flags"
              placeholder="Extra flags e.g. --model sonnet"
              value={flags()}
              onInput={(e) => setFlags(e.currentTarget.value)}
              spellcheck={false}
            />
            <label class="nsb-check" title="Adds --dangerously-skip-permissions">
              <input
                type="checkbox"
                checked={skipPerms()}
                onChange={(e) => setSkipPerms(e.currentTarget.checked)}
              />
              skip perms
            </label>
            <button class="nsb-btn nsb-btn--run" type="submit" disabled={busy()}>
              {busy() ? '…' : 'Launch'}
            </button>
            <button
              class="nsb-btn nsb-btn--cancel"
              type="button"
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              ×
            </button>
          </form>
        }
      >
        <button class="new-session-bar__trigger" onClick={() => setOpen(true)}>
          <span class="nsb-plus">+</span>
          <span>New session</span>
          <span class="nsb-hint">click to configure launch options</span>
        </button>
      </Show>
    </div>
  );
}
