/**
 * strip-alt-screen.ts
 *
 * The PTY upstream (claude --resume) emits DECSET ?1049h to switch
 * xterm into the alternate buffer for its TUI. In xterm.js v5 the alt
 * buffer has no scrollback AND no fallthrough to the normal buffer's
 * scrollback, so the user cannot scroll up to see the conversation
 * that already printed to the terminal.
 *
 * Filter the byte stream before it hits xterm: strip the alt-screen
 * enter/exit toggles so claude's UI redraws happen in the normal
 * buffer. Each redraw still works (claude uses cursor-home + erase),
 * but rows that scroll off the top now land in scrollback — which is
 * exactly what the user expects.
 *
 * The function is stateful because an ESC sequence may be split across
 * two PTY chunks. We keep up to N trailing bytes (the maximum needed
 * to disambiguate any partial sequence prefix) and re-prepend them to
 * the next chunk.
 *
 * Stripped sequences (all forms of "enter / leave alt buffer"):
 *   - ESC [ ? 47 h / l        DEC private mode 47   (legacy alt screen)
 *   - ESC [ ? 1047 h / l      DEC private mode 1047 (alt without cursor save)
 *   - ESC [ ? 1049 h / l      DEC private mode 1049 (alt + cursor save)
 *
 * Sequence 1048 (cursor save/restore alone) is intentionally KEPT —
 * claude uses it for legitimate cursor bookkeeping inside its TUI and
 * stripping it would break UI redraws.
 */

// Maximum prefix length we need to hold back when a chunk ends mid-
// sequence. The longest target is "\x1b[?1049h" — 8 bytes — so any
// chunk that ends in fewer than 8 bytes of a potential ESC prefix
// could be the start of a strip target.
const MAX_PARTIAL = 8;

// Single regex covers all strip targets in one pass. Working in a
// latin-1 decoded string is safe because every byte of an ANSI/VT100
// escape sequence is < 0x80 and decodes 1:1.
// eslint-disable-next-line no-control-regex -- ESC is intentional, it's the lead byte of the sequences we strip
const STRIP_RE = /\x1b\[\?(?:47|1047|1049)[hl]/g;

export class AltScreenStripper {
  private carry: string = '';
  private static readonly decoder = new TextDecoder('latin1', { fatal: false });

  /**
   * Feed a chunk; receive the filtered chunk. Trailing bytes that
   * could be the start of a strip target are buffered internally and
   * surfaced on the next call (or via flush()).
   */
  push(chunk: Uint8Array): Uint8Array {
    // Latin-1 round-trip: decode the bytes 1:1 into a string, run the
    // strip on the string, re-encode. We can't use utf-8 here because
    // a malformed multibyte char at the chunk boundary would be replaced
    // with U+FFFD which corrupts what xterm sees.
    const incoming = AltScreenStripper.decoder.decode(chunk);
    const buf = this.carry + incoming;

    // Hold back up to MAX_PARTIAL trailing bytes IF they could be a
    // partial ESC sequence prefix. Cheap heuristic: search for the last
    // ESC byte; if it's within MAX_PARTIAL of the end, hold from there.
    let cutoff = buf.length;
    const lastEsc = buf.lastIndexOf('\x1b');
    if (lastEsc >= 0 && buf.length - lastEsc < MAX_PARTIAL) {
      cutoff = lastEsc;
    }
    const head = buf.slice(0, cutoff);
    this.carry = buf.slice(cutoff);

    const stripped = head.replace(STRIP_RE, '');
    if (stripped.length === 0) return new Uint8Array(0);
    // Encode via latin1 mapping (1:1) so we don't accidentally rewrite
    // bytes >= 0x80 into multi-byte UTF-8.
    return latin1Encode(stripped);
  }

  /** Flush any held-back bytes — call once when the stream ends. */
  flush(): Uint8Array {
    if (!this.carry) return new Uint8Array(0);
    const tail = this.carry.replace(STRIP_RE, '');
    this.carry = '';
    return latin1Encode(tail);
  }
}

function latin1Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
