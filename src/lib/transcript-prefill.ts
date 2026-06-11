/**
 * transcript-prefill.ts — the decision a resumed tile makes when its
 * session transcript finishes loading.
 *
 * REGRESSION GUARD (2026-06-11, «не могу прокрутить вверх» — again):
 * resumed tiles prefill their xterm scrollback with the session
 * transcript before claude's banner. A 3-second safety gate releases
 * buffered PTY output if the transcript IPC stalls (huge JSONL, or the
 * main process busy with the lineage scan). The OLD code only wrote the
 * transcript when the gate had NOT yet opened (`!gateOpen`), so a slow
 * IPC meant the transcript was silently DROPPED → empty scrollback.
 *
 * The fix: write the transcript whenever it loaded and the terminal is
 * still alive — the gate state is irrelevant to *whether* we write (it
 * only affects ordering, and a late transcript below the banner is far
 * better than no transcript at all). This function encodes exactly that,
 * free of DOM/xterm so it unit-tests cleanly.
 */

export interface PrefillInput {
  /** The rendered transcript text, or null/empty if none/unreadable. */
  transcript: string | null | undefined;
  /** Whether the xterm instance is still mounted (not disposed). */
  termAlive: boolean;
}

/** Should the loaded transcript be written into xterm scrollback? */
export function shouldWriteTranscript(input: PrefillInput): boolean {
  return input.termAlive && typeof input.transcript === 'string' && input.transcript.length > 0;
}
