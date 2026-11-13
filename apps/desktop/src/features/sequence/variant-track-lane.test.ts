import { describe, expect, it } from 'vitest';

import type { IndexedGenomeVariantSourceState } from '../../shared/indexed-genome';
import { laneFromVariantSource, variantTrackId } from './variant-track-lane';

describe('variant lane projection', () => {
  it('derives one stable first-class lane from the durable source identity', () => {
    const source = variantSource();
    const lane = laneFromVariantSource(source, 'grch38', 4);

    expect(variantTrackId(source)).toBe(`variant:${'a'.repeat(64)}`);
    expect(lane).toMatchObject({
      assemblyId: 'grch38',
      order: 4,
      visible: true,
      dataset: {
        trackId: `variant:${'a'.repeat(64)}`,
        trackType: 'variant',
        kind: 'variant',
        label: 'Tumor calls',
        records: [],
      },
      source: source.admittedSource,
    });
  });
});

function variantSource(): IndexedGenomeVariantSourceState {
  return {
    sourcePath: '/data/tumor.vcf.gz',
    queryPath: '/cache/tumor.vcf.gz',
    indexPath: '/cache/tumor.vcf.gz.tbi',
    format: 'vcf',
    label: 'Tumor calls',
    sourceSizeBytes: 1_000,
    sourceIdentity: 'a'.repeat(64),
    assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
    matchedReferences: ['chr1'],
    samples: [],
    attachedAt: 1,
    admittedSource: {
      admissionVersion: 2,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: 'grch38',
        source: { kind: 'local-file', path: '/data/tumor.vcf.gz' },
        formatId: 'vcf',
        scientificKind: 'variants',
        ingress: { kind: 'file-picker' },
      },
      admittedAt: '2026-09-21T20:00:00.000Z',
      uri: 'file:///data/tumor.vcf.gz',
      input: { kind: 'path', path: '/data/tumor.vcf.gz' },
      formatId: 'vcf',
      recommendedTypes: ['variant'],
      fingerprint: `sha256:${'c'.repeat(64)}`,
      readerKind: 'variant',
      scientificKind: 'variants',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        referenceSignature: `sha256:${'d'.repeat(64)}`,
        sourceSignature: `sha256:${'e'.repeat(64)}`,
        contigMap: { chr1: 'chr1' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-21T20:00:00.000Z',
      },
      provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'Tumor calls' },
      expectedValidators: { contentLength: 1_000 },
    },
  };
}
