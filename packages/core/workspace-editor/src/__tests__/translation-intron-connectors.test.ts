/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drawTranslation } from '../translation-drawing';
import { drawAnnotations } from '../canvas-drawing';
import { DEFAULT_EDITOR_CONFIG, type ClassifiedCDS } from '../types';
import {
  TRANSLATION_AA_HEIGHT_RATIO,
  TRANSLATION_LABEL_HEIGHT,
  TRANSLATION_PILL_HEIGHT,
  TRANSLATION_TRANSCRIPT_HEIGHT,
} from '../layout-constants';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
  type CanvasOp,
} from '../testing/recording-canvas-context';

const sequence = 'ATG'.repeat(32);
const config = { ...DEFAULT_EDITOR_CONFIG, charWidth: 8, showResidueNumbers: false };
const x = 20;
const y = 10;
const gapCenterX = x + 48 * config.charWidth;

function cds(direction: 1 | -1): ClassifiedCDS & { lane: number } {
  return {
    name: 'Spliced coding sequence',
    type: 'CDS',
    start: 13,
    end: 84,
    segments: [
      { start: 13, end: 36 },
      { start: 61, end: 84 },
    ],
    direction,
    cdsType: 'full',
    translationLane: 0,
    lane: 0,
  };
}

function gapConnectionYs(log: CanvasOp[]) {
  const ys: number[] = [];
  let points: Array<{ x: number; y: number }> = [];
  for (const op of log) {
    if (op.op === 'beginPath') points = [];
    if (op.op === 'moveTo' || op.op === 'lineTo') points.push(op);
    if (op.op !== 'stroke') continue;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a.y === b.y && Math.min(a.x, b.x) < gapCenterX && Math.max(a.x, b.x) > gapCenterX)
        ys.push(a.y);
    }
  }
  return ys;
}

describe('spliced CDS intron connections', () => {
  beforeEach(installRecordingCanvas);
  afterEach(uninstallRecordingCanvas);

  for (const direction of [1, -1] as const) {
    it(`keeps only the amino-acid connection at nucleotide detail on strand ${direction}`, () => {
      const canvas = document.createElement('canvas');
      const result = drawTranslation(
        canvas.getContext('2d')!,
        sequence,
        [cds(direction)],
        0,
        sequence.length,
        x,
        y,
        config,
        sequence
      );
      const log = getRecordingLog(canvas);
      const connections = gapConnectionYs(log);
      const upperY = y + TRANSLATION_PILL_HEIGHT + TRANSLATION_TRANSCRIPT_HEIGHT / 2;
      const lowerY =
        y + TRANSLATION_LABEL_HEIGHT + (config.rowHeight * TRANSLATION_AA_HEIGHT_RATIO) / 2;
      expect(connections).not.toContain(upperY);
      expect(connections.filter((value) => value === lowerY)).toHaveLength(1);
      expect(result.codons).toHaveLength(16);
      expect(log.some((op) => op.op === 'fill')).toBe(true);
    });

    it(`retains the primary transcript connection when the amino-acid track is collapsed on strand ${direction}`, () => {
      const canvas = document.createElement('canvas');
      drawAnnotations(
        canvas.getContext('2d')!,
        [cds(direction)],
        0,
        sequence.length,
        x,
        y,
        1,
        { ...config, lodLevel: 'feature', showTranslation: false },
        sequence.length,
        undefined,
        undefined,
        true
      );
      expect(gapConnectionYs(getRecordingLog(canvas))).not.toHaveLength(0);
    });
  }
});
