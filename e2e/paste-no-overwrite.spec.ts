/**
 * e2e/paste-no-overwrite.spec.ts
 *
 * Reproduces the user's "second paste erases the first" bug and pins
 * the fix.
 *
 * Mechanism: when a multi-line paste lands in xterm's hidden
 * helper-textarea via a path that bypasses the Ctrl+V handler (Wispr
 * Flow's simulated paste, some IMEs/SendInput tools), the 200ms poll
 * in TerminalView forwards it. The OLD code forwarded it raw — every
 * embedded \n reached claude as Enter, so the first line was
 * submitted and the rest replaced the input. Net effect: the
 * previously pasted block disappeared.
 *
 * The fix routes multi-line injected text through term.paste(), which
 * wraps it in bracketed-paste markers (CSI 200~ … CSI 201~) so claude
 * treats it as one atomic block with NO premature submit.
 *
 * This test:
 *   1. Enables bracketed paste mode on the live term.
 *   2. Captures everything that reaches the PTY via term.onData.
 *   3. Simulates an external injection of a multi-line block A into
 *      the helper-textarea, waits for the poll.
 *   4. Simulates injection of block B the same way.
 *   5. Asserts BOTH blocks arrived AND each is bracketed (so neither
 *      caused a premature submit that would wipe the other).
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, openOneChat, awaitChatReady, closeAllChats } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.afterAll(async () => {
  if (app) await app.close();
});

test('two multi-line injected pastes both arrive bracketed — neither erases the other', async () => {
  await closeAllChats(win);
  await openOneChat(win);
  await awaitChatReady(win);

  const blockA = 'AAA line one\nAAA line two\nAAA line three';
  const blockB = 'BBB line one\nBBB line two\nBBB line three';

  const captured = await win.evaluate(
    async ({ a, b }) => {
      interface XtermInternals {
        __term?: {
          write: (t: string) => void;
          onData: (cb: (d: string) => void) => { dispose: () => void };
        };
      }
      const xtermEl = document.querySelector('.chat-tile .xterm') as HTMLElement | null;
      if (!xtermEl) throw new Error('no .chat-tile .xterm');
      const term = (xtermEl as unknown as XtermInternals).__term;
      if (!term) throw new Error('no __term');
      const ta = xtermEl.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      if (!ta) throw new Error('no helper textarea');

      // Host enables bracketed paste mode (claude does this on startup).
      term.write('\x1b[?2004h');
      await new Promise((r) => setTimeout(r, 40));

      const captured: string[] = [];
      const sub = term.onData((d) => captured.push(d));

      // Simulate Wispr-Flow-style injection: set textarea value
      // programmatically (no keydown), let the 200ms poll pick it up.
      ta.value = a;
      await new Promise((r) => setTimeout(r, 320));
      ta.value = b;
      await new Promise((r) => setTimeout(r, 320));

      sub.dispose();
      return captured.join('');
    },
    { a: blockA, b: blockB },
  );

  // Both blocks' content must be present — neither was lost.
  for (const line of blockA.split('\n')) {
    expect(captured.includes(line), `block A line missing: "${line}"`).toBe(true);
  }
  for (const line of blockB.split('\n')) {
    expect(captured.includes(line), `block B line missing: "${line}"`).toBe(true);
  }

  // Each block must be bracketed — proves no raw multi-line delivery
  // (which is what caused the premature-submit erase). Count open
  // markers: at least two distinct bracketed pastes.
  // eslint-disable-next-line no-control-regex -- ESC is the literal byte we test for
  const openMarkers = (captured.match(/\x1b\[200~/g) ?? []).length;
  // eslint-disable-next-line no-control-regex -- ESC is the literal byte we test for
  const closeMarkers = (captured.match(/\x1b\[201~/g) ?? []).length;
  expect(openMarkers, 'expected ≥2 bracketed-paste open markers').toBeGreaterThanOrEqual(2);
  expect(closeMarkers, 'expected ≥2 bracketed-paste close markers').toBeGreaterThanOrEqual(2);

  // Critical erase-guard: there must be NO bare CR/LF OUTSIDE the
  // bracketed regions. A bare Enter between/after the blocks is what
  // submitted-and-wiped. Strip the bracketed regions, then assert no
  // stray \r or \n remains from our injected blocks.
  // eslint-disable-next-line no-control-regex -- ESC is the literal byte we test for
  const withoutBracketed = captured.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, '');
  expect(
    /[\r\n]/.test(withoutBracketed),
    `found bare newline outside bracketed paste (would submit & erase): ${JSON.stringify(
      withoutBracketed,
    )}`,
  ).toBe(false);

  await closeAllChats(win);
});
