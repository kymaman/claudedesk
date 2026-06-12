/**
 * terminal-file-links.ts
 *
 * Pure helper behind TerminalView's link provider: find file-path
 * candidates in a single terminal line. Extracted from the component so
 * the matching rules are unit-testable (TerminalView itself needs a live
 * xterm + PTY and has no test harness).
 *
 * Matching rules:
 *  - POSIX absolute (/a/b.ts), ./ and ../ relative, bare relative with a
 *    slash (src/lib/foo.ts), @scoped package paths
 *  - Windows absolute paths (C:\Users\x\file.md or C:/Users/x/file.md)
 *  - optional :line or :line:col suffix (foo.ts:42:10)
 *  - must contain a dot (file extension) — avoids matching plain
 *    directories and URLs-less prose
 *  - trailing punctuation (.,;:!?)) is stripped
 */

export interface FileLinkCandidate {
  /** 0-based character index in the line. */
  startIndex: number;
  /** Length of the matched (cleaned) text. */
  length: number;
  /** The cleaned path text, including any :line:col suffix. */
  text: string;
}

const PATH_RE =
  // windows drive | posix abs | ./ ../ | bare-with-slash (incl @scope)
  /(?:[A-Za-z]:[\\/][\w@.\\/-]+|\/[\w@./-]+|\.{1,2}\/[\w@./-]+|[\w@][\w@./-]*\/[\w@./-]+)(?::\d+(?::\d+)?)?/g;

export function extractFileLinkCandidates(line: string): FileLinkCandidate[] {
  const links: FileLinkCandidate[] = [];
  let match: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((match = PATH_RE.exec(line)) !== null) {
    // Strip trailing punctuation that's not part of the path
    const text = match[0].replace(/[.,;:!?)]+$/, '');
    if (!text) continue;
    // Must contain a dot somewhere (file extension) to avoid matching
    // plain directories
    if (!text.includes('.')) continue;
    links.push({ startIndex: match.index, length: text.length, text });
  }
  return links;
}

/** Strip a :line(:col) suffix so the path can be opened on disk. */
export function stripLineColSuffix(text: string): string {
  return text.replace(/:\d+(:\d+)?$/, '');
}
