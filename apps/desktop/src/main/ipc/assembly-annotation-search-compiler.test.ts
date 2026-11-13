import {
  unpackPrepackedAnnotationSearchIndexV1,
  type ResolvedAnnotation,
  type ResolvedTranscript,
} from '@waypoint/genome-data';
import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
} from '@waypoint/genome-renderer/pure';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { rendererFeatureCandidateFromAnnotationGlyph } from '../../shared/indexed-genome-annotation-feature-mapper';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import {
  rendererAnnotationIdentityProjection,
  transcriptCarrierFeatureForRendererIdentity,
} from '../../features/sequence/components/indexed-genome-legacy-adapter';
import {
  compileAndCommitAssemblyAnnotationSearchWorkerJob,
  indexedAnnotationSearchManifest,
  indexedQuartetPaths,
} from './assembly-annotation-search-compiler';
import type { AssemblyAnnotationSearchPayloadIdentityV2 } from './assembly-annotation-search-cache';

type SearchCacheWrite = NonNullable<
  Parameters<typeof compileAndCommitAssemblyAnnotationSearchWorkerJob>[1]['writeSearchCache']
>;
type SearchCacheWriteInput = Parameters<SearchCacheWrite>[0];

const SEARCH_PAYLOAD_IDENTITY: AssemblyAnnotationSearchPayloadIdentityV2 = {
  size: '1',
  mtimeNs: '1',
  ctimeNs: '1',
  ino: '1',
  dev: '1',
};

