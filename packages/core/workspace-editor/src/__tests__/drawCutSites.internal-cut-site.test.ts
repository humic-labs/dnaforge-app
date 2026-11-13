// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drawCutSites } from '../restriction-enzymes/drawCutSites';
import { drawRecognitionHighlights } from '../canvas-drawing-restriction';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { LayoutSnapshot2D, Layout2DRow, LinePositions, WorkspaceEditorConfig } from '../types';
import type { ColoredCutSite, RestrictionEnzyme } from '@waypoint/sequence-utils';
import { INTERNAL_CUT_SITE_STYLE } from '@waypoint/sequence-utils';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  type CanvasOp,
} from '../testing/recording-canvas-context';

const CONFIG: WorkspaceEditorConfig = {
  ...DEFAULT_EDITOR_CONFIG,
  showReverseComplement: true,
  showPrimers: false,
};

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
    totalWidth: 50 * CONFIG.charWidth + CONFIG.marginLeft,
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
      sequenceY: 10,
      complementY: 32,
      mutationTrackY: 0,
      hasMutationTrack: false,
      rulerY: 80,
      forwardPrimerY: 56,
      reversePrimerY: 64,
      lineEndY: 90,
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

const enzyme = (name: string): RestrictionEnzyme => ({ name }) as RestrictionEnzyme;

function internalSite(): ColoredCutSite {
  return {
    enzyme: enzyme('BsaI'),
    cutPositionTop: 10,
    cutPositionBottom: 10,
    recognitionStart: 10,
    recognitionEnd: 16,
    strand: 'forward',
    color: INTERNAL_CUT_SITE_STYLE.colorHex,
    isInternalCutSite: true,
  };
}

function normalSite(): ColoredCutSite {
  return {
    enzyme: enzyme('EcoRI'),
    cutPositionTop: 10,
    cutPositionBottom: 14,
    recognitionStart: 10,
    recognitionEnd: 16,
    strand: 'forward',
    color: '#3366cc',
  };
}

function runCutSites(sites: ColoredCutSite[]): CanvasOp[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const line = row();
  drawCutSites(ctx, sites, layoutFor(line), CONFIG, undefined, null, true, linePositionsFor(line));
  return getRecordingLog(canvas);
}

function runRecognition(sites: ColoredCutSite[]): CanvasOp[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const line = row();
  drawRecognitionHighlights(ctx, linePositionsFor(line), sites, CONFIG.marginLeft, CONFIG);
  return getRecordingLog(canvas);
}

const strokeColors = (log: CanvasOp[]): unknown[] =>
  log
    .filter((o) => o.op === 'set' && o.prop === 'strokeStyle')
    .map((o) => (o as { value: unknown }).value);
const fillColors = (log: CanvasOp[]): unknown[] =>
  log
    .filter((o) => o.op === 'set' && o.prop === 'fillStyle')
    .map((o) => (o as { value: unknown }).value);
const lineDashes = (log: CanvasOp[]): number[][] =>
  log
    .filter((o): o is Extract<CanvasOp, { op: 'setLineDash' }> => o.op === 'setLineDash')
    .map((o) => o.segments);
const arcs = (log: CanvasOp[]): Array<Extract<CanvasOp, { op: 'arc' }>> =>
  log.filter((o): o is Extract<CanvasOp, { op: 'arc' }> => o.op === 'arc');
const texts = (log: CanvasOp[]): string[] =>
  log
    .filter((o): o is Extract<CanvasOp, { op: 'fillText' }> => o.op === 'fillText')
    .map((o) => o.text);

describe('drawCutSites internal Type IIS restyle  #10)', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it('draws an internal site with a red line, dotted label border, and a ROUND ! badge', () => {
    const log = runCutSites([internalSite()]);

    expect(strokeColors(log)).toContain(INTERNAL_CUT_SITE_STYLE.colorHex);
    expect(strokeColors(log)).toContain(INTERNAL_CUT_SITE_STYLE.badgeStrokeHex);
    expect(fillColors(log)).toContain(INTERNAL_CUT_SITE_STYLE.badgeGlyphHex);
    expect(lineDashes(log)).toContainEqual([...INTERNAL_CUT_SITE_STYLE.labelBorderDash]);
    expect(arcs(log).length).toBeGreaterThanOrEqual(1);
    expect(texts(log)).toContain('BsaI');
    expect(texts(log)).toContain(INTERNAL_CUT_SITE_STYLE.badgeChar);
  });

  it('leaves an ordinary cut site with no dotted border, no badge, and no error red', () => {
    const log = runCutSites([normalSite()]);

    expect(texts(log)).toContain('EcoRI');
    expect(texts(log)).not.toContain(INTERNAL_CUT_SITE_STYLE.badgeChar);
    expect(arcs(log)).toHaveLength(0);
    expect(lineDashes(log)).not.toContainEqual([...INTERNAL_CUT_SITE_STYLE.labelBorderDash]);
    expect(strokeColors(log)).not.toContain(INTERNAL_CUT_SITE_STYLE.colorHex);
  });
});

describe('drawCutSites label size is LOD/zoom-independent', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  const recordedLabelFontPx = (fontSize: number): number[] => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const line = row();
    drawCutSites(
      ctx,
      [normalSite()],
      layoutFor(line),
      { ...CONFIG, fontSize },
      undefined,
      null,
      false,
      linePositionsFor(line)
    );
    return getRecordingLog(canvas)
      .filter((o) => o.op === 'set' && o.prop === 'font')
      .map((o) => Number.parseInt(String((o as { value: unknown }).value), 10));
  };

  it('renders cut-site labels at a constant font size regardless of zoom-scaled config.fontSize', () => {
    const featurePx = recordedLabelFontPx(4);
    const detailPx = recordedLabelFontPx(22);
    expect(featurePx.length).toBeGreaterThan(0);
    expect(new Set([...featurePx, ...detailPx]).size).toBe(1);
    expect(featurePx[0]).toBe(10);
  });
});

describe('drawRecognitionHighlights internal Type IIS restyle  #10)', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it('fills the internal recognition box error-red, the ordinary one neutral gray', () => {
    const internalFills = fillColors(runRecognition([internalSite()]));
    expect(internalFills).toContain('rgba(220, 38, 38, 0.4)');
    expect(internalFills).not.toContain('rgba(185, 185, 185, 0.25)');

    const normalFills = fillColors(runRecognition([normalSite()]));
    expect(normalFills).toContain('rgba(185, 185, 185, 0.25)');
    expect(normalFills).not.toContain('rgba(220, 38, 38, 0.4)');
  });
});
