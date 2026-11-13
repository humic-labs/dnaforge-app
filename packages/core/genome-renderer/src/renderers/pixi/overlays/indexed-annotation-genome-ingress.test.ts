import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Feature, Genome } from '../../../types';
import { FeatureWindowIndex } from '../shared/feature-window-index';
import {
  applyAnnotationGenome,
  loadAnnotationGenome,
  type GenomeIngressHost,
} from './indexed-annotation-genome-ingress';

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
    type: 'mRNA',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'gene',
    qualifiers: { _lane: '0' },
    ...overrides,
  };
}

function genome(overrides: Partial<Genome> = {}): Genome {
  return {
    name: 'chr1',
    sourceIdentity: 'chr1',
    length: 1_000,
    circular: false,
    features: [feature()],
    sequenceAvailable: true,
    ...overrides,
  };
}

function ingressHost(overrides: Partial<GenomeIngressHost> = {}): GenomeIngressHost {
  const interactionResidents = new Map<
    string,
    { metadata: { genomeIdentity: string; genomeLengthBp: number } }
  >();
  const prepackedResidents = new Map<
    string,
    { metadata: { genomeIdentity: string; genomeLengthBp: number } }
  >();
  return {
    prebuiltRasterEligibleForLastFrame: true,
    prebuiltRasterContractForLastFrame: {
      contractMatch: true,
      sourceMatch: true,
      placementMatch: true,
      artifactLayerTypes: ['mRNA'],
      artifactSourceFingerprint: 'src',
      artifactPlacementFingerprint: 'plc',
    },
    currentGenomeIdentity: '',
    currentGenomeAnnotationSourcePlacementProvenance: null,
    compiledBroadSurfaceSourcePlacementAuthority: null,
    compiledBroadSurfacePresenter: null,
    compiledBroadSurfaceCandidatePresenter: null,
    compiledBroadSurfaceTrackOwners: new Map(),
    compiledBroadSurfaceTrackCandidateOwners: new Map(),
    compiledBroadSurfaceRequirement: null,
    compiledBroadSurfaceManifest: null,
    prepackedAnnotationSceneResidents: prepackedResidents,
    compiledBroadAnnotationInteractionResidents: interactionResidents,
    compiledBroadAnnotationInteractionResidentGeneration: 0,
    currentAnnotationSourceFingerprint: null,
    currentAnnotationPlacementFingerprint: null,
    features: [],
    annotationRequestedLayerTypes: [],
    annotationExactCoverage: null,
    prepackedAnnotationSceneLayer: null,
    prepackedAnnotationSceneInput: null,
    prepackedAnnotationSceneStatus: 'not-loaded',
    retainedLinearFullSetMeshResident: true,
    featureById: new Map(),
    featureWindowIndex: new FeatureWindowIndex({
      genomeLength: 0,
      circular: false,
      features: [],
    }),
    genomeLength: 0,
    genomeCircular: false,
    labelCache: { clear() {} },
    overviewCache: { invalidate() {} },
    retainedOverviewHitBins: [{ bin: 1 }],
    retainedOverviewPassthroughDrawn: true,
    lastRenderKey: 'stale',
    retainedOverviewLayer: { resetData() {} },
    genomeWideTextureCacheLayer: { resetData() {} },
    retainedLinearFeatureLayer: { resetData() {} },
    retainedLinearTranscriptLayer: { resetData() {} },
    retainedLinearTranscriptKey: 'mesh',
    retainedLinearTranscriptFeatureSet: new Set(),
    retainedLinearTranscriptMembershipNeedsRebind: false,
    retainedLinearSourceWindow: { startBp: 0, endBp: 10, features: [] },
    sourceMaxAnnotationLane: 0,
    sourceMaxCdsLane: 0,
    featuresSortedByStart: [],
    longFeatures: [],
    circularWrappedFeatures: [],
    maxFeatureLenBp: 0,
    annotationPresentationStreams: { clear() {} },
    activeAnnotationPresentationStreamKey: 'stream',
    annotationResidentPageStreams: { clear() {} },
    activeAnnotationResidentPageStreamKey: 'pages',
    annotationResidentPageStore: {
      sourceIdentity: 'old',
      genomeLengthBp: 500,
    },
    residentAnnotationViewportSelectionCache: { key: 'cached' },
    residentAnnotationViewportSelectionStatus: 'ready',
    residentAnnotationViewportSelectedPageCount: 2,
    residentAnnotationViewportSelectedFeatureCount: 4,
    residentAnnotationViewportExpectedPageCount: 2,
    residentAnnotationViewportMissingPageCount: 0,
    residentAnnotationViewportCoverageComplete: true,
    residentAnnotationViewportProducerCoverageComplete: true,
    clearCompiledBroadSurfaceRequirement() {},
    disposePrepackedAnnotationScene() {},
    clearDrawState() {},
    resetRenderStats() {},
    resetTilePyramid() {},
    resetRetainedOverviewDebug() {},
    reconcileAnnotationLaneEnvelopeAuthority() {},
    ...overrides,
  };
}

