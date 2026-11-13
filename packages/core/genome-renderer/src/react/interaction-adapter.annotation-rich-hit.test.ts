// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { FeatureHitPayload, Genome, RenderState } from '@waypoint/genome-renderer';
import { attachPixiInteractionAdapter } from './interaction-adapter';
import type { UsePixiMapOptions } from './types';
import { PrimerOverlay } from '../renderers/pixi/overlays/primer-overlay';

function makeState(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 220,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

const genome: Genome = {
  name: 'full-assembly-direct-cache',
  length: 3_088_269_832,
  circular: false,
  features: [],
};

const hit: FeatureHitPayload = {
  id: 17,
  start: 1_544_000_000,
  end: 1_544_010_000,
  canonicalIdentity: '["annotation.v2","grch38","rna-TX41"]',
  displayName: 'TX41',
  type: 'mRNA',
  transcriptId: 'NM_TX41.1',
  sourceId: 'rna-TX41',
  lane: 4,
  direction: 'forward',
};

describe('attachPixiInteractionAdapter rich annotation bridge', () => {
  it('converts intron hover to renderer coordinates without adding a click target', () => {
    const canvasEl = document.createElement('canvas');
    canvasEl.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 110 }) as DOMRect;
    const hitTestIntron = vi.fn(() => ({ id: 7, start: 450, end: 250 }));
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: makeState() },
      optionsRef: { current: { genome, circular: false, width: 800, height: 220 } },
      renderer: {
        getOverlayRegistry: () => null,
        getCurrentPathMapper: () => null,
        hitTestIntron,
      } as never,
      activeGenome: genome,
      circular: false,
    });
    expect(interaction.hitTestHoverFeatureFn?.(210, 75)).toEqual({ id: 7, start: 450, end: 250 });
    expect(hitTestIntron).toHaveBeenCalledWith(400, 110);
    expect(interaction.hitTestFn?.(210, 75)).toBeNull();
    expect(hitTestIntron).toHaveBeenCalledOnce();
    interaction.cleanup();
  });

  it('inspects only the primer overlay beneath a selection handle in renderer coordinates', () => {
    const canvasEl = document.createElement('canvas');
    canvasEl.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 110 }) as DOMRect;
    const state = makeState();
    const path = {};
    const primerHit = { kind: 'feature', payload: { id: 1_000_000_000, start: 100, end: 142 } };
    const hitTest = vi.fn(() => primerHit);
    const hitTestAll = vi.fn();
    const get = vi.fn(() => ({ hitTest }));
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: state },
      optionsRef: { current: { genome, circular: false, width: 800, height: 220 } },
      renderer: {
        getOverlayRegistry: () => ({ get, hitTestAll }),
        getCurrentPathMapper: () => path,
      } as never,
      activeGenome: genome,
      circular: false,
    });
    const probe = interaction.hitTestPrimerFn;
    expect(probe?.(210, 75)).toEqual(primerHit);
    expect(get).toHaveBeenCalledWith('primers');
    expect(hitTest).toHaveBeenCalledWith(400, 110, path, state);
    expect(hitTestAll).not.toHaveBeenCalled();
    interaction.cleanup();
  });

  it('publishes the exact pre-zoom pointer anchor with the committed camera', () => {
    const canvasEl = document.createElement('canvas');
    canvasEl.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 110 }) as DOMRect;
    document.body.appendChild(canvasEl);
    const state = makeState();
    const onCameraChange = vi.fn();
    const adjustViewOffsetForZoom = vi.fn();
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: state },
      optionsRef: {
        current: {
          genome,
          circular: false,
          width: 800,
          height: 220,
          onCameraChange,
        } satisfies UsePixiMapOptions,
      },
      renderer: {
        screenToBp: (x: number) => 1_000_000_000 + x,
        getViewCenterBp: () => 1_500_000_000,
        adjustViewOffsetForZoom,
        getOverlayRegistry: () => null,
        getCurrentPathMapper: () => null,
      } as never,
      activeGenome: genome,
      circular: false,
    });

    interaction.onBeforeZoom?.(1, 2, 210, 75);
    state.zoom = 2;
    interaction.onCameraChange?.('zoom');

    expect(adjustViewOffsetForZoom).toHaveBeenCalledOnce();
    expect(onCameraChange).toHaveBeenCalledWith(
      1_500_000_000,
      'zoom',
      2,
      { start: 727_932_542, end: 2_272_067_458 },
      { zoomAnchorBp: 1_000_000_400 }
    );
    interaction.cleanup();
  });

  it('carries the current base under same-feature hover without repeating cross-surface identity writes', () => {
    const canvasEl = document.createElement('canvas');
    canvasEl.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 110 }) as DOMRect;
    const onHoverChange = vi.fn();
    const onFeatureHover = vi.fn();
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: makeState() },
      optionsRef: {
        current: {
          genome,
          circular: false,
          width: 800,
          height: 220,
          onHoverChange,
          onFeatureHover,
        },
      },
      renderer: {
        screenToBp: (x: number) => Math.floor(x),
        getOverlayRegistry: () => null,
        getCurrentPathMapper: () => null,
      } as never,
      activeGenome: genome,
      circular: false,
    });
    interaction.onHoverFeature?.(hit, 20, 30);
    interaction.onHoverFeature?.(hit, 30, 30);
    expect(onHoverChange).toHaveBeenNthCalledWith(1, {
      ...hit,
      position: 20,
      screenX: 20,
      screenY: 20,
    });
    expect(onHoverChange).toHaveBeenNthCalledWith(2, {
      ...hit,
      position: 40,
      screenX: 40,
      screenY: 20,
    });
    expect(onFeatureHover).toHaveBeenCalledExactlyOnceWith(hit.id);
    interaction.onHoverFeature?.(null, 30, 30);
    expect(onFeatureHover).toHaveBeenLastCalledWith(null);
    interaction.cleanup();
  });

  it('preserves exact cache-sidecar identity through hover, click, and range commit', () => {
    const canvasEl = document.createElement('canvas');
    canvasEl.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 110 }) as DOMRect;
    document.body.appendChild(canvasEl);
    const onHoverChange = vi.fn();
    const onFeatureHitClick = vi.fn();
    const onFeatureRangeHitCommit = vi.fn();
    const optionsRef = {
      current: {
        genome,
        circular: false,
        width: 800,
        height: 220,
        onHoverChange,
        onFeatureHitClick,
        onFeatureRangeHitCommit,
      } satisfies UsePixiMapOptions,
    };
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: makeState() },
      optionsRef,
      renderer: {
        screenToBp: () => hit.start,
        getOverlayRegistry: () => null,
        getCurrentPathMapper: () => null,
      } as never,
      activeGenome: genome,
      circular: false,
    });

    interaction.onHoverFeature?.(hit, 210, 75);
    interaction.onFeatureClick?.(hit);
    interaction.onFeatureRangeCommit?.(hit);

    expect(onHoverChange).toHaveBeenCalledWith({
      ...hit,
      position: hit.start,
      screenX: 400,
      screenY: 110,
    });
    expect(onFeatureHitClick).toHaveBeenCalledWith(hit);
    expect(onFeatureRangeHitCommit).toHaveBeenCalledWith(hit);
    interaction.cleanup();
  });

  it('clears an incompatible backbone-part target while preserving generic preview behavior', () => {
    const canvasEl = document.createElement('canvas');
    const state = makeState();
    const setBackbonePartInsertionPreview = vi.fn(() => true);
    const clearBackbonePartInsertionPreview = vi.fn();
    const invalidateRender = vi.fn();
    const optionsRef: { current: UsePixiMapOptions } = {
      current: {
        genome,
        circular: false,
        width: 800,
        height: 220,
        onBackbonePartDragPreview: () => null,
      },
    };
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: state },
      optionsRef,
      renderer: {
        screenToBp: () => 120,
        getOverlayRegistry: () => null,
        getCurrentPathMapper: () => null,
        setBackbonePartInsertionPreview,
        clearBackbonePartInsertionPreview,
      } as never,
      activeGenome: genome,
      circular: false,
      invalidateRender,
    });
    const part = { regionId: 'part-a', rangeStart: 0, rangeEnd: 100 };

    expect(interaction.canDragBackbonePart?.()).toBe(false);
    interaction.onBackbonePartDragPreview?.(part, 120);
    expect(clearBackbonePartInsertionPreview).toHaveBeenCalledOnce();
    expect(setBackbonePartInsertionPreview).not.toHaveBeenCalled();
    expect(invalidateRender).toHaveBeenCalledOnce();

    clearBackbonePartInsertionPreview.mockClear();
    invalidateRender.mockClear();
    optionsRef.current = {
      genome,
      circular: false,
      width: 800,
      height: 220,
    };
    expect(interaction.canDragBackbonePart?.()).toBe(false);
    interaction.onBackbonePartDragPreview?.(part, 120);
    expect(clearBackbonePartInsertionPreview).not.toHaveBeenCalled();
    expect(setBackbonePartInsertionPreview).toHaveBeenCalledWith(part, 120, null);

    optionsRef.current = {
      genome,
      circular: false,
      width: 800,
      height: 220,
      onBackbonePartDragPreview: () => null,
      onBackbonePartDragCommit: () => undefined,
    };
    expect(interaction.canDragBackbonePart?.()).toBe(true);
    interaction.cleanup();
  });

  it('gives an editable primer grip priority over overlapping assembly-map surfaces', () => {
    const canvasEl = document.createElement('canvas');
    canvasEl.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 400, height: 110 }) as DOMRect;
    const state = makeState();
    const primerHandleHit = {
      kind: 'primer-handle' as const,
      payload: { id: 91, direction: 'reverse' as const },
    };
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: state },
      optionsRef: {
        current: {
          genome,
          circular: false,
          width: 800,
          height: 220,
        } satisfies UsePixiMapOptions,
      },
      renderer: {
        screenToBp: () => 40,
        getOverlayRegistry: () => ({
          get: (id: string) => (id === 'primers' ? { hitTest: () => primerHandleHit } : undefined),
          hitTestAll: () => ({
            kind: 'feature' as const,
            payload: { id: 7, start: 0, end: 100 },
          }),
        }),
        getCurrentPathMapper: () => ({}),
        hitTestBackbonePart: () => ({
          kind: 'backbone-part' as const,
          payload: { regionId: 'part-a', rangeStart: 0, rangeEnd: 100 },
        }),
      } as never,
      activeGenome: genome,
      circular: false,
    });

    expect(interaction.hitTestFn?.(210, 75)).toEqual(primerHandleHit);
    interaction.cleanup();
  });

  it('clears renderer-owned primer preview state before forwarding drag completion', () => {
    const canvasEl = document.createElement('canvas');
    const primerOverlay = new PrimerOverlay();
    const primerGenome: Genome = {
      name: 'primer-preview-commit',
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: 'primer-forward',
          renderId: 1_000_000_013,
          name: 'forward primer',
          start: 20,
          end: 40,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(20),
          editablePbsEndpoint: true,
        },
      ],
      sequence: 'A'.repeat(100),
    };
    primerOverlay.loadGenome(primerGenome);
    expect(primerOverlay.setPbsEndpointPreview(1_000_000_013, 47)).toBe(true);
    const clearPreview = vi.spyOn(primerOverlay, 'clearPbsEndpointPreview');
    const invalidateRender = vi.fn();
    const onCommit = vi.fn();
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: makeState() },
      optionsRef: {
        current: {
          genome: primerGenome,
          circular: false,
          width: 800,
          height: 220,
          onPrimerHandleDragCommit: onCommit,
        } satisfies UsePixiMapOptions,
      },
      renderer: {
        screenToBp: () => 47,
        getOverlayRegistry: () => ({ get: () => primerOverlay }),
        getCurrentPathMapper: () => null,
      } as never,
      activeGenome: primerGenome,
      circular: false,
      invalidateRender,
    });
    const handle = {
      id: 1_000_000_013,
      primerId: 'primer-forward',
      start: 20,
      end: 40,
      direction: 'forward' as const,
      overhangLength: 0,
      anchorBp: 40,
    };

    interaction.onPrimerHandleDragCommit?.(handle, 47);

    expect(clearPreview).toHaveBeenCalledWith(handle.id);
    expect(invalidateRender).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(handle, 47);
    interaction.cleanup();
    primerOverlay.destroy();
  });

  it('renders the host-projected primer preview instead of a competing raw endpoint', () => {
    const canvasEl = document.createElement('canvas');
    const primerOverlay = new PrimerOverlay();
    const primerGenome: Genome = {
      name: 'primer-preview-projection',
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: 'primer-forward',
          renderId: 1_000_000_014,
          name: 'forward primer',
          start: 20,
          end: 40,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(20),
          editablePbsEndpoint: true,
        },
      ],
      sequence: 'A'.repeat(100),
    };
    primerOverlay.loadGenome(primerGenome);
    const setPreview = vi.spyOn(primerOverlay, 'setPbsEndpointPreview');
    const invalidateRender = vi.fn();
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: makeState() },
      optionsRef: {
        current: {
          genome: primerGenome,
          circular: false,
          width: 800,
          height: 220,
          onPrimerHandleDragPreview: () => ({
            boundaryBp: 44,
            bases: 'A'.repeat(24),
            tm: 61,
            gc: 50,
          }),
        } satisfies UsePixiMapOptions,
      },
      renderer: {
        screenToBp: () => 47,
        getOverlayRegistry: () => ({ get: () => primerOverlay }),
        getCurrentPathMapper: () => null,
      } as never,
      activeGenome: primerGenome,
      circular: false,
      invalidateRender,
    });
    const handle = {
      id: 1_000_000_014,
      primerId: 'primer-forward',
      start: 20,
      end: 40,
      direction: 'forward' as const,
      overhangLength: 0,
      anchorBp: 40,
    };

    interaction.onPrimerHandleDragPreview?.(handle, 47);

    expect(setPreview).toHaveBeenCalledOnce();
    expect(setPreview).toHaveBeenCalledWith(handle.id, {
      boundaryBp: 44,
      bases: 'A'.repeat(24),
      tm: 61,
      gc: 50,
    });
    expect(invalidateRender).toHaveBeenCalledOnce();
    interaction.cleanup();
    primerOverlay.destroy();
  });
});
