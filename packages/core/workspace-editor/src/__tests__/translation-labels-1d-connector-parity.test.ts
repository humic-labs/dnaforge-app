// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CDS_GLYPH_STYLE } from '@waypoint/platform';
import { drawTranslationLabels1D } from '../translation-labels-1d';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';
import type { ClassifiedCDS } from '../types';

beforeEach(installRecordingCanvas);
afterEach(uninstallRecordingCanvas);

describe('flat Canvas CDS connector parity', () => {
  it.each([1, -1] as const)(
    'places the thin line against the chevrons for direction %s',
    (direction) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      const cds: ClassifiedCDS = {
        type: 'CDS',
        name: 'CDS',
        start: 1,
        end: 120,
        direction,
        cdsType: 'full',
        translationLane: 0,
      };
      drawTranslationLabels1D(ctx, {
        cdss: [cds],
        pxPerBase: 10,
        columnCount: 240,
        sequenceLength: 240,
        viewportLeftX: 0,
        viewportRightX: 1600,
        originX: 0,
        bandTopY: 100,
        laneHeight: 40,
        labelHeight: 14,
        labelFontSize: 12,
        labelFontFamily: 'monospace',
      });
      const bands = getRecordingLog(canvas).filter((op) => op.op === 'fillRect' && op.w > 100);
      expect(bands).toHaveLength(1);
      const band = bands[0];
      expect(band.op).toBe('fillRect');
      if (band.op !== 'fillRect') throw Error('Missing painted CDS line');
      expect(band.h).toBe(CDS_GLYPH_STYLE.replacementTopEdgeHeight);
      expect(band.y + band.h).toBe(114);
    }
  );
});
