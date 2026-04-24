import { describe, expect, it } from 'vitest';
import { extractChatIds } from './chat-markers';

describe('extractChatIds', () => {
  it('pulls [[open:UUID]] markers out of text', () => {
    expect(
      extractChatIds('Here is a match: [[open:11111111-2222-3333-4444-555555555555]] try it'),
    ).toEqual(['11111111-2222-3333-4444-555555555555']);
  });

  it('pulls [[chat:UUID]] markers too', () => {
    expect(extractChatIds('see [[chat:AAAABBBB-0000-0000-0000-cccccccccccc]] end')).toEqual([
      'aaaabbbb-0000-0000-0000-cccccccccccc',
    ]);
  });

  it('tolerates whitespace inside markers', () => {
    expect(extractChatIds('[[open:  11111111-2222-3333-4444-555555555555  ]]')).toEqual([
      '11111111-2222-3333-4444-555555555555',
    ]);
  });

  it('de-duplicates repeated markers and preserves first-seen order', () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    expect(extractChatIds(`[[open:${a}]] then ${a} and ${b} and [[chat:${b}]]`)).toEqual([a, b]);
  });

  it('falls back to bare UUIDs when no marker is used', () => {
    expect(extractChatIds('session abc-0: 11111111-2222-3333-4444-555555555555')).toEqual([
      '11111111-2222-3333-4444-555555555555',
    ]);
  });

  it('strips ANSI escape sequences before extracting — xterm buffers are colored', () => {
    // The UUID has a colour-reset escape in the middle of it as it would come
    // through the WS stream from node-pty. Without ANSI stripping the matcher
    // sees "11111111-\x1b[0m2222-..." and bails.
    const coloured = '\x1b[31m11111111-\x1b[0m2222-3333-4444-555555555555\x1b[0m';
    expect(extractChatIds(coloured)).toEqual(['11111111-2222-3333-4444-555555555555']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(extractChatIds('no ids here')).toEqual([]);
    expect(extractChatIds('')).toEqual([]);
  });
});
