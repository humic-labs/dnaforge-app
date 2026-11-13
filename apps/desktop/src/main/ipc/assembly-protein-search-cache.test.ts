import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packPrepackedProteinSearchIndexV1 } from '@waypoint/genome-data';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import { assemblyAnnotationSearchPlacement } from './assembly-annotation-search-cache';
import {
  readAssemblyProteinSearchCacheIndex,
  readAssemblyProteinSearchCacheResource,
  writeAssemblyProteinSearchCache,
} from './assembly-protein-search-cache';
import {
  ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2,
  type ProteinSearchCompilerWorkV1,
} from './assembly-protein-search-compiler';
import { resolveAssemblyProteinSearchSourceRevisionV1 } from './assembly-protein-search-source';

const roots: string[] = [];
const EMPTY_WORK: ProteinSearchCompilerWorkV1 = {
  transcriptCount: 0,
  sourceTranslationCount: 0,
  derivedTranslationCount: 0,
  skippedEmptyTranslationCount: 0,
  quarantinedIsoformCount: 0,
  quarantinedIsoforms: [],
  quarantineDiagnosticsTruncated: false,
};
const QUARANTINED_WORK: ProteinSearchCompilerWorkV1 = {
  ...EMPTY_WORK,
  transcriptCount: 1,
  quarantinedIsoformCount: 1,
  quarantinedIsoforms: [
    {
      chrom: 'chr1',
      source: 'RefSeq',
      isoformId: 'rna-malformed',
      reason: 'unknown-strand',
    },
  ],
};

