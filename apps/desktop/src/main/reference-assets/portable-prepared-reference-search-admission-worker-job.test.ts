import { describe, expect, it, vi } from 'vitest';

import {
  packPrepackedAnnotationSearchIndexV1,
  packPrepackedProteinSearchIndexV1,
} from '@waypoint/genome-data';

import {
  portablePreparedReferenceSearchAdmissionWorkerContractV1,
  runPortablePreparedReferenceSearchAdmissionWorkerJobV1,
} from './portable-prepared-reference-search-admission-worker-job';

const DATASET = {
  datasetId: 'waypoint:assembly-annotation:grch38',
  datasetVersion: 'test-v1',
  sourceSha256: 'a'.repeat(64),
};
const ASSEMBLY = {
  assemblyId: 'grch38',
  assemblyLengthBp: 10_000,
  placementSignature: 'chr1:10000',
  sourceFingerprint: 'b'.repeat(24),
};
const CANONICAL_IDENTITY = JSON.stringify([
  'annotation.v2',
  'grch38',
  'refseq',
  'rna-alpha-1',
  'mRNA',
  'mRNA',
  100,
  213,
  'forward',
]);

describe('portable prepared-reference search admission worker job', () => {
  it('exhaustively admits annotation search bytes without returning the payload to main', async () => {
    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: DATASET,
      assemblyContract: ASSEMBLY,
      trackType: 'mRNA',
      features: [
        {
          sourceOrdinal: 0,
          start: 100,
          end: 213,
          type: 'mRNA',
          annotationTrackId: 'mRNA',
          canonicalIdentity: CANONICAL_IDENTITY,
          direction: 'forward',
          displayName: 'alpha isoform',
          qualifiers: {},
          attributes: {},
        },
      ],
    });
    const payloadPath = '/authorized/annotation-search.bin';
    const result = await runPortablePreparedReferenceSearchAdmissionWorkerJobV1(
      {
        contract: portablePreparedReferenceSearchAdmissionWorkerContractV1(),
        kind: 'annotation',
        payloadPath,
        authorizedPayloadRealPath: payloadPath,
        manifest: packed.manifest,
        admittedAnnotationTrackIds: ['mRNA'],
      },
      {
        resolveRealPath: vi.fn(async () => payloadPath) as never,
        readPayload: vi.fn(async () => packed.payload),
      }
    );

    expect(result).toEqual({
      contract: 'portable-prepared-reference-search-admission-worker.v1',
      kind: 'annotation',
      byteCount: packed.payload.byteLength,
      featureCount: 1,
    });
    expect(result).not.toHaveProperty('payload');
  });

  it('exhaustively admits protein search bytes under the same visual roster', async () => {
    const packed = await packPrepackedProteinSearchIndexV1({
      datasetContract: DATASET,
      assemblyContract: ASSEMBLY,
      features: [
        {
          proteinSequence: 'MKWVTAA',
          segments: [
            { start: 100, end: 108 },
            { start: 200, end: 213 },
          ],
          strand: 'forward',
          geneticCode: 1,
          leadingFrameOffset: 0,
          label: 'alpha isoform',
          geneId: 'gene-alpha',
          transcriptId: 'rna-alpha-1',
          featureType: 'mRNA',
          annotationTrackId: 'mRNA',
          canonicalIdentity: CANONICAL_IDENTITY,
        },
      ],
    });
    const payloadPath = '/authorized/protein-search.bin';
    await expect(
      runPortablePreparedReferenceSearchAdmissionWorkerJobV1(
        {
          contract: portablePreparedReferenceSearchAdmissionWorkerContractV1(),
          kind: 'protein',
          payloadPath,
          authorizedPayloadRealPath: payloadPath,
          manifest: packed.manifest,
          admittedAnnotationTrackIds: ['mRNA'],
        },
        {
          resolveRealPath: vi.fn(async () => payloadPath) as never,
          readPayload: vi.fn(async () => packed.payload),
        }
      )
    ).resolves.toMatchObject({ kind: 'protein', featureCount: 1 });
  });

  it('rechecks the main-authorized real path before reading any payload bytes', async () => {
    const readPayload = vi.fn();
    const manifest = {
      byteLength: 1,
      featureCount: 0,
      integrity: { payloadSha256: 'a'.repeat(64) },
    } as never;
    await expect(
      runPortablePreparedReferenceSearchAdmissionWorkerJobV1(
        {
          contract: portablePreparedReferenceSearchAdmissionWorkerContractV1(),
          kind: 'annotation',
          payloadPath: '/authorized/search.bin',
          authorizedPayloadRealPath: '/authorized/search.bin',
          manifest,
          admittedAnnotationTrackIds: ['mRNA'],
        },
        {
          resolveRealPath: vi.fn(async () => '/replaced/search.bin') as never,
          readPayload,
        }
      )
    ).rejects.toThrow('changed payload path');
    expect(readPayload).not.toHaveBeenCalled();
  });
});
