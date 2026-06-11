const TOKEN_KEY = 'parallel-code-token';

/**
 * Extract token from URL query param and persist to sessionStorage.
 *
 * The server token is freshly generated on every app launch, so long-term
 * persistence via localStorage buys nothing. sessionStorage (cleared when the
 * tab closes) is strictly better: any XSS or rogue browser extension cannot
 * read a stale token from a previous session.
 */
export function initAuth(): string | null {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');

  if (urlToken) {
    sessionStorage.setItem(TOKEN_KEY, urlToken);
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search);
    return urlToken;
  }

  return sessionStorage.getItem(TOKEN_KEY);
}

/** Get the stored token. */
export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

/** Clear stored token. */
export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** Build an authenticated URL for API requests. */
export function apiUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

/** Build headers with auth token. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
