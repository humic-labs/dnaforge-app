// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Feature, Genome } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP } from './annotation-lod-policy';
import { applyAnnotationGenome } from './indexed-annotation-genome-ingress';
import {
  featureOffset,
  getFeatureRenderOffset,
  setOverlayLayout,
} from './indexed-annotation-layout';
import { featuresInRange, hasFeaturesInRange } from './indexed-annotation-features-in-range';
import { AnnotationLayoutState } from './indexed-annotation-layout-state';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'gene',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'gene',
    ...overrides,
  };
}

function layout(): UnifiedLayout {
  return {
    annotationOffset: -42,
    annotationStep: 16,
    cdsBarOffset: -8,
    cdsLaneStep: 12,
    sequenceRevealProgress: 0,
  } as UnifiedLayout;
}

describe('AnnotationLayoutState', () => {
  it('hands indexed assembly text on at the retained rectangle-to-shape boundary', () => {
    const state = new AnnotationLayoutState();
    state.genomeLength = 3_088_269_832;
    const pathAt = (pixelsPerBp: number, isArcMode = true) =>
      ({
        isArcMode,
        sequenceVisible: false,
        pixelsPerBp,
      }) as PathMapper;

    expect(
      state.shouldRenderFeatureText(pathAt(OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP * 0.999))
    ).toBe(false);
    expect(state.shouldRenderFeatureText(pathAt(OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP))).toBe(
      true
    );
    expect(
      state.shouldRenderFeatureText(pathAt(OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP * 0.999, false))
    ).toBe(true);
  });

  it('holds layout and culls features without constructing IndexedAnnotationOverlay', () => {
    const state = new AnnotationLayoutState();
    const nextLayout = layout();
    setOverlayLayout(state, nextLayout, { maxAnnotationLane: 1, maxCdsLane: 0 });

    expect(state._layout).toBe(nextLayout);
    expect(state._contract).not.toBeNull();
    expect(featureOffset(state, feature({ lane: 0 }))).toBe(-42);
    expect(getFeatureRenderOffset(state, feature({ lane: 2 }))).toBeNull();

    state.commitAnnotationLaneEnvelope(3, 1);
    expect(state.maxAnnotationLane).toBe(3);
    expect(state.maxCdsLane).toBe(1);
    expect(state.maxLane).toBe(3);

    const left = feature({ id: 1, start: 0, end: 10 });
    const overlap = feature({ id: 2, start: 40, end: 60 });
    const startsNearbyButEndsBefore = feature({ id: 3, start: 20, end: 25 });
    const right = feature({ id: 4, start: 90, end: 110 });
    const sorted = [left, startsNearbyButEndsBefore, overlap, right];
    state.features = sorted;
    state.featuresSortedByStart = sorted;
    state.maxFeatureLenBp = 30;
    state.genomeLength = 1000;

    expect(featuresInRange(state, 45, 55).map((next) => next.id)).toEqual([2]);
    expect(hasFeaturesInRange(state, 45, 55)).toBe(true);
    expect(hasFeaturesInRange(state, 200, 220)).toBe(false);
  });

  it('installs genome features and source lanes onto the state object', () => {
    const state = new AnnotationLayoutState();
    const cds = feature({
      id: 9,
      type: 'CDS',
      start: 20,
      end: 50,
      qualifiers: { _lane: '2' },
    });
    const genome: Genome = {
      name: 'chr1',
      sourceIdentity: 'chr1',
      length: 1_000,
      circular: false,
      features: [cds],
      sequenceAvailable: true,
      annotationLayout: { maxAnnotationLane: 3, maxCdsLane: 2 },
    };

    applyAnnotationGenome(state, genome);

    expect(state.features).toEqual([cds]);
    expect(state.genomeLength).toBe(1_000);
    expect(state.genomeCircular).toBe(false);
    expect(cds.lane).toBe(2);
    expect(cds.cdsLane).toBe(2);
    expect(state.sourceMaxAnnotationLane).toBe(3);
    expect(state.sourceMaxCdsLane).toBe(2);
    expect(state.featuresSortedByStart).toEqual([cds]);
    expect(state.longFeatures).toEqual([]);
    expect(state.maxFeatureLenBp).toBe(30);
  });

  it('does not let a chromosome-length feature set the viewport lookback', () => {
    const state = new AnnotationLayoutState();
    const genomeLength = 50_000_000;
    const spanning = feature({ id: 1, type: 'region', start: 0, end: genomeLength });
    const terminal = feature({ id: 2, start: genomeLength - 500, end: genomeLength - 100 });
    const genome: Genome = {
      name: 'chr1',
      sourceIdentity: 'chr1',
      length: genomeLength,
      circular: false,
      features: [spanning, terminal],
      sequenceAvailable: true,
    };

    applyAnnotationGenome(state, genome);

    expect(state.maxFeatureLenBp).toBe(400);
    expect(state.longFeatures.map((item) => item.id)).toEqual([1]);
    expect(state.featuresSortedByStart.map((item) => item.id)).toEqual([2]);
    expect(
      featuresInRange(state, genomeLength - 1_000, genomeLength).map((item) => item.id)
    ).toEqual([1, 2]);
  });

  it('does not keep layout or cull fields as overlay-owned data', () => {
    const overlay = new IndexedAnnotationOverlay();
    const state = overlay.getLayoutStateForTest();

    expect(Object.hasOwn(overlay, '_layout')).toBe(false);
    expect(Object.hasOwn(overlay, '_contract')).toBe(false);
    expect(Object.hasOwn(overlay, 'features')).toBe(false);
    expect(Object.hasOwn(overlay, 'featuresSortedByStart')).toBe(false);
    expect(Object.hasOwn(overlay, 'circularWrappedFeatures')).toBe(false);
    expect(Object.hasOwn(overlay, 'maxFeatureLenBp')).toBe(false);
    expect(Object.hasOwn(overlay, 'genomeLength')).toBe(false);
    expect(Object.hasOwn(overlay, 'genomeCircular')).toBe(false);
    expect(Object.hasOwn(overlay, 'sourceMaxAnnotationLane')).toBe(false);
    expect(Object.hasOwn(overlay, 'sourceMaxCdsLane')).toBe(false);
    expect(Object.hasOwn(overlay, 'currentGenomeIdentity')).toBe(false);
    expect(Object.hasOwn(overlay, 'featureById')).toBe(false);
    expect(Object.hasOwn(overlay, 'featureWindowIndex')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationRequestedLayerTypes')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationPresentationStreams')).toBe(false);
    expect(state).toBeInstanceOf(AnnotationLayoutState);
    expect(Object.hasOwn(state, '_layout')).toBe(true);
    expect(Object.hasOwn(state, 'features')).toBe(true);
    expect(Object.hasOwn(state, 'currentGenomeIdentity')).toBe(true);
    expect(Object.hasOwn(state, 'featureById')).toBe(true);
    expect(Object.hasOwn(state, 'featureWindowIndex')).toBe(true);
    expect(Object.hasOwn(state, 'annotationPresentationStreams')).toBe(true);
    expect(state._layout).toBeNull();
    expect(state.features).toEqual([]);

    const source = overlaySource();
    expect(source).toContain('private readonly layoutState = new AnnotationLayoutState');
    expect(source).not.toContain('this as unknown as OverlayLayoutHost');
    expect(source).not.toContain('this as unknown as LaneEnvelopeHost');
    expect(source).not.toContain('this as unknown as FeaturesInRangeHost');
    expect(source).not.toContain('this as unknown as GenomeIngressHost');
    expect(source).not.toContain('this as unknown as ClearDrawStateHost');
    expect(source).not.toContain('createFlatPresentationSnapshotHost');
    expect(source).toContain('setAnnotationFlatPresentationSnapshotFn(this.layoutState, snapshot)');
  });

  it('restores source/placement fingerprints when clearing compiled-broad requirement', () => {
    const overlay = new IndexedAnnotationOverlay();
    const layout = overlay.getLayoutStateForTest();
    layout.currentGenomeAnnotationSourcePlacementProvenance = {
      sourceFingerprint: 'src-fp',
      placementFingerprint: 'place-fp',
    };
    layout.currentAnnotationSourceFingerprint = 'stale-src';
    layout.currentAnnotationPlacementFingerprint = 'stale-place';
    overlay.clearCompiledBroadSurfaceRequirement();

    expect(layout.currentAnnotationSourceFingerprint).toBe('src-fp');
    expect(layout.currentAnnotationPlacementFingerprint).toBe('place-fp');
  });

  it('clears stale fingerprints when provenance is null and still tears down compiled-broad', () => {
    const overlay = new IndexedAnnotationOverlay();
    const layout = overlay.getLayoutStateForTest();
    const compiled = overlay.getCompiledBroadControllerForTest();
    let cleared = 0;
    const original = compiled.clearCompiledBroadSurfaceRequirement.bind(compiled);
    compiled.clearCompiledBroadSurfaceRequirement = () => {
      cleared += 1;
      original();
    };
    layout.currentGenomeAnnotationSourcePlacementProvenance = null;
    layout.currentAnnotationSourceFingerprint = 'stale-src';
    layout.currentAnnotationPlacementFingerprint = 'stale-place';

    overlay.clearCompiledBroadSurfaceRequirement();

    expect(cleared).toBe(1);
    expect(layout.currentAnnotationSourceFingerprint).toBeNull();
    expect(layout.currentAnnotationPlacementFingerprint).toBeNull();
  });

  it('forwards leftover compiledBroadSurfaceRequirement writes to the compiled-broad controller', () => {
    const overlay = new IndexedAnnotationOverlay();
    const layout = overlay.getLayoutStateForTest();
    const compiled = overlay.getCompiledBroadControllerForTest();
    layout.genomeLength = 3_088_269_832;
    layout.compiledBroadSurfaceRequirement = {
      genomeLengthBp: 3_088_269_832,
      broadCorridorFinestSpanBp: 16_000_000,
    };
    expect(compiled.compiledBroadSurfaceRequirement?.genomeLengthBp).toBe(3_088_269_832);
    layout.compiledBroadSurfaceRequirement = null;
    expect(compiled.compiledBroadSurfaceRequirement).toBeNull();
  });
});
