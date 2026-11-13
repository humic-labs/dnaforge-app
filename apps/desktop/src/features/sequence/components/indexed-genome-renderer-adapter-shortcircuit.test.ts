// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import type { GenomeFeature, ResolvedAnnotation } from '@waypoint/genome-data';

import { resolveAnnotationFeaturesForViewer } from './indexed-genome-legacy-adapter';
import * as splicedResolver from './spliced-feature-resolver';

function feature(overrides: Partial<GenomeFeature> = {}): GenomeFeature {
  return {
    chrom: 'chr11',
    source: 'test',
    type: 'mRNA',
    start: 0,
    end: 100,
    score: null,
    strand: '+',
    phase: null,
    attributes: {},
    raw: '',
    ...overrides,
  };
}

function resolvedAnnotation(overrides: Partial<ResolvedAnnotation> = {}): ResolvedAnnotation {
  return {
    ...feature({ type: 'mRNA', attributes: { ID: ['tx-1'] } }),
    ...overrides,
  } as ResolvedAnnotation;
}

describe('resolveAnnotationFeaturesForViewer — Slice 3e short-circuit', () => {
  it('does NOT call resolveTranscripts when featureModel is resolved-transcript-v2', () => {
    const spy = vi.spyOn(splicedResolver, 'resolveTranscripts');
    const input = [resolvedAnnotation({ attributes: { ID: ['tx-1'] } })];
    resolveAnnotationFeaturesForViewer(input, 'resolved-transcript-v2', true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('DOES call resolveTranscripts when featureModel is raw-gff3 and glyphV2 is enabled', () => {
    const spy = vi.spyOn(splicedResolver, 'resolveTranscripts');
    resolveAnnotationFeaturesForViewer([feature()], 'raw-gff3', true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('does NOT call resolveTranscripts when featureModel is raw-gff3 and glyphV2 is disabled', () => {
    const spy = vi.spyOn(splicedResolver, 'resolveTranscripts');
    resolveAnnotationFeaturesForViewer([feature()], 'raw-gff3', false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
