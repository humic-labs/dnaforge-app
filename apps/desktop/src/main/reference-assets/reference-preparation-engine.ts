import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ReferenceSemanticsV1 } from '@waypoint/genome-data';
import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '@waypoint/genome-renderer/pure';

import {
  buildGenomeAssembly,
  referenceAssemblyCacheRoot,
  referenceAssemblyById,
  referenceAssemblySourceOwner,
  referenceAssemblyViewsForAssetCacheKey,
  type ReferenceAssemblyEntry,
  type ReferenceAssemblyMember,
} from '../../features/sequence/reference-catalog';
import {
  createReferenceAssetProductLayoutV1,
  parseReferenceAssetPublicationV1,
  REFERENCE_ASSET_PUBLICATION_V1,
  REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1,
  REFERENCE_ASSET_PRODUCT_STORAGE_SHARED_V1,
  referenceAssetPublicationPath,
  referenceAssetPublicationProductRoot,
  referenceAssetPublicationSourceRoot,
  type ReferenceAssetProductLayoutV1,
  type ReferenceAssetPublicationV1,
  type ReferenceAssetRequiredAnnotationProductV1,
} from '../../features/sequence/reference-asset-publication';
import {
  PREPARED_REFERENCE_DEFINITION_FILE,
  PREPARED_REFERENCE_DEFINITION_V2,
  PREPARED_REFERENCE_DEFINITION_V3,
  parsePreparedReferenceDefinition,
  preparedReferenceAssemblyEntry,
  preparedReferenceDefinition,
  preparedReferenceDefinitionV3,
  readReferencePreparationManifest,
  type HostedReferencePreparationManifestAdmissionV2,
  type LoadedReferencePreparationManifest,
} from './reference-preparation-manifest';
import { preparedAnnotationIndexSuffix } from './reference-preparation-validation';
import { parsePortablePreparedReferenceSourceReceiptV2 } from './portable-prepared-reference-source-receipt';
import { verifyPortableSourceQuartet } from './portable-source-quartet-verification';
import { assemblyAnnotationSourceRequest } from '../../features/sequence/assembly-annotation-source-request';
import { deriveAssemblyPrepackedAnnotationSceneDescriptor } from '../../features/sequence/assembly-annotation-product-descriptor';
import {
  assemblyAnnotationSceneScopeForRequest,
  type AssemblyAnnotationSceneReadRequest,
  type IndexedGenomeManifest,
} from '../../shared/indexed-genome';
import {
  createAuthorizedExpandedAnnotationSourcePathGuard,
  compileAndCommitExpandedAnnotationSceneWorkerJob,
  compileAndCommitExpandedAnnotationSceneWorkerSetJob,
  readExpandedAnnotationSceneTrackInventoryWorkerJob,
} from '../ipc/assembly-expanded-annotation-scene-compiler';
import { compileAndCommitAssemblyAnnotationSearchWorkerJob } from '../ipc/assembly-annotation-search-compiler';
import { compileAndCommitAssemblyProteinSearchWorkerJob } from '../ipc/assembly-protein-search-build';
import { readAssemblyOverviewCaches } from '../ipc/assembly-overview-cache';
import { writeAssemblyOverviewFeaturesCache } from '../ipc/assembly-overview-features-cache';
import {
  createAuthorizedCompiledBroadRasterScenePathGuard,
  prepareAssemblyCompiledBroadRasterWorkerJobV1,
} from '../ipc/assembly-compiled-broad-raster-worker-job';
import { getCachedAnnotationOverviewTile } from '../ipc/genome-overview-tile-cache';
import {
  ensureChromosomeSourceSummaryV1,
  type ChromosomeSourceSummaryJobV1,
} from './reference-source-summary';
import {
  createAssemblyReferenceAssetAuthoritiesV1,
  type AssemblyReferenceAssetAuthoritiesV1,
  type AssemblyReferenceAssetRuntimeV1,
} from './create-assembly-reference-asset-service';
import type { AssemblyReferenceAssetStatusV1 } from './assembly-reference-asset-service';
import {
  acquireReferenceAssetWriterLock,
  type ReferenceAssetWriterLease,
} from './reference-asset-writer-lock';
import {
  createLocalPreparedSourceReceipt,
  LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE,
  localPreparedSourceReceiptMatches,
  samePreparedSourceFileIdentity as sameFileIdentity,
  type PreparedOutputIdentitySet,
  type PreparedSourceIdentitySet,
} from './prepared-reference-source-receipt';
import { materializePreparedReferenceAssembly } from './prepared-reference-assembly-materializer';
import { HOSTED_REFERENCE_CATALOG_V1 } from './hosted-reference-catalog';
import {
  matureHostedPreparedReferenceSemanticsV1,
  maturePreparedReferenceSemanticsV1,
  validateHostedReferenceSemanticMaturationV1,
} from './reference-semantic-maturation';
import {
  assertAtOrBelow,
  DNA_INDEXER_SCHEMA,
  fileIdentity,
  gziPathForPreparedFasta,
  isBgzfFile,
  readDnaIndexerSchema,
  readPreparedFaiLength,
  type PreparedOutputPaths,
  type PreparedSourcePaths,
  verifyOptionalSha256,
} from './reference-preparation-file-integrity';
import {
  DNA_INDEXER_ASSEMBLY_INGEST_TIMEOUT_MS,
  execDnaIndexerFile,
  runDnaIndexerAssemblyIngestProcess,
} from './dna-indexer-process';

export type ReferenceAssetPreparationCommand = 'status' | 'ensure' | 'verify';
const REFERENCE_SOURCE_RECEIPT_FILE = LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE;

export { DNA_INDEXER_ASSEMBLY_INGEST_TIMEOUT_MS, runDnaIndexerAssemblyIngestProcess };

export interface ReferenceAssetPreparationInput {
  readonly command: ReferenceAssetPreparationCommand;
  readonly assemblyId?: string;
  readonly manifestPath?: string | null;
  readonly hostedManifestAdmission?: HostedReferencePreparationManifestAdmissionV2;
  readonly projectRoot: string;
  readonly cacheRoot: string;
  readonly publicationRoot?: string;
  readonly fallbackPublicationRoot?: string | null;
  readonly themeMode: 'light' | 'dark';
  readonly sourceBuildFingerprint: string;
  readonly indexerBinary?: string;
  readonly publishedEntry?: ReferenceAssemblyEntry;
  readonly expectedPublishedSource?: Readonly<{
    fastaSha256: string;
    gffSha256?: string;
  }>;
  readonly runCompilersDirectly?: boolean;
  readonly preparedThemes?: readonly ('light' | 'dark')[];
  readonly onProgress?: (message: string) => void;
  readonly onSourcePublished?: () => void | Promise<void>;
}

export type ReferenceAssetPreparationReceipt = Readonly<{
  command: ReferenceAssetPreparationCommand;
  assemblyId: string;
  manifestPath: string | null;
  projectRoot: string;
  cacheRoot: string;
  workspaceRoot: string;
  sourceGenerationRoot: string | null;
  publication: ReferenceAssetPublicationV1 | null;
  themeMode: 'light' | 'dark';
  sourceBuildFingerprint: string;
  durationMs: number;
}> &
  (
    | AssemblyReferenceAssetStatusV1
    | Readonly<{
        status: 'source-ready';
        message: string;
      }>
  );

type ReferenceAssetPreparationResult =
  | AssemblyReferenceAssetStatusV1
  | Readonly<{
      status: 'source-ready';
      message: string;
    }>;

export type PreparedReferenceSourcePublicationStatusV1 =
  | Readonly<{
      status: 'ready';
      publicationId: string;
      sourceGenerationRoot: string;
    }>
  | Readonly<{
      status: 'needs-refresh';
      reason: 'source-index-missing';
      message: string;
    }>;

type PreparedReferenceSourcePublicationResolution =
  | Readonly<{
      status: 'ready';
      publication: ReferenceAssetPublicationV1;
      sourceGenerationRoot: string;
      entry: ReferenceAssemblyEntry;
    }>
  | Readonly<{ status: 'stale'; message: string }>;

export async function inspectPreparedReferenceSourcePublication(input: {
  readonly entry: ReferenceAssemblyEntry;
  readonly cacheRoot: string;
  readonly publicationRoot?: string;
  readonly fallbackPublicationRoot?: string | null;
  readonly expectedSource: Readonly<{
    fastaSha256: string;
    gffSha256?: string;
  }>;
}): Promise<PreparedReferenceSourcePublicationStatusV1> {
  const resolved = await resolvePreparedReferenceSourcePublication(input);
  return resolved.status === 'ready'
    ? {
        status: 'ready',
        publicationId: resolved.publication.publicationId,
        sourceGenerationRoot: resolved.sourceGenerationRoot,
      }
    : {
        status: 'needs-refresh',
        reason: 'source-index-missing',
        message: `Prepared reference source admission failed: ${resolved.message}`,
      };
}

