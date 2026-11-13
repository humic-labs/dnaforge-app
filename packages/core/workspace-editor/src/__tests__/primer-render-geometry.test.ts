import { describe, expect, it } from 'vitest';
import type { PrimerDisplay } from '../types';
import { computeRenderedPrimerSegments } from '../primer-render-geometry';

describe('computeRenderedPrimerSegments', () => {
  it('splits a forward primer into tail, spacer, and PBS geometry', () => {
    const primer = primerDisplay({
      id: 'forward',
      start: 10,
      end: 30,
      direction: 'forward',
      overhangLength: 6,
      spacerLength: 2,
    });

    const segments = computeRenderedPrimerSegments({
      primers: [primer],
      direction: 'forward',
      lineStartPos: 0,
      lineEndPos: 100,
      originX: 0,
      bandTop: 20,
      charWidth: 2,
      rowHeight: 20,
      sequenceLength: 100,
    });

    expect(segments.map((segment) => segment.role)).toEqual(['tail', 'spacer', 'pbs']);
    expect(
      segments.map((segment) => [segment.start, segment.end, segment.x, segment.width])
    ).toEqual([
      [10, 14, 20, 8],
      [14, 16, 28, 4],
      [16, 30, 32, 28],
    ]);
  });

  it('splits a reverse primer with the spacer at the start of the overhang', () => {
    const primer = primerDisplay({
      id: 'reverse',
      start: 10,
      end: 30,
      direction: 'reverse',
      overhangLength: 6,
      spacerLength: 2,
    });

    const segments = computeRenderedPrimerSegments({
      primers: [primer],
      direction: 'reverse',
      lineStartPos: 0,
      lineEndPos: 100,
      originX: 0,
      bandTop: 40,
      charWidth: 2,
      rowHeight: 20,
      sequenceLength: 100,
    });

    expect(segments.map((segment) => segment.role)).toEqual(['pbs', 'spacer', 'tail']);
    expect(
      segments.map((segment) => [segment.start, segment.end, segment.x, segment.width])
    ).toEqual([
      [10, 24, 20, 28],
      [24, 26, 48, 4],
      [26, 30, 52, 8],
    ]);
  });

  it('keeps origin-spanning primer geometry in source-primer base order', () => {
    const primer = primerDisplay({
      id: 'wrap',
      start: 90,
      end: 10,
      direction: 'forward',
      overhangLength: 5,
    });

    const segments = computeRenderedPrimerSegments({
      primers: [primer],
      direction: 'forward',
      lineStartPos: 0,
      lineEndPos: 100,
      originX: 0,
      bandTop: 20,
      charWidth: 1,
      rowHeight: 20,
      sequenceLength: 100,
    });

    expect(segments.map((segment) => [segment.role, segment.start, segment.end])).toEqual([
      ['tail', 90, 95],
      ['pbs', 95, 100],
      ['pbs', 0, 10],
    ]);
    expect(segments.map((segment) => [segment.primerBaseStart, segment.primerBaseEnd])).toEqual([
      [0, 5],
      [5, 10],
      [10, 20],
    ]);
  });
});

function primerDisplay(input: Partial<PrimerDisplay> & Pick<PrimerDisplay, 'id'>): PrimerDisplay {
  const length =
    input.start !== undefined && input.end !== undefined && input.start <= input.end
      ? input.end - input.start
      : 20;
  return {
    name: input.id,
    start: 0,
    end: length,
    direction: 'forward',
    bases: 'A'.repeat(length),
    tm: 60,
    gc: 50,
    mismatches: [],
    ...input,
  };
}
