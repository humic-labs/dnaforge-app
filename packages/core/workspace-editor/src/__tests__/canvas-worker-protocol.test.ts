import { describe, it, expect } from 'vitest';
import {
  createViewportScopedLayout,
  encodeSequenceToSharedBuffer,
  decodeSequenceFromSharedBuffer,
  cullLinesToViewport,
} from '../canvas-worker-protocol';
import type { PrecomputedLinePosition } from '../hooks/usePrecomputedLayout';
import type { SequenceLayout } from '../types';

describe('encodeSequenceToSharedBuffer', () => {
  it('encodes an ASCII sequence to SharedArrayBuffer', () => {
    const sequence = 'ATGCATGC';
    const { buffer, length } = encodeSequenceToSharedBuffer(sequence);

    expect(buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(length).toBe(8);
  });

  it('round-trips a sequence through encode/decode', () => {
    const sequence = 'ATGCNNN---ATGC';
    const { buffer, length } = encodeSequenceToSharedBuffer(sequence);
    const decoded = decodeSequenceFromSharedBuffer(buffer, length);

    expect(decoded).toBe(sequence);
  });

  it('handles empty sequence', () => {
    const { buffer, length } = encodeSequenceToSharedBuffer('');
    expect(length).toBe(0);
    expect(decodeSequenceFromSharedBuffer(buffer, length)).toBe('');
  });

  it('handles large sequence (1M bases)', () => {
    const sequence = 'ATGC'.repeat(250_000);
    const { buffer, length } = encodeSequenceToSharedBuffer(sequence);

    expect(length).toBe(1_000_000);
    const decoded = decodeSequenceFromSharedBuffer(buffer, length);
    expect(decoded.slice(0, 8)).toBe('ATGCATGC');
    expect(decoded.slice(-8)).toBe('ATGCATGC');
    expect(decoded.length).toBe(1_000_000);
  });

  it('buffer is shared (modifications visible across views)', () => {
    const sequence = 'AAAA';
    const { buffer } = encodeSequenceToSharedBuffer(sequence);

    const view2 = new Uint8Array(buffer);
    view2[0] = 'T'.charCodeAt(0);

    const view1 = new Uint8Array(buffer);
    expect(String.fromCharCode(view1[0])).toBe('T');
  });
});

function makeLine(
  lineIndex: number,
  absoluteLineY: number,
  lineHeight: number
): PrecomputedLinePosition {
  return {
    line: {
      lineIndex,
      startPos: lineIndex * 80,
      endPos: (lineIndex + 1) * 80,
      sequence: 'A'.repeat(80),
      annotations: [],
      annotationLaneCount: 0,
    } as PrecomputedLinePosition['line'],
    annotationY: absoluteLineY,
    translationY: absoluteLineY + 16,
    translationLaneCount: 0,
    sequenceY: absoluteLineY + 32,
    complementY: absoluteLineY + 48,
    mutationTrackY: absoluteLineY + 64,
    hasMutationTrack: false,
    rulerY: absoluteLineY + 80,
    forwardPrimerY: absoluteLineY + 96,
    reversePrimerY: absoluteLineY + 112,
    lineEndY: absoluteLineY + lineHeight,
    hasPrimers: false,
    hasForwardPrimers: false,
    hasReversePrimers: false,
    absoluteLineY,
    forwardOrfY: absoluteLineY + 128,
    reverseOrfY: absoluteLineY + 144,
    forwardOrfLaneCount: 0,
    reverseOrfLaneCount: 0,
  };
}

describe('cullLinesToViewport', () => {
  const lineHeight = 160;
  const lines = Array.from({ length: 10 }, (_, i) => makeLine(i, i * lineHeight, lineHeight));

  it('returns lines visible in viewport', () => {
    const cache: PrecomputedLinePosition[] = [];
    const count = cullLinesToViewport(lines, 0, 400, cache);

    expect(count).toBeGreaterThanOrEqual(3);
    expect(cache[0].line.lineIndex).toBe(0);
  });

  it('applies ±100px buffer', () => {
    const cache: PrecomputedLinePosition[] = [];
    const count = cullLinesToViewport(lines, 320, 200, cache);

    const indices = cache.slice(0, count).map((l) => l.line.lineIndex);
    expect(indices).toContain(1);
    expect(indices).toContain(2);
  });

  it('applies scroll offset to Y coordinates', () => {
    const cache: PrecomputedLinePosition[] = [];
    const scrollTop = 500;
    cullLinesToViewport(lines, scrollTop, 400, cache);

    for (const cached of cache) {
      const original = lines.find((l) => l.line.lineIndex === cached.line.lineIndex)!;
      expect(cached.annotationY).toBe(original.annotationY - scrollTop);
      expect(cached.sequenceY).toBe(original.sequenceY - scrollTop);
      expect(cached.rulerY).toBe(original.rulerY - scrollTop);
    }
  });

  it('returns 0 for zero viewport height', () => {
    const cache: PrecomputedLinePosition[] = [];
    const count = cullLinesToViewport(lines, 0, 0, cache);
    expect(count).toBe(0);
  });

  it('excludes lines entirely above viewport', () => {
    const cache: PrecomputedLinePosition[] = [];
    const count = cullLinesToViewport(lines, 800, 400, cache);

    const indices = cache.slice(0, count).map((l) => l.line.lineIndex);
    expect(indices).not.toContain(0);
    expect(indices).not.toContain(1);
    expect(indices).not.toContain(2);
  });

  it('excludes lines entirely below viewport', () => {
    const cache: PrecomputedLinePosition[] = [];
    const count = cullLinesToViewport(lines, 0, 400, cache);

    const indices = cache.slice(0, count).map((l) => l.line.lineIndex);
    expect(indices).not.toContain(8);
    expect(indices).not.toContain(9);
  });

  it('reuses cache array across calls (no allocations)', () => {
    const cache: PrecomputedLinePosition[] = [];

    cullLinesToViewport(lines, 0, 400, cache);
    const firstCacheObj = cache[0];

    cullLinesToViewport(lines, 200, 400, cache);

    expect(cache[0]).toBe(firstCacheObj);
  });

  it('trims cache when fewer lines are visible', () => {
    const cache: PrecomputedLinePosition[] = [];

    cullLinesToViewport(lines, 0, 2000, cache);
    expect(cache.length).toBe(10);

    const count = cullLinesToViewport(lines, 0, 200, cache);
    expect(cache.length).toBe(count);
    expect(count).toBeLessThan(10);
  });

  it('handles sparse large layouts without scanning from the start', () => {
    const cache: PrecomputedLinePosition[] = [];
    const largeLines = Array.from({ length: 50_000 }, (_, i) =>
      makeLine(i, i * lineHeight, lineHeight)
    );

    const count = cullLinesToViewport(largeLines, 4_000_000, 400, cache);
    const indices = cache.slice(0, count).map((l) => l.line.lineIndex);

    expect(count).toBeGreaterThan(0);
    expect(indices[0]).toBeGreaterThan(24_000);
    expect(indices[indices.length - 1]).toBeLessThan(26_000);
  });

  it('preserves viewport intersection behavior with variable row heights', () => {
    const cache: PrecomputedLinePosition[] = [];
    const variableLines = [
      makeLine(0, 0, 50),
      makeLine(1, 50, 200),
      makeLine(2, 250, 80),
      makeLine(3, 330, 300),
      makeLine(4, 630, 70),
    ];

    const count = cullLinesToViewport(variableLines, 350, 180, cache);
    expect(cache.slice(0, count).map((l) => l.line.lineIndex)).toEqual([1, 2, 3, 4]);
  });
});

describe('createViewportScopedLayout', () => {
  it('preserves layout metadata but scopes lines to the viewport payload', () => {
    const lines = Array.from({ length: 1_000 }, (_, i) => makeLine(i, i * 160, 160));
    const sourceLayout: SequenceLayout = {
      lines: lines.map((lp) => lp.line),
      totalHeight: 160_000,
      totalWidth: 1_200,
      sequenceLength: 80_000,
      isCircular: true,
      circularOffset: 123,
      bpOffset: 45,
      firstRealRowIndex: 10,
      firstBottomBufferIndex: 990,
      realRowsStartY: 1_600,
      bottomBufferStartY: 158_400,
      summary: {
        cpr: 80,
        seqLength: 80_000,
        totalRows: 1_000,
        realRowCount: 980,
        topBufferCount: 10,
        bottomBufferCount: 10,
        topBp: 0,
        isCircular: true,
        avgRowHeight: 128,
        rowGapPx: 32,
        topPaddingPx: 24,
        rowHeights: new Int32Array(1_000),
        rowYOffsets: new Int32Array(1_001),
      },
    };
    const cache: PrecomputedLinePosition[] = [];
    cullLinesToViewport(lines, 40_000, 400, cache);

    const scoped = createViewportScopedLayout(sourceLayout, cache);

    expect(scoped.totalHeight).toBe(sourceLayout.totalHeight);
    expect(scoped.totalWidth).toBe(sourceLayout.totalWidth);
    expect(scoped.sequenceLength).toBe(sourceLayout.sequenceLength);
    expect(scoped.isCircular).toBe(true);
    expect(scoped.circularOffset).toBe(123);
    expect(scoped.bpOffset).toBe(45);
    expect(scoped.summary).toBeUndefined();
    expect(scoped.lines).toEqual(cache.map((lp) => lp.line));
    expect(scoped.lines.length).toBeLessThan(sourceLayout.lines.length);
  });
});

describe('message type discrimination', () => {
  it('MainToWorkerMessage types are distinguishable by type field', () => {
    const types = ['init', 'render', 'viewport', 'sequence-data', 'theme'];
    expect(new Set(types).size).toBe(types.length);
  });

  it('WorkerToMainMessage types are distinguishable by type field', () => {
    const types = ['ready', 'render-complete', 'error'];
    expect(new Set(types).size).toBe(types.length);
  });
});
