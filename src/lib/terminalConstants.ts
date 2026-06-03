// xterm scrollback budget per chat. Set to 10_000 after a user report
// that they "can't see history above" — claude's `--resume <sid>` prints
// the full prior conversation into the PTY on startup, and long sessions
// blew right past 3_000 (the previous, memory-optimised value). 10_000
// matches xterm's original default and covers the great majority of
// resume scenarios; the memory hit is acceptable (~10MB per heavy chat).
//
// If a future feature needs more (e.g. session export from xterm buffer
// alone), bump this deliberately AND update the unit test.
export const TERMINAL_SCROLLBACK_LINES = 10_000;
