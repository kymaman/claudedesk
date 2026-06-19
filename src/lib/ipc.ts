// Core IPC — wraps Electron's ipcRenderer for frontend-backend communication.

import { IPC } from '../../electron/ipc/channels';

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
        removeAllListeners: (channel: string) => void;
      };
      setZoomFactor: (factor: number) => void;
    };
  }
}

export class Channel<T> {
  private _id = crypto.randomUUID();
  cleanup: (() => void) | null = null;
  onmessage: ((msg: T) => void) | null = null;

  constructor() {
    this.cleanup = window.electron.ipcRenderer.on(`channel:${this._id}`, (msg: unknown) => {
      this.onmessage?.(msg as T);
    });
  }

  get id() {
    return this._id;
  }

  toJSON() {
    return { __CHANNEL_ID__: this._id };
  }

  dispose(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.onmessage = null;
  }
}

export async function invoke<T>(cmd: IPC, args?: Record<string, unknown>): Promise<T> {
  // Test-only IPC spy. An e2e test sets `window.__ipcSpy = []` before an
  // action, then reads which channels were invoked. We record HERE — on the
  // real call path — because monkeypatching `window.electron.ipcRenderer`
  // does NOT work: Electron's contextBridge deep-freezes exposed objects, so
  // a reassignment of `.invoke` silently no-ops. No-op in production (the
  // flag is never set); negligible cost when it is. See
  // e2e/transcript-native-render.spec.ts (variant-A prefill guard).
  const spy = (window as unknown as { __ipcSpy?: string[] }).__ipcSpy;
  if (spy) spy.push(cmd);
  // JSON round-trip ensures all args are structured-clone-safe.
  // Triggers Channel.toJSON() to replace Channel instances with
  // plain { __CHANNEL_ID__: id } objects.
  const safeArgs = args ? (JSON.parse(JSON.stringify(args)) as Record<string, unknown>) : undefined;
  return window.electron.ipcRenderer.invoke(cmd, safeArgs) as Promise<T>;
}

/**
 * Invoke an IPC command without awaiting the result.
 * Logs errors to console and optionally calls onError for user-visible feedback.
 */
export function fireAndForget(
  cmd: IPC,
  args?: Record<string, unknown>,
  onError?: (err: unknown) => void,
): void {
  invoke(cmd, args).catch((err: unknown) => {
    console.error(`[IPC] ${cmd} failed:`, err);
    onError?.(err);
  });
}
