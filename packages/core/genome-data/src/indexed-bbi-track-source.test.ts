import { describe, expect, it } from 'vitest';

import type { AdmittedTrackSource } from './admitted-track-source';
import {
  createIndexedBbiTrackId,
  indexedBbiTrackLabel,
  isIndexedBbiTrackSource,
  type IndexedBbiTrackSource,
} from './indexed-bbi-track-source';

describe('indexed BBI track identity', () => {
  it('keeps stable ids compact without exposing a full path or URL', () => {
    const local = createIndexedBbiTrackId({
      assemblyId: 'GRCh38',
      source: { kind: 'path', path: '/private/work/rna/sample.bigWig' },
    });
    const linked = createIndexedBbiTrackId({
      assemblyId: 'GRCh38',
      source: { kind: 'url', url: 'https://results.example.org/run/sample.bigWig?signature=x' },
    });

    expect(local).toMatch(/^data:sample\.bigWig-/);
    expect(local).not.toContain('/private/work');
    expect(linked).toMatch(/^data:sample\.bigWig-/);
    expect(linked).not.toContain('results.example.org');
    expect(local).not.toBe(linked);
  });

  it('derives a useful label from either source kind', () => {
    expect(
      indexedBbiTrackLabel({ kind: 'url', url: 'https://example.org/run/RNA%20signal.bw?v=1' })
    ).toBe('RNA signal.bw');
    expect(indexedBbiTrackLabel({ kind: 'path', path: 'C:\\analysis\\coverage.bigWig' })).toBe(
      'coverage.bigWig'
    );
  });

  it('rejects malformed or provenance-confused durable local and URL inputs', () => {
    const source = {
      admissionVersion: 1,
      uri: 'file:///analysis/coverage.bw',
      input: { kind: 'path', path: '/analysis/coverage.bw' },
      formatId: 'bigwig',
      recommendedTypes: ['quantitative'],
      fingerprint: 'generation',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: 'grch38',
        sourceSignature: 'source',
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-08-17T00:00:00.000Z',
      },
      provenance: {
        provider: 'local-file',
        sourceKind: 'local-file',
        label: 'coverage.bw',
      },
    } as const satisfies IndexedBbiTrackSource;

    expect(isIndexedBbiTrackSource(source)).toBe(true);
    expect(
      isIndexedBbiTrackSource({
        ...source,
        input: { kind: 'path', path: '' },
      } as AdmittedTrackSource)
    ).toBe(false);
    expect(
      isIndexedBbiTrackSource({
        ...source,
        input: { kind: 'url', url: 'https://example.org/coverage.bw' },
      } as AdmittedTrackSource)
    ).toBe(false);
  });
});
