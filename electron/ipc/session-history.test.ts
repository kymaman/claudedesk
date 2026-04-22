/**
 * Tests for session-history.ts cwd-recovery logic.
 *
 * Regression motivation: folder names under ~/.claude/projects encode the
 * original cwd by replacing separators with "-", but this is lossy — dashes
 * inside real path segments (e.g. UUIDs, "my-project") can't be distinguished
 * from separators. We now read the real cwd from inside the JSONL itself.
 * If the JSONL has no cwd field, we fall back to the (lossy) decoded name.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (_: string): string =>
      path.join(os.tmpdir(), `claudedesk-test-${process.pid}-${Date.now()}`),
  },
}));

async function importModule() {
  // Re-import per test to pick up a fresh SQLite path.
  vi.resetModules();
  return await import('./session-history.js');
}

describe('parseJsonlSummary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedesk-jsonl-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts cwd from the first record that carries one', async () => {
    const { __test } = await importModule();
    const file = path.join(tmpDir, 'a.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
        JSON.stringify({
          type: 'user',
          cwd: 'C:\\Users\\me\\my-project-name',
          message: { role: 'user', content: 'hello world' },
        }),
      ].join('\n'),
    );

    const extracted = await __test.parseJsonlSummary(file);
    expect(extracted.cwd).toBe('C:\\Users\\me\\my-project-name');
    expect(extracted.title).toBe('hello world');
  });

  it('preserves dashes inside cwd segments — this is the whole point of the fix', async () => {
    const { __test } = await importModule();
    const file = path.join(tmpDir, 'b.jsonl');
    const realCwd =
      'C:\\Users\\burmistrov\\.paperclip\\instances\\default\\projects\\2b021542-e720-46b1-bb06-3b2858903176';
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'user', cwd: realCwd, message: { role: 'user', content: 'x' } }),
    );

    const extracted = await __test.parseJsonlSummary(file);
    expect(extracted.cwd).toBe(realCwd);
  });

  it('returns null cwd when the JSONL never has a cwd field', async () => {
    const { __test } = await importModule();
    const file = path.join(tmpDir, 'c.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'summary', summary: 'only a summary' }));

    const extracted = await __test.parseJsonlSummary(file);
    expect(extracted.cwd).toBeNull();
    expect(extracted.summary).toBe('only a summary');
  });

  it('returns null cwd for a non-existent file without throwing', async () => {
    const { __test } = await importModule();
    const extracted = await __test.parseJsonlSummary(path.join(tmpDir, 'missing.jsonl'));
    expect(extracted.cwd).toBeNull();
  });
});

describe('decodeProjectPath (legacy fallback)', () => {
  it('demonstrates the lossy nature the JSONL fix works around', async () => {
    const { __test } = await importModule();
    // A folder name that encodes cwd "C:\Users\me\my-project-name":
    // all dashes become slashes, producing a wrong path.
    const decoded = __test.decodeProjectPath('C--Users-me-my-project-name');
    expect(decoded).toBe('C:/Users/me/my/project/name');
    // The real cwd from the JSONL would be preferred instead.
  });

  it('decodes a simple Windows-style folder correctly when no dashes are present in segments', async () => {
    const { __test } = await importModule();
    expect(__test.decodeProjectPath('D--YandexDisk-Antigravity-EasyTable')).toBe(
      'D:/YandexDisk/Antigravity/EasyTable',
    );
  });
});

// NOTE: integration tests over `listSessions` are omitted because the module
// opens a better-sqlite3 database on first use, and better-sqlite3 in this
// project is rebuilt against Electron's ABI (v143) — vitest runs under plain
// Node (v127) and can't load the .node binary. The parseJsonlSummary unit
// tests above cover the entire cwd-recovery logic; listSessions only wires
// the `extracted.cwd` through as `projectPath`.
