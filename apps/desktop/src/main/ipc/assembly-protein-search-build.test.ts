import type {
  GenomeFeature,
  IndexedGenomeManifest,
  ResolvedTranscript,
} from '@waypoint/genome-data';
import { describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import {
  compileAndCommitAssemblyProteinSearchWorkerJob,
  type AssemblyProteinSearchWorkerJob,
} from './assembly-protein-search-build';

type ProteinSearchCacheWrite = NonNullable<
  Parameters<typeof compileAndCommitAssemblyProteinSearchWorkerJob>[1]['writeSearchCache']
>;

function raw(
  overrides: Partial<GenomeFeature> & Pick<GenomeFeature, 'start' | 'end'>
): GenomeFeature {
  return {
    chrom: 'chr1',
    source: 'RefSeq',
    type: 'CDS',
    score: null,
    strand: '+',
    phase: '0',
    attributes: {},
    raw: '',
    ...overrides,
  };
}

function transcript(
  transcriptId: string,
  overrides: Partial<ResolvedTranscript> = {}
): ResolvedTranscript {
  return {
    ...raw({ start: 0, end: 9 }),
    type: 'mRNA',
    attributes: { ID: [transcriptId], Parent: ['gene-alpha'] },
    exons: [{ start: 1, end: 9 }],
    cds: [{ start: 1, end: 9 }],
    transcriptId,
    geneId: 'gene-alpha',
    ...overrides,
  };
}

function job(): AssemblyProteinSearchWorkerJob {
  const manifest: IndexedGenomeManifest = {
    chrom: 'chr1',
    length: 30,
    fastaPath: '/safe/chr1.fa',
    faiPath: '/safe/chr1.fa.fai',
    gffPath: '/safe/chr1.gff3.gz',
    tbiPath: '/safe/chr1.gff3.gz.tbi',
  };
  const request: AssemblyAnnotationSceneReadRequest = {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'assembly-protein-build-test',
    workspaceRoot: '/safe',
    chromosomes: [{ chrom: 'chr1', length: 30, sourcePath: manifest.gffPath, manifest }],
    scope: {
      kind: 'complete-assembly',
      placements: [{ chrom: 'chr1', length: 30, annotationCoverage: 'sourced' }],
    },
    datasetContract: {
      datasetId: 'protein-build-test',
      datasetVersion: 'v1',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {} as AssemblyAnnotationSceneReadRequest['artifact'],
    requestedPolicy: { isoformMode: 'canonical', laneLimit: null },
  };
  const paths = [manifest.fastaPath, manifest.faiPath, manifest.gffPath!, manifest.tbiPath!];
  return {
    request,
    expectedSourceFingerprint: 'b'.repeat(24),
    resolvedChromosomes: [{ chrom: 'chr1', manifest }],
    authorizedSourceRealPaths: paths.map((inputPath) => ({
      inputPath,
      realPath: `/real${inputPath}`,
    })),
  };
}

describe('assembly protein search build', () => {
  it('commits valid isoforms and persists a bounded quarantine report', async () => {
    const valid = transcript('rna-valid', { translation: 'MKW' });
    const malformed = transcript('rna-malformed', {
      start: 10,
      end: 19,
      strand: '.',
      translation: 'MKW',
      exons: [{ start: 11, end: 19 }],
      cds: [{ start: 11, end: 19 }],
    });
    const close = vi.fn(async () => undefined);
    const writeSearchCache = vi.fn<ProteinSearchCacheWrite>(async () => ({
      fingerprint: 'b'.repeat(24),
      byteCount: 1,
      manifestPath: '/safe/protein.json',
      payloadPath: '/safe/protein.bin',
      payloadIdentity: {
        size: '1',
        mtimeNs: '1',
        ctimeNs: '1',
        ino: '1',
        dev: '1',
      },
    }));

    const result = await compileAndCommitAssemblyProteinSearchWorkerJob(job(), {
      assertSafePath: async () => undefined,
      openChromosomeSource: async () => ({
        rawFeatures: [
          raw({ start: 0, end: 9, attributes: { Parent: ['rna-valid'] } }),
          raw({
            start: 10,
            end: 19,
            strand: '.',
            attributes: { Parent: ['rna-malformed'] },
          }),
        ],
        resolvedAnnotations: [valid, malformed],
        readSequence: async () => {
          throw new Error('source translations must not read FASTA');
        },
        close,
      }),
      writeSearchCache,
    });

    expect(result).toMatchObject({
      status: 'committed',
      featureCount: 1,
      work: {
        transcriptCount: 2,
        sourceTranslationCount: 1,
        derivedTranslationCount: 0,
        quarantinedIsoformCount: 1,
        quarantinedIsoforms: [
          {
            chrom: 'chr1',
            source: 'RefSeq',
            isoformId: 'rna-malformed',
            reason: 'unknown-strand',
          },
        ],
      },
    });
    expect(writeSearchCache).toHaveBeenCalledOnce();
    expect(writeSearchCache.mock.calls[0]?.[0].work).toEqual(result.work);
    expect(close).toHaveBeenCalledOnce();
  });
});
