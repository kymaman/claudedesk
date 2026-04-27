/**
 * register-helpers.ts
 *
 * Tiny in-house schema helpers for IPC handler registration. Wraps the
 * existing `assertString` / `validatePath` / etc. style in a per-channel
 * descriptor so handler bodies stop with the assert-soup at the top.
 *
 * The shape:
 *
 *   const handler: HandlerDescriptor<{ id: string; name: string }> = {
 *     channel: IPC.RenameProject,
 *     schema: { id: 'string', name: 'string' },
 *     handler: ({ id, name }) => renameProjectWs({ id, name }),
 *   };
 *   registerHandler(handler);
 *
 * The schema entries are tiny string discriminants (no zod, no class
 * gymnastics) — they map to the existing assert helpers in validate.ts.
 *
 * No new validation behaviour: every error message stays identical to
 * what the inline assertions used to throw, so any downstream code that
 * matched on those messages keeps working.
 */

import { ipcMain } from 'electron';
import path from 'path';
import {
  assertString,
  assertInt,
  assertBoolean,
  assertStringArray,
  assertOptionalString,
  assertOptionalBoolean,
} from './validate.js';

/** A single field's expected shape. The string token picks an asserter. */
export type FieldKind =
  | 'string'
  | 'int'
  | 'boolean'
  | 'string[]'
  | 'optionalString'
  | 'optionalBoolean'
  /** Absolute filesystem path (no traversal). */
  | 'path';

/** Rejects non-absolute paths and any "..\" / "../" component. */
export function validatePath(p: unknown, label: string): void {
  if (typeof p !== 'string') throw new Error(`${label} must be a string`);
  if (!path.isAbsolute(p)) throw new Error(`${label} must be absolute`);
  if (p.includes('..')) throw new Error(`${label} must not contain ".."`);
}

/**
 * Validate `args` against `schema` and return a typed copy. Throws the same
 * `${label} must be …` errors as the per-line asserts so callers (and any
 * tests that match on error text) keep working.
 *
 * `schema` is a record of `{ argName: FieldKind }` — the value is a tiny
 * discriminant string, which keeps the call sites declarative without
 * requiring full zod / runtypes.
 */
export function validateArgs<T extends Record<string, unknown>>(
  args: unknown,
  schema: Record<string, FieldKind>,
): T {
  // We use a fresh object to satisfy the caller's `T` type without mutating
  // the renderer-supplied input.
  const out: Record<string, unknown> = {};
  // `args` is always an object in @electron/ipc (wrapped at the renderer side).
  // Treat null/undefined as "{}", so handlers with all-optional fields work.
  const src = (args ?? {}) as Record<string, unknown>;
  for (const [key, kind] of Object.entries(schema)) {
    const v = src[key];
    switch (kind) {
      case 'string':
        assertString(v, key);
        out[key] = v;
        break;
      case 'int':
        assertInt(v, key);
        out[key] = v;
        break;
      case 'boolean':
        assertBoolean(v, key);
        out[key] = v;
        break;
      case 'string[]':
        assertStringArray(v, key);
        out[key] = v;
        break;
      case 'optionalString':
        assertOptionalString(v, key);
        out[key] = v;
        break;
      case 'optionalBoolean':
        assertOptionalBoolean(v, key);
        out[key] = v;
        break;
      case 'path':
        validatePath(v, key);
        out[key] = v;
        break;
      default: {
        // Compile-time exhaustiveness guard.
        const _exhaustive: never = kind;
        throw new Error(`unknown FieldKind: ${String(_exhaustive)}`);
      }
    }
  }
  return out as T;
}

export interface HandlerDescriptor<Args extends Record<string, unknown>, Result = unknown> {
  channel: string;
  schema: Record<string, FieldKind>;
  handler: (args: Args) => Result | Promise<Result>;
}

/**
 * Register an IPC handler whose args are validated by a co-located schema.
 * Equivalent to `ipcMain.handle(channel, (_e, args) => { …asserts…; return handler(typed); })`.
 */
export function registerHandler<Args extends Record<string, unknown>, Result = unknown>(
  desc: HandlerDescriptor<Args, Result>,
): void {
  ipcMain.handle(desc.channel, (_e, args) => {
    const typed = validateArgs<Args>(args, desc.schema);
    return desc.handler(typed);
  });
}