export async function inspectPreparedReferenceAssetPublication(input: {
  readonly entry: ReferenceAssemblyEntry;
  readonly cacheRoot: string;
  readonly publicationRoot?: string;
  readonly fallbackPublicationRoot?: string | null;
  readonly sourceBuildFingerprint: string;
  readonly themeMode: 'light' | 'dark';
  readonly expectedSource: Readonly<{
    fastaSha256: string;
    gffSha256?: string;
  }>;
}): Promise<AssemblyReferenceAssetStatusV1> {
  const source = await resolvePreparedReferenceSourcePublication(input);
  if (source.status === 'stale') {
    return {
      status: 'needs-refresh',
      reason: 'source-index-missing',
      message: `Prepared reference admission failed: ${source.message}`,
    };
  }

  try {
    return await runReferenceAssetLifecycle({
      entry: source.entry,
      workspaceRoot: referenceAssetPublicationProductRoot(
        referenceAssemblyCacheRoot(resolve(input.cacheRoot), source.entry),
        source.publication
      ),
      sourceGenerationRoot: source.sourceGenerationRoot,
      sourceMaterializationFingerprint: source.publication.sourceMaterializationFingerprint,
      sourceBuildFingerprint: input.sourceBuildFingerprint,
      themeMode: resultTheme(input),
      command: 'status',
      runCompilersDirectly: false,
    });
  } catch (error) {
    return {
      status: 'needs-refresh',
      reason: 'verification-failed',
      message:
        error instanceof Error
          ? `Prepared reference admission failed: ${error.message}`
          : 'Prepared reference admission failed.',
    };
  }
}

async function resolvePreparedReferenceSourcePublication(input: {
  readonly entry: ReferenceAssemblyEntry;
  readonly cacheRoot: string;
  readonly publicationRoot?: string;
  readonly fallbackPublicationRoot?: string | null;
  readonly expectedSource: Readonly<{
    fastaSha256: string;
    gffSha256?: string;
  }>;
}): Promise<PreparedReferenceSourcePublicationResolution> {
  const cacheRoot = resolve(input.cacheRoot);
  const workspaceRoot = referenceAssemblyCacheRoot(cacheRoot, input.entry);
  const publicationWorkspaceRoot = referenceAssemblyCacheRoot(
    resolve(input.publicationRoot ?? cacheRoot),
    input.entry
  );
  const fallbackPublicationWorkspaceRoot = input.fallbackPublicationRoot
    ? referenceAssemblyCacheRoot(resolve(input.fallbackPublicationRoot), input.entry)
    : null;
  assertAtOrBelow(cacheRoot, workspaceRoot, 'Reference assembly cache');
  const publication = await readReferenceAssetPublication(
    workspaceRoot,
    publicationWorkspaceRoot,
    fallbackPublicationWorkspaceRoot,
    input.entry.assetCacheKey
  );
  if (!publication) {
    return { status: 'stale', message: 'No committed reference-asset generation is available.' };
  }
  const sourceGenerationRoot = referenceAssetPublicationSourceRoot(workspaceRoot, publication);
  assertAtOrBelow(workspaceRoot, sourceGenerationRoot, 'Published reference source generation');

  try {
    const definition = parsePreparedReferenceDefinition(
      JSON.parse(
        await readFile(join(sourceGenerationRoot, PREPARED_REFERENCE_DEFINITION_FILE), 'utf8')
      ) as unknown,
      input.entry.assetCacheKey
    );
    if (
      definition.source.fastaSha256 !== input.expectedSource.fastaSha256.toLowerCase() ||
      (definition.source.gffSha256 ?? null) !==
        (input.expectedSource.gffSha256?.toLowerCase() ?? null)
    ) {
      return {
        status: 'stale',
        message: 'Prepared reference source identity does not match the hosted catalog.',
      };
    }
    const definitionEntry = preparedReferenceAssemblyEntry(definition);
    const comparableEntry =
      !input.entry.referenceIdentity ||
      input.entry.referenceIdentity.sequenceIdentity ===
        definitionEntry.referenceIdentity?.sequenceIdentity
        ? { ...input.entry, referenceIdentity: definitionEntry.referenceIdentity }
        : input.entry;
    if (
      canonicalJson(sourceComparableReferenceEntry(definitionEntry)) !==
      canonicalJson(sourceComparableReferenceEntry(comparableEntry))
    ) {
      return {
        status: 'stale',
        message: 'Prepared reference definition does not match the admitted assembly entry.',
      };
    }
    const preparedSources = await inspectCommittedPreparedReferenceSources(
      definitionEntry,
      sourceGenerationRoot
    );
    if (preparedSources.status === 'stale') return preparedSources;
    const sourceFingerprint = await preparedSourceMaterializationFingerprint(
      definitionEntry,
      sourceGenerationRoot
    );
    if (sourceFingerprint !== publication.sourceMaterializationFingerprint) {
      return {
        status: 'stale',
        message: 'Published source materialization fingerprint does not match its pointer.',
      };
    }
    return {
      status: 'ready',
      publication,
      sourceGenerationRoot,
      entry: definitionEntry,
    };
  } catch (error) {
    return {
      status: 'stale',
      message: error instanceof Error ? error.message : 'Prepared reference source is unavailable.',
    };
  }
}

function assertReferencePreparationInputs(
  input: ReferenceAssetPreparationInput,
  preparation: Awaited<ReturnType<typeof readReferencePreparationManifest>> | null
): {
  entry: NonNullable<ReturnType<typeof referenceAssemblyById>>;
  sourceOwner: NonNullable<ReturnType<typeof referenceAssemblySourceOwner>>;
} {
  if (preparation && input.publishedEntry) {
    throw new Error('Reference preparation cannot combine raw inputs with a published entry.');
  }
  if (input.publishedEntry && !input.expectedPublishedSource) {
    throw new Error('Published reference product repair requires the expected hosted source.');
  }
  const assemblyId = input.assemblyId ?? 'grch38';
  const entry = preparation?.entry ?? input.publishedEntry ?? referenceAssemblyById(assemblyId);
  if (!entry) throw new Error(`Unknown reference assembly: ${assemblyId}`);
  if (input.publishedEntry && input.publishedEntry.id !== assemblyId) {
    throw new Error('Published reference product repair identity does not match the assembly ID.');
  }
  const sourceOwner =
    preparation || input.publishedEntry ? entry : referenceAssemblySourceOwner(entry);
  if (!sourceOwner) {
    throw new Error(`Reference asset family ${entry.assetCacheKey} has no canonical source owner.`);
  }
  return { entry, sourceOwner };
}

async function inspectCurrentPreparedReferenceDefinition(params: {
  preparation: Awaited<ReturnType<typeof readReferencePreparationManifest>> | null;
  sourceGenerationRoot: string | null;
  input: ReferenceAssetPreparationInput;
  cacheRoot: string;
  publicationRoot: string;
  fallbackPublicationRoot: string | null;
}): Promise<PreparedSourceInspection> {
  const {
    preparation,
    sourceGenerationRoot,
    input,
    cacheRoot,
    publicationRoot,
    fallbackPublicationRoot,
  } = params;
  if (preparation && sourceGenerationRoot) {
    return inspectPreparedReferenceDefinition(preparation, sourceGenerationRoot);
  }
  if (input.publishedEntry && input.expectedPublishedSource) {
    const inspection = await inspectPreparedReferenceSourcePublication({
      entry: input.publishedEntry,
      cacheRoot,
      publicationRoot,
      fallbackPublicationRoot,
      expectedSource: input.expectedPublishedSource,
    });
    return inspection.status === 'ready'
      ? { status: 'ready' }
      : { status: 'stale', message: inspection.message };
  }
  return { status: 'ready' };
}

