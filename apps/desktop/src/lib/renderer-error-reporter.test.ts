// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installRendererErrorReporter } from './renderer-error-reporter';

class FakeWindow extends EventTarget {
  electronAPI = { reportRendererError: vi.fn() };
}

function dispatchError(target: EventTarget, error: unknown): void {
  const ev = new Event('error') as ErrorEvent;
  (ev as { error?: unknown }).error = error;
  target.dispatchEvent(ev);
}

function dispatchRejection(target: EventTarget, reason: unknown): void {
  const ev = new Event('unhandledrejection');
  (ev as { reason?: unknown }).reason = reason;
  target.dispatchEvent(ev);
}

describe('renderer-error-reporter  item 3)', () => {
  let win: FakeWindow;
  let teardown: () => void;

  beforeEach(() => {
    win = new FakeWindow();
    teardown = installRendererErrorReporter(win as unknown as Window);
  });

  it('forwards an uncaught error CLASS (never the message) to the phone-home bridge', () => {
    dispatchError(win, new TypeError('secret-message-should-not-leak'));

    expect(win.electronAPI.reportRendererError).toHaveBeenCalledWith({
      errorClass: 'TypeError',
      source: 'error',
    });
    expect(JSON.stringify(win.electronAPI.reportRendererError.mock.calls)).not.toContain(
      'secret-message-should-not-leak'
    );
    teardown();
  });

  it('forwards an unhandled rejection class', () => {
    dispatchRejection(win, new RangeError('bad'));
    expect(win.electronAPI.reportRendererError).toHaveBeenCalledWith({
      errorClass: 'RangeError',
      source: 'unhandledrejection',
    });
    teardown();
  });

  it('dedupes repeated errors of the same class within a session', () => {
    dispatchError(win, new TypeError('a'));
    dispatchError(win, new TypeError('b'));
    dispatchError(win, new TypeError('c'));
    expect(win.electronAPI.reportRendererError).toHaveBeenCalledTimes(1);
    teardown();
  });

  it('stops sending after teardown', () => {
    teardown();
    dispatchError(win, new TypeError('a'));
    expect(win.electronAPI.reportRendererError).not.toHaveBeenCalled();
  });
});
