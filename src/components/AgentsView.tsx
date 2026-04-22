/**
 * AgentsView.tsx
 * Main-view for managing CLI agents and global terminal defaults.
 */

import { For, Show, createSignal, createEffect } from 'solid-js';
import { store } from '../store/store';
import {
  terminalDefaults,
  setTerminalFlags,
  setTerminalEnv,
  parseFlagsInput,
  parseEnvInput,
  stringifyFlags,
  stringifyEnv,
} from '../store/terminal-defaults';
import { CustomAgentEditor } from './CustomAgentEditor';
import './AgentsView.css';

export function AgentsView() {
  const [flagsDraft, setFlagsDraft] = createSignal(stringifyFlags(terminalDefaults().flags));
  const [envDraft, setEnvDraft] = createSignal(stringifyEnv(terminalDefaults().env));
  const [savedFlash, setSavedFlash] = createSignal<string | null>(null);

  // Reset drafts when stored value changes externally (e.g. load on mount)
  createEffect(() => {
    setFlagsDraft(stringifyFlags(terminalDefaults().flags));
    setEnvDraft(stringifyEnv(terminalDefaults().env));
  });

  function saveFlags() {
    setTerminalFlags(parseFlagsInput(flagsDraft()));
    flash('flags saved');
  }

  function saveEnv() {
    setTerminalEnv(parseEnvInput(envDraft()));
    flash('env saved');
  }

  function flash(msg: string) {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(null), 1500);
  }

  return (
    <div class="agents-view">
      <div class="agents-view__scroller">
        <section class="agents-section">
          <h2 class="agents-section__title">CLI agents</h2>
          <p class="agents-section__desc">
            Built-in + custom CLI agents. Each can be used to resume sessions from History or
            start new Branches tasks. The &quot;Claude Code (Opus 4.6/4.7)&quot; presets point
            directly at the two installed claude binaries on this machine.
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
                  <Show when={agent.resume_args.length > 0 || agent.skip_permissions_args.length > 0}>
                    <div class="agent-card__flags">
                      <Show when={agent.resume_args.length > 0}>
                        <span class="agent-card__flag">
                          resume: <code>{agent.resume_args.join(' ')}</code>
                        </span>
                      </Show>
                      <Show when={agent.skip_permissions_args.length > 0}>
                        <span class="agent-card__flag">
                          yolo: <code>{agent.skip_permissions_args.join(' ')}</code>
                        </span>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>

          <h3 class="agents-section__subtitle">Custom agents</h3>
          <CustomAgentEditor />
        </section>

        <section class="agents-section">
          <h2 class="agents-section__title">Terminal defaults</h2>
          <p class="agents-section__desc">
            These flags and env vars are applied to every new Claude terminal you open, on top
            of the agent&apos;s own defaults. Per-session version / args override them.
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
                <code>HTTPS_PROXY=http://localhost:7890</code>
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
      </div>
    </div>
  );
}
