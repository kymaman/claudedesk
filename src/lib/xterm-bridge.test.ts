/**
 * Tests for the xterm bridge — the typed wrapper around the
 * `claudedesk-paste` / `claudedesk-copy` custom-event protocol that links
 * the right-click context menu to xterm's Terminal instance.
 *
 * Uses Node's built-in EventTarget (no jsdom dependency) so the tests run
 * in the same environment as the rest of the unit suite.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  XtermBridgeEvent,
  dispatchXtermPaste,
  listenXtermBridge,
  readXtermSelection,
} from './xterm-bridge';

describe('XtermBridgeEvent constants', () => {
  it('exposes the two expected event names', () => {
    expect(XtermBridgeEvent.Paste).toBe('claudedesk-paste');
    expect(XtermBridgeEvent.Copy).toBe('claudedesk-copy');
  });
});

describe('dispatchXtermPaste + listener', () => {
  it('forwards the paste text to the registered onPaste handler', () => {
    const target = new EventTarget();
    const onPaste = vi.fn();
    listenXtermBridge(target, { onPaste, onCopy: vi.fn() });
    dispatchXtermPaste(target, 'hello\nworld');
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledWith({ text: 'hello\nworld' });
  });
});

describe('readXtermSelection round-trip', () => {
  it('returns whatever the onCopy listener writes into detail.result.text', () => {
    const target = new EventTarget();
    listenXtermBridge(target, {
      onPaste: vi.fn(),
      onCopy: (detail) => {
        detail.result.text = 'selected stuff';
      },
    });
    expect(readXtermSelection(target)).toBe('selected stuff');
  });

  it('returns an empty string when no listener is attached', () => {
    const target = new EventTarget();
    expect(readXtermSelection(target)).toBe('');
  });
});

describe('listenXtermBridge unsubscribe', () => {
  it('removes both listeners when the returned function is called', () => {
    const target = new EventTarget();
    const onPaste = vi.fn();
    const onCopy = vi.fn();
    const off = listenXtermBridge(target, { onPaste, onCopy });
    off();
    dispatchXtermPaste(target, 'after-off');
    void readXtermSelection(target);
    expect(onPaste).not.toHaveBeenCalled();
    expect(onCopy).not.toHaveBeenCalled();
  });
});
