// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { drawSequenceText } from '../canvas-drawing-sequence-text';
import type { LinePositions, WorkspaceEditorConfig } from '../types';

it('preserves the exact 2D letter, background and deletion-strike styling', () => {
  const letters: Array<[string, string]> = [];
  const backgrounds: string[] = [];
  const strokes: Array<[string, number]> = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect: () => backgrounds.push(context.fillStyle),
    fillText: (text: string) => letters.push([text, context.fillStyle]),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => strokes.push([context.strokeStyle, context.lineWidth]),
  };
  drawSequenceText(
    context as unknown as CanvasRenderingContext2D,
    [{ line: { sequence: 'ACGT', startPos: 0 }, sequenceY: 0 }] as LinePositions[],
    0,
    {
      fontFamily: 'monospace',
      fontSize: 16,
      rowHeight: 18,
      charWidth: 12,
    } as WorkspaceEditorConfig,
    [{ start: 0, end: 1 }],
    [{ start: 1, end: 2 }],
    [{ start: 2, end: 3, original: 'A' }]
  );
  expect(letters.slice(0, 3)).toEqual([
    ['A', 'rgba(244, 67, 54, 0.6)'],
    ['C', '#22c55e'],
    ['G', '#e09c07'],
  ]);
  expect(backgrounds).toEqual([
    'rgba(244, 67, 54, 0.15)',
    'rgba(34, 197, 94, 0.15)',
    'rgba(255, 200, 0, 0.15)',
  ]);
  expect(strokes).toEqual([['rgba(244, 67, 54, 0.8)', 1.5]]);
});
