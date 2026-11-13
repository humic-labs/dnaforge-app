import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN,
  PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN,
  packPrepackedAnnotationSearchIndexV1,
  packPrepackedProteinSearchIndexV1,
} from '@waypoint/genome-data';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT } from '../../shared/indexed-genome';
import {
  ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2,
  ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
} from '../ipc/assembly-annotation-search-cache';
import { ASSEMBLY_ANNOTATION_PRODUCT_SET_MANIFEST_V2 } from '../ipc/assembly-annotation-product-set-manifest';
import {
  ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2,
  type ProteinSearchCompilerWorkV1,
} from '../ipc/assembly-protein-search-compiler';
import { ASSEMBLY_PROTEIN_SEARCH_CACHE_V1 } from '../ipc/assembly-protein-search-cache';
import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';
import {
  buildPortablePreparedReferenceBundleV1,
  portablePreparedReferenceContentObjectKeyV1,
  type PortablePreparedReferenceObjectRoleV1,
  type PortablePreparedReferenceReadinessTierV1,
} from './portable-prepared-reference-bundle';
import type {
  PortablePreparedReferenceHydrationResult,
  PortablePreparedReferenceHydrator,
} from './portable-prepared-reference-hydrator';
import { PortablePreparedReferenceViewAuthorityV1 } from './portable-prepared-reference-view-authority';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('portable prepared-reference durable view admission', () => {
  it('reconstructs the full search capability after restart without rerunning payload workers', async () => {
    const fixture = await fullAdmissionFixture();
    const firstWorkers = vi.fn(async () => ({ status: 'admitted' }));
    const first = new PortablePreparedReferenceViewAuthorityV1({ admitSearch: firstWorkers });

    await expect(first.admit(fixture.admission)).resolves.toMatchObject({
      trackTypes: ['mRNA'],
      searchReady: true,
    });
    expect(firstWorkers).toHaveBeenCalledTimes(2);

    const restartedWorkers = vi.fn(async () => ({ status: 'admitted' }));
    const restarted = new PortablePreparedReferenceViewAuthorityV1({
      admitSearch: restartedWorkers,
    });
    const projection = await restarted.admit(fixture.admission);

    expect(projection).toMatchObject({
      trackTypes: ['mRNA'],
      searchReady: true,
      assetGenerationsByTheme: {
        light: { sourceFingerprint: fixture.sourceFingerprint },
        dark: { sourceFingerprint: fixture.sourceFingerprint },
      },
    });
    expect(restartedWorkers).not.toHaveBeenCalled();

    const search = await restarted.readAnnotationSearchIndex(fixture.searchRequest);
    expect(search).toMatchObject({
      status: 'hit',
      fingerprint: fixture.sourceFingerprint,
      payloadSha256: fixture.annotationPayloadSha256,
    });
  });

  it('falls back to the exhaustive workers when a bound payload changes', async () => {
    const fixture = await fullAdmissionFixture();
    const first = new PortablePreparedReferenceViewAuthorityV1({ admitSearch: vi.fn() });
    await first.admit(fixture.admission);

    await writeFile(fixture.annotationPayloadPath, Buffer.alloc(fixture.annotationPayloadBytes, 7));

    const fallbackWorkers = vi.fn(async () => ({ status: 'admitted' }));
    const restarted = new PortablePreparedReferenceViewAuthorityV1({
      admitSearch: fallbackWorkers,
    });
    await restarted.admit(fixture.admission);

    expect(fallbackWorkers).toHaveBeenCalledTimes(2);
  });
});

