/**
 * selection-mirror.ts
 *
 * Distinguishes xterm's right-click "copy-mirror" from a genuine external
 * text injection (Wispr Flow dictation, SendInput, paste-into-textarea).
 *
 * The bug (reported 2026-06-15): the user selects text in the terminal,
 * right-clicks, and the selected text immediately gets typed back into
 * the PTY. Root cause — xterm's rightClickHandler mirrors the active
 * selection into its hidden helper-textarea so a native context-menu
 * "Copy" works. Its exact code is:
 *
 *     moveTextAreaUnderMouseCursor(...);
 *     textarea.value = selectionService.selectionText;
 *     textarea.select();                 // <-- selects the ENTIRE value
 *
 * Our 200ms Wispr-Flow poll in TerminalView reads that textarea value and
 * used to forward it to the PTY as if it were dictation.
 *
 * The robust signature of the mirror is that `textarea.select()` leaves
 * the ENTIRE textarea content selected (selectionStart 0 … selectionEnd
 * value.length). Dictation tools and programmatic paste set `value` but
 * leave the caret COLLAPSED at the end (selectionStart === selectionEnd),
 * because they simulate typing/insertion rather than calling select().
 *
 * This is timing-independent and does not depend on string-matching the
 * live buffer selection (which shifts as a running TUI repaints) — it
 * keys off the one thing only the copy-mirror does: fully selecting the
 * helper-textarea.
 */

export interface TextareaSelectionState {
  /** The helper-textarea's current value. */
  value: string;
  /** textarea.selectionStart (may be null in some engines). */
  selectionStart: number | null;
  /** textarea.selectionEnd (may be null in some engines). */
  selectionEnd: number | null;
}

/**
 * True when the helper-textarea state looks like xterm's right-click
 * copy-mirror (non-empty value that is fully selected). Such text must
 * NOT be forwarded to the PTY — it is the user's own selection echoed in
 * so the OS "Copy" works, not something they want typed.
 */
export function isSelectionMirror(state: TextareaSelectionState): boolean {
  const { value, selectionStart, selectionEnd } = state;
  if (!value) return false;
  return selectionStart === 0 && selectionEnd === value.length;
}
