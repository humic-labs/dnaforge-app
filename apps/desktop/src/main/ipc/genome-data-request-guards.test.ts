import { describe, expect, it } from 'vitest';
import {
  PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1,
  PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1,
} from '@waypoint/genome-data';
import {
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
} from '@waypoint/genome-renderer/pure';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyOverviewChromInput,
  GenomeFeatureDetailsRequest,
  IndexedGenomeManifest,
} from '../../shared/indexed-genome';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
  GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
  assemblyAnnotationSceneArtifactKey,
} from '../../shared/indexed-genome';
import {
  buildGenomeAssembly,
  referenceAssemblyById,
} from '../../features/sequence/reference-catalog';
import { completeManifestFromIndexedGff3Source } from '../../features/sequence/assembly-indexed-manifest';
import {
  assertLegacyGetFeatureDetailsRequestAllowed,
  assertLegacyGetFeaturesRequestAllowed,
  isBoundedAssemblyAnnotationSearchCancelRequest,
  isBoundedAssemblyAnnotationSearchQueryRequest,
  isBoundedAssemblyAnnotationSearchSource,
  isBoundedAssemblyProteinSearchCancelRequest,
  isBoundedAssemblyProteinSearchQueryRequest,
  isBoundedAssemblySequenceSearchRequest,
  isBoundedGenomeSequenceSearchRequest,
} from './genome-data-request-guards';

function manifest(overrides: Partial<IndexedGenomeManifest> = {}): IndexedGenomeManifest {
  return {
    chrom: 'chr11',
    fastaPath: '/Users/test/chr11.fa',
    faiPath: '/Users/test/chr11.fa.fai',
    gffPath: '/Users/test/chr11.gff3.gz',
    tbiPath: '/Users/test/chr11.gff3.gz.tbi',
    length: 135_086_622,
    ...overrides,
  };
}

