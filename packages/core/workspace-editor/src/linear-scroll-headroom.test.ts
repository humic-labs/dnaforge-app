import { expect, it } from 'vitest';
import { linearScrollEndGeometry, offsetLayoutViewport } from './linear-scroll-headroom';
import { computeSequenceLayoutImpl } from './useSequenceLayout';
import { DEFAULT_EDITOR_CONFIG } from './types';

it('centers the true final row even when only middle rows are prepared', () => {
  const sequence = {
    id: 'linear',
    name: 'linear',
    sequence: 'N'.repeat(150000),
    length: 150000,
    circular: false,
    annotations: [],
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const full = computeSequenceLayoutImpl(sequence, config);
  const scoped = computeSequenceLayoutImpl(sequence, config, 0, 0, [], false, [], 0, {
    firstRowIndex: 600,
    lastRowIndex: 728,
    emitOnlyViewportLines: true,
  });
  const end = linearScrollEndGeometry(scoped, 640);
  expect(end).toEqual(linearScrollEndGeometry(full, 640));
  const maxScroll = end.totalHeight + end.headroom - 640;
  expect(end.lastRowTop + end.lastRowHeight / 2 - maxScroll).toBeCloseTo(320);
  expect(end.headroom).toBeGreaterThan(0);
});

it('does not add headroom to circular sequences or an unmeasured viewport', () => {
  const layout = { lines: [], totalHeight: 0, totalWidth: 0, isCircular: true };
  expect(linearScrollEndGeometry(layout, 640).headroom).toBe(0);
  expect(linearScrollEndGeometry({ ...layout, isCircular: false }, 0).headroom).toBe(0);
});

it('keeps the global prefix and bounded scientific rows in the same coordinate space', () => {
  const sequence = {
    id: 'shift',
    name: 'shift',
    sequence: 'N'.repeat(150000),
    length: 150000,
    circular: false,
    annotations: [],
  };
  const original = computeSequenceLayoutImpl(
    sequence,
    { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 },
    0,
    0,
    [],
    false,
    [],
    0,
    { firstRowIndex: 600, lastRowIndex: 728, emitOnlyViewportLines: true }
  );
  const shifted = offsetLayoutViewport(original, 57.5);
  expect(shifted.lines.length).toBe(129);
  expect(shifted.totalHeight).toBe(original.totalHeight + 57.5);
  for (const row of shifted.lines) {
    expect(row.y).toBe(shifted.summary!.rowYOffsets[row.lineIndex]);
    expect(row.sequence).toBe(
      original.lines.find((old) => old.lineIndex === row.lineIndex)!.sequence
    );
  }
  expect(linearScrollEndGeometry(shifted, 640).headroom).toBe(
    linearScrollEndGeometry(original, 640).headroom
  );
  expect(offsetLayoutViewport(shifted, 0)).toEqual({ ...original, viewportOriginOffset: 0 });
});
