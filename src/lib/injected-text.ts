/**
 * injected-text.ts
 *
 * Decides how text that appeared in xterm's hidden helper-textarea
 * (caught by the 200ms Wispr-Flow poll in TerminalView) should be
 * delivered to the PTY.
 *
 * Why this matters — the "paste erases previous text" bug:
 *   When a paste lands in the textarea via a path that bypasses our
 *   Ctrl+V handler (Wispr Flow's simulated paste, some IMEs, certain
 *   SendInput tools), the poll used to forward it with a RAW
 *   enqueueInput(text). For a MULTI-LINE payload that means every
 *   embedded newline reaches claude as a literal Enter — claude
 *   submits the first line immediately and the remaining lines either
 *   replace the input or get submitted as separate prompts. The user
 *   sees their previous pasted block "disappear".
 *
 *   The fix: multi-line injected text must be delivered as a
 *   BRACKETED PASTE (term.paste), exactly like the Ctrl+V path, so
 *   claude treats it as one atomic block with no premature submit.
 *   Single-line text (real dictation) is delivered raw — that's what
 *   dictation is supposed to do.
 */

export type InjectedDelivery = 'ignore' | 'type' | 'paste';

/**
 * Classify polled textarea text.
 *   - 'ignore' : length ≤ 1 — stray single-char residue xterm leaves
 *                in the helper textarea; forwarding it double-types.
 *   - 'paste'  : contains a newline (CR or LF) — treat as a pasted
 *                block, deliver via bracketed paste to avoid premature
 *                submit (the erase bug).
 *   - 'type'   : single-line phrase — real dictation, deliver raw.
 *
 * NOTE: this function only decides HOW to deliver text that has already
 * been judged to be a genuine injection. Whether the textarea write is a
 * genuine injection vs. xterm's right-click copy-mirror is a separate
 * decision — see isSelectionMirror() in selection-mirror.ts.
 */
export function classifyInjectedText(text: string): InjectedDelivery {
  if (text.length <= 1) return 'ignore';
  if (/[\r\n]/.test(text)) return 'paste';
  return 'type';
}
