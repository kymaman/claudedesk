// xterm keeps a full off-screen line buffer per chat — with 12 chats open the
// previous 10k value held up to ~120k lines in memory. Empirically 3k covers
// "scroll back through this session's output" without making the app feel
// heavy. If a future feature needs more (e.g. session export from xterm
// buffer alone), bump this deliberately AND update the unit test.
export const TERMINAL_SCROLLBACK_LINES = 3_000;
