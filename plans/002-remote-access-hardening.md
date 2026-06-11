# Plan 002: Harden the remote-access server — Origin check, sessionStorage token, CSP

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0d7fc92..HEAD -- electron/remote/server.ts src/remote/auth.ts`
> On any change, compare the "Current state" excerpts against the live code;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `0d7fc92`, 2026-06-11

## Why this matters

The remote feature serves the user's live terminals over the LAN
(`0.0.0.0` bind is intentional — phone access). Auth is solid (per-launch
`randomBytes(24)` token, `timingSafeEqual`, unauthenticated sockets cut after
5 s, every command message requires prior auth). Three gaps remain:
(1) WebSocket upgrades accept ANY Origin, so a malicious web page open in a
browser on the same LAN can attempt cross-site WebSocket connections (CSWSH) —
they still need the token, but the door should not be open at all;
(2) the token is persisted in `localStorage` forever — any XSS or rogue
browser extension on the phone can read it;
(3) no Content-Security-Policy on served pages. Terminal input = command
execution on this PC, so defense-in-depth here is cheap and worth it.

## Current state

- `electron/remote/server.ts` — HTTP + WS server. Key excerpts:

`verifyClient` accepts everyone (lines 217–228):

```ts
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,
  verifyClient: (info, cb) => {
    if (wss.clients.size >= 10) {
      cb(false, 429, 'Too many connections');
      return;
    }
    // Also accept token in URL query for backward compatibility, but
    // the preferred flow is first-message auth (avoids token in URL).
    cb(true);
  },
});
```

Bind (line 395): `server.listen(opts.port, '0.0.0.0', () => { ... });`
Token (lines 106–109): `const token = randomBytes(24).toString('base64url');`
There is a `SECURITY_HEADERS` object already used in responses (e.g. line 205
`res.writeHead(404, SECURITY_HEADERS)`) — find its definition near the top of
`startRemoteServer` and extend it.

- `src/remote/auth.ts` — browser-side token storage (whole file is 38 lines):

```ts
const TOKEN_KEY = 'parallel-code-token';

