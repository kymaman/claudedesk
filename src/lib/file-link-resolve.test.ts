/**
 * Unit: file-link resolution must NOT prefix cwd onto an already-absolute
 * Windows path. Pins the fix for "open folder leads nowhere on Windows".
 */
import { describe, it, expect } from 'vitest';
import { isAbsolutePath, resolveFileLink } from './file-link-resolve';

describe('isAbsolutePath', () => {
  it('accepts POSIX absolute paths', () => {
    expect(isAbsolutePath('/usr/local/bin/foo')).toBe(true);
  });
  it('accepts Windows drive-letter paths with backslash', () => {
    expect(isAbsolutePath('C:\\Users\\me\\foo.ts')).toBe(true);
  });
  it('accepts Windows drive-letter paths with forward slash', () => {
    expect(isAbsolutePath('D:/Yandex/proj/file.ts')).toBe(true);
  });
  it('accepts lowercase drive letter', () => {
    expect(isAbsolutePath('c:\\temp')).toBe(true);
  });
  it('accepts UNC paths', () => {
    expect(isAbsolutePath('\\\\server\\share\\file')).toBe(true);
  });
  it('rejects relative paths', () => {
    expect(isAbsolutePath('foo/bar.ts')).toBe(false);
    expect(isAbsolutePath('./src/main.ts')).toBe(false);
    expect(isAbsolutePath('../parent')).toBe(false);
  });
});

describe('resolveFileLink', () => {
  it('returns Windows absolute path as-is, NOT prefixed with cwd', () => {
    expect(resolveFileLink('C:\\Users\\me\\foo.ts', 'D:/work')).toBe('C:\\Users\\me\\foo.ts');
  });
  it('joins relative path under cwd', () => {
    expect(resolveFileLink('src/main.ts', 'D:/work')).toBe('D:/work/src/main.ts');
  });
  it('returns POSIX absolute path as-is', () => {
    expect(resolveFileLink('/etc/hosts', '/home/x')).toBe('/etc/hosts');
  });
});
