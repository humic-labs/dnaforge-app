import { describe, expect, it, vi } from 'vitest';

import { createStreamProjectionCoalescer } from './stream-projection-coalescer';

function harness() {
  let frame: (() => void) | undefined;
  let fallback: (() => void) | undefined;
  const commit = vi.fn();
  const cancelFrame = vi.fn();
  const cancelFallback = vi.fn();
  const coalescer = createStreamProjectionCoalescer<string>({
    commit,
    requestFrame: (callback) => {
      frame = callback;
      return 11;
    },
    cancelFrame,
    scheduleFallback: (callback) => {
      fallback = callback;
      return 22;
    },
    cancelFallback,
  });
  return {
    coalescer,
    commit,
    cancelFrame,
    cancelFallback,
    fireFrame: () => frame?.(),
    fireFallback: () => fallback?.(),
  };
}

describe('stream projection coalescer', () => {
  it('commits only the latest provider snapshot once per display frame', () => {
    const subject = harness();
    subject.coalescer.push('a');
    subject.coalescer.push('ab');
    subject.coalescer.push('abc');

    expect(subject.commit).not.toHaveBeenCalled();
    subject.fireFrame();

    expect(subject.commit).toHaveBeenCalledTimes(1);
    expect(subject.commit).toHaveBeenCalledWith('abc');
    expect(subject.cancelFallback).toHaveBeenCalledWith(22);
  });

  it('uses the fallback scheduler when animation frames are throttled', () => {
    const subject = harness();
    subject.coalescer.push('hidden pane');

    subject.fireFallback();

    expect(subject.commit).toHaveBeenCalledWith('hidden pane');
    expect(subject.cancelFrame).toHaveBeenCalledWith(11);
  });

  it('flushes the latest snapshot synchronously at a stream boundary', () => {
    const subject = harness();
    subject.coalescer.push('before tool');

    subject.coalescer.flush();

    expect(subject.commit).toHaveBeenCalledWith('before tool');
    expect(subject.cancelFrame).toHaveBeenCalledWith(11);
    expect(subject.cancelFallback).toHaveBeenCalledWith(22);
    subject.fireFrame();
    subject.fireFallback();
    expect(subject.commit).toHaveBeenCalledTimes(1);
  });
});
