/**
 * auto-trust.test.ts
 *
 * Guards the fix for "open old dialog → история замирает и её не видно": a
 * resumed Claude tile froze at the folder-trust prompt because auto-confirm
 * was gated behind the (default-off) autoTrustFolders toggle. The fix
 * auto-confirms folder-trust for RESUMED sessions regardless of the toggle.
 *
 * The decisive RED→GREEN case is `resume + toggle OFF + trust prompt`: the old
 * gated logic returned false (→ freeze); the fix returns true (→ Enter sent).
 */

import { describe, it, expect } from 'vitest';
import { shouldAutoConfirmFolderTrust } from './auto-trust';

const TRUST_TEXT =
  'Quick safety check: Is this a project you created or one you trust? 1. Yes, I trust this folder 2. No, exit  Enter to confirm';

describe('shouldAutoConfirmFolderTrust', () => {
  it('RESUME + toggle OFF + trust prompt → confirms (the unfreeze fix)', () => {
    expect(
      shouldAutoConfirmFolderTrust({
        text: TRUST_TEXT,
        commandLooksClaude: true,
        isResume: true,
        autoTrustEnabled: false,
      }),
    ).toBe(true);
  });

  it('matches the real "trust this folder" wording', () => {
    expect(
      shouldAutoConfirmFolderTrust({
        text: 'Yes, I trust this folder',
        commandLooksClaude: true,
        isResume: true,
        autoTrustEnabled: false,
      }),
    ).toBe(true);
  });

  it('FRESH + toggle OFF + trust prompt → does NOT confirm (unchanged)', () => {
    expect(
      shouldAutoConfirmFolderTrust({
        text: TRUST_TEXT,
        commandLooksClaude: true,
        isResume: false,
        autoTrustEnabled: false,
      }),
    ).toBe(false);
  });

  it('FRESH + toggle ON + trust prompt → confirms', () => {
    expect(
      shouldAutoConfirmFolderTrust({
        text: TRUST_TEXT,
        commandLooksClaude: true,
        isResume: false,
        autoTrustEnabled: true,
      }),
    ).toBe(true);
  });

  it('safety: destructive-looking output is NEVER auto-confirmed, even on resume', () => {
    expect(
      shouldAutoConfirmFolderTrust({
        text: 'Do you trust this action? It will DELETE credentials and drop the database',
        commandLooksClaude: true,
        isResume: true,
        autoTrustEnabled: true,
      }),
    ).toBe(false);
  });

  it('non-Claude command → never', () => {
    expect(
      shouldAutoConfirmFolderTrust({
        text: TRUST_TEXT,
        commandLooksClaude: false,
        isResume: true,
        autoTrustEnabled: true,
      }),
    ).toBe(false);
  });

  it('no trust prompt in the output → does not confirm', () => {
    expect(
      shouldAutoConfirmFolderTrust({
        text: '● Running the build…\n⎿ done',
        commandLooksClaude: true,
        isResume: true,
        autoTrustEnabled: true,
      }),
    ).toBe(false);
  });
});