describe('annotation overlay genome dual-ingress', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('const previousGenomeIdentity = this.currentGenomeIdentity');
    expect(source).not.toContain('const prepackedGenomeMatches =');
    expect(source).not.toContain('const streamingUpdate =');
    expect(source).not.toContain('SPLIT lane packing — runs ONCE at load');
    expect(source).not.toContain('do NOT eagerly warm the retained-transcript feature KEY');
    expect(source).not.toContain('const nextIdentity = genome.sourceIdentity ?? genome.name');
    expect(source).not.toContain('this.annotationPresentationStreams.clear()');
    expect(source).not.toContain('function loadAnnotationGenome(');
    expect(source).not.toContain('function applyAnnotationGenome(');
  });

  it('exports the dual-ingress entry points for the overlay façade', () => {
    expect(typeof loadAnnotationGenome).toBe('function');
    expect(typeof applyAnnotationGenome).toBe('function');
  });

  it('clears shell streams then installs features and lanes', () => {
    const cleared: string[] = [];
    const host = ingressHost({
      annotationPresentationStreams: {
        clear() {
          cleared.push('presentation');
        },
      },
      annotationResidentPageStreams: {
        clear() {
          cleared.push('pages');
        },
      },
    });
    const next = feature({ id: 9, type: 'CDS', start: 20, end: 50, qualifiers: { _lane: '2' } });
    loadAnnotationGenome(
      host,
      genome({
        features: [next],
        annotationLayout: { maxAnnotationLane: 3, maxCdsLane: 2 },
      })
    );
    expect(cleared).toEqual(['presentation', 'pages']);
    expect(host.activeAnnotationPresentationStreamKey).toBeNull();
    expect(host.activeAnnotationResidentPageStreamKey).toBeNull();
    expect(host.annotationResidentPageStore).toBeNull();
    expect(host.residentAnnotationViewportSelectionStatus).toBe('unavailable');
    expect(host.features).toEqual([next]);
    expect(host.currentGenomeIdentity).toBe('chr1');
    expect(host.genomeLength).toBe(1_000);
    expect(next.lane).toBe(2);
    expect(next.cdsLane).toBe(2);
    expect(host.sourceMaxAnnotationLane).toBe(3);
    expect(host.sourceMaxCdsLane).toBe(2);
    expect(host.annotationRequestedLayerTypes).toEqual(['CDS']);
    expect(host.retainedLinearFullSetMeshResident).toBe(false);
    expect(host.prebuiltRasterEligibleForLastFrame).toBe(false);
  });

  it('retains the last-good transcript mesh on a same-identity streaming merge', () => {
    const tileOpts: Array<{ retainRtt?: boolean }> = [];
    const debugOpts: Array<{ preserveTranscriptMesh?: boolean }> = [];
    const resetCalls: string[] = [];
    const meshSet = new Set<Feature>([feature()]);
    const host = ingressHost({
      currentGenomeIdentity: 'chr1',
      genomeLength: 1_000,
      genomeCircular: false,
      retainedLinearTranscriptFeatureSet: meshSet,
      retainedLinearTranscriptKey: 'keep',
      retainedLinearTranscriptLayer: {
        resetData() {
          resetCalls.push('transcript');
        },
      },
      resetTilePyramid(opts) {
        tileOpts.push(opts);
      },
      resetRetainedOverviewDebug(opts) {
        debugOpts.push(opts);
      },
    });
    applyAnnotationGenome(host, genome({ features: [feature({ id: 2 })] }));
    expect(resetCalls).toEqual([]);
    expect(host.retainedLinearTranscriptKey).toBe('keep');
    expect(host.retainedLinearTranscriptFeatureSet).toBe(meshSet);
    expect(host.retainedLinearTranscriptMembershipNeedsRebind).toBe(true);
    expect(tileOpts).toEqual([{ retainRtt: true }]);
    expect(debugOpts).toEqual([{ preserveTranscriptMesh: true }]);
  });

  it('resets transcript mesh and drops mismatched residents on a genome identity change', () => {
    const disposed: string[] = [];
    const cleared: string[] = [];
    const resetCalls: string[] = [];
    const prepacked = new Map([
      ['old', { metadata: { genomeIdentity: 'old', genomeLengthBp: 1_000 } }],
    ]);
    const interaction = new Map([
      ['keep', { metadata: { genomeIdentity: 'chr1', genomeLengthBp: 1_000 } }],
      ['drop', { metadata: { genomeIdentity: 'old', genomeLengthBp: 1_000 } }],
    ]);
    const host = ingressHost({
      currentGenomeIdentity: 'old',
      genomeLength: 1_000,
      compiledBroadSurfacePresenter: {},
      compiledBroadSurfaceManifest: { genomeLengthBp: 1_000 },
      prepackedAnnotationSceneResidents: prepacked,
      compiledBroadAnnotationInteractionResidents: interaction,
      compiledBroadAnnotationInteractionResidentGeneration: 4,
      retainedLinearTranscriptLayer: {
        resetData() {
          resetCalls.push('transcript');
        },
      },
      clearCompiledBroadSurfaceRequirement() {
        cleared.push('compiled');
      },
      disposePrepackedAnnotationScene(status) {
        disposed.push(status);
      },
    });
    applyAnnotationGenome(host, genome());
    expect(cleared).toEqual(['compiled']);
    expect(disposed).toEqual(['genome-mismatch']);
    expect(resetCalls).toEqual(['transcript']);
    expect(host.retainedLinearTranscriptKey).toBe('');
    expect(host.retainedLinearTranscriptFeatureSet).toBeNull();
    expect(host.compiledBroadAnnotationInteractionResidents.has('keep')).toBe(true);
    expect(host.compiledBroadAnnotationInteractionResidents.has('drop')).toBe(false);
    expect(host.compiledBroadAnnotationInteractionResidentGeneration).toBe(5);
    expect(host.currentGenomeIdentity).toBe('chr1');
  });
});
