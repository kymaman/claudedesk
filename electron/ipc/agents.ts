import { isCommandOnPath } from '../platform.js';

interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  skip_permissions_args: string[];
  description: string;
  available?: boolean;
  prompt_ready_delay_ms?: number;
}

import path from 'path';
import { homedir } from 'os';
import { IS_WINDOWS } from '../platform.js';

// One binary per Opus version. Empirically `--model <id>` on a single
// shared CLI changed claude's TUI behaviour enough to make terminal
// scrollback unreachable for users; the cleanest mitigation is to
// install one CLI per supported model and select via PATH alone — no
// `--model` flag. Users without the binary can grab it from
// CLAUDE_DOWNLOAD_URLS below (UI exposes a "Download" button next to
// each missing agent).
//
// Layout convention (Windows):
//   ~/.local/bin/claude.exe                          → 4.8 (npm latest install)
//   ~/.local/bin/claude-4.7/claude.exe               → 4.7 (CLI 2.1.116)
//   ~/AppData/Local/Microsoft/WinGet/Links/claude.exe → 4.6 (WinGet, CLI 2.1.101)
const WIN_CLAUDE_48 = IS_WINDOWS ? path.join(homedir(), '.local', 'bin', 'claude.exe') : 'claude';
const WIN_CLAUDE_47 = IS_WINDOWS
  ? path.join(homedir(), '.local', 'bin', 'claude-4.7', 'claude.exe')
  : 'claude';
const WIN_CLAUDE_46 = IS_WINDOWS
  ? path.join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'claude.exe')
  : 'claude';

/**
 * Official tarball URLs for each Opus version's Claude Code CLI. Used by
 * the Agents view to offer a one-click "Download" when a binary is
 * missing. Anyone — not just the original author — can fetch these
 * because they're the npm public registry, no auth.
 */
export const CLAUDE_DOWNLOAD_URLS: Record<string, string | null> = {
  'claude-opus-4-8': null, // latest — install via `npm i -g @anthropic-ai/claude-code`
  'claude-opus-4-7':
    'https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.116.tgz',
  'claude-opus-4-6':
    'https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.101.tgz',
};

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: 'claude-opus-4-8',
    name: 'Claude Code (Opus 4.8)',
    command: IS_WINDOWS ? WIN_CLAUDE_48 : 'claude',
    args: [],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: 'Claude Code 2.1.157+ — Opus 4.8 (default install at ~/.local/bin/claude.exe)',
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude Code (Opus 4.7)',
    command: IS_WINDOWS ? WIN_CLAUDE_47 : 'claude',
    args: [],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: 'Claude Code 2.1.116 — Opus 4.7 (install via Download button)',
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Code (Opus 4.6)',
    command: IS_WINDOWS ? WIN_CLAUDE_46 : 'claude',
    args: [],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: 'Claude Code 2.1.101 — Opus 4.6 (WinGet install)',
  },
  {
    id: 'claude-code',
    name: 'Claude Code (system)',
    command: 'claude',
    args: [],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: "Whichever 'claude' resolves on PATH",
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    args: [],
    resume_args: ['resume', '--last'],
    skip_permissions_args: ['--full-auto'],
    description: "OpenAI's Codex CLI agent",
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: [],
    resume_args: ['--resume', 'latest'],
    skip_permissions_args: ['--yolo'],
    description: "Google's Gemini CLI agent",
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: 'Open source AI coding agent (opencode.ai)',
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    command: 'copilot',
    args: [],
    resume_args: [],
    skip_permissions_args: ['--yolo'],
    description: "GitHub's Copilot CLI agent",
    prompt_ready_delay_ms: 1_000,
  },
];

async function isCommandAvailable(command: string): Promise<boolean> {
  return isCommandOnPath(command);
}

// TTL cache to avoid repeated `which` calls
let cachedAgents: AgentDef[] | null = null;
let cacheTime = 0;
const AGENT_CACHE_TTL = 30_000;

export async function listAgents(): Promise<AgentDef[]> {
  const now = Date.now();
  if (cachedAgents && now - cacheTime < AGENT_CACHE_TTL) {
    return cachedAgents;
  }

  cachedAgents = await Promise.all(
    DEFAULT_AGENTS.map(async (agent) => ({
      ...agent,
      available: await isCommandAvailable(agent.command),
    })),
  );
  cacheTime = now;
  return cachedAgents;
}
