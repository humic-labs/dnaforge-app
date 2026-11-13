import { describe, it, expect } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import {
  absoluteRowIndexForBp,
  bpForAbsoluteRowIndex,
  approximateYForAbsoluteRowIndex,
  approximateAbsoluteRowIndexForY,
  calculateVisibleRange,
  getSequencePositionAtScrollY,
  hasCircularScrollBuffers,
} from '../layout-utils';
import { DEFAULT_EDITOR_CONFIG } from '../types';

function makeLinear(seqLen: number, charsPerLine = 80) {
  const seq: AnnotatedSequence = {
    id: 'lin',
    name: 'lin',
    sequence: 'ACGTACGTAC'.repeat(Math.ceil(seqLen / 10)).slice(0, seqLen),
    length: seqLen,
    annotations: [
      { name: 'a1', type: 'misc_feature', start: 20, end: 60, direction: 1 },
      { name: 'cds', type: 'CDS', start: 90, end: 180, direction: 1 },
    ],
    circular: false,
  };
  const layout = computeSequenceLayoutImpl(seq, {
    ...DEFAULT_EDITOR_CONFIG,
    charsPerLine,
  });
  return layout;
}

function makeCircular(
  seqLen: number,
  charsPerLine = 80,
  opts: { bpOffset?: number; virtualRowCount?: number } = {}
) {
  const virtualRowCount = opts.virtualRowCount ?? 5;
  const bpOffset = opts.bpOffset ?? 0;
  const seq: AnnotatedSequence = {
    id: 'circ',
    name: 'circ',
    sequence: 'ACGTACGTAC'.repeat(Math.ceil(seqLen / 10)).slice(0, seqLen),
    length: seqLen,
    annotations: [{ name: 'a1', type: 'misc_feature', start: 20, end: 60, direction: 1 }],
    circular: true,
  };
  return computeSequenceLayoutImpl(
    seq,
    { ...DEFAULT_EDITOR_CONFIG, charsPerLine },
    0,
    virtualRowCount,
    [],
    false,
    [],
    bpOffset
  );
}

describe('SequenceLayoutSummary — exists and reflects the layout', () => {
  it('linear: totalRows = realRowCount, buffers are zero', () => {
    const layout = makeLinear(500);
    expect(layout.summary).toBeDefined();
    const s = layout.summary!;
    expect(s.topBufferCount).toBe(0);
    expect(s.bottomBufferCount).toBe(0);
    expect(s.realRowCount).toBe(Math.ceil(500 / s.cpr));
    expect(s.totalRows).toBe(s.realRowCount);
    expect(s.totalRows).toBe(layout.lines.length);
  });

  it('circular: buffer + real + buffer equals totalRows', () => {
    const layout = makeCircular(500, 80, { virtualRowCount: 5 });
    const s = layout.summary!;
    expect(s.topBufferCount).toBe(5);
    expect(s.bottomBufferCount).toBe(5);
    expect(s.realRowCount).toBe(Math.ceil(500 / s.cpr));
    expect(s.totalRows).toBe(s.topBufferCount + s.realRowCount + s.bottomBufferCount);
    expect(s.totalRows).toBe(layout.lines.length);
  });

  it('topBp reflects circularOffset + bpOffset', () => {
    const layout = makeCircular(1000, 80, { bpOffset: 123 });
    expect(layout.summary!.topBp).toBe(123);
  });
});

describe('absoluteRowIndexForBp — matches lines[] startPos lookup', () => {
  it('linear: every row is found at its startPos', () => {
    const layout = makeLinear(500);
    for (let i = 0; i < layout.lines.length; i++) {
      const line = layout.lines[i];
      const got = absoluteRowIndexForBp(line.startPos, layout.summary!);
      expect(got).toBe(i);
    }
  });

  it('linear: invalid bp returns -1', () => {
    const layout = makeLinear(500);
    expect(absoluteRowIndexForBp(-1, layout.summary!)).toBe(-1);
    expect(absoluteRowIndexForBp(10000, layout.summary!)).toBe(-1);
  });

  it('circular: every real row is found at its startPos', () => {
    const layout = makeCircular(500, 80, { virtualRowCount: 5 });
    const s = layout.summary!;
    for (let i = s.topBufferCount; i < s.topBufferCount + s.realRowCount; i++) {
      const line = layout.lines[i];
      const got = absoluteRowIndexForBp(line.startPos, s);
      expect(got).toBe(i);
    }
  });

  it('circular: wraps bp beyond seqLength', () => {
    const layout = makeCircular(500, 80, { virtualRowCount: 5 });
    const s = layout.summary!;
    const firstReal = layout.lines[s.topBufferCount];
    expect(absoluteRowIndexForBp(firstReal.startPos + 500, s)).toBe(s.topBufferCount);
  });
});

