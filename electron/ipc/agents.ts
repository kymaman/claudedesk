import path from 'path';
import { homedir } from 'os';
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

import { IS_WINDOWS } from '../platform.js';

// Default Windows claude binaries (user can override via custom agents).
// Resolved against the actual user's home directory so the app ships
// with working defaults regardless of who installed it.
//
// `.local/bin/claude.exe` is the modern claude CLI 2.1.162 — supports
// Opus 4.8 via `--model claude-opus-4-8`. Its TUI uses the alt-screen
// buffer, so scrollback in xterm.js v5 is empty by default; we mitigate
// that with the AltScreenStripper in the PTY pipeline (see
// strip-alt-screen.ts + agentSpawn integration), which makes claude
// redraw into the normal buffer so old frames land in scrollback.
//
// `claude-4.7/claude.exe` is claude CLI 2.1.116 pinned for users who
// still want Opus 4.7 (the only version available on 2.1.116). The
// WinGet path is the legacy 2.1.101 binary that still works for 4.6.
const WIN_CLAUDE_MODERN = IS_WINDOWS
  ? path.join(homedir(), '.local', 'bin', 'claude.exe')
  : 'claude';
const WIN_CLAUDE_47 = IS_WINDOWS
  ? path.join(homedir(), '.local', 'bin', 'claude-4.7', 'claude.exe')
  : 'claude';
const WIN_CLAUDE_46 = IS_WINDOWS
  ? path.join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'claude.exe')
  : 'claude';

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: 'claude-opus-4-8',
    name: 'Claude Code (Opus 4.8)',
    command: IS_WINDOWS ? WIN_CLAUDE_MODERN : 'claude',
    args: ['--remote-control', '--model', 'claude-opus-4-8'],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: 'Claude Code 2.1.162 — Opus 4.8 (latest)',
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude Code (Opus 4.7)',
    command: IS_WINDOWS ? WIN_CLAUDE_47 : 'claude',
    args: ['--remote-control'],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: 'Claude Code 2.1.116 — Opus 4.7 / Sonnet 4.6',
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Code (Opus 4.6)',
    command: IS_WINDOWS ? WIN_CLAUDE_46 : 'claude',
    args: ['--remote-control'],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: 'Claude Code 2.1.101 — legacy CLI required for Opus 4.6',
  },
  {
    id: 'claude-code',
    name: 'Claude Code (system)',
    command: 'claude',
    args: ['--remote-control'],
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
