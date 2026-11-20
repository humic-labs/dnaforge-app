import { expect, it } from 'vitest';
import { buildSharedSequenceAxis, type SharedSangerLane } from './shared-sequence-read-model';
import {
  biologicalViewportForColumns,
  readSelectionForColumns,
  searchColumnRanges,
} from './shared-sequence-read-selection';

const axis = buildSharedSequenceAxis('ACGT', {
  mode: 'gapped',
  gappedSequence: '-AC--GT-',
  alignedQuery: 'TACATGTA',
});

it('projects map endpoints and clamps gap-only viewports to the preceding reference base', () => {
  expect(biologicalViewportForColumns(axis, { start: 3, end: 6 }, 4)).toEqual({
    start: 2,
    end: 3,
    centerColumn: 1,
  });
  expect(biologicalViewportForColumns(axis, { start: 3, end: 4 }, 4)).toEqual({
    start: 1,
    end: 1,
    centerColumn: 1,
  });
  expect(biologicalViewportForColumns(axis, { start: 0, end: 0 }, 0)).toEqual({
    start: 0,
    end: 0,
    centerColumn: 0,
  });
});

it('paints only matching biological columns, including split and origin-spanning matches', () => {
  expect(
    searchColumnRanges(axis, [{ start: 1, end: 2, strand: 'forward', type: 'nucleotide' }])
  ).toEqual([
    { start: 2, end: 3 },
    { start: 5, end: 6 },
  ]);
  expect(
    searchColumnRanges(axis, [
      { start: 3, end: 0, wraps: true, strand: 'reverse', type: 'nucleotide' },
    ])
  ).toEqual([
    { start: 1, end: 2 },
    { start: 6, end: 7 },
  ]);
});

it('copies aligned query bases including an insertion and excluding deletion columns', () => {
  expect(
    readSelectionForColumns(
      {
        id: 'query',
        label: 'query',
        kind: 'alignment',
        alignedReference: 'AC--GT',
        alignedQuery: 'ACTAG-',
      },
      { start: 5, end: 2 }
    )
  ).toEqual({ bases: 'TAG', first: 3, last: 5, quality: undefined });
});

it('reports the original reverse-read base and quality at a wrapped insertion', () => {
  const lane: SharedSangerLane = {
    kind: 'sanger',
    id: 'reverse',
    label: 'reverse',
    sequence: 'TGC',
    quality: [12, 35, 23],
    baseToColumn: [7, 8, 9],
    sourceBaseIndices: [12, 11, 10],
    sourcePeakPositions: [450, 424, 393],
    cycleLength: 8,
    mutationColumns: [],
    deletionColumns: [],
    trace: {
      channels: { A: [], C: [], G: [], T: [] },
      baseOrder: 'ACGT',
      peakPositions: [],
      maxValue: 1,
    },
  };
  expect(readSelectionForColumns(lane, { start: 0, end: 0 })).toEqual({
    bases: 'G',
    first: 12,
    last: 12,
    quality: 35,
    sample: 424,
  });
  expect(readSelectionForColumns(lane, { start: 3, end: 3 })).toBeNull();
});
