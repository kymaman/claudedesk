/* eslint-disable solid/reactivity -- createRoot(() => createSignal(...)) is the deliberate HMR-safe pattern that this whole helper exists to consolidate; the linter can't see through the closure to the destructure on the outer line. */
/**
 * persisted-signal.ts
 * SolidJS-flavoured "signal that round-trips through localStorage". Replaces
 * the 30-line boilerplate every preference module copy-pasted: createRoot
 * for HMR safety, JSON parse with try/catch, custom validator, persist on
 * every set. The only non-obvious bits centralised here:
 *
 *   - createRoot disposal is owned by the helper — module-level signals
 *     don't trigger Solid's "computations created outside createRoot"
 *     warning during HMR.
 *   - On every setter call the new value is JSON-stringified through an
 *     optional `serialize` (e.g. for Sets / Maps) before being persisted,
 *     so callers don't need to remember to call a separate persist().
 *   - Read errors (corrupt JSON, validate rejects) silently fall back to
 *     `initial` — the same forgiving behaviour all six prior copies had.
 */

import { createRoot, createSignal, type Accessor, type Setter } from 'solid-js';

export interface PersistedSignalOptions<T> {
  /**
   * Validate / normalize a parsed value before adopting it. Return the
   * cleaned value, or `null` to fall back to `initial`. If omitted, the
   * raw parsed value is trusted.
   */
  validate?: (raw: unknown) => T | null;
  /**
   * Convert the live value to something `JSON.stringify` understands.
   * Required for `Set`/`Map`. Default is identity.
   */
  serialize?: (value: T) => unknown;
  /**
   * Reverse of `serialize`. Applied to `JSON.parse` output before
   * `validate`. Default is identity.
   */
  deserialize?: (raw: unknown) => unknown;
}

export type PersistedSignalApi<T> = [Accessor<T>, (next: T) => void];

/**
 * Create a SolidJS signal whose value is loaded from localStorage on
 * module init and re-persisted on every set.
 *
 * Returns `[get, set]` — `set` is a plain function (not a Solid Setter
 * with the function-form overload) because that's the only shape the
 * existing pref modules ever use.
 */
export function createPersistedSignal<T>(
  key: string,
  initial: T,
  options: PersistedSignalOptions<T> = {},
): PersistedSignalApi<T> {
  const { validate, serialize, deserialize } = options;

  const loaded = loadFromStorage(key, initial, validate, deserialize);

  const [get, set] = createRoot<[Accessor<T>, Setter<T>]>(() => createSignal<T>(loaded));

  function persist(value: T): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const payload = serialize ? serialize(value) : value;
      localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      /* storage quota / private mode — non-fatal */
    }
  }

  function setAndPersist(next: T): void {
    set(() => next);
    persist(next);
  }

  return [get, setAndPersist];
}

function loadFromStorage<T>(
  key: string,
  initial: T,
  validate: PersistedSignalOptions<T>['validate'],
  deserialize: PersistedSignalOptions<T>['deserialize'],
): T {
  if (typeof localStorage === 'undefined') return initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return initial;
    const parsed: unknown = JSON.parse(raw);
    let after: unknown = parsed;
    if (deserialize) {
      after = deserialize(parsed);
      // null/undefined from deserialize is the "I don't recognize this"
      // signal — fall back to the supplied initial.
      if (after === null || after === undefined) return initial;
    }
    if (validate) {
      const cleaned = validate(after);
      return cleaned ?? initial;
    }
    return after as T;
  } catch {
    return initial;
  }
}