function assemblySearchSource(
  chromosomes: AssemblyOverviewChromInput[] = [
    {
      chrom: 'chr11',
      sourcePath: '/Users/test/chr11.gff3.gz',
      manifest: manifest(),
      length: 135_086_622,
    },
    { chrom: 'chrM', length: 16_569 },
  ]
): AssemblyAnnotationSceneReadRequest {
  const artifactWithoutKey = {
    themeMode: 'light' as const,
    trackType: 'mRNA',
    partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  };
  return {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'GRCh38',
    workspaceRoot: '/Users/test/workspace',
    chromosomes,
    scope: {
      kind: 'complete-assembly',
      placements: chromosomes.map(({ chrom, length, sourcePath }) => ({
        chrom,
        length,
        annotationCoverage: sourcePath == null ? ('unsourced' as const) : ('sourced' as const),
      })),
    },
    datasetContract: {
      datasetId: 'gencode',
      datasetVersion: 'v44',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {
      ...artifactWithoutKey,
      artifactKey: assemblyAnnotationSceneArtifactKey(artifactWithoutKey),
    },
    requestedPolicy: { isoformMode: 'expanded', laneLimit: 2 },
  };
}

describe('legacy genome:getFeatures request guard', () => {
  it('allows bounded compatibility requests', () => {
    expect(() =>
      assertLegacyGetFeaturesRequestAllowed({
        manifest: manifest(),
        chrom: 'chr11',
        start: 1_000_000,
        end: 1_100_000,
        zoomLevel: 1,
      })
    ).not.toThrow();
  });

  it('rejects multi-megabase feature-array requests on the legacy IPC path', () => {
    expect(() =>
      assertLegacyGetFeaturesRequestAllowed({
        manifest: manifest(),
        chrom: 'chr11',
        start: 1_000_000,
        end: 1_000_001 + GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
        zoomLevel: 1,
      })
    ).toThrow(/Use genome:getAnnotationTile/);
  });

  it('rejects known whole-chromosome feature-array requests even under the span cap', () => {
    expect(() =>
      assertLegacyGetFeaturesRequestAllowed({
        manifest: manifest({ length: 200_000 }),
        chrom: 'chr11',
        start: 0,
        end: 200_000,
        zoomLevel: 0,
      })
    ).toThrow(/Legacy getFeatures is limited/);
  });

  it('rejects chrom mismatches before they can hit the data source', () => {
    expect(() =>
      assertLegacyGetFeaturesRequestAllowed({
        manifest: manifest(),
        chrom: 'chr12',
        start: 0,
        end: 100,
        zoomLevel: 1,
      })
    ).toThrow(/chrom mismatch/);
  });
});

describe('legacy genome:getFeatureDetails request guard', () => {
  function request(
    overrides: Partial<GenomeFeatureDetailsRequest> = {}
  ): GenomeFeatureDetailsRequest {
    return {
      chrom: 'chr11',
      start: 1_000_000,
      end: 1_100_000,
      featureId: 'ENST000001',
      maxWindowBp: GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
      ...overrides,
    };
  }

  it('admits a bounded feature-closure lookup', () => {
    expect(() =>
      assertLegacyGetFeatureDetailsRequestAllowed({ manifest: manifest(), request: request() })
    ).not.toThrow();
  });

  it('admits bounded workspace roots and rejects an empty authority list', () => {
    expect(() =>
      assertLegacyGetFeatureDetailsRequestAllowed({
        manifest: manifest({ workspaceRootPaths: ['/Users/test'] }),
        request: request(),
      })
    ).not.toThrow();
    expect(() =>
      assertLegacyGetFeatureDetailsRequestAllowed({
        manifest: manifest({ workspaceRootPaths: [] }),
        request: request(),
      })
    ).toThrow(/Invalid legacy feature-details manifest/);
  });

  it('rejects a feature-closure lookup beyond the declared chromosome', () => {
    expect(() =>
      assertLegacyGetFeatureDetailsRequestAllowed({
        manifest: manifest({ length: 1_050_000 }),
        request: request(),
      })
    ).toThrow(/limited/);
  });

  it('rejects extra request keys before the data source sees them', () => {
    expect(() =>
      assertLegacyGetFeatureDetailsRequestAllowed({
        manifest: manifest(),
        request: { ...request(), injected: true } as GenomeFeatureDetailsRequest,
      })
    ).toThrow(/Invalid legacy feature-details request/);
  });
});

describe('assembly annotation search query guard', () => {
  const source = assemblySearchSource();
  const identity = { clientId: 'find-client', requestId: 'probe-1' };

  it('admits a bounded text query and result limit', () => {
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({
        source,
        ...identity,
        query: 'HBB',
        limit: 500,
      })
    ).toBe(true);
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({
        source,
        ...identity,
        query: 'MT-',
        limit: 500,
      })
    ).toBe(true);
  });

  it('rejects oversized text before the cache/query path can run', () => {
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({
        source,
        ...identity,
        query: 'x'.repeat(PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1 + 1),
        limit: 500,
      })
    ).toBe(false);
  });

  it('rejects missing sources and invalid result limits', () => {
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({ ...identity, query: 'HBB', limit: 500 })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({
        source,
        ...identity,
        query: 'HBB',
        limit: 501,
      })
    ).toBe(false);
  });

  it('rejects missing or unbounded lifecycle identities', () => {
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({ source, query: 'HBB', limit: 500 })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({
        source,
        ...identity,
        clientId: 'x'.repeat(129),
        query: 'HBB',
        limit: 500,
      })
    ).toBe(false);
  });

  it('rejects unbounded or malformed chromosome source rows before cache iteration', () => {
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({
        source: assemblySearchSource(
          Array.from({ length: 1_025 }, (_, index) => ({
            chrom: `chr${index}`,
            sourcePath: `/tmp/chr${index}.gff3.gz`,
            length: 1,
          }))
        ),
        ...identity,
        query: 'HBB',
        limit: 500,
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({
        source: {
          ...source,
          chromosomes: [{ chrom: 'chr11', sourcePath: '/tmp/chr11.gff3.gz' }],
        },
        ...identity,
        query: 'HBB',
        limit: 500,
      })
    ).toBe(false);

    const chromosomesWithBallast = [...source.chromosomes] as typeof source.chromosomes & {
      ballast?: string;
    };
    chromosomesWithBallast.ballast = 'x';
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({
        source: { ...source, chromosomes: chromosomesWithBallast },
        ...identity,
        query: 'HBB',
        limit: 500,
      })
    ).toBe(false);

    const placementsWithBallast = [...source.scope.placements] as typeof source.scope.placements & {
      ballast?: string;
    };
    placementsWithBallast.ballast = 'x';
    expect(
      isBoundedAssemblyAnnotationSearchQueryRequest({
        source: { ...source, scope: { ...source.scope, placements: placementsWithBallast } },
        ...identity,
        query: 'HBB',
        limit: 500,
      })
    ).toBe(false);
  });

  it('rejects incomplete, subset, and placement-mismatched sources', () => {
    expect(isBoundedAssemblyAnnotationSearchSource({ chromosomes: source.chromosomes })).toBe(
      false
    );
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        scope: { ...source.scope, kind: 'viewport-subset' },
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        scope: {
          ...source.scope,
          placements: source.scope.placements.map((placement, index) =>
            index === 0 ? { ...placement, chrom: 'chr12' } : placement
          ),
        },
      })
    ).toBe(false);
  });

  it('rejects unbounded or structurally extended authority fields before serialization', () => {
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        workspaceRoot: `/${'x'.repeat(32_768)}`,
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({ ...source, workspaceRoot: ' /workspace' })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        datasetContract: { ...source.datasetContract, datasetId: 'x'.repeat(1_025) },
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        datasetContract: { ...source.datasetContract, extra: 'x'.repeat(1_025) },
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        artifact: { ...source.artifact, trackType: 'x'.repeat(1_025) },
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource(
        assemblySearchSource(
          Array.from({ length: 40 }, (_, index) => ({
            chrom: `chr${index}`,
            sourcePath: `/${String(index).padStart(2, '0')}/${'x'.repeat(30_000)}`,
            length: 1,
          }))
        )
      )
    ).toBe(false);
  });

  it('requires an exact scene contract, valid dataset seal, and bounded runtime policy', () => {
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        datasetVersion: source.datasetContract.datasetVersion,
      })
    ).toBe(true);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        datasetVersion: 'different-compiler-contract',
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        ipcContractVersion: 'assembly-annotation-scene-ipc.v3',
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        datasetContract: { ...source.datasetContract, sourceSha256: 'not-a-sha' },
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        requestedPolicy: { isoformMode: 'expanded', laneLimit: 0 },
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        requestedPolicy: {
          isoformMode: 'expanded',
          laneLimit: COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 + 1,
        },
      })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchSource({
        ...source,
        artifact: { ...source.artifact, annotationBarHeightPx: 1 },
      })
    ).toBe(false);
  });

  it('admits only exact bounded cancel identities', () => {
    expect(isBoundedAssemblyAnnotationSearchCancelRequest(identity)).toBe(true);
    expect(
      isBoundedAssemblyAnnotationSearchCancelRequest({ clientId: '', requestId: 'probe' })
    ).toBe(false);
    expect(
      isBoundedAssemblyAnnotationSearchCancelRequest({
        clientId: 'find-client',
        requestId: 'x'.repeat(129),
      })
    ).toBe(false);
  });
});

