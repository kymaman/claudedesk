/**
 * Pin the scrollback constant. Two reasons:
 *   1. It's a memory knob — silent bumps can cost ~10MB+ per chat.
 *   2. Some flows export from the xterm buffer; lowering it below a
 *      reasonable floor could lose data.
 * Future intentional changes must update this test alongside.
 */
import { describe, expect, it } from 'vitest';
import { TERMINAL_SCROLLBACK_LINES } from './terminalConstants';

describe('TERMINAL_SCROLLBACK_LINES', () => {
  it('is a sensible value (not accidentally bumped back to 10k)', () => {
    expect(TERMINAL_SCROLLBACK_LINES).toBe(3_000);
  });

  it('stays in a safe range — too low loses context, too high wastes RAM', () => {
    expect(TERMINAL_SCROLLBACK_LINES).toBeGreaterThanOrEqual(1_000);
    expect(TERMINAL_SCROLLBACK_LINES).toBeLessThanOrEqual(5_000);
  });
});