/** Extract token from URL query param and persist to localStorage. */
export function initAuth(): string | null {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');

  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    ...
  }
  return localStorage.getItem(TOKEN_KEY);
}
```

`getToken()` / `clearToken()` also use `localStorage`.

- The remote SPA is a separate Vite build: `npm run build:remote`
  (config `src/remote/vite.config.ts`). The server token is NEW on every app
  launch, so long-term client-side persistence buys nothing anyway —
  `sessionStorage` (cleared when the tab closes) loses no real functionality.

## Commands you will need

| Purpose          | Command                                                                    | Expected on success |
| ---------------- | -------------------------------------------------------------------------- | ------------------- |
| Typecheck        | `npm run typecheck`                                                        | exit 0              |
| Compile electron | `npm run compile`                                                          | exit 0              |
| Build remote SPA | `npm run build:remote`                                                     | exit 0              |
| Lint             | `npx eslint electron/remote/server.ts src/remote/auth.ts --max-warnings 0` | exit 0              |

## Scope

**In scope**:

- `electron/remote/server.ts`
- `src/remote/auth.ts`
- `electron/remote/server.test.ts` (create if practical — see Test plan)

**Out of scope**:

- The `0.0.0.0` bind — it IS the feature (phone access). Do not change it.
- The token scheme itself (generation, timingSafeEqual compare, first-message
  auth) — already sound, do not redesign.
- `src/remote/ws.ts`, `src/remote/AgentDetail.tsx` — client logic unchanged.
- QR/URL flow in the main app UI.

## Git workflow

- Current branch; commit style `fix(remote): ...`. Do NOT push.

## Steps

### Step 1: Reject cross-origin WebSocket upgrades

In `verifyClient`, before `cb(true)`, add an Origin check: browsers ALWAYS
send an `Origin` header on WebSocket handshakes; non-browser clients may omit
it. Policy — reject only a PRESENT, mismatched Origin:

```ts
const origin = info.req.headers.origin;
if (origin) {
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host; // host includes :port
  } catch {
    originHost = null;
  }
  const reqHost = info.req.headers.host; // e.g. 192.168.1.10:3030
  if (!originHost || !reqHost || originHost !== reqHost) {
    cb(false, 403, 'Forbidden origin');
    return;
  }
}
cb(true);
```

This keeps the legit flow working (the SPA is served from the same
host:port it connects to) and blocks pages from other origins.

**Verify**: `npm run compile` → exit 0.

### Step 2: Move the client token from localStorage to sessionStorage

In `src/remote/auth.ts`, replace every `localStorage` with `sessionStorage`
(3 call sites: `initAuth` set + get, `getToken`, `clearToken`). Update the
file-top comment to say the token is per-app-launch anyway, so session-scoped
storage loses nothing. Keep `TOKEN_KEY` unchanged.

**Verify**: `npm run typecheck` → exit 0, then `npm run build:remote` → exit 0.

### Step 3: Add a Content-Security-Policy header

Find the `SECURITY_HEADERS` definition in `electron/remote/server.ts` and add:

```ts
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
```

`'unsafe-inline'` for styles is needed only if the built SPA uses inline
styles — check `dist-remote/index.html` after `npm run build:remote`; if there
are no inline `<style>`/style attributes, drop `'unsafe-inline'`.

**Verify**: `npm run compile` → exit 0. Then functional check: run the app or
`node -e` against a started server is impractical here — instead grep:
`Select-String -Path electron\remote\server.ts -Pattern 'Content-Security-Policy'`
→ 1 match inside SECURITY_HEADERS.

### Step 4: Unit-test the origin policy (pure function)

Extract the origin decision into an exported pure helper so it's testable
without sockets:

```ts
/** Browsers always send Origin on WS handshakes; absent Origin = non-browser client, allowed. */
export function isOriginAllowed(origin: string | undefined, reqHost: string | undefined): boolean;
```

Use it from `verifyClient`. Create `electron/remote/server.test.ts` (vitest,
node env — mock `electron` if the import chain requires it; follow the
`vi.mock('electron', ...)` pattern from `electron/ipc/session-lineage.test.ts`)
with cases: same host:port → true; different host → false; different port →
false; absent origin → true; malformed origin → false; absent reqHost with
present origin → false.

**Verify**: `npx vitest run electron/remote/server.test.ts` → 6 tests pass.

## Test plan

Step 4 covers the new logic. Manual smoke (optional, requires a phone or
second browser): start remote access from the app UI, open the QR URL — page
loads, terminal streams; then from a devtools console on ANY OTHER site try
`new WebSocket('ws://<pc-ip>:<port>')` → connection fails during handshake.

## Done criteria

- [ ] `npm run typecheck`, `npm run compile`, `npm run build:remote` all exit 0
- [ ] `npx vitest run electron/remote/server.test.ts` exits 0
- [ ] `Select-String -Path src\remote\auth.ts -Pattern 'localStorage'` → 0 matches
- [ ] CSP header present in SECURITY_HEADERS
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- `SECURITY_HEADERS` does not exist or responses are written without it —
  report instead of inventing a new header mechanism.
- The remote SPA stops connecting after the Origin check (would mean the SPA
  is served from a different host than it connects to) — report, do not loosen
  the check.
- Importing `server.ts` in vitest drags in `node-pty` or other native modules
  that fail to load — extract `isOriginAllowed` into a separate small file
  (e.g. `electron/remote/origin.ts`) instead; that keeps the test dependency-free.

## Maintenance notes

- If TLS is added later (self-signed cert for LAN), revisit `connect-src` in
  the CSP and the ws:// references.
- If a reverse proxy (Tailscale Serve etc.) ever fronts this server, the
  Origin==Host policy needs the proxy's external host allowed — keep the
  helper pure so that's a one-line change.
- Deferred consciously: token expiry/rotation (token already rotates per app
  launch), TLS (LAN threat model accepted by the owner).
