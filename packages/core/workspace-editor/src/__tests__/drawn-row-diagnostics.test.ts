import { describe, expect, it, vi } from 'vitest';
import { summarizeDrawnRow } from '../drawn-row-diagnostics';
import type { PrecomputedLinePosition } from '../hooks/usePrecomputedLayout';

function row(): PrecomputedLinePosition {
  return {
    line: {
      lineIndex: 1,
      startPos: 0,
      endPos: 8,
      sequence: 'ACGTACGT',
      complementSequence: 'TGCATGCA',
      annotations: [],
      annotationLaneCount: 0,
    },
    absoluteLineY: 100,
    annotationY: 20,
    sequenceY: 40,
    lineEndY: 80,
    hasPrimers: false,
    hasForwardPrimers: false,
    hasReversePrimers: false,
  } as PrecomputedLinePosition;
}

describe('drawn row diagnostic cost and freshness', () => {
  it('does not rehash unchanged bases for every viewport scroll', () => {
    const position = row();
    const reads = vi.spyOn(String.prototype, 'charCodeAt');
    try {
      const first = summarizeDrawnRow(position);
      JSON.stringify(first);
      const initialReads = reads.mock.calls.length;
      expect(initialReads).toBe(16);
      const next = summarizeDrawnRow({ ...position, annotationY: 10, sequenceY: 30, lineEndY: 70 });
      expect(reads.mock.calls.length).toBe(initialReads);
      expect(next.sequenceHash).toBe(first.sequenceHash);
      expect(next.complementHash).toBe(first.complementHash);
      expect(next.viewportYStart).toBe(10);
      expect(next.absoluteSequenceY).toBe(first.absoluteSequenceY);
    } finally {
      reads.mockRestore();
    }
  });

  it('defers content hashing until evidence is read, preserving the captured immutable strings', () => {
    const position = row();
    const reads = vi.spyOn(String.prototype, 'charCodeAt');
    try {
      const captured = summarizeDrawnRow(position);
      expect(reads.mock.calls.length).toBe(0);
      position.line.sequence = 'TTTTTTTT';
      position.line.complementSequence = 'AAAAAAAA';
      const serialized = JSON.parse(JSON.stringify(captured));
      expect(reads.mock.calls.length).toBe(16);
      const original = summarizeDrawnRow(row());
      expect(serialized.sequenceHash).toBe(original.sequenceHash);
      expect(serialized.complementHash).toBe(original.complementHash);
      const current = summarizeDrawnRow(position);
      expect(current.sequenceHash).not.toBe(serialized.sequenceHash);
      expect(current.complementHash).not.toBe(serialized.complementHash);
    } finally {
      reads.mockRestore();
    }
  });

  it('detects changed sequence, complement and missing payload on the same row', () => {
    const position = row();
    const first = summarizeDrawnRow(position);
    position.line.sequence = 'TCGTACGT';
    position.line.complementSequence = 'AGCA';
    position.line.annotationLaneCount = 1;
    const next = summarizeDrawnRow(position);
    expect(next.sequenceHash).not.toBe(first.sequenceHash);
    expect(next.complementHash).not.toBe(first.complementHash);
    expect(next.payloadProblems).toEqual([
      'reverse-complement-length-mismatch',
      'annotation-lanes-without-annotations',
    ]);
    expect(next.payloadReady).toBe(false);
  });
});
