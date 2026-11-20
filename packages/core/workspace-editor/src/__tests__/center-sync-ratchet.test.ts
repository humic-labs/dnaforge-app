import { describe, it, expect } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import {
  getSequencePositionAtScrollY,
  getScrollYForSequencePosition,
  yForAbsoluteRowIndex,
  viewportCenterRowBoundsChanged,
} from '../layout-utils';
import { DEFAULT_EDITOR_CONFIG } from '../types';

function maxFlatRun(values: Array<number | null>): number {
  let best = 0;
  let run = 0;
  let prev: number | null = NaN as unknown as number;
  for (const v of values) {
    if (v === prev) {
      run += 1;
    } else {
      run = 1;
      prev = v;
    }
    if (run > best) best = run;
  }
  return best;
}

describe(' center-sync ratchet: getSequencePositionAtScrollY advances across the full row pitch', () => {
  const seq: AnnotatedSequence = {
    id: 's',
    name: 's',
    sequence: 'ACGT'.repeat(400),
    length: 1600,
    annotations: [],
    circular: false,
  };
  const cpr = 80;
  const layout = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
  const summary = layout.summary!;

  it('compares only existing center-row bounds, including the last row bottom', () => {
    const table = (values: number[], totalRows = values.length - 1) => ({
      ...layout,
      summary: { ...summary, totalRows, rowYOffsets: Float64Array.from(values) },
    });
    const original = table([0, 10, 20]);
    const lastRowTaller = table([0, 10, 22]);
    const shorter = table([0, 10]);
    const empty = table([0]);
    const missingEnd = table([0, 10], 2);

    expect(viewportCenterRowBoundsChanged(original, lastRowTaller, 15)).toBe(true);
    expect(viewportCenterRowBoundsChanged(original, lastRowTaller, 5)).toBe(false);
    expect(viewportCenterRowBoundsChanged(original, shorter, 15)).toBe(false);
    expect(viewportCenterRowBoundsChanged(original, shorter, 5)).toBe(false);
    expect(viewportCenterRowBoundsChanged(empty, original, 5)).toBe(false);
    expect(viewportCenterRowBoundsChanged(original, empty, 5)).toBe(false);
    expect(viewportCenterRowBoundsChanged(missingEnd, original, 15)).toBe(false);
    expect(viewportCenterRowBoundsChanged(original, missingEnd, 15)).toBe(false);
  });

  it('layout has a non-zero inter-row gap (otherwise this test proves nothing)', () => {
    expect(summary.rowGapPx).toBeGreaterThan(0);
    const i = 3;
    const pitch = yForAbsoluteRowIndex(i + 1, summary) - yForAbsoluteRowIndex(i, summary);
    expect(pitch - summary.rowHeights[i]).toBe(summary.rowGapPx);
  });

  it('does not freeze the mapped position across the trailing row gap', () => {
    const i = 3;
    const rowTop = yForAbsoluteRowIndex(i, summary);
    const rowBottom = yForAbsoluteRowIndex(i + 1, summary);
    const pitch = rowBottom - rowTop;
    const charsInRow = layout.lines[i].sequence.length;

    const values: Array<number | null> = [];
    for (let y = rowTop; y < rowBottom; y += 1) {
      values.push(getSequencePositionAtScrollY(y, layout));
    }

    const perCharPx = Math.ceil(pitch / charsInRow);
    const flat = maxFlatRun(values);
    expect(flat).toBeLessThan(summary.rowGapPx);
    expect(flat).toBeLessThanOrEqual(perCharPx + 1);
  });

  it('covers ~all characters of the row across its pitch (monotonic, no saturation clamp)', () => {
    const i = 3;
    const rowTop = yForAbsoluteRowIndex(i, summary);
    const rowBottom = yForAbsoluteRowIndex(i + 1, summary);
    const charsInRow = layout.lines[i].sequence.length;
    const rowStart = layout.lines[i].startPos;

    const distinct = new Set<number>();
    let prev = -Infinity;
    let monotonic = true;
    for (let y = rowTop; y < rowBottom; y += 1) {
      const p = getSequencePositionAtScrollY(y, layout);
      if (p == null) continue;
      distinct.add(p);
      if (p < prev) monotonic = false;
      prev = p;
    }
    expect(monotonic).toBe(true);
    expect(distinct.size).toBeGreaterThan(charsInRow * 0.8);
    expect(prev).toBeLessThanOrEqual(rowStart + charsInRow);
  });
});

describe(' inverse SSOT: getScrollYForSequencePosition round-trips with the forward map', () => {
  const seqLen = 1000;
  const cpr = 100;
  const seq: AnnotatedSequence = {
    id: 'c',
    name: 'c',
    sequence: 'ACGT'.repeat(seqLen / 4),
    length: seqLen,
    annotations: [],
    circular: false,
  };
  const firstRow = 3;
  const lastRow = 6;
  const layout = computeSequenceLayoutImpl(
    seq,
    { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
    0,
    0,
    [],
    false,
    [],
    0,
    { firstRowIndex: firstRow, lastRowIndex: lastRow, emitOnlyViewportLines: true }
  );
  const summary = layout.summary!;

  it('exercises the rowYOffsets inverse fast-path (the branch under test)', () => {
    expect(summary.rowYOffsets?.length ?? 0).toBeGreaterThan(0);
    expect(layout.lines.length).not.toBe(summary.totalRows);
  });

  it('inverse then forward returns the original position (tight bound)', () => {
    for (let pos = firstRow * cpr; pos < (lastRow + 1) * cpr; pos += 13) {
      const y = getScrollYForSequencePosition(pos, layout);
      if (y == null) continue;
      const back = getSequencePositionAtScrollY(y, layout);
      if (back == null) continue;
      expect(Math.abs(back - pos)).toBeLessThanOrEqual(2);
    }
  });
});

it('keeps the circular origin centered when the browser rounds fractional scroll offsets', () => {
  const layout = computeSequenceLayoutImpl(
    {
      id: 'circular',
      name: 'Circular',
      sequence: 'A'.repeat(2686),
      length: 2686,
      annotations: [],
      circular: true,
    },
    { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 80 },
    205,
    6
  );
  const y = getScrollYForSequencePosition(0, layout, true, 'center')!;
  for (const viewportHeight of [400, 401]) {
    const scrollTop = Math.round(y - viewportHeight / 2);
    expect(getSequencePositionAtScrollY(scrollTop + viewportHeight / 2, layout)).toBe(0);
  }
});
