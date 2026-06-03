/**
 * Unit: AltScreenStripper byte-level filter for DECSET 1049/1047/47.
 */

import { describe, expect, it } from 'vitest';
import { AltScreenStripper } from './strip-alt-screen';

const dec = new TextDecoder('latin1');

function strip(chunks: string[]): string {
  const s = new AltScreenStripper();
  const out: number[] = [];
  for (const c of chunks) {
    const filtered = s.push(latin1Bytes(c));
    out.push(...filtered);
  }
  const tail = s.flush();
  out.push(...tail);
  return dec.decode(new Uint8Array(out));
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

describe('AltScreenStripper', () => {
  it('strips the 1049 enter sequence', () => {
    expect(strip(['hello\x1b[?1049hworld'])).toBe('helloworld');
  });

  it('strips the 1049 exit sequence', () => {
    expect(strip(['goodbye\x1b[?1049l!'])).toBe('goodbye!');
  });

  it('strips legacy 47 and 1047 variants', () => {
    expect(strip(['a\x1b[?47hb\x1b[?47lc\x1b[?1047hd\x1b[?1047le'])).toBe('abcde');
  });

  it('keeps 1048 (cursor save/restore) untouched — claude uses it', () => {
    expect(strip(['save\x1b[?1048hrestore\x1b[?1048l'])).toBe('save\x1b[?1048hrestore\x1b[?1048l');
  });

  it('passes through unrelated ESC sequences (cursor move, color, clear)', () => {
    const sample = '\x1b[H\x1b[2J\x1b[1;31mred\x1b[0m';
    expect(strip([sample])).toBe(sample);
  });

  it('handles a sequence split across two chunks', () => {
    // \x1b[?1049h — split between byte 4 and 5
    expect(strip(['before\x1b[?10', '49hafter'])).toBe('beforeafter');
  });

  it('handles a sequence split right after ESC', () => {
    expect(strip(['x\x1b', '[?1049hy'])).toBe('xy');
  });

  it('does not hold back unrelated trailing ESC if no partial match', () => {
    // ESC then a complete CSI — should NOT be held back forever.
    // The stripper holds the latest ESC up to MAX_PARTIAL bytes from
    // end. As long as flush() is called the held bytes come out.
    const s = new AltScreenStripper();
    const a = s.push(latin1Bytes('aaa\x1b[H'));
    const b = s.flush();
    const result = dec.decode(new Uint8Array([...a, ...b]));
    expect(result).toBe('aaa\x1b[H');
  });

  it('passes through plain ASCII unchanged byte-for-byte', () => {
    const text =
      'lorem ipsum dolor sit amet 1234567890 !@#$%^&*() ' +
      'and a newline\nplus carriage return\r\nthe end.';
    expect(strip([text])).toBe(text);
  });

  it('high bytes (>=0x80) round-trip correctly (no UTF-8 mojibake)', () => {
    // Simulate a non-ASCII byte stream — could be UTF-8 inside but we
    // don't interpret; just need byte-exact passthrough.
    const bytes = new Uint8Array([0xc3, 0xa9, 0xd0, 0x9f, 0xe2, 0x80, 0x94]); // é, П, —
    const s = new AltScreenStripper();
    const out = s.push(bytes);
    const tail = s.flush();
    expect([...out, ...tail]).toEqual([0xc3, 0xa9, 0xd0, 0x9f, 0xe2, 0x80, 0x94]);
  });

  it('strip works even when ESC starts at the very end of a chunk', () => {
    // ESC alone at end → buffered; next chunk completes the sequence.
    expect(strip(['plain text\x1b', '[?1049hmore'])).toBe('plain textmore');
  });
});
