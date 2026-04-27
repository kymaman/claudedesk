/**
 * Tests for drag-mime helpers — the DnD MIME registry and the tiny
 * preventDefault/dataTransfer wrappers. All five places that handle drag
 * in the app share these — a regression here breaks drag everywhere.
 */

import { describe, expect, it, vi } from 'vitest';
import { DragMime, acceptDrag, dragHasMime, handleDrop, setDragPayload } from './drag-mime';

function fakeEvent(types: string[], data: Record<string, string> = {}): DragEvent {
  // Minimal DragEvent stub — we only need dataTransfer surface area.
  const dt: Partial<DataTransfer> = {
    types: Object.freeze([...types]),
    getData: vi.fn((m: string) => data[m] ?? ''),
    setData: vi.fn((m: string, v: string) => {
      data[m] = v;
    }),
    effectAllowed: 'all',
    dropEffect: 'none',
  };
  const ev = {
    dataTransfer: dt as DataTransfer,
    preventDefault: vi.fn(),
  } as unknown as DragEvent;
  return ev;
}

describe('DragMime registry', () => {
  it('exposes both known MIME types under stable keys', () => {
    expect(DragMime.SessionId).toBe('application/x-claudedesk-session-id');
    expect(DragMime.ChatId).toBe('application/x-claudedesk-chat-id');
  });
});

describe('setDragPayload', () => {
  it('writes the payload under the given MIME and sets effectAllowed=move', () => {
    const data: Record<string, string> = {};
    const e = fakeEvent([], data);
    setDragPayload(e, DragMime.ChatId, 'chat-123');
    expect(data[DragMime.ChatId]).toBe('chat-123');
    expect(e.dataTransfer?.effectAllowed).toBe('move');
  });

  it('is a no-op when dataTransfer is missing', () => {
    const e = { dataTransfer: null, preventDefault: vi.fn() } as unknown as DragEvent;
    expect(() => setDragPayload(e, DragMime.ChatId, 'x')).not.toThrow();
  });
});

describe('dragHasMime', () => {
  it('returns true only when the MIME is present in dataTransfer.types', () => {
    expect(dragHasMime(fakeEvent([DragMime.SessionId]), DragMime.SessionId)).toBe(true);
    expect(dragHasMime(fakeEvent([DragMime.ChatId]), DragMime.SessionId)).toBe(false);
    expect(dragHasMime(fakeEvent([]), DragMime.ChatId)).toBe(false);
  });
});

describe('acceptDrag', () => {
  it('preventDefaults and sets dropEffect when MIME matches', () => {
    const onOver = acceptDrag(DragMime.SessionId, 'move');
    const e = fakeEvent([DragMime.SessionId]);
    onOver(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.dataTransfer?.dropEffect).toBe('move');
  });

  it('does nothing when the drag carries a different MIME — drop will be rejected', () => {
    const onOver = acceptDrag(DragMime.SessionId);
    const e = fakeEvent([DragMime.ChatId]);
    onOver(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('honours the dropEffect option (copy)', () => {
    const onOver = acceptDrag(DragMime.SessionId, 'copy');
    const e = fakeEvent([DragMime.SessionId]);
    onOver(e);
    expect(e.dataTransfer?.dropEffect).toBe('copy');
  });
});

describe('handleDrop', () => {
  it('extracts the payload and forwards it to the callback', () => {
    const cb = vi.fn();
    const onDrop = handleDrop(DragMime.ChatId, cb);
    const e = fakeEvent([DragMime.ChatId], { [DragMime.ChatId]: 'chat-abc' });
    onDrop(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith('chat-abc', e);
  });

  it('skips when MIME is not present (e.g. external file drop)', () => {
    const cb = vi.fn();
    const onDrop = handleDrop(DragMime.ChatId, cb);
    const e = fakeEvent(['Files']);
    onDrop(e);
    expect(cb).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('skips when payload is empty (browsers sometimes deliver an empty type)', () => {
    const cb = vi.fn();
    const onDrop = handleDrop(DragMime.SessionId, cb);
    const e = fakeEvent([DragMime.SessionId], { [DragMime.SessionId]: '' });
    onDrop(e);
    expect(cb).not.toHaveBeenCalled();
  });
});