async function ensureReferenceAssetPreparation(params: {
  input: ReferenceAssetPreparationInput;
  preparation: Awaited<ReturnType<typeof readReferencePreparationManifest>> | null;
  entry: ReferenceAssemblyEntry;
  sourceOwner: ReferenceAssemblyEntry;
  familyViews: ReturnType<typeof referenceAssemblyViewsForAssetCacheKey>;
  annotationProductsRequired: boolean;
  projectRoot: string;
  cacheRoot: string;
  publicationRoot: string;
  fallbackPublicationRoot: string | null;
  workspaceRoot: string;
  publicationWorkspaceRoot: string;
  publication: ReferenceAssetPublicationV1 | null;
  inheritedPublication: boolean;
  sourceGenerationRoot: string | null;
  indexer: {
    binary: string;
    version: Awaited<ReturnType<typeof requireCompatibleDnaIndexer>>;
  } | null;
  writerLease: ReferenceAssetWriterLease | null;
}): Promise<{
  result: ReferenceAssetPreparationResult;
  publication: ReferenceAssetPublicationV1 | null;
  sourceGenerationRoot: string | null;
}> {
  const { input, preparation, entry, sourceOwner, familyViews, annotationProductsRequired } =
    params;
  const {
    projectRoot,
    cacheRoot,
    publicationRoot,
    fallbackPublicationRoot,
    workspaceRoot,
    publicationWorkspaceRoot,
    inheritedPublication,
    indexer,
    writerLease,
  } = params;
  let { publication, sourceGenerationRoot } = params;
  const sourceBuildFingerprint = input.sourceBuildFingerprint;
  const report = input.onProgress;
  const currentDefinition = await inspectCurrentPreparedReferenceDefinition({
    preparation,
    sourceGenerationRoot,
    input,
    cacheRoot,
    publicationRoot,
    fallbackPublicationRoot,
  });
  const inspectedFamily =
    annotationProductsRequired &&
    publication &&
    sourceGenerationRoot &&
    currentDefinition.status === 'ready'
      ? {
          publication,
          results: await inspectPublishedAssetFamily({
            publication,
            sourceOwner,
            familyViews,
            projectRoot,
            workspaceRoot: referenceAssetPublicationProductRoot(workspaceRoot, publication),
            sourceGenerationRoot,
            sourceBuildFingerprint,
            report,
            runCompilersDirectly: input.runCompilersDirectly ?? false,
            preparedThemes: preparedThemesFor(input),
          }),
        }
      : null;
  const currentFamily = inspectedFamily?.results
    ? { publication: inspectedFamily.publication, results: inspectedFamily.results }
    : null;
  const currentReady = currentFamily?.results ?? null;
  const currentSequenceSource =
    !annotationProductsRequired &&
    publication &&
    sourceGenerationRoot &&
    currentDefinition.status === 'ready'
      ? await inspectPublishedReferenceSources(
          publication,
          sourceOwner,
          projectRoot,
          sourceGenerationRoot
        )
      : null;
  const requestedCurrent = currentReady?.[entry.id];
  if (currentSequenceSource?.status === 'ready') {
    return {
      result: sourceOnlyPreparationReady(entry),
      publication,
      sourceGenerationRoot,
    };
  }
  if (currentFamily && publishedAssetFamilyIsReady(currentFamily.results) && requestedCurrent) {
    const productLayout = productLayoutForVerifiedAssetFamily(
      currentFamily.results,
      productStorageForPublication(currentFamily.publication)
    );
    if (!sameReferenceAssetProductLayout(publication?.productLayout, productLayout)) {
      if (!publication || !writerLease) {
        throw new Error('Reference asset writer lease is unavailable.');
      }
      publication = { ...publication, productLayout, publishedAtMs: Date.now() };
      await publishReferenceAssetGeneration(
        workspaceRoot,
        publicationWorkspaceRoot,
        publication,
        writerLease
      );
    }
    return {
      result: requestedCurrent[resultTheme(input)] ?? requestedCurrent.light,
      publication,
      sourceGenerationRoot,
    };
  }
  if (currentFamily && sourceGenerationRoot && !inheritedPublication) {
    const built = await buildAndVerifyPublishedAssetFamily({
      familyViews,
      workspaceRoot: sourceGenerationRoot,
      sourceGenerationRoot,
      sourceMaterializationFingerprint: currentFamily.publication.sourceMaterializationFingerprint,
      sourceBuildFingerprint,
      report,
      runCompilersDirectly: input.runCompilersDirectly ?? false,
      preparedThemes: preparedThemesFor(input),
    });
    if (!publication || !writerLease) {
      throw new Error('Reference asset writer lease is unavailable.');
    }
    publication = {
      ...publication,
      productLayout: productLayoutForVerifiedAssetFamily(
        built,
        REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1
      ),
      publishedAtMs: Date.now(),
    };
    await publishReferenceAssetGeneration(
      workspaceRoot,
      publicationWorkspaceRoot,
      publication,
      writerLease
    );
    return {
      result: resultForPublishedAssetFamily(built, entry.id, resultTheme(input)),
      publication,
      sourceGenerationRoot,
    };
  }
  if (currentReady && sourceGenerationRoot) {
    return {
      result: {
        status: 'needs-refresh',
        reason: 'verification-failed',
        message:
          'This profile inherited a read-only reference publication whose derived products need refresh.',
      },
      publication,
      sourceGenerationRoot,
    };
  }
  if (input.publishedEntry) {
    return {
      result: {
        status: 'needs-refresh',
        reason: 'source-index-missing',
        message:
          currentDefinition.status === 'stale'
            ? currentDefinition.message
            : 'The committed prepared source is unavailable for product repair.',
      },
      publication,
      sourceGenerationRoot,
    };
  }
  if (!indexer) {
    throw new Error('Reference preparation requires an available dna-indexer helper.');
  }
  publication = newReferenceAssetPublication(entry.assetCacheKey);
  sourceGenerationRoot = referenceAssetPublicationSourceRoot(workspaceRoot, publication);
  assertAtOrBelow(workspaceRoot, sourceGenerationRoot, 'Reference source generation');
  const initialPublication = publication;
  const generatedSourceRoot = sourceGenerationRoot;
  let maturedSemantics: ReferenceSemanticsV1 | null = null;
  const transaction = await runSourceFirstReferenceGenerationTransaction({
    prepareSource: async () => {
      await reserveReferenceAssetGenerationRoot(workspaceRoot, generatedSourceRoot);
      if (preparation) {
        const semanticCandidates = await materializePreparedReferenceAssembly(
          preparation,
          generatedSourceRoot,
          indexer,
          report
        );
        const hostedDefinition = HOSTED_REFERENCE_CATALOG_V1.find(
          (definition) => definition.id === preparation.entry.id
        );
        if (hostedDefinition) {
          maturedSemantics =
            preparation.contract === 'dnaforge-reference-preparation.v2'
              ? matureHostedPreparedReferenceSemanticsV1(
                  hostedDefinition,
                  preparation.assemblyIdentity.sha256,
                  semanticCandidates
                )
              : validateHostedReferenceSemanticMaturationV1(hostedDefinition, semanticCandidates);
          report?.('validated hosted reference semantic maturation');
        } else if (preparation.contract === 'dnaforge-reference-preparation.v2') {
          maturedSemantics = maturePreparedReferenceSemanticsV1(preparation, semanticCandidates);
        }
      } else {
        await ensurePreparedReferenceSources(
          sourceOwner,
          projectRoot,
          generatedSourceRoot,
          indexer,
          report
        );
      }
      const preparedSources = await inspectPreparedReferenceSources(
        sourceOwner,
        projectRoot,
        generatedSourceRoot
      );
      if (preparedSources.status === 'stale') {
        throw new Error(preparedSources.message);
      }
      if (preparation) {
        await writePreparedReferenceDefinition(preparation, generatedSourceRoot, maturedSemantics);
      }
      const sourceFingerprint = await preparedSourceMaterializationFingerprint(
        sourceOwner,
        generatedSourceRoot
      );
      return {
        ...initialPublication,
        sourceMaterializationFingerprint: sourceFingerprint,
        publishedAtMs: Date.now(),
      };
    },
    publishSource: async (preparedPublication) => {
      if (!writerLease) throw new Error('Reference asset writer lease is unavailable.');
      await publishReferenceAssetGeneration(
        workspaceRoot,
        publicationWorkspaceRoot,
        preparedPublication,
        writerLease
      );
      report?.('published source generation');
    },
    onSourcePublished: () => input.onSourcePublished?.(),
    prepareProducts: (preparedPublication) =>
      annotationProductsRequired
        ? buildAndVerifyPublishedAssetFamily({
            familyViews,
            workspaceRoot: generatedSourceRoot,
            sourceGenerationRoot: generatedSourceRoot,
            sourceMaterializationFingerprint: preparedPublication.sourceMaterializationFingerprint,
            sourceBuildFingerprint,
            report,
            runCompilersDirectly: input.runCompilersDirectly ?? false,
            preparedThemes: preparedThemesFor(input),
          })
        : Promise.resolve(null),
    discardUnpublishedSource: () => rm(generatedSourceRoot, { recursive: true, force: true }),
  });
  publication = transaction.source;
  if (transaction.products) {
    if (!writerLease) throw new Error('Reference asset writer lease is unavailable.');
    publication = {
      ...publication,
      productLayout: productLayoutForVerifiedAssetFamily(
        transaction.products,
        REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1
      ),
      publishedAtMs: Date.now(),
    };
    await publishReferenceAssetGeneration(
      workspaceRoot,
      publicationWorkspaceRoot,
      publication,
      writerLease
    );
    return {
      result: resultForPublishedAssetFamily(transaction.products, entry.id, resultTheme(input)),
      publication,
      sourceGenerationRoot,
    };
  }
  return {
    result: sourceOnlyPreparationReady(entry),
    publication,
    sourceGenerationRoot,
  };
}

async function verifyPublishedReferenceAssetPreparation(params: {
  input: ReferenceAssetPreparationInput;
  preparation: Awaited<ReturnType<typeof readReferencePreparationManifest>> | null;
  entry: ReferenceAssemblyEntry;
  sourceOwner: ReferenceAssemblyEntry;
  annotationProductsRequired: boolean;
  projectRoot: string;
  workspaceRoot: string;
  publication: ReferenceAssetPublicationV1 | null;
  sourceGenerationRoot: string | null;
}): Promise<{
  result: ReferenceAssetPreparationResult;
  publication: ReferenceAssetPublicationV1 | null;
  sourceGenerationRoot: string | null;
}> {
  const {
    input,
    preparation,
    entry,
    sourceOwner,
    annotationProductsRequired,
    projectRoot,
    workspaceRoot,
    publication,
    sourceGenerationRoot,
  } = params;
  if (!publication || !sourceGenerationRoot) {
    return {
      result: {
        status: 'needs-refresh',
        reason: 'source-index-missing',
        message: 'No committed reference-asset generation is available.',
      },
      publication,
      sourceGenerationRoot,
    };
  }
  const preparedSources = await inspectPublishedReferenceSources(
    publication,
    sourceOwner,
    projectRoot,
    sourceGenerationRoot
  );
  const preparedDefinition = preparation
    ? await inspectPreparedReferenceDefinition(preparation, sourceGenerationRoot)
    : ({ status: 'ready' } as const);
  const result =
    preparedSources.status === 'stale'
      ? {
          status: 'needs-refresh' as const,
          reason: 'source-index-missing' as const,
          message: preparedSources.message,
        }
      : preparedDefinition.status === 'stale'
        ? {
            status: 'needs-refresh' as const,
            reason: 'source-index-missing' as const,
            message: preparedDefinition.message,
          }
        : annotationProductsRequired
          ? await runReferenceAssetLifecycle({
              entry,
              workspaceRoot: referenceAssetPublicationProductRoot(workspaceRoot, publication),
              sourceGenerationRoot,
              sourceMaterializationFingerprint: publication.sourceMaterializationFingerprint,
              sourceBuildFingerprint: input.sourceBuildFingerprint,
              themeMode: resultTheme(input),
              command: input.command,
              report: input.onProgress,
              runCompilersDirectly: input.runCompilersDirectly ?? false,
            })
          : sourceOnlyPreparationReady(entry);
  return { result, publication, sourceGenerationRoot };
}

