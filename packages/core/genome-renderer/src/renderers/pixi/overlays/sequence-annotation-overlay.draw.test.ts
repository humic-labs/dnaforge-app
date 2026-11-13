// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Container } from 'pixi.js';
import { CodonTrack } from '../tracks/codon-track';
import { setupInteraction } from '../interaction';
import { PILL_LABEL_EMPHASIS_STROKE_PX } from '../shared/label-pill';
import { genomeFeatures, type Feature, type Genome, type RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import { getLabelOccupancyRecords, resetLabelOccupancy } from '../shared/label-occupancy';
import { webglAnnotationColorForMode } from '../shared/theme';
import {
  annotationTypeBadgeStyle,
  featureTypeColor,
  transcriptColorForMode,
} from '../../../feature-colors';

const GENOME_LENGTH = 1000;

let AnnotationOverlayClass: typeof import('./sequence-annotation-overlay').SequenceAnnotationOverlay;
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

  ({ SequenceAnnotationOverlay: AnnotationOverlayClass } =
    await import('./sequence-annotation-overlay'));
  ({ StadiumPathMapper: StadiumPathMapperClass } = await import('../shared/path-mapper'));
  ({ getStadiumDimensions: getStadiumDimensionsFn } = await import('../../../geometry/stadium'));
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

function createCapCdsGenome(): Genome {
  const dims = getStadiumDimensionsFn(800, 400, 0, 80);
  const topEnd = dims.straightLength / dims.totalLength;
  const rightCapEnd = (dims.straightLength + Math.PI * dims.radius) / dims.totalLength;
  const startNorm = topEnd + (rightCapEnd - topEnd) * 0.2;
  const endNorm = topEnd + (rightCapEnd - topEnd) * 0.8;

  return {
    name: 'curved-annotation-label-regression',
    length: GENOME_LENGTH,
    circular: true,
    features: [
      {
        id: 1,
        type: 'CDS',
        start: Math.floor(startNorm * GENOME_LENGTH),
        end: Math.ceil(endNorm * GENOME_LENGTH),
        direction: 'forward',
        displayName: 'Curved CDS Label',
        color: 0x3b82f6,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createTransitionCdsGenome(): Genome {
  const dims = getStadiumDimensionsFn(800, 400, 0, 80);
  const topEnd = dims.straightLength / dims.totalLength;
  const startNorm = topEnd - 0.045;
  const endNorm = topEnd + 0.045;

  return {
    name: 'annotation-label-transition-spacing-regression',
    length: GENOME_LENGTH,
    circular: true,
    features: [
      {
        id: 2,
        type: 'CDS',
        start: Math.floor(startNorm * GENOME_LENGTH),
        end: Math.ceil(endNorm * GENOME_LENGTH),
        direction: 'none',
        displayName: 'AAAAAAAAAAAA',
        color: 0x3b82f6,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createLinearCdsGenome(): Genome {
  return {
    name: 'linear-annotation-label-overdraw-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 3,
        type: 'CDS',
        start: 10,
        end: 80,
        direction: 'none',
        displayName: 'Linear Label',
        color: 0x3b82f6,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createDirectionalLinearCdsGenome(direction: Feature['direction']): Genome {
  const genome = createLinearCdsGenome();
  return {
    ...genome,
    features: genomeFeatures(genome).map((feature) => ({ ...feature, direction })),
  };
}

function createDirectionalArcCdsGenome(direction: Feature['direction']): Genome {
  return {
    name: 'arc-directional-outline-regression',
    length: GENOME_LENGTH,
    circular: true,
    features: [
      {
        id: 40,
        type: 'CDS',
        start: 10,
        end: 80,
        direction,
        displayName: '',
        color: 0x3b82f6,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createDirectionalArcGeneGenome(direction: Feature['direction']): Genome {
  return {
    name: 'arc-directional-gene-outline-regression',
    length: GENOME_LENGTH,
    circular: true,
    features: [
      {
        id: 43,
        type: 'gene',
        start: 10,
        end: 80,
        direction,
        displayName: '',
        color: 0x22c55e,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createFeatureLevelCdsGenome(): Genome {
  return {
    name: 'feature-level-cds-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 30,
        type: 'CDS',
        start: 10,
        end: 80,
        direction: 'forward',
        displayName: 'Feature CDS',
        color: 0x3b82f6,
        lane: 0,
      },
      {
        id: 31,
        type: 'gene',
        start: 90,
        end: 150,
        direction: 'none',
        displayName: 'Feature Gene',
        color: 0x22c55e,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createOverlappingCdsGeneGenome(): Genome {
  return {
    name: 'cds-lod-lane-stability-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 32,
        type: 'gene',
        start: 10,
        end: 90,
        direction: 'none',
        displayName: 'Overlapping Gene',
        color: 0x22c55e,
        lane: 0,
      },
      {
        id: 33,
        type: 'CDS',
        start: 10,
        end: 90,
        direction: 'forward',
        displayName: 'Stable CDS',
        color: 0x3b82f6,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createLongLabelCdsGenome(): Genome {
  return {
    name: 'long-label-cds-connector-regression',
    length: GENOME_LENGTH,
    circular: true,
    features: [
      {
        id: 10,
        type: 'CDS',
        start: 10,
        end: 80,
        direction: 'none',
        displayName: 'Very Long CDS Label That Fills The Whole Feature',
        color: 0x3b82f6,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createTinyLinearGeneGenome(): Genome {
  return {
    name: 'tiny-linear-annotation-lod-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 4,
        type: 'gene',
        start: 10,
        end: 11,
        direction: 'none',
        displayName: 'tiny',
        color: 0x22c55e,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createNarrowForwardGeneGenome(): Genome {
  return {
    name: 'narrow-forward-annotation-shape-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 9,
        type: 'gene',
        start: 10,
        end: 14,
        direction: 'forward',
        displayName: 'narrow',
        color: 0x22c55e,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createOutlineOnlyDraftGeneGenome(): Genome {
  return {
    name: 'outline-only-plannotate-draft-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 41,
        type: 'gene',
        start: 10,
        end: 90,
        direction: 'forward',
        displayName: 'draft gene',
        color: 0x22c55e,
        outlineOnly: true,
        qualifiers: { source: 'pLannotate-draft' },
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createOutlineOnlyDraftCdsGenome(): Genome {
  return {
    name: 'outline-only-plannotate-cds-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 42,
        type: 'CDS',
        start: 10,
        end: 90,
        direction: 'forward',
        displayName: 'draft CDS',
        color: 0x3b82f6,
        outlineOnly: true,
        qualifiers: { source: 'pLannotate-draft' },
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createTinyCircularGenesGenome(): Genome {
  return {
    name: 'tiny-circular-overview-aggregation-regression',
    length: 10_000,
    circular: true,
    features: [
      {
        id: 5,
        type: 'gene',
        start: 1000,
        end: 1500,
        direction: 'none',
        displayName: 'tiny-a',
        color: 0x22c55e,
        lane: 0,
      },
      {
        id: 6,
        type: 'gene',
        start: 4000,
        end: 4500,
        direction: 'none',
        displayName: 'tiny-b',
        color: 0x22c55e,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(10_000),
  };
}

function createPartialCoverageCircularGeneGenome(): Genome {
  return {
    name: 'partial-density-atlas-coverage-regression',
    length: 10_000,
    circular: true,
    features: [
      {
        id: 15,
        type: 'gene',
        start: 1000,
        end: 1300,
        direction: 'none',
        displayName: 'partial-density',
        color: 0x22c55e,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(10_000),
  };
}

function createSplicedLinearCdsGenome(): Genome {
  return {
    name: 'spliced-linear-cds-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 7,
        type: 'CDS',
        start: 10,
        end: 90,
        direction: 'forward',
        displayName: 'Spliced CDS',
        color: 0x3b82f6,
        lane: 0,
        segments: [
          { start: 11, end: 30 },
          { start: 60, end: 90 },
        ],
        qualifiers: { _locationString: 'join(11..30,60..90)' },
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createOriginSpanningSplicedCdsGenome(): Genome {
  return {
    name: 'origin-spanning-spliced-cds-regression',
    length: 603,
    circular: true,
    features: [
      {
        id: 19,
        type: 'CDS',
        start: 450,
        end: 250,
        direction: 'forward',
        displayName: 'OriginSpanGene',
        color: 0x3b82f6,
        lane: 0,
        segments: [
          { start: 451, end: 558 },
          { start: 101, end: 250 },
        ],
        qualifiers: { _locationString: 'join(451..558,101..250)' },
      },
    ],
    sequence: 'A'.repeat(603),
  };
}

function createCloseSplicedLinearCdsGenome(): Genome {
  return {
    name: 'close-spliced-linear-cds-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 17,
        type: 'CDS',
        start: 10,
        end: 80,
        direction: 'forward',
        displayName: 'CDS',
        color: 0x3b82f6,
        lane: 0,
        segments: [
          { start: 11, end: 20 },
          { start: 25, end: 35 },
        ],
        qualifiers: { _locationString: 'join(11..20,25..35)' },
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function createRightEdgeCdsGenome(): Genome {
  return {
    name: 'linear-cds-right-edge-regression',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 8,
        type: 'CDS',
        start: 76,
        end: 150,
        direction: 'forward',
        displayName: 'Right Edge CDS',
        color: 0x3b82f6,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
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

function createSegmentedArcPath(pixelsPerBp = 1): PathMapper {
  const y = 100;
  const posAt = (bp: number, offset: number) => ({
    x: (bp - 0) * pixelsPerBp,
    y: y + offset,
    angle: 0,
  });
  return {
    ...createLinearPath(pixelsPerBp),
    isArcMode: true,
    featureLabelPosAt: posAt,
    featurePolygonAt: (startBp: number, endBp: number, offset: number, halfHeight = 7) => {
      const startX = startBp * pixelsPerBp;
      const midX = ((startBp + endBp) / 2) * pixelsPerBp;
      const endX = endBp * pixelsPerBp;
      const cy = y + offset;
      return [
        startX,
        cy - halfHeight,
        midX,
        cy - halfHeight,
        endX,
        cy - halfHeight,
        endX,
        cy + halfHeight,
        midX,
        cy + halfHeight,
        startX,
        cy + halfHeight,
      ];
    },
  } as PathMapper;
}

function createOverviewArcPath(pixelsPerBp = 0.001): PathMapper {
  const base = createLinearPath(pixelsPerBp);
  return {
    ...base,
    isArcMode: true,
  };
}

function createCountingSequenceArcPath(params: {
  viewStartBp: number;
  viewEndBp: number;
  pixelsPerBp: number;
  visibleSpy: (startBp: number, featureLenBp: number) => void;
}): PathMapper {
  const base = createLinearPath(params.pixelsPerBp, params.viewStartBp);
  return {
    ...base,
    isArcMode: true,
    sequenceVisible: true,
    sequenceOpacity: 1,
    viewStartBp: params.viewStartBp,
    viewEndBp: params.viewEndBp,
    pixelsPerBp: params.pixelsPerBp,
    isFeatureVisible: (startBp: number, featureLenBp: number) => {
      params.visibleSpy(startBp, featureLenBp);
      const endBp = startBp + featureLenBp;
      return endBp >= params.viewStartBp && startBp <= params.viewEndBp;
    },
  };
}

function createTwoSampleArcPath(pixelsPerBp = 1): PathMapper {
  const y = 100;
  const posAt = (bp: number, offset: number) => ({
    x: bp * pixelsPerBp,
    y: y + offset,
    angle: 0,
  });
  return {
    ...createLinearPath(pixelsPerBp),
    isArcMode: true,
    featureLabelPosAt: posAt,
    featurePolygonAt: (startBp: number, endBp: number, offset: number, halfHeight = 7) => {
      const start = posAt(startBp, offset);
      const end = posAt(endBp, offset);
      return [
        start.x,
        start.y - halfHeight,
        end.x,
        end.y - halfHeight,
        end.x,
        end.y + halfHeight,
        start.x,
        start.y + halfHeight,
      ];
    },
  } as PathMapper;
}

function createClippedArcPath(pixelsPerBp = 10, viewStartBp = 20): PathMapper {
  const y = 100;
  const posAt = (bp: number, offset: number) => ({
    x: (bp - viewStartBp) * pixelsPerBp,
    y: y + offset + Math.sin(bp / 8) * 4,
    angle: 0.15,
  });
  return {
    ...createLinearPath(pixelsPerBp, viewStartBp),
    isArcMode: true,
    featureLabelPosAt: posAt,
    featurePolygonAt: (startBp: number, endBp: number, offset: number, halfHeight = 7) => {
      const start = posAt(startBp, offset);
      const end = posAt(endBp, offset);
      return [
        start.x,
        start.y - halfHeight,
        end.x,
        end.y - halfHeight,
        end.x,
        end.y + halfHeight,
        start.x,
        start.y + halfHeight,
      ];
    },
  } as unknown as PathMapper;
}

function createNonlinearArcPath(): PathMapper {
  const y = 100;
  const posAt = (bp: number, offset: number) => ({
    x: (Math.exp((bp - 10) / 20) - 1) * 10,
    y: y + offset,
    angle: 0,
  });
  return {
    ...createLinearPath(1),
    isArcMode: true,
    featureLabelPosAt: posAt,
    featurePolygonAt: (startBp: number, endBp: number, offset: number, halfHeight = 7) => {
      const start = posAt(startBp, offset);
      const end = posAt(endBp, offset);
      return [
        start.x,
        start.y - halfHeight,
        end.x,
        end.y - halfHeight,
        end.x,
        end.y + halfHeight,
        start.x,
        start.y + halfHeight,
      ];
    },
  } as unknown as PathMapper;
}

function createCompactAnnotationLayout(): UnifiedLayout {
  return {
    compactScale: 0.5,
    annotationOffset: 0,
    annotationStep: 16,
    cdsBarOffset: 0,
    cdsLaneStep: 30,
  } as UnifiedLayout;
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

function averageEdgeLength(pts: number[]): number {
  const pointCount = pts.length / 2;
  const edgePointCount = pointCount / 2;
  const edgeLength = (start: number, end: number) => {
    let total = 0;
    for (let i = start + 1; i < end; i++) {
      const ax = pts[(i - 1) * 2];
      const ay = pts[(i - 1) * 2 + 1];
      const bx = pts[i * 2];
      const by = pts[i * 2 + 1];
      total += Math.hypot(bx - ax, by - ay);
    }
    return total;
  };
  return (edgeLength(0, edgePointCount) + edgeLength(edgePointCount, pointCount)) / 2;
}

describe('AnnotationOverlay curved labels', () => {
  it('does not scan every MG1655-scale feature when rendering sequence-level annotations', () => {
    const overlay = new AnnotationOverlayClass();
    const genomeLength = 1_000_000;
    const features: Feature[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: index + 1,
      type: 'gene',
      start: index * 100,
      end: index * 100 + 30,
      direction: 'none',
      displayName: '',
      color: 0x22c55e,
      lane: 0,
    }));
    const genome: Genome = {
      name: 'sequence-lod-feature-window-index-regression',
      length: genomeLength,
      circular: true,
      features,
      sequence: 'A'.repeat(genomeLength),
    };
    const visibleSpy = vi.fn();
    const path = {
      ...createCountingSequenceArcPath({
        viewStartBp: 500_000,
        viewEndBp: 502_000,
        pixelsPerBp: 1.6,
        visibleSpy,
      }),
      sequenceVisible: false,
    };

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(true));
    overlay.render(path, createState(), 0, 400);

    expect(overlay.getDebugSnapshot().featureCount).toBe(10_000);
    expect(visibleSpy.mock.calls.length).toBeGreaterThan(0);
    expect(visibleSpy.mock.calls.length).toBeLessThan(150);

    overlay.destroy();
  });

  it('keeps minimum-width overview annotations visually stable on straight and curved stadium segments', () => {
    const overlay = new AnnotationOverlayClass();
    const state = { ...createState(), zoom: 0.32 };
    const dims = getStadiumDimensionsFn(state.width, state.height, state.morph, 80);
    const topEnd = dims.straightLength / dims.totalLength;
    const rightCapEnd = (dims.straightLength + Math.PI * dims.radius) / dims.totalLength;
    const straightBp = Math.floor(topEnd * 0.5 * GENOME_LENGTH);
    const capBp = Math.floor((topEnd + (rightCapEnd - topEnd) * 0.5) * GENOME_LENGTH);
    const genome: Genome = {
      name: 'tiny-overview-width-stability-regression',
      length: GENOME_LENGTH,
      circular: true,
      features: [
        {
          id: 70,
          type: 'gene',
          start: straightBp,
          end: straightBp + 1,
          direction: 'none',
          displayName: 'straight tiny',
          color: 0x3b82f6,
          lane: 0,
        },
        {
          id: 71,
          type: 'gene',
          start: capBp,
          end: capBp + 1,
          direction: 'none',
          displayName: 'cap tiny',
          color: 0x3b82f6,
          lane: 0,
        },
      ],
      sequence: 'A'.repeat(GENOME_LENGTH),
    };
    const path = createPath(state, genome);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const polygons = polySpy.mock.calls.map((call) => call[0] as number[]);
    expect(polygons).toHaveLength(2);
    const [straightWidth, capWidth] = polygons.map(averageEdgeLength);
    expect(Math.abs(straightWidth - capWidth)).toBeLessThanOrEqual(0.25);

    overlay.destroy();
  });

  it('draws a dotted outline on filled authored draft annotations', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'pixi-authored-draft-outline-regression',
      length: GENOME_LENGTH,
      circular: true,
      features: [
        {
          id: 72,
          type: 'gene',
          start: 100,
          end: 180,
          direction: 'none',
          displayName: '',
          color: 0x22c55e,
          lane: 0,
          qualifiers: { source: 'annotation-draft' },
        },
      ],
      sequence: 'A'.repeat(GENOME_LENGTH),
    };
    const state = createState();
    const path = createPath(state, genome);
    const graphics = (
      overlay as unknown as {
        graphics: {
          fill: (...args: unknown[]) => unknown;
          lineTo: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');
    const lineToSpy = vi.spyOn(graphics, 'lineTo');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(fillSpy).toHaveBeenCalled();
    expect(lineToSpy).toHaveBeenCalled();

    overlay.destroy();
  });

  it('joins the stadium CDS connector to the wrapped-style pill bottom and codon top', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createLinearCdsGenome();
    const state = createState();
    const path = { ...createLinearPath(10), isArcMode: true };
    const presenter = overlay.getImmediateDrawPresenterForTest();
    const band = vi.spyOn(presenter, 'drawLaneBandWithGaps');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(band).toHaveBeenCalledTimes(1);
    const [, , , , offset, halfHeight] = band.mock.calls[0];
    const pillBottom =
      presenter.featureOffset(genomeFeatures(genome)[0]) + presenter.scaledBarHeight() / 2;
    expect(halfHeight * 2).toBeCloseTo(4.5, 10);
    expect(offset + halfHeight).toBeCloseTo(pillBottom, 10);
    overlay.destroy();
  });

  it.each([false, true])(
    'routes the painted CDS connector through the pill pointer actions (arc=%s)',
    (isArcMode) => {
      const overlay = new AnnotationOverlayClass();
      const genome = createLinearCdsGenome();
      const feature = genomeFeatures(genome)[0];
      const state = createState();
      const path = { ...createLinearPath(10), isArcMode };
      const draw = overlay.getImmediateDrawPresenterForTest();
      const band = vi.spyOn(draw, 'drawLaneBandWithGaps');
      overlay.loadGenome(genome);
      overlay.render(path, state, 0, state.height);
      const [, , start, end, offset] = band.mock.calls[0];
      const point = path.featureLabelPosAt((start + end) / 2, offset);
      const expected = { id: feature.id, start: feature.start, end: feature.end };
      const pill = draw.labelOccupancyCache.find((p) => p.kind === 'cds-label-pill')!;
      expect(point.x).toBeGreaterThan(pill.xMax);
      const pillHit = overlay.hitTest(
        (pill.xMin + pill.xMax) / 2,
        (pill.yMin + pill.yMax) / 2,
        path,
        state
      );
      expect(overlay.hitTest(point.x, point.y, path, state)).toEqual(pillHit);
      expect(pillHit).toEqual({ kind: 'feature', payload: expected });

      let gestureTime = 1000;
      const gestureClock = vi.spyOn(performance, 'now').mockImplementation(() => gestureTime);
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const interaction = setupInteraction(canvas, state);
      interaction.genomeLength = genome.length;
      interaction.genomeCircular = false;
      interaction.screenToBp = () => (start + end) / 2;
      interaction.hitTestFn = (x, y) => overlay.hitTest(x, y, path, state);
      const hover = vi.fn(),
        click = vi.fn(),
        commit = vi.fn(),
        menu = vi.fn();
      interaction.onHoverFeature = hover;
      interaction.onFeatureClick = click;
      interaction.onFeatureRangeCommit = commit;
      interaction.onContextMenu = menu;
      const pointer = (type: string, button = 0) =>
        canvas.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button,
            clientX: point.x,
            clientY: point.y,
          })
        );
      try {
        pointer('pointermove');
        interaction.flushInteraction();
        expect(hover).toHaveBeenCalledWith(expected, point.x, point.y);
        expect(canvas.style.cursor).toBe('pointer');
        pointer('pointerdown');
        gestureTime += 16;
        pointer('pointerup');
        expect(click).toHaveBeenCalledWith(expected);
        expect([...state.selectedIds]).toEqual([feature.id]);
        pointer('dblclick');
        expect(commit).toHaveBeenCalledWith(expected);
        expect(state.highlightRange).toEqual([feature.start, feature.end - 1]);
        pointer('contextmenu', 2);
        expect(menu.mock.calls[0][1]).toMatchObject({
          hitResult: pillHit,
          highlightRange: [feature.start, feature.end - 1],
        });
      } finally {
        interaction.cleanup();
        canvas.remove();
        overlay.destroy();
        gestureClock.mockRestore();
      }
    }
  );

  it('uses curved glyphs on the Canvas-style CDS pill and thin connector in stadium mode', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createCapCdsGenome();
    const state = createState();
    const path = createPath(state, genome);
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const debug = overlay.getDebugSnapshot();
    const rotations = debug.curvedGlyphRotations;
    const rotationSpan = Math.max(...rotations) - Math.min(...rotations);

    expect(debug.straightLabelCount).toBe(0);
    expect(debug.curvedGlyphCount).toBeGreaterThan(4);
    expect(new Set(debug.curvedGlyphFontSizes)).toEqual(new Set([16]));
    expect(debug.curvedGlyphScales.every((scale) => Math.abs(scale - 10 / 16) < 1e-6)).toBe(true);
    expect(Math.min(...debug.curvedGlyphResolutions)).toBeGreaterThanOrEqual(2);
    expect(rotationSpan).toBeGreaterThan(0.1);
    expect(polySpy).toHaveBeenCalledTimes(2);

    overlay.destroy();
  });

  it('keeps equal-width curved label spacing continuous across straight-to-curve transitions', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTransitionCdsGenome();
    const state = createState();
    const path = createPath(state, genome);

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const positions = overlay.getDebugSnapshot().curvedGlyphPositions;
    const gaps: number[] = [];
    for (let i = 1; i < positions.length; i++) {
      gaps.push(
        Math.hypot(positions[i].x - positions[i - 1].x, positions[i].y - positions[i - 1].y)
      );
    }

    expect(gaps.length).toBeGreaterThan(4);
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.35);

    overlay.destroy();
  });

  it('renders straight annotation labels sharply without a second CDS background fill', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createLinearCdsGenome();
    const state = createState();
    const path = createLinearPath();
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const debug = overlay.getDebugSnapshot();
    expect(polySpy).toHaveBeenCalledTimes(1);
    expect(debug.straightLabelCount).toBe(1);
    expect(debug.straightLabelAlphas).toEqual([1]);
    expect(Math.min(...debug.straightLabelResolutions)).toBeGreaterThanOrEqual(2);

    overlay.destroy();
  });

  it('splits origin-spanning circular annotations into both ends of the flat linear map', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'linearized-circular-origin-span-regression',
      length: GENOME_LENGTH,
      circular: true,
      features: [
        {
          id: 90,
          type: 'gene',
          start: 900,
          end: 100,
          direction: 'none',
          displayName: '',
          color: 0x22c55e,
          lane: 0,
        },
      ],
      sequence: 'A'.repeat(GENOME_LENGTH),
    };
    const state = createState();
    const path = createLinearPath(1, 0);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(polySpy).toHaveBeenCalledTimes(2);
    const xRanges = polySpy.mock.calls
      .map((call) => (call[0] as number[]).filter((_, index) => index % 2 === 0))
      .map((xs) => [Math.min(...xs), Math.max(...xs)])
      .sort((a, b) => a[0] - b[0]);
    expect(xRanges).toEqual([
      [0, 100],
      [900, 1000],
    ]);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      drawnFeatureCount: 2,
      hitRecords: 2,
    });
    const hitCache = (
      overlay as unknown as {
        hitCache: Array<{ id: number; start: number; end: number; xMin: number; xMax: number }>;
      }
    ).hitCache;
    expect(
      hitCache.map((record) => ({ id: record.id, start: record.start, end: record.end }))
    ).toEqual([
      { id: 90, start: 900, end: 100 },
      { id: 90, start: 900, end: 100 },
    ]);

    overlay.destroy();
  });

  it('splits origin-spanning spliced CDS annotations without filling origin-side gaps', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createOriginSpanningSplicedCdsGenome();
    const state = createState();
    const path = createLinearPath(1, 0);

    overlay.loadGenome(genome);
    overlay.setLayout({ ...createAnnotationLayout(true, 1), sequenceOpacity: 1 });
    overlay.render(path, state, 0, state.height);

    expect(overlay.hitTest(500, 86, path, state)).toMatchObject({
      kind: 'feature',
      payload: { id: 19 },
    });
    expect(overlay.hitTest(150, 86, path, state)).toMatchObject({
      kind: 'feature',
      payload: { id: 19 },
    });
    expect(
      overlay.hitTest(50, 86, path, state),
      'gap before the post-origin exon must not be painted or hittable'
    ).toBeNull();
    expect(
      overlay.hitTest(580, 86, path, state),
      'gap after the pre-origin exon must not be painted or hittable'
    ).toBeNull();

    overlay.destroy();
  });

  it('renders CDSs as feature-level annotation shapes when sequence detail is hidden', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createFeatureLevelCdsGenome();
    const state = createState();
    state.hoveredId = 30;
    const path = createLinearPath(10);
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (...args: unknown[]) => unknown;
          roundRect: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const interactionGraphics = (
      overlay as unknown as {
        interactionGraphics: {
          poly: (...args: unknown[]) => unknown;
          rect: (...args: unknown[]) => unknown;
        };
      }
    ).interactionGraphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const roundRectSpy = vi.spyOn(graphics, 'roundRect');
    const outlinePolySpy = vi.spyOn(interactionGraphics, 'poly');
    const outlineRectSpy = vi.spyOn(interactionGraphics, 'rect');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.render(path, state, 0, state.height);

    expect(polySpy).toHaveBeenCalledTimes(2);
    expect(roundRectSpy).not.toHaveBeenCalled();
    const hitIds = (
      overlay as unknown as {
        hitCache: Array<{ id: number }>;
      }
    ).hitCache.map((record) => record.id);
    expect(hitIds).toEqual([30, 31]);
    expect(outlinePolySpy).toHaveBeenCalled();
    expect(outlineRectSpy).not.toHaveBeenCalled();

    overlay.destroy();
  });

  it('moves CDS label pill and text from feature position into label-strip position during reveal', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createDirectionalLinearCdsGenome('forward');
    const state = createState();
    const path = createLinearPath();
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (...args: unknown[]) => unknown;
          roundRect: (...args: unknown[]) => unknown;
          fill: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const roundRectSpy = vi.spyOn(graphics, 'roundRect');
    const fillSpy = vi.spyOn(graphics, 'fill');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false, 0.5));
    overlay.render(path, state, 0, state.height);

    expect(polySpy).toHaveBeenCalledTimes(3);
    expect(roundRectSpy).not.toHaveBeenCalled();
    const transitionPts = polySpy.mock.calls[0][0] as number[];
    const transitionYs = transitionPts.filter((_, index) => index % 2 === 1);
    const transitionHeight = Math.max(...transitionYs) - Math.min(...transitionYs);
    expect(transitionHeight).toBeGreaterThan(5);
    expect(transitionHeight).toBeLessThan(14);
    for (const shellCall of polySpy.mock.calls.slice(1)) {
      const shellYs = (shellCall[0] as number[]).filter((_, index) => index % 2 === 1);
      const shellMinY = Math.min(...shellYs);
      const shellMaxY = Math.max(...shellYs);
      expect(
        shellMaxY <= Math.min(...transitionYs) + 1e-6 ||
          shellMinY >= Math.max(...transitionYs) - 1e-6
      ).toBe(true);
    }
    const fillAlphas = fillSpy.mock.calls.map((call) => (call[0] as { alpha: number }).alpha);
    expect(fillAlphas).toEqual([0.85, 0.85, 0.85]);
    const debug = overlay.getDebugSnapshot();
    expect(debug.straightLabelCount).toBe(2);
    expect(debug.straightLabelAlphas).toContain(0.5);
    expect(debug.straightLabelAlphas).toContain(1);
    const labels = (
      overlay as unknown as {
        labelPool: Array<{ text: string; visible: boolean; x: number }>;
      }
    ).labelPool;
    const primaryLabel = labels.find((label) => label.visible && label.text === 'Linear Label');
    expect(primaryLabel).toBeDefined();
    expect(primaryLabel!.x).toBeGreaterThan(250);
    expect(primaryLabel!.x).toBeLessThan(450);

    overlay.destroy();
  });

  it('uses one compound hover outline during the CDS LOD transition', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createDirectionalLinearCdsGenome('forward');
    const state = createState();
    state.hoveredId = 3;
    const path = createLinearPath();
    const interactionGraphics = (
      overlay as unknown as {
        interactionGraphics: {
          poly: (...args: unknown[]) => unknown;
          roundRect: (...args: unknown[]) => unknown;
          stroke: (...args: unknown[]) => unknown;
        };
      }
    ).interactionGraphics;
    const outlinePolySpy = vi.spyOn(interactionGraphics, 'poly');
    const outlineRoundRectSpy = vi.spyOn(interactionGraphics, 'roundRect');
    const outlineStrokeSpy = vi.spyOn(interactionGraphics, 'stroke');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false, 0.5));
    overlay.render(path, state, 0, state.height);

    expect(outlinePolySpy).toHaveBeenCalledTimes(1);
    expect(outlineStrokeSpy).toHaveBeenCalledTimes(1);
    expect(outlineRoundRectSpy).not.toHaveBeenCalled();

    overlay.destroy();
  });

  it.each(['forward', 'reverse'] as const)(
    'joins the pill, line and codon selection into one outside contour on the %s strand',
    (direction) => {
      const overlay = new AnnotationOverlayClass();
      const track = new CodonTrack(new Container());
      const genome = createDirectionalLinearCdsGenome(direction);
      const feature = genomeFeatures(genome)[0];
      const state = createState();
      state.selectedIds.add(feature.id);
      const path = createLinearPath(4);
      const graphics = (
        overlay as unknown as {
          interactionGraphics: { poly: (...args: unknown[]) => void; stroke: () => void };
        }
      ).interactionGraphics;
      const polygons = vi.spyOn(graphics, 'poly'),
        strokes = vi.spyOn(graphics, 'stroke');
      overlay.loadGenome(genome);
      const codons = Array.from({ length: 23 }, (_, index) => ({
        startBp: 10 + index * 3,
        endBp: 13 + index * 3,
        codon: 'AAA',
        aa: 'K',
        isStart: false,
        isStop: false,
      }));
      for (const opacity of [0, 0.5, 1]) {
        overlay.setLayout(createAnnotationLayout(true));
        overlay.render(path, state, 0, state.height);
        track.reset();
        const contours = new Map<number, number[][]>();
        const offset = overlay.getFeatureRenderOffset(feature)! + 7 + (path.rowHeight * 0.9) / 2;
        track.renderCodons(
          feature,
          codons,
          path,
          offset,
          GENOME_LENGTH,
          state,
          opacity,
          0,
          Infinity,
          (points) => contours.set(feature.id, [points])
        );
        if (opacity === 0) {
          expect(contours.size).toBe(0);
          const own = overlay
            .getDebugSnapshot()
            .interactionContours.filter((contour) => contour.featureId === feature.id);
          expect(own).toHaveLength(1);
          const ys = own[0].points.filter((_, i) => i % 2 === 1);
          expect(Math.max(...ys)).toBeLessThanOrEqual(
            100 + offset - (path.rowHeight * 0.9) / 2 + 1e-6
          );
          continue;
        }
        polygons.mockClear();
        strokes.mockClear();
        overlay.renderCompoundCdsInteractionOutlines(path, state, contours);
        expect(polygons).toHaveBeenCalledTimes(1);
        expect(strokes).toHaveBeenCalledTimes(1);
        const flat = polygons.mock.calls[0][0] as number[];
        const points = Array.from({ length: flat.length / 2 }, (_, i) => ({
          x: flat[i * 2],
          y: flat[i * 2 + 1],
        }));
        expect(Math.min(...points.map((p) => p.y))).toBeLessThan(
          100 + offset - (path.rowHeight * 0.9) / 2
        );
        expect(Math.max(...points.map((p) => p.y))).toBeCloseTo(
          100 + offset + (path.rowHeight * 0.9) / 2
        );
        const cross = (
          a: (typeof points)[number],
          b: (typeof points)[number],
          c: (typeof points)[number]
        ) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        for (let i = 0; i < points.length; i++)
          for (let j = i + 2; j < points.length; j++) {
            if (i === 0 && j === points.length - 1) continue;
            const a = points[i],
              b = points[(i + 1) % points.length],
              c = points[j],
              d = points[(j + 1) % points.length];
            expect(
              cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8
            ).toBe(false);
          }
      }
      track.destroy();
      overlay.destroy();
    }
  );

  it('includes the directional CDS tip in the transition hover outline', () => {
    for (const direction of ['forward', 'reverse'] as const) {
      const overlay = new AnnotationOverlayClass();
      const genome = createDirectionalLinearCdsGenome(direction);
      const state = createState();
      state.hoveredId = 3;
      const path = createLinearPath();
      const interactionGraphics = (
        overlay as unknown as {
          interactionGraphics: {
            poly: (...args: unknown[]) => unknown;
            stroke: (...args: unknown[]) => unknown;
          };
        }
      ).interactionGraphics;
      const outlinePolySpy = vi.spyOn(interactionGraphics, 'poly');

      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false, 0.5));
      overlay.render(path, state, 0, state.height);

      expect(outlinePolySpy).toHaveBeenCalledTimes(1);
      const points = outlinePolySpy.mock.calls[0][0] as number[];
      const xs = points.filter((_, index) => index % 2 === 0);
      if (direction === 'forward') {
        expect(Math.max(...xs)).toBeCloseTo(path.bpLeftX(80), 5);
      } else {
        expect(Math.min(...xs)).toBeCloseTo(path.bpLeftX(10), 5);
      }

      overlay.destroy();
    }
  });

  it('does not backtrack directional feature-level hover outlines past arc arrow cuts', () => {
    for (const direction of ['forward', 'reverse'] as const) {
      const overlay = new AnnotationOverlayClass();
      const genome = createDirectionalArcCdsGenome(direction);
      const state = createState();
      state.hoveredId = 40;
      const path = createSegmentedArcPath();
      const interactionGraphics = (
        overlay as unknown as {
          interactionGraphics: {
            poly: (...args: unknown[]) => unknown;
          };
        }
      ).interactionGraphics;
      const outlinePolySpy = vi.spyOn(interactionGraphics, 'poly');

      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));
      overlay.render(path, state, 0, state.height);

      expect(outlinePolySpy).toHaveBeenCalledTimes(1);
      const points = outlinePolySpy.mock.calls[0][0] as number[];
      const pairs: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < points.length; i += 2) pairs.push({ x: points[i], y: points[i + 1] });
      const centerY = path.featureLabelPosAt(10, -20).y;
      const arrowWidth = 8;
      if (direction === 'forward') {
        const topXs = pairs
          .filter((point) => Math.abs(point.y - (centerY - 7)) < 1e-6)
          .map((point) => point.x);
        expect(Math.max(...topXs)).toBeLessThanOrEqual(80 - arrowWidth + 1e-6);
        expect(Math.max(...pairs.map((point) => point.x))).toBeCloseTo(80, 5);
      } else {
        const bottomXs = pairs
          .filter((point) => Math.abs(point.y - (centerY + 7)) < 1e-6)
          .map((point) => point.x);
        expect(Math.min(...bottomXs)).toBeGreaterThanOrEqual(10 + arrowWidth - 1e-6);
        expect(Math.min(...pairs.map((point) => point.x))).toBeCloseTo(10, 5);
      }

      overlay.destroy();
    }
  });

  it('draws directional CDS chevrons on two-sample straight stadium spans', () => {
    for (const direction of ['forward', 'reverse'] as const) {
      const overlay = new AnnotationOverlayClass();
      const genome = createDirectionalArcCdsGenome(direction);
      const state = createState();
      state.hoveredId = 40;
      const path = createTwoSampleArcPath();
      const graphics = (
        overlay as unknown as {
          graphics: {
            poly: (...args: unknown[]) => unknown;
          };
        }
      ).graphics;
      const interactionGraphics = (
        overlay as unknown as {
          interactionGraphics: {
            poly: (...args: unknown[]) => unknown;
          };
        }
      ).interactionGraphics;
      const fillPolySpy = vi.spyOn(graphics, 'poly');
      const outlinePolySpy = vi.spyOn(interactionGraphics, 'poly');

      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));
      overlay.render(path, state, 0, state.height);

      expect(fillPolySpy).toHaveBeenCalled();
      expect(outlinePolySpy).toHaveBeenCalledTimes(1);

      const fillPts = fillPolySpy.mock.calls[0][0] as number[];
      const outlinePts = outlinePolySpy.mock.calls[0][0] as number[];
      expect(fillPts).toHaveLength(10);
      expect(outlinePts).toEqual(fillPts);

      const pairs: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < fillPts.length; i += 2) pairs.push({ x: fillPts[i], y: fillPts[i + 1] });
      const centerY = path.featureLabelPosAt(10, -20).y;
      const arrowWidth = 8;
      if (direction === 'forward') {
        const topXs = pairs
          .filter((point) => Math.abs(point.y - (centerY - 7)) < 1e-6)
          .map((point) => point.x);
        expect(Math.max(...pairs.map((point) => point.x))).toBeCloseTo(80, 5);
        expect(Math.max(...topXs)).toBeCloseTo(80 - arrowWidth, 5);
      } else {
        const bottomXs = pairs
          .filter((point) => Math.abs(point.y - (centerY + 7)) < 1e-6)
          .map((point) => point.x);
        expect(Math.min(...pairs.map((point) => point.x))).toBeCloseTo(10, 5);
        expect(Math.min(...bottomXs)).toBeCloseTo(10 + arrowWidth, 5);
      }

      overlay.destroy();
    }
  });

  it('draws directional standard annotation chevrons on two-sample straight stadium spans', () => {
    for (const direction of ['forward', 'reverse'] as const) {
      const overlay = new AnnotationOverlayClass();
      const genome = createDirectionalArcGeneGenome(direction);
      const state = createState();
      state.hoveredId = 43;
      const path = createTwoSampleArcPath();
      const graphics = (
        overlay as unknown as {
          graphics: {
            poly: (...args: unknown[]) => unknown;
          };
        }
      ).graphics;
      const interactionGraphics = (
        overlay as unknown as {
          interactionGraphics: {
            poly: (...args: unknown[]) => unknown;
          };
        }
      ).interactionGraphics;
      const fillPolySpy = vi.spyOn(graphics, 'poly');
      const outlinePolySpy = vi.spyOn(interactionGraphics, 'poly');

      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));
      overlay.render(path, state, 0, state.height);

      const fillPts = fillPolySpy.mock.calls[0][0] as number[];
      const outlinePts = outlinePolySpy.mock.calls[0][0] as number[];
      expect(fillPts).toHaveLength(10);
      expect(outlinePts).toEqual(fillPts);

      overlay.destroy();
    }
  });

  it('uses identical opacity for the WebGL CDS connector and label pill', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createDirectionalLinearCdsGenome('forward');
    const state = createState();
    const path = createLinearPath();
    const graphics = (
      overlay as unknown as {
        graphics: { fill: (...args: unknown[]) => unknown };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(true));
    overlay.render(path, state, 0, state.height);

    const fillAlphas = fillSpy.mock.calls.map((call) => (call[0] as { alpha: number }).alpha);
    expect(fillAlphas).toEqual([0.85, 0.85]);

    overlay.destroy();
  });

  it('uses dark-mode annotation colors for WebGL fills', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createDirectionalLinearCdsGenome('forward');
    const state = { ...createState(), themeMode: 'dark' as const };
    const path = createLinearPath();
    const graphics = (
      overlay as unknown as {
        graphics: { fill: (...args: unknown[]) => unknown };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(true));
    overlay.render(path, state, 0, state.height);

    const fillColors = fillSpy.mock.calls
      .map((call) => (call[0] as { color?: number } | undefined)?.color)
      .filter((color): color is number => typeof color === 'number');
    expect(fillColors).toContain(0x1e3862);
    expect(fillColors).not.toContain(0x3b82f6);

    overlay.destroy();
  });

  it('keeps a subclassed non-RNA row on source-shape color in the live renderer', () => {
    const overlay = new AnnotationOverlayClass();
    const color = featureTypeColor('regulatory');
    const genome: Genome = {
      name: 'regulatory-enhancer-color-parity',
      length: GENOME_LENGTH,
      circular: false,
      annotationLayerTypes: ['enhancer'],
      features: [
        {
          id: 81,
          type: 'regulatory',
          annotationTrackId: 'enhancer',
          start: 10,
          end: 80,
          direction: 'forward',
          displayName: 'enhancer-classified row',
          color,
          lane: 0,
          exons: [{ start: 11, end: 80 }],
        },
      ],
    };
    const state = createState();
    const graphics = (
      overlay as unknown as {
        graphics: { fill: (...args: unknown[]) => unknown };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.render(createLinearPath(), state, 0, state.height);

    const fillColors = fillSpy.mock.calls
      .map((call) => (call[0] as { color?: number } | undefined)?.color)
      .filter((candidate): candidate is number => typeof candidate === 'number');
    expect(fillColors).toContain(color);
    expect(
      (overlay as unknown as { lastImmediateTranscriptDrawnCount: number })
        .lastImmediateTranscriptDrawnCount
    ).toBe(0);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      immediateDrawnLayerTypes: ['regulatory'],
    });
    expect(annotationTypeBadgeStyle('regulatory', 'light').background).toBe('#14b8a6');

    overlay.destroy();
  });

  it('puts the WebGL forward CDS direction glyph inside the label pill', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createDirectionalLinearCdsGenome('forward');
    const state = createState();
    const path = createLinearPath();

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(true));
    overlay.render(path, state, 0, state.height);

    const labels = (overlay as unknown as { labelPool: Array<{ text: string; visible: boolean }> })
      .labelPool;
    const visibleTexts = labels.filter((label) => label.visible).map((label) => label.text);
    expect(visibleTexts).toContain('»');
    expect(visibleTexts).toContain('Linear Label');

    overlay.destroy();
  });

  it('puts the WebGL reverse CDS direction glyph inside the label pill', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createDirectionalLinearCdsGenome('reverse');
    const state = createState();
    const path = createLinearPath();

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(true));
    overlay.render(path, state, 0, state.height);

    const labels = (overlay as unknown as { labelPool: Array<{ text: string; visible: boolean }> })
      .labelPool;
    const visibleTexts = labels.filter((label) => label.visible).map((label) => label.text);
    expect(visibleTexts).toContain('«');
    expect(visibleTexts).toContain('Linear Label');

    overlay.destroy();
  });

  it('keeps the WebGL CDS direction glyph visible when the pill label truncates', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createDirectionalLinearCdsGenome('forward');
    const features = genomeFeatures(genome);
    features[0] = {
      ...features[0],
      displayName: 'Very Long CDS Label That Must Truncate Before Hiding Direction',
    };
    const state = createState();
    const path = createLinearPath(1);

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(true));
    overlay.render(path, state, 0, state.height);

    const labels = (overlay as unknown as { labelPool: Array<{ text: string; visible: boolean }> })
      .labelPool;
    const visibleTexts = labels.filter((label) => label.visible).map((label) => label.text);
    expect(visibleTexts).toContain('»');
    expect(visibleTexts.some((text) => text.endsWith('…'))).toBe(true);
    expect(visibleTexts.some((text) => text.includes('»') && text.length > 1)).toBe(false);

    overlay.destroy();
  });

  it('uses one compound CDS label-strip path for detail hover outlines', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createLinearCdsGenome();
    const state = createState();
    state.hoveredId = 3;
    const path = createLinearPath();
    const interactionGraphics = (
      overlay as unknown as {
        interactionGraphics: {
          poly: (...args: unknown[]) => unknown;
          roundRect: (...args: unknown[]) => unknown;
          rect: (...args: unknown[]) => unknown;
          stroke: (...args: unknown[]) => unknown;
        };
      }
    ).interactionGraphics;
    const outlinePolySpy = vi.spyOn(interactionGraphics, 'poly');
    const outlineRoundRectSpy = vi.spyOn(interactionGraphics, 'roundRect');
    const outlineRectSpy = vi.spyOn(interactionGraphics, 'rect');
    const outlineStrokeSpy = vi.spyOn(interactionGraphics, 'stroke');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(outlinePolySpy).toHaveBeenCalledTimes(1);
    expect(outlineStrokeSpy).toHaveBeenCalledTimes(1);
    expect(outlineRoundRectSpy).not.toHaveBeenCalled();
    expect(outlineRectSpy).not.toHaveBeenCalled();

    overlay.destroy();
  });

  it('keeps CDS lane position stable across feature/detail LOD transition', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createOverlappingCdsGeneGenome();
    overlay.loadGenome(genome);
    const internals = overlay as unknown as {
      features: Feature[];
      featureOffset: (feature: Feature) => number;
    };
    const cds = internals.features.find((feature) => feature.type === 'CDS');
    expect(cds).toBeDefined();

    const featureLayout = createAnnotationLayout(false);
    overlay.setLayout(featureLayout);
    const featureLodOffset = internals.featureOffset(cds!);

    const detailLayout = createAnnotationLayout(true);
    overlay.setLayout(detailLayout);
    const detailLodOffset = internals.featureOffset(cds!);

    expect(featureLodOffset).toBeCloseTo(detailLodOffset, 5);
    expect(featureLodOffset).toBeCloseTo(featureLayout.cdsBarOffset, 5);

    overlay.destroy();
  });

  it('clears annotation hit records immediately when features are removed from the genome', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createLinearCdsGenome();
    const emptyGenome: Genome = { ...genome, features: [] };
    const state = createState();
    const path = createLinearPath();

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);
    const hitCache = (
      overlay as unknown as {
        hitCache: Array<{ xMin: number; xMax: number; yMin: number; yMax: number }>;
      }
    ).hitCache;
    expect(hitCache).toHaveLength(1);
    const hitPoint = {
      x: (hitCache[0].xMin + hitCache[0].xMax) / 2,
      y: (hitCache[0].yMin + hitCache[0].yMax) / 2,
    };
    expect(overlay.hitTest(hitPoint.x, hitPoint.y, path, state)).toMatchObject({
      kind: 'feature',
      payload: { id: 3 },
    });

    overlay.loadGenome(emptyGenome);

    expect(overlay.hitTest(hitPoint.x, hitPoint.y, path, state)).toBeNull();

    overlay.destroy();
  });

  it('keeps sub-2px annotations full-height instead of collapsing into dots', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyLinearGeneGenome();
    const state = createState();
    const path = createLinearPath(1);
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (points: number[]) => unknown;
          rect: (x: number, y: number, w: number, h: number) => unknown;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const rectSpy = vi.spyOn(graphics, 'rect');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(rectSpy).not.toHaveBeenCalled();
    expect(polySpy).toHaveBeenCalledTimes(1);
    const points = polySpy.mock.calls[0][0] as number[];
    const xs = points.filter((_, index) => index % 2 === 0);
    const ys = points.filter((_, index) => index % 2 === 1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2, 5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(14, 5);

    overlay.destroy();
  });

  it('matches Canvas 2D annotation bar height and arrow depth for narrow directional features', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createNarrowForwardGeneGenome();
    const state = createState();
    const path = createLinearPath(1);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(polySpy).toHaveBeenCalledTimes(1);
    const points = polySpy.mock.calls[0][0] as number[];
    const xs = points.filter((_, index) => index % 2 === 0);
    const ys = points.filter((_, index) => index % 2 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(14, 5);
    expect(points[2]).toBeCloseTo(12.8, 5);
    expect(Math.max(...xs)).toBeCloseTo(14, 5);

    overlay.destroy();
  });

  it('keeps Canvas 2D annotation sizes even when the WebGL layout is compacted', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createNarrowForwardGeneGenome();
    const state = createState();
    const path = createLinearPath(1);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.setLayout(createCompactAnnotationLayout());
    overlay.render(path, state, 0, state.height);

    const points = polySpy.mock.calls[0][0] as number[];
    const ys = points.filter((_, index) => index % 2 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(14, 5);

    overlay.destroy();
  });

  it('keeps stadium annotation lanes visible instead of locally culling compact geometry', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createNarrowForwardGeneGenome();
    const state = createState();
    const normalBandRenderable = vi.fn(() => false);
    const path = {
      ...createTwoSampleArcPath(1),
      isNormalBandRenderable: normalBandRenderable,
    } satisfies PathMapper;
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.render(path, state, 0, state.height);

    expect(polySpy).toHaveBeenCalled();
    expect(normalBandRenderable).not.toHaveBeenCalled();

    overlay.destroy();
  });

  it('renders unchecked Plannotate draft annotations as path outlines without fill', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createOutlineOnlyDraftGeneGenome();
    const state = createState();
    const path = createLinearPath(2);
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (...args: unknown[]) => unknown;
          fill: (...args: unknown[]) => unknown;
          stroke: (...args: unknown[]) => unknown;
          setStrokeStyle: (...args: unknown[]) => unknown;
          lineTo: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');
    const strokeSpy = vi.spyOn(graphics, 'stroke');
    const strokeStyleSpy = vi.spyOn(graphics, 'setStrokeStyle');
    const lineToSpy = vi.spyOn(graphics, 'lineTo');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(fillSpy).not.toHaveBeenCalled();
    expect(strokeSpy.mock.calls.length).toBeGreaterThan(1);
    expect(lineToSpy).toHaveBeenCalled();
    expect(strokeStyleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ color: 0x22c55e, alpha: 0.9 })
    );
    const debug = overlay.getDebugSnapshot();
    expect(debug.straightLabelCount).toBe(1);

    overlay.destroy();
  });

  it('renders unchecked Plannotate CDS detail as one compound outside outline', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createOutlineOnlyDraftCdsGenome();
    const state = createState();
    const path = createLinearPath(5);
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (...args: unknown[]) => unknown;
          roundRect: (...args: unknown[]) => unknown;
          fill: (...args: unknown[]) => unknown;
          stroke: (...args: unknown[]) => unknown;
          lineTo: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const roundRectSpy = vi.spyOn(graphics, 'roundRect');
    const fillSpy = vi.spyOn(graphics, 'fill');
    const strokeSpy = vi.spyOn(graphics, 'stroke');
    const lineToSpy = vi.spyOn(graphics, 'lineTo');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(true));
    overlay.render(path, state, 0, state.height);

    expect(fillSpy).not.toHaveBeenCalled();
    expect(roundRectSpy).not.toHaveBeenCalled();
    expect(strokeSpy.mock.calls.length).toBeGreaterThan(1);
    expect(lineToSpy).toHaveBeenCalled();
    expect(polySpy).toHaveBeenCalledTimes(1);

    overlay.destroy();
  });

  it('renders unchecked Plannotate CDS LOD transition as one compound outside outline', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createOutlineOnlyDraftCdsGenome();
    const state = createState();
    const path = createLinearPath(5);
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (...args: unknown[]) => unknown;
          roundRect: (...args: unknown[]) => unknown;
          fill: (...args: unknown[]) => unknown;
          stroke: (...args: unknown[]) => unknown;
          lineTo: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const roundRectSpy = vi.spyOn(graphics, 'roundRect');
    const fillSpy = vi.spyOn(graphics, 'fill');
    const strokeSpy = vi.spyOn(graphics, 'stroke');
    const lineToSpy = vi.spyOn(graphics, 'lineTo');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false, 0.5));
    overlay.render(path, state, 0, state.height);

    expect(fillSpy).not.toHaveBeenCalled();
    expect(roundRectSpy).not.toHaveBeenCalled();
    expect(strokeSpy.mock.calls.length).toBeGreaterThan(1);
    expect(lineToSpy).toHaveBeenCalled();
    expect(polySpy).toHaveBeenCalledTimes(1);

    overlay.destroy();
  });

  it('keeps overview aggregation fine-grained enough for nearby tiny stadium annotations', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = createState();
    const path = createOverviewArcPath(0.001);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const debug = overlay.getDebugSnapshot();
    expect(debug.overviewDensityAtlasSampleScreenPx).toBe(0.25);
    expect(debug.overviewBinDrawCount).toBe(4);
    expect(polySpy).toHaveBeenCalledTimes(4);

    overlay.destroy();
  });

  it('draws selected outlines for features collapsed into stadium overview aggregation', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = createState();
    state.selectedIds.add(5);
    const path = createOverviewArcPath(0.001);
    const interactionGraphics = (
      overlay as unknown as { interactionGraphics: { poly: (...args: unknown[]) => unknown } }
    ).interactionGraphics;
    const outlinePolySpy = vi.spyOn(interactionGraphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const debug = overlay.getDebugSnapshot();
    expect(debug.overviewBinDrawCount).toBe(4);
    expect(debug.lastInteractionOutlineCommandCount).toBeGreaterThan(0);
    expect(outlinePolySpy).toHaveBeenCalled();

    overlay.destroy();
  });

  it('draws aggregated stadium overview annotations with curved polygons, not straight quads', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = createState();
    const path = createOverviewArcPath(0.001);
    const polygonSpy = vi.spyOn(path, 'featurePolygonAt');
    const quadSpy = vi.spyOn(path, 'featureQuadAt');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(overlay.getDebugSnapshot().overviewBinDrawCount).toBe(4);
    expect(polygonSpy).toHaveBeenCalled();
    expect(quadSpy).not.toHaveBeenCalled();

    overlay.destroy();
  });

  it('keeps aggregated overview annotations visible instead of locally culling compact geometry', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = createState();
    const normalBandRenderable = vi.fn(() => false);
    const path = {
      ...createOverviewArcPath(0.001),
      isNormalBandRenderable: normalBandRenderable,
    } as PathMapper;

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(overlay.getDebugSnapshot().overviewBinDrawCount).toBe(4);
    expect(normalBandRenderable).not.toHaveBeenCalled();

    overlay.destroy();
  });

  it('renders a spliced CDS name and continuous connector without exon pills or lengths', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createSplicedLinearCdsGenome();
    const state = createState();
    const path = createLinearPath(10);
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (...args: unknown[]) => unknown;
          roundRect: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const roundRectSpy = vi.spyOn(graphics, 'roundRect');
    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);
    expect(roundRectSpy).toHaveBeenCalledTimes(1);
    expect(polySpy).toHaveBeenCalledTimes(1);
    const [x, , width] = roundRectSpy.mock.calls[0] as number[];
    const xs = (polySpy.mock.calls[0][0] as number[]).filter((_, index) => index % 2 === 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(x + width - 3 - 1e-6);
    expect(Math.min(...xs)).toBeLessThan(x + width);
    for (const screenX of [105, 200, 450, 600]) {
      expect(overlay.hitTest(screenX, 86, path, state)).toMatchObject({
        kind: 'feature',
        payload: { id: 7, start: 10, end: 90 },
      });
    }
    overlay.destroy();
  });

  it('reserves spliced CDS label pill bounds for cross-track collision avoidance', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createSplicedLinearCdsGenome();
    const state = createState();
    const path = createLinearPath(10);

    resetLabelOccupancy(state);
    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const records = getLabelOccupancyRecords(state);
    expect(records.map((record) => record.kind)).toContain('cds-label-pill');
    expect(records.map((record) => record.kind)).not.toContain('exon-label-pill');
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        const a = records[i];
        const b = records[j];
        const overlap = a.xMin < b.xMax && a.xMax > b.xMin && a.yMin < b.yMax && a.yMax > b.yMin;
        expect(overlap, `${a.kind}:${a.text} overlaps ${b.kind}:${b.text}`).toBe(false);
      }
    }

    overlay.destroy();
  });

  it('replays spliced CDS label occupancy on cached renders', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createSplicedLinearCdsGenome();
    const state = createState();
    const path = createLinearPath(10);

    resetLabelOccupancy(state);
    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);
    const firstRecords = getLabelOccupancyRecords(state);
    expect(firstRecords.map((record) => record.kind)).toContain('cds-label-pill');
    expect(firstRecords.map((record) => record.kind)).not.toContain('exon-label-pill');

    resetLabelOccupancy(state);
    overlay.render(path, state, 0, state.height);
    const cachedRecords = getLabelOccupancyRecords(state);

    expect(cachedRecords).toEqual(firstRecords);

    overlay.destroy();
  });

  it('pins linear CDS label pills to the visible viewport edge while side-scrolling', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createLinearCdsGenome();
    const state = createState();
    const path = createLinearPath(10, 20);
    const graphics = (
      overlay as unknown as {
        graphics: { roundRect: (...args: unknown[]) => unknown };
      }
    ).graphics;
    const roundRectSpy = vi.spyOn(graphics, 'roundRect');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(roundRectSpy).toHaveBeenCalled();
    const [x] = roundRectSpy.mock.calls[0] as [number, number, number, number, number];
    expect(x).toBeCloseTo(0, 5);

    overlay.destroy();
  });

  it('places a spliced CDS label pill on its widest visible coding segment while side-scrolling', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createSplicedLinearCdsGenome();
    const state = createState();
    const path = createLinearPath(10, 20);
    const graphics = (
      overlay as unknown as {
        graphics: { roundRect: (...args: unknown[]) => unknown };
      }
    ).graphics;
    const roundRectSpy = vi.spyOn(graphics, 'roundRect');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(roundRectSpy).toHaveBeenCalled();
    const [x, , width] = roundRectSpy.mock.calls[0] as [number, number, number, number, number];
    expect(x).toBeGreaterThanOrEqual((60 - 20) * 10 - 15);
    expect(x + width).toBeLessThanOrEqual((90 - 20) * 10 + 10);

    overlay.destroy();
  });

  it.each(['linear', 'panned', 'close', 'origin', 'transition'] as const)(
    'keeps exon names and region lengths out of %s GPU label strips',
    (scene) => {
      const overlay = new AnnotationOverlayClass();
      const genome =
        scene === 'origin'
          ? createOriginSpanningSplicedCdsGenome()
          : scene === 'close'
            ? createCloseSplicedLinearCdsGenome()
            : createSplicedLinearCdsGenome();
      const state = createState();
      const path =
        scene === 'origin'
          ? createSegmentedArcPath(1)
          : createLinearPath(10, scene === 'panned' ? 55 : 0);
      const texts: string[] = [];
      const draw = overlay.getImmediateDrawPresenterForTest();
      const original = draw.drawLabelTextInPill.bind(draw);
      vi.spyOn(draw, 'drawLabelTextInPill').mockImplementation((...args) => {
        texts.push(args[1]);
        return original(...args);
      });
      overlay.loadGenome(genome);
      overlay.setLayout({
        ...createAnnotationLayout(true, scene === 'transition' ? 0.25 : 1),
        sequenceOpacity: scene === 'transition' ? 0.25 : 1,
      });
      overlay.render(path, state, 0, state.height);
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.some((text) => /^(exon|intron) \d|\(\d+ bp\)/i.test(text))).toBe(false);
      overlay.destroy();
    }
  );

  it('keeps linear CDS label pills inside the right viewport edge', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createRightEdgeCdsGenome();
    const state = createState();
    const path = createLinearPath(10);
    const graphics = (
      overlay as unknown as {
        graphics: { roundRect: (...args: unknown[]) => unknown };
      }
    ).graphics;
    const roundRectSpy = vi.spyOn(graphics, 'roundRect');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(roundRectSpy).toHaveBeenCalled();
    const [x, , width] = roundRectSpy.mock.calls[0] as [number, number, number, number, number];
    expect(x + width).toBeLessThanOrEqual(state.width);

    overlay.destroy();
  });

  it('hides appended exon pill labels once that exon is completely offscreen', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createSplicedLinearCdsGenome();
    const state = createState();
    const path = createLinearPath(10, 31);

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const staleExonHit = overlay.hitTest(95, 86, path, state);
    expect(staleExonHit).not.toMatchObject({
      kind: 'feature',
      payload: { id: 7, start: 10, end: 29 },
    });

    overlay.destroy();
  });

  it('pins circular CDS label pills to the same left viewport edge used by other lane pills', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createLinearCdsGenome();
    const state = createState();
    const path = createClippedArcPath(10, 20);
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(polySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const pillPoints = polySpy.mock.calls[1][0] as number[];
    const xs = pillPoints.filter((_, index) => index % 2 === 0);
    expect(Math.min(...xs)).toBeLessThan(1);
    expect(Math.min(...xs)).toBeGreaterThan(-2);
    expect(Math.max(...xs)).toBeLessThanOrEqual(state.width + 2);

    overlay.destroy();
  });

  it('starts circular CDS label pills at the same nucleotide boundary as their chevrons', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createDirectionalLinearCdsGenome('forward');
    const state = createState();
    const pixelsPerBp = 10;
    const path = createSegmentedArcPath(pixelsPerBp);
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(true));
    overlay.render(path, state, 0, state.height);

    const leftEdges = polySpy.mock.calls
      .map((call) => call[0] as number[])
      .map((points) => Math.min(...points.filter((_, index) => index % 2 === 0)));
    const expectedChevronStartX = (genomeFeatures(genome)[0].start - 0.5) * pixelsPerBp;

    expect(Math.min(...leftEdges)).toBeCloseTo(expectedChevronStartX, 5);

    overlay.destroy();
  });

  it('does not draw a wrapped CDS connector when the clamped label consumes the feature span', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createLongLabelCdsGenome();
    const state = createState();
    const path = createNonlinearArcPath();
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(polySpy).toHaveBeenCalledTimes(1);

    overlay.destroy();
  });

  it('reports annotation geometry rebuilds, cache hits, and rebuild reasons', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createLinearCdsGenome();
    const state = createState();
    const path = createLinearPath();

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(overlay.getDebugSnapshot()).toMatchObject({
      featureCount: 1,
      drawnFeatureCount: 1,
      hitRecords: 1,
      renderCalls: 1,
      geometryRebuilds: 1,
      geometryCacheHits: 0,
      lastRenderMode: 'rebuild',
      lastGeometryRebuildReasons: ['initial'],
    });

    overlay.render(path, state, 0, state.height);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      renderCalls: 2,
      geometryRebuilds: 1,
      geometryCacheHits: 1,
      lastRenderMode: 'cache-hit',
      lastGeometryRebuildReasons: [],
    });

    state.hoveredId = 3;
    overlay.render(path, state, 0, state.height);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      renderCalls: 3,
      geometryRebuilds: 1,
      geometryCacheHits: 2,
      lastRenderMode: 'cache-hit',
    });

    state.themeMode = 'dark';
    overlay.render(path, state, 0, state.height);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      renderCalls: 4,
      geometryRebuilds: 2,
      geometryCacheHits: 2,
      lastRenderMode: 'rebuild',
      lastGeometryRebuildReasons: ['themeMode'],
    });

    state.viewOffset = 0.25;
    overlay.render(path, state, 0, state.height);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      renderCalls: 5,
      geometryRebuilds: 3,
      geometryCacheHits: 2,
      lastRenderMode: 'rebuild',
      lastGeometryRebuildReasons: ['viewOffset'],
    });

    overlay.destroy();
  });

  it('focus-composes exact flat-source targets without mutating the immediate body', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      ...createLinearCdsGenome(),
      annotationLayout: {
        maxAnnotationLane: 2,
        maxCdsLane: 0,
      },
    };
    const state = createState();
    const path = createLinearPath(10, 0);
    const focusGraphics = (
      overlay as unknown as {
        annotationSearchFocusGraphics: {
          visible: boolean;
          rect: (...args: unknown[]) => unknown;
          poly: (...args: unknown[]) => unknown;
          fill: (...args: unknown[]) => unknown;
        };
      }
    ).annotationSearchFocusGraphics;
    const rect = vi.spyOn(focusGraphics, 'rect');
    const poly = vi.spyOn(focusGraphics, 'poly');
    const fill = vi.spyOn(focusGraphics, 'fill');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.render(path, state, 0, state.height);
    const bodyBefore = overlay.getDebugSnapshot();
    expect(bodyBefore).toMatchObject({
      featureCount: 1,
      drawnFeatureCount: 1,
      hitRecords: 1,
      geometryRebuilds: 1,
    });

    const ordinaryTarget: Feature = {
      id: 9001,
      type: 'enhancer',
      annotationTrackId: 'enhancer',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      canonicalIdentity: 'canonical-flat-enhancer',
      start: 20,
      end: 40,
      direction: 'forward',
      displayName: 'flat enhancer',
      color: 0xef4444,
      lane: 1,
    };
    state.annotationSearchFocus = {
      trackId: 'enhancer',
      canonicalIdentity: ordinaryTarget.canonicalIdentity!,
      presentation: 'temporary-additional-lane',
    };
    state.annotationSearchFocusFeature = ordinaryTarget;
    overlay.render(path, state, 0, state.height);

    expect(rect).not.toHaveBeenCalled();
    expect(poly).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenLastCalledWith({
      color: webglAnnotationColorForMode(ordinaryTarget.color, state.themeMode),
      alpha: 0.85,
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      featureCount: bodyBefore.featureCount,
      drawnFeatureCount: bodyBefore.drawnFeatureCount,
      hitRecords: bodyBefore.hitRecords,
      geometryRebuilds: bodyBefore.geometryRebuilds,
      annotationSearchFocusMaskDrawCount: 0,
      annotationSearchFocusPrimitiveDrawCount: 1,
      annotationSearchFocusResolvedTrackId: 'enhancer',
      annotationSearchFocusResolvedCanonicalIdentity: ordinaryTarget.canonicalIdentity,
      annotationSearchFocusPresentationLane: null,
    });

    rect.mockClear();
    poly.mockClear();
    fill.mockClear();
    const transcriptTarget: Feature = {
      id: 9002,
      type: 'lnc_RNA',
      annotationTrackId: 'lnc_RNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      canonicalIdentity: 'canonical-flat-lnc',
      start: 45,
      end: 80,
      direction: 'reverse',
      displayName: 'flat lncRNA',
      color: featureTypeColor('lnc_RNA'),
      lane: 2,
      exons: [{ start: 46, end: 80 }],
      cds: [],
    };
    state.annotationSearchFocus = {
      trackId: 'lnc_RNA',
      canonicalIdentity: transcriptTarget.canonicalIdentity!,
    };
    state.annotationSearchFocusFeature = transcriptTarget;
    overlay.render(path, state, 0, state.height);

    expect(rect).toHaveBeenCalledOnce();
    expect(poly).toHaveBeenCalled();
    expect(
      fill.mock.calls.some(
        ([style]) =>
          (style as { color?: number }).color === transcriptColorForMode('ncRnaExon', 'light')
      )
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      featureCount: bodyBefore.featureCount,
      drawnFeatureCount: bodyBefore.drawnFeatureCount,
      hitRecords: bodyBefore.hitRecords,
      geometryRebuilds: bodyBefore.geometryRebuilds,
      annotationSearchFocusMaskDrawCount: 1,
      annotationSearchFocusResolvedTrackId: 'lnc_RNA',
      annotationSearchFocusResolvedCanonicalIdentity: transcriptTarget.canonicalIdentity,
    });
    expect(overlay.getDebugSnapshot().annotationSearchFocusPrimitiveDrawCount).toBeGreaterThan(0);

    rect.mockClear();
    poly.mockClear();
    fill.mockClear();
    state.annotationSearchFocus = {
      trackId: 'lnc_RNA',
      canonicalIdentity: 'wrong-canonical-identity',
    };
    overlay.render(path, state, 0, state.height);
    expect(rect).not.toHaveBeenCalled();
    expect(poly).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusMaskDrawCount: 0,
      annotationSearchFocusPrimitiveDrawCount: 0,
      annotationSearchFocusResolvedTrackId: null,
      annotationSearchFocusResolvedCanonicalIdentity: null,
    });

    state.annotationSearchFocus = null;
    state.annotationSearchFocusFeature = null;
    overlay.render(path, state, 0, state.height);
    expect(focusGraphics.visible).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      featureCount: bodyBefore.featureCount,
      drawnFeatureCount: bodyBefore.drawnFeatureCount,
      hitRecords: bodyBefore.hitRecords,
      geometryRebuilds: bodyBefore.geometryRebuilds,
      annotationSearchFocusMaskDrawCount: 0,
      annotationSearchFocusPrimitiveDrawCount: 0,
    });
    overlay.destroy();
  });

  it('rebuilds overview geometry when the overview rendering style changes', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = createState();
    const path = createOverviewArcPath(0.001);
    const styleFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
    };

    try {
      styleFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = 'retained';
      overlay.loadGenome(genome);
      overlay.render(path, state, 0, state.height);

      styleFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = 'full-shapes';
      overlay.render(path, state, 0, state.height);

      expect(overlay.getDebugSnapshot()).toMatchObject({
        renderCalls: 2,
        geometryRebuilds: 2,
        geometryCacheHits: 0,
        lastRenderMode: 'rebuild',
        lastGeometryRebuildReasons: ['overviewStyle'],
      });
    } finally {
      delete styleFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
      overlay.destroy();
    }
  });

  it('damps forced full-shape overview alpha without hiding subpixel annotations', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = createState();
    const path = createOverviewArcPath(0.001);
    const styleFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
    };
    const graphics = (
      overlay as unknown as {
        graphics: {
          fill: (...args: unknown[]) => unknown;
          poly: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');
    const polySpy = vi.spyOn(graphics, 'poly');

    try {
      styleFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = 'full-shapes';
      overlay.loadGenome(genome);
      overlay.render(path, state, 0, state.height);

      const fillAlphas = fillSpy.mock.calls
        .map((call) => (call[0] as { alpha?: number } | undefined)?.alpha)
        .filter((alpha): alpha is number => typeof alpha === 'number');

      expect(overlay.getDebugSnapshot().drawnFeatureCount).toBe(genomeFeatures(genome).length);
      expect(polySpy).toHaveBeenCalledTimes(genomeFeatures(genome).length);
      expect(fillAlphas).toHaveLength(genomeFeatures(genome).length);
      expect(fillAlphas.every((alpha) => alpha > 0)).toBe(true);
      expect(fillAlphas.every((alpha) => alpha < 0.85)).toBe(true);
    } finally {
      delete styleFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
      overlay.destroy();
    }
  });

  it('shows that overview aggregation cache survives view-offset geometry rebuilds', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = createState();
    const path = createOverviewArcPath(0.001);

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const first = overlay.getDebugSnapshot();
    expect(first.overviewAggregationEnabled).toBe(true);
    expect(first.overviewAggregationCacheHit).toBe(false);
    expect(first.overviewBinDrawCount).toBeGreaterThan(0);
    expect(first.overviewPassthroughFeatureCount).toBe(0);

    state.viewOffset = 0.1;
    overlay.render(path, state, 0, state.height);

    const second = overlay.getDebugSnapshot();
    expect(second.lastGeometryRebuildReasons).toEqual(['viewOffset']);
    expect(second.geometryRebuilds).toBe(2);
    expect(second.overviewAggregationEnabled).toBe(true);
    expect(second.overviewAggregationCacheHit).toBe(true);
    expect(second.overviewBinDrawCount).toBe(first.overviewBinDrawCount);

    overlay.destroy();
  });

  it('retains overview annotation bodies across stadium viewOffset camera updates when enabled', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);
      overlay.updateRetainedInteraction(state);

      const debug = overlay.getDebugSnapshot();
      expect(debug).toMatchObject({
        renderCalls: 1,
        geometryRebuilds: 0,
        lastRenderMode: 'retained',
        overviewAggregationEnabled: true,
      });
      expect(debug.overviewDensityAtlasSampleScreenPx).toBe(0.25);
      expect(debug.overviewBinDrawCount).toBeGreaterThan(3);
      expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
        id: 'annotations.overview-bodies',
        enabled: true,
        mode: 'retained',
        dataBuilds: 1,
        cameraUpdates: 1,
        interactionUpdates: 1,
      });
      expect(overlay.getRetainedDebugSnapshot().retainedInstanceCount).toBe(
        debug.overviewBinDrawCount
      );
      expect(overlay.getRetainedDebugSnapshot().visibleInstanceCount).toBe(
        debug.overviewBinDrawCount
      );

      state.viewOffset = 0.1;
      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      const secondDebug = overlay.getDebugSnapshot();
      expect(secondDebug).toMatchObject({
        renderCalls: 2,
        geometryRebuilds: 0,
        lastRenderMode: 'retained',
        overviewAggregationCacheHit: true,
      });
      expect(secondDebug.overviewBinDrawCount).toBe(debug.overviewBinDrawCount);
      expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
        mode: 'retained',
        dataBuilds: 1,
        cameraUpdates: 2,
      });
      expect(overlay.getRetainedDebugSnapshot().retainedInstanceCount).toBe(
        debug.overviewBinDrawCount
      );
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });

  it('keeps retained overview bins at the source annotation color and opacity', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      const retainedBins = overlay.getRetainedLinearPresenterForTest().retainedOverviewHitBins;
      expect(retainedBins.length).toBeGreaterThan(0);
      expect(retainedBins.every((bin) => bin.color === 0x22c55e)).toBe(true);
      expect(retainedBins.every((bin) => bin.alpha === 0.85)).toBe(true);
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });

  it('uploads dark-mode colors for retained overview annotation bodies', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = { ...createState(), zoom: 0.01, themeMode: 'dark' as const };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
      __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;
    retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = 'retained';

    try {
      overlay.loadGenome(genome);
      overlay.setLayout({
        ...createAnnotationLayout(false),
        overviewLaneScale: 0.1,
        laneGeometryScale: 1,
      });

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      const colors = (
        overlay.getRetainedLinearPresenterForTest().retainedOverviewLayer as unknown as {
          colorBuffer: { data: Float32Array };
        }
      ).colorBuffer.data;
      const expected = webglAnnotationColorForMode(0x22c55e, 'dark');
      expect(expected).not.toBe(0x22c55e);
      expect(colors.length).toBeGreaterThan(0);
      expect(colors[0]).toBeCloseTo(((expected >> 16) & 0xff) / 255, 5);
      expect(colors[1]).toBeCloseTo(((expected >> 8) & 0xff) / 255, 5);
      expect(colors[2]).toBeCloseTo((expected & 0xff) / 255, 5);
      expect(colors[3]).toBeCloseTo(0.85, 5);
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      delete retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
      overlay.destroy();
    }
  });

  it('maps legacy texture overview styles onto retained-bin rendering', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createPartialCoverageCircularGeneGenome();
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
      __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));
      const camera = {
        path: createPath(state, genome),
        state,
        yOffset: 0,
        height: state.height,
      };

      retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = 'retained';
      expect(overlay.updateRetainedCamera(camera)).toBe(true);
      expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
        mode: 'retained',
        style: 'retained',
        dataBuilds: 1,
      });

      const unsafeStyles = ['texture-exact', 'texture-coverage', 'texture-soft', 'density'];
      for (const style of unsafeStyles) {
        retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = style;
        expect(overlay.updateRetainedCamera(camera)).toBe(true);
        expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
          mode: 'retained',
          style: 'retained',
          lastFallbackReason: null,
        });
        expect('overviewDensityTextureActive' in overlay.getDebugSnapshot()).toBe(false);
      }
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      delete retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
      overlay.destroy();
    }
  });

  it('denies hidden texture candidates as alternate annotation renderers', () => {
    const textureCandidates = [
      'shape-raster-coverage',
      'feature-gaussian-field-v1',
      'feature-gaussian-field-tight',
      'feature-gaussian-field-soft',
      'feature-gaussian-field-wash',
      'feature-gaussian-field-ridge',
    ] as const;

    for (const style of textureCandidates) {
      const overlay = new AnnotationOverlayClass();
      const genome = createPartialCoverageCircularGeneGenome();
      const state = { ...createState(), zoom: 0.01 };
      const retainedFlag = globalThis as typeof globalThis & {
        __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
        __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
      };
      retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;
      retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = style;

      try {
        overlay.loadGenome(genome);
        overlay.setLayout(createAnnotationLayout(false));

        expect(
          overlay.updateRetainedCamera({
            path: createPath(state, genome),
            state,
            yOffset: 0,
            height: state.height,
          })
        ).toBe(true);

        expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
          mode: 'retained',
          style: 'retained',
          fallbackRenders: 0,
          lastFallbackReason: null,
        });
        expect('overviewDensityTextureActive' in overlay.getDebugSnapshot()).toBe(false);
      } finally {
        delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
        delete retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
        overlay.destroy();
      }
    }
  });

  it('keeps retained-bin geometry as the only compressed overview across the LOD boundary', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createPartialCoverageCircularGeneGenome();
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
      __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;
    retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = 'feature-gaussian-field-v1';

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
        mode: 'retained',
        style: 'retained',
      });
      expect(overlay.getDebugSnapshot()).toMatchObject({
        lastRenderMode: 'retained',
      });
      expect('overviewDensityTextureActive' in overlay.getDebugSnapshot()).toBe(false);
      const debug = overlay.getDebugSnapshot();
      expect(debug.overviewLodCompressionBlend).toBeGreaterThan(0);
      expect(debug.overviewLodCompressionBlend).toBeLessThan(1);
      expect(debug.overviewLodFullShapeBlend).toBeCloseTo(1 - debug.overviewLodCompressionBlend);
      expect(debug.overviewBinDrawCount).toBeGreaterThan(0);
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      delete retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
      overlay.destroy();
    }
  });

  it('keeps retained-bin overview transitions on retained geometry', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createPartialCoverageCircularGeneGenome();
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
      __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;
    retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = 'retained';

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      const debug = overlay.getDebugSnapshot();
      expect(debug.lastRenderMode).toBe('retained');
      expect(debug.overviewLodCompressionBlend).toBeGreaterThan(0);
      expect(debug.overviewLodCompressionBlend).toBeLessThan(1);
      expect(debug.overviewLodFullShapeBlend).toBeCloseTo(1 - debug.overviewLodCompressionBlend);
      expect(debug.drawnFeatureCount).toBe(0);
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      delete retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
      overlay.destroy();
    }
  });

  it('updates retained-bin overview zoom transitions through camera uniforms', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createPartialCoverageCircularGeneGenome();
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
      __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;
    retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = 'retained';

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      state.zoom *= 1.2;
      overlay.setLayout({
        ...createAnnotationLayout(false),
        overviewLaneScale: 0.6,
        laneGeometryScale: 1,
      });
      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
        mode: 'retained',
        dataBuilds: 1,
        cameraUpdates: 2,
      });
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      delete retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
      overlay.destroy();
    }
  });

  it('uses retained overview rendering by default for the safe overview LOD', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };
    delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
        enabled: true,
        mode: 'retained',
        fallbackRenders: 0,
        lastFallbackReason: null,
      });
      expect(overlay.getDebugSnapshot()).toMatchObject({
        geometryRebuilds: 0,
        lastRenderMode: 'retained',
      });
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });

  it('can force full feature shapes at fully zoomed-out overview levels for visual comparison', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
    };
    retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE = 'full-shapes';

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));
      const path = createPath(state, genome);

      expect(
        overlay.updateRetainedCamera({
          path,
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(false);

      overlay.render(path, state, 0, state.height);

      expect(overlay.getDebugSnapshot()).toMatchObject({
        lastRenderMode: 'rebuild',
        overviewAggregationEnabled: false,
        overviewBinDrawCount: 0,
        drawnFeatureCount: 2,
      });
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
      overlay.destroy();
    }
  });

  it('honors the internal retained-overview disable flag', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = false;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(false);

      expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
        enabled: false,
        mode: 'fallback',
        fallbackRenders: 1,
        lastFallbackReason: 'disabled',
      });
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });

  it('retains wide overview annotation bodies instead of falling back to immediate rendering', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'wide-circular-overview-retained-regression',
      length: 10_000,
      circular: true,
      features: [
        {
          id: 51,
          type: 'gene',
          start: 1000,
          end: 8000,
          direction: 'none',
          displayName: 'wide retained gene',
          color: 0x22c55e,
          lane: 0,
        },
      ],
      sequence: 'A'.repeat(10_000),
    };
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      const retained = overlay.getRetainedDebugSnapshot();
      expect(retained).toMatchObject({
        mode: 'retained',
        fallbackRenders: 0,
        lastFallbackReason: null,
      });
      expect(retained.retainedInstanceCount).toBeGreaterThan(1);
      expect(overlay.getDebugSnapshot()).toMatchObject({
        geometryRebuilds: 0,
        lastRenderMode: 'retained',
        overviewPassthroughFeatureCount: 0,
      });
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });

  it('keeps spliced CDS features out of retained overview bins and renders them as passthrough', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'retained-overview-spliced-passthrough-regression',
      length: 10_000,
      circular: true,
      features: [
        {
          id: 91,
          type: 'CDS',
          start: 1000,
          end: 7000,
          direction: 'forward',
          displayName: 'Spliced overview CDS',
          color: 0x3b82f6,
          lane: 0,
          segments: [
            { start: 1000, end: 2200 },
            { start: 5200, end: 7000 },
          ],
          qualifiers: { _locationString: 'join(1001..2200,5201..7000)' },
        },
      ],
      sequence: 'A'.repeat(10_000),
    };
    const state = { ...createState(), zoom: 0.01 };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      const retainedBins = overlay.getRetainedLinearPresenterForTest().retainedOverviewHitBins;
      expect(retainedBins.some((bin) => bin.featureId === 91)).toBe(false);
      const snapshot = overlay.getDebugSnapshot();
      expect(snapshot).toMatchObject({
        lastRenderMode: 'retained',
        overviewPassthroughFeatureCount: 1,
        drawnFeatureCount: 1,
        floatingLabelFrame: {
          placedCount: 1,
          densitySelectedCount: 1,
        },
      });
      expect(snapshot.hitRecords).toBe(2);
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });

  it('clears retained passthrough graphics when spliced features become too small to draw', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'retained-overview-spliced-passthrough-clear-regression',
      length: 10_000,
      circular: true,
      features: [
        {
          id: 92,
          type: 'CDS',
          start: 1000,
          end: 7000,
          direction: 'forward',
          displayName: 'Spliced overview CDS',
          color: 0x3b82f6,
          lane: 0,
          segments: [
            { start: 1000, end: 2200 },
            { start: 5200, end: 7000 },
          ],
          qualifiers: { _locationString: 'join(1001..2200,5201..7000)' },
        },
      ],
      sequence: 'A'.repeat(10_000),
    };
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));
      const graphics = (overlay as unknown as { graphics: { clear: () => void } }).graphics;
      const clearSpy = vi.spyOn(graphics, 'clear');

      const visibleState = { ...createState(), zoom: 0.01 };
      expect(
        overlay.updateRetainedCamera({
          path: createPath(visibleState, genome),
          state: visibleState,
          yOffset: 0,
          height: visibleState.height,
        })
      ).toBe(true);
      expect(overlay.getDebugSnapshot()).toMatchObject({
        overviewPassthroughFeatureCount: 1,
        drawnFeatureCount: 1,
      });
      expect(clearSpy).toHaveBeenCalledTimes(1);

      const hiddenState = { ...createState(), zoom: 0.00001 };
      expect(
        overlay.updateRetainedCamera({
          path: createPath(hiddenState, genome),
          state: hiddenState,
          yOffset: 0,
          height: hiddenState.height,
        })
      ).toBe(true);
      expect(overlay.getDebugSnapshot()).toMatchObject({
        overviewPassthroughFeatureCount: 1,
        drawnFeatureCount: 0,
      });
      expect(clearSpy).toHaveBeenCalledTimes(2);
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });

  it('keeps retained overview bodies hit-testable so hover can fall back to immediate outlines', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = { ...createState(), zoom: 0.01 };
    const path = createPath(state, genome);

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

    const retainedBins = overlay.getRetainedLinearPresenterForTest().retainedOverviewHitBins;
    const bin = retainedBins.find((candidate) => candidate.featureId === 5);
    expect(bin).toBeTruthy();

    const pts = path.featurePolygonAt(bin!.startBp, bin!.endBp, bin!.offset, bin!.halfHeight);
    const xs = pts.filter((_, i) => i % 2 === 0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    const hitX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
    const hitY = ys.reduce((sum, y) => sum + y, 0) / ys.length;

    const hit = overlay.hitTest(hitX, hitY, path, state);
    if (!hit || hit.kind !== 'feature') {
      throw new Error('Expected retained overview hit test to resolve a feature');
    }
    expect([5, 6]).toContain(hit.payload.id);

    overlay.destroy();
  });

  it('keeps retained overview bodies active while drawing interaction outlines', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = { ...createState(), zoom: 0.01 };
    state.selectedIds.add(5);
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));

      expect(
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        })
      ).toBe(true);

      expect(overlay.getRetainedDebugSnapshot()).toMatchObject({
        mode: 'retained',
        fallbackRenders: 0,
        lastFallbackReason: null,
      });
      expect(overlay.getDebugSnapshot()).toMatchObject({
        geometryRebuilds: 0,
        lastRenderMode: 'retained',
        lastInteractionOutlineCommandCount: 1,
      });
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });

  it("emphasizes the hovered feature's floating label letters without drawing a box", () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createTinyCircularGenesGenome();
    const state = { ...createState(), zoom: 0.01 };
    state.hoveredId = 5;
    const retainedFlag = globalThis as typeof globalThis & {
      __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
    };
    retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS = true;
    const interactionGraphics = (
      overlay as unknown as {
        interactionGraphics: { roundRect: (...args: unknown[]) => unknown };
      }
    ).interactionGraphics;
    const roundRectSpy = vi.spyOn(interactionGraphics, 'roundRect');
    const labels = (
      overlay as unknown as {
        floatingLabels: {
          textLabelsByFeature: Map<number, { style: { stroke: { width?: number } | null } }>;
        };
      }
    ).floatingLabels.textLabelsByFeature;

    try {
      overlay.loadGenome(genome);
      overlay.setLayout(createAnnotationLayout(false));
      const update = () =>
        overlay.updateRetainedCamera({
          path: createPath(state, genome),
          state,
          yOffset: 0,
          height: state.height,
        });
      expect(update()).toBe(true);
      const placed = overlay
        .getDebugSnapshot()
        .floatingLabelFrame.decisions.filter((decision) => decision.status === 'placed');
      expect(placed.some((decision) => decision.featureId === 5)).toBe(true);
      expect(overlay.getDebugSnapshot().lastInteractionOutlineCommandCount).toBe(1);
      expect(roundRectSpy).not.toHaveBeenCalled();
      expect(labels.get(5)?.style.stroke?.width).toBe(PILL_LABEL_EMPHASIS_STROKE_PX);
      for (const decision of placed) {
        if (decision.featureId === 5) continue;
        expect(labels.get(decision.featureId)?.style.stroke?.width ?? null).toBeNull();
      }

      state.hoveredId = null;
      state.selectedIds.add(5);
      expect(update()).toBe(true);
      expect(labels.get(5)?.style.stroke?.width).toBe(PILL_LABEL_EMPHASIS_STROKE_PX);

      state.selectedIds.clear();
      expect(update()).toBe(true);
      expect(labels.get(5)?.style.stroke?.width ?? null).toBeNull();
    } finally {
      delete retainedFlag.__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS;
      overlay.destroy();
    }
  });
});

