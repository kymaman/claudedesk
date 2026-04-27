/**
 * agent-output-analyzer.ts
 *
 * Pure text/ANSI analysis for agent terminal output. Extracted from
 * src/store/taskStatus.ts so the store layer can stay focused on
 * SolidJS signals + per-agent tracking maps.
 *
 * Nothing in here reads `store`, `setStore`, signals, or any module-scope
 * mutable state. Every function takes its full input as arguments and
 * returns a value, which is what makes them safe to unit-test in isolation
 * (see agent-output-analyzer.test.ts) and reuse from other modules.
 */

// --- Trust-specific patterns (subset of QUESTION_PATTERNS) ---
// These are auto-accepted when autoTrustFolders is enabled.
// Note: TUI apps (Ink/blessed) use ANSI cursor-positioning to lay out text.
// After stripping ANSI, words run together (e.g. "Itrustthisfolder"),
// so patterns must work without word boundaries or spaces.
export const TRUST_PATTERNS: RegExp[] = [
  /\btrust\b.*\?/i, // normal text with spaces: "trust this folder?"
  /\ballow\b.*\?/i, // normal text: "allow access?"
  /trust.*folder/i, // TUI-garbled: "Itrustthisfolder"
  /confirm.*folder.*trust/i, // Copilot CLI: "Confirm folder trust" (normal and garbled)
];

// Safety guard: reject auto-trust if the dialog mentions dangerous operations.
// Uses \b so garbled TUI text ("forkeyboardshortcuts") doesn't false-positive.
// In garbled text, \b doesn't match between concatenated words — that's fine:
// Claude Code's trust dialog content is fixed and won't contain these keywords.
export const TRUST_EXCLUSION_KEYWORDS =
  /\b(delet|remov|credential|secret|password|key|token|destro|format|drop)/i;

/**
 * Patterns that indicate the agent is waiting for user input (i.e. idle).
 * Each regex is tested against the last non-empty line of stripped output.
 *
 * - Claude Code prompt: ends with ❯ (possibly with trailing whitespace)
 * - Common shell prompts: $, %, #, >
 * - Y/n confirmation prompts
 */
const PROMPT_PATTERNS: RegExp[] = [
  /❯\s*$/, // Claude Code prompt
  /›\s*$/, // Codex CLI prompt
  /(?:^|\s)\$\s*$/, // bash/zsh dollar prompt (preceded by whitespace or BOL)
  /(?:^|\s)%\s*$/, // zsh percent prompt
  /(?:^|\s)#\s*$/, // root prompt
  /\[Y\/n\]\s*$/i, // Y/n confirmation
  /\[y\/N\]\s*$/i, // y/N confirmation
];

/**
 * Patterns for known agent main input prompts (ready for a new task).
 * Tested against the stripped data chunk (not a single line), because TUI
 * apps like Claude Code use cursor positioning instead of newlines.
 */
const AGENT_READY_TAIL_PATTERNS: RegExp[] = [/❯/, /›/];

/** Patterns indicating the terminal is asking a question — do NOT auto-send.
 *  Includes both normal-text and TUI-garbled variants (no spaces between words
 *  after ANSI cursor-positioning sequences are stripped). */
const QUESTION_PATTERNS: RegExp[] = [
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
  /\(y(?:es)?\/n(?:o)?\)\s*$/i,
  /\btrust\b.*\?/i,
  /\bupdate\b.*\?/i,
  /\bproceed\b.*\?/i,
  /\boverwrite\b.*\?/i,
  /\bcontinue\b.*\?/i,
  /\ballow\b.*\?/i,
  /Do you want to/i,
  /Would you like to/i,
  /Are you sure/i,
  // TUI-garbled: words concatenated after ANSI strip ("Itrustthisfolder").
  /trust.*folder/i,
  // Copilot CLI header: "Confirm folder trust" (normal and TUI-garbled "Confirmfoldertrust").
  /confirm.*folder.*trust/i,
];

/** Strip ANSI escape sequences (CSI, OSC, and single-char escapes) from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g,
    '',
  );
}

/** Returns true if `line` looks like a prompt waiting for input. */
export function looksLikePrompt(line: string): boolean {
  const stripped = stripAnsi(line).trimEnd();
  if (stripped.length === 0) return false;
  return PROMPT_PATTERNS.some((re) => re.test(stripped));
}

/** Check stripped output for known agent prompt characters.
 *  Only checks the tail of the chunk — the agent's main prompt renders near
 *  the end of the visible content, while TUI selection UIs place ❯ earlier in
 *  the render followed by option text and other choices.
 *  300 chars covers both Claude Code (❯ at the very end) and Copilot CLI
 *  (❯ ~200 chars from end — box border and a footer line appear below it). */
export function chunkContainsAgentPrompt(stripped: string): boolean {
  if (stripped.length === 0) return false;
  const tail = stripped.slice(-300);
  return AGENT_READY_TAIL_PATTERNS.some((re) => re.test(tail));
}

