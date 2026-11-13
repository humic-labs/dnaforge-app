import { describe, expect, it } from 'vitest';

import {
  buildCoverageGpuAtlas,
  coverageGpuAtlasEligible,
  coverageGpuAtlasLogColorFill,
  coverageGpuAtlasHeightCutoffFill,
  coverageGpuAtlasMipLevel,
  sampleCoverageGpuAtlas,
  sampleCoverageGpuAtlasSmoothed,
} from './coverage-gpu-atlas';

function atlas() {
  return buildCoverageGpuAtlas({
    sourceIdentity: 'source-a',
    assemblyFingerprint: 'assembly-a',
    statistic: 'fixed-base-peak-mean-v1',
    payloadRevision: 'revision-a',
    assemblyEndBp: 18,
    baseBinSizeBp: 2,
    depthPercentiles: { p50: 5, p90: 10, p95: 12, p99: 15, max: 20 },
    layers: [
      {
        chrom: 'chrA',
        globalStartBp: 0,
        globalEndBp: 10,
        binSizeBp: 2,
        bins: new Float32Array([2, 4, 6, 8, 10]),
      },
      {
        chrom: 'chrB',
        globalStartBp: 10,
        globalEndBp: 18,
        binSizeBp: 2,
        bins: new Float32Array([100, 200, 300, 400]),
      },
    ],
  });
}