describe('assembly protein search query guard', () => {
  const source = assemblySearchSource();
  const identity = { clientId: 'find-client', requestId: 'protein-1' };

  it('admits exact amino-acid queries and bounded whitespace normalization', () => {
    expect(
      isBoundedAssemblyProteinSearchQueryRequest({
        source,
        ...identity,
        query: 'MVHLT',
        limit: 500,
      })
    ).toBe(true);
    expect(
      isBoundedAssemblyProteinSearchQueryRequest({
        source,
        ...identity,
        query: 'MVH LT',
        limit: 1,
      })
    ).toBe(true);
  });

  it('rejects short, invalid-alphabet, oversized, and over-limit requests', () => {
    for (const query of [
      'MVHL',
      'MVHLB',
      'M*VHL',
      'A'.repeat(PREPACKED_PROTEIN_SEARCH_MAX_QUERY_RESIDUES_V1 + 1),
    ]) {
      expect(
        isBoundedAssemblyProteinSearchQueryRequest({
          source,
          ...identity,
          query,
          limit: 500,
        })
      ).toBe(false);
    }
    expect(
      isBoundedAssemblyProteinSearchQueryRequest({
        source,
        ...identity,
        query: 'MVHLT',
        limit: 501,
      })
    ).toBe(false);
  });

  it('uses the same exact lifecycle identity contract for cancellation', () => {
    expect(isBoundedAssemblyProteinSearchCancelRequest(identity)).toBe(true);
    expect(
      isBoundedAssemblyProteinSearchCancelRequest({
        clientId: 'find-client',
        requestId: '',
      })
    ).toBe(false);
  });
});

