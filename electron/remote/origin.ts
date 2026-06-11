// electron/remote/origin.ts

/**
 * Browsers always send the Origin header on WebSocket handshakes.
 * Non-browser clients (native apps, CLI tools) may omit it — those are allowed.
 *
 * Policy: reject only a PRESENT Origin that does not match the request Host.
 * This blocks cross-site WebSocket hijacking (CSWSH) from other browser tabs
 * while keeping the legitimate flow (SPA served from the same host:port) working.
 */
export function isOriginAllowed(origin: string | undefined, reqHost: string | undefined): boolean {
  if (!origin) {
    // Non-browser client — allow
    return true;
  }
  if (!reqHost) {
    // Origin present but no Host header — reject (malformed / unusual request)
    return false;
  }
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host; // host includes :port
  } catch {
    // Malformed Origin — reject
    return false;
  }
  return originHost === reqHost;
}
