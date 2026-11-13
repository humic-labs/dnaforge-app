// @vitest-environment jsdom

import { beforeAll, expect, it } from 'vitest';
import { Container, type Application } from 'pixi.js';
import type { AnnotationResidentPagePublication, Feature, Genome, RenderState } from '../../types';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 6 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

it('renders a resident CDS codon carrier at coding detail without granting it body lane authority', async () => {
  const sourceIdentity = 'ncbi-resident-cds-source';
  const genome: Genome = {
    name: 'NCBI resident CDS genome',
    sourceIdentity,
    length: 600_000,
    circular: false,
    features: [],
    annotationLayerTypes: ['CDS'],
    annotationLayout: { maxAnnotationLane: -1, maxCdsLane: -1 },
    sequenceAvailable: true,
    sequenceWindow: { startBp: 292_970, bases: 'ATG'.repeat(120) },
  };
  const state: RenderState = {
    morph: 0,
    viewOffset: 0.5,
    zoom: 1,
    width: 1102,
    height: 178,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
  const cds: Feature = {
    id: 1,
    type: 'CDS',
    start: 293_000,
    end: 293_120,
    direction: 'forward',
    displayName: 'resident CDS',
    color: 0x22c55e,
    lane: 0,
    annotationTrackId: 'CDS',
    annotationTrackLane: 0,
    annotationTrackLaneCapacity: 1,
    canonicalIdentity: 'ncbi-resident-cds-1',
  };
  const publication: AnnotationResidentPagePublication = {
    contract: 'annotation-codon-carrier-page-publication.v1',
    sourceIdentity,
    genomeLengthBp: genome.length,
    policyKey: 'source-pages:CDS',
    generation: 1,
    requestedLayerTypes: ['CDS'],
    exactCoverage: [{ startBp: 0, endBp: genome.length }],
    pages: [
      {
        contract: 'annotation-presentation-page.v1',
        pageKey: 'CDS:0-600000',
        chromosomeId: 'chromosome-beta',
        trackId: 'CDS',
        trackOrder: 0,
        laneCapacity: 1,
        ownerStartBp: 0,
        ownerEndBp: genome.length,
        maxFeatureEndBp: genome.length,
        contentRevision: 'ncbi-resident-cds-v1',
        features: [cds],
      },
    ],
  };
  const renderer = new IndexedPixiLinearRenderer();
  const app = {
    stage: new Container(),
    canvas: document.createElement('canvas'),
  } as unknown as Application;
  await renderer.init(app, genome, () => state);
  const internals = renderer as unknown as {
    annotationOverlay: { maxAnnotationLane: number; maxCdsLane: number };
    codonTrack: { getDebugSnapshot: () => { hitCount: number } };
  };
  expect(internals.annotationOverlay.maxAnnotationLane).toBe(-1);
  expect(internals.annotationOverlay.maxCdsLane).toBe(-1);
  expect(renderer.ingestAnnotationResidentPages(publication).status).toBe('applied');
  expect(internals.annotationOverlay.maxAnnotationLane).toBe(-1);
  expect(internals.annotationOverlay.maxCdsLane).toBe(-1);
  expect(() => renderer.render(state)).not.toThrow();
  expect(internals.codonTrack.getDebugSnapshot().hitCount).toBe(0);
  expect(internals.annotationOverlay.maxAnnotationLane).toBe(-1);
  expect(internals.annotationOverlay.maxCdsLane).toBe(-1);
  const beforeFrame = renderer.getRendererOperationSnapshot().completedFrameEpoch;

  state.zoom = genome.length / 360;
  state.viewportRange = [292_970, 293_330];
  renderer.setViewCenterBp(293_150, state);

  expect(() => renderer.render(state)).not.toThrow();
  expect(renderer.getRendererOperationSnapshot().completedFrameEpoch).toBeGreaterThan(beforeFrame);
  expect(internals.codonTrack.getDebugSnapshot().hitCount).toBeGreaterThan(0);
  expect(internals.annotationOverlay.maxAnnotationLane).toBe(-1);
  expect(internals.annotationOverlay.maxCdsLane).toBe(-1);

  state.zoom = 1;
  state.viewportRange = null;
  renderer.setViewCenterBp(genome.length / 2, state);
  expect(() => renderer.render(state)).not.toThrow();
  expect(internals.codonTrack.getDebugSnapshot().hitCount).toBe(0);
  expect(internals.annotationOverlay.maxAnnotationLane).toBe(-1);
  expect(internals.annotationOverlay.maxCdsLane).toBe(-1);

  const emptyPublication: AnnotationResidentPagePublication = {
    ...publication,
    generation: 2,
    pages: publication.pages.map((page) => ({
      ...page,
      contentRevision: 'ncbi-resident-cds-empty-v2',
      features: [],
    })),
  };
  expect(renderer.ingestAnnotationResidentPages(emptyPublication).status).toBe('applied');
  state.zoom = genome.length / 360;
  state.viewportRange = [292_970, 293_330];
  renderer.setViewCenterBp(293_150, state);
  expect(() => renderer.render(state)).not.toThrow();
  expect(internals.codonTrack.getDebugSnapshot().hitCount).toBe(0);
  expect(internals.annotationOverlay.maxAnnotationLane).toBe(-1);
  expect(internals.annotationOverlay.maxCdsLane).toBe(-1);
  expect(genome.features).toEqual([]);
});