describe('indexed sequence search query guard', () => {
  const control = { clientId: 'find-client', requestId: 'sequence-1' };

  it('admits the exact bounded renderer contract and rejects resource-amplifying variants', () => {
    const indexed = manifest();
    const valid = {
      manifest: indexed,
      chrom: indexed.chrom,
      motif: 'ACGT',
      opts: { maxResults: 500, reverseComplement: true, validateIupacDna: true },
      control,
    };

    expect(isBoundedGenomeSequenceSearchRequest(valid)).toBe(true);
    expect(isBoundedGenomeSequenceSearchRequest({ ...valid, motif: 'A'.repeat(16_385) })).toBe(
      false
    );
    expect(
      isBoundedGenomeSequenceSearchRequest({
        ...valid,
        opts: { ...valid.opts, maxResults: 501 },
      })
    ).toBe(false);
    expect(
      isBoundedGenomeSequenceSearchRequest({
        ...valid,
        opts: { ...valid.opts, validateIupacDna: 'yes' },
      })
    ).toBe(false);
    expect(
      isBoundedGenomeSequenceSearchRequest({
        ...valid,
        control: { ...control, requestId: 'x'.repeat(129) },
      })
    ).toBe(false);
  });
});

describe('assembly sequence search query guard', () => {
  const valid = {
    source: {
      contract: ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
      assemblyId: 'GRCh38',
      chromosomes: [
        {
          chrom: 'chr1',
          length: 248_956_422,
          manifest: manifest({
            chrom: 'chr1',
            fastaPath: '/Users/test/chr1.fa',
            faiPath: '/Users/test/chr1.fa.fai',
            length: 248_956_422,
          }),
        },
        {
          chrom: 'chr11',
          length: 135_086_622,
          manifest: manifest({ length: 135_086_622 }),
        },
      ],
    },
    clientId: 'find-client',
    requestId: 'assembly-sequence-1',
    motif: 'ACGT',
    limit: 500,
    reverseComplement: true,
  };

  it('admits an exact ordered assembly source without caller-provided offsets', () => {
    expect(isBoundedAssemblySequenceSearchRequest(valid)).toBe(true);
  });

  it('admits the exact completed manifests produced for the production GRCh38 assembly', () => {
    const catalogEntry = referenceAssemblyById('grch38');
    expect(catalogEntry).toBeDefined();
    if (!catalogEntry) throw new Error('GRCh38 production catalog entry is unavailable.');
    const assembly = buildGenomeAssembly(
      catalogEntry,
      (relativePath) => `/Users/test/waypoint/${relativePath}`
    );
    const productionRequest = {
      ...valid,
      source: {
        contract: ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
        assemblyId: assembly.assemblyId,
        chromosomes: assembly.chromosomes.map((chromosome) => ({
          chrom: chromosome.chrom,
          length: chromosome.length,
          manifest: completeManifestFromIndexedGff3Source(chromosome.manifest),
        })),
      },
    };

    expect(productionRequest.source.chromosomes).toHaveLength(24);
    expect(isBoundedAssemblySequenceSearchRequest(productionRequest)).toBe(true);
  });

  it('rejects coordinate injection, chromosome/manifest disagreement, and unsafe totals', () => {
    expect(
      isBoundedAssemblySequenceSearchRequest({
        ...valid,
        source: {
          ...valid.source,
          chromosomes: [
            {
              ...valid.source.chromosomes[0],
              globalStartBp: 123,
            },
          ],
        },
      })
    ).toBe(false);
    expect(
      isBoundedAssemblySequenceSearchRequest({
        ...valid,
        source: {
          ...valid.source,
          chromosomes: [
            {
              ...valid.source.chromosomes[0],
              manifest: { ...valid.source.chromosomes[0].manifest, chrom: 'chr2' },
            },
          ],
        },
      })
    ).toBe(false);
    expect(
      isBoundedAssemblySequenceSearchRequest({
        ...valid,
        source: {
          ...valid.source,
          chromosomes: [
            {
              ...valid.source.chromosomes[0],
              length: Number.MAX_SAFE_INTEGER,
              manifest: {
                ...valid.source.chromosomes[0].manifest,
                length: Number.MAX_SAFE_INTEGER,
              },
            },
            {
              ...valid.source.chromosomes[1],
              length: 1,
              manifest: { ...valid.source.chromosomes[1].manifest, length: 1 },
            },
          ],
        },
      })
    ).toBe(false);
  });

  it('rejects unbounded result/query payloads and renderer-local signals', () => {
    expect(isBoundedAssemblySequenceSearchRequest({ ...valid, limit: 501 })).toBe(false);
    expect(isBoundedAssemblySequenceSearchRequest({ ...valid, motif: 'A'.repeat(16_385) })).toBe(
      false
    );
    expect(
      isBoundedAssemblySequenceSearchRequest({
        ...valid,
        signal: new AbortController().signal,
      })
    ).toBe(false);
  });
});