export async function runReferenceAssetPreparation(
  input: ReferenceAssetPreparationInput
): Promise<ReferenceAssetPreparationReceipt> {
  const startedAt = Date.now();
  const projectRoot = resolve(input.projectRoot);
  const cacheRoot = resolve(input.cacheRoot);
  const publicationRoot = resolve(input.publicationRoot ?? cacheRoot);
  const fallbackPublicationRoot = input.fallbackPublicationRoot
    ? resolve(input.fallbackPublicationRoot)
    : null;
  const manifestPath = input.manifestPath ? resolve(input.manifestPath) : null;
  if (input.hostedManifestAdmission && !manifestPath) {
    throw new Error('Hosted manifest admission requires a preparation manifest.');
  }
  const preparation = manifestPath
    ? await readReferencePreparationManifest(manifestPath, input.hostedManifestAdmission)
    : null;
  const { entry, sourceOwner } = assertReferencePreparationInputs(input, preparation);
  const familyViews =
    preparation || input.publishedEntry
      ? [entry]
      : referenceAssemblyViewsForAssetCacheKey(entry.assetCacheKey);
  const annotationProductsRequired = referenceEntryHasAnnotationProducts(entry);
  const workspaceRoot = referenceAssemblyCacheRoot(cacheRoot, entry);
  const publicationWorkspaceRoot = referenceAssemblyCacheRoot(publicationRoot, entry);
  const fallbackPublicationWorkspaceRoot = fallbackPublicationRoot
    ? referenceAssemblyCacheRoot(fallbackPublicationRoot, entry)
    : null;
  assertAtOrBelow(cacheRoot, workspaceRoot, 'Reference assembly cache');
  const indexer =
    input.command === 'ensure'
      ? await resolveDnaIndexerBinary(projectRoot, input.indexerBinary).then(async (binary) => ({
          binary,
          version: await requireCompatibleDnaIndexer(binary),
        }))
      : null;
  const writerLease = indexer
    ? await acquireReferenceAssetWriterLock(workspaceRoot, indexer.binary)
    : null;
  try {
    const sourceBuildFingerprint = input.sourceBuildFingerprint;
    let publication = await readReferenceAssetPublication(
      workspaceRoot,
      publicationWorkspaceRoot,
      null,
      entry.assetCacheKey
    );
    let inheritedPublication = false;
    if (!publication && fallbackPublicationWorkspaceRoot) {
      publication = await readReferenceAssetPublication(
        workspaceRoot,
        fallbackPublicationWorkspaceRoot,
        null,
        entry.assetCacheKey
      );
      inheritedPublication = publication !== null;
    }
    let sourceGenerationRoot = publication
      ? referenceAssetPublicationSourceRoot(workspaceRoot, publication)
      : null;
    const outcome =
      input.command === 'ensure'
        ? await ensureReferenceAssetPreparation({
            input,
            preparation,
            entry,
            sourceOwner,
            familyViews,
            annotationProductsRequired,
            projectRoot,
            cacheRoot,
            publicationRoot,
            fallbackPublicationRoot,
            workspaceRoot,
            publicationWorkspaceRoot,
            publication,
            inheritedPublication,
            sourceGenerationRoot,
            indexer,
            writerLease,
          })
        : await verifyPublishedReferenceAssetPreparation({
            input,
            preparation,
            entry,
            sourceOwner,
            annotationProductsRequired,
            projectRoot,
            workspaceRoot,
            publication,
            sourceGenerationRoot,
          });
    const result = outcome.result;
    publication = outcome.publication;
    sourceGenerationRoot = outcome.sourceGenerationRoot;
    return {
      command: input.command,
      assemblyId: entry.id,
      manifestPath: preparation?.manifestPath ?? null,
      projectRoot,
      cacheRoot,
      workspaceRoot,
      sourceGenerationRoot,
      publication,
      themeMode: input.themeMode,
      sourceBuildFingerprint,
      durationMs: Date.now() - startedAt,
      ...result,
    };
  } finally {
    await writerLease?.release();
  }
}

async function readReferenceAssetPublication(
  assemblyCacheRoot: string,
  publicationAssemblyRoot: string,
  fallbackPublicationAssemblyRoot: string | null,
  assetCacheKey: string
): Promise<ReferenceAssetPublicationV1 | null> {
  const publicationRoots = [publicationAssemblyRoot, fallbackPublicationAssemblyRoot].filter(
    (root, index, roots): root is string => Boolean(root) && roots.indexOf(root) === index
  );
  for (const publicationRoot of publicationRoots) {
    try {
      const parsed = parseReferenceAssetPublicationV1(
        JSON.parse(
          await readFile(referenceAssetPublicationPath(publicationRoot), 'utf8')
        ) as unknown,
        assetCacheKey
      );
      if (!parsed) continue;
      const sourceRoot = referenceAssetPublicationSourceRoot(assemblyCacheRoot, parsed);
      assertAtOrBelow(assemblyCacheRoot, sourceRoot, 'Published reference source generation');
      return parsed;
    } catch {}
  }
  return null;
}

function newReferenceAssetPublication(assetCacheKey: string): ReferenceAssetPublicationV1 {
  return {
    contract: REFERENCE_ASSET_PUBLICATION_V1,
    assetCacheKey,
    publicationId: randomUUID(),
    sourceMaterializationFingerprint: '0'.repeat(64),
    publishedAtMs: Date.now(),
  };
}

async function preparedSourceMaterializationFingerprint(
  entry: ReferenceAssemblyEntry,
  sourceGenerationRoot: string
): Promise<string> {
  return (await readSourceMaterializationSnapshot(entry, sourceGenerationRoot)).fingerprint;
}

async function readSourceMaterializationSnapshot(
  entry: ReferenceAssemblyEntry,
  sourceGenerationRoot: string
) {
  const receipts: unknown[] = [];
  const receiptsByChrom = new Map<string, unknown>();
  for (const member of entry.members) {
    if (!member.manifest) continue;
    const receiptPath = join(
      dirname(resolve(sourceGenerationRoot, member.manifest.fastaPath)),
      REFERENCE_SOURCE_RECEIPT_FILE
    );
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
    receipts.push(receipt);
    receiptsByChrom.set(member.chrom, receipt);
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        assetCacheKey: entry.assetCacheKey,
        dnaIndexerSchema: DNA_INDEXER_SCHEMA,
        receipts,
      })
    )
    .digest('hex');
  return { fingerprint, receiptsByChrom };
}

