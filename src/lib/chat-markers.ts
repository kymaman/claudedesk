/**
 * chat-markers.ts
 * Pure helpers for the Assistant sidebar. The assistant is a regular Claude
 * CLI that we teach (via a CLAUDE.md at its cwd) to emit two marker forms
 * when it finds chat sessions matching a user query:
 *   [[open:<sessionId>]]    — a call-to-action chip the user can click
 *   [[chat:<sessionId>]]    — an inline mention (still becomes a chip)
 * We also catch bare session UUIDs as a fallback, since a helpful model
 * sometimes just writes them plain.
 */

/** Claude session IDs are plain RFC-4122 v4 UUIDs — 8-4-4-4-12 hex. */
export const SESSION_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const MARKER_RE =
  /\[\[(?:open|chat):\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\]\]/gi;

/** ANSI CSI / character-set sequences that make raw UUIDs "split" across the
 *  matcher. Strip them before extracting — otherwise colored UUIDs in the xterm
 *  buffer never match. */
// eslint-disable-next-line no-control-regex
const ANSI_STRIP = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]/g;

/**
 * Extract every session id mentioned in `text`. Explicit markers win — we
 * collect them first, then sweep bare UUIDs so one source (typing out a UUID)
 * can't flood the same chip list multiple times.
 *
 * Returns ids in order of first appearance, de-duplicated.
 */
export function extractChatIds(text: string): string[] {
  const clean = text.replace(ANSI_STRIP, '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of clean.matchAll(MARKER_RE)) {
    const id = m[1].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const m of clean.matchAll(SESSION_UUID_RE)) {
    const id = m[0].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