function request(): AssemblyAnnotationSceneReadRequest {
  const manifest = (chrom: string, length: number, root: string) => ({
    chrom,
    length,
    fastaPath: `${root}.fa`,
    faiPath: `${root}.fa.fai`,
    gffPath: `${root}.gff3`,
    tbiPath: `${root}.gff3.tbi`,
  });
  return {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'GRCh38-search-compiler-test',
    chromosomes: [
      {
        chrom: 'chr1',
        length: 1_000,
        sourcePath: '/safe/chr1.gff3',
        manifest: manifest('chr1', 1_000, '/safe/chr1'),
      },
      {
        chrom: 'chr11',
        length: 2_000,
        sourcePath: '/safe/chr11.gff3',
        manifest: manifest('chr11', 2_000, '/safe/chr11'),
      },
    ],
    scope: {
      kind: 'complete-assembly',
      placements: [
        { chrom: 'chr1', length: 1_000, annotationCoverage: 'sourced' },
        { chrom: 'chr11', length: 2_000, annotationCoverage: 'sourced' },
      ],
    },
    workspaceRoot: '/safe/workspace',
    datasetContract: {
      datasetId: 'refseq-grch38',
      datasetVersion: 'test-v1',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {
      artifactKey: 'visual-artifact-is-not-search-identity',
      themeMode: 'light',
      trackType: 'mRNA',
      partitionSpanBp: 1_048_576,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
      mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    },
    requestedPolicy: { isoformMode: 'expanded', laneLimit: 2 },
  };
}

describe('assembly annotation search compiler', () => {
  it('uses only the explicit manifest quartet even when conventional guessed siblings differ', () => {
    const explicit = {
      chrom: 'chr11',
      length: 135_086_622,
      fastaPath: '/manifest/reference.fa',
      faiPath: '/manifest/reference.fa.fai',
      gffPath: '/manifest/annotations.custom.gff3.gz',
      tbiPath: '/manifest/annotations.custom.gff3.gz.explicit.tbi',
    };
    expect(
      indexedAnnotationSearchManifest({
        chrom: 'chr11',
        length: 135_086_622,
        sourcePath: explicit.gffPath,
        manifest: explicit,
      })
    ).toEqual(explicit);
  });

  it('compiles searchable records through the real already-indexed quartet path', async () => {
    const sourcePath = join(
      process.cwd(),
      '..',
      '..',
      'test-fixtures',
      'indexed',
      'pUC19',
      'pUC19.gff3.gz'
    );
    const realRequest: AssemblyAnnotationSceneReadRequest = {
      ...request(),
      assemblyId: 'pUC19-search-real-quartet',
      chromosomes: [
        {
          chrom: 'puc19',
          length: 2_686,
          sourcePath,
          manifest: {
            chrom: 'puc19',
            length: 2_686,
            fastaPath: sourcePath.replace(/\.gff3\.gz$/, '.fa'),
            faiPath: sourcePath.replace(/\.gff3\.gz$/, '.fa.fai'),
            gffPath: sourcePath,
            tbiPath: `${sourcePath}.tbi`,
          },
        },
      ],
      scope: {
        kind: 'complete-assembly',
        placements: [{ chrom: 'puc19', length: 2_686, annotationCoverage: 'sourced' }],
      },
      workspaceRoot: join(process.cwd(), '..', '..'),
    };
    const directManifest = indexedAnnotationSearchManifest(realRequest.chromosomes[0]);
    if (!directManifest) throw new Error('real indexed quartet fixture was not recognized');
    const authorizedSourcePaths = [
      ...new Set([sourcePath, ...indexedQuartetPaths(directManifest)]),
    ];
    let committed: SearchCacheWriteInput | undefined;
    const result = await compileAndCommitAssemblyAnnotationSearchWorkerJob(
      {
        request: realRequest,
        expectedSourceFingerprint: 'c'.repeat(24),
        authorizedSourceRealPaths: authorizedSourcePaths.map((inputPath) => ({
          inputPath,
          realPath: inputPath,
        })),
      },
      {
        assertSafePath: async () => {},
        writeSearchCache: async (input) => {
          committed = input;
          return {
            fingerprint: input.expectedSourceFingerprint,
            byteCount:
              input.payload instanceof ArrayBuffer
                ? input.payload.byteLength
                : input.payload.byteLength,
            manifestPath: '/cache/puc19-search.json',
            payloadPath: '/cache/puc19-search.bin',
            payloadIdentity: SEARCH_PAYLOAD_IDENTITY,
          };
        },
      }
    );

    expect(result.status).toBe('committed');
    if (!committed) throw new Error('real indexed quartet search compiler did not publish');
    const payload =
      committed.payload instanceof ArrayBuffer
        ? new Uint8Array(committed.payload)
        : committed.payload;
    const index = await unpackPrepackedAnnotationSearchIndexV1(committed.manifest, payload);
    expect(index.query('lacZ')).toEqual([
      expect.objectContaining({
        label: 'lacZ-alpha',
        start: 145,
        end: 469,
        featureType: 'CDS',
        direction: 'reverse',
      }),
    ]);
  });

  it('indexes raw full-value attributes and folded transcripts at global coordinates', async () => {
    let committed: SearchCacheWriteInput | undefined;
    const writeSearchCache = vi.fn<SearchCacheWrite>(async (input) => {
      committed = input;
      return {
        fingerprint: input.expectedSourceFingerprint,
        byteCount:
          input.payload instanceof ArrayBuffer
            ? input.payload.byteLength
            : input.payload.byteLength,
        manifestPath: '/cache/search.json',
        payloadPath: '/cache/search.bin',
        payloadIdentity: SEARCH_PAYLOAD_IDENTITY,
      };
    });

    const result = await compileAndCommitAssemblyAnnotationSearchWorkerJob(
      {
        request: request(),
        expectedSourceFingerprint: 'b'.repeat(24),
        authorizedSourceRealPaths: [],
      },
      {
        assertSafePath: async () => {},
        readIndexedSourceAnnotations: async (chromosome): Promise<ResolvedAnnotation[]> =>
          chromosome.chrom === 'chr1'
            ? [
                {
                  chrom: 'chr1',
                  source: 'RefSeq',
                  type: 'gene',
                  start: 20,
                  end: 80,
                  score: null,
                  strand: '+',
                  phase: null,
                  attributes: {
                    Name: ['ALPHA'],
                    Alias: ['first', 'second', 'third', 'fourth', 'FIFTH_ALIAS'],
                  },
                  raw: 'gene-alpha',
                },
                {
                  chrom: 'chr1',
                  source: 'RefSeq',
                  type: 'protein_coding_transcript',
                  start: 200,
                  end: 400,
                  score: null,
                  strand: '+',
                  phase: null,
                  attributes: {
                    ID: ['rna-PRODUCT_ONLY'],
                    transcript_name: ['PRODUCT_ONLY_TRANSCRIPT'],
                    product: ['product-only annotation'],
                  },
                  raw: 'rna-product-only',
                },
                {
                  chrom: 'chr1',
                  source: 'RefSeq',
                  type: 'misc_feature',
                  start: 500,
                  end: 550,
                  score: null,
                  strand: '.',
                  phase: null,
                  attributes: {
                    ID: ['misc-regulatory-1'],
                    standard_name: ['MPRA-validated silencer'],
                  },
                  raw: 'misc-regulatory-1',
                },
              ]
            : [
                {
                  chrom: 'chr11',
                  source: 'RefSeq',
                  type: 'gene',
                  start: 100,
                  end: 300,
                  score: null,
                  strand: '-',
                  phase: null,
                  attributes: { ID: ['gene-HBB'], gene_name: ['HBB'] },
                  raw: 'gene-hbb',
                  geneId: 'gene-HBB',
                  transcripts: [
                    {
                      chrom: 'chr11',
                      source: 'RefSeq',
                      type: 'mRNA',
                      start: 120,
                      end: 280,
                      score: null,
                      strand: '-',
                      phase: null,
                      attributes: {
                        ID: ['rna-NM_000518.5'],
                        transcript_id: ['NM_000518.5'],
                      },
                      raw: 'rna-hbb',
                      transcriptId: 'rna-NM_000518.5',
                      geneId: 'gene-HBB',
                      exons: [],
                      cds: [],
                    },
                  ],
                },
              ],
        writeSearchCache,
      }
    );

    expect(result).toMatchObject({ status: 'committed', featureCount: 5 });
    expect(writeSearchCache).toHaveBeenCalledOnce();
    if (!committed) throw new Error('search compiler did not publish');
    const payload =
      committed.payload instanceof ArrayBuffer
        ? new Uint8Array(committed.payload)
        : committed.payload;
    const index = await unpackPrepackedAnnotationSearchIndexV1(committed.manifest, payload);
    expect(index.query('fifth_alias')).toEqual([
      expect.objectContaining({ label: 'ALPHA', direction: 'forward', start: 20, end: 80 }),
    ]);
    expect(index.query('HBB')).toEqual([
      expect.objectContaining({
        label: 'HBB',
        direction: 'reverse',
        start: 1_100,
        end: 1_300,
      }),
    ]);
    expect(index.query('NM_000518.5')).toEqual([
      expect.objectContaining({ label: 'NM_000518.5', start: 1_120, end: 1_280 }),
    ]);
    expect(index.query('product-only annotation')).toEqual([
      expect.objectContaining({ label: 'PRODUCT_ONLY_TRANSCRIPT', start: 200, end: 400 }),
    ]);
    expect(index.query('MPRA-validated silencer')).toEqual([
      expect.objectContaining({
        label: 'MPRA-validated silencer',
        direction: 'none',
        start: 500,
        end: 550,
      }),
    ]);
  });

  it('persists the renderer-exact identity when raw ncRNA belongs to the lncRNA track', async () => {
    const transcript: ResolvedTranscript = {
      chrom: 'chr11',
      source: 'RefSeq',
      type: 'ncRNA',
      start: 195,
      end: 300,
      score: null,
      strand: '-',
      phase: null,
      attributes: {
        ID: ['rna-NR_131224.2'],
        transcript_id: ['NR_131224.2'],
        Name: ['NR_131224.2'],
        ncRNA_class: ['lncRNA'],
      },
      raw: 'rna-NR_131224.2',
      transcriptId: 'rna-NR_131224.2',
      geneId: 'gene-H19',
      exons: [{ start: 196, end: 301 }],
      cds: [],
    };
    let committed: SearchCacheWriteInput | undefined;

    await compileAndCommitAssemblyAnnotationSearchWorkerJob(
      {
        request: request(),
        expectedSourceFingerprint: 'd'.repeat(24),
        authorizedSourceRealPaths: [],
      },
      {
        assertSafePath: async () => {},
        readIndexedSourceAnnotations: async (chromosome) =>
          chromosome.chrom === 'chr11' ? [transcript] : [],
        writeSearchCache: async (input) => {
          committed = input;
          return {
            fingerprint: input.expectedSourceFingerprint,
            byteCount: input.payload.byteLength,
            manifestPath: '/cache/lncrna-search.json',
            payloadPath: '/cache/lncrna-search.bin',
            payloadIdentity: SEARCH_PAYLOAD_IDENTITY,
          };
        },
      }
    );

    if (!committed) throw new Error('lncRNA identity fixture was not published');
    const payload =
      committed.payload instanceof ArrayBuffer
        ? new Uint8Array(committed.payload)
        : committed.payload;
    const index = await unpackPrepackedAnnotationSearchIndexV1(committed.manifest, payload);
    const [hit] = index.query('NR_131224.2');
    const projection = rendererAnnotationIdentityProjection(
      transcriptCarrierFeatureForRendererIdentity(transcript)
    );
    const globalStartBp = 1_000 + projection.start;
    const globalEndBp = 1_000 + projection.end;
    const genomeIdentity = `assembly-annotation-source-sha256.v1:${request().datasetContract.sourceSha256}`;
    const rendererFeature = rendererFeatureCandidateFromAnnotationGlyph({
      genomeIdentity,
      genomeName: request().assemblyId,
      glyph: {
        id: projection.sourceId,
        type: transcript.type,
        trackId: projection.annotationTrackId,
        label: 'NR_131224.2',
        startBp: globalStartBp,
        endBp: globalEndBp,
        strand: transcript.strand,
        lane: 0,
        color: 0,
        exons: transcript.exons,
        cds: transcript.cds,
        transcriptId: transcript.transcriptId,
      },
    });

    expect(hit).toEqual(
      expect.objectContaining({
        label: 'NR_131224.2',
        featureType: 'ncRNA',
        annotationTrackId: 'lncRNA',
        direction: 'reverse',
        start: 1_195,
        end: 1_301,
        canonicalIdentity: rendererFeature.canonicalIdentity,
      })
    );
  });

  it('does not publish a partial authority when any sourced chromosome cache is missing', async () => {
    const writeSearchCache = vi.fn();
    const result = await compileAndCommitAssemblyAnnotationSearchWorkerJob(
      {
        request: request(),
        expectedSourceFingerprint: 'b'.repeat(24),
        authorizedSourceRealPaths: [],
      },
      {
        assertSafePath: async () => {},
        readIndexedSourceAnnotations: async (chromosome) =>
          chromosome.chrom === 'chr1' ? [] : null,
        writeSearchCache,
      }
    );

    expect(result).toEqual({ status: 'features-cache-miss', featureCount: 0, byteCount: 0 });
    expect(writeSearchCache).not.toHaveBeenCalled();
  });
});
