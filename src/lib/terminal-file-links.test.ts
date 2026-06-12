/**
 * Tests for the terminal link-provider matcher (extracted from
 * TerminalView). Covers the path styles claude actually prints — POSIX,
 * relative, scoped packages, line:col suffixes — plus Windows drive
 * paths, which the user's transcripts are full of and which the old
 * inline regex silently ignored.
 */

import { describe, expect, it } from 'vitest';
import { extractFileLinkCandidates, stripLineColSuffix } from './terminal-file-links.js';

describe('extractFileLinkCandidates', () => {
  it('matches a POSIX absolute path with extension', () => {
    const links = extractFileLinkCandidates('see /home/user/app/main.ts for details');
    expect(links).toHaveLength(1);
    expect(links[0]?.text).toBe('/home/user/app/main.ts');
    expect(links[0]?.startIndex).toBe(4);
  });

  it('matches ./ and ../ relative paths', () => {
    const links = extractFileLinkCandidates('edit ./src/a.ts and ../lib/b.js');
    expect(links.map((l) => l.text)).toEqual(['./src/a.ts', '../lib/b.js']);
  });

  it('matches bare relative paths with a slash', () => {
    const links = extractFileLinkCandidates('open src/store/chats.ts now');
    expect(links.map((l) => l.text)).toEqual(['src/store/chats.ts']);
  });

  it('keeps a :line:col suffix in the text', () => {
    const links = extractFileLinkCandidates('error at src/foo.ts:42:10');
    expect(links[0]?.text).toBe('src/foo.ts:42:10');
  });

  it('matches Windows backslash paths', () => {
    const links = extractFileLinkCandidates(
      String.raw`файл лежит в C:\Users\burmistrov\potok-marketing\site-pages\POT-2.md рядом`,
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.text).toBe(
      String.raw`C:\Users\burmistrov\potok-marketing\site-pages\POT-2.md`,
    );
  });

  it('matches Windows forward-slash paths', () => {
    const links = extractFileLinkCandidates('see D:/YandexDisk/Antigravity/ClaudeDesk/README.md');
    expect(links[0]?.text).toBe('D:/YandexDisk/Antigravity/ClaudeDesk/README.md');
  });

  it('strips trailing punctuation', () => {
    const links = extractFileLinkCandidates('look at src/foo.ts.');
    expect(links[0]?.text).toBe('src/foo.ts');
  });

  it('requires a dot (skips plain directories)', () => {
    expect(extractFileLinkCandidates('go to src/components now')).toEqual([]);
  });

  it('returns no candidates for plain prose', () => {
    expect(extractFileLinkCandidates('обычный текст без путей')).toEqual([]);
  });

  it('finds multiple candidates with correct indices', () => {
    const line = 'a /x/y.ts b src/z.js c';
    const links = extractFileLinkCandidates(line);
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect(line.slice(l.startIndex, l.startIndex + l.length)).toBe(l.text);
    }
  });
});

describe('stripLineColSuffix', () => {
  it('strips :line and :line:col', () => {
    expect(stripLineColSuffix('a/b.ts:42')).toBe('a/b.ts');
    expect(stripLineColSuffix('a/b.ts:42:10')).toBe('a/b.ts');
  });
  it('leaves Windows drive prefixes alone', () => {
    expect(stripLineColSuffix(String.raw`C:\a\b.ts`)).toBe(String.raw`C:\a\b.ts`);
  });
});
