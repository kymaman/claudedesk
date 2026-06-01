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

// Default Windows claude binaries. Resolved against the current user's home
// directory so the app ships with working defaults for the two common install
// flavours — npm-global-to-.local and winget. Users with a different layout
// can override via Agents view → Custom agents.
//
// As of Claude Code 2.1.157 the `.local/bin/claude.exe` binary supports
// both Opus 4.7 and Opus 4.8 — model selection moves to an explicit
// `--model <id>` flag rather than relying on the CLI version's default.
// The old WinGet binary (2.1.101) stays around for Opus 4.6.
const WIN_CLAUDE_MODERN = IS_WINDOWS
  ? path.join(homedir(), '.local', 'bin', 'claude.exe')
  : 'claude';
const WIN_CLAUDE_46 = IS_WINDOWS
  ? path.join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'claude.exe')
  : 'claude';

const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: 'claude-opus-4-8',
    name: 'Claude Code (Opus 4.8)',
    command: IS_WINDOWS ? WIN_CLAUDE_MODERN : 'claude',
    args: ['--model', 'claude-opus-4-8'],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: 'Claude Code 2.1.157+ — Opus 4.8 (latest)',
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude Code (Opus 4.7)',
    // Same binary as 4.8 now — but we MUST pass --model explicitly,
    // otherwise the CLI's default (4.8 in 2.1.157+) would override the
    // user's pick. Without this, selecting "Opus 4.7" silently gave 4.8.
    command: IS_WINDOWS ? WIN_CLAUDE_MODERN : 'claude',
    args: ['--model', 'claude-opus-4-7'],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: 'Claude Code 2.1.157+ — pinned to Opus 4.7',
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Code (Opus 4.6)',
    command: IS_WINDOWS ? WIN_CLAUDE_46 : 'claude',
    args: [],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: 'Claude Code 2.1.101 — legacy CLI required for Opus 4.6',
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
