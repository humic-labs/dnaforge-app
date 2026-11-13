/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isGitReadTabCloseAbortReason } from '../../shared/git-read-ipc';
import {
  consumeSequenceTabCloseGesture,
  recordSequenceTabCloseGesture,
  registerSequenceTabCloseAbortController,
  SEQUENCE_TAB_CLOSE_COMMITTED_EVENT,
  type SequenceTabCloseCommittedDetail,
} from '../../shared/tab-close-gesture';

describe('sequence tab close gesture correlation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a valid one-shot close reason for the exact tab', () => {
    const committed = vi.fn<(event: Event) => void>();
    window.addEventListener(SEQUENCE_TAB_CLOSE_COMMITTED_EVENT, committed);
    const reason = recordSequenceTabCloseGesture('sequence-tab-a');

    expect(isGitReadTabCloseAbortReason(reason)).toBe(true);
    expect(committed).toHaveBeenCalledOnce();
    const event = committed.mock.calls[0]?.[0] as CustomEvent<SequenceTabCloseCommittedDetail>;
    expect(event.detail).toEqual({
      tabId: 'sequence-tab-a',
      closeGestureToken: reason.closeGestureToken,
      activeAbortControllerCount: 0,
    });
    expect(consumeSequenceTabCloseGesture('sequence-tab-b')).toBeUndefined();
    expect(consumeSequenceTabCloseGesture('sequence-tab-a')).toEqual(reason);
    expect(consumeSequenceTabCloseGesture('sequence-tab-a')).toBeUndefined();
    window.removeEventListener(SEQUENCE_TAB_CLOSE_COMMITTED_EVENT, committed);
  });

  it('aborts every active request for the exact tab at the committed close boundary', () => {
    const first = new AbortController();
    const second = new AbortController();
    const unrelated = new AbortController();
    const releaseFirst = registerSequenceTabCloseAbortController('sequence-tab-a', first);
    const releaseSecond = registerSequenceTabCloseAbortController('sequence-tab-a', second);
    const releaseUnrelated = registerSequenceTabCloseAbortController('sequence-tab-b', unrelated);

    const reason = recordSequenceTabCloseGesture('sequence-tab-a');

    expect(first.signal.reason).toEqual(reason);
    expect(second.signal.reason).toEqual(reason);
    expect(unrelated.signal.aborted).toBe(false);

    releaseFirst();
    releaseSecond();
    releaseUnrelated();
    consumeSequenceTabCloseGesture('sequence-tab-a');
  });

  it('expires an unconsumed close reason without retaining a timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T00:00:00.000Z'));
    recordSequenceTabCloseGesture('expired-tab');

    vi.setSystemTime(new Date('2026-08-29T00:00:05.001Z'));
    expect(consumeSequenceTabCloseGesture('expired-tab')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('evicts the oldest entry when more than 32 close gestures remain unconsumed', () => {
    for (let index = 0; index < 33; index += 1) {
      recordSequenceTabCloseGesture(`bounded-tab-${index}`);
    }

    expect(consumeSequenceTabCloseGesture('bounded-tab-0')).toBeUndefined();
    for (let index = 1; index < 33; index += 1) {
      expect(consumeSequenceTabCloseGesture(`bounded-tab-${index}`)).toBeDefined();
    }
  });
});
