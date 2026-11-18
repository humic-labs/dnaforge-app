import { parseGenomeComparisonPaf } from '@waypoint/genome-data';
import { createComparisonProjection } from '@waypoint/genome-renderer/pure';
import { describe, expect, it } from 'vitest';
import {
  comparisonCameraForTargetViewport,
  comparisonTargetViewport,
} from './comparison-projection-navigation';

const projection = createComparisonProjection({
  id: 'comparison',
  comparison: parseGenomeComparisonPaf(
    [
      'query\t50\t0\t12\t+\ttarget\t40\t0\t10\t10\t12\t60\tcg:Z:5=2I5=\tnn:i:0',
      'query\t50\t20\t30\t-\ttarget\t40\t20\t30\t10\t10\t60\tcg:Z:10=\tnn:i:0',
    ].join('\n'),
    { target: { id: 'target', length: 40 }, query: { id: 'query', length: 50 } }
  ),
});

describe('indexed target and projected comparison camera boundary', () => {
  it('maps a target navigation interval through a real insertion without treating columns as bases', () => {
    const camera = comparisonCameraForTargetViewport(projection, { start: 4, end: 7 });
    expect(camera).toEqual({ projectionId: 'comparison', startColumn: 4, endColumn: 9 });
    expect(comparisonTargetViewport(projection, camera!)).toEqual({ start: 4, end: 7 });
  });

  it('keeps the fixed-width unaligned join separate from its biological source interval', () => {
    const camera = comparisonCameraForTargetViewport(projection, { start: 12, end: 15 });
    expect(camera).toEqual({ projectionId: 'comparison', startColumn: 12, endColumn: 44 });
    expect(comparisonTargetViewport(projection, camera!)).toEqual({ start: 10, end: 20 });
  });

  it('returns the actual target loci after a rearrangement rather than clamping display columns to reference length', () => {
    const camera = { projectionId: 'comparison', startColumn: 47, endColumn: 50 };
    expect(comparisonTargetViewport(projection, camera)).toEqual({ start: 23, end: 26 });
    expect(comparisonCameraForTargetViewport(projection, { start: 23, end: 26 })).toEqual(camera);
  });

  it('does not invent a target navigation mapping outside the aligned source extent', () => {
    expect(comparisonCameraForTargetViewport(projection, { start: 35, end: 39 })).toBeNull();
  });
});
