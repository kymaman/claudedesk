/**
 * Tiny helper for resolving a clicked terminal file-link against the
 * chat's cwd. Lives in its own module so the Windows-absolute-path
 * heuristic can be unit-tested without dragging in xterm/Solid.
 *
 * Bug it guards against: on Windows, `C:\Users\…` does NOT start with
 * `/`, so the prior naive `startsWith('/')` check treated every Win
 * absolute path as relative and prefixed it with cwd → the resulting
 * "open folder" action led to a mangled, non-existent location.
 */

export function isAbsolutePath(p: string): boolean {
  // POSIX: leading slash.
  // Windows: drive-letter + colon + slash/backslash (C:\, c:/), OR
  //          UNC path starting with `\\` (`\\server\share`).
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p);
}

export function resolveFileLink(linkText: string, cwd: string): string {
  return isAbsolutePath(linkText) ? linkText : `${cwd}/${linkText}`;
}
