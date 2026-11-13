// @vitest-environment node

import { Mapping, StepMap } from '@tiptap/pm/transform';
import { describe, expect, it } from 'vitest';

import { createInsertionRangeTracker } from './insertion-range-tracker';

function typedAt(pos: number, count: number): Mapping {
  const mapping = new Mapping();
  mapping.appendMap(new StepMap([pos, 0, count]));
  return mapping;
}

function deletedRange(from: number, to: number): Mapping {
  const mapping = new Mapping();
  mapping.appendMap(new StepMap([from, to - from, 0]));
  return mapping;
}

describe('insertion range tracker', () => {
  it('returns the original position when nothing changed', () => {
    const tracker = createInsertionRangeTracker();
    const token = tracker.capture(10);

    expect(tracker.resolve(token)).toEqual({ ok: true, pos: 10 });
  });

  it('remaps forward when the user types BEFORE the captured position', () => {
    const tracker = createInsertionRangeTracker();
    const token = tracker.capture(10);

    tracker.onTransaction(typedAt(2, 5));

    expect(tracker.resolve(token)).toEqual({ ok: true, pos: 15 });
  });

  it('leaves the position alone when the user types AFTER it', () => {
    const tracker = createInsertionRangeTracker();
    const token = tracker.capture(10);

    tracker.onTransaction(typedAt(40, 5));

    expect(tracker.resolve(token)).toEqual({ ok: true, pos: 10 });
  });

  it('accumulates across several transactions', () => {
    const tracker = createInsertionRangeTracker();
    const token = tracker.capture(10);

    tracker.onTransaction(typedAt(0, 3));
    tracker.onTransaction(typedAt(0, 4));

    expect(tracker.resolve(token)).toEqual({ ok: true, pos: 17 });
  });

  it('aborts when the captured position was deleted out from under it', () => {
    const tracker = createInsertionRangeTracker();
    const token = tracker.capture(10);

    tracker.onTransaction(deletedRange(5, 20));

    expect(tracker.resolve(token)).toEqual({ ok: false, reason: 'range-deleted' });
  });

  it('tracks several in-flight captures independently', () => {
    const tracker = createInsertionRangeTracker();
    const first = tracker.capture(10);

    tracker.onTransaction(typedAt(0, 5));
    const second = tracker.capture(30);
    tracker.onTransaction(typedAt(0, 2));

    expect(tracker.resolve(first)).toEqual({ ok: true, pos: 17 });
    expect(tracker.resolve(second)).toEqual({ ok: true, pos: 32 });
  });

  it('stops accumulating once a token is released', () => {
    const tracker = createInsertionRangeTracker();
    const token = tracker.capture(10);
    tracker.release(token);

    tracker.onTransaction(typedAt(0, 5));

    expect(tracker.resolve(token)).toEqual({ ok: false, reason: 'unknown-token' });
  });

  it('does not leak mappings for released tokens', () => {
    const tracker = createInsertionRangeTracker();
    for (let index = 0; index < 50; index += 1) {
      tracker.release(tracker.capture(index));
    }

    expect(tracker.inFlightCount()).toBe(0);
  });

  it('reports how many captures are awaiting resolution', () => {
    const tracker = createInsertionRangeTracker();
    const first = tracker.capture(1);
    tracker.capture(2);

    expect(tracker.inFlightCount()).toBe(2);
    tracker.release(first);
    expect(tracker.inFlightCount()).toBe(1);
  });
});