describe('bpForAbsoluteRowIndex — matches lines[i].startPos', () => {
  it('linear: inverse of absoluteRowIndexForBp', () => {
    const layout = makeLinear(500);
    for (let i = 0; i < layout.lines.length; i++) {
      const got = bpForAbsoluteRowIndex(i, layout.summary!);
      expect(got).toBe(layout.lines[i].startPos);
    }
  });

  it('circular: matches real rows; buffer rows also produce valid modular bps', () => {
    const layout = makeCircular(500, 80, { virtualRowCount: 5, bpOffset: 30 });
    const s = layout.summary!;
    for (let i = s.topBufferCount; i < s.topBufferCount + s.realRowCount; i++) {
      const got = bpForAbsoluteRowIndex(i, s);
      expect(got).toBe(layout.lines[i].startPos);
    }
    for (let i = 0; i < layout.lines.length; i++) {
      const got = bpForAbsoluteRowIndex(i, s);
      expect(got).toBe(layout.lines[i].startPos);
    }
  });

  it('out-of-range returns -1', () => {
    const layout = makeLinear(500);
    expect(bpForAbsoluteRowIndex(-1, layout.summary!)).toBe(-1);
    expect(bpForAbsoluteRowIndex(99999, layout.summary!)).toBe(-1);
  });
});

describe('approximate Y helpers — in-the-ballpark for uniform layouts', () => {
  it('yForAbsoluteRowIndex is monotonic and starts at topPaddingPx', () => {
    const layout = makeLinear(500);
    const s = layout.summary!;
    let prevY = approximateYForAbsoluteRowIndex(0, s);
    expect(prevY).toBe(s.topPaddingPx);
    for (let i = 1; i < s.totalRows; i++) {
      const y = approximateYForAbsoluteRowIndex(i, s);
      expect(y).toBeGreaterThan(prevY);
      prevY = y;
    }
  });

  it('approximateAbsoluteRowIndexForY is inverse of approximateYForAbsoluteRowIndex', () => {
    const layout = makeLinear(1000);
    const s = layout.summary!;
    for (let i = 0; i < s.totalRows; i++) {
      const y = approximateYForAbsoluteRowIndex(i, s);
      const recovered = approximateAbsoluteRowIndexForY(y, s);
      expect(recovered).toBe(i);
    }
  });
});

describe('circular scroll buffer detection', () => {
  it('is false when circular layout has no virtual rows', () => {
    const layout = makeCircular(1000, 100, { virtualRowCount: 0 });

    expect(layout.firstRealRowIndex).toBe(0);
    expect(layout.firstBottomBufferIndex).toBe(layout.lines.length);
    expect(hasCircularScrollBuffers(layout)).toBe(false);
  });

  it('is true when circular detail layout has top and bottom buffer rows', () => {
    const layout = makeCircular(1000, 100, { virtualRowCount: 3 });

    expect(layout.firstRealRowIndex).toBe(3);
    expect(layout.firstBottomBufferIndex).toBeLessThan(layout.lines.length);
    expect(hasCircularScrollBuffers(layout)).toBe(true);
  });
});

describe('summary lookups with sparse emitted lines', () => {
  it('calculateVisibleRange uses lineIndex, not array index', () => {
    const seq: AnnotatedSequence = {
      id: 'lin',
      name: 'lin',
      sequence: 'ACGTACGTAC'.repeat(200),
      length: 2000,
      annotations: [],
      circular: false,
    };
    const full = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 });
    const scoped = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 },
      0,
      0,
      [],
      false,
      [],
      0,
      { firstRowIndex: 8, lastRowIndex: 10, emitOnlyViewportLines: true }
    );
    const scrollTop = full.summary!.rowYOffsets[9];

    expect(scoped.lines.map((line) => line.lineIndex)).toEqual([8, 9, 10]);
    const range = calculateVisibleRange(
      scrollTop,
      250,
      scoped.lines,
      scoped.sequenceLength ?? 0,
      false,
      scoped.summary
    );

    expect(range?.startPos).toBe(full.lines[9].startPos);
  });

  it('getSequencePositionAtScrollY resolves sparse row starts from summary geometry', () => {
    const scoped = computeSequenceLayoutImpl(
      {
        id: 'lin',
        name: 'lin',
        sequence: 'A'.repeat(2000),
        length: 2000,
        annotations: [],
        circular: false,
      },
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 },
      0,
      0,
      [],
      false,
      [],
      0,
      { firstRowIndex: 8, lastRowIndex: 10, emitOnlyViewportLines: true }
    );
    const y = scoped.summary!.rowYOffsets[12];

    expect(scoped.lines.some((line) => line.lineIndex === 12)).toBe(false);
    expect(getSequencePositionAtScrollY(y, scoped)).toBe(1200);
  });
});
