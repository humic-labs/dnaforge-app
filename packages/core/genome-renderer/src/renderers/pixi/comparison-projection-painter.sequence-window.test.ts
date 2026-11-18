import { beforeAll, describe, expect, it } from 'vitest';
import { Container, Text } from 'pixi.js';
import { createGenomeComparisonBlock } from '@waypoint/genome-data';
import {
  comparisonColumnX,
  comparisonPlot,
  createComparisonProjection,
  type ComparisonCamera,
  type ComparisonProjection,
} from '../../comparison-projection';
import { comparisonFixture } from '../../test-support/comparison-projection-fixture';
import type { RenderState } from '../../types';
import { ComparisonProjectionPainter } from './comparison-projection-painter';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((id: string) =>
    id !== '2d'
      ? null
      : {
          font: '',
          fillStyle: '',
          textBaseline: '',
          scale: () => undefined,
          measureText: (text: string) => ({ width: text.length * 6 }),
          fillText: () => undefined,
          clearRect: () => undefined,
        }) as typeof HTMLCanvasElement.prototype.getContext;
});

const state: RenderState = {
  morph: 0,
  viewOffset: 0,
  zoom: 1,
  width: 1000,
  height: 600,
  selectedIds: new Set(),
  hoveredId: null,
  highlightRange: null,
  cursorPosition: null,
  hoveredCutSiteId: null,
  perfPanelVisible: false,
};

function labelsAtY(container: Container, y: number): Array<{ text: string; x: number }> {
  return container.children.flatMap((child) =>
    child instanceof Text
      ? child.visible && child.y === y
        ? [{ text: child.text, x: child.x }]
        : []
      : child instanceof Container
        ? labelsAtY(child, y)
        : []
  );
}

function expectRows(
  projection: ComparisonProjection,
  camera: ComparisonCamera,
  target: ReadonlyArray<readonly [number, string]>,
  query: ReadonlyArray<readonly [number, string]>
) {
  const painter = new ComparisonProjectionPainter();
  const plot = comparisonPlot(state.width, state.height);
  try {
    painter.paint(projection, camera, state);
    for (const [expected, y] of [
      [target, plot.targetY],
      [query, plot.queryY],
    ] as const) {
      expect(labelsAtY(painter.container, y)).toEqual(
        expected.map(([column, text]) => ({
          text,
          x: comparisonColumnX(column + 0.5, camera, plot),
        }))
      );
    }
    expect(painter.getDiagnostics()).toMatchObject({
      baseLetters: target.length + query.length,
    });
  } finally {
    painter.destroy();
  }
}

describe('comparison painter source sequence windows', () => {
  it('uses explicit source windows across indels without filling unavailable bases from full strings', () => {
    const projection = createComparisonProjection({
      ...comparisonFixture(),
      targetSequenceWindows: [{ start: 2, sequence: 'ga' }],
      querySequenceWindows: [{ start: 2, sequence: 'tcga' }],
    });
    expectRows(
      projection,
      { projectionId: projection.id, startColumn: 0, endColumn: 9 },
      [
        [2, '-'],
        [3, '-'],
        [4, 'G'],
        [5, 'A'],
      ],
      [
        [2, 'T'],
        [3, 'C'],
        [4, 'G'],
        [5, 'A'],
        [6, '-'],
      ]
    );
  });

  it('draws a bounded query window in reverse complement source order without full strings', () => {
    const projection = createComparisonProjection({
      ...comparisonFixture(),
      targetSequence: undefined,
      querySequence: undefined,
      targetSequenceWindows: [{ start: 11, sequence: 'cg' }],
      querySequenceWindows: [
        { start: 12, sequence: 'g' },
        { start: 10, sequence: 'a' },
      ],
    });
    expectRows(
      projection,
      { projectionId: projection.id, startColumn: 41, endColumn: 44 },
      [
        [42, 'C'],
        [43, 'G'],
      ],
      [
        [41, 'C'],
        [43, 'T'],
      ]
    );
  });

  it('treats explicit empty windows as unavailable and retains actual alignment gaps', () => {
    const projection = createComparisonProjection({
      ...comparisonFixture(),
      targetSequenceWindows: [],
      querySequenceWindows: [],
    });
    expectRows(
      projection,
      { projectionId: projection.id, startColumn: 0, endColumn: 9 },
      [
        [2, '-'],
        [3, '-'],
      ],
      [[6, '-']]
    );
  });

  it('paints far-apart source windows on both sides of a rearrangement without intervening bases', () => {
    const projection = createComparisonProjection({
      id: 'rearranged-windows',
      comparison: {
        target: { id: 'target', length: 4 },
        query: { id: 'query', length: 4_000_000 },
        blocks: [
          createGenomeComparisonBlock({
            id: 'forward',
            target: { referenceId: 'target', start: 0, end: 2 },
            query: { referenceId: 'query', start: 1_000_000, end: 1_000_002 },
            strand: '+',
            matchingBases: 2,
            alignmentColumns: 2,
            mappingQuality: 60,
            cigar: '2M',
          }),
          createGenomeComparisonBlock({
            id: 'reverse',
            target: { referenceId: 'target', start: 2, end: 4 },
            query: { referenceId: 'query', start: 3_000_000, end: 3_000_002 },
            strand: '-',
            matchingBases: 2,
            alignmentColumns: 2,
            mappingQuality: 60,
            cigar: '2M',
          }),
        ],
      },
      targetSequenceWindows: [
        { start: 2, sequence: 'gt' },
        { start: 0, sequence: 'ac' },
      ],
      querySequenceWindows: [
        { start: 3_000_000, sequence: 'tg' },
        { start: 1_000_000, sequence: 'ac' },
      ],
    });
    expectRows(
      projection,
      { projectionId: projection.id, startColumn: 0, endColumn: 36 },
      [
        [0, 'A'],
        [1, 'C'],
        [34, 'G'],
        [35, 'T'],
      ],
      [
        [0, 'A'],
        [1, 'C'],
        [34, 'C'],
        [35, 'A'],
      ]
    );
  });
});
