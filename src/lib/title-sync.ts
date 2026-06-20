/**
 * title-sync.ts — pick the freshest DISK title for an open chat tile.
 *
 * The tile header and the left History row must show the SAME title (title
 * parity). The History row shows the on-disk `session.title`; the tile shows
 * `titleFor()` = manual override ?? diskTitle ?? stale base `chat.title`. The
 * App effect feeds `diskTitle` from the on-disk sessions list keyed by sessionId.
 *
 * THE GAP this fixes: a tile advances its `sessionId` to a freshly-minted live
 * session (watchLiveSession/adoptLiveSessionId mints a new file on every
 * --resume) BEFORE the disk scan has picked that file up. In that window the
 * lookup by the CURRENT sessionId misses, so the tile snaps back to its stale
 * base title while History already shows the fresh one — the divergence the user
 * sees on open. We bridge it by falling back to the most recent PAST sessionId
 * that IS on disk: same conversation, same title, no flby-the-base-title gap.
 *
 * Pure (no Solid, no DOM) so it unit-tests cleanly.
 */

export interface TitleSyncChat {
  sessionId?: string;
  /** Earlier session ids this tile lived under (oldest..newest). */
  pastSessionIds?: string[];
}

/**
 * Resolve the disk title to apply to a chat, or undefined if none is known yet.
 * Prefers the current sessionId; falls back to the newest past sessionId present
 * in `byId` (the disk-title map: sessionId -> title).
 */
export function pickDiskTitle(
  chat: TitleSyncChat,
  byId: ReadonlyMap<string, string>,
): string | undefined {
  if (!chat.sessionId) return undefined;
  const current = byId.get(chat.sessionId);
  if (current !== undefined) return current;
  const past = chat.pastSessionIds;
  if (past) {
    for (let i = past.length - 1; i >= 0; i--) {
      const t = byId.get(past[i]);
      if (t !== undefined) return t;
    }
  }
  return undefined;
}
