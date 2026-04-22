# ClaudeDesk

Desktop app for running and switching between Claude Code sessions. One window, many dialogs, full history, isolated git worktrees, Nothing-inspired UI.

Forked from [parallel-code](https://github.com/johannesjo/parallel-code) (MIT). Extended with:

- **Claude sessions history sidebar** — index of every `~/.claude/projects/*/*.jsonl` session on the machine, enriched with the project-wide `SESSIONS_INDEX.md` summaries. Rename dialogs locally; the alias survives across restarts.
- **CLI version picker** — pre-configured presets for Claude Code 2.1.116 (Opus 4.7) and 2.1.101 (Opus 4.6, required for legacy models). Add your own via Custom Agents.
- **Custom launch flags** — per-agent overrides: `--dangerously-skip-permissions`, `--continue`, custom `args` and `resume_args`.
- **Worktree isolation** — every new task gets its own git branch + worktree. Run five claudes on five features simultaneously with zero file conflicts.
- **Tile layout** — 1 / 2 / 4 / 6 terminals per window, drag-to-reorder, drag-to-resize.
- **Multi-window** — open nested windows, each with its own tile grid, for wide-monitor or multi-monitor setups.
- **Nothing theme** — OLED black, Space Grotesk / Space Mono, monochrome + single accent. Toggle in Settings → Theme.

## Platform

- **Windows 10/11** — primary target (parallel-code itself only listed macOS/Linux; ClaudeDesk fixes PATH resolution, shell selection, and `HOME`/`USERPROFILE` handling).
- macOS / Linux — inherited from parallel-code base, should work but less tested.

## Prerequisites

- Node.js 22+, npm 10+
- Git 2.40+ (`git worktree` must be available)
- One or more Claude Code installs (see CLI version picker above)

## Install

```bash
npm install
```

On Windows, if `node-pty` or `better-sqlite3` rebuild fails, install the Visual Studio Build Tools (Desktop development with C++) and try again.

## Run in dev

```bash
npm run dev
```

## Build

```bash
npm run build
```

Output lands in `release/`. On Windows you get an NSIS installer; on macOS a signed DMG; on Linux AppImage + deb.

## Tests

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint
```

## Known limits (v1)

- **Sub-agent visualization**: when the main `claude` spawns sub-agents via the `Agent`/`Task` tool, they live inside the same process — ClaudeDesk does not currently render them as separate panels or let you address them individually. Deferred to v2 pending stable hooks into the Claude Code runtime.
- **Telegram plugin UI**: launch custom agents with the telegram plugin flags manually for now; no first-class UI.

## License

MIT, inherited from parallel-code.
