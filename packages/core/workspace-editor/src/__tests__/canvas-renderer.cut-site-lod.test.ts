// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderSequence, type RenderSequenceParams } from '../canvas-renderer';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { Layout2DRow, LayoutSnapshot2D, LinePositions, SequenceLodLevel } from '../types';
import type { ColoredCutSite, RestrictionEnzyme } from '@waypoint/sequence-utils';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  type CanvasOp,
} from '../testing/recording-canvas-context';

function row(): Layout2DRow {
  return {
    lineIndex: 0,
    startPos: 0,
    endPos: 50,
    sequence: 'A'.repeat(50),
    complementSequence: 'T'.repeat(50),
    y: 0,
    annotations: [],
    annotationLaneCount: 0,
    translationLaneCount: 0,
  } as Layout2DRow;
}

function layoutFor(line: Layout2DRow): LayoutSnapshot2D {
  return {
    lines: [line],
    totalHeight: 200,
    totalWidth: 50 * DEFAULT_EDITOR_CONFIG.charWidth + DEFAULT_EDITOR_CONFIG.marginLeft,
    sequenceLength: 50,
  };
}

function linePositionsFor(line: Layout2DRow): LinePositions[] {
  return [
    {
      line,
      annotationY: 0,
      translationY: 0,
      translationLaneCount: 0,
      sequenceY: 20,
      complementY: 42,
      mutationTrackY: 0,
      hasMutationTrack: false,
      rulerY: 90,
      forwardPrimerY: 66,
      reversePrimerY: 74,
      lineEndY: 100,
      hasPrimers: false,
      hasForwardPrimers: false,
      hasReversePrimers: false,
      absoluteLineY: 0,
      forwardOrfY: 0,
      reverseOrfY: 0,
      forwardOrfLaneCount: 0,
      reverseOrfLaneCount: 0,
    },
  ];
}

const normalSite = (): ColoredCutSite => ({
  enzyme: { name: 'EcoRI' } as RestrictionEnzyme,
  cutPositionTop: 10,
  cutPositionBottom: 14,
  recognitionStart: 10,
  recognitionEnd: 16,
  strand: 'forward',
  color: '#3366cc',
});

const labelTexts = (log: CanvasOp[]): string[] =>
  log
    .filter((o): o is Extract<CanvasOp, { op: 'fillText' }> => o.op === 'fillText')
    .map((o) => o.text);

function renderAt(lodLevel: SequenceLodLevel): string[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const line = row();
  const params: RenderSequenceParams = {
    linePositions: linePositionsFor(line),
    config: {
      ...DEFAULT_EDITOR_CONFIG,
      lodLevel,
      overviewLod: false,
      showReverseComplement: lodLevel === 'detail',
    },
    canvasWidth: 800,
    canvasHeight: 300,
    sequenceLength: 50,
    fullSequence: 'A'.repeat(50),
    cutSites: [normalSite()],
    scannedCutSites: [],
    primers: [],
    mutations: [],
    rulerSegments: [],
    insertedRanges: [],
    deletedRanges: [],
    showCutSites: true,
    highlightedRange: null,
    hoveredCodon: null,
    viewCursor: null,
    hoveredCutSite: null,
    hoveredGGProductLabel: null,
    hoveredEnzymeName: null,
    hoveredPositionInfo: null,
    coordinateSpace: undefined,
    junctionIndicators: undefined,
    layout: layoutFor(line),
  };
  renderSequence(ctx, params);
  return labelTexts(getRecordingLog(canvas));
}

describe('2D canvas cut-site label LOD', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it('renders the enzyme label at FEATURE LOD', () => {
    expect(renderAt('feature')).toContain('EcoRI');
  });

  it('renders the enzyme label at DETAIL LOD', () => {
    expect(renderAt('detail')).toContain('EcoRI');
  });

  it('hides the enzyme label at DENSITY (overview) LOD', () => {
    expect(renderAt('density')).not.toContain('EcoRI');
  });
});
