import { describe, expect, it } from 'vitest';
import path from 'path';
import { resolveClaudeBinary, _internals, type FsProbe } from './claude-resolver.js';

const HOME = path.join('C:', 'Users', 'tester');
const MIN = _internals.MIN_NATIVE_BINARY_BYTES;

function makeProbe(files: Record<string, number>, dirs: Record<string, string[]> = {}): FsProbe {
  return {
    exists: (p) => p in files || p in dirs,
    size: (p) => files[p] ?? 0,
    listDir: (p) => dirs[p] ?? [],
  };
}

describe('resolveClaudeBinary', () => {
  it('prefers the native installer path when a real binary lives there', () => {
    const nativePath = path.join(HOME, '.local', 'bin', 'claude.exe');
    const probe = makeProbe({ [nativePath]: MIN + 1 });
    expect(resolveClaudeBinary(HOME, probe)).toBe(nativePath);
  });

  it('rejects the 500-byte npm placeholder shim and falls through', () => {
    const nativePath = path.join(HOME, '.local', 'bin', 'claude.exe');
    const probe = makeProbe({ [nativePath]: 500 });
    expect(resolveClaudeBinary(HOME, probe)).toBe(nativePath); // fallback path
  });

  it('finds the real binary inside the isolated hashed npm install layout', () => {
    const anthropicDir = path.join(
      HOME,
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      '@anthropic-ai',
    );
    const hashed = path.join(
      anthropicDir,
      '.claude-code-GRWKbxl2',
      'node_modules',
      '@anthropic-ai',
      'claude-code-win32-x64',
      'claude.exe',
    );
    const probe = makeProbe(
      { [hashed]: MIN + 100 },
      { [anthropicDir]: ['.claude-code-GRWKbxl2', 'claude-code'] },
    );
    expect(resolveClaudeBinary(HOME, probe)).toBe(hashed);
  });

  it('finds the real binary in the flat claude-code-win32-x64 layout', () => {
    const anthropicDir = path.join(
      HOME,
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      '@anthropic-ai',
    );
    const flat = path.join(anthropicDir, 'claude-code-win32-x64', 'claude.exe');
    const probe = makeProbe({ [flat]: MIN + 1 }, { [anthropicDir]: ['claude-code-win32-x64'] });
    expect(resolveClaudeBinary(HOME, probe)).toBe(flat);
  });

  it('falls back to AppData/Local/npm when Roaming has no anthropic dir', () => {
    const anthropicDir = path.join(
      HOME,
      'AppData',
      'Local',
      'npm',
      'node_modules',
      '@anthropic-ai',
    );
    const flat = path.join(anthropicDir, 'claude-code-win32-x64', 'claude.exe');
    const probe = makeProbe({ [flat]: MIN + 1 }, { [anthropicDir]: ['claude-code-win32-x64'] });
    expect(resolveClaudeBinary(HOME, probe)).toBe(flat);
  });

  it('returns the default fallback path when nothing is installed', () => {
    const probe = makeProbe({});
    const fallback = path.join(HOME, '.local', 'bin', 'claude.exe');
    expect(resolveClaudeBinary(HOME, probe)).toBe(fallback);
  });
});