/**
 * Normalize terminal output for quiescence comparison.
 * Strips ANSI, removes control characters, collapses whitespace so that
 * cursor repositioning and status bar redraws don't register as changes.
 */
export function normalizeForComparison(text: string): string {
  return (
    stripAnsi(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Like normalizeForComparison, but only considers the most recently rendered
 * screen frame.  TUI agents (Copilot CLI, Codex CLI) redraw the full screen on
 * every frame using cursor-positioning escape codes without a screen-clear
 * between frames.  The raw tail buffer therefore grows with each redraw even
 * when the visible content is identical, making `normalizeForComparison(tail)`
 * produce a longer string on every call — which breaks the quiescence snapshot
 * comparison in PromptInput.
 *
 * This function finds the last occurrence of a "frame start" marker
 * (cursor-to-row-1 or screen-clear sequence) and normalizes only the content
 * from that point on.  Consecutive redraws of the same screen therefore
 * produce identical normalized strings, allowing the stability check to pass.
 *
 * Falls back to normalizeForComparison(text) when no frame-start marker is
 * found (regular line-oriented terminal output).
 */
export function normalizeCurrentFrame(rawTail: string): string {
  // Matches the beginning of a new render cycle:
  //   \x1b[H        — cursor home (row 1, col 1)
  //   \x1b[1;NNH    — cursor to row 1, any column
  //   \x1b[2J       — erase entire display
  //   \x1b[?1049h   — enter alternate screen buffer
  // eslint-disable-next-line no-control-regex
  const frameStartRe = /\x1b\[(?:H|1;\d+H|2J|\?1049h)/g;
  let frameStart = -1;
  let m: RegExpExecArray | null;
  while ((m = frameStartRe.exec(rawTail)) !== null) {
    frameStart = m.index;
  }
  if (frameStart >= 0) {
    return normalizeForComparison(rawTail.slice(frameStart));
  }
  // No frame-start marker found (e.g. cursor-up redraws).  Each redraw appends
  // identical visible content so the full normalized string grows without bound.
  // Taking a fixed-size suffix stabilises the comparison: once two consecutive
  // frames have accumulated the last SUFFIX_LEN chars are always the same
  // repeating frame content.
  const SUFFIX_LEN = 1000;
  return normalizeForComparison(rawTail).slice(-SUFFIX_LEN);
}

/** Find the byte offset just after the last screen-clearing ANSI sequence
 *  that has non-empty visible content after it.  Returns -1 when none is found.
 *
 *  Full-screen TUI apps (Ink, etc.) erase their display before every redraw.
 *  We walk backward through all clears and pick the last one that already has
 *  visible text after it.  This prevents a mid-redraw race where the most
 *  recent \x1b[2J was just emitted but the TUI hasn't written the new render
 *  yet — in that window the post-clear content is empty, causing a false
 *  negative that lets auto-send fire into an active dialog. */
function findLastNonEmptyScreenClear(raw: string): number {
  // \x1b[2J  – erase entire display (most common full-screen clear)
  // \x1b[?1049h – enter alternate screen buffer (fresh context on TUI start)
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[2J|\x1b\[\?1049h/g;
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    indices.push(m.index + m[0].length);
  }
  // Walk from newest to oldest, return the first (newest) clear with content.
  for (let i = indices.length - 1; i >= 0; i--) {
    if (stripAnsi(raw.slice(indices[i])).trim().length > 0) {
      return indices[i];
    }
  }
  return -1;
}

/** True when recent output contains a question or confirmation prompt.
 *  Checks ALL recent lines because TUI dialogs render the question above
 *  selection options — the question text may not be the last line.
 *
 *  For full-screen TUI agents (e.g. Copilot CLI) that clear+redraw their
 *  display on every render cycle, only output *after* the most recent
 *  COMPLETE render is analysed.  This prevents stale question text from a
 *  previous render from keeping the question flag set indefinitely after the
 *  agent has returned to its prompt.  "Most recent complete render" means the
 *  last screen-clear that has non-empty visible content after it — skipping
 *  mid-redraw clears where the new render hasn't been written yet.
 *
 *  For agents that do not emit screen-clear sequences the full tail buffer
 *  is used, preserving the existing behaviour. */
export function looksLikeQuestion(tail: string): boolean {
  // Restrict analysis to content after the last COMPLETE screen clear.
  const clearIdx = findLastNonEmptyScreenClear(tail);
  const analysisTail = clearIdx >= 0 ? tail.slice(clearIdx) : tail;

  const visible = stripAnsi(analysisTail);
  // Use the full visible content — do NOT slice to a small suffix.
  // TUI agents (Copilot CLI, Codex CLI) use cursor positioning instead of
  // newlines, so all rendered text collapses to one long string.  A 500-char
  // window only captures the selection options (❯ Yes / No) and misses the
  // question header ("Confirm folder trust", "Do you trust…?") that appears
  // earlier in the visual layout.  Visible content is always bounded by
  // TAIL_BUFFER_MAX raw bytes so scanning the full string is fast.
  const chunk = visible;
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return false;
  }

  // --- Trust-dialog fast path ---
  // Check the current-frame raw bytes for trust phrases before any ANSI stripping.
  // Trust dialog text is written as atomic UTF-8 — ANSI codes appear between words,
  // not inside them, so a raw search reliably finds them.  Use analysisTail (not
  // full tail) to avoid matching stale trust-dialog content from old TUI frames
  // that have already been overwritten by a screen-clear.
  const rawLower = analysisTail.toLowerCase();
  if (rawLower.includes('confirm folder trust') || rawLower.includes('do you trust')) {
    // Bare ❯ on its own line means the dialog was already answered.
    const hasBarePromptLineRaw = lines.some((l) => /^\s*[❯›]\s*$/.test(l.trimEnd()));
    if (!hasBarePromptLineRaw) {
      return true;
    }
  }

  // Check trust patterns against the ANSI-stripped lines BEFORE the bare-❯ suppression.
  // TUI agents (Ink) render the trust dialog using cursor-positioning — after ANSI stripping
  // all content collapses to one long string.  If the PTY buffer was captured
  // mid-frame (e.g. right after the selection-cursor ❯ was written but before
  // the surrounding box-border was completed), that string can end with ❯,
  // which would normally trigger the bare-❯ suppression and return false.
  // Trust dialogs are high-confidence: if the visible content contains a trust
  // pattern, we return true immediately — UNLESS a bare-❯-only line is present
  // (which would mean the question was already answered and the agent is back
  // at its main prompt with old trust-dialog text still in the buffer).
  const hasTrustContent = lines.some((line) => {
    const trimmed = line.trimEnd();
    return TRUST_PATTERNS.some((re) => re.test(trimmed));
  });
  if (hasTrustContent) {
    // A bare ❯ on its own line means the agent returned to its prompt after
    // the trust dialog was already handled (old text lingers in the tail buffer).
    const hasBarePromptLine = lines.some((l) => /^\s*[❯›]\s*$/.test(l.trimEnd()));
    if (!hasBarePromptLine) {
      return true;
    }
  }

  // If a known agent main prompt (❯ or ›) is visible on its own line or at
  // the end of a line, any earlier question/trust dialog text has already been
  // answered — not a live question.
  // TUI selection UIs also use ❯, but always followed by option text
  // (e.g. "❯ Yes"), so they won't produce a bare ❯ line or end-of-line ❯.
  //
  // We scan the last 8 lines (not just the last 3) because some TUI agents
  // (e.g. Codex CLI) render a multi-line footer/help bar *below* the prompt,
  // pushing the bare ❯/› line several positions up from the end.
  const lastLine = lines[lines.length - 1].trimEnd();
  const recentLines = lines.slice(-8);
  if (recentLines.some((l) => /^\s*[❯›]\s*$/.test(l.trimEnd())) || /[❯›]\s*$/.test(lastLine)) {
    return false;
  }

  return lines.some((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return false;
    return QUESTION_PATTERNS.some((re) => re.test(trimmed));
  });
}

/** True when recent output contains a trust or permission dialog. */
export function looksLikeTrustDialog(tail: string): boolean {
  // Raw-text fast path: trust dialog phrases are literal UTF-8 in the PTY stream.
  // ANSI codes appear between/around words but not splitting individual words, so a
  // case-insensitive raw search reliably finds them without stripping first.
  const rawLower = tail.toLowerCase();
  if (rawLower.includes('confirm folder trust') || rawLower.includes('do you trust')) {
    return true;
  }

  const visible = stripAnsi(tail); // full visible — see looksLikeQuestion for rationale
  const lines = visible.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.some((line) => TRUST_PATTERNS.some((re) => re.test(line.trimEnd())));
}

/**
 * True when the tail buffer's question patterns are entirely from trust/allow
 * dialogs that auto-trust *would* handle. Stateless variant — the caller must
 * supply `autoTrustEnabled` because that flag lives in the SolidJS store.
 *
 * Returns false when:
 *   - autoTrustEnabled is false
 *   - the tail doesn't contain trust dialog patterns
 *   - exclusion keywords (delete, password, etc.) are present
 *   - non-trust question patterns are also found in the tail
 */
export function isTrustQuestionAutoHandled(tail: string, autoTrustEnabled: boolean): boolean {
  if (!autoTrustEnabled) return false;
  if (!looksLikeTrustDialog(tail)) return false;
  const visible = stripAnsi(tail); // full visible — see looksLikeQuestion for rationale
  if (TRUST_EXCLUSION_KEYWORDS.test(visible)) return false;
  const lines = visible.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return !lines.some((line) => {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return false;
    // Lines matching trust patterns are handled by auto-trust — skip them.
    if (TRUST_PATTERNS.some((re) => re.test(trimmed))) return false;
    // If a line matches a non-trust question pattern, this is NOT only a trust question.
    return QUESTION_PATTERNS.some((re) => re.test(trimmed));
  });
}
