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
  it('is at least 10_000 — claude --resume prints the whole conversation into the buffer', () => {
    // Lowering this below ~10_000 truncated long resumed sessions:
    // users could not scroll up to see earlier turns. Don't lower without
    // first deciding how to preserve the resume output (e.g., dedicated
    // history viewer, file-backed scrollback).
    expect(TERMINAL_SCROLLBACK_LINES).toBeGreaterThanOrEqual(10_000);
  });

  it('stays in a safe range — too high wastes RAM with many tiles', () => {
    expect(TERMINAL_SCROLLBACK_LINES).toBeLessThanOrEqual(20_000);
  });
});
