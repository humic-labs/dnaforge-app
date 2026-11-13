/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cdsReplacementZoomPresentation } from '@waypoint/platform';
import { drawTranslation } from '../translation-drawing';
import { DEFAULT_EDITOR_CONFIG, type ClassifiedCDS } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
  getRecordingLog,
} from '../testing/recording-canvas-context';

beforeEach(installRecordingCanvas);
afterEach(uninstallRecordingCanvas);

function paintCds(view: 'wrapped' | 'unwrapped', pixelsPerBp = 8) {
  const canvas = document.createElement('canvas');
  const sequence = 'ATG'.repeat(20);
  const cds: ClassifiedCDS = {
    type: 'CDS',
    name: 'coding',
    start: 1,
    end: 60,
    direction: 1,
    cdsType: 'full',
    translationLane: 0,
  };
  const policy = cdsReplacementZoomPresentation(pixelsPerBp, 840);
  const config = {
    ...DEFAULT_EDITOR_CONFIG,
    charWidth: pixelsPerBp,
    rowHeight: (20 * pixelsPerBp) / 8,
    fontSize: (11 * pixelsPerBp) / 8,
    ...(view === 'wrapped' ? { cdsZoomPresentation: policy, cdsDetailProgress: 1 } : {}),
  };
  const result = drawTranslation(
    canvas.getContext('2d')!,
    sequence,
    [cds],
    0,
    59,
    0,
    100,
    config,
    sequence,
    [],
    [],
    0,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    { skipLabels: view === 'unwrapped' }
  );
  let font = '';
  const sizes: number[] = [];
  for (const op of getRecordingLog(canvas)) {
    if (op.op === 'set' && op.prop === 'font') font = String(op.value);
    if (op.op === 'fillText' && op.text === 'M') sizes.push(Number(font.match(/([\d.]+)px/)?.[1]));
  }
  expect(sizes.length).toBeGreaterThan(0);
  return { sizes, trackHeight: result.trackHeight, config };
}

it.each([
  [8, 18, 14],
  [9.6, 21.6, 17],
  [14, 31.5, 24],
])('matches original Canvas 2D CDS proportions at %s px/base', (pitch, height, font) => {
  const result = paintCds('wrapped', pitch);
  expect.soft(result.trackHeight).toBeCloseTo(height, 8);
  for (const size of result.sizes) expect.soft(size).toBe(font);
});

it('preserves the existing separate 1D Canvas letter policy', () => {
  const result = paintCds('unwrapped');
  for (const size of result.sizes)
    expect(size).toBeCloseTo(result.config.fontSize * 1.27 * 0.92, 8);
  expect(result.trackHeight).toBe(result.config.rowHeight * 0.9);
});