describe('coverage GPU atlas', () => {
  it('mean-pools odd chromosome-local rows without zero padding or seam mixing', () => {
    const value = atlas();
    expect(value.textureWidth).toBe(8);
    expect(value.textureHeight).toBe(7);
    expect(Array.from(value.data.slice(0, 5))).toEqual([2, 4, 6, 8, 10]);
    expect(Array.from(value.data.slice(8, 11))).toEqual([3, 7, 10]);
    expect(Array.from(value.data.slice(16, 18))).toEqual([5, 10]);
    expect(Array.from(value.data.slice(32, 36))).toEqual([100, 200, 300, 400]);
  });

  it('uses a physical sampling predicate instead of a span threshold', () => {
    const value = atlas();
    expect(coverageGpuAtlasEligible(value, 1_999, 1_000)).toBe(false);
    expect(coverageGpuAtlasEligible(value, 2_000, 1_000)).toBe(true);
    expect(coverageGpuAtlasEligible(value, 4_000, 2_000)).toBe(true);
  });

  it('chooses the finest mean mip no wider than a screen pixel', () => {
    const value = atlas();
    const chrA = value.chromosomes[0]!;
    expect(coverageGpuAtlasMipLevel(value, 2_000, 1_000, chrA)).toBe(0);
    expect(coverageGpuAtlasMipLevel(value, 4_000, 1_000, chrA)).toBe(1);
    expect(coverageGpuAtlasMipLevel(value, 8_000, 1_000, chrA)).toBe(2);
    expect(coverageGpuAtlasMipLevel(value, 1e9, 1, chrA)).toBe(chrA.rowCount - 1);
  });

  it('blends continuously across every mip boundary', () => {
    const value = atlas();
    const boundarySpan = value.baseBinSizeBp * 2 * 1_000;
    const below = sampleCoverageGpuAtlas(value, 2.1, boundarySpan * (1 - 1e-6), 1_000);
    const at = sampleCoverageGpuAtlas(value, 2.1, boundarySpan, 1_000);
    const above = sampleCoverageGpuAtlas(value, 2.1, boundarySpan * (1 + 1e-6), 1_000);
    expect(Math.abs(at - below)).toBeLessThan(1e-4);
    expect(Math.abs(above - at)).toBeLessThan(1e-4);
  });

  it('samples each side of a chromosome seam from its own rows', () => {
    const value = atlas();
    const chrA = value.chromosomes[0]!;
    const chrB = value.chromosomes[1]!;
    expect(sampleCoverageGpuAtlas(value, 9.999, 2_000, 1_000)).toBe(10);
    expect(sampleCoverageGpuAtlas(value, 10, 2_000, 1_000)).toBe(100);
    expect(sampleCoverageGpuAtlas(value, 11, 2_000, 1_000, chrA)).toBe(10);
    expect(sampleCoverageGpuAtlas(value, 9, 2_000, 1_000, chrB)).toBe(100);
    expect(sampleCoverageGpuAtlasSmoothed(value, 9.999, 2_000, 1_000)).toBeLessThan(11);
    expect(sampleCoverageGpuAtlasSmoothed(value, 10, 2_000, 1_000)).toBeGreaterThan(99);
  });

  it('matches the locked global logcolor height transfer', () => {
    expect(coverageGpuAtlasLogColorFill(0, 10, 100, 0.9)).toBe(0);
    expect(coverageGpuAtlasLogColorFill(5, 10, 100, 0.9)).toBeCloseTo(0.2475, 6);
    expect(coverageGpuAtlasLogColorFill(10, 10, 100, 0.9)).toBeCloseTo(0.495, 6);
    expect(coverageGpuAtlasLogColorFill(100, 10, 100, 0.9)).toBeCloseTo(0.9, 6);
  });

  it('maps a manual cutoff to full height and clips deeper coverage', () => {
    expect(coverageGpuAtlasHeightCutoffFill(0, 50, 0.9)).toBe(0);
    expect(coverageGpuAtlasHeightCutoffFill(10, 50, 0.9)).toBeGreaterThan(0);
    expect(coverageGpuAtlasHeightCutoffFill(50, 50, 0.9)).toBeCloseTo(0.9, 6);
    expect(coverageGpuAtlasHeightCutoffFill(500, 50, 0.9)).toBeCloseTo(0.9, 6);
  });

  it('manually interpolates same-row bin centres into a smooth ramp', () => {
    const value = buildCoverageGpuAtlas({
      sourceIdentity: 'ramp-source',
      assemblyFingerprint: 'ramp-assembly',
      statistic: 'fixed-base-peak-mean-v1',
      payloadRevision: 'ramp-revision',
      assemblyEndBp: 30,
      baseBinSizeBp: 10,
      depthPercentiles: { p50: 50, p90: 150, p95: 180, p99: 195, max: 200 },
      layers: [
        {
          chrom: 'ramp',
          globalStartBp: 0,
          globalEndBp: 30,
          binSizeBp: 10,
          bins: new Float32Array([0, 100, 200]),
        },
      ],
    });
    const samples = [5, 7.5, 10, 12.5, 15].map((bp) =>
      sampleCoverageGpuAtlas(value, bp, 1_000, 100)
    );
    expect(samples).toEqual([0, 25, 50, 75, 100]);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]! - samples[index - 1]!).toBe(25);
    }
  });

  it('fails closed for partial, gapped, mismatched-resolution, or anonymous input', () => {
    const common = {
      sourceIdentity: 'source-a',
      assemblyFingerprint: 'assembly-a',
      statistic: 'fixed-base-peak-mean-v1',
      payloadRevision: 'revision-a',
      assemblyEndBp: 10,
      baseBinSizeBp: 2,
      depthPercentiles: { p50: 1, p90: 1, p95: 1, p99: 1, max: 1 },
    } as const;
    expect(() =>
      buildCoverageGpuAtlas({
        ...common,
        sourceIdentity: '',
        layers: [
          {
            chrom: 'chrA',
            globalStartBp: 0,
            globalEndBp: 10,
            binSizeBp: 2,
            bins: new Float32Array(5),
          },
        ],
      })
    ).toThrow(/anonymous source/);
    expect(() =>
      buildCoverageGpuAtlas({
        ...common,
        layers: [
          {
            chrom: 'chrA',
            globalStartBp: 1,
            globalEndBp: 10,
            binSizeBp: 2,
            bins: new Float32Array(5),
          },
        ],
      })
    ).toThrow(/contiguously/);
    expect(() =>
      buildCoverageGpuAtlas({
        ...common,
        layers: [
          {
            chrom: 'chrA',
            globalStartBp: 0,
            globalEndBp: 10,
            binSizeBp: 4,
            bins: new Float32Array(3),
          },
        ],
      })
    ).toThrow(/mixed base/);
  });
});
