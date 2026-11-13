import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packPrepackedProteinSearchIndexV1 } from '@waypoint/genome-data';
import { afterEach, describe, expect, it } from 'vitest';

import {
  payloadIdentityFromFileStat,
  type AssemblyAnnotationSearchPayloadIdentityV2,
} from './assembly-annotation-search-cache';
import type { AssemblyProteinSearchCacheIndexHit } from './assembly-protein-search-cache';
import {
  disposeAssemblyProteinSearchQuerySessions,
  queryAssemblyProteinSearchIndexHitOrMiss,
} from './assembly-protein-search-query';

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  hit: AssemblyProteinSearchCacheIndexHit;
}> {
  const root = await mkdtemp(join(tmpdir(), 'waypoint-protein-query-'));
  roots.push(root);
  const packed = await packPrepackedProteinSearchIndexV1({
    datasetContract: {
      datasetId: 'GRCh38',
      datasetVersion: 'v1',
      sourceSha256: '1'.repeat(64),
    },
    assemblyContract: {
      assemblyId: 'GRCh38',
      assemblyLengthBp: 1000,
      placementSignature: 'placement',
      sourceFingerprint: 'a'.repeat(24),
    },
    features: [
      {
        sourceOrdinal: 0,
        proteinSequence: 'MPEPTIDER',
        segments: [{ start: 100, end: 127 }],
        strand: 'forward',
        geneticCode: 1,
        leadingFrameOffset: 0,
        label: 'isoform 1',
        transcriptId: 'TX1',
        featureType: 'mRNA',
        annotationTrackId: 'mRNA',
        canonicalIdentity: 'canonical:tx1',
      },
    ],
  });
  const payloadPath = join(root, 'protein.bin');
  await writeFile(payloadPath, packed.payload);
  const payloadIdentity = payloadIdentityFromFileStat(
    await stat(payloadPath, { bigint: true })
  ) as AssemblyAnnotationSearchPayloadIdentityV2;
  return {
    root,
    hit: {
      status: 'hit',
      fingerprint: 'a'.repeat(24),
      byteCount: packed.payload.byteLength,
      work: {
        transcriptCount: 1,
        sourceTranslationCount: 1,
        derivedTranslationCount: 0,
        skippedEmptyTranslationCount: 0,
        quarantinedIsoformCount: 0,
        quarantinedIsoforms: [],
        quarantineDiagnosticsTruncated: false,
      },
      manifest: packed.manifest,
      payloadPath,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      payloadIdentity,
      sourceContinuity: [],
    },
  };
}

afterEach(async () => {
  await disposeAssemblyProteinSearchQuerySessions();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('assembly protein search disk query', () => {
  it('range-reads the immutable payload and returns only bounded match metadata', async () => {
    const { hit } = await fixture();

    const result = await queryAssemblyProteinSearchIndexHitOrMiss(hit, 'PEPTI', 10);
    expect(result).toMatchObject({
      status: 'hit',
      fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      featureCount: 1,
      truncated: false,
      limit: 10,
      matches: [
        {
          proteinStart: 1,
          proteinEnd: 6,
          start: 103,
          end: 118,
          segments: [{ start: 103, end: 118 }],
          strand: 'forward',
          transcriptId: 'TX1',
          annotationTrackId: 'mRNA',
          canonicalIdentity: 'canonical:tx1',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(hit.payloadPath);
    expect(JSON.stringify(result)).not.toContain(hit.payloadSha256);
  });

  it('fails closed to a repairable miss when the persisted payload is replaced', async () => {
    const { hit } = await fixture();
    await writeFile(hit.payloadPath, new Uint8Array(hit.byteCount));

    await expect(queryAssemblyProteinSearchIndexHitOrMiss(hit, 'PEPTI', 10)).resolves.toEqual({
      status: 'miss',
      fingerprint: hit.fingerprint,
    });
  });

  it('propagates cancellation instead of misreporting a corrupt-cache miss', async () => {
    const { hit } = await fixture();
    const controller = new AbortController();
    controller.abort(new DOMException('superseded', 'AbortError'));

    await expect(
      queryAssemblyProteinSearchIndexHitOrMiss(hit, 'PEPTI', 10, {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
