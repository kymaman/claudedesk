/**
 * AgentsView.tsx
 * Main-view for managing CLI agents and global terminal defaults.
 */

import { For, Show, createSignal, createEffect } from 'solid-js';
import { store, toggleSettingsDialog, setAutoTrustFolders } from '../store/store';
import {
  terminalDefaults,
  setTerminalFlags,
  setTerminalEnv,
  parseFlagsInput,
  parseEnvInput,
  stringifyFlags,
  stringifyEnv,
} from '../store/terminal-defaults';
import {
  filterState,
  setExtraFolders,
  setMinSizeKb,
  setMinDurationSec,
} from '../store/session-filters';
import { loadSessions } from '../store/sessions-history';
import { CustomAgentEditor } from './CustomAgentEditor';
import './AgentsView.css';

export function AgentsView() {
  const [flagsDraft, setFlagsDraft] = createSignal(stringifyFlags(terminalDefaults().flags));
  const [envDraft, setEnvDraft] = createSignal(stringifyEnv(terminalDefaults().env));
  const [extraFoldersDraft, setExtraFoldersDraft] = createSignal(
    filterState().extraFolders.join('\n'),
  );
  const [savedFlash, setSavedFlash] = createSignal<string | null>(null);

  // Reset drafts when stored value changes externally (e.g. load on mount)
  createEffect(() => {
    setFlagsDraft(stringifyFlags(terminalDefaults().flags));
    setEnvDraft(stringifyEnv(terminalDefaults().env));
  });
  createEffect(() => {
    setExtraFoldersDraft(filterState().extraFolders.join('\n'));
  });

  function saveFlags() {
    setTerminalFlags(parseFlagsInput(flagsDraft()));
    flash('flags saved');
  }

  function saveEnv() {
    setTerminalEnv(parseEnvInput(envDraft()));
    flash('env saved');
  }

  async function saveExtraFolders() {
    const folders = extraFoldersDraft()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    setExtraFolders(folders);
    flash('folders saved');
    await loadSessions();
  }

  function flash(msg: string) {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(null), 1500);
  }

  return (
    <div class="agents-view">
      <div class="agents-view__scroller">
        <div class="agents-view__header">
          <h1 class="agents-view__h1">Agents &amp; Settings</h1>
          <button
            class="agents-view__apprefs"
            onClick={() => toggleSettingsDialog()}
            title="Open theme, terminal font, global scale, etc."
          >
            App preferences…
          </button>
        </div>

        <section class="agents-section">
          <h2 class="agents-section__title">CLI agents</h2>
          <p class="agents-section__desc">
            Built-in + custom CLI agents. Each can be used to resume sessions from History or start
            new Branches tasks. Click a session&apos;s ▶ to launch it with the agent you pick.
          </p>
          <div class="agents-list">
            <For each={store.availableAgents}>
              {(agent) => (
                <div class="agent-card">
                  <div class="agent-card__head">
                    <span class="agent-card__name">{agent.name}</span>
                    <span
                      class={`agent-card__status ${
                        agent.available === false ? 'is-missing' : 'is-ok'
                      }`}
                      title={agent.available === false ? 'Not found in PATH' : 'Available'}
                    >
                      {agent.available === false ? '✕ missing' : '● ready'}
                    </span>
                  </div>
                  <div class="agent-card__cmd" title={agent.command}>
                    {agent.command}
                  </div>
                  <Show when={agent.description}>
                    <div class="agent-card__desc">{agent.description}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <h3 class="agents-section__subtitle">Custom agents</h3>
          <CustomAgentEditor />
        </section>

        <section class="agents-section agents-section--accent">
          <h2 class="agents-section__title">Auto-trust folders</h2>
          <p class="agents-section__desc">
            Appends <code>--dangerously-skip-permissions</code> to every Claude chat so you never
            have to confirm "Trust this folder?" manually.
          </p>
          <label class="launch-option">
            <input
              type="checkbox"
              checked={store.autoTrustFolders}
              onChange={(e) => setAutoTrustFolders(e.currentTarget.checked)}
            />
            <span>
              Auto-accept "Trust this folder?" prompts
              <Show when={store.autoTrustFolders}>
                <span class="defaults-flash" style={{ 'margin-left': '8px' }}>
                  ✓ enabled
                </span>
              </Show>
            </span>
          </label>
        </section>

        <section class="agents-section agents-section--accent">
          <h2 class="agents-section__title">Terminal defaults · applied to every chat</h2>
          <p class="agents-section__desc">
            Flags and env vars here are appended to the args / env of every new terminal (History
            resumes + Branches tasks). Per-session overrides (gear ⚙ on a session row) win over
            these defaults.
          </p>

          <div class="defaults-block">
            <label class="defaults-label">
              Default flags
              <span class="defaults-hint">
                one per line — e.g. <code>--dangerously-skip-permissions</code>
              </span>
            </label>
            <textarea
              class="defaults-textarea"
              spellcheck={false}
              value={flagsDraft()}
              onInput={(e) => setFlagsDraft(e.currentTarget.value)}
              placeholder="--dangerously-skip-permissions"
              rows={4}
            />
            <div class="defaults-actions">
              <button class="defaults-btn" onClick={saveFlags}>
                Save flags
              </button>
              <Show when={savedFlash() === 'flags saved'}>
                <span class="defaults-flash">✓ saved</span>
              </Show>
            </div>
          </div>

          <div class="defaults-block">
            <label class="defaults-label">
              Environment variables
              <span class="defaults-hint">
                one per line as <code>KEY=VALUE</code>. Example:{' '}
                <code>HTTPS_PROXY=http://localhost:7890</code>. Pasting a shell line like{' '}
                <code>$env:HTTPS_PROXY="..."</code> or <code>export HTTPS_PROXY='...'</code> also
                works.
              </span>
            </label>
            <textarea
              class="defaults-textarea"
              spellcheck={false}
              value={envDraft()}
              onInput={(e) => setEnvDraft(e.currentTarget.value)}
              placeholder="HTTPS_PROXY=http://localhost:7890"
              rows={4}
            />
            <div class="defaults-actions">
              <button class="defaults-btn" onClick={saveEnv}>
                Save env
              </button>
              <Show when={savedFlash() === 'env saved'}>
                <span class="defaults-flash">✓ saved</span>
              </Show>
            </div>
          </div>
        </section>

        <section class="agents-section">
          <h2 class="agents-section__title">Scan extra folders</h2>
          <p class="agents-section__desc">
            Additional paths to scan for Claude Code JSONL sessions (beyond
            <code> ~/.claude/projects</code>). One absolute path per line. Changes refresh the
            History list immediately.
          </p>
          <textarea
            class="defaults-textarea"
            spellcheck={false}
            value={extraFoldersDraft()}
            onInput={(e) => setExtraFoldersDraft(e.currentTarget.value)}
            placeholder={'D:\\projects\\claude-backups\nC:\\Users\\burmistrov\\OneDrive\\claude'}
            rows={3}
          />
          <div class="defaults-actions">
            <button class="defaults-btn" onClick={() => void saveExtraFolders()}>
              Save & rescan
            </button>
            <Show when={savedFlash() === 'folders saved'}>
              <span class="defaults-flash">✓ saved · rescanning…</span>
            </Show>
          </div>
        </section>

        <section class="agents-section">
          <h2 class="agents-section__title">Noise filters</h2>
          <p class="agents-section__desc">
            Hide low-signal sessions from the History list. Use the ◆ / ◇ toggles next to each
            project in the sidebar for per-project hiding.
          </p>
          <div class="defaults-block">
            <label class="defaults-label">
              Minimum file size (KB) <span class="defaults-hint">0 = off</span>
            </label>
            <input
              class="defaults-textarea"
              type="number"
              min="0"
              step="1"
              value={filterState().minSizeKb}
              onChange={(e) => setMinSizeKb(Number(e.currentTarget.value) || 0)}
              style={{ width: '120px' }}
            />
          </div>
          <div class="defaults-block">
            <label class="defaults-label">
              Minimum duration (sec) <span class="defaults-hint">0 = off</span>
            </label>
            <input
              class="defaults-textarea"
              type="number"
              min="0"
              step="10"
              value={filterState().minDurationSec}
              onChange={(e) => setMinDurationSec(Number(e.currentTarget.value) || 0)}
              style={{ width: '120px' }}
            />
          </div>
          <p class="defaults-hint">
            Note: size/duration metadata is extracted from JSONL on scan. Sessions smaller than your
            threshold won't appear in the list but stay on disk.
          </p>
        </section>
      </div>
    </div>
  );
}
