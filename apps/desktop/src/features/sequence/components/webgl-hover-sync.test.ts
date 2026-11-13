// @vitest-environment node

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { PlasmidFeature } from '@waypoint/plasmid-viewer';
import type { HoveredAnnotationKey } from '@waypoint/workspace-editor';
import {
  buildHoveredAnnotationFeatureIndex,
  createDeferredWebGLHoverSync,
  hoveredAnnotationKeyFromFeature,
  resolveHoveredFeatureId,
} from './webgl-hover-sync';

const featureA: PlasmidFeature = {
  type: 'CDS',
  displayName: 'mioC',
  start: 100,
  end: 400,
  direction: 'forward',
  qualifiers: {},
  color: '#3b82f6',
};

const featureB: PlasmidFeature = {
  type: 'gene',
  displayName: 'thrL',
  start: 500,
  end: 650,
  direction: 'reverse',
  qualifiers: {},
  color: '#22c55e',
};

function createStore(initial: HoveredAnnotationKey | null = null) {
  let current = initial;
  const set = vi.fn((next: HoveredAnnotationKey | null) => {
    current = next;
  });
  return {
    getSnapshot: () => current,
    set,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WebGL hover sync helpers', () => {
  it('resolves hovered annotation identity to a WebGL feature id through an index', () => {
    const index = buildHoveredAnnotationFeatureIndex([featureA, featureB]);

    expect(resolveHoveredFeatureId(index, hoveredAnnotationKeyFromFeature(featureB))).toBe(1);
    expect(
      resolveHoveredFeatureId(index, {
        ...hoveredAnnotationKeyFromFeature(featureB),
        name: 'missing',
      })
    ).toBeNull();
  });

  it('defers WebGL hover store writes so local tooltip rendering is not blocked', () => {
    vi.useFakeTimers();
    const store = createStore();
    const sync = createDeferredWebGLHoverSync(store, { delayMs: 25 });
    const key = hoveredAnnotationKeyFromFeature(featureA);

    sync.schedule(key);

    expect(store.set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(store.set).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual(key);
  });

  it('coalesces rapid WebGL hover transitions to the latest feature', () => {
    vi.useFakeTimers();
    const store = createStore();
    const sync = createDeferredWebGLHoverSync(store, { delayMs: 25 });
    const keyA = hoveredAnnotationKeyFromFeature(featureA);
    const keyB = hoveredAnnotationKeyFromFeature(featureB);

    sync.schedule(keyA);
    vi.advanceTimersByTime(10);
    sync.schedule(keyB);
    vi.advanceTimersByTime(25);

    expect(store.set).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual(keyB);
  });

  it('does not let a stale delayed WebGL hover clobber another surface hover', () => {
    vi.useFakeTimers();
    const store = createStore();
    const sync = createDeferredWebGLHoverSync(store, { delayMs: 25 });
    const keyA = hoveredAnnotationKeyFromFeature(featureA);
    const canvasKey = hoveredAnnotationKeyFromFeature(featureB);

    sync.schedule(keyA);
    store.set(canvasKey);
    vi.advanceTimersByTime(25);

    expect(store.getSnapshot()).toEqual(canvasKey);
  });

  it('does not let a delayed WebGL clear remove another surface hover', () => {
    vi.useFakeTimers();
    const store = createStore();
    const sync = createDeferredWebGLHoverSync(store, { delayMs: 25 });
    const keyA = hoveredAnnotationKeyFromFeature(featureA);
    const canvasKey = hoveredAnnotationKeyFromFeature(featureB);

    sync.schedule(keyA);
    vi.advanceTimersByTime(25);
    expect(store.getSnapshot()).toEqual(keyA);

    sync.schedule(null);
    store.set(canvasKey);
    vi.advanceTimersByTime(25);

    expect(store.getSnapshot()).toEqual(canvasKey);
  });
});
