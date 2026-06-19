/**
 * rename-key.ts
 *
 * IME-safe key decisions for inline rename inputs (session rows, folder
 * rows, chat tiles).
 *
 * The crash (reported 2026-06-15): the user dictated/typed a Russian
 * session name and pressed Enter — the app died. Cause: pressing Enter
 * while an IME / dictation composition is still ACTIVE. The rename
 * handlers committed immediately, which tears the <input> out of the DOM
 * mid-composition; Chromium's input-method engine crashes the renderer
 * when its composition target vanishes underneath it. Russian (and any
 * non-Latin / voice) input goes through composition; plain Latin typing
 * usually doesn't — which is why it looked "Russian-specific".
 *
 * The fix: while composing, Enter belongs to the IME (it commits the
 * candidate text), NOT to our rename. We must ignore it until
 * composition finishes. `KeyboardEvent.isComposing` is the modern signal;
 * `keyCode === 229` is the legacy one some engines still emit. We accept
 * a minimal shape so this is trivially unit-testable.
 */

export interface Keyish {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
}

/** True while an IME / dictation composition is in progress. Enter/Escape
 *  during this window must be left to the input method, not acted on. */
export function isComposing(e: Keyish): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

/** Commit the rename? Only on a real Enter that is NOT part of an active
 *  composition. */
export function isCommitKey(e: Keyish): boolean {
  if (isComposing(e)) return false;
  return e.key === 'Enter';
}

/** Cancel the rename? Only on a real Escape outside composition. */
export function isCancelKey(e: Keyish): boolean {
  if (isComposing(e)) return false;
  return e.key === 'Escape';
}
