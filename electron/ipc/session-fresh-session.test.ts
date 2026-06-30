/**
 * session-fresh-session.test.ts
 *
 * resolveFreshSessionId — bind a FRESH tile (opened without a --resume
 * seed) to the session claude mints once the user sends a first message.
 *
 * This is the fix for «последние 4 диалога открылись как новые чаты»:
 * a brand-new chat never learned its on-disk session id, so on restart it
 * spawned a blank claude instead of resuming. The resolver matches by
 * cwd + freshness + real content, excluding ids sibling tiles already own,
 * so a fresh chat only ever adopts ITS OWN new session — never a peer's,
 * never an empty aborted shell, never a background agent in another folder.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveFreshSessionId, sessionHeadInfo, normalizeCwd } from './session-lineage.js';

const sid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** Write a session JSONL with a recorded cwd and (optionally) a real user turn. */
function writeSession(
  dir: string,
  sessionId: string,
  opts: { cwd: string; withUser: boolean; mtime?: Date },
): string {
  const lines: string[] = [
    JSON.stringify({ type: 'system', cwd: opts.cwd, sessionId }),
    JSON.stringify({ type: 'bridge-session', sessionId }),
  ];
  if (opts.withUser) {
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `u-${sessionId}`,
        sessionId,
        cwd: opts.cwd,
        message: { role: 'user', content: 'привет, поехали' },
      }),
    );
  }
  const f = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n', 'utf-8');
  if (opts.mtime) fs.utimesSync(f, opts.mtime, opts.mtime);
  return f;
}

describe('normalizeCwd', () => {
  it('is case-insensitive, slash-agnostic, trims trailing separators', () => {
    expect(normalizeCwd('C:\\Users\\Mark\\')).toBe('c:/users/mark');
    expect(normalizeCwd('C:/Users/Mark')).toBe('c:/users/mark');
    expect(normalizeCwd('')).toBe('');
    expect(normalizeCwd(null)).toBe('');
  });
});

describe('sessionHeadInfo', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-fresh-head-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the cwd and detects a real user turn', () => {
    const f = writeSession(root, sid(1), { cwd: 'D:\\proj', withUser: true });
    const info = sessionHeadInfo(f);
    expect(normalizeCwd(info.cwd)).toBe('d:/proj');
    expect(info.hasUser).toBe(true);
  });

  it('an empty shell (only system/bridge lines) has no user turn', () => {
    const f = writeSession(root, sid(2), { cwd: 'D:\\proj', withUser: false });
    const info = sessionHeadInfo(f);
    expect(info.hasUser).toBe(false);
  });
});

describe('resolveFreshSessionId', () => {
  let root: string;
  let proj: string;
  const CWD = 'D:\\YandexDisk\\proj';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-fresh-'));
    proj = path.join(root, 'D--YandexDisk-proj');
    fs.mkdirSync(proj, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('adopts the newest fresh session written in the tile cwd', async () => {
    const since = Date.now() - 30_000;
    writeSession(proj, sid(1), { cwd: CWD, withUser: true, mtime: new Date(since + 1_000) });
    writeSession(proj, sid(2), { cwd: CWD, withUser: true, mtime: new Date(since + 5_000) }); // newest
    const res = await resolveFreshSessionId({
      cwd: CWD,
      sinceMs: since,
      waitMs: 0,
      projectsDir: root,
    });
    expect(res).toEqual({ sessionId: sid(2), changed: true });
  });

  it('never adopts an empty aborted shell', async () => {
    const since = Date.now() - 30_000;
    // newest file is empty (no user turn); only the older real one qualifies
    writeSession(proj, sid(1), { cwd: CWD, withUser: true, mtime: new Date(since + 1_000) });
    writeSession(proj, sid(2), { cwd: CWD, withUser: false, mtime: new Date(since + 9_000) });
    const res = await resolveFreshSessionId({
      cwd: CWD,
      sinceMs: since,
      waitMs: 0,
      projectsDir: root,
    });
    expect(res).toEqual({ sessionId: sid(1), changed: true });
  });

  it('never adopts a session born in a DIFFERENT folder', async () => {
    const since = Date.now() - 30_000;
    const other = path.join(root, 'C--Users-someone');
    fs.mkdirSync(other, { recursive: true });
    writeSession(other, sid(3), { cwd: 'C:\\Users\\someone', withUser: true });
    const res = await resolveFreshSessionId({
      cwd: CWD,
      sinceMs: since,
      waitMs: 0,
      projectsDir: root,
    });
    expect(res).toEqual({ sessionId: null, changed: false });
  });

  it('excludes ids a sibling tile already owns', async () => {
    const since = Date.now() - 30_000;
    writeSession(proj, sid(1), { cwd: CWD, withUser: true, mtime: new Date(since + 1_000) });
    writeSession(proj, sid(2), { cwd: CWD, withUser: true, mtime: new Date(since + 5_000) });
    const res = await resolveFreshSessionId({
      cwd: CWD,
      sinceMs: since,
      waitMs: 0,
      projectsDir: root,
      excludeSessionIds: [sid(2)],
    });
    expect(res).toEqual({ sessionId: sid(1), changed: true });
  });

  it('ignores sessions older than sinceMs (pre-launch sessions)', async () => {
    const since = Date.now() - 30_000;
    writeSession(proj, sid(1), { cwd: CWD, withUser: true, mtime: new Date(since - 60_000) });
    const res = await resolveFreshSessionId({
      cwd: CWD,
      sinceMs: since,
      waitMs: 0,
      projectsDir: root,
    });
    expect(res).toEqual({ sessionId: null, changed: false });
  });

  it('empty cwd falls back to the home dir (the «cross posting» case)', async () => {
    const since = Date.now() - 30_000;
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const homeProj = path.join(root, 'C--home-default');
    fs.mkdirSync(homeProj, { recursive: true });
    writeSession(homeProj, sid(7), { cwd: home, withUser: true, mtime: new Date(since + 2_000) });
    const res = await resolveFreshSessionId({
      cwd: '',
      homeDir: home,
      sinceMs: since,
      waitMs: 0,
      projectsDir: root,
    });
    expect(res).toEqual({ sessionId: sid(7), changed: true });
  });
});
