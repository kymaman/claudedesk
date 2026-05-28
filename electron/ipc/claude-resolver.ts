import { existsSync, statSync, readdirSync } from 'fs';
import path from 'path';

export interface FsProbe {
  exists(p: string): boolean;
  size(p: string): number;
  listDir(p: string): string[];
}

export const defaultFsProbe: FsProbe = {
  exists: (p) => existsSync(p),
  size: (p) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  },
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

// npm publishes a tiny shell-script placeholder named `claude.exe` in the
// generic claude-code package; the real native binary lives in the
// platform-specific optional dep and is ~200 MB. Reject anything below this
// threshold so we never hand the spawner a non-Win32 shim.
const MIN_NATIVE_BINARY_BYTES = 1_000_000;

// Walk the @anthropic-ai folder under an npm prefix and return any usable
// claude.exe paths. Handles four real-world layouts:
//   1. claude-code/bin/claude.exe        — postinstall has swapped the
//      placeholder shim for the real native binary
//   2. claude-code/node_modules/@anthropic-ai/claude-code-win32-x64/
//      claude.exe                       — npm placed the optional dep
//      under claude-code's local node_modules
//   3. claude-code-win32-x64/claude.exe  — flat sibling layout
//   4. .claude-code-*/node_modules/@anthropic-ai/claude-code-win32-x64/
//      claude.exe                       — hashed isolated install layout
function findNativeUnderNpmPrefix(npmPrefix: string, fs: FsProbe): string[] {
  const anthropicDir = path.join(npmPrefix, 'node_modules', '@anthropic-ai');
  if (!fs.exists(anthropicDir)) return [];

  const out: string[] = [];
  const binNative = path.join(anthropicDir, 'claude-code', 'bin', 'claude.exe');
  if (fs.exists(binNative)) out.push(binNative);

  const nestedDirect = path.join(
    anthropicDir,
    'claude-code',
    'node_modules',
    '@anthropic-ai',
    'claude-code-win32-x64',
    'claude.exe',
  );
  if (fs.exists(nestedDirect)) out.push(nestedDirect);

  const directNative = path.join(anthropicDir, 'claude-code-win32-x64', 'claude.exe');
  if (fs.exists(directNative)) out.push(directNative);

  for (const entry of fs.listDir(anthropicDir)) {
    if (!entry.startsWith('.claude-code')) continue;
    const nested = path.join(
      anthropicDir,
      entry,
      'node_modules',
      '@anthropic-ai',
      'claude-code-win32-x64',
      'claude.exe',
    );
    if (fs.exists(nested)) out.push(nested);
  }
  return out;
}

export function resolveClaudeBinary(homedir: string, fs: FsProbe = defaultFsProbe): string {
  const candidates: string[] = [
    path.join(homedir, '.local', 'bin', 'claude.exe'),
    ...findNativeUnderNpmPrefix(path.join(homedir, 'AppData', 'Roaming', 'npm'), fs),
    ...findNativeUnderNpmPrefix(path.join(homedir, 'AppData', 'Local', 'npm'), fs),
  ];

  for (const candidate of candidates) {
    if (fs.exists(candidate) && fs.size(candidate) >= MIN_NATIVE_BINARY_BYTES) {
      return candidate;
    }
  }
  return path.join(homedir, '.local', 'bin', 'claude.exe');
}

export const _internals = { MIN_NATIVE_BINARY_BYTES };
