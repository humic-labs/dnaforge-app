// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { findORFs } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { renderSequence } from '../canvas-renderer';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorConfig } from '../types';
import { calculateOrfHeight } from '../orf-drawing';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  opsOf,
} from '../testing/recording-canvas-context';
import type { LinePositions } from '../canvas-drawing';

const PUC19 = parseGenBankFull(
  readFileSync(join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb'), 'utf-8')
);
const ORFS = findORFs(PUC19.sequence, 100);

function buildLinePositions(
  layout: ReturnType<typeof computeSequenceLayoutImpl>,
  config: WorkspaceEditorConfig
): LinePositions[] {
  return layout.lines.map((line) => {
    let y = line.y;
    const forwardOrfLaneCount = line.forwardOrfLaneCount ?? 0;
    const reverseOrfLaneCount = line.reverseOrfLaneCount ?? 0;
    const forwardOrfHeight = calculateOrfHeight(forwardOrfLaneCount, config.rowHeight);
    const reverseOrfHeight = calculateOrfHeight(reverseOrfLaneCount, config.rowHeight);
    const annotationY = y;
    const translationY = y;
    const forwardOrfY = y;
    y += forwardOrfHeight;
    if (forwardOrfHeight > 0 && reverseOrfHeight > 0) y += 4;
    const reverseOrfY = y;
    y += reverseOrfHeight;
    const sequenceY = y;
    y += config.rowHeight;
    return {
      line,
      annotationY,
      translationY,
      translationLaneCount: line.translationLaneCount ?? 0,
      sequenceY,
      complementY: y,
      mutationTrackY: y,
      hasMutationTrack: false,
      rulerY: y + 4,
      forwardPrimerY: y,
      reversePrimerY: y,
      lineEndY: y + 20,
      hasPrimers: false,
      hasForwardPrimers: false,
      hasReversePrimers: false,
      absoluteLineY: line.y,
      forwardOrfY,
      reverseOrfY,
      forwardOrfLaneCount,
      reverseOrfLaneCount,
    };
  });
}

function render(config: WorkspaceEditorConfig, canvas: HTMLCanvasElement) {
  const layout = computeSequenceLayoutImpl(PUC19, config, 0, 0, [], false, ORFS);
  const linePositions = buildLinePositions(layout, config);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const paint = renderSequence(ctx, {
    linePositions,
    config,
    layout,
    canvasWidth: 1200,
    canvasHeight: 4000,
    sequenceLength: PUC19.sequence.length,
    fullSequence: PUC19.sequence,
    cutSites: [],
    scannedCutSites: [],
    primers: [],
    mutations: [],
    rulerSegments: [],
    insertedRanges: [],
    deletedRanges: [],
    showCutSites: false,
    highlightedRange: null,
    hoveredCodon: null,
    viewCursor: null,
    hoveredCutSite: null,
    hoveredGGProductLabel: null,
    hoveredEnzymeName: null,
    hoveredPositionInfo: null,
    orfs: ORFS,
  });
  return { layout, linePositions, paint };
}

let canvas: HTMLCanvasElement;
beforeEach(() => {
  installRecordingCanvas();
  canvas = document.createElement('canvas');
});
afterEach(() => uninstallRecordingCanvas());

describe('ORF feature-LOD render proof (real pipeline, real fixture)', () => {
  it.each([
    { lodLevel: 'detail', charWidth: 9, expected: true },
    { lodLevel: 'feature', charWidth: 2, expected: true },
    { lodLevel: 'density', charWidth: 0.1, expected: false },
  ] as const)(
    'reports actual ORF draw qualification at $lodLevel LOD',
    ({ lodLevel, charWidth, expected }) => {
      const { paint } = render(
        {
          ...DEFAULT_EDITOR_CONFIG,
          lodLevel,
          charWidth,
          charsPerLine: 1000,
          rowHeight: 14,
        },
        canvas
      );
      expect(paint.orfsDrawn).toBe(expected);
    }
  );

  it('the fixture actually has ORFs (guards the test itself)', () => {
    expect(ORFS.length).toBeGreaterThan(0);
  });

  it('feature LOD: ORF bars are emitted INTO the reserved ORF lane band', () => {
    const config: WorkspaceEditorConfig = {
      ...DEFAULT_EDITOR_CONFIG,
      lodLevel: 'feature',
      charsPerLine: 1000,
      charWidth: 2,
      rowHeight: 14,
      showAnnotations: true,
    };
    const { linePositions } = render(config, canvas);

    const orfLines = linePositions.filter(
      (lp) => lp.forwardOrfLaneCount > 0 || lp.reverseOrfLaneCount > 0
    );

    expect(orfLines.length).toBeGreaterThan(0);

    const log = getRecordingLog(canvas);

    const verts = [
      ...opsOf(log, 'moveTo').map((o) => ({ x: o.x, y: o.y })),
      ...opsOf(log, 'lineTo').map((o) => ({ x: o.x, y: o.y })),
    ];

    const inOrfBand = verts.filter((p) =>
      orfLines.some((lp) => {
        const fH = calculateOrfHeight(lp.forwardOrfLaneCount, config.rowHeight) || 0;
        const rH = calculateOrfHeight(lp.reverseOrfLaneCount, config.rowHeight) || 0;
        const inFwd = fH > 0 && p.y >= lp.forwardOrfY - 1 && p.y <= lp.forwardOrfY + fH + 1;
        const inRev = rH > 0 && p.y >= lp.reverseOrfY - 1 && p.y <= lp.reverseOrfY + rH + 1;
        return inFwd || inRev;
      })
    );

    expect(
      inOrfBand.length,
      `feature-LOD ORF bars MUST be drawn in the ORF lane band. ` +
        `orfLines=${orfLines.length}, polygonVerts=${verts.length}, ` +
        `inBand=${inOrfBand.length}`
    ).toBeGreaterThan(0);
  });

  it('detail LOD still renders ORF content (no regression to chevron path)', () => {
    const config: WorkspaceEditorConfig = {
      ...DEFAULT_EDITOR_CONFIG,
      lodLevel: 'detail',
      charsPerLine: 120,
      charWidth: 9,
      rowHeight: 20,
      showAnnotations: true,
    };
    render(config, canvas);
    const log = getRecordingLog(canvas);

    expect(opsOf(log, 'fill').length).toBeGreaterThan(0);
  });
});
