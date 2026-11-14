import { describe, expect, it } from 'vitest';
import type { TraceData } from '../../trace';
import { buildAlignedChromatogramOptions } from './aligned-chromatogram';

function fakeTrace(numPeaks: number): TraceData {
  const samples = numPeaks * 10;
  const ch = (): number[] => new Array(samples).fill(0);
  return {
    channels: { A: ch(), C: ch(), G: ch(), T: ch() },
    peakPositions: Array.from({ length: numPeaks }, (_, i) => 5 + i * 10),
    baseOrder: 'GATC',
    maxValue: 1000,
  };
}

describe('buildAlignedChromatogramOptions', () => {
  it('places aligned peaks on the reference grid at the correct offset', () => {
    const referenceSequence = 'TTTTTTACGTACGTTTTTT';
    const readSequence = 'ACGTACGT';
    const trace = fakeTrace(8);
    const result = buildAlignedChromatogramOptions({
      referenceSequence,
      trace,
      readSequence,
      readQuality: [40, 40, 40, 40, 40, 40, 40, 40],
      alignedQuery: 'ACGTACGT',
      alignedReference: 'ACGTACGT',
    });

    expect(result.coverageStart).toBe(6);
    expect(result.coverageEnd).toBe(14);
    expect(result.retainedPeaks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.droppedInsertions).toBe(0);
    expect(result.laneOptions.baseToColumn).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
    expect(result.laneOptions.totalColumns).toBe(19);
    expect(result.laneOptions.sequence).toBe('ACGTACGT');
  });

  it('handles a gap in the query (deletion in read vs reference): peak skipped, refIdx advances', () => {
    const trace = fakeTrace(7);
    const result = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGTACGT',
      trace,
      readSequence: 'ACGACGT',
      alignedQuery: 'ACG-ACGT',
      alignedReference: 'ACGTACGT',
    });

    expect(result.laneOptions.baseToColumn).toEqual([0, 1, 2, 4, 5, 6, 7]);
    expect(result.retainedPeaks).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.droppedInsertions).toBe(0);
    expect(result.deletionColumns).toEqual([3]);
    expect(result.laneOptions.deletionColumns).toEqual([3]);
  });

  it('records every deletion column for a multi-nucleotide deletion', () => {
    const trace = fakeTrace(6);
    const result = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGTACGT',
      trace,
      readSequence: 'ACGCGT',
      alignedQuery: 'ACG--CGT',
      alignedReference: 'ACGTACGT',
    });

    expect(result.deletionColumns).toEqual([3, 4]);
    expect(result.laneOptions.baseToColumn).toEqual([0, 1, 2, 5, 6, 7]);
    expect(result.coverageStart).toBe(0);
    expect(result.coverageEnd).toBe(8);
  });

  it('does NOT count TRAILING ref overhang as deletions (regression: huge red area past read end)', () => {
    const trace = fakeTrace(4);
    const result = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGTAAAA',
      trace,
      readSequence: 'ACGT',
      alignedQuery: 'ACGT----',
      alignedReference: 'ACGTAAAA',
    });
    expect(result.deletionColumns).toEqual([]);
    expect(result.coverageStart).toBe(0);
    expect(result.coverageEnd).toBe(4);
  });

  it('does NOT count leading ref overhang as deletions (deletions only inside coverage)', () => {
    const trace = fakeTrace(4);
    const result = buildAlignedChromatogramOptions({
      referenceSequence: 'TTTTACGT',
      trace,
      readSequence: 'ACGT',
      alignedQuery: '----ACGT',
      alignedReference: 'TTTTACGT',
    });

    expect(result.deletionColumns).toEqual([]);
    expect(result.coverageStart).toBe(4);
    expect(result.coverageEnd).toBe(8);
  });

  it('drops insertions in the read (gap in reference) and reports the count', () => {
    const trace = fakeTrace(5);
    const result = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGT',
      trace,
      readSequence: 'ACGGT',
      alignedQuery: 'ACGGT',
      alignedReference: 'AC-GT',
    });

    expect(result.laneOptions.baseToColumn).toEqual([0, 1, 2, 3]);
    expect(result.retainedPeaks).toEqual([0, 1, 3, 4]);
    expect(result.droppedInsertions).toBe(1);
  });

  it('finds the correct reference offset when the alignment is in the middle of a long ref', () => {
    const referenceSequence = 'A'.repeat(50) + 'CGTACGTAC' + 'G'.repeat(41);
    const trace = fakeTrace(9);
    const result = buildAlignedChromatogramOptions({
      referenceSequence,
      trace,
      readSequence: 'CGTACGTAC',
      alignedQuery: 'CGTACGTAC',
      alignedReference: 'CGTACGTAC',
    });
    expect(result.coverageStart).toBe(50);
    expect(result.coverageEnd).toBe(59);
    expect(result.laneOptions.totalColumns).toBe(100);
  });

  it('throws when alignedQuery and alignedReference have different lengths', () => {
    expect(() =>
      buildAlignedChromatogramOptions({
        referenceSequence: 'ACGT',
        trace: fakeTrace(4),
        readSequence: 'ACGT',
        alignedQuery: 'ACGT',
        alignedReference: 'ACG',
      })
    ).toThrow(/same length/);
  });

  it('throws when the alignment was computed against a different reference', () => {
    expect(() =>
      buildAlignedChromatogramOptions({
        referenceSequence: 'AAAAA',
        trace: fakeTrace(4),
        readSequence: 'ACGT',
        alignedQuery: 'ACGT',
        alignedReference: 'ACGT',
      })
    ).toThrow(/not found/);
  });

  it('preserves quality when provided; omits it when not', () => {
    const trace = fakeTrace(4);
    const withQ = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGT',
      trace,
      readSequence: 'ACGT',
      readQuality: [10, 20, 30, 40],
      alignedQuery: 'ACGT',
      alignedReference: 'ACGT',
    });
    expect(withQ.laneOptions.quality).toEqual([10, 20, 30, 40]);

    const withoutQ = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGT',
      trace,
      readSequence: 'ACGT',
      alignedQuery: 'ACGT',
      alignedReference: 'ACGT',
    });
    expect(withoutQ.laneOptions.quality).toBeUndefined();
  });

  it.each([[[0, 20, 30]], [[0, 20, 30, 40, 50]], [[0, 20, 30, 256]], [Array<number>(4)]])(
    'rejects malformed quality before dropping or mapping bases (%j)',
    (readQuality) => {
      expect(() =>
        buildAlignedChromatogramOptions({
          referenceSequence: 'ACGT',
          trace: fakeTrace(4),
          readSequence: 'ACGT',
          readQuality,
          alignedQuery: 'ACGT',
          alignedReference: 'ACGT',
        })
      ).toThrow('Quality values do not match the called bases.');
    }
  );

  it.each([[[]], [[0, 20, 30, 40]]])(
    'keeps unavailable quality distinct from Q0 after alignment (%j)',
    (readQuality) => {
      const result = buildAlignedChromatogramOptions({
        referenceSequence: 'ACGT',
        trace: fakeTrace(4),
        readSequence: 'ACGT',
        readQuality,
        alignedQuery: 'ACGT',
        alignedReference: 'ACGT',
      });
      expect(result.laneOptions.quality).toEqual(readQuality.length ? readQuality : undefined);
    }
  );

  it('output is always display-ready: laneOptions.reverseComplemented is always false', () => {
    const trace = fakeTrace(4);
    const rcResult = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGT',
      trace,
      readSequence: 'ACGT',
      alignedQuery: 'ACGT',
      alignedReference: 'ACGT',
      reverseComplemented: true,
    });
    expect(rcResult.laneOptions.reverseComplemented).toBe(false);
    const fwdResult = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGT',
      trace,
      readSequence: 'ACGT',
      alignedQuery: 'ACGT',
      alignedReference: 'ACGT',
      reverseComplemented: false,
    });
    expect(fwdResult.laneOptions.reverseComplemented).toBe(false);
  });

  it('RC alignment with insertion drops produces correct peak sample positions', () => {
    const totalSamples = 100;
    const ch = (): number[] => new Array(totalSamples).fill(0);
    const trace: TraceData = {
      channels: { A: ch(), C: ch(), G: ch(), T: ch() },
      peakPositions: [10, 30, 50, 70, 90],
      baseOrder: 'GATC',
      maxValue: 1000,
    };
    const result = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGT',
      trace,
      readSequence: 'ACXGT',
      alignedQuery: 'ACXGT',
      alignedReference: 'AC-GT',
      reverseComplemented: true,
    });
    expect(result.retainedPeaks).toEqual([0, 1, 3, 4]);
    expect([...result.laneOptions.trace.peakPositions]).toEqual([9, 29, 69, 89]);
  });

  it('extracts mutation columns where read disagrees with reference', () => {
    const trace = fakeTrace(4);
    const result = buildAlignedChromatogramOptions({
      referenceSequence: 'TTTACGTAAA',
      trace,
      readSequence: 'ATGT',
      alignedQuery: 'ATGT',
      alignedReference: 'ACGT',
    });
    expect(result.mutationColumns).toEqual([4]);
    expect(result.laneOptions.mutationColumns).toEqual([4]);
  });

  it('does not flag N as a mutation (low quality, not a substitution)', () => {
    const trace = fakeTrace(4);
    const result = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGT',
      trace,
      readSequence: 'ANGT',
      alignedQuery: 'ANGT',
      alignedReference: 'ACGT',
    });
    expect(result.mutationColumns).toEqual([]);
  });

  it('emits multiple mutation columns when read has multiple substitutions', () => {
    const trace = fakeTrace(6);
    const result = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGTAC',
      trace,
      readSequence: 'TCATAC',
      alignedQuery: 'TCATAC',
      alignedReference: 'ACGTAC',
    });
    expect(result.mutationColumns).toEqual([0, 2]);
  });

  it('totalColumns equals the full reference length, not just coverage span', () => {
    const referenceSequence = 'A'.repeat(500) + 'CGTACGTACG' + 'A'.repeat(490);
    const trace = fakeTrace(10);
    const result = buildAlignedChromatogramOptions({
      referenceSequence,
      trace,
      readSequence: 'CGTACGTACG',
      alignedQuery: 'CGTACGTACG',
      alignedReference: 'CGTACGTACG',
    });
    expect(result.laneOptions.totalColumns).toBe(1000);
    expect(result.coverageStart).toBe(500);
    expect(result.coverageEnd).toBe(510);
  });
});
