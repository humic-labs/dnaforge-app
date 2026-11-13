// @vitest-environment node

import type { ResolvedTranscript } from '@waypoint/genome-data';
import type { GenomeTrackTile } from '../../../shared/indexed-genome';
import { describe, expect, it, vi } from 'vitest';

import { loadAssemblyAnnotationTileFeatures } from './assembly-annotation-tile-loader';

function transcript(index: number): ResolvedTranscript {
  return {
    chrom: 'chr7',
    source: 'test',
    type: 'mRNA',
    start: 100,
    end: 900,
    score: null,
    strand: '+',
    phase: null,
    attributes: { ID: [`tx-${index}`], gene: ['dense-gene'] },
    raw: '',
    exons: [{ start: 100, end: 900 }],
    cds: [{ start: 150, end: 850 }],
    transcriptId: `tx-${index}`,
    geneId: 'dense-gene',
  };
}

function readyTile(features: ResolvedTranscript[]): GenomeTrackTile {
  return {
    sessionId: 'session-chr7',
    requestId: 'request-1',
    trackId: 'chr7:annotations',
    chrom: 'chr7',
    start: 0,
    end: 1_000,
    generation: 1,
    state: 'ready',
    fidelity: 'best_available',
    validationState: 'valid',
    byteCount: 1_024,
    recordCount: features.length,
    featureModel: 'resolved-transcript-v2',
    features,
  };
}

function load(
  mode: 'canonical' | 'expanded',
  options: {
    tile?: Partial<GenomeTrackTile>;
    requireCompleteSource?: boolean;
  } = {}
) {
  const features = Array.from({ length: 13 }, (_, index) => transcript(index));
  return loadAssemblyAnnotationTileFeatures({
    sessionId: 'session-chr7',
    requestId: 'request-1',
    chrom: 'chr7',
    start: 0,
    end: 1_000,
    lod: 1,
    generation: 1,
    fidelity: 'best_available',
    byteBudget: 1_000_000,
    sourceFingerprint: 'fixture-fingerprint',
    visibleTypes: new Set(['mRNA']),
    laneLimit: 12,
    length: 10_000,
    globalStart: 0,
    glyphV2Enabled: false,
    transcriptDisplayMode: mode,
    expandedGeneIds: new Set(),
    laneStacking: { groupByType: true, typeOrder: ['mRNA'] },
    maxAttempts: 1,
    pollMs: 0,
    requireCompleteSource: options.requireCompleteSource,
    isCurrent: () => true,
    getAnnotationTile: vi.fn().mockResolvedValue({ ...readyTile(features), ...options.tile }),
  });
}

describe('loadAssemblyAnnotationTileFeatures annotation pressure policy', () => {
  it('keeps one primary isoform in canonical mode', async () => {
    const result = await load('canonical');

    expect(result).not.toBeNull();
    expect(result?.resolvedExpandedFeatures).toHaveLength(13);
    expect(result?.collapsedFeatureCount).toBe(1);
    expect(result?.localFeatureCount).toBe(1);
    expect(result?.droppedCount).toBe(0);
  });

  it('processes all isoforms and caps the rendered lane stack at 12', async () => {
    const result = await load('expanded');

    expect(result).not.toBeNull();
    expect(result?.resolvedFeatureCount).toBe(13);
    expect(result?.collapsedFeatureCount).toBe(13);
    expect(result?.typeFilteredCount).toBe(13);
    expect(result?.localFeatureCount).toBe(12);
    expect(result?.droppedCount).toBe(1);
    expect(result?.featureStats).toEqual({
      featureCount: 12,
      transcriptCount: 12,
      codingTranscriptCount: 12,
      multiExonTranscriptCount: 0,
      exonCount: 12,
      cdsCount: 12,
    });
    expect(new Set(result?.features.map((feature) => feature.lane))).toEqual(
      new Set(Array.from({ length: 12 }, (_, lane) => lane))
    );
  });

  it('fails closed instead of publishing a transport error as an exact empty source page', async () => {
    await expect(
      load('expanded', {
        tile: { state: 'error', features: undefined, recordCount: 13 },
        requireCompleteSource: true,
      })
    ).resolves.toBeNull();
  });

  it('rejects density-degraded source data for exact pages while summary callers may retain it', async () => {
    const degraded = {
      degradedReason: 'density' as const,
      sourceRecordCount: 13,
      recordCount: 12,
    };
    await expect(
      load('expanded', { tile: degraded, requireCompleteSource: true })
    ).resolves.toBeNull();
    await expect(
      load('expanded', { tile: degraded, requireCompleteSource: false })
    ).resolves.not.toBeNull();
  });

  it('accepts a complete resolved representation while rejecting a byte-capped one', async () => {
    const compacted = {
      degradedReason: 'density' as const,
      sourceRecordCount: 130,
      recordCount: 13,
      sourceRepresentationComplete: true,
    };
    await expect(
      load('expanded', { tile: compacted, requireCompleteSource: true })
    ).resolves.not.toBeNull();
    await expect(
      load('expanded', {
        tile: { ...compacted, sourceRepresentationComplete: false },
        requireCompleteSource: true,
      })
    ).resolves.toBeNull();
  });
});
