// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Renderer } from 'pixi.js';
import { genomeFeatures, type Feature, type Genome, type RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';

let AnnotationOverlayClass: typeof import('./annotation-overlay').AnnotationOverlay;
let StadiumPathMapperClass: typeof import('../shared/path-mapper').StadiumPathMapper;
let getStadiumDimensionsFn: typeof import('../../../geometry/stadium').getStadiumDimensions;

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      scale: () => undefined,
      measureText: (text: string) => ({ width: text.length * 6 }),
      fillText: () => undefined,
      clearRect: () => undefined,
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;

  ({ AnnotationOverlay: AnnotationOverlayClass } = await import('./annotation-overlay'));
  ({ StadiumPathMapper: StadiumPathMapperClass } = await import('../shared/path-mapper'));
  ({ getStadiumDimensions: getStadiumDimensionsFn } = await import('../../../geometry/stadium'));
});

function overlayTestSourcePath(name: string): string {
  const metaUrl = import.meta.url;
  if (metaUrl.startsWith('file:')) {
    return join(dirname(fileURLToPath(metaUrl)), name);
  }
  return join(process.cwd(), 'src/renderers/pixi/overlays', name);
}

describe('sequence-annotation-overlay.draw.test.ts product split', () => {
  it('does not call indexed texture APIs', () => {
    const source = readFileSync(
      overlayTestSourcePath('sequence-annotation-overlay.draw.test.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/loadPrebuiltGenomeWideTexture/);
    expect(source).not.toMatch(/isPrebuiltGenomeWideTextureLoaded/);
  });
});

function createState(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function createLinearPath(pixelsPerBp = 10, viewStartBp = 0): PathMapper {
  const y = 100;
  return {
    isArcMode: false,
    pixelsPerBp,
    viewStartBp,
    viewEndBp: viewStartBp + 100,
    sequenceVisible: false,
    sequenceOpacity: 0,
    rowHeight: 12,
    sequenceFontSize: 10,
    fwdStrandTop: y,
    fwdStrandBottom: y + 12,
    revStrandTop: y + 18,
    revStrandBottom: y + 30,
    cutLineTopY: y,
    cutLineBottomY: y + 30,
    cutLabelY: y + 40,
    scaleStroke: (baseWidth: number) => baseWidth,
    bpLeftX: (bp: number) => (bp - viewStartBp) * pixelsPerBp,
    bpCenterX: (bp: number) => (bp - viewStartBp) * pixelsPerBp + pixelsPerBp / 2,
    featureLabelPosAt: (bp: number, offset: number) => ({
      x: (bp - viewStartBp) * pixelsPerBp + pixelsPerBp / 2,
      y: y + offset,
      angle: 0,
    }),
    featurePolygonAt: (startBp: number, endBp: number, offset: number, halfHeight = 7) => [
      (startBp - viewStartBp) * pixelsPerBp,
      y + offset - halfHeight,
      (endBp - viewStartBp) * pixelsPerBp,
      y + offset - halfHeight,
      (endBp - viewStartBp) * pixelsPerBp,
      y + offset + halfHeight,
      (startBp - viewStartBp) * pixelsPerBp,
      y + offset + halfHeight,
    ],
    featureQuadAt: (startBp: number, endBp: number, offset: number, halfHeight = 7) => [
      (startBp - viewStartBp) * pixelsPerBp,
      y + offset - halfHeight,
      (endBp - viewStartBp) * pixelsPerBp,
      y + offset - halfHeight,
      (endBp - viewStartBp) * pixelsPerBp,
      y + offset + halfHeight,
      (startBp - viewStartBp) * pixelsPerBp,
      y + offset + halfHeight,
    ],
    isFeatureVisible: () => true,
    backboneAt: (bp: number) => ({
      x: (bp - viewStartBp) * pixelsPerBp + pixelsPerBp / 2,
      y,
      angle: 0,
    }),
    fwdStrandAt: (bp: number) => ({
      x: (bp - viewStartBp) * pixelsPerBp + pixelsPerBp / 2,
      y,
      angle: 0,
    }),
    revStrandAt: (bp: number) => ({
      x: (bp - viewStartBp) * pixelsPerBp + pixelsPerBp / 2,
      y: y + 18,
      angle: 0,
    }),
    cutLineTopAt: (bp: number) => ({ x: (bp - viewStartBp) * pixelsPerBp, y }),
    cutLineConnectorAt: (bp: number) => ({
      x: (bp - viewStartBp) * pixelsPerBp,
      y: y + 15,
    }),
    cutLineBottomAt: (bp: number) => ({ x: (bp - viewStartBp) * pixelsPerBp, y: y + 30 }),
    translationAt: (bp: number) => ({
      x: (bp - viewStartBp) * pixelsPerBp + pixelsPerBp / 2,
      y,
      angle: 0,
    }),
    annotationAt: (bp: number) => ({
      x: (bp - viewStartBp) * pixelsPerBp + pixelsPerBp / 2,
      y,
      angle: 0,
    }),
    rulerAt: (bp: number) => ({
      x: (bp - viewStartBp) * pixelsPerBp + pixelsPerBp / 2,
      y,
      angle: 0,
    }),
    boundaryAt: (bp: number) => ({ x: (bp - viewStartBp) * pixelsPerBp, y }),
    cutLabelAt: (bp: number) => ({ x: (bp - viewStartBp) * pixelsPerBp, y: y + 40 }),
  };
}

function createPath(state: RenderState, genome: Genome) {
  const dims = getStadiumDimensionsFn(state.width, state.height, state.morph, 80);
  const pixelsPerBp = (dims.totalLength * state.zoom) / genome.length;
  return new StadiumPathMapperClass({
    genomeLength: genome.length,
    viewOffset: state.viewOffset,
    zoom: state.zoom,
    dims,
    ox: 80,
    oy: 80,
    stagePosX: 0,
    stagePosY: 0,
    bpPerPixel: 1 / pixelsPerBp,
    hasSequence: !!genome.sequence,
    viewportWidth: state.width,
    viewportHeight: state.height,
  });
}

function createAnnotationLayout(
  sequenceVisible: boolean,
  sequenceRevealProgress = sequenceVisible ? 1 : 0
): UnifiedLayout {
  return {
    compactScale: 1,
    sequenceVisible,
    sequenceRevealProgress,
    annotationOffset: 0,
    annotationStep: 16,
    cdsBarOffset: -20,
    cdsLaneStep: 30,
  } as UnifiedLayout;
}

function createChromosomeScaleGenome(featureCount: number): Genome {
  const length = 4_600_000;
  const features = Array.from({ length: featureCount }, (_, i) => ({
    id: i + 1,
    type: 'gene',
    start: Math.floor((i * length) / featureCount),
    end: Math.floor((i * length) / featureCount) + 800,
    direction: 'forward' as const,
    displayName: `g${i}`,
    color: 0x3b82f6,
    lane: 0,
  }));
  return {
    name: 'chromosome-scale-linear-lod',
    length,
    circular: false,
    features,
  };
}

function createChromosomeScaleTranscriptGenome(featureCount: number): Genome {
  const length = 4_600_000;
  const features = Array.from({ length: featureCount }, (_, i) => {
    const start = Math.floor((i * length) / featureCount);
    return {
      id: i + 1,
      type: 'mRNA',
      start,
      end: start + 12_000,
      direction: 'forward' as const,
      displayName: `tx${i}`,
      color: 0x3b82f6,
      lane: i % 8,
      exons: [
        { start: start + 1, end: start + 500 },
        { start: start + 2_000, end: start + 2_600 },
        { start: start + 8_000, end: start + 12_000 },
      ],
      cds: [
        { start: start + 2_050, end: start + 2_500 },
        { start: start + 8_200, end: start + 11_800 },
      ],
    };
  });
  return {
    name: 'chromosome-scale-linear-transcript-lod',
    length,
    circular: false,
    features,
  };
}

describe('indexed resident annotation labels', () => {
  it.each([
    {
      label: 'human transcript exons',
      feature: {
        id: 71,
        type: 'mRNA',
        compositeKind: 'transcript' as const,
        start: 99,
        end: 900,
        direction: 'forward' as const,
        displayName: 'HUMAN',
        color: 0x3b82f6,
        lane: 0,
        exons: [
          { start: 100, end: 200 },
          { start: 800, end: 900 },
        ],
        cds: [{ start: 800, end: 875 }],
      },
    },
    {
      label: 'bacterial compound CDS segments',
      feature: {
        id: 72,
        type: 'CDS',
        compositeKind: 'compound-cds' as const,
        start: 99,
        end: 900,
        direction: 'forward' as const,
        displayName: 'BACT',
        color: 0x16a34a,
        lane: 0,
        segments: [
          { start: 100, end: 200 },
          { start: 800, end: 900 },
        ],
        qualifiers: { _locationString: 'join(100..200,800..900)' },
      },
    },
  ])('anchors $label to its visible painted block', ({ feature }) => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'indexed-resident-label-placement',
      length: 1_000,
      circular: false,
      features: [feature],
    };
    const state = createState();
    const path = {
      ...createLinearPath(1, 700),
      viewEndBp: 1_000,
    } as PathMapper;

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.getImmediateDrawControllerForTest().renderResidentFeatureLabels([feature], path, state);

    const label = overlay
      .getRetainedLinearPresenterForTest()
      .labelPool.find((candidate) => candidate.text === feature.displayName);
    expect(label).toBeDefined();
    expect(label?.x).toBeGreaterThanOrEqual(path.bpLeftX(799));
    expect(label?.x).toBeLessThanOrEqual(path.bpLeftX(900));

    overlay.destroy();
  });

  it('skips resident labels for transcripts beyond the lane limit instead of failing the frame', () => {
    const overlay = new AnnotationOverlayClass();
    const placed: Feature = {
      id: 81,
      type: 'mRNA',
      start: 99,
      end: 900,
      direction: 'forward',
      displayName: 'PLACED.1',
      color: 0x3b82f6,
      lane: 0,
    };
    const beyondLimit: Feature = { ...placed, id: 82, displayName: 'BEYOND.1', lane: 99 };
    const genome: Genome = {
      name: 'indexed-resident-label-lane-limit',
      length: 1_000,
      circular: false,
      features: [placed],
    };
    const state = createState();
    const path = { ...createLinearPath(1, 700), viewEndBp: 1_000 } as PathMapper;

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    expect(() =>
      overlay
        .getImmediateDrawControllerForTest()
        .renderResidentFeatureLabels([placed, beyondLimit], path, state)
    ).not.toThrow();

    const texts = overlay.getRetainedLinearPresenterForTest().labelPool.map((l) => l.text);
    expect(texts).toContain('PLACED.1');
    expect(texts).not.toContain('BEYOND.1');

    overlay.destroy();
  });

  it('does not add an indexed resident label in an intron-only viewport', () => {
    const overlay = new AnnotationOverlayClass();
    const feature: Feature = {
      id: 73,
      type: 'mRNA',
      compositeKind: 'transcript',
      start: 99,
      end: 900,
      direction: 'forward',
      displayName: 'NO_INDEXED_INTRON_LABEL',
      color: 0x3b82f6,
      lane: 0,
      exons: [
        { start: 100, end: 200 },
        { start: 800, end: 900 },
      ],
      cds: [],
    };
    const genome: Genome = {
      name: 'indexed-intron-only-label-placement',
      length: 1_000,
      circular: false,
      features: [feature],
    };
    const state = createState();
    const path = {
      ...createLinearPath(1, 300),
      viewEndBp: 700,
    } as PathMapper;

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.getImmediateDrawControllerForTest().renderResidentFeatureLabels([feature], path, state);

    expect(
      overlay
        .getRetainedLinearPresenterForTest()
        .labelPool.some((candidate) => candidate.text === feature.displayName)
    ).toBe(false);

    overlay.destroy();
  });
});

describe('AnnotationOverlay linear source-shaped overview contract ', () => {
  it('keeps prebuilt annotation textures resident but inert on genome reload', () => {
    const overlay = new AnnotationOverlayClass();
    const firstGenome = createChromosomeScaleTranscriptGenome(16);
    const secondGenome = createChromosomeScaleTranscriptGenome(8);

    overlay.loadGenome(firstGenome);
    overlay.loadPrebuiltGenomeWideTexture({ width: 16, height: 8 } as ImageBitmap, {
      widthPx: 16,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: firstGenome.length,
    });

    expect(overlay.isPrebuiltGenomeWideTextureLoaded()).toBe(true);

    overlay.loadGenome(secondGenome);

    expect(overlay.isPrebuiltGenomeWideTextureLoaded()).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prebuiltGenomeWideTextureContractMatch: false,
      prebuiltGenomeWideTextureVisible: false,
    });
    overlay.destroy();
  });

  it('rejects prebuilt annotation textures whose genome length does not match the loaded genome', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleTranscriptGenome(16);

    overlay.loadGenome(genome);
    overlay.loadPrebuiltGenomeWideTexture({ width: 16, height: 8 } as ImageBitmap, {
      widthPx: 16,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length + 1,
    });

    expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureLoaded).toBe(false);
    overlay.destroy();
  });

  it('keeps a legacy prebuilt texture resident but fails presentation closed without a semantic receipt', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'assembly-empty-summary-with-prebuilt-overview',
      length: 4_600_000,
      circular: false,
      annotationLayerTypes: ['mRNA'],
      features: [],
    };
    const state = createState();
    const genomeWidePath = { ...createLinearPath(1.7e-4, 0), viewEndBp: genome.length };

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.loadPrebuiltGenomeWideTexture({ width: 4096, height: 8 } as ImageBitmap, {
      widthPx: 4096,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });

    expect(
      overlay.updateRetainedCamera({
        path: genomeWidePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(false);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.prebuiltGenomeWideTextureLoaded).toBe(true);
    expect(snapshot.prebuiltGenomeWideTextureContractMatch).toBe(false);
    expect(snapshot.prebuiltGenomeWideTextureVisible).toBe(false);
    expect(snapshot.annotationPresentationOwnerViolations).toEqual([
      'missing-annotation-layer-coverage:mRNA',
    ]);
    overlay.destroy();
  });

  it('never magnifies the prebuilt genome-wide PNG at intermediate spans, even before another owner is ready', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'assembly-empty-summary-with-prebuilt-intermediate-floor',
      length: 10_000_000,
      circular: false,
      annotationLayerTypes: ['mRNA'],
      features: [],
    };
    const state = createState();
    const intermediatePath = { ...createLinearPath(0.001, 0), viewEndBp: 1_200_000 };

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.loadPrebuiltGenomeWideTexture({ width: 16, height: 8 } as ImageBitmap, {
      widthPx: 16,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });

    expect(
      overlay.updateRetainedCamera({
        path: intermediatePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(false);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.prebuiltGenomeWideTextureLoaded).toBe(true);
    expect(snapshot.prebuiltGenomeWideTextureVisible).toBe(false);
    expect(snapshot.annotationPresentationOwnerViolations).toEqual([
      'missing-annotation-layer-coverage:mRNA',
    ]);
    expect(
      snapshot.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'compiled-raster-surface'
      )
    ).toMatchObject({ visible: false });
    expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
      mode: 'fallback',
      lastFallbackReason: 'dirty-data',
      visibleInstanceCount: 0,
    });
    overlay.destroy();
  });

  it('does not let physical sharpness promote a legacy raster without semantic authority', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'assembly-prebuilt-exact-sampling-boundary',
      length: 10_000_000,
      circular: false,
      annotationLayerTypes: ['mRNA'],
      features: [],
    };
    const state = createState();
    const genomeWidePath = {
      ...createLinearPath(state.width / genome.length, 0),
      viewEndBp: genome.length,
    };

    overlay.setRenderer({ resolution: 1 } as unknown as Renderer);
    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    overlay.loadPrebuiltGenomeWideTexture({ width: 799, height: 8 } as ImageBitmap, {
      widthPx: 799,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });
    expect(
      overlay.updateRetainedCamera({
        path: genomeWidePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prebuiltGenomeWideTextureVisible: false,
      prebuiltGenomeWideTextureEligible: false,
    });

    overlay.loadPrebuiltGenomeWideTexture({ width: 800, height: 8 } as ImageBitmap, {
      widthPx: 800,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });
    expect(
      overlay.updateRetainedCamera({
        path: genomeWidePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prebuiltGenomeWideTextureContractMatch: false,
      prebuiltGenomeWideTextureVisible: false,
      prebuiltGenomeWideTextureEligible: false,
    });
    overlay.destroy();
  });

  it('does not let a high-DPR legacy raster bypass semantic validation', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'assembly-prebuilt-display-dpr-mismatch',
      length: 10_000_000,
      circular: false,
      annotationLayerTypes: ['mRNA'],
      features: [],
    };
    const state = createState();
    const genomeWidePath = {
      ...createLinearPath(state.width / genome.length, 0),
      viewEndBp: genome.length,
    };

    overlay.setRenderer({ resolution: 2 } as unknown as Renderer);
    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    overlay.loadPrebuiltGenomeWideTexture({ width: 3200, height: 8 } as ImageBitmap, {
      widthPx: 3200,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });
    expect(
      overlay.updateRetainedCamera({
        path: genomeWidePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(false);
    expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureVisible).toBe(false);

    overlay.loadPrebuiltGenomeWideTexture({ width: 1600, height: 16 } as ImageBitmap, {
      widthPx: 800,
      heightPx: 8,
      resolution: 2,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });
    expect(
      overlay.updateRetainedCamera({
        path: genomeWidePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prebuiltGenomeWideTextureContractMatch: false,
      prebuiltGenomeWideTextureVisible: false,
    });
    overlay.destroy();
  });

  it('prebuilt genome-wide PNG YIELDS to the live mesh once resident features cover the viewport  anti-blur)', () => {
    const overlay = new AnnotationOverlayClass();
    const features: Feature[] = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      type: 'mRNA',
      start: i * 100_000,
      end: i * 100_000 + 60_000,
      direction: 'forward' as const,
      displayName: `tx-${i}`,
      color: 0x3b82f6,
      lane: 0,
      exons: [{ start: i * 100_000, end: i * 100_000 + 60_000 }],
    }));
    const genome: Genome = {
      name: 'assembly-covered-viewport-with-prebuilt',
      length: 10_000_000,
      circular: false,
      annotationLayerTypes: ['mRNA'],
      features,
    };
    const state = createState();
    const intermediatePath = { ...createLinearPath(0.001, 0), viewEndBp: 1_200_000 };

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.loadPrebuiltGenomeWideTexture({ width: 16, height: 8 } as ImageBitmap, {
      widthPx: 16,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });

    expect(
      overlay.updateRetainedCamera({
        path: intermediatePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.prebuiltGenomeWideTextureLoaded).toBe(true);
    expect(snapshot.prebuiltGenomeWideTextureVisible).toBe(false);
    expect(snapshot.annotationPresentationOwnerViolations).toEqual([]);
    overlay.destroy();
  });

  it('honors explicit annotation layout when a prebuilt texture has no live feature payload', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'assembly-empty-summary-with-layout-contract',
      length: 4_600_000,
      circular: false,
      annotationLayout: { maxAnnotationLane: 3, maxCdsLane: 1 },
      annotationLayerTypes: ['mRNA'],
      features: [],
    };
    const state = createState();
    const genomeWidePath = { ...createLinearPath(1.7e-4, 0), viewEndBp: genome.length };

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.loadPrebuiltGenomeWideTexture({ width: 4096, height: 8 } as ImageBitmap, {
      widthPx: 4096,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });
    expect(
      overlay.updateRetainedCamera({
        path: genomeWidePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(false);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.featureCount).toBe(0);
    expect(snapshot.layout?.annotationLanes).toBe(4);
    expect(snapshot.layout?.cdsLanes).toBe(2);
    expect(snapshot.annotationPresentationLayerTypes).toEqual([]);
    overlay.destroy();
  });

  it('hides prebuilt genome-wide annotation texture when annotation presentation is disabled', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'assembly-empty-summary-with-layout-contract',
      length: 4_600_000,
      circular: false,
      annotationLayout: { maxAnnotationLane: 3, maxCdsLane: 1 },
      annotationLayerTypes: ['mRNA'],
      features: [],
    };
    const state = createState();
    const genomeWidePath = { ...createLinearPath(1.7e-4, 0), viewEndBp: genome.length };

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.loadPrebuiltGenomeWideTexture({ width: 4096, height: 8 } as ImageBitmap, {
      widthPx: 4096,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });
    expect(
      overlay.updateRetainedCamera({
        path: genomeWidePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(false);
    expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureVisible).toBe(false);

    overlay.setPresentationVisible(false);
    expect(
      overlay.updateRetainedCamera({
        path: genomeWidePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.prebuiltGenomeWideTextureLoaded).toBe(true);
    expect(snapshot.prebuiltGenomeWideTextureVisible).toBe(false);
    expect(snapshot.annotationPresentationOwners.filter((owner) => owner.visible)).toEqual([]);
    overlay.destroy();
  });

  it('never promotes an unreceipted linear raster while switching to an arc retained camera', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleTranscriptGenome(16);
    const state = createState();

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.loadPrebuiltGenomeWideTexture({ width: 4096, height: 8 } as ImageBitmap, {
      widthPx: 4096,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });

    expect(
      overlay.updateRetainedCamera({
        path: { ...createLinearPath(1.7e-4, 0), viewEndBp: genome.length },
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureVisible).toBe(false);

    const arcState = { ...state, zoom: 0.01 };
    expect(
      overlay.updateRetainedCamera({
        path: createPath(arcState, { ...genome, circular: true }),
        state: arcState,
        yOffset: 0,
        height: arcState.height,
      })
    ).toBe(true);

    expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureVisible).toBe(false);
    overlay.destroy();
  });

  it('never promotes an unreceipted linear raster before immediate rendering owns the frame', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleTranscriptGenome(16);
    const state = createState();
    const genomeWidePath = { ...createLinearPath(1.7e-4, 0), viewEndBp: genome.length };

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.loadPrebuiltGenomeWideTexture({ width: 4096, height: 8 } as ImageBitmap, {
      widthPx: 4096,
      heightPx: 8,
      resolution: 1,
      spineOffsetPx: 4,
      genomeLength: genome.length,
    });

    expect(
      overlay.updateRetainedCamera({
        path: genomeWidePath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureVisible).toBe(false);

    overlay.render(genomeWidePath, state, 0, state.height);

    expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureVisible).toBe(false);
    overlay.destroy();
  });

  it('never promotes an unreceipted linear raster while retained linear fallback yields', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleTranscriptGenome(16);
    const state = createState();
    const genomeWidePath = { ...createLinearPath(1.7e-4, 0), viewEndBp: genome.length };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));
      overlay.loadPrebuiltGenomeWideTexture({ width: 4096, height: 8 } as ImageBitmap, {
        widthPx: 4096,
        heightPx: 8,
        resolution: 1,
        spineOffsetPx: 4,
        genomeLength: genome.length,
      });

      expect(
        overlay.updateRetainedCamera({
          path: genomeWidePath,
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);
      expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureVisible).toBe(false);

      retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = false;
      expect(
        overlay.updateRetainedCamera({
          path: genomeWidePath,
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(false);

      expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureVisible).toBe(false);
      overlay.render(genomeWidePath, state, 0, state.height);
      expect(overlay.getDebugSnapshot().prebuiltGenomeWideTextureVisible).toBe(false);
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });

  it('publishes the live annotation presentation owner and visual contract id', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleTranscriptGenome(64);
    const state = createState();
    const path = createLinearPath(1.7e-4, 0);

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    expect(
      overlay.updateRetainedCamera({
        path,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.annotationPresentationStyleId).toBe(
      'indexed-linear-annotation-visual-contract-v1'
    );
    expect(snapshot.annotationLodBackend).toBe('active-segment-retained-surface');
    expect(snapshot.annotationPresentationLayerTypes).toContain('mRNA');
    expect(snapshot.annotationPresentationOwnerViolations).toEqual([]);
    expect(
      snapshot.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'active-segment-retained-surface'
      )
    ).toMatchObject({
      visible: true,
      layerTypes: ['mRNA'],
      visualGroups: ['transcript-body', 'cds-exon', 'intron-connector'],
    });
    overlay.destroy();
  });

  it('does not flip linear zoomed-out views into grouped overview aggregation', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleGenome(2000);
    const state = createState();
    const path = createLinearPath(1.7e-4);

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.overviewAggregationEnabled).toBe(false);
    expect(snapshot.drawAudit).toMatchObject({
      pathMode: 'linear',
      overview: {
        aggregationEnabled: false,
        atlasInputFeatureCount: 0,
        atlasAggregatedFeatureCount: 0,
      },
    });
    expect(snapshot.drawAudit?.overview.binCount).toBe(0);
    expect(snapshot.drawAudit?.decisions['skipped-overview-aggregated-tiny']).toBe(0);
    expect(snapshot.drawAudit?.decisions.drawn).toBeGreaterThan(0);
    overlay.destroy();
  });

  it('retains transcript bodies for mixed source-shaped linear feature sets', () => {
    const overlay = new AnnotationOverlayClass();
    const transcriptGenome = createChromosomeScaleTranscriptGenome(64);
    const geneGenome = createChromosomeScaleGenome(64);
    const genome: Genome = {
      name: 'chromosome-scale-linear-mixed-source-shapes',
      length: transcriptGenome.length,
      circular: false,
      features: [
        ...genomeFeatures(transcriptGenome),
        ...genomeFeatures(geneGenome).map((feature) => ({
          ...feature,
          id: feature.id + 10_000,
          lane: 12,
        })),
      ],
    };
    const state = createState();
    const firstPath = createLinearPath(1.7e-4, 0);

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    expect(
      overlay.updateRetainedCamera({
        path: firstPath,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    const first = overlay.getDebugSnapshot();
    expect(first.overviewAggregationEnabled).toBe(false);
    expect(first.retainedLinearDataBuilds).toBe(0);
    expect(first.retainedLinearBinCount).toBe(0);
    expect(first.retainedLinearTranscriptBuilds).toBe(1);
    expect(first.retainedLinearTranscriptBlockCount).toBeGreaterThan(0);
    expect(first.drawAudit?.decisions['skipped-batched-transcript']).toBeGreaterThan(0);
    expect(first.drawAudit?.decisions.drawn).toBeGreaterThan(0);
    expect(first.drawAudit?.decisions['skipped-overview-aggregated-tiny']).toBe(0);
    expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
      supported: true,
      enabled: true,
      mode: 'retained',
      dataBuilds: 1,
      cameraUpdates: 1,
      fallbackRenders: 0,
      lastFallbackReason: null,
    });

    overlay.destroy();
  });

  it('keeps linear transcript buffers stable across atlas-level changes', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleTranscriptGenome(64);
    const state = createState();

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    expect(
      overlay.updateRetainedCamera({
        path: createLinearPath(1.7e-4, 0),
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);
    const first = overlay.getDebugSnapshot();
    expect(first.overviewAggregationEnabled).toBe(false);
    expect(first.retainedLinearBinCount).toBe(0);
    expect(first.retainedLinearTranscriptBuilds).toBe(1);
    expect(first.retainedLinearTranscriptBlockCount).toBeGreaterThan(0);
    expect(first.drawAudit?.decisions['skipped-batched-transcript']).toBeGreaterThan(0);

    state.zoom = 1.5;
    state.viewOffset = 0.2;
    expect(
      overlay.updateRetainedCamera({
        path: createLinearPath(3.4e-4, 50_000),
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    const second = overlay.getDebugSnapshot();
    expect(second.overviewAggregationEnabled).toBe(false);
    expect(second.retainedLinearBinCount).toBe(0);
    expect(second.retainedLinearTranscriptBuilds).toBe(1);
    expect(second.retainedLinearTranscriptBlockCount).toBe(
      first.retainedLinearTranscriptBlockCount
    );
    expect(second.drawAudit?.decisions['skipped-overview-aggregated-tiny']).toBe(0);

    state.zoom = 10;
    state.viewOffset = 0.4;
    expect(
      overlay.updateRetainedCamera({
        path: createLinearPath(0.01, 200_000),
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    const third = overlay.getDebugSnapshot();
    expect(third).toMatchObject({
      geometryRebuilds: 0,
      lastRenderMode: 'retained',
      overviewAggregationEnabled: false,
    });
    expect(third.retainedLinearTranscriptBuilds).toBe(1);
    expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
      mode: 'retained',
      fallbackRenders: 0,
      lastFallbackReason: null,
    });

    overlay.destroy();
  });

  it('rebinds equivalent streaming transcript membership without repainting a second live owner', () => {
    const overlay = new AnnotationOverlayClass();
    const firstGenome = {
      ...createChromosomeScaleTranscriptGenome(64),
      sourceIdentity: 'grch38-equivalent-stream',
    };
    const state = createState();
    const path = {
      ...createLinearPath(0.004, 0),
      viewEndBp: 200_000,
    } as PathMapper;

    overlay.loadGenome(firstGenome);
    overlay.setLayout(createAnnotationLayout(false));
    expect(
      overlay.updateRetainedCamera({
        path,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);
    const first = overlay.getDebugSnapshot();
    expect(first.retainedLinearTranscriptBuilds).toBe(1);
    expect(first.drawnFeatureCount).toBe(0);

    const remintedFeatures = genomeFeatures(firstGenome).map((feature) => ({
      ...feature,
      exons: feature.exons?.map((span) => ({ ...span })),
      cds: feature.cds?.map((span) => ({ ...span })),
      qualifiers: feature.qualifiers ? { ...feature.qualifiers } : undefined,
    }));
    expect(remintedFeatures[0]).not.toBe(genomeFeatures(firstGenome)[0]);
    overlay.loadGenome({ ...firstGenome, features: remintedFeatures });

    expect(
      overlay.updateRetainedCamera({
        path,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);
    const second = overlay.getDebugSnapshot();
    expect(second.retainedLinearTranscriptBuilds).toBe(first.retainedLinearTranscriptBuilds);
    expect(second.drawnFeatureCount).toBe(0);
    expect(second.annotationPresentationOwnerViolations).toEqual([]);
    expect(
      second.annotationPresentationOwners
        .filter((owner) => owner.visible && owner.visualGroups.length > 0)
        .map((owner) => owner.ownerId)
    ).toEqual(['active-segment-retained-surface']);
    expect(
      second.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'single-chrom-live-surface'
      )
    ).toMatchObject({ visible: false });

    overlay.destroy();
  });

  it('does not retain a transcript mesh across different sources with matching length and circularity', () => {
    const overlay = new AnnotationOverlayClass();
    const firstGenome = {
      ...createChromosomeScaleTranscriptGenome(8),
      sourceIdentity: 'assembly-source-a',
    };
    const state = createState();
    const path = {
      ...createLinearPath(0.004, 0),
      viewEndBp: 200_000,
    } as PathMapper;

    overlay.loadGenome(firstGenome);
    overlay.setLayout(createAnnotationLayout(false));
    expect(
      overlay.updateRetainedCamera({
        path,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().retainedLinearTranscriptBlockCount).toBeGreaterThan(0);

    overlay.loadGenome({
      ...firstGenome,
      sourceIdentity: 'assembly-source-b',
      features: [],
    });

    const second = overlay.getDebugSnapshot();
    expect(second.retainedLinearTranscriptBlockCount).toBe(0);
    expect(
      second.annotationPresentationOwners.find(
        (owner) => owner.ownerId === 'active-segment-retained-surface'
      )
    ).toMatchObject({ visible: false });

    overlay.destroy();
  });

  it('rebuilds retained transcript buffers when middle transcript glyph geometry changes', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleTranscriptGenome(3);
    const baseFeatures = genomeFeatures(genome);
    const state = createState();
    const path = {
      ...createLinearPath(1.7e-4, 0),
      viewEndBp: genome.length,
    } as PathMapper;
    const syncRetainedLinearOverviewLayers = (
      overlay as unknown as {
        syncRetainedLinearOverviewLayers: (
          path: PathMapper,
          state: RenderState,
          overviewCache: unknown,
          featuresToRender: readonly Feature[]
        ) => Set<Feature> | null;
      }
    ).syncRetainedLinearOverviewLayers.bind(overlay);
    const overviewCache = (features: readonly Feature[]) => ({
      key: 'linear-source-shaped-full-shapes',
      binBp: 0,
      atlasLevelCount: 0,
      bins: [],
      passthroughFeatures: features,
      diagnostics: {
        inputFeatureCount: features.length,
        skippedMinVisibleFeatureCount: 0,
        passthroughFeatureCount: features.length,
        aggregateWideFeatureCount: 0,
        aggregatedFeatureCount: 0,
        binContributionCount: 0,
      },
    });

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    expect(
      syncRetainedLinearOverviewLayers(path, state, overviewCache(baseFeatures), baseFeatures)
    ).not.toBeNull();
    const first = overlay.getDebugSnapshot();
    expect(first.retainedLinearTranscriptBuilds).toBe(1);
    expect(first.retainedLinearTranscriptBlockCount).toBeGreaterThan(0);

    const changedMiddleGeometry = baseFeatures.map((feature, index) => {
      if (index !== 1) return feature;
      return {
        ...feature,
        exons: [{ start: feature.start + 1, end: feature.end }],
        cds: [],
      };
    });

    expect(
      syncRetainedLinearOverviewLayers(
        path,
        state,
        overviewCache(changedMiddleGeometry),
        changedMiddleGeometry
      )
    ).not.toBeNull();
    const second = overlay.getDebugSnapshot();
    expect(second.retainedLinearTranscriptBuilds).toBe(2);
    expect(second.retainedLinearTranscriptBlockCount).not.toBe(
      first.retainedLinearTranscriptBlockCount
    );

    overlay.destroy();
  });

  it('does not rebuild retained transcript buffers for sequence reveal-only layout changes', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleTranscriptGenome(64);
    const state = createState();
    const path = createLinearPath(1.7e-4, 0);

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false, 0));

    expect(
      overlay.updateRetainedCamera({
        path,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);
    const first = overlay.getDebugSnapshot();
    expect(first.retainedLinearTranscriptBuilds).toBe(1);

    overlay.setLayout({
      ...createAnnotationLayout(true, 0.5),
      annotationOffset: 0,
      annotationStep: 16,
      cdsBarOffset: -20,
      cdsLaneStep: 30,
      sequenceOpacity: 0.5,
    } as UnifiedLayout);

    expect(
      overlay.updateRetainedCamera({
        path,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);
    const second = overlay.getDebugSnapshot();
    expect(second.retainedLinearTranscriptBuilds).toBe(1);
    expect(second.retainedLinearTranscriptBlockCount).toBe(
      first.retainedLinearTranscriptBlockCount
    );

    overlay.destroy();
  });

  it('keeps transcript-only retained full-shape rendering free of aggregate bins', () => {
    const overlay = new AnnotationOverlayClass();
    const transcript = (id: number, lane: number): Feature => ({
      id,
      type: 'mRNA',
      start: 100_000 + id * 20_000,
      end: 112_000 + id * 20_000,
      direction: 'forward',
      displayName: `visible-lane-${id}`,
      color: 0x3b82f6,
      lane,
      qualifiers: { _lane: String(lane) },
      exons: [
        { start: 100_001 + id * 20_000, end: 100_500 + id * 20_000 },
        { start: 102_000 + id * 20_000, end: 112_000 + id * 20_000 },
      ],
      cds: [{ start: 102_100 + id * 20_000, end: 111_800 + id * 20_000 }],
    });
    const genome: Genome = {
      name: 'retained-linear-offscreen-lane-cull',
      length: 4_600_000,
      circular: false,
      features: [transcript(1, 0), transcript(2, 40)],
    };
    const state = createState();

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    expect(
      overlay.updateRetainedCamera({
        path: createLinearPath(1.7e-4, 0),
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.overviewAggregationEnabled).toBe(false);
    expect(snapshot.retainedLinearBinCount).toBe(0);
    expect(snapshot.drawAudit?.decisions['skipped-overview-aggregated-tiny']).toBe(0);
    expect(snapshot.drawAudit?.decisions.drawn).toBe(0);

    overlay.destroy();
  });

  it('keeps retained linear transcript intron chevrons visible', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'retained-linear-transcript-chevron-regression',
      length: 5_000,
      circular: false,
      features: [
        {
          id: 1,
          type: 'mRNA',
          start: 99,
          end: 1_000,
          direction: 'forward',
          displayName: 'retained-chevron',
          color: 0x3b82f6,
          lane: 0,
          exons: [
            { start: 100, end: 200 },
            { start: 800, end: 1000 },
          ],
          cds: [
            { start: 150, end: 200 },
            { start: 800, end: 950 },
          ],
        },
      ],
      sequence: 'A'.repeat(5_000),
    };
    const state = createState();
    const retainedDecorationGraphics =
      overlay.getRetainedLinearPresenterForTest().retainedTranscriptDecorationGraphics;
    const polySpy = vi.spyOn(retainedDecorationGraphics, 'poly');
    const strokeSpy = vi.spyOn(retainedDecorationGraphics, 'stroke');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    expect(
      overlay.updateRetainedCamera({
        path: createLinearPath(0.5, 150),
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot).toMatchObject({
      lastRenderMode: 'retained',
      retainedLinearTranscriptBuilds: 1,
    });
    expect(snapshot.drawAudit?.decisions['skipped-batched-transcript']).toBe(1);
    expect(polySpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(strokeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    overlay.destroy();
  });

  it('rebuilds retained transcript buffers when an in-place feature update gains exons', () => {
    const overlay = new AnnotationOverlayClass();
    const features: Feature[] = [
      {
        id: 1,
        type: 'gene',
        start: 99,
        end: 1_000,
        direction: 'forward',
        displayName: 'mutating-detail-feature',
        color: 0x3b82f6,
        lane: 0,
      },
    ];
    const genome: Genome = {
      name: 'retained-linear-mutating-feature-regression',
      length: 5_000,
      circular: false,
      features,
      annotationLayerTypes: ['mRNA'],
    };
    const state = createState();
    const path = createLinearPath(0.5, 150);

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    expect(
      overlay.updateRetainedCamera({
        path,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      retainedLinearTranscriptBlockCount: 0,
      retainedLinearTranscriptVisibleFeatureCount: 0,
    });

    Object.assign(features[0], {
      type: 'mRNA',
      exons: [
        { start: 100, end: 200 },
        { start: 800, end: 1_000 },
      ],
      cds: [
        { start: 150, end: 200 },
        { start: 800, end: 950 },
      ],
    });

    expect(
      overlay.updateRetainedCamera({
        path,
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.retainedLinearSourceWindowFeatureSamples).toMatchObject([
      {
        type: 'mRNA',
        exonCount: 2,
        laneEnvelopeResolved: true,
      },
    ]);
    expect(snapshot.retainedLinearTranscriptVisibleFeatureCount).toBe(1);
    expect(snapshot.retainedLinearTranscriptBlockCount).toBeGreaterThan(0);
    expect(snapshot.annotationPresentationLayerTypes).toEqual(['mRNA']);

    overlay.destroy();
  });

  it('stays in full-shape rendering at plasmid-scale zoom on a linear path', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createChromosomeScaleGenome(20);
    const state = createState();
    const path = createLinearPath(0.5);

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const snapshot = overlay.getDebugSnapshot();
    expect(snapshot.overviewAggregationEnabled).toBe(false);
    overlay.destroy();
  });

  it('does not rebuild geometry for empty full-shape linear camera frames', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'empty-full-shape-linear-camera',
      length: 1_000_000,
      circular: false,
      features: [
        {
          id: 1,
          type: 'gene',
          start: 100,
          end: 500,
          direction: 'none',
          displayName: 'far-away',
          color: 0x22c55e,
          lane: 0,
        },
      ],
    };
    const state = createState();

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));

    expect(
      overlay.updateRetainedCamera({
        path: createLinearPath(0.5, 500_000),
        state,
        yOffset: 0,
        height: state.height,
      })
    ).toBe(true);

    expect(overlay.getDebugSnapshot()).toMatchObject({
      renderCalls: 1,
      geometryRebuilds: 0,
      lastRenderMode: 'retained',
      overviewAggregationEnabled: false,
    });
    expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
      mode: 'retained',
      lastFallbackReason: null,
      visibleInstanceCount: 0,
    });
    expect(overlay.getDebugSnapshot().drawAudit).toMatchObject({
      pathMode: 'linear',
      renderSetFeatureCount: 0,
    });

    overlay.destroy();
  });
});
