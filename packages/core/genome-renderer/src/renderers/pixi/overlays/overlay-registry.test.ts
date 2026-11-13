import { describe, expect, it } from 'vitest';
import { OverlayRegistry } from './overlay-registry';
import { isRetainedOverlayTrack } from './overlay-track';
import type { OverlayTrack, OverlayPosition, RetainedOverlayTrack } from './overlay-track';
import type { RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';

function makeOverlay(opts: {
  id: string;
  sortOrder: number;
  hitTestOrder?: number;
  position?: OverlayPosition;
}): OverlayTrack {
  return {
    id: opts.id,
    displayName: opts.id,
    position: opts.position ?? 'above',
    sortOrder: opts.sortOrder,
    hitTestOrder: opts.hitTestOrder,
    enabled: true,
    computeHeight: () => 0,
    loadGenome: () => {},
    render: () => {},
    hitTest: () => ({
      kind: 'feature',
      payload: { id: opts.id === 'top' || opts.id === 'first' ? 1 : 2, start: 0, end: 10 },
    }),
    container: {} as OverlayTrack['container'],
    destroy: () => {},
  };
}

function expectFeaturePayloadId(
  result: ReturnType<OverlayRegistry['hitTestAll']>,
  expectedId: number
): void {
  expect(result?.kind).toBe('feature');
  if (result?.kind !== 'feature') {
    throw new Error(`Expected feature hit target, received ${result?.kind ?? 'null'}`);
  }
  expect(result.payload.id).toBe(expectedId);
}

describe('OverlayRegistry hit testing', () => {
  it('fails layout reuse closed unless every enabled overlay defines a semantic key', () => {
    const registry = new OverlayRegistry();
    const state = {} as RenderState;
    const genome = { name: 'layout-cache-test', length: 1, circular: false, features: [] };
    registry.register(makeOverlay({ id: 'unknown-layout-dependencies', sortOrder: 1 }));

    expect(registry.captureLayoutCacheKeys(genome, state, 0.001)).toBeNull();
    expect(registry.layoutCacheKeysMatch([], genome, state, 0.001)).toBe(false);
  });

  it('invalidates semantic layout keys when registry structure changes', () => {
    const registry = new OverlayRegistry();
    const overlay = {
      ...makeOverlay({ id: 'stable-layout', sortOrder: 1 }),
      layoutCacheKey: () => 7,
    };
    const state = {} as RenderState;
    const genome = { name: 'layout-cache-test', length: 1, circular: false, features: [] };

    registry.register(overlay);
    const revision = registry.getLayoutRevision();
    const keys = registry.captureLayoutCacheKeys(genome, state, 0.001);
    expect(keys).toEqual([7]);
    expect(registry.layoutCacheKeysMatch(keys ?? [], genome, state, 0.001)).toBe(true);

    registry.reorder(overlay.id, 2);
    expect(registry.getLayoutRevision()).toBe(revision + 1);
    registry.toggle(overlay.id);
    expect(registry.getLayoutRevision()).toBe(revision + 2);
  });

  it('uses explicit hitTestOrder instead of registration order', () => {
    const registry = new OverlayRegistry();
    registry.register(makeOverlay({ id: 'top', sortOrder: 1, hitTestOrder: 10 }));
    registry.register(makeOverlay({ id: 'bottom', sortOrder: 999, hitTestOrder: 1 }));

    const result = registry.hitTestAll(0, 0, {} as PathMapper, {} as RenderState);

    expectFeaturePayloadId(result, 1);
  });

  it('falls back to sortOrder and then reverse registration order', () => {
    const registry = new OverlayRegistry();
    registry.register(makeOverlay({ id: 'first', sortOrder: 100 }));
    registry.register(makeOverlay({ id: 'second', sortOrder: 100 }));

    const result = registry.hitTestAll(0, 0, {} as PathMapper, {} as RenderState);

    expectFeaturePayloadId(result, 2);
  });

  it('detects overlays that implement the retained rendering contract', () => {
    const immediate = makeOverlay({ id: 'immediate', sortOrder: 1 });
    const retained: RetainedOverlayTrack = {
      ...makeOverlay({ id: 'retained', sortOrder: 1 }),
      getRetainedDebugSnapshot: () => ({
        id: 'retained',
        supported: true,
        enabled: true,
        mode: 'retained',
        dataBuilds: 1,
        cameraUpdates: 2,
        interactionUpdates: 3,
        fallbackRenders: 0,
        lastFallbackReason: null,
        retainedInstanceCount: 4,
        visibleInstanceCount: 4,
      }),
    };

    expect(isRetainedOverlayTrack(immediate)).toBe(false);
    expect(isRetainedOverlayTrack(retained)).toBe(true);
  });

  it('collects retained overlay debug snapshots without inspecting overlay internals', () => {
    const registry = new OverlayRegistry();
    const retained: RetainedOverlayTrack = {
      ...makeOverlay({ id: 'retained', sortOrder: 1 }),
      getRetainedDebugSnapshot: () => ({
        id: 'retained',
        supported: true,
        enabled: true,
        mode: 'fallback',
        dataBuilds: 1,
        cameraUpdates: 2,
        interactionUpdates: 0,
        fallbackRenders: 3,
        lastFallbackReason: 'unsupported-visual-state',
        retainedInstanceCount: 4,
        visibleInstanceCount: 2,
      }),
    };
    registry.register(makeOverlay({ id: 'immediate', sortOrder: 1 }));
    registry.register(retained);

    expect(registry.getRetainedDebugSnapshots()).toEqual([
      {
        id: 'retained',
        supported: true,
        enabled: true,
        mode: 'fallback',
        dataBuilds: 1,
        cameraUpdates: 2,
        interactionUpdates: 0,
        fallbackRenders: 3,
        lastFallbackReason: 'unsupported-visual-state',
        retainedInstanceCount: 4,
        visibleInstanceCount: 2,
      },
    ]);
  });

  it('routes render calls through retained camera updates when available', () => {
    const registry = new OverlayRegistry();
    const renderCalls: Array<[number, number]> = [];
    const interactionStates: RenderState[] = [];
    const retained: RetainedOverlayTrack = {
      ...makeOverlay({ id: 'retained', sortOrder: 1 }),
      render: (_path, _state, yOffset, height) => renderCalls.push([yOffset, height]),
      updateRetainedCamera: ({ yOffset, height }) => {
        expect(yOffset).toBe(12);
        expect(height).toBe(34);
        return true;
      },
      updateRetainedInteraction: (state) => interactionStates.push(state),
    };
    registry.register(retained);

    const state = {} as RenderState;
    const mode = registry.renderOverlay(retained, {} as PathMapper, state, 12, 34);

    expect(mode).toBe('retained');
    expect(renderCalls).toEqual([]);
    expect(interactionStates).toEqual([state]);
  });

  it('falls back to immediate render when retained camera update declines the frame', () => {
    const registry = new OverlayRegistry();
    const renderCalls: Array<[number, number]> = [];
    const retained: RetainedOverlayTrack = {
      ...makeOverlay({ id: 'retained', sortOrder: 1 }),
      render: (_path, _state, yOffset, height) => renderCalls.push([yOffset, height]),
      updateRetainedCamera: () => false,
      updateRetainedInteraction: () => {
        throw new Error('interaction updates should only run for retained frames');
      },
    };
    registry.register(retained);

    const mode = registry.renderOverlay(retained, {} as PathMapper, {} as RenderState, 5, 8);

    expect(mode).toBe('fallback');
    expect(renderCalls).toEqual([[5, 8]]);
  });

  it('skips disabled overlays before retained or immediate rendering', () => {
    const registry = new OverlayRegistry();
    const retained: RetainedOverlayTrack = {
      ...makeOverlay({ id: 'retained', sortOrder: 1 }),
      enabled: false,
      render: () => {
        throw new Error('disabled overlay should not render');
      },
      updateRetainedCamera: () => {
        throw new Error('disabled overlay should not update retained camera');
      },
    };
    registry.register(retained);

    const mode = registry.renderOverlay(retained, {} as PathMapper, {} as RenderState, 0, 0);

    expect(mode).toBe('inactive');
  });
});
