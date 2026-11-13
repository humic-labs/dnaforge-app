import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WORKSPACE_FILE_RELOCATED_EVENT } from '../../../shared/workspace-relocate-types';
import {
  bumpReferenceGeneration,
  getReferenceGeneration,
  startReferenceInvalidationListeners,
  subscribeToReferenceGeneration,
} from './reference-generation';

describe('reference generation store', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    stop = startReferenceInvalidationListeners();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it('returns a referentially stable snapshot when nothing changed', () => {
    const first = getReferenceGeneration();
    const second = getReferenceGeneration();

    expect(first).toEqual(expect.any(Number));
    expect(first).toBe(second);
  });

  it('notifies subscribers and advances the generation on a file relocate', () => {
    const listener = vi.fn();
    subscribeToReferenceGeneration(listener);
    const before = getReferenceGeneration();

    window.dispatchEvent(new CustomEvent(WORKSPACE_FILE_RELOCATED_EVENT, { detail: {} }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getReferenceGeneration()).toBeGreaterThan(before);
  });

  it('notifies subscribers and advances the generation on workspace-files-changed', () => {
    const listener = vi.fn();
    subscribeToReferenceGeneration(listener);
    const before = getReferenceGeneration();

    window.dispatchEvent(new CustomEvent('waypoint:workspace-files-changed'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getReferenceGeneration()).toBeGreaterThan(before);
  });

  it('is monotonic across many invalidations', () => {
    const seen: number[] = [getReferenceGeneration()];

    for (let index = 0; index < 5; index += 1) {
      bumpReferenceGeneration();
      seen.push(getReferenceGeneration());
    }

    const sorted = [...seen].sort((a, b) => a - b);
    expect(seen).toEqual(sorted);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToReferenceGeneration(listener);

    bumpReferenceGeneration();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    bumpReferenceGeneration();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('detaches the window listeners when the invalidation source is stopped', () => {
    const listener = vi.fn();
    subscribeToReferenceGeneration(listener);

    stop?.();
    stop = undefined;

    window.dispatchEvent(new CustomEvent(WORKSPACE_FILE_RELOCATED_EVENT, { detail: {} }));

    expect(listener).not.toHaveBeenCalled();
  });

  it('survives a listener that throws without dropping the other subscribers', () => {
    const exploding = vi.fn(() => {
      throw new Error('subscriber blew up');
    });
    const healthy = vi.fn();
    subscribeToReferenceGeneration(exploding);
    subscribeToReferenceGeneration(healthy);

    expect(() => bumpReferenceGeneration()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