async function fullAdmissionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-portable-full-admission-'));
  roots.push(root);
  const generationRoot = join(root, 'generation');
  const familyRoot = join(root, 'family');
  await Promise.all([mkdir(generationRoot, { recursive: true }), mkdir(familyRoot)]);

  const sourceFingerprint = 'a'.repeat(24);
  const datasetContract = {
    datasetId: 'waypoint:assembly-annotation:fixture',
    datasetVersion: 'fixture-v1',
    sourceSha256: 'b'.repeat(64),
  };
  const placementSignature = 'chr1:100';
  const assemblyContract = {
    assemblyId: 'fixture',
    assemblyLengthBp: 100,
    placementSignature,
    sourceFingerprint,
  };
  const canonicalIdentity = JSON.stringify([
    'annotation.v2',
    'fixture',
    'test',
    'rna-alpha-1',
    'mRNA',
    'mRNA',
    10,
    31,
    'forward',
  ]);
  const [annotationPacked, proteinPacked] = await Promise.all([
    packPrepackedAnnotationSearchIndexV1({
      datasetContract,
      assemblyContract,
      trackType: 'mRNA',
      features: [],
    }),
    packPrepackedProteinSearchIndexV1({
      datasetContract,
      assemblyContract,
      features: [
        {
          proteinSequence: 'MKWVTAA',
          segments: [{ start: 10, end: 31 }],
          strand: 'forward',
          geneticCode: 1,
          leadingFrameOffset: 0,
          label: 'alpha isoform',
          geneId: 'gene-alpha',
          transcriptId: 'rna-alpha-1',
          featureType: 'mRNA',
          annotationTrackId: 'mRNA',
          canonicalIdentity,
        },
      ],
    }),
  ]);
  const annotationCompanionKey = 'c'.repeat(64);
  const proteinCompanionKey = 'd'.repeat(64);
  const annotationPayloadPath = 'search/annotation-search.bin';
  const proteinPayloadPath = 'search/protein-search.bin';
  const annotationManifestPath = `search/annotation-search-${annotationCompanionKey}.v2.json`;
  const proteinManifestPath = `search/protein-search-${proteinCompanionKey}.v1.json`;
  const annotationManifest = {
    contract: 'dnaforge-portable-annotation-search-manifest.v1',
    sourceManifestVersion: ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2,
    sourceFingerprint,
    version: ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2,
    compilerSemantics: ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
    assemblyId: 'fixture',
    fingerprint: sourceFingerprint,
    companionKey: annotationCompanionKey,
    placementSignature,
    payloadFile: basename(annotationPayloadPath),
    byteCount: annotationPacked.payload.byteLength,
    searchManifest: annotationPacked.manifest,
  };
  const proteinWork: ProteinSearchCompilerWorkV1 = {
    transcriptCount: 1,
    sourceTranslationCount: 1,
    derivedTranslationCount: 0,
    skippedEmptyTranslationCount: 0,
    quarantinedIsoformCount: 0,
    quarantinedIsoforms: [],
    quarantineDiagnosticsTruncated: false,
  };
  const proteinManifest = {
    contract: 'dnaforge-portable-protein-search-manifest.v1',
    sourceManifestVersion: ASSEMBLY_PROTEIN_SEARCH_CACHE_V1,
    sourceFingerprint,
    version: ASSEMBLY_PROTEIN_SEARCH_CACHE_V1,
    compilerSemantics: ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2,
    assemblyId: 'fixture',
    fingerprint: sourceFingerprint,
    companionKey: proteinCompanionKey,
    placementSignature,
    payloadFile: basename(proteinPayloadPath),
    byteCount: proteinPacked.payload.byteLength,
    searchManifest: proteinPacked.manifest,
    work: proteinWork,
  };

  const placementFingerprint = `ap1:${createHash('sha256')
    .update(
      ['placement:ordered-linear-assembly-placement-v1', 'total:100', '0|chr1|0|100|100'].join('\n')
    )
    .digest('hex')
    .slice(0, 24)}`;
  const surfaceManifestFingerprint = 'e'.repeat(64);
  const broadCatalogFingerprint = 'f'.repeat(64);
  const scenePayload = Buffer.from('focused-scene-payload');
  const scenePayloadSha256 = sha256(scenePayload);
  const viewEntry = (themeMode: 'dark' | 'light', broadManifestObjectId: string) => ({
    themeMode,
    trackType: 'mRNA',
    sourceFingerprint,
    surfaceManifestFingerprint,
    catalogFingerprint: broadCatalogFingerprint,
    placementFingerprint,
    scenePayloadSha256,
    sceneContractSha256: '1'.repeat(64),
    sceneCompilerContractFingerprint: '2'.repeat(64),
    sceneArtifactKey: 'fixture-mrna-artifact',
    sceneManifestObjectId: 'scene-manifest',
    scenePayloadObjectId: 'scene-payload',
    broadManifestObjectId,
  });
  const viewCatalogCore = {
    contract: 'dnaforge-portable-prepared-reference-view-catalog.v1',
    assemblyId: 'fixture',
    sourceFingerprint,
    entries: [viewEntry('dark', 'broad-dark'), viewEntry('light', 'broad-light')],
  };
  const viewCatalog = {
    ...viewCatalogCore,
    catalogFingerprint: sha256(Buffer.from(canonicalJson(viewCatalogCore))),
  };
  const preparedDefinition = {
    contract: 'dnaforge-prepared-reference-definition.v1',
    pipelineRevision: 1,
    id: 'fixture',
    name: 'Fixture',
    organism: 'Test organism',
    description: 'Focused durable-admission fixture.',
    assetCacheKey: 'fixture',
    source: { fastaSha256: '3'.repeat(64), gffSha256: '4'.repeat(64) },
    provenance: { provider: 'test', datasetId: 'fixture', datasetVersion: 'fixture-v1' },
    members: [
      {
        chrom: 'chr1',
        displayName: 'chr1',
        lengthBp: 100,
        sourceSeqId: 'chr1',
        manifest: {
          fastaPath: 'prepared/chr1/chr1.fa.gz',
          faiPath: 'prepared/chr1/chr1.fa.gz.fai',
          gffPath: 'prepared/chr1/chr1.gff3.gz',
          tbiPath: 'prepared/chr1/chr1.gff3.gz.tbi',
        },
      },
    ],
  };
  const scope = {
    kind: 'complete-assembly' as const,
    placements: [{ chrom: 'chr1', length: 100, annotationCoverage: 'sourced' as const }],
  };
  const chromosomeManifest = {
    chrom: 'chr1',
    length: 100,
    fastaPath: '/publisher/chr1.fa.gz',
    faiPath: '/publisher/chr1.fa.gz.fai',
    gffPath: '/publisher/chr1.gff3.gz',
    tbiPath: '/publisher/chr1.gff3.gz.tbi',
  };
  const chromosomes = [
    {
      chrom: 'chr1',
      length: 100,
      sourcePath: '/publisher/chr1.gff3.gz',
      manifest: chromosomeManifest,
    },
  ];
  const searchReceipt = (packed: typeof annotationPacked, contractToken: string) => ({
    fingerprint: sourceFingerprint,
    byteCount: packed.payload.byteLength,
    payloadSha256: packed.manifest.integrity.payloadSha256,
    contractSha256: packed.manifest.integrity.contractSha256,
    schema: packed.manifest.schema,
    contractToken,
  });
  const productManifest = (themeMode: 'dark' | 'light') => {
    const core = {
      contract: ASSEMBLY_ANNOTATION_PRODUCT_SET_MANIFEST_V2,
      assemblyId: 'fixture',
      themeMode,
      sourceFingerprint,
      datasetContract,
      scope,
      chromosomes,
      trackTypes: ['mRNA'],
      products: [
        {
          trackType: 'mRNA',
          artifactStatus: 'published',
          sourceFingerprint,
          surfaceManifestFingerprint,
          catalogFingerprint: broadCatalogFingerprint,
        },
      ],
      searchIndexes: {
        annotationSearch: searchReceipt(
          annotationPacked,
          PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN
        ),
        proteinSearch: searchReceipt(
          proteinPacked as unknown as typeof annotationPacked,
          PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN
        ),
      },
    };
    return { ...core, inventoryFingerprint: sha256(Buffer.from(JSON.stringify(core))) };
  };

  const bytesById = new Map<string, Buffer>([
    ['definition', Buffer.from(JSON.stringify(preparedDefinition))],
    ['view-catalog', Buffer.from(JSON.stringify(viewCatalog))],
    ['broad-dark', Buffer.from('broad-dark')],
    ['broad-light', Buffer.from('broad-light')],
    ['fasta', Buffer.from('fasta')],
    ['fai', Buffer.from('fai')],
    ['gff', Buffer.from('gff')],
    ['tbi', Buffer.from('tbi')],
    ['scene-manifest', Buffer.from('scene-manifest')],
    ['scene-payload', scenePayload],
    ['product-dark', Buffer.from(JSON.stringify(productManifest('dark')))],
    ['product-light', Buffer.from(JSON.stringify(productManifest('light')))],
    ['annotation-search-manifest', Buffer.from(JSON.stringify(annotationManifest))],
    ['annotation-search-payload', Buffer.from(annotationPacked.payload)],
    ['protein-search-manifest', Buffer.from(JSON.stringify(proteinManifest))],
    ['protein-search-payload', Buffer.from(proteinPacked.payload)],
  ]);
  const draft = (
    id: string,
    role: PortablePreparedReferenceObjectRoleV1,
    tier: PortablePreparedReferenceReadinessTierV1,
    installPath: string,
    dependsOn: readonly string[] = []
  ) => {
    const bytes = bytesById.get(id)!;
    const digest = sha256(bytes);
    return {
      id,
      role,
      objectKey: portablePreparedReferenceContentObjectKeyV1(digest),
      installPath,
      byteLength: bytes.byteLength,
      sha256: digest,
      contractToken: `${role}.v1`,
      dependsOn,
      tier,
    };
  };
  const drafts = [
    draft('definition', 'prepared-reference-definition', 'shell', 'shell/definition.json'),
    draft('view-catalog', 'view-catalog', 'view', 'view/catalog.json', ['definition']),
    draft('broad-dark', 'broad-raster-manifest', 'view', 'view/dark/broad.json', ['view-catalog']),
    draft('broad-light', 'broad-raster-manifest', 'view', 'view/light/broad.json', [
      'view-catalog',
    ]),
    draft('fasta', 'fasta', 'detail', 'prepared/chr1/chr1.fa.gz', ['definition']),
    draft('fai', 'fasta-index', 'detail', 'prepared/chr1/chr1.fa.gz.fai', ['fasta']),
    draft('gff', 'gff3-bgzf', 'detail', 'prepared/chr1/chr1.gff3.gz', ['definition']),
    draft('tbi', 'gff3-tabix', 'detail', 'prepared/chr1/chr1.gff3.gz.tbi', ['gff']),
    draft('scene-manifest', 'annotation-scene-manifest', 'detail', 'detail/scene.json', [
      'view-catalog',
    ]),
    draft('scene-payload', 'annotation-scene-payload', 'detail', 'detail/scene.bin', [
      'scene-manifest',
    ]),
    draft('product-dark', 'annotation-product-set-manifest', 'detail', 'detail/dark.json', [
      'view-catalog',
    ]),
    draft('product-light', 'annotation-product-set-manifest', 'detail', 'detail/light.json', [
      'view-catalog',
    ]),
    {
      ...draft(
        'annotation-search-manifest',
        'annotation-search-manifest',
        'search',
        annotationManifestPath,
        ['definition']
      ),
      contractToken: 'dnaforge-portable-annotation-search-manifest.v1',
    },
    {
      ...draft(
        'annotation-search-payload',
        'annotation-search-payload',
        'search',
        annotationPayloadPath,
        ['annotation-search-manifest']
      ),
      contractToken: PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN,
    },
    {
      ...draft(
        'protein-search-manifest',
        'protein-search-manifest',
        'search',
        proteinManifestPath,
        ['definition']
      ),
      contractToken: 'dnaforge-portable-protein-search-manifest.v1',
    },
    {
      ...draft('protein-search-payload', 'protein-search-payload', 'search', proteinPayloadPath, [
        'protein-search-manifest',
      ]),
      contractToken: PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN,
    },
  ];
  const objects = drafts.map(({ tier: _tier, ...object }) => object);
  const bundle = buildPortablePreparedReferenceBundleV1({
    assembly: {
      id: 'fixture',
      assetCacheKey: 'fixture',
      preparationPipelineRevision: 1,
      assemblyLengthBp: 100,
      contigCount: 1,
      source: { fastaSha256: '3'.repeat(64), gffSha256: '4'.repeat(64) },
    },
    objects,
    readiness: {
      shell: { dependsOn: [], objectIds: ['definition'] },
      view: { dependsOn: ['shell'], objectIds: ['view-catalog', 'broad-dark', 'broad-light'] },
      detail: {
        dependsOn: ['view'],
        objectIds: [
          'fasta',
          'fai',
          'gff',
          'tbi',
          'scene-manifest',
          'scene-payload',
          'product-dark',
          'product-light',
        ],
      },
      search: {
        dependsOn: ['shell'],
        objectIds: [
          'annotation-search-manifest',
          'annotation-search-payload',
          'protein-search-manifest',
          'protein-search-payload',
        ],
      },
    },
  });
  const objectPaths = new Map<string, string>();
  for (const object of objects) {
    const path = join(generationRoot, object.installPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytesById.get(object.id)!);
    objectPaths.set(object.id, path);
  }
  const hydration: PortablePreparedReferenceHydrationResult = {
    bundle,
    generationRoot,
    hydratedTiers: ['detail', 'search'],
    objectPaths,
  };
  const hydrator = {} as PortablePreparedReferenceHydrator;
  const definition = { id: 'fixture' } as HostedReferenceCatalogDefinitionV1;
  const admission = {
    definition,
    familyRoot,
    hydration,
    hydrator,
    runtimeSourceFingerprint: 'focused-runtime-a',
  };
  const installed = preparedDefinition.members[0].manifest;
  const searchRequest = {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'fixture',
    workspaceRoot: familyRoot,
    datasetContract,
    scope,
    chromosomes: [
      {
        chrom: 'chr1',
        length: 100,
        sourcePath: join(generationRoot, installed.gffPath),
        manifest: {
          chrom: 'chr1',
          length: 100,
          fastaPath: join(generationRoot, installed.fastaPath),
          faiPath: join(generationRoot, installed.faiPath),
          gffPath: join(generationRoot, installed.gffPath),
          tbiPath: join(generationRoot, installed.tbiPath),
        },
      },
    ],
    artifact: {
      artifactKey: 'fixture-mrna-artifact',
      themeMode: 'light' as const,
      trackType: 'mRNA' as const,
      partitionSpanBp: 100_000_000,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: 'source-lanes.v1' as const,
      mapperContractToken: 'annotation-isoform-mapper.v2' as const,
      geometryContractToken:
        'retained-linear-directional-block.track-local.theme-final.v3' as const,
      interactionContractToken: 'annotation-feature-hit-index.v3' as const,
    },
    requestedPolicy: { isoformMode: 'canonical' as const, laneLimit: null },
  };
  return {
    admission,
    searchRequest,
    sourceFingerprint,
    annotationPayloadPath: join(generationRoot, annotationPayloadPath),
    annotationPayloadBytes: annotationPacked.payload.byteLength,
    annotationPayloadSha256: annotationPacked.manifest.integrity.payloadSha256,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
