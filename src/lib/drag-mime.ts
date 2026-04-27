/**
 * drag-mime.ts
 * Centralised registry of custom HTML5 drag-and-drop MIME types used inside
 * ClaudeDesk, plus tiny typed helpers for `draggable`/`onDrop` boilerplate.
 *
 * Why this exists: until this commit, MIME literals like
 *   'application/x-claudedesk-session-id'
 *   'application/x-claudedesk-chat-id'
 * were repeated as raw strings across 5 files. A typo in any one of them
 * silently breaks drag — the DOM reports no error, the drop just never
 * fires. The enum gives the compiler something to enforce.
 */

export const DragMime = {
  /** A History session being dropped onto a folder or "All sessions". */
  SessionId: 'application/x-claudedesk-session-id',
  /** An open chat tile/chip being reordered. */
  ChatId: 'application/x-claudedesk-chat-id',
} as const satisfies Record<string, string>;

export type DragMimeType = (typeof DragMime)[keyof typeof DragMime];

/**
 * Mark the current drag as carrying `payload` of `mime` type.
 * Equivalent to `e.dataTransfer.setData(mime, payload); e.dataTransfer.effectAllowed = 'move'`,
 * with a no-op when `dataTransfer` is missing (some synthetic events).
 */
export function setDragPayload(e: DragEvent, mime: DragMimeType, payload: string): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(mime, payload);
  e.dataTransfer.effectAllowed = 'move';
}

/** True when the drag-in-progress is carrying our `mime` payload. */
export function dragHasMime(e: DragEvent, mime: DragMimeType): boolean {
  return e.dataTransfer?.types.includes(mime) ?? false;
}

/**
 * Standard `onDragOver` handler that accepts a drag if it carries `mime`,
 * preventing default (which is required to enable drop) and setting a
 * "move" cursor.
 */
export function acceptDrag(mime: DragMimeType, dropEffect: 'move' | 'copy' = 'move') {
  return (e: DragEvent): void => {
    if (!dragHasMime(e, mime)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = dropEffect;
  };
}

/**
 * Standard `onDrop` handler. Pulls the payload string and hands it to
 * `onDrop` only when the right MIME is present. Calls `preventDefault`
 * to stop browsers from navigating to dropped URLs.
 */
export function handleDrop(mime: DragMimeType, onDrop: (payload: string, e: DragEvent) => void) {
  return (e: DragEvent): void => {
    if (!dragHasMime(e, mime)) return;
    e.preventDefault();
    const payload = e.dataTransfer?.getData(mime) ?? '';
    if (payload) onDrop(payload, e);
  };
}
