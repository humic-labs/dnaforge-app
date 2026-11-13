// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildAssembly } from '@waypoint/genome-renderer';

import { resolveFeatureDetailsCoords } from './indexed-genome-feature-details-coords';

const assembly = buildAssembly('test', 'Test', [
  { id: 'chr1', displayName: 'chr1', length: 1000, cytobands: [] },
  { id: 'chr7', displayName: 'chr7', length: 500, cytobands: [] },
]);

describe('resolveFeatureDetailsCoords', () => {
  it('single-chromosome view: passes through as chromosome-local (anchor chrom)', () => {
    const coords = resolveFeatureDetailsCoords(
      { start: 101, end: 200 },
      { rendererAssembly: null, anchorChrom: 'chr1' }
    );
    expect(coords).toEqual({ chrom: 'chr1', start: 100, end: 200 });
  });

  it('assembly view: inverts the global offset to (chrom, local) for a non-anchor chrom', () => {
    const coords = resolveFeatureDetailsCoords(
      { start: 1101, end: 1200 },
      { rendererAssembly: assembly, anchorChrom: 'chr1' }
    );
    expect(coords).toEqual({ chrom: 'chr7', start: 100, end: 200 });
  });

  it('assembly view: a feature on the anchor chrom still resolves locally', () => {
    const coords = resolveFeatureDetailsCoords(
      { start: 51, end: 150 },
      { rendererAssembly: assembly, anchorChrom: 'chr1' }
    );
    expect(coords).toEqual({ chrom: 'chr1', start: 50, end: 150 });
  });

  it('regression: the exact failing case maps below the chromosome length, never above it', () => {
    const big = buildAssembly('grch38', 'GRCh38', [
      { id: 'chr1', displayName: 'chr1', length: 248_956_422, cytobands: [] },
      { id: 'chr7', displayName: 'chr7', length: 159_345_973, cytobands: [] },
    ]);
    const globalStart = 248_956_422 + 100;
    const coords = resolveFeatureDetailsCoords(
      { start: globalStart + 1, end: globalStart + 320 },
      { rendererAssembly: big, anchorChrom: 'chr1' }
    );
    expect(coords?.chrom).toBe('chr7');
    expect(coords?.start).toBe(100);
    expect(coords?.end).toBe(420);
    expect(coords?.end).toBeLessThan(159_345_973);
  });

  it('returns null when the global coordinate is outside the assembly (do not fire the request)', () => {
    const coords = resolveFeatureDetailsCoords(
      { start: 9_999_999, end: 10_000_000 },
      { rendererAssembly: assembly, anchorChrom: 'chr1' }
    );
    expect(coords).toBeNull();
  });
});
