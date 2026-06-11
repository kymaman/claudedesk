// electron/remote/server.test.ts
// Unit tests for the isOriginAllowed helper (origin policy for CSWSH protection).

import { describe, expect, it } from 'vitest';
import { isOriginAllowed } from './origin.js';

describe('isOriginAllowed', () => {
  it('allows when origin host:port matches request host', () => {
    expect(isOriginAllowed('http://192.168.1.10:3030', '192.168.1.10:3030')).toBe(true);
  });

  it('rejects when origin host differs', () => {
    expect(isOriginAllowed('http://evil.example.com', '192.168.1.10:3030')).toBe(false);
  });

  it('rejects when port differs', () => {
    expect(isOriginAllowed('http://192.168.1.10:9999', '192.168.1.10:3030')).toBe(false);
  });

  it('allows when origin is absent (non-browser client)', () => {
    expect(isOriginAllowed(undefined, '192.168.1.10:3030')).toBe(true);
  });

  it('rejects when origin is malformed', () => {
    expect(isOriginAllowed('not-a-url', '192.168.1.10:3030')).toBe(false);
  });

  it('rejects when reqHost is absent but origin is present', () => {
    expect(isOriginAllowed('http://192.168.1.10:3030', undefined)).toBe(false);
  });
});