function createSplicedCdsGenome(): Genome {
  return {
    name: 'spliced-cds',
    length: 5000,
    circular: false,
    sequence: 'A'.repeat(5000),
    features: [
      {
        id: 1,
        type: 'CDS',
        start: 100,
        end: 1000,
        direction: 'forward',
        displayName: 'mRNA-X',
        color: 0x3b82f6,
        lane: 0,
        cdsLane: 0,
        segments: [
          { start: 101, end: 200 },
          { start: 401, end: 500 },
          { start: 801, end: 1000 },
        ],
        qualifiers: { _locationString: 'join(101..200,401..500,801..1000)' },
      },
    ],
  };
}

describe('AnnotationOverlay spliced CDS draw  task #7)', () => {
  it('draws each exon as its own polygon + thin intron connectors between', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = createSplicedCdsGenome();
    const state = createState();
    state.zoom = 1;
    const path = createLinearPath(0.5);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.render(path, state, 0, state.height);

    expect(polySpy.mock.calls.length).toBeGreaterThanOrEqual(5);

    overlay.destroy();
  });

  it('triggers the same blocks-with-introns view for mRNA features (RefSeq mammalian model)', () => {
    const overlay = new AnnotationOverlayClass();
    const baseGenome = createSplicedCdsGenome();
    const genome: Genome = {
      ...baseGenome,
      features: [{ ...genomeFeatures(baseGenome)[0], type: 'mRNA' }],
    };
    const state = createState();
    state.zoom = 1;
    const path = createLinearPath(0.5);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.render(path, state, 0, state.height);

    expect(polySpy.mock.calls.length).toBeGreaterThanOrEqual(5);

    overlay.destroy();
  });

  it('places a spliced-feature label on the visible segment when the largest segment is offscreen', () => {
    const overlay = new AnnotationOverlayClass();
    const baseGenome = createSplicedCdsGenome();
    const feature: Feature = {
      ...genomeFeatures(baseGenome)[0],
      type: 'mRNA',
      displayName: 'VISIBLE',
      start: 100,
      end: 900,
      segments: [
        { start: 101, end: 600 },
        { start: 801, end: 900 },
      ],
      qualifiers: { _locationString: 'join(101..600,801..900)' },
    };
    const genome: Genome = { ...baseGenome, features: [feature] };
    const state = createState();
    const path: PathMapper = {
      ...createLinearPath(1, 700),
      viewEndBp: 1_500,
    };

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.render(path, state, 0, state.height);

    const labels = (
      overlay as unknown as {
        labelPool: Array<{ text: string; x: number }>;
      }
    ).labelPool;
    const label = labels.find((candidate) => candidate.text === 'VISIBLE');
    expect(label).toBeDefined();
    expect(label?.x).toBeGreaterThanOrEqual(path.bpLeftX(800));
    expect(label?.x).toBeLessThanOrEqual(path.bpLeftX(900));

    overlay.destroy();
  });

  it('viewport culling: skips features outside the visible bp range on linear paths  task #8)', () => {
    const overlay = new AnnotationOverlayClass();
    const length = 1_000_000;
    const features: Feature[] = [
      ...Array.from({ length: 50 }, (_, i) => ({
        id: i,
        type: 'gene',
        start: i * 1000,
        end: i * 1000 + 500,
        direction: 'forward' as const,
        displayName: `gA${i}`,
        color: 0x3b82f6,
        lane: 0,
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        id: 100 + i,
        type: 'gene',
        start: 800_000 + i * 1000,
        end: 800_000 + i * 1000 + 500,
        direction: 'forward' as const,
        displayName: `gB${i}`,
        color: 0x3b82f6,
        lane: 0,
      })),
    ];
    const genome: Genome = {
      name: 'cull-test',
      length,
      circular: false,
      features,
    };
    const state = createState();
    const path: PathMapper = {
      ...createLinearPath(0.001),
      viewStartBp: 0,
      viewEndBp: 100_000,
    };

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const debug = overlay.getDebugSnapshot();
    expect(debug.drawnFeatureCount).toBeLessThanOrEqual(50);

    overlay.destroy();
  });

  it('preserves indexed source lanes instead of repacking viewport subsets', () => {
    const overlay = new AnnotationOverlayClass();
    const features: Feature[] = [
      {
        id: 1,
        type: 'mRNA',
        start: 100,
        end: 900,
        direction: 'forward',
        displayName: 'long-left',
        color: 0x3b82f6,
        lane: 0,
        qualifiers: { _lane: '9' },
      },
      {
        id: 2,
        type: 'mRNA',
        start: 200,
        end: 800,
        direction: 'forward',
        displayName: 'nested',
        color: 0x3b82f6,
        lane: 0,
        qualifiers: { _lane: '4' },
      },
      {
        id: 3,
        type: 'CDS',
        start: 240,
        end: 760,
        direction: 'forward',
        displayName: 'cds',
        color: 0x3b82f6,
        lane: 0,
        qualifiers: { _lane: '2' },
      },
    ];

    overlay.loadGenome({
      name: 'stable-source-lanes',
      length: 1_000,
      circular: false,
      features,
    });

    expect(features[0].lane).toBe(9);
    expect(features[1].lane).toBe(4);
    expect(features[2].lane).toBe(2);
    expect(features[2].cdsLane).toBe(2);

    overlay.destroy();
  });

  it('falls back to a single flat polygon when feature is NOT spliced', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      ...createSplicedCdsGenome(),
      features: [
        {
          ...genomeFeatures(createSplicedCdsGenome())[0],
          segments: undefined,
          qualifiers: {},
        },
      ],
    };
    const state = createState();
    state.zoom = 1;
    const path = createLinearPath(0.5);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.setLayout(createAnnotationLayout(false));
    overlay.render(path, state, 0, state.height);

    expect(polySpy.mock.calls.length).toBeLessThan(5);

    overlay.destroy();
  });
});