async function publishReferenceAssetGeneration(
  assemblyCacheRoot: string,
  publicationAssemblyRoot: string,
  publication: ReferenceAssetPublicationV1,
  writerLease: ReferenceAssetWriterLease
): Promise<void> {
  const pointerPath = referenceAssetPublicationPath(publicationAssemblyRoot);
  const temporaryPath = `${pointerPath}.${randomUUID()}.tmp`;
  assertAtOrBelow(publicationAssemblyRoot, pointerPath, 'Reference asset publication pointer');
  assertAtOrBelow(publicationAssemblyRoot, temporaryPath, 'Reference asset publication pointer');
  await mkdir(publicationAssemblyRoot, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(publication, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    try {
      await writerLease.commitPointer(temporaryPath, pointerPath);
    } catch (error) {
      const committed = await readReferenceAssetPublication(
        assemblyCacheRoot,
        publicationAssemblyRoot,
        null,
        publication.assetCacheKey
      );
      if (!committed || !sameReferenceAssetPublication(committed, publication)) throw error;
      await writerLease.acceptReconciledCommit();
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function runSourceFirstReferenceGenerationTransaction<TSource, TProducts>(input: {
  readonly prepareSource: () => Promise<TSource>;
  readonly publishSource: (source: TSource) => Promise<void>;
  readonly onSourcePublished?: (source: TSource) => void | Promise<void>;
  readonly prepareProducts: (source: TSource) => Promise<TProducts>;
  readonly discardUnpublishedSource: () => Promise<void>;
}): Promise<Readonly<{ source: TSource; products: TProducts }>> {
  let sourcePublished = false;
  try {
    const source = await input.prepareSource();
    await input.publishSource(source);
    sourcePublished = true;
    await input.onSourcePublished?.(source);
    const products = await input.prepareProducts(source);
    return { source, products };
  } catch (error) {
    if (!sourcePublished) await input.discardUnpublishedSource();
    throw error;
  }
}

function sameReferenceAssetPublication(
  left: ReferenceAssetPublicationV1,
  right: ReferenceAssetPublicationV1
): boolean {
  return (
    left.contract === right.contract &&
    left.assetCacheKey === right.assetCacheKey &&
    left.publicationId === right.publicationId &&
    left.sourceMaterializationFingerprint === right.sourceMaterializationFingerprint &&
    left.publishedAtMs === right.publishedAtMs &&
    sameReferenceAssetProductLayout(left.productLayout, right.productLayout)
  );
}

function productLayoutForVerifiedAssetFamily(
  results: PublishedAssetFamilyResults,
  storage:
    | typeof REFERENCE_ASSET_PRODUCT_STORAGE_SHARED_V1
    | typeof REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1
): ReferenceAssetProductLayoutV1 {
  const products: ReferenceAssetRequiredAnnotationProductV1[] = [];
  for (const [assemblyId, themes] of Object.entries(results)) {
    for (const themeMode of PREPARED_THEME_ORDER) {
      const result = themes[themeMode];
      if (!result) continue;
      if (result.status !== 'ready') {
        const detail = result.message ? `${result.reason}: ${result.message}` : result.reason;
        throw new Error(
          `Cannot publish an incomplete reference annotation product family (${assemblyId} ${themeMode}: ${detail}).`
        );
      }
      products.push({
        assemblyId,
        themeMode,
        sourceFingerprint: result.generation.sourceFingerprint,
        inventoryFingerprint: result.generation.inventoryFingerprint,
      });
    }
  }
  return createReferenceAssetProductLayoutV1(products, storage);
}

function productStorageForPublication(
  publication: ReferenceAssetPublicationV1
):
  | typeof REFERENCE_ASSET_PRODUCT_STORAGE_SHARED_V1
  | typeof REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1 {
  return publication.productLayout?.storage === REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1
    ? REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1
    : REFERENCE_ASSET_PRODUCT_STORAGE_SHARED_V1;
}

function sameReferenceAssetProductLayout(
  left: ReferenceAssetProductLayoutV1 | undefined,
  right: ReferenceAssetProductLayoutV1 | undefined
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

async function reserveReferenceAssetGenerationRoot(
  assemblyCacheRoot: string,
  sourceGenerationRoot: string
): Promise<void> {
  const generationsRoot = dirname(sourceGenerationRoot);
  assertAtOrBelow(assemblyCacheRoot, generationsRoot, 'Reference generations directory');
  await mkdir(generationsRoot, { recursive: true });
  await mkdir(sourceGenerationRoot);
}

async function writePreparedReferenceDefinition(
  preparation: LoadedReferencePreparationManifest,
  sourceGenerationRoot: string,
  semantics: ReferenceSemanticsV1 | null
): Promise<void> {
  const path = join(sourceGenerationRoot, PREPARED_REFERENCE_DEFINITION_FILE);
  assertAtOrBelow(sourceGenerationRoot, path, 'Prepared reference definition');
  const base = preparedReferenceDefinition(preparation, preparation.entry);
  if (base.contract === PREPARED_REFERENCE_DEFINITION_V2 && !semantics) {
    throw new Error('Prepared reference definition v3 requires completed semantic maturation.');
  }
  const definition =
    base.contract === PREPARED_REFERENCE_DEFINITION_V2
      ? preparedReferenceDefinitionV3(base, semantics!)
      : base;
  await writeFile(path, `${JSON.stringify(definition, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

async function inspectPreparedReferenceDefinition(
  preparation: LoadedReferencePreparationManifest,
  sourceGenerationRoot: string
): Promise<PreparedSourceInspection> {
  const path = join(sourceGenerationRoot, PREPARED_REFERENCE_DEFINITION_FILE);
  assertAtOrBelow(sourceGenerationRoot, path, 'Prepared reference definition');
  try {
    const actual = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const expected = preparedReferenceDefinition(preparation, preparation.entry);
    const parsed = parsePreparedReferenceDefinition(actual, preparation.entry.assetCacheKey);
    const comparableActual =
      parsed.contract === PREPARED_REFERENCE_DEFINITION_V3
        ? preparedDefinitionV2Projection(parsed)
        : parsed;
    const contractMatches =
      expected.contract === PREPARED_REFERENCE_DEFINITION_V2
        ? parsed.contract === PREPARED_REFERENCE_DEFINITION_V3
        : parsed.contract === expected.contract;
    return contractMatches && canonicalJson(comparableActual) === canonicalJson(expected)
      ? { status: 'ready' }
      : {
          status: 'stale',
          message: 'Prepared reference definition does not match its input manifest.',
        };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'stale',
      message: `Prepared reference definition is unavailable: ${detail}`,
    };
  }
}

function preparedDefinitionV2Projection(
  definition: ReturnType<typeof parsePreparedReferenceDefinition> & {
    contract: typeof PREPARED_REFERENCE_DEFINITION_V3;
  }
) {
  const {
    semantics: _semantics,
    semanticDigestSha256: _semanticDigestSha256,
    ...base
  } = definition;
  return {
    ...base,
    contract: PREPARED_REFERENCE_DEFINITION_V2,
    pipelineRevision: 2 as const,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const PREPARED_THEME_ORDER = ['light', 'dark'] as const;

function preparedThemesFor(input: {
  readonly preparedThemes?: readonly ('light' | 'dark')[];
}): readonly ('light' | 'dark')[] {
  return input.preparedThemes?.includes('dark')
    ? PREPARED_THEME_ORDER
    : [INDEXED_ANNOTATION_COLOR_BASIS_THEME];
}

function resultTheme(input: {
  readonly themeMode: 'light' | 'dark';
  readonly preparedThemes?: readonly ('light' | 'dark')[];
}): 'light' | 'dark' {
  return preparedThemesFor(input).includes(input.themeMode)
    ? input.themeMode
    : INDEXED_ANNOTATION_COLOR_BASIS_THEME;
}

type PublishedThemeResults = Readonly<{
  light: AssemblyReferenceAssetStatusV1;
  dark?: AssemblyReferenceAssetStatusV1;
}>;

function publishedThemeResults(
  themes: readonly ('light' | 'dark')[],
  statuses: readonly AssemblyReferenceAssetStatusV1[]
): PublishedThemeResults {
  const byTheme = new Map(themes.map((themeMode, index) => [themeMode, statuses[index]]));
  const light = byTheme.get('light');
  if (!light) throw new Error('Prepared reference products omit the light colour basis.');
  const dark = byTheme.get('dark');
  return dark ? { light, dark } : { light };
}

function sourceComparableReferenceEntry(entry: ReferenceAssemblyEntry): ReferenceAssemblyEntry {
  const {
    referenceVersionHistory: _referenceVersionHistory,
    portableView: _portableView,
    ...sourceEntry
  } = entry;
  return {
    ...sourceEntry,
    members: entry.members.map(
      ({ cytobandId: _cytobandId, morphology: _morphology, ...member }) => member
    ),
  };
}

type PublishedAssetFamilyResults = Readonly<Record<string, PublishedThemeResults>>;

function referenceEntryHasAnnotationProducts(entry: ReferenceAssemblyEntry): boolean {
  let annotationMemberCount = 0;
  for (const member of entry.members) {
    if (!member.manifest) continue;
    const hasGff = Boolean(member.manifest.gffPath);
    const hasTbi = Boolean(member.manifest.tbiPath);
    if (hasGff !== hasTbi) {
      throw new Error(
        `Prepared reference member ${member.chrom} has an incomplete annotation index pair.`
      );
    }
    if (hasGff) annotationMemberCount += 1;
  }
  return annotationMemberCount > 0;
}

function sourceOnlyPreparationReady(
  entry: ReferenceAssemblyEntry
): Extract<ReferenceAssetPreparationResult, { status: 'source-ready' }> {
  return {
    status: 'source-ready',
    message: `${entry.name} sequence is ready; this reference has no annotation source.`,
  };
}

async function inspectPublishedAssetFamily(input: {
  publication: ReferenceAssetPublicationV1;
  sourceOwner: ReferenceAssemblyEntry;
  familyViews: ReadonlyArray<ReferenceAssemblyEntry>;
  projectRoot: string;
  workspaceRoot: string;
  sourceGenerationRoot: string;
  sourceBuildFingerprint: string;
  report?: (message: string) => void;
  runCompilersDirectly: boolean;
  preparedThemes?: readonly ('light' | 'dark')[];
}): Promise<PublishedAssetFamilyResults | null> {
  const preparedSources = await inspectPublishedReferenceSources(
    input.publication,
    input.sourceOwner,
    input.projectRoot,
    input.sourceGenerationRoot
  );
  if (preparedSources.status === 'stale') return null;
  const results: Record<string, PublishedThemeResults> = {};
  for (const entry of input.familyViews) {
    const themes = preparedThemesFor(input);
    results[entry.id] = publishedThemeResults(
      themes,
      await Promise.all(
        themes.map((themeMode) =>
          runReferenceAssetLifecycle({
            ...input,
            sourceMaterializationFingerprint: input.publication.sourceMaterializationFingerprint,
            entry,
            themeMode,
            command: 'status',
          })
        )
      )
    );
  }
  return results;
}

async function inspectPublishedReferenceSources(
  publication: ReferenceAssetPublicationV1,
  sourceOwner: ReferenceAssemblyEntry,
  projectRoot: string,
  sourceGenerationRoot: string
): Promise<PreparedSourceInspection> {
  const prepared = await inspectPreparedReferenceSources(
    sourceOwner,
    projectRoot,
    sourceGenerationRoot
  );
  if (prepared.status === 'stale') return prepared;
  const fingerprint = await preparedSourceMaterializationFingerprint(
    sourceOwner,
    sourceGenerationRoot
  );
  return fingerprint === publication.sourceMaterializationFingerprint
    ? { status: 'ready' }
    : {
        status: 'stale',
        message: 'Published source materialization fingerprint does not match its pointer.',
      };
}

async function buildAndVerifyPublishedAssetFamily(input: {
  familyViews: ReadonlyArray<ReferenceAssemblyEntry>;
  workspaceRoot: string;
  sourceGenerationRoot: string;
  sourceMaterializationFingerprint?: string;
  sourceBuildFingerprint: string;
  report?: (message: string) => void;
  runCompilersDirectly: boolean;
  preparedThemes?: readonly ('light' | 'dark')[];
}): Promise<PublishedAssetFamilyResults> {
  const results: Record<string, PublishedThemeResults> = {};
  for (const entry of input.familyViews) {
    const searchReadiness = await prepareThemeIndependentReferenceAssets({
      ...input,
      entry,
      themeMode: 'light',
    });
    const trackInventories: NonNullable<AssemblyReferenceAssetRuntimeV1['trackInventories']> =
      new Map();
    const themes = preparedThemesFor(input);
    const statuses = await Promise.all(
      themes.map(async (themeMode) => {
        let builtNow = false;
        const ensured = await runReferenceAssetLifecycle({
          ...input,
          entry,
          themeMode,
          searchReadiness,
          trackInventories,
          onPhase: (phase) => {
            if (phase === 'preparing-products') builtNow = true;
          },
          command: 'ensure',
        });
        if (builtNow) return ensured;
        return ensured.status === 'ready'
          ? runReferenceAssetLifecycle({
              ...input,
              entry,
              themeMode,
              searchReadiness,
              command: 'verify',
            })
          : ensured;
      })
    );
    results[entry.id] = publishedThemeResults(themes, statuses);
  }
  return results;
}

function publishedAssetFamilyIsReady(results: PublishedAssetFamilyResults): boolean {
  const views = Object.values(results);
  return (
    views.length > 0 &&
    views.every((themes) => Object.values(themes).every((result) => result?.status === 'ready'))
  );
}

function firstUnreadyPublishedAssetResult(
  results: PublishedAssetFamilyResults
): AssemblyReferenceAssetStatusV1 | null {
  for (const themes of Object.values(results)) {
    for (const result of Object.values(themes)) {
      if (result && result.status !== 'ready') return result;
    }
  }
  return null;
}

function resultForPublishedAssetFamily(
  results: PublishedAssetFamilyResults,
  requestedEntryId: string,
  themeMode: 'light' | 'dark'
): AssemblyReferenceAssetStatusV1 {
  const requested = results[requestedEntryId];
  if (publishedAssetFamilyIsReady(results) && requested) {
    return requested[themeMode] ?? requested.light;
  }
  return (
    firstUnreadyPublishedAssetResult(results) ?? {
      status: 'needs-refresh',
      reason: 'verification-failed',
      message: `Prepared asset family omitted requested view ${requestedEntryId}.`,
    }
  );
}

interface ReferenceAssetLifecycleInput {
  entry: ReferenceAssemblyEntry;
  workspaceRoot: string;
  sourceGenerationRoot: string;
  sourceMaterializationFingerprint?: string;
  sourceBuildFingerprint: string;
  themeMode: 'light' | 'dark';
  report?: (message: string) => void;
  runCompilersDirectly: boolean;
  searchReadiness?: AssemblyReferenceAssetAuthoritiesV1['searchReadiness'];
  trackInventories?: NonNullable<AssemblyReferenceAssetRuntimeV1['trackInventories']>;
  onPhase?: (phase: string) => void;
}

async function runReferenceAssetLifecycle(
  input: ReferenceAssetLifecycleInput & { command: ReferenceAssetPreparationCommand }
): Promise<AssemblyReferenceAssetStatusV1> {
  const { seed, authorities } = await referenceAssetLifecycleRuntime(input);
  const onProgress = (phase: string) => {
    input.onPhase?.(phase);
    input.report?.(`${input.themeMode}:${phase}`);
  };
  return input.command === 'ensure'
    ? authorities.service.ensure({ seedProduct: seed, onProgress })
    : input.command === 'verify'
      ? authorities.service.verify({ seedProduct: seed, onProgress })
      : authorities.service.status({ seedProduct: seed, onProgress });
}

async function prepareThemeIndependentReferenceAssets(
  input: ReferenceAssetLifecycleInput
): Promise<AssemblyReferenceAssetAuthoritiesV1['searchReadiness']> {
  const { seed, authorities, ensureSourceSummaries } = await referenceAssetLifecycleRuntime(input);
  const status = await authorities.service.status({ seedProduct: seed });
  if (status.status === 'ready') return authorities.searchReadiness;
  authorities.searchReadiness.ensure(seed).catch(() => undefined);
  await ensureSourceSummaries(seed);
  return authorities.searchReadiness;
}

async function referenceAssetLifecycleRuntime(input: ReferenceAssetLifecycleInput) {
  const assembly = buildGenomeAssembly(input.entry, (path) =>
    resolve(input.sourceGenerationRoot, path)
  );
  const source = assemblyAnnotationSourceRequest(assembly, input.workspaceRoot);
  if (!source) {
    throw new Error(`Assembly ${input.entry.id} has no annotation-bearing source manifest.`);
  }
  const seed = (
    await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      request: {
        ...source,
        scope: assemblyAnnotationSceneScopeForRequest('complete-assembly', source.chromosomes),
      },
      themeMode: input.themeMode,
      policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 2 },
    })
  ).request;
  const assertSafePath = async (candidate: string): Promise<void> => {
    assertAtOrBelow(input.workspaceRoot, resolve(candidate), 'Reference asset path');
  };
  const readPreparedOverviewCaches: typeof readAssemblyOverviewCaches = (request, deps) =>
    readAssemblyOverviewCaches(request, {
      assertSafePath: deps.assertSafePath,
      readCachedOverview: async (manifest) => {
        const tile = await getCachedAnnotationOverviewTile({
          manifest,
          deps: {
            mkdir,
            realpath,
            stat,
            readFile: (path) => readFile(path, 'utf8'),
            writeFile: (path, content) => writeFile(path, content, 'utf8'),
            rename,
            unlink,
            sourceBuildFingerprint: input.sourceBuildFingerprint,
          },
        });
        return tile ? { features: tile.features, layerTypes: tile.layerTypes } : null;
      },
    });
  const directCompilerRuntime = input.runCompilersDirectly
    ? {
        compileScene: async (
          job: Parameters<
            NonNullable<
              Parameters<typeof createAssemblyReferenceAssetAuthoritiesV1>[0]['compileScene']
            >
          >[0]
        ) => {
          const guard = createAuthorizedExpandedAnnotationSourcePathGuard(
            job.authorizedSourceRealPaths,
            realpath
          );
          return compileAndCommitExpandedAnnotationSceneWorkerJob(job, {
            assertSafePath: guard,
            writeFeaturesCache: writeAssemblyOverviewFeaturesCache,
            readOverviewCaches: readPreparedOverviewCaches,
          });
        },
        compileSceneSet: async (
          job: Parameters<
            NonNullable<
              Parameters<typeof createAssemblyReferenceAssetAuthoritiesV1>[0]['compileSceneSet']
            >
          >[0]
        ) => {
          const first = job.jobs[0];
          if (!first) throw new Error('Reference asset compiler received an empty product set.');
          const guard = createAuthorizedExpandedAnnotationSourcePathGuard(
            first.authorizedSourceRealPaths,
            realpath
          );
          return compileAndCommitExpandedAnnotationSceneWorkerSetJob(job, {
            assertSafePath: guard,
            writeFeaturesCache: writeAssemblyOverviewFeaturesCache,
            readOverviewCaches: readPreparedOverviewCaches,
          });
        },
        readTrackInventory: async (
          job: Parameters<
            NonNullable<
              Parameters<typeof createAssemblyReferenceAssetAuthoritiesV1>[0]['readTrackInventory']
            >
          >[0]
        ) => {
          const guard = createAuthorizedExpandedAnnotationSourcePathGuard(
            job.authorizedSourceRealPaths,
            realpath
          );
          return readExpandedAnnotationSceneTrackInventoryWorkerJob(job, {
            assertSafePath: guard,
            readOverviewCaches: readPreparedOverviewCaches,
          });
        },
        compileBroadRaster: (
          job: Parameters<
            NonNullable<
              Parameters<typeof createAssemblyReferenceAssetAuthoritiesV1>[0]['compileBroadRaster']
            >
          >[0]
        ) =>
          prepareAssemblyCompiledBroadRasterWorkerJobV1(job, {
            assertAuthorizedScenePath: createAuthorizedCompiledBroadRasterScenePathGuard(
              job.scenePath,
              job.authorizedSceneRealPath
            ),
          }),
        compileAnnotationSearch: async (
          job: Parameters<
            NonNullable<
              Parameters<
                typeof createAssemblyReferenceAssetAuthoritiesV1
              >[0]['compileAnnotationSearch']
            >
          >[0]
        ) => {
          const guard = createAuthorizedExpandedAnnotationSourcePathGuard(
            job.authorizedSourceRealPaths,
            realpath
          );
          return compileAndCommitAssemblyAnnotationSearchWorkerJob(job, {
            assertSafePath: guard,
          });
        },
        compileProteinSearch: async (
          job: Parameters<
            NonNullable<
              Parameters<
                typeof createAssemblyReferenceAssetAuthoritiesV1
              >[0]['compileProteinSearch']
            >
          >[0]
        ) => {
          const guard = createAuthorizedExpandedAnnotationSourcePathGuard(
            job.authorizedSourceRealPaths,
            realpath
          );
          return compileAndCommitAssemblyProteinSearchWorkerJob(job, {
            assertSafePath: guard,
          });
        },
      }
    : {};
  const ensureSourceSummaries = (request: AssemblyAnnotationSceneReadRequest) =>
    ensurePerChromosomeSourceSummaries(
      request,
      assertSafePath,
      input.sourceBuildFingerprint,
      input.report,
      !input.runCompilersDirectly
    );
  const sourceSnapshot = input.sourceMaterializationFingerprint
    ? await readSourceMaterializationSnapshot(input.entry, input.sourceGenerationRoot)
    : null;
  if (sourceSnapshot && sourceSnapshot.fingerprint !== input.sourceMaterializationFingerprint) {
    throw new Error('Published source materialization changed before index admission.');
  }
  const authorities = createAssemblyReferenceAssetAuthoritiesV1({
    assertSafePath,
    sourceBuildFingerprint: input.sourceBuildFingerprint,
    ensureSourceSummaries,
    ...(sourceSnapshot
      ? ({
          verifyPublishedSourceQuartet: async (chrom, paths) => {
            const declared = seed.chromosomes.find(
              (chromosome) => chromosome.chrom === chrom
            )?.manifest;
            if (
              !declared ||
              JSON.stringify(paths) !==
                JSON.stringify([
                  declared.fastaPath,
                  declared.faiPath,
                  declared.gffPath,
                  declared.tbiPath,
                ])
            )
              return false;
            const expectedReceipt = parsePortablePreparedReferenceSourceReceiptV2(
              sourceSnapshot.receiptsByChrom.get(chrom)
            );
            return expectedReceipt
              ? verifyPortableSourceQuartet({
                  chrom,
                  paths,
                  expectedReceipt,
                  assertSafePath,
                })
              : false;
          },
        } satisfies Pick<AssemblyReferenceAssetRuntimeV1, 'verifyPublishedSourceQuartet'>)
      : {}),
    ...directCompilerRuntime,
    ...(input.searchReadiness ? { searchReadiness: input.searchReadiness } : {}),
    ...(input.trackInventories ? { trackInventories: input.trackInventories } : {}),
    onFailure: (error, request) => {
      input.report?.(`${request.artifact.trackType}: ${error.name}: ${error.message}`);
    },
  });
  return { seed, authorities, ensureSourceSummaries };
}

async function ensurePerChromosomeSourceSummaries(
  request: AssemblyAnnotationSceneReadRequest,
  assertSafePath: (path: string) => Promise<void>,
  sourceBuildFingerprint: string,
  report?: (message: string) => void,
  inProcesses = false
): Promise<void> {
  const jobs: ChromosomeSourceSummaryJobV1[] = [];
  for (let index = 0; index < request.chromosomes.length; index += 1) {
    if (request.scope.placements[index]?.annotationCoverage !== 'sourced') continue;
    const chromosome = request.chromosomes[index];
    const manifest = chromosome.manifest as IndexedGenomeManifest | null | undefined;
    if (!manifest?.gffPath || !manifest.tbiPath) {
      throw new Error(`Indexed annotation quartet is unavailable for ${chromosome.chrom}.`);
    }
    for (const path of [manifest.fastaPath, manifest.faiPath, manifest.gffPath, manifest.tbiPath]) {
      await assertSafePath(path);
    }
    jobs.push({
      manifest,
      chrom: chromosome.chrom,
      length: chromosome.length,
      sourceBuildFingerprint,
    });
  }
  if (inProcesses && jobs.length > 1) {
    const { ensureChromosomeSourceSummariesInProcessesV1 } =
      await import('./reference-source-summary-pool');
    await ensureChromosomeSourceSummariesInProcessesV1(jobs, (job) =>
      report?.(`preparing ${job.chrom} source summary`)
    );
    return;
  }
  for (const job of jobs) {
    report?.(`preparing ${job.chrom} source summary`);
    await ensureChromosomeSourceSummaryV1(job);
  }
}

type PreparedSourceInspection =
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'stale'; message: string }>;

async function inspectPreparedReferenceSources(
  entry: ReferenceAssemblyEntry,
  projectRoot: string,
  assemblyCacheRoot: string
): Promise<PreparedSourceInspection> {
  for (const member of entry.members) {
    if (!member.importSource || !member.manifest) continue;
    const inspection = await inspectPreparedReferenceSource(member, projectRoot, assemblyCacheRoot);
    if (inspection.status === 'stale') return inspection;
  }
  return { status: 'ready' };
}

async function inspectCommittedPreparedReferenceSources(
  entry: ReferenceAssemblyEntry,
  assemblyCacheRoot: string
): Promise<PreparedSourceInspection> {
  for (const member of entry.members) {
    if (!member.manifest) {
      return { status: 'stale', message: `${member.chrom} has no prepared source manifest.` };
    }
    const inspection = await inspectPreparedReferenceSourceMaterialization(
      member,
      assemblyCacheRoot
    );
    if (inspection.status === 'stale') return inspection;
  }
  return { status: 'ready' };
}

async function inspectPreparedReferenceSource(
  member: ReferenceAssemblyMember,
  projectRoot: string,
  assemblyCacheRoot: string
): Promise<PreparedSourceInspection> {
  if (!member.importSource || !member.manifest) {
    return { status: 'stale', message: `${member.chrom} has no import source or manifest.` };
  }
  const sourcePaths: PreparedSourcePaths = {
    fasta: resolve(projectRoot, member.importSource.fastaPath),
    ...(member.importSource.gffPath
      ? { gff: resolve(projectRoot, member.importSource.gffPath) }
      : {}),
  };
  return inspectPreparedReferenceSourceMaterialization(member, assemblyCacheRoot, sourcePaths);
}

async function inspectPreparedReferenceSourceMaterialization(
  member: ReferenceAssemblyMember,
  assemblyCacheRoot: string,
  sourcePaths?: PreparedSourcePaths
): Promise<PreparedSourceInspection> {
  if (!member.manifest) {
    return { status: 'stale', message: `${member.chrom} has no prepared source manifest.` };
  }
  const hasGff = Boolean(member.manifest.gffPath);
  const hasTbi = Boolean(member.manifest.tbiPath);
  if (hasGff !== hasTbi) {
    return {
      status: 'stale',
      message: `${member.chrom} has an incomplete prepared annotation index pair.`,
    };
  }
  const annotationPaths =
    member.manifest.gffPath && member.manifest.tbiPath
      ? { gffPath: member.manifest.gffPath, tbiPath: member.manifest.tbiPath }
      : null;
  const hasAnnotations = annotationPaths !== null;
  if (sourcePaths && Boolean(sourcePaths.gff) !== hasAnnotations) {
    return {
      status: 'stale',
      message: `${member.chrom} source and prepared annotation variants do not match.`,
    };
  }
  const outputPaths: PreparedOutputPaths = {
    fasta: resolve(assemblyCacheRoot, member.manifest.fastaPath),
    fai: resolve(assemblyCacheRoot, member.manifest.faiPath),
    ...(member.manifest.fastaPath.toLowerCase().endsWith('.gz')
      ? { gzi: resolve(assemblyCacheRoot, `${member.manifest.fastaPath}.gzi`) }
      : {}),
    ...(annotationPaths
      ? {
          gff: resolve(assemblyCacheRoot, annotationPaths.gffPath),
          tbi: resolve(assemblyCacheRoot, annotationPaths.tbiPath),
        }
      : {}),
  };
  const receiptPath = join(dirname(outputPaths.fasta), REFERENCE_SOURCE_RECEIPT_FILE);
  try {
    const source: PreparedSourceIdentitySet | null = sourcePaths
      ? {
          fasta: await fileIdentity(sourcePaths.fasta),
          ...(sourcePaths.gff ? { gff: await fileIdentity(sourcePaths.gff) } : {}),
        }
      : null;
    const output: PreparedOutputIdentitySet = {
      fasta: await fileIdentity(outputPaths.fasta),
      fai: await fileIdentity(outputPaths.fai),
      ...(outputPaths.gff && outputPaths.tbi
        ? {
            gff: await fileIdentity(outputPaths.gff),
            tbi: await fileIdentity(outputPaths.tbi),
          }
        : {}),
    };
    const rawReceipt = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
    const portableReceipt = parsePortablePreparedReferenceSourceReceiptV2(rawReceipt);
    const receiptIsReady =
      hasAnnotations && portableReceipt && output.gff && output.tbi
        ? !source &&
          portableReceipt.chrom === member.chrom &&
          sameFileIdentity(portableReceipt.output.fasta.continuity, output.fasta) &&
          sameFileIdentity(portableReceipt.output.fai.continuity, output.fai) &&
          sameFileIdentity(portableReceipt.output.gff.continuity, output.gff) &&
          sameFileIdentity(portableReceipt.output.tbi.continuity, output.tbi)
        : localPreparedSourceReceiptMatches({
            value: rawReceipt,
            chrom: member.chrom,
            source,
            output,
          });
    if (!receiptIsReady) {
      return { status: 'stale', message: `${member.chrom} prepared source receipt is stale.` };
    }
    if (outputPaths.fasta.toLowerCase().endsWith('.gz') && !(await isBgzfFile(outputPaths.fasta))) {
      return { status: 'stale', message: `${member.chrom} prepared FASTA is not BGZF.` };
    }
    if (outputPaths.gff && !(await isBgzfFile(outputPaths.gff))) {
      return { status: 'stale', message: `${member.chrom} prepared GFF is not BGZF.` };
    }
    if (outputPaths.gff && (await readDnaIndexerSchema(outputPaths.gff)) !== DNA_INDEXER_SCHEMA) {
      return {
        status: 'stale',
        message: `${member.chrom} prepared GFF does not use dna-indexer schema ${DNA_INDEXER_SCHEMA}.`,
      };
    }
    const preparedLength = await readPreparedFaiLength(outputPaths.fai, member.chrom);
    if (member.lengthBp !== undefined && preparedLength !== member.lengthBp) {
      return {
        status: 'stale',
        message:
          `${member.chrom} prepared FASTA length ${preparedLength} does not match ` +
          `manifest length ${member.lengthBp}.`,
      };
    }
    return { status: 'ready' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'stale',
      message: `${member.chrom} prepared source is unavailable: ${message}`,
    };
  }
}

async function ensurePreparedReferenceSources(
  entry: ReferenceAssemblyEntry,
  projectRoot: string,
  assemblyCacheRoot: string,
  indexer: Readonly<{ binary: string; version: string }>,
  report?: (message: string) => void
): Promise<void> {
  for (const member of entry.members) {
    if (!member.importSource || !member.manifest) continue;
    const inspection = await inspectPreparedReferenceSource(member, projectRoot, assemblyCacheRoot);
    if (inspection.status === 'ready') continue;
    report?.(`indexing ${member.chrom} with dna-indexer`);
    await materializePreparedReferenceSource(
      member,
      projectRoot,
      assemblyCacheRoot,
      indexer.binary,
      indexer.version
    );
    report?.(`indexed ${member.chrom}`);
  }
}

async function materializePreparedReferenceSource(
  member: ReferenceAssemblyMember,
  projectRoot: string,
  assemblyCacheRoot: string,
  binary: string,
  indexerVersion: string
): Promise<void> {
  if (!member.importSource || !member.manifest) {
    throw new Error(`${member.chrom} has no import source or prepared manifest.`);
  }
  if (!member.importSource.gffPath || !member.manifest.gffPath || !member.manifest.tbiPath) {
    throw new Error(
      `${member.chrom} legacy per-contig preparation requires an annotation source and index pair.`
    );
  }
  const sourcePaths = {
    fasta: resolve(projectRoot, member.importSource.fastaPath),
    gff: resolve(projectRoot, member.importSource.gffPath),
  };
  const gziRel = gziPathForPreparedFasta(member.manifest.fastaPath);
  const outputPaths = {
    fasta: resolve(assemblyCacheRoot, member.manifest.fastaPath),
    fai: resolve(assemblyCacheRoot, member.manifest.faiPath),
    ...(gziRel ? { gzi: resolve(assemblyCacheRoot, gziRel) } : {}),
    gff: resolve(assemblyCacheRoot, member.manifest.gffPath),
    tbi: resolve(assemblyCacheRoot, member.manifest.tbiPath),
  };
  const outputDir = dirname(outputPaths.gff);
  const stagingDir = join(dirname(outputDir), `.${member.chrom}.${randomUUID()}.reference-staging`);
  const staged = {
    fasta: join(stagingDir, `${member.chrom}.fa.gz`),
    fai: join(stagingDir, `${member.chrom}.fa.gz.fai`),
    gzi: join(stagingDir, `${member.chrom}.fa.gz.gzi`),
    gff: join(stagingDir, `${member.chrom}.gff3.gz`),
    tbi: join(stagingDir, `${member.chrom}.${preparedAnnotationIndexSuffix(member.lengthBp ?? 0)}`),
  };
  const receiptPath = join(outputDir, REFERENCE_SOURCE_RECEIPT_FILE);
  const temporaryReceipt = `${receiptPath}.${randomUUID()}.tmp`;
  for (const path of [...Object.values(outputPaths), stagingDir]) {
    assertAtOrBelow(assemblyCacheRoot, path, 'Prepared reference source path');
  }
  try {
    const sourceBefore = {
      fasta: await fileIdentity(sourcePaths.fasta),
      gff: await fileIdentity(sourcePaths.gff),
    };
    await verifyOptionalSha256(
      sourcePaths.fasta,
      member.importSource.fastaSha256,
      `${member.chrom} FASTA`
    );
    await verifyOptionalSha256(
      sourcePaths.gff,
      member.importSource.gffSha256,
      `${member.chrom} GFF3`
    );
    await mkdir(stagingDir, { recursive: true });
    const sourceSeqIdArgs = member.importSource.sourceSeqId
      ? ['--source-seqid', member.importSource.sourceSeqId]
      : [];
    await execDnaIndexerFile(
      binary,
      [
        'ingest-gff3',
        '--in',
        sourcePaths.gff,
        '--in-fasta',
        sourcePaths.fasta,
        ...sourceSeqIdArgs,
        '--out-dir',
        stagingDir,
        '--name',
        member.chrom,
      ],
      DNA_INDEXER_ASSEMBLY_INGEST_TIMEOUT_MS
    );
    const sourceAfter = {
      fasta: await fileIdentity(sourcePaths.fasta),
      gff: await fileIdentity(sourcePaths.gff),
    };
    if (
      !sameFileIdentity(sourceBefore.fasta, sourceAfter.fasta) ||
      !sameFileIdentity(sourceBefore.gff, sourceAfter.gff)
    ) {
      throw new Error(`${member.chrom} import source changed while dna-indexer was running.`);
    }
    for (const path of Object.values(staged)) await fileIdentity(path);
    if (!(await isBgzfFile(staged.fasta)))
      throw new Error(`${member.chrom} FASTA indexer output is not BGZF.`);
    if (!(await isBgzfFile(staged.gff)))
      throw new Error(`${member.chrom} indexer output is not BGZF.`);
    if ((await readDnaIndexerSchema(staged.gff)) !== DNA_INDEXER_SCHEMA) {
      throw new Error(`${member.chrom} indexer output has an incompatible schema.`);
    }
    const preparedLength = await readPreparedFaiLength(staged.fai, member.chrom);
    if (member.lengthBp !== undefined && preparedLength !== member.lengthBp) {
      throw new Error(
        `${member.chrom} FASTA length ${preparedLength} does not match manifest length ${member.lengthBp}.`
      );
    }

    await mkdir(outputDir, { recursive: true });
    await unlink(receiptPath).catch(() => undefined);
    await unlink(outputPaths.tbi).catch(() => undefined);
    await rename(staged.fasta, outputPaths.fasta);
    await rename(staged.fai, outputPaths.fai);
    if (outputPaths.gzi) await rename(staged.gzi, outputPaths.gzi);
    await rename(staged.gff, outputPaths.gff);
    await rename(staged.tbi, outputPaths.tbi);

    const receipt = createLocalPreparedSourceReceipt({
      chrom: member.chrom,
      indexerVersion,
      source: sourceAfter,
      output: {
        fasta: await fileIdentity(outputPaths.fasta),
        fai: await fileIdentity(outputPaths.fai),
        gff: await fileIdentity(outputPaths.gff),
        tbi: await fileIdentity(outputPaths.tbi),
      },
    });
    await writeFile(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryReceipt, receiptPath);
  } finally {
    await unlink(temporaryReceipt).catch(() => undefined);
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function resolveDnaIndexerBinary(
  projectRoot: string,
  explicitBinary?: string
): Promise<string> {
  const explicit = explicitBinary ?? process.env.DNA_INDEXER_PATH;
  if (explicit) {
    await access(explicit, fsConstants.X_OK);
    return resolve(explicit);
  }
  const suffix =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : process.platform === 'darwin' && process.arch === 'x64'
        ? 'x86_64-apple-darwin'
        : process.platform === 'linux' && process.arch === 'x64'
          ? 'x86_64-unknown-linux-musl'
          : process.platform === 'win32' && process.arch === 'x64'
            ? 'x86_64-pc-windows-msvc'
            : null;
  if (!suffix)
    throw new Error(`dna-indexer is unsupported on ${process.platform}/${process.arch}.`);
  const helperName = `dna-indexer-${suffix}${process.platform === 'win32' ? '.exe' : ''}`;
  const candidates = [
    ...(process.env.DNAFORGE_HELPERS_DIR
      ? [resolve(process.env.DNAFORGE_HELPERS_DIR, helperName)]
      : []),
    resolve(projectRoot, 'apps/desktop/resources/helpers', helperName),
    resolve(
      projectRoot,
      'target/release',
      `dna-indexer${process.platform === 'win32' ? '.exe' : ''}`
    ),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`dna-indexer executable not found. Searched: ${candidates.join(', ')}`);
}

async function requireCompatibleDnaIndexer(binary: string): Promise<string> {
  const { stdout } = await execDnaIndexerFile(binary, ['--version'], 5_000);
  const version = stdout.trim();
  if (!new RegExp(`\\bschema ${DNA_INDEXER_SCHEMA}\\b`).test(version)) {
    throw new Error(`Incompatible dna-indexer: ${version || 'missing version output'}`);
  }
  return version;
}