async function sourceFixture(): Promise<{
  root: string;
  request: AssemblyAnnotationSceneReadRequest;
  fastaPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'waypoint-protein-cache-'));
  roots.push(root);
  const gffPath = join(root, 'chr1.gff3.gz');
  const fastaPath = join(root, 'chr1.fa');
  await Promise.all([
    writeFile(gffPath, 'gff'),
    writeFile(`${gffPath}.tbi`, 'tbi'),
    writeFile(fastaPath, '>chr1\nACGT\n'),
    writeFile(`${fastaPath}.fai`, 'chr1\t4\t6\t4\t5\n'),
  ]);
  return {
    root,
    fastaPath,
    request: {
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      assemblyId: 'GRCh38',
      workspaceRoot: root,
      chromosomes: [
        {
          chrom: 'chr1',
          length: 1000,
          sourcePath: gffPath,
          manifest: {
            chrom: 'chr1',
            length: 1000,
            fastaPath,
            faiPath: `${fastaPath}.fai`,
            gffPath,
            tbiPath: `${gffPath}.tbi`,
          },
        },
      ],
      scope: {
        kind: 'complete-assembly',
        placements: [{ chrom: 'chr1', length: 1000, annotationCoverage: 'sourced' }],
      },
      datasetContract: {
        datasetId: 'GRCh38',
        datasetVersion: 'v1',
        sourceSha256: '1'.repeat(64),
      },
      artifact: {} as AssemblyAnnotationSceneReadRequest['artifact'],
      requestedPolicy: { isoformMode: 'canonical', laneLimit: null },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('assembly protein search cache', () => {
  it('publishes atomically and admits the exact annotation + FASTA revision', async () => {
    const { request } = await sourceFixture();
    const deps = { assertSafePath: async () => undefined };
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, deps);
    const placement = assemblyAnnotationSearchPlacement(request.chromosomes);
    expect(revision).not.toBeNull();
    expect(placement).not.toBeNull();
    const packed = await packPrepackedProteinSearchIndexV1({
      datasetContract: request.datasetContract,
      assemblyContract: {
        assemblyId: request.assemblyId,
        assemblyLengthBp: placement!.assemblyLengthBp,
        placementSignature: placement!.placementSignature,
        sourceFingerprint: revision!.fingerprint,
      },
      features: [],
    });

    const written = await writeAssemblyProteinSearchCache(
      {
        request,
        expectedSourceFingerprint: revision!.fingerprint,
        manifest: packed.manifest,
        payload: packed.payload,
        work: QUARANTINED_WORK,
      },
      deps
    );

    expect(written).not.toBeNull();
    await expect(readAssemblyProteinSearchCacheIndex(request, deps)).resolves.toMatchObject({
      status: 'hit',
      fingerprint: revision!.fingerprint,
      byteCount: packed.payload.byteLength,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      work: QUARANTINED_WORK,
    });
  });

  it('invalidates the artifact when FASTA changes even though the GFF source is unchanged', async () => {
    const { request, fastaPath } = await sourceFixture();
    const deps = { assertSafePath: async () => undefined };
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, deps);
    const placement = assemblyAnnotationSearchPlacement(request.chromosomes)!;
    const packed = await packPrepackedProteinSearchIndexV1({
      datasetContract: request.datasetContract,
      assemblyContract: {
        assemblyId: request.assemblyId,
        assemblyLengthBp: placement.assemblyLengthBp,
        placementSignature: placement.placementSignature,
        sourceFingerprint: revision!.fingerprint,
      },
      features: [],
    });
    await writeAssemblyProteinSearchCache(
      {
        request,
        expectedSourceFingerprint: revision!.fingerprint,
        manifest: packed.manifest,
        payload: packed.payload,
        work: EMPTY_WORK,
      },
      deps
    );

    await writeFile(fastaPath, '>chr1\nTGCA\n');
    const changedAt = new Date(Date.now() + 10_000);
    await utimes(fastaPath, changedAt, changedAt);

    const result = await readAssemblyProteinSearchCacheIndex(request, deps);
    expect(result).toMatchObject({ status: 'miss' });
    expect(result?.fingerprint).not.toBe(revision!.fingerprint);
  });

  it('fails closed on a same-path payload replacement and exposes a repairable miss', async () => {
    const { request } = await sourceFixture();
    const deps = { assertSafePath: async () => undefined };
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, deps);
    const placement = assemblyAnnotationSearchPlacement(request.chromosomes)!;
    const packed = await packPrepackedProteinSearchIndexV1({
      datasetContract: request.datasetContract,
      assemblyContract: {
        assemblyId: request.assemblyId,
        assemblyLengthBp: placement.assemblyLengthBp,
        placementSignature: placement.placementSignature,
        sourceFingerprint: revision!.fingerprint,
      },
      features: [],
    });
    const written = await writeAssemblyProteinSearchCache(
      {
        request,
        expectedSourceFingerprint: revision!.fingerprint,
        manifest: packed.manifest,
        payload: packed.payload,
        work: EMPTY_WORK,
      },
      deps
    );
    await writeFile(written!.payloadPath, new Uint8Array(packed.payload.byteLength));

    await expect(readAssemblyProteinSearchCacheResource(request, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: revision!.fingerprint,
    });
  });

  it('binds admission to compiler semantics and rejects a legacy manifest without the token', async () => {
    const { request } = await sourceFixture();
    const deps = { assertSafePath: async () => undefined };
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, deps);
    const placement = assemblyAnnotationSearchPlacement(request.chromosomes)!;
    const packed = await packPrepackedProteinSearchIndexV1({
      datasetContract: request.datasetContract,
      assemblyContract: {
        assemblyId: request.assemblyId,
        assemblyLengthBp: placement.assemblyLengthBp,
        placementSignature: placement.placementSignature,
        sourceFingerprint: revision!.fingerprint,
      },
      features: [],
    });
    const written = await writeAssemblyProteinSearchCache(
      {
        request,
        expectedSourceFingerprint: revision!.fingerprint,
        manifest: packed.manifest,
        payload: packed.payload,
        work: EMPTY_WORK,
      },
      deps
    );
    expect(written).not.toBeNull();
    const disk = JSON.parse((await readFile(written!.manifestPath)).toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(disk.compilerSemantics).toBe(ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2);

    delete disk.compilerSemantics;
    await writeFile(written!.manifestPath, JSON.stringify(disk));
    await expect(readAssemblyProteinSearchCacheIndex(request, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: revision!.fingerprint,
    });
  });
});
