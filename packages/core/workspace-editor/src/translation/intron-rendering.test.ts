import { describe, it, expect } from 'vitest';
import {
  getIntronLineSegments,
  getIntronLabel,
  getResidueNumberVisibility,
} from './intron-rendering';

describe('getIntronLineSegments', () => {
  const basesPerLine = 80;

  it('returns single segment for intron within one line', () => {
    const segments = getIntronLineSegments(50, 60, basesPerLine);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      lineIndex: 0,
      startPos: 50,
      endPos: 60,
      type: 'single',
    });
  });

  it('returns start/end segments for intron spanning two lines', () => {
    const segments = getIntronLineSegments(70, 90, basesPerLine);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      lineIndex: 0,
      startPos: 70,
      endPos: 79,
      type: 'start',
    });
    expect(segments[1]).toMatchObject({
      lineIndex: 1,
      startPos: 80,
      endPos: 90,
      type: 'end',
    });
  });

  it('returns start/middle/end segments for intron spanning 3+ lines', () => {
    const segments = getIntronLineSegments(70, 250, basesPerLine);

    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(segments[0].type).toBe('start');
    expect(segments[segments.length - 1].type).toBe('end');
    const middleSegments = segments.filter((s) => s.type === 'middle');
    expect(middleSegments.length).toBeGreaterThanOrEqual(1);
  });

  it('produces correct line boundary edge case', () => {
    const segments = getIntronLineSegments(80, 90, basesPerLine);

    expect(segments).toHaveLength(1);
    expect(segments[0].lineIndex).toBe(1);
  });
});

describe('getIntronLabel', () => {
  it('produces "intron 1 (100 bp)" format', () => {
    expect(getIntronLabel(1, 100)).toBe('intron 1 (100 bp)');
  });

  it('handles single-bp intron', () => {
    expect(getIntronLabel(3, 1)).toBe('intron 3 (1 bp)');
  });
});

describe('getResidueNumberVisibility', () => {
  it('shows all residue numbers when zoom provides enough space', () => {
    const visible = getResidueNumberVisibility(1, 12, 11);
    expect(visible).toBe(true);
  });

  it('thins to every 5th at moderate zoom', () => {
    const visible10 = getResidueNumberVisibility(10, 4, 11);
    expect(visible10).toBe(true);
    const visible11 = getResidueNumberVisibility(11, 4, 11);
    expect(visible11).toBe(false);
  });
});
