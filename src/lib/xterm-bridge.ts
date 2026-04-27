/**
 * xterm-bridge.ts
 * The right-click context menu lives outside the SolidJS tree, so it can't
 * call methods on a Terminal instance directly. Instead it dispatches custom
 * DOM events on the .xterm container and TerminalView's onMount registers
 * matching listeners that delegate to term.paste() / term.getSelection().
 *
 * Both halves used to use bare strings ('claudedesk-paste', 'claudedesk-copy')
 * — a typo silently breaks paste. Centralised here as typed constants and
 * tiny dispatch/listen helpers, so a rename is a single-file change.
 */

export const XtermBridgeEvent = {
  Paste: 'claudedesk-paste',
  Copy: 'claudedesk-copy',
} as const;

export interface XtermPasteDetail {
  text: string;
}

export interface XtermCopyDetail {
  /** Mutated by the listener — TerminalView writes term.getSelection() here. */
  result: { text: string };
}

/**
 * Dispatch a paste request at the given xterm container. The bubbles flag
 * lets a listener attached on a parent (e.g. TerminalView's containerRef)
 * still see events fired on the inner `.xterm` div.
 */
export function dispatchXtermPaste(target: EventTarget, text: string): void {
  target.dispatchEvent(
    new CustomEvent<XtermPasteDetail>(XtermBridgeEvent.Paste, {
      detail: { text },
      bubbles: true,
    }),
  );
}

/**
 * Ask the xterm container for its current selection text. Synchronous —
 * the listener writes back into `detail.result.text` before dispatchEvent
 * returns. Empty string means "nothing selected".
 */
export function readXtermSelection(target: EventTarget): string {
  const detail: XtermCopyDetail = { result: { text: '' } };
  target.dispatchEvent(
    new CustomEvent<XtermCopyDetail>(XtermBridgeEvent.Copy, { detail, bubbles: true }),
  );
  return detail.result.text;
}

/**
 * Subscribe the given target to bridge events. Returns a single unsubscribe
 * function that removes both listeners.
 */
export function listenXtermBridge(
  target: EventTarget,
  handlers: {
    onPaste: (detail: XtermPasteDetail) => void;
    onCopy: (detail: XtermCopyDetail) => void;
  },
): () => void {
  const onPaste = (e: Event) => {
    const detail = (e as CustomEvent<XtermPasteDetail>).detail;
    if (detail && typeof detail.text === 'string') handlers.onPaste(detail);
  };
  const onCopy = (e: Event) => {
    const detail = (e as CustomEvent<XtermCopyDetail>).detail;
    if (detail && detail.result) handlers.onCopy(detail);
  };
  target.addEventListener(XtermBridgeEvent.Paste, onPaste);
  target.addEventListener(XtermBridgeEvent.Copy, onCopy);
  return () => {
    target.removeEventListener(XtermBridgeEvent.Paste, onPaste);
    target.removeEventListener(XtermBridgeEvent.Copy, onCopy);
  };
}
