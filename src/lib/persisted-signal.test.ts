/**
 * Tests for createPersistedSignal — the helper consolidating the
 * "signal + localStorage" pattern that lived in 6 store modules.
 * If any of these fail, the migrated stores will silently lose data.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPersistedSignal } from './persisted-signal';

// In-memory localStorage polyfill — vitest runs under Node.
{
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => void map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    },
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('createPersistedSignal — basic round-trip', () => {
  it('returns the initial value when nothing is stored', () => {
    const [get] = createPersistedSignal('a', 'default');
    expect(get()).toBe('default');
  });

  it('persists the value through set and is readable on the next load', () => {
    const [, set] = createPersistedSignal('b', 0);
    set(42);
    expect(JSON.parse(localStorage.getItem('b') as string)).toBe(42);

    const [get2] = createPersistedSignal('b', 0);
    expect(get2()).toBe(42);
  });

  it('handles object values', () => {
    const [, set] = createPersistedSignal<{ on: boolean }>('c', { on: false });
    set({ on: true });
    const [get2] = createPersistedSignal('c', { on: false });
    expect(get2()).toEqual({ on: true });
  });
});

describe('createPersistedSignal — error tolerance', () => {
  it('falls back to initial when stored JSON is corrupt', () => {
    localStorage.setItem('d', '{broken json');
    const [get] = createPersistedSignal('d', 'fallback');
    expect(get()).toBe('fallback');
  });

  it('falls back to initial when validate returns null', () => {
    localStorage.setItem('e', JSON.stringify({ unexpected: 'shape' }));
    const [get] = createPersistedSignal<{ ok: boolean }>(
      'e',
      { ok: false },
      {
        validate: (raw) =>
          raw && typeof raw === 'object' && 'ok' in (raw as Record<string, unknown>)
            ? (raw as { ok: boolean })
            : null,
      },
    );
    expect(get()).toEqual({ ok: false });
  });

  it('passes valid values through validate untouched', () => {
    localStorage.setItem('f', JSON.stringify({ ok: true }));
    const [get] = createPersistedSignal<{ ok: boolean }>(
      'f',
      { ok: false },
      {
        validate: (raw) =>
          raw && typeof raw === 'object' && (raw as { ok?: unknown }).ok === true
            ? { ok: true }
            : null,
      },
    );
    expect(get()).toEqual({ ok: true });
  });
});

describe('createPersistedSignal — Set/Map serialization', () => {
  it('round-trips a Set<string> via serialize/deserialize hooks', () => {
    const [, set] = createPersistedSignal<Set<string>>('g', new Set(), {
      serialize: (s) => [...s],
      deserialize: (raw) =>
        Array.isArray(raw) ? new Set(raw.filter((x): x is string => typeof x === 'string')) : null,
    });
    set(new Set(['a', 'b', 'c']));
    expect(JSON.parse(localStorage.getItem('g') as string)).toEqual(['a', 'b', 'c']);

    const [get2] = createPersistedSignal<Set<string>>('g', new Set(), {
      serialize: (s) => [...s],
      deserialize: (raw) =>
        Array.isArray(raw) ? new Set(raw.filter((x): x is string => typeof x === 'string')) : null,
    });
    const value = get2();
    expect(value instanceof Set).toBe(true);
    expect([...value].sort()).toEqual(['a', 'b', 'c']);
  });

  it('falls back when deserialize returns null', () => {
    localStorage.setItem('h', JSON.stringify({ not: 'an array' }));
    const [get] = createPersistedSignal<Set<string>>('h', new Set(['fallback']), {
      serialize: (s) => [...s],
      deserialize: (raw) => (Array.isArray(raw) ? new Set<string>(raw as string[]) : null),
    });
    expect([...get()]).toEqual(['fallback']);
  });
});

describe('createPersistedSignal — set is reactive', () => {
  it('every setter call writes a fresh JSON to localStorage', () => {
    const [, set] = createPersistedSignal<number>('i', 0);
    set(1);
    expect(JSON.parse(localStorage.getItem('i') as string)).toBe(1);
    set(2);
    expect(JSON.parse(localStorage.getItem('i') as string)).toBe(2);
  });
});
