// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drawCutSites1D } from '../restriction-enzymes/drawCutSites1D';
import type { Layout1D } from '../layout-1d';
import type { ColoredCutSite, RestrictionEnzyme } from '@waypoint/sequence-utils';
import { INTERNAL_CUT_SITE_STYLE } from '@waypoint/sequence-utils';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
  type CanvasOp,
} from '../testing/recording-canvas-context';

const LAYOUT = {
  pxPerBase: 12,
  columnCount: 50,
  isCircular: false,
  sequenceRowY: 20,
  sequenceRowHeight: 16,
  cutSiteLabelRowY: 80,
} as Layout1D;

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

function run(sites: ColoredCutSite[]): CanvasOp[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  drawCutSites1D({
    ctx,
    layout: LAYOUT,
    originX: 0,
    viewportLeftX: 0,
    viewportRightX: 1000,
    cutSites: sites,
    scannedCutSites: [],
    baseFontSize: 11,
    fontFamily: 'monospace',
    showReverseComplement: true,
    hoveredEnzymeName: null,
    hoveredPositionInfo: null,
    hoveredCutSite: null,
  });
  return getRecordingLog(canvas);
}

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

describe('drawCutSites1D internal Type IIS restyle  #10)', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it('draws an internal site with a red recognition box, dotted border, and a ROUND ! badge', () => {
    const log = run([internalSite()]);

    expect(fillColors(log)).toContain('rgba(220, 38, 38, 0.4)');
    expect(fillColors(log)).toContain(INTERNAL_CUT_SITE_STYLE.badgeGlyphHex);
    expect(lineDashes(log)).toContainEqual([...INTERNAL_CUT_SITE_STYLE.labelBorderDash]);
    expect(arcs(log).length).toBeGreaterThanOrEqual(1);
    expect(texts(log)).toContain('BsaI');
    expect(texts(log)).toContain(INTERNAL_CUT_SITE_STYLE.badgeChar);
  });

  it('leaves an ordinary site gray with no dotted border and no badge', () => {
    const log = run([normalSite()]);

    expect(fillColors(log)).toContain('rgba(185, 185, 185, 0.25)');
    expect(fillColors(log)).not.toContain('rgba(220, 38, 38, 0.4)');
    expect(arcs(log)).toHaveLength(0);
    expect(lineDashes(log)).not.toContainEqual([...INTERNAL_CUT_SITE_STYLE.labelBorderDash]);
    expect(texts(log)).not.toContain(INTERNAL_CUT_SITE_STYLE.badgeChar);
  });
});
