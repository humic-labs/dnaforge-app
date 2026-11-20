import {
  inspectInstalledHostedReference,
  readReferenceVersionHistory,
  recordReferenceVersionIdentity,
} from './installed-hosted-reference';
import { referenceContentIdentity } from './reference-content-identity';
import { REFERENCE_PREPARATION_PIPELINE_REVISION } from './reference-preparation-manifest';
import { createHash, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  HostedReferenceCatalogEntryV1,
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetHostedPreparationStatusV1,
  ReferenceAssetInstallHostedResultV1,
  ReferenceAssetPreparationProgressUpdateV1,
  ReferenceAssetThemeModeV1,
} from '../../shared/reference-assets-ipc';
import {
  referenceAssemblyCacheRoot,
  type ReferenceAssemblyMember,
} from '../../features/sequence/reference-catalog';
import { referenceAssetPublicationPath } from '../../features/sequence/reference-asset-publication';
import {
  DEFAULT_HOSTED_REFERENCE_ASSET_BASE_URL,
  HOSTED_REFERENCE_CATALOG_V1,
  hostedReferenceCatalogEntryV1,
  type HostedReferenceCatalogDefinitionV1,
  type HostedReferenceSourceAssetV1,
} from './hosted-reference-catalog';
import {
  createPortablePreparedReferenceHydrator,
  writeFileHandleCompletely,
  type PortablePreparedReferenceHydrator,
  type PortablePreparedReferenceHydrationResult,
  type PortablePreparedReferenceHydrationProgress,
  type PortablePreparedReferenceTransferEvent,
} from './portable-prepared-reference-hydrator';
import {
  portablePreparedReferenceViewAuthorityV1,
  type PortablePreparedReferenceViewAdmissionProjectionV1,
} from './portable-prepared-reference-view-authority';
import {
  requestHostedReferenceAsset,
  resolveHostedReferenceAssetUrl,
  type HostedReferenceFetch,
  validateHostedReferenceAssetBaseUrl,
} from './hosted-reference-transport';
import { listPreparedReferenceAssemblyEntries } from './prepared-reference-library';
import {
  parsePreparedReferenceDefinition,
  parseHostedReferencePreparationManifestV2,
  preparedReferenceAssemblyEntry,
  REFERENCE_ASSEMBLY_IDENTITY_V2,
  REFERENCE_PREPARATION_MANIFEST_V2,
  referenceAssemblyIdentitySha256V2,
} from './reference-preparation-manifest';
import { inspectLocalReferenceSources } from './local-reference-source-plan';
import {
  inspectPreparedReferenceAssetPublication,
  inspectPreparedReferenceSourcePublication,
  runReferenceAssetPreparation,
  type PreparedReferenceSourcePublicationStatusV1,
  type ReferenceAssetPreparationInput,
  type ReferenceAssetPreparationReceipt,
} from './reference-preparation-engine';
import {
  acquireReferenceAssetWriterLock,
  type ReferenceAssetWriterLease,
} from './reference-asset-writer-lock';
import {
  publishPortablePreparedReferenceSourceGenerationV1,
  type PublishPortablePreparedReferenceSourceInput,
} from './portable-prepared-reference-source-publication';
import {
  hasHostedReferenceSemanticDispositionV1,
  matureHostedReferenceSemanticsV1,
} from './reference-semantic-source-catalog';
import { PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RULES_V1 } from './portable-prepared-reference-view-admission-receipt';
import {
  beginHostedReferenceInstallObservation,
  type HostedReferenceInstallObserver,
} from './hosted-reference-install-telemetry';

const SAFE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class PortablePreparedViewAdmissionError extends Error {
  readonly originalError: unknown;

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'PortablePreparedViewAdmissionError';
    this.originalError = error;
  }
}

export interface HostedReferenceAssetAuthority {
  listHosted(): Promise<ReadonlyArray<HostedReferenceCatalogEntryV1>>;
  getHostedPreparationStatus(input: {
    readonly catalogId: string;
    readonly themeMode: ReferenceAssetThemeModeV1;
  }): Promise<ReferenceAssetHostedPreparationStatusV1 | null>;
  openHosted(input: {
    readonly catalogId: string;
    readonly themeMode: ReferenceAssetThemeModeV1;
    readonly onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }): Promise<ReferenceAssetInstallHostedResultV1>;
  installHosted(input: {
    readonly catalogId: string;
    readonly themeMode: ReferenceAssetThemeModeV1;
    readonly onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }): Promise<PreparedReferenceAssemblyEntryV1>;
}

export type HostedReferencePreparationResult = ReferenceAssetPreparationReceipt;

export type HostedReferencePreparationRunner = (
  input: ReferenceAssetPreparationInput
) => Promise<HostedReferencePreparationResult>;

export type HostedReferenceReadinessInspector = (input: {
  readonly entry: PreparedReferenceAssemblyEntryV1;
  readonly cacheRoot: string;
  readonly publicationRoot?: string;
  readonly fallbackPublicationRoot?: string | null;
  readonly sourceBuildFingerprint: string;
  readonly themeMode: ReferenceAssetThemeModeV1;
  readonly expectedSource: Readonly<{
    fastaSha256: string;
    gffSha256: string;
  }>;
}) => Promise<Readonly<{ status: string }>>;

export type HostedReferenceSourceReadinessInspector = (input: {
  readonly entry: PreparedReferenceAssemblyEntryV1;
  readonly cacheRoot: string;
  readonly publicationRoot?: string;
  readonly fallbackPublicationRoot?: string | null;
  readonly expectedSource: Readonly<{
    fastaSha256: string;
    gffSha256: string;
  }>;
}) => Promise<PreparedReferenceSourcePublicationStatusV1>;

export type HostedPreparedBundleHydrator = (input: {
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly tiers: readonly ('detail' | 'search')[];
  readonly onProgress: (progress: PortablePreparedReferenceHydrationProgress) => void;
}) => Promise<PortablePreparedReferenceHydrationResult>;

export type HostedPreparedSourcePublisher = (
  input: PublishPortablePreparedReferenceSourceInput
) => Promise<PreparedReferenceAssemblyEntryV1>;

type HostedReferenceDestinationFile = Pick<FileHandle, 'write' | 'sync' | 'close'>;

export interface CreateHostedReferenceAssetAuthorityInput {
  readonly cacheRoot: string;
  readonly publicationRoot?: string;
  readonly fallbackPublicationRoot?: string | null;
  readonly projectRoot: string;
  readonly sourceBuildFingerprint: string;
  readonly indexerBinary: string;
  readonly assetBaseUrl?: string;
  readonly allowLoopbackHttpForTests?: boolean;
  readonly catalog?: ReadonlyArray<HostedReferenceCatalogDefinitionV1>;
  readonly fetchAsset?: HostedReferenceFetch;
  readonly openDestinationFile?: (
    path: string,
    flags: 'wx',
    mode: number
  ) => Promise<HostedReferenceDestinationFile>;
  readonly runPreparation?: HostedReferencePreparationRunner;
  readonly inspectPrepared?: HostedReferenceReadinessInspector;
  readonly inspectSourcePublication?: HostedReferenceSourceReadinessInspector;
  readonly hydratePreparedBundle?: HostedPreparedBundleHydrator;
  readonly inspectCachedPreparedBundle?: PortablePreparedReferenceHydrator['inspectCached'];
  readonly acquireWriterLease?: (
    assemblyCacheRoot: string,
    helper: string
  ) => Promise<ReferenceAssetWriterLease>;
  readonly publishPreparedSource?: HostedPreparedSourcePublisher;
  readonly hydratePreparedView?: (input: {
    readonly definition: HostedReferenceCatalogDefinitionV1;
    readonly onProgress: (progress: PortablePreparedReferenceHydrationProgress) => void;
  }) => Promise<PortablePreparedReferenceHydrationResult>;
  readonly admitPreparedView?: (input: {
    readonly definition: HostedReferenceCatalogDefinitionV1;
    readonly familyRoot: string;
    readonly hydration: PortablePreparedReferenceHydrationResult;
    readonly hydrator: ReturnType<typeof createPortablePreparedReferenceHydrator>;
  }) => Promise<PortablePreparedReferenceViewAdmissionProjectionV1>;
  readonly listPrepared?: (
    cacheRoot: string,
    publicationRoot?: string,
    fallbackPublicationRoot?: string | null
  ) => Promise<ReadonlyArray<PreparedReferenceAssemblyEntryV1>>;
  readonly createOperationId?: () => string;
  readonly inspectInstalledVersion?: typeof inspectInstalledHostedReference;
  readonly retainInstalledGeneration?: (root: string) => Promise<() => void>;
  readonly collectSupersededVersions?: () => Promise<unknown>;
  readonly observeInstall?: HostedReferenceInstallObserver;
}

function logPortableReferenceTransfer(event: PortablePreparedReferenceTransferEvent): void {
  console.info(`[hosted-reference-transfer] ${JSON.stringify(event)}`);
}

export function createHostedReferenceAssetAuthority(
  input: CreateHostedReferenceAssetAuthorityInput
): HostedReferenceAssetAuthority {
  const cacheRoot = resolve(input.cacheRoot);
  const publicationRoot = resolve(input.publicationRoot ?? cacheRoot);
  const fallbackPublicationRoot = input.fallbackPublicationRoot
    ? resolve(input.fallbackPublicationRoot)
    : null;
  const catalog = input.catalog ?? HOSTED_REFERENCE_CATALOG_V1;
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  if (catalogById.size !== catalog.length) {
    throw new Error('Hosted reference catalog IDs must be unique.');
  }
  const assetBaseUrl = validateHostedReferenceAssetBaseUrl(
    input.assetBaseUrl ?? DEFAULT_HOSTED_REFERENCE_ASSET_BASE_URL,
    input.allowLoopbackHttpForTests ?? false
  );
  const fetchAsset = input.fetchAsset ?? globalThis.fetch;
  const openDestinationFile = input.openDestinationFile ?? open;
  const runPreparation = input.runPreparation ?? runReferenceAssetPreparation;
  const inspectPrepared = input.inspectPrepared ?? inspectPreparedReferenceAssetPublication;
  const inspectSourcePublication =
    input.inspectSourcePublication ?? inspectPreparedReferenceSourcePublication;
  const listPrepared = input.listPrepared ?? listPreparedReferenceAssemblyEntries;
  const listPreparedForProfile = (): Promise<ReadonlyArray<PreparedReferenceAssemblyEntryV1>> =>
    listPrepared(cacheRoot, publicationRoot, fallbackPublicationRoot);
  const createOperationId = input.createOperationId ?? randomUUID;
  const acquireWriterLease = input.acquireWriterLease ?? acquireReferenceAssetWriterLock;
  const publishPreparedSource =
    input.publishPreparedSource ?? publishPortablePreparedReferenceSourceGenerationV1;
  const portableHydrator = createPortablePreparedReferenceHydrator({
    cacheRoot,
    assetBaseUrl,
    fetchAsset,
    instrumentation: {
      onContentObjectTransfer(event) {
        if (
          event.outcome === 'cache-hit' ||
          (event.outcome === 'success' && event.attempt === 1 && event.resumedFromBytes === 0)
        ) {
          return;
        }
        logPortableReferenceTransfer(event);
      },
    },
  });
  const installedVersions = new Map<
    string,
    Promise<Awaited<ReturnType<typeof inspectInstalledHostedReference>>>
  >();
  const inspectInstalledVersion = input.inspectInstalledVersion ?? inspectInstalledHostedReference;
  const getInstalledVersion = (definition: HostedReferenceCatalogDefinitionV1) => {
    let pending = installedVersions.get(definition.id);
    if (!pending) {
      pending = inspectInstalledVersion({
        cacheRoot,
        publicationRoot,
        fallbackPublicationRoot,
        definition,
        hydrator: portableHydrator,
      }).then(async (previous) => {
        if (!previous) return null;
        const source = await inspectSourcePublication({
          entry: previous.entry,
          cacheRoot,
          publicationRoot,
          fallbackPublicationRoot,
          expectedSource: {
            fastaSha256: previous.expectedSource.fastaSha256,
            gffSha256: previous.expectedSource.gffSha256 ?? '',
          },
        });
        return source.status === 'ready' ? previous : null;
      });
      installedVersions.set(definition.id, pending);
    }
    return pending;
  };
  const hydratePreparedBundle: HostedPreparedBundleHydrator =
    input.hydratePreparedBundle ??
    (async ({ definition, tiers, onProgress }) => {
      const previous = await getInstalledVersion(definition);
      return portableHydrator.hydrate({
        definition,
        tiers,
        onProgress,
        ...(previous ? { reuseSequenceFrom: previous.hydration } : {}),
      });
    });
  const inspectCachedPreparedBundle =
    input.inspectCachedPreparedBundle ?? portableHydrator.inspectCached;
  const hydratePreparedView =
    input.hydratePreparedView ??
    (async ({
      definition,
      onProgress,
    }: {
      definition: HostedReferenceCatalogDefinitionV1;
      onProgress: (progress: PortablePreparedReferenceHydrationProgress) => void;
    }) =>
      portableHydrator.hydrate({
        definition,
        tiers: ['shell', 'view'],
        includeCachedTiers: ['detail', 'search'],
        onProgress,
      }));
  const admitPreparedView =
    input.admitPreparedView ??
    ((admission: {
      definition: HostedReferenceCatalogDefinitionV1;
      familyRoot: string;
      hydration: PortablePreparedReferenceHydrationResult;
      hydrator: ReturnType<typeof createPortablePreparedReferenceHydrator>;
    }) =>
      portablePreparedReferenceViewAuthorityV1.admit({
        ...admission,
        runtimeSourceFingerprint: PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RULES_V1,
      }));
  const withVersionHistory = async (
    entry: PreparedReferenceAssemblyEntryV1,
    definition = catalogById.get(entry.id)
  ): Promise<PreparedReferenceAssemblyEntryV1> => {
    const familyRoot = join(cacheRoot, entry.assetCacheKey);
    const generations = Object.values(entry.portableView?.assetGenerationsByTheme ?? {});
    if (definition && entry.referenceIdentity && generations.length > 0) {
      entry = {
        ...entry,
        referenceIdentity: referenceContentIdentity({
          source: hostedExpectedSource(definition),
          members: definition.contigs,
          pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
          annotationPreparation: generations
            .map(({ themeMode, inventoryFingerprint }) => ({ themeMode, inventoryFingerprint }))
            .sort((a, b) => a.themeMode.localeCompare(b.themeMode)),
        }),
      };
    }
    if (entry.referenceIdentity && entry.portableView && generations.length > 0) {
      await recordReferenceVersionIdentity(familyRoot, {
        ...entry.referenceIdentity,
        bundleFingerprint: entry.portableView.bundleFingerprint,
        assetGenerations: generations.map(({ sourceFingerprint, inventoryFingerprint }) => ({
          sourceFingerprint,
          inventoryFingerprint,
        })),
      });
    }
    const history = await readReferenceVersionHistory(familyRoot);
    return history.length > 0 ? { ...entry, referenceVersionHistory: history } : entry;
  };
  const installedOpenings = new Map<string, Promise<PreparedReferenceAssemblyEntryV1 | null>>();
  const openInstalledVersion = (
    definition: HostedReferenceCatalogDefinitionV1
  ): Promise<PreparedReferenceAssemblyEntryV1 | null> => {
    let pending = installedOpenings.get(definition.id);
    if (!pending) {
      pending = (async () => {
        const previous = await getInstalledVersion(definition);
        if (!previous) return null;
        const source = await inspectSourcePublication({
          entry: previous.entry,
          cacheRoot,
          publicationRoot,
          fallbackPublicationRoot,
          expectedSource: {
            fastaSha256: previous.expectedSource.fastaSha256,
            gffSha256: previous.expectedSource.gffSha256 ?? '',
          },
        });
        if (source.status !== 'ready') return null;
        let admission: PortablePreparedReferenceViewAdmissionProjectionV1;
        try {
          admission = await admitPreparedView({
            definition: previous.definition,
            familyRoot: join(cacheRoot, definition.id),
            hydration: previous.hydration,
            hydrator: portableHydrator,
          });
        } catch (error) {
          if (
            !previous.definition.preparedBundle ||
            !definition.preparedBundle ||
            previous.definition.preparedBundle.manifest.sha256 ===
              definition.preparedBundle.manifest.sha256
          ) {
            throw error;
          }
          return null;
        }
        return withVersionHistory(
          {
            ...hostedReferenceAssemblyEntryV1(previous.definition, previous.entry),
            portableView: portableViewProjectionV1(previous.hydration, admission),
          },
          previous.definition
        );
      })();
      installedOpenings.set(definition.id, pending);
    }
    return pending;
  };
  const backgroundInstalls = new Map<string, Promise<PreparedReferenceAssemblyEntryV1>>();
  const familyInstallTails = new Map<string, Promise<void>>();
  const preparationStatusByInstallKey = new Map<string, ReferenceAssetHostedPreparationStatusV1>();
  const portableViewHydrations = new Map<
    string,
    Promise<
      | Readonly<{ status: 'ready'; entry: PreparedReferenceAssemblyEntryV1 }>
      | Readonly<{ status: 'failed' }>
    >
  >();

  const installKey = (
    definition: HostedReferenceCatalogDefinitionV1,
    themeMode: ReferenceAssetThemeModeV1
  ): string => `${definition.id}\u0000${themeMode}`;
  const preparingStatus = (
    definition: HostedReferenceCatalogDefinitionV1,
    themeMode: ReferenceAssetThemeModeV1,
    progress: ReferenceAssetPreparationProgressUpdateV1
  ): ReferenceAssetHostedPreparationStatusV1 => ({
    catalogId: definition.id,
    themeMode,
    status: 'preparing',
    phase: progress.phase,
    label: progress.label,
    updatedAtMs: Date.now(),
  });
  const failedStatus = (
    definition: HostedReferenceCatalogDefinitionV1,
    themeMode: ReferenceAssetThemeModeV1,
    label: string
  ): ReferenceAssetHostedPreparationStatusV1 => ({
    catalogId: definition.id,
    themeMode,
    status: 'failed',
    phase: 'background-preparation-failed',
    label,
    updatedAtMs: Date.now(),
  });
  const readyStatus = async (
    definition: HostedReferenceCatalogDefinitionV1,
    themeMode: ReferenceAssetThemeModeV1,
    entry: PreparedReferenceAssemblyEntryV1,
    knownSourcePublicationId?: string
  ): Promise<Extract<ReferenceAssetHostedPreparationStatusV1, { status: 'ready' }>> => {
    const sourceEntry = hostedReferenceSourceAdmissionEntryV1(entry, definition);
    const source =
      knownSourcePublicationId === undefined
        ? await inspectSourcePublication({
            entry: sourceEntry,
            cacheRoot,
            publicationRoot,
            fallbackPublicationRoot,
            expectedSource: hostedExpectedSource(definition),
          })
        : null;
    if (source && source.status !== 'ready') {
      throw new Error(
        source.message ??
          'The complete hosted reference did not have an admitted source publication.'
      );
    }
    const sourcePublicationId =
      knownSourcePublicationId ??
      (source && typeof source.publicationId === 'string' && source.publicationId.length > 0
        ? source.publicationId
        : createHash('sha256').update(JSON.stringify(sourceEntry)).digest('hex'));
    const capabilityGenerationId = createHash('sha256')
      .update(
        JSON.stringify({
          catalogId: definition.id,
          themeMode,
          sourcePublicationId,
          sourceBuildFingerprint: input.sourceBuildFingerprint,
        })
      )
      .digest('hex');
    return {
      catalogId: definition.id,
      themeMode,
      status: 'ready',
      phase: 'ready',
      label: `${definition.name} is ready`,
      updatedAtMs: Date.now(),
      capabilityGenerationId,
      entry: await withVersionHistory(hostedReferenceAssemblyEntryV1(definition, entry)),
    };
  };
  const annotationReadyStatus = async (
    definition: HostedReferenceCatalogDefinitionV1,
    themeMode: ReferenceAssetThemeModeV1,
    entry: PreparedReferenceAssemblyEntryV1,
    sourcePublicationId: string
  ): Promise<ReferenceAssetHostedPreparationStatusV1> => {
    const terminal = await readyStatus(definition, themeMode, entry, sourcePublicationId);
    if (terminal.status !== 'ready') {
      throw new Error('Hosted annotation admission did not produce a ready identity.');
    }
    return {
      ...terminal,
      status: 'annotation-ready',
      phase: 'detail-ready',
      label: `${definition.name} annotations are ready`,
    };
  };

  const getOrStartInstall = (
    definition: HostedReferenceCatalogDefinitionV1,
    themeMode: ReferenceAssetThemeModeV1,
    onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void,
    options: Readonly<{ skipPreparedBundle?: boolean }> = {}
  ): Promise<PreparedReferenceAssemblyEntryV1> => {
    const key = installKey(definition, themeMode);
    const admitted = preparationStatusByInstallKey.get(key);
    if (admitted?.status === 'ready') {
      return Promise.resolve(admitted.entry);
    }
    let pending = backgroundInstalls.get(key);
    if (!pending) {
      const previousFamilyInstall = familyInstallTails.get(definition.id) ?? Promise.resolve();
      let terminalReadyProgress: ReferenceAssetPreparationProgressUpdateV1 | null = null;
      const observation = beginHostedReferenceInstallObservation(input.observeInstall);
      const publishInstallProgress = (
        progress: ReferenceAssetPreparationProgressUpdateV1
      ): void => {
        observation.progress(progress.phase);
        if (progress.phase === 'ready') {
          terminalReadyProgress = progress;
          return;
        }
        const current = preparationStatusByInstallKey.get(key);
        if (current?.status !== 'annotation-ready') {
          preparationStatusByInstallKey.set(key, preparingStatus(definition, themeMode, progress));
        }
        onProgress(progress);
      };
      if (admitted?.status !== 'annotation-ready') {
        preparationStatusByInstallKey.set(
          key,
          preparingStatus(definition, themeMode, {
            phase: 'queued-hosted-reference',
            label: `Waiting to prepare ${definition.name}`,
          })
        );
      }
      pending = previousFamilyInstall
        .then(async () => {
          const previous = await getInstalledVersion(definition);
          observation.previousVersion(Boolean(previous));
          const release = previous
            ? await input.retainInstalledGeneration?.(previous.hydration.generationRoot)
            : undefined;
          try {
            if (previous) await openInstalledVersion(definition);
            if (preparationStatusByInstallKey.get(key)?.status !== 'annotation-ready') {
              preparationStatusByInstallKey.set(
                key,
                preparingStatus(definition, themeMode, {
                  phase: 'resolving-hosted-reference',
                  label: `Checking ${definition.name}`,
                })
              );
            }
            return await installHostedReference(
              definition,
              themeMode,
              publishInstallProgress,
              options.skipPreparedBundle ?? false,
              async (entry, sourcePublicationId) => {
                const status = await annotationReadyStatus(
                  definition,
                  themeMode,
                  entry,
                  sourcePublicationId
                );
                preparationStatusByInstallKey.set(key, status);
                observation.annotationReady();
                onProgress({
                  phase: 'detail-ready',
                  label: status.label,
                  completed: 1,
                  total: 1,
                });
              }
            );
          } finally {
            release?.();
          }
        })
        .then(async (entry) => {
          const status = await readyStatus(definition, themeMode, entry);
          preparationStatusByInstallKey.set(key, status);
          installedVersions.delete(definition.id);
          installedOpenings.delete(definition.id);
          onProgress(
            terminalReadyProgress ?? {
              phase: 'ready',
              label: status.label,
              completed: 1,
              total: 1,
            }
          );
          void input
            .collectSupersededVersions?.()
            .catch((error) => console.warn('[reference-retention]', error));
          observation.ready();
          return status.entry;
        })
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          const current = preparationStatusByInstallKey.get(key);
          observation.failed(current?.phase, current?.status === 'annotation-ready');
          preparationStatusByInstallKey.set(
            key,
            current?.status === 'annotation-ready'
              ? {
                  ...current,
                  updatedAtMs: Date.now(),
                  label: `${definition.name} annotations are ready; search is unavailable: ${detail}`,
                }
              : failedStatus(
                  definition,
                  themeMode,
                  `${definition.name} detail is unavailable: ${detail}`
                )
          );
          throw error;
        })
        .finally(() => {
          if (backgroundInstalls.get(key) === pending) {
            backgroundInstalls.delete(key);
          }
        });
      backgroundInstalls.set(key, pending);
      const familyTail = pending.then(
        () => undefined,
        () => undefined
      );
      familyInstallTails.set(definition.id, familyTail);
      void familyTail.finally(() => {
        if (familyInstallTails.get(definition.id) === familyTail) {
          familyInstallTails.delete(definition.id);
        }
      });
    }
    return pending;
  };

  const startBackgroundInstall = (
    definition: HostedReferenceCatalogDefinitionV1,
    themeMode: ReferenceAssetThemeModeV1,
    onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void,
    options: Readonly<{ skipPreparedBundle?: boolean }> = {}
  ): void => {
    const pending = getOrStartInstall(definition, themeMode, onProgress, options);
    void pending.catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      const current = preparationStatusByInstallKey.get(installKey(definition, themeMode));
      onProgress({
        phase: 'background-preparation-failed',
        label: current?.label ?? `${definition.name} detail is unavailable: ${detail}`,
      });
    });
  };

  const publishHydratedPortableSource = async (
    definition: HostedReferenceCatalogDefinitionV1,
    hydration: PortablePreparedReferenceHydrationResult
  ): Promise<PreparedReferenceAssemblyEntryV1> => {
    const familyRoot = join(cacheRoot, definition.id);
    const writerLease = await acquireWriterLease(familyRoot, input.indexerBinary);
    let publishedEntry: PreparedReferenceAssemblyEntryV1;
    try {
      publishedEntry = await publishPreparedSource({
        cacheRoot,
        ...(publicationRoot === cacheRoot ? {} : { publicationRoot }),
        definition,
        hydration,
        writerLease,
      });
    } finally {
      await writerLease.release();
    }
    const published = (await listPreparedForProfile()).find(
      (candidate) =>
        candidate.id === definition.id &&
        preparedEntryMatchesHostedDefinition(candidate, definition)
    );
    if (!published) {
      throw new Error('The prepared hosted reference was not visible after atomic publication.');
    }
    const sourceReadiness = await inspectSourcePublication({
      entry: published,
      cacheRoot,
      publicationRoot,
      fallbackPublicationRoot,
      expectedSource: hostedExpectedSource(definition),
    });
    if (sourceReadiness.status !== 'ready') {
      throw new Error(
        sourceReadiness.message ??
          'The prepared hosted reference source failed local admission after publication.'
      );
    }
    return publishedEntry;
  };

  async function installHostedReference(
    definition: HostedReferenceCatalogDefinitionV1,
    themeMode: ReferenceAssetThemeModeV1,
    onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void,
    skipPreparedBundle = false,
    onAnnotationReady: (
      entry: PreparedReferenceAssemblyEntryV1,
      sourcePublicationId: string
    ) => Promise<void> = async () => undefined
  ): Promise<PreparedReferenceAssemblyEntryV1> {
    const admitPortableProducts = async (
      hydration: PortablePreparedReferenceHydrationResult
    ): Promise<PortablePreparedReferenceViewAdmissionProjectionV1> => {
      try {
        return await admitPreparedView({
          definition,
          familyRoot: join(cacheRoot, definition.id),
          hydration,
          hydrator: portableHydrator,
        });
      } catch (error) {
        throw new PortablePreparedViewAdmissionError(error);
      }
    };
    const hydrateAndAdmitPortableProducts = async (
      publishDetail: (input: {
        hydration: PortablePreparedReferenceHydrationResult;
        viewAdmission: PortablePreparedReferenceViewAdmissionProjectionV1;
      }) => Promise<void>
    ): Promise<{
      hydration: PortablePreparedReferenceHydrationResult;
      viewAdmission: PortablePreparedReferenceViewAdmissionProjectionV1;
    }> => {
      let hydration = await hydratePreparedBundle({
        definition,
        tiers: ['detail'],
        onProgress: (progress) =>
          onProgress(progressForPortableHydration(definition.name, progress)),
      });
      let viewAdmission = await admitPortableProducts(hydration);
      try {
        await publishDetail({ hydration, viewAdmission });
      } catch (error) {
        throw new PortablePreparedViewAdmissionError(error);
      }
      if (!hydration.hydratedTiers.includes('search')) {
        hydration = await hydratePreparedBundle({
          definition,
          tiers: ['detail', 'search'],
          onProgress: (progress) =>
            onProgress(progressForPortableHydration(definition.name, progress)),
        });
        viewAdmission = await admitPortableProducts(hydration);
        await publishDetail({ hydration, viewAdmission });
      }
      return { hydration, viewAdmission };
    };
    await openInstalledVersion(definition);
    const alreadyPrepared = (await listPreparedForProfile()).find(
      (candidate) => candidate.id === definition.id
    );
    if (alreadyPrepared && preparedEntryMatchesHostedDefinition(alreadyPrepared, definition)) {
      const expectedSource = hostedExpectedSource(definition);
      onProgress({
        phase: 'checking-hosted-reference',
        label: `Checking ${definition.name}`,
      });
      const sourceReadiness = await inspectSourcePublication({
        entry: alreadyPrepared,
        cacheRoot,
        publicationRoot,
        fallbackPublicationRoot,
        expectedSource,
      });
      if (sourceReadiness.status === 'ready') {
        const readiness = await inspectPrepared({
          entry: alreadyPrepared,
          cacheRoot,
          publicationRoot,
          fallbackPublicationRoot,
          sourceBuildFingerprint: input.sourceBuildFingerprint,
          themeMode,
          expectedSource,
        });
        if (readiness.status === 'ready') {
          onProgress({
            phase: 'ready',
            label: `${definition.name} is ready`,
            completed: 1,
            total: 1,
          });
          return alreadyPrepared;
        }
        if (definition.preparedBundle && !skipPreparedBundle) {
          onProgress({
            phase: 'checking-prepared-bundle',
            label: `Validating cached ${definition.name}`,
          });
          let portableProducts: Awaited<ReturnType<typeof hydrateAndAdmitPortableProducts>> | null =
            null;
          let annotationReadyEntry: PreparedReferenceAssemblyEntryV1 | null = null;
          const readAnnotationReadyEntry = (): PreparedReferenceAssemblyEntryV1 | null =>
            annotationReadyEntry;
          try {
            portableProducts = await hydrateAndAdmitPortableProducts(
              async ({ hydration, viewAdmission }) => {
                const sourceAlreadyUsesPortableGeneration =
                  sourceReadiness.publicationId === hydration.bundle.bundleFingerprint &&
                  typeof sourceReadiness.sourceGenerationRoot === 'string' &&
                  resolve(sourceReadiness.sourceGenerationRoot) ===
                    resolve(hydration.generationRoot);
                const sourceEntry = sourceAlreadyUsesPortableGeneration
                  ? alreadyPrepared
                  : await publishHydratedPortableSource(definition, hydration);
                if (!sourceAlreadyUsesPortableGeneration) {
                  onProgress({
                    phase: 'source-published',
                    label: `${definition.name} sequence and coordinates are ready`,
                    completed: 1,
                    total: 1,
                  });
                }
                annotationReadyEntry = {
                  ...sourceEntry,
                  portableView: portableViewProjectionV1(hydration, viewAdmission),
                };
                await onAnnotationReady(annotationReadyEntry, hydration.bundle.bundleFingerprint);
              }
            );
          } catch (error) {
            if (error instanceof PortablePreparedViewAdmissionError) {
              throw error.originalError;
            }
            if (readAnnotationReadyEntry()) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            onProgress({
              phase: 'prepared-bundle-fallback',
              label: `Prepared ${definition.name} was unavailable (${detail}); using local source`,
            });
          }
          if (portableProducts) {
            const { hydration, viewAdmission } = portableProducts;
            const readyEntry = readAnnotationReadyEntry();
            if (!readyEntry) {
              throw new Error('Portable annotation detail was not published before search.');
            }
            onProgress({
              phase: 'ready',
              label: `${definition.name} is ready`,
              completed: 1,
              total: 1,
            });
            return {
              ...readyEntry,
              portableView: portableViewProjectionV1(hydration, viewAdmission),
            };
          }
        }
        onProgress({
          phase: 'preparing-reference-products',
          label: `Preparing ${definition.name} annotations and search`,
        });
        const receipt = await runPreparation({
          command: 'ensure',
          assemblyId: definition.id,
          manifestPath: null,
          publishedEntry: alreadyPrepared,
          expectedPublishedSource: expectedSource,
          projectRoot: input.projectRoot,
          cacheRoot,
          publicationRoot,
          fallbackPublicationRoot,
          themeMode,
          sourceBuildFingerprint: input.sourceBuildFingerprint,
          indexerBinary: input.indexerBinary,
          onProgress: (message) => onProgress(progressForEngineMessage(definition.name, message)),
        });
        if (receipt.status !== 'ready') {
          throw new Error(receipt.message);
        }
        onProgress({
          phase: 'ready',
          label: `${definition.name} is ready`,
          completed: 1,
          total: 1,
        });
        return alreadyPrepared;
      }
    }

    if (definition.preparedBundle && !skipPreparedBundle) {
      onProgress({
        phase: 'checking-prepared-bundle',
        label: `Validating cached ${definition.name}`,
      });
      let portableProducts: Awaited<ReturnType<typeof hydrateAndAdmitPortableProducts>> | null =
        null;
      let annotationReadyEntry: PreparedReferenceAssemblyEntryV1 | null = null;
      const readAnnotationReadyEntry = (): PreparedReferenceAssemblyEntryV1 | null =>
        annotationReadyEntry;
      try {
        portableProducts = await hydrateAndAdmitPortableProducts(
          async ({ hydration, viewAdmission }) => {
            const publishedEntry = await publishHydratedPortableSource(definition, hydration);
            annotationReadyEntry = {
              ...publishedEntry,
              portableView: portableViewProjectionV1(hydration, viewAdmission),
            };
            onProgress({
              phase: 'source-published',
              label: `${definition.name} sequence and coordinates are ready`,
              completed: 1,
              total: 1,
            });
            await onAnnotationReady(annotationReadyEntry, hydration.bundle.bundleFingerprint);
          }
        );
      } catch (error) {
        if (error instanceof PortablePreparedViewAdmissionError) {
          throw error.originalError;
        }
        if (readAnnotationReadyEntry()) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        onProgress({
          phase: 'prepared-bundle-fallback',
          label: `Prepared ${definition.name} was unavailable (${detail}); using source fallback`,
        });
      }
      if (portableProducts) {
        const { hydration, viewAdmission } = portableProducts;
        const readyEntry = readAnnotationReadyEntry();
        if (!readyEntry) {
          throw new Error('Portable annotation detail was not published before search.');
        }
        const hydrated: PreparedReferenceAssemblyEntryV1 = {
          ...readyEntry,
          portableView: portableViewProjectionV1(hydration, viewAdmission),
        };
        onProgress({
          phase: 'ready',
          label: `${definition.name} is ready`,
          completed: 1,
          total: 1,
        });
        return hydrated;
      }
    }

    const operationId = createOperationId();
    if (!SAFE_OPERATION_ID.test(operationId) || operationId === '.' || operationId === '..') {
      throw new Error('Hosted reference operation ID is invalid.');
    }
    const operationRoot = join(publicationRoot, '.hosted-import-staging', operationId);
    const fastaPath = join(operationRoot, 'source.fa');
    const annotationsPath = join(operationRoot, 'annotations.gff3.gz');
    const manifestPath = join(operationRoot, 'reference-preparation.v2.json');

    try {
      await mkdir(join(publicationRoot, '.hosted-import-staging'), {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(operationRoot, { mode: 0o700 });

      const expectedDownloadBytes =
        definition.sources.fasta.byteLength + definition.sources.annotations.byteLength;
      let downloadedBytes = 0;
      onProgress({
        phase: 'downloading-reference',
        label: `Downloading ${definition.name}`,
        completed: 0,
        total: expectedDownloadBytes,
      });
      const reportDownloadedBytes = (additionalBytes: number): void => {
        downloadedBytes += additionalBytes;
        onProgress({
          phase: 'downloading-reference',
          label: `Downloading ${definition.name}`,
          completed: downloadedBytes,
          total: expectedDownloadBytes,
        });
      };

      await downloadHostedSourcesConcurrently({
        assetBaseUrl,
        allowLoopbackHttpForTests: input.allowLoopbackHttpForTests ?? false,
        fetchAsset,
        openDestinationFile,
        downloads: [
          {
            source: definition.sources.fasta,
            destinationPath: fastaPath,
            label: 'FASTA',
          },
          {
            source: definition.sources.annotations,
            destinationPath: annotationsPath,
            label: 'GFF3',
          },
        ],
        onDownloadedBytes: reportDownloadedBytes,
      });

      onProgress({
        phase: 'verifying-download',
        label: `Verified ${definition.name} source files`,
        completed: expectedDownloadBytes,
        total: expectedDownloadBytes,
      });
      const manifest = await hostedPreparationManifest(definition, fastaPath, annotationsPath);
      const hostedManifestAdmission = {
        expectedCatalogId: definition.id,
        expectedFastaSha256: definition.sources.fasta.sha256,
        expectedGffSha256: definition.sources.annotations.sha256,
      };
      parseHostedReferencePreparationManifestV2(manifest, manifestPath, hostedManifestAdmission);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });

      onProgress({
        phase: 'indexing-reference',
        label: `Preparing ${definition.name}`,
      });
      const receipt = await runPreparation({
        command: 'ensure',
        assemblyId: definition.id,
        manifestPath,
        hostedManifestAdmission,
        projectRoot: input.projectRoot,
        cacheRoot,
        publicationRoot,
        fallbackPublicationRoot,
        themeMode,
        sourceBuildFingerprint: input.sourceBuildFingerprint,
        indexerBinary: input.indexerBinary,
        onProgress: (message) => onProgress(progressForEngineMessage(definition.name, message)),
      });
      if (receipt.status !== 'ready') {
        throw new Error(receipt.message);
      }

      onProgress({
        phase: 'verifying-publication',
        label: `Verifying ${definition.name}`,
      });
      const published = await listPreparedForProfile();
      const entry = published.find((candidate) => candidate.id === definition.id);
      if (!entry) {
        throw new Error('The hosted reference was not visible after atomic publication.');
      }
      onProgress({
        phase: 'ready',
        label: `${definition.name} is ready`,
        completed: 1,
        total: 1,
      });
      return entry;
    } finally {
      await rm(operationRoot, { recursive: true, force: true });
    }
  }

  type HostedListingInspection = readonly [
    HostedReferenceCatalogEntryV1['cacheStatus'],
    HostedReferenceCatalogEntryV1['cacheStatusReason']?,
  ];
  const hostedListingInspections = new Map<
    string,
    { key: string; result: Promise<HostedListingInspection> }
  >();
  const publicationPointerIdentity = (
    local: PreparedReferenceAssemblyEntryV1
  ): Promise<readonly (readonly [number, number, number] | null)[]> =>
    Promise.all(
      [publicationRoot ?? cacheRoot, fallbackPublicationRoot]
        .filter((root): root is string => Boolean(root))
        .map((root) =>
          stat(referenceAssetPublicationPath(referenceAssemblyCacheRoot(resolve(root), local)))
            .then((pointer) => [pointer.ino, pointer.size, pointer.mtimeMs] as const)
            .catch(() => null)
        )
    );
  const inspectHostedListing = async (
    definition: HostedReferenceCatalogDefinitionV1,
    local: PreparedReferenceAssemblyEntryV1
  ): Promise<HostedListingInspection> => {
    try {
      const source = await inspectSourcePublication({
        entry: local,
        cacheRoot,
        publicationRoot,
        fallbackPublicationRoot,
        expectedSource: hostedExpectedSource(definition),
      });
      if (source.status !== 'ready') return ['stale', 'local-files-invalid'];
      if (definition.preparedBundle) {
        const cached = await inspectCachedPreparedBundle({
          definition,
          tiers: ['detail', 'search'],
        });
        const complete =
          cached?.hydratedTiers.includes('detail') && cached.hydratedTiers.includes('search');
        return complete ? ['cached'] : ['not-cached', 'prepared-files-incomplete'];
      }
      const products = await Promise.all(
        (['light'] as const).map((themeMode) =>
          inspectPrepared({
            entry: local,
            cacheRoot,
            publicationRoot,
            fallbackPublicationRoot,
            sourceBuildFingerprint: input.sourceBuildFingerprint,
            themeMode,
            expectedSource: hostedExpectedSource(definition),
          })
        )
      );
      return products.every((status) => status.status === 'ready')
        ? ['cached']
        : ['not-cached', 'prepared-files-incomplete'];
    } catch {
      return ['stale', 'local-files-invalid'];
    }
  };

  return {
    async listHosted() {
      const localEntries = await listPreparedForProfile();
      const localById = new Map(localEntries.map((entry) => [entry.id, entry]));
      return Promise.all(
        catalog.map(async (definition) => {
          const catalogEntry = (
            cacheStatus: HostedReferenceCatalogEntryV1['cacheStatus'],
            cacheStatusReason?: HostedReferenceCatalogEntryV1['cacheStatusReason']
          ): HostedReferenceCatalogEntryV1 => {
            const latest = (['light', 'dark'] as const)
              .map((theme) => ({
                key: installKey(definition, theme),
                status: preparationStatusByInstallKey.get(installKey(definition, theme)),
              }))
              .filter((candidate) => candidate.status)
              .sort((a, b) => b.status!.updatedAtMs - a.status!.updatedAtMs)[0];
            const preparation = latest?.status;
            return {
              ...hostedReferenceCatalogEntryV1(definition, cacheStatus),
              ...(cacheStatus !== 'cached' && installed ? { currentVersionAvailable: true } : {}),
              ...(cacheStatusReason ? { cacheStatusReason } : {}),
              ...(cacheStatus !== 'cached' && preparation && preparation.status !== 'ready'
                ? {
                    preparation: {
                      status: preparation.status,
                      phase: preparation.phase,
                      label: preparation.label,
                      active: backgroundInstalls.has(latest.key),
                    },
                  }
                : {}),
            };
          };
          const installed = await getInstalledVersion(definition);
          const local = localById.get(definition.id);
          if (!local) return catalogEntry('not-cached');
          if (!preparedEntryMatchesHostedDefinition(local, definition)) {
            return catalogEntry('stale', 'reference-definition-changed');
          }
          const listingKey = JSON.stringify([local, await publicationPointerIdentity(local)]);
          let listing = hostedListingInspections.get(definition.id);
          if (!listing || listing.key !== listingKey) {
            listing = { key: listingKey, result: inspectHostedListing(definition, local) };
            hostedListingInspections.set(definition.id, listing);
          }
          const [cacheStatus, cacheStatusReason] = await listing.result;
          if (cacheStatus !== 'cached') hostedListingInspections.delete(definition.id);
          return catalogEntry(cacheStatus, cacheStatusReason);
        })
      );
    },

    async getHostedPreparationStatus({ catalogId, themeMode }) {
      const definition = catalogById.get(catalogId);
      if (!definition) {
        throw new Error(`Unknown hosted reference catalog ID: ${catalogId}`);
      }
      const key = installKey(definition, themeMode);
      if (backgroundInstalls.has(key)) {
        return (
          preparationStatusByInstallKey.get(key) ??
          preparingStatus(definition, themeMode, {
            phase: 'resolving-hosted-reference',
            label: `Checking ${definition.name}`,
          })
        );
      }
      const current = preparationStatusByInstallKey.get(key);
      if (current?.status === 'ready' || current?.status === 'annotation-ready') return current;

      const published = (await listPreparedForProfile()).find(
        (candidate) =>
          candidate.id === definition.id &&
          preparedEntryMatchesHostedDefinition(candidate, definition)
      );
      if (published) {
        try {
          const expectedSource = hostedExpectedSource(definition);
          const source = await inspectSourcePublication({
            entry: published,
            cacheRoot,
            publicationRoot,
            fallbackPublicationRoot,
            expectedSource,
          });
          if (source.status === 'ready') {
            const complete = await inspectPrepared({
              entry: published,
              cacheRoot,
              publicationRoot,
              fallbackPublicationRoot,
              sourceBuildFingerprint: input.sourceBuildFingerprint,
              themeMode,
              expectedSource,
            });
            if (complete.status === 'ready') {
              const sourcePublicationId =
                typeof source.publicationId === 'string' && source.publicationId.length > 0
                  ? source.publicationId
                  : createHash('sha256').update(JSON.stringify(published)).digest('hex');
              const status = await readyStatus(
                definition,
                themeMode,
                published,
                sourcePublicationId
              );
              preparationStatusByInstallKey.set(key, status);
              return status;
            }
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const status = failedStatus(
            definition,
            themeMode,
            `${definition.name} readiness could not be checked: ${detail}`
          );
          preparationStatusByInstallKey.set(key, status);
          return status;
        }
      }

      if (current?.status === 'failed') return current;
      preparationStatusByInstallKey.delete(key);
      return null;
    },

    async openHosted({ catalogId, themeMode, onProgress }) {
      const definition = catalogById.get(catalogId);
      if (!definition) {
        throw new Error(`Unknown hosted reference catalog ID: ${catalogId}`);
      }
      const admitted = preparationStatusByInstallKey.get(installKey(definition, themeMode));
      if (admitted?.status === 'ready' || admitted?.status === 'annotation-ready') {
        onProgress({
          phase: 'view-ready',
          label: `${definition.name} visualization is ready`,
          completed: 1,
          total: 1,
        });
        return { status: 'view-ready', entry: admitted.entry };
      }
      const alreadyPublished = (await listPreparedForProfile()).find(
        (candidate) =>
          candidate.id === definition.id &&
          preparedEntryMatchesHostedDefinition(candidate, definition)
      );
      const sourceAdmission = alreadyPublished
        ? await inspectSourcePublication({
            entry: alreadyPublished,
            cacheRoot,
            publicationRoot,
            fallbackPublicationRoot,
            expectedSource: hostedExpectedSource(definition),
          })
        : null;
      const sourceReady = sourceAdmission?.status === 'ready';
      if (alreadyPublished && sourceReady) {
        const complete = await inspectPrepared({
          entry: alreadyPublished,
          cacheRoot,
          publicationRoot,
          fallbackPublicationRoot,
          sourceBuildFingerprint: input.sourceBuildFingerprint,
          themeMode,
          expectedSource: hostedExpectedSource(definition),
        });
        if (complete.status === 'ready') {
          const ready = await readyStatus(definition, themeMode, alreadyPublished);
          preparationStatusByInstallKey.set(installKey(definition, themeMode), ready);
          onProgress({
            phase: 'view-ready',
            label: `${definition.name} cached view is ready`,
            completed: 1,
            total: 1,
          });
          return {
            status: 'view-ready',
            entry: ready.entry,
          };
        }
      }
      const working = await openInstalledVersion(definition);
      if (working) {
        const previous = await getInstalledVersion(definition);
        const isCurrent =
          previous?.definition.preparedBundle?.manifest.sha256 ===
          definition.preparedBundle?.manifest.sha256;
        if (isCurrent && sourceReady && working.portableView?.searchReady) {
          preparationStatusByInstallKey.set(
            installKey(definition, themeMode),
            await readyStatus(definition, themeMode, working)
          );
        } else {
          startBackgroundInstall(definition, themeMode, onProgress);
        }
        onProgress({
          phase: 'view-ready',
          label: `${definition.name} is ready`,
          completed: 1,
          total: 1,
        });
        return {
          status: 'view-ready',
          entry: hostedReferenceAssemblyEntryV1(previous?.definition ?? definition, working),
        };
      }
      if (alreadyPublished && sourceReady && !definition.preparedBundle) {
        startBackgroundInstall(definition, themeMode, onProgress);
        onProgress({
          phase: 'view-ready',
          label: `${definition.name} cached view is ready`,
          completed: 1,
          total: 1,
        });
        return {
          status: 'view-ready',
          entry: hostedReferenceAssemblyEntryV1(definition, alreadyPublished),
        };
      }
      if (definition.preparedBundle) {
        onProgress({
          phase: 'checking-prepared-bundle',
          label: `Validating cached ${definition.name} view`,
        });
        let portableViewHydration = portableViewHydrations.get(definition.id);
        if (!portableViewHydration) {
          portableViewHydration = (async () => {
            try {
              const hydration = await hydratePreparedView({
                definition,
                onProgress: (progress) =>
                  onProgress(progressForPortableHydration(definition.name, progress)),
              });
              const familyRoot = join(cacheRoot, definition.id);
              const viewAdmission = await admitPreparedView({
                definition,
                familyRoot,
                hydration,
                hydrator: portableHydrator,
              });
              const entry = await hostedReferencePortableViewEntryV1(
                definition,
                hydration,
                viewAdmission
              );
              onProgress({
                phase: 'verifying-publication',
                label: `Prepared ${definition.name} view is ready`,
                completed: 1,
                total: 1,
              });
              return { status: 'ready', entry } as const;
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              onProgress({
                phase: 'prepared-bundle-fallback',
                label: `Prepared ${definition.name} view was unavailable (${detail}); using source fallback`,
              });
              startBackgroundInstall(definition, themeMode, onProgress, {
                skipPreparedBundle: true,
              });
              return { status: 'failed' } as const;
            }
          })();
          portableViewHydrations.set(definition.id, portableViewHydration);
        }
        const outcome = await portableViewHydration;
        if (outcome.status === 'ready') {
          const portableView = outcome.entry.portableView;
          if (
            portableView?.searchReady &&
            portableView.assetGenerationsByTheme?.[themeMode] &&
            sourceAdmission?.status === 'ready' &&
            sourceAdmission.publicationId === portableView.bundleFingerprint &&
            resolve(sourceAdmission.sourceGenerationRoot) === resolve(portableView.generationRoot)
          ) {
            preparationStatusByInstallKey.set(
              installKey(definition, themeMode),
              await readyStatus(definition, themeMode, outcome.entry, sourceAdmission.publicationId)
            );
          } else {
            startBackgroundInstall(definition, themeMode, onProgress);
          }
          onProgress({
            phase: 'view-ready',
            label: `${definition.name} visualization is ready`,
            completed: 1,
            total: 1,
          });
          return {
            status: 'view-ready',
            entry:
              alreadyPublished && sourceReady
                ? {
                    ...hostedReferenceAssemblyEntryV1(definition, alreadyPublished),
                    portableView: outcome.entry.portableView,
                  }
                : outcome.entry,
          };
        }
        if (portableViewHydrations.get(definition.id) === portableViewHydration) {
          portableViewHydrations.delete(definition.id);
        }
        return {
          status: 'view-ready',
          entry:
            alreadyPublished && sourceReady
              ? hostedReferenceAssemblyEntryV1(definition, alreadyPublished)
              : hostedReferenceShellEntryV1(definition),
        };
      }
      startBackgroundInstall(definition, themeMode, onProgress);
      onProgress({
        phase: 'view-ready',
        label: `Opening ${definition.name}; sequence, annotations, and search are preparing`,
        completed: 1,
        total: 1,
      });
      return {
        status: 'view-ready',
        entry: hostedReferenceShellEntryV1(definition),
      };
    },

    async installHosted({ catalogId, themeMode, onProgress }) {
      const definition = catalogById.get(catalogId);
      if (!definition) {
        throw new Error(`Unknown hosted reference catalog ID: ${catalogId}`);
      }
      return getOrStartInstall(definition, themeMode, onProgress);
    },
  };
}

async function hostedReferencePortableViewEntryV1(
  definition: HostedReferenceCatalogDefinitionV1,
  hydration: PortablePreparedReferenceHydrationResult,
  viewAdmission: PortablePreparedReferenceViewAdmissionProjectionV1
): Promise<PreparedReferenceAssemblyEntryV1> {
  const definitionObjects = hydration.bundle.objects.filter(
    (object) => object.role === 'prepared-reference-definition'
  );
  if (definitionObjects.length !== 1) {
    throw new Error('Portable prepared-reference shell has no unique definition.');
  }
  const definitionPath = hydration.objectPaths.get(definitionObjects[0].id);
  if (!definitionPath) {
    throw new Error('Portable prepared-reference definition is not hydrated.');
  }
  const prepared = parsePreparedReferenceDefinition(
    JSON.parse(await readFile(definitionPath, 'utf8')) as unknown,
    definition.id
  );
  return hostedReferenceAssemblyEntryV1(definition, {
    ...preparedReferenceAssemblyEntry(prepared),
    portableView: portableViewProjectionV1(hydration, viewAdmission),
  });
}

function portableViewProjectionV1(
  hydration: PortablePreparedReferenceHydrationResult,
  viewAdmission: PortablePreparedReferenceViewAdmissionProjectionV1
): NonNullable<PreparedReferenceAssemblyEntryV1['portableView']> {
  return {
    generationRoot: hydration.generationRoot,
    bundleFingerprint: hydration.bundle.bundleFingerprint,
    trackTypes: viewAdmission.trackTypes,
    ...(viewAdmission.datasetVersion ? { datasetVersion: viewAdmission.datasetVersion } : {}),
    ...(viewAdmission.assetGenerationsByTheme
      ? { assetGenerationsByTheme: viewAdmission.assetGenerationsByTheme }
      : {}),
    ...(viewAdmission.searchReady !== undefined ? { searchReady: viewAdmission.searchReady } : {}),
  };
}

export function hostedReferenceShellEntryV1(
  definition: HostedReferenceCatalogDefinitionV1
): PreparedReferenceAssemblyEntryV1 {
  const morphologyByChrom = hostedMorphologyByChrom(definition);
  return {
    id: definition.id,
    name: definition.name,
    organism: definition.organism,
    taxId: definition.taxId,
    assembly: definition.assembly,
    description: definition.description,
    assetCacheKey: definition.id,
    referenceIdentity: referenceContentIdentity({
      source: hostedExpectedSource(definition),
      members: definition.contigs,
      pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
    }),
    members: definition.contigs.map(
      ({
        sourceSeqId: _sourceSeqId,
        ...contig
      }): PreparedReferenceAssemblyEntryV1['members'][number] => ({
        chrom: contig.chrom,
        displayName: contig.displayName,
        lengthBp: contig.lengthBp,
        role: contig.role,
        aliases: contig.aliases ? { ...contig.aliases } : undefined,
        circular: contig.circular,
        cytobandId: contig.cytobandId,
        morphology: morphologyByChrom.get(contig.chrom),
      })
    ),
  };
}

function hostedReferenceSourceAdmissionEntryV1(
  entry: PreparedReferenceAssemblyEntryV1,
  definition: HostedReferenceCatalogDefinitionV1
): PreparedReferenceAssemblyEntryV1 {
  const { portableView: _portableView, referenceVersionHistory: _history, ...sourceEntry } = entry;
  return entry.referenceIdentity
    ? {
        ...sourceEntry,
        referenceIdentity: referenceContentIdentity({
          source: hostedExpectedSource(definition),
          members: definition.contigs,
          pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
        }),
      }
    : sourceEntry;
}

function hostedReferenceAssemblyEntryV1(
  definition: HostedReferenceCatalogDefinitionV1,
  entry: PreparedReferenceAssemblyEntryV1
): PreparedReferenceAssemblyEntryV1 {
  const membersWithMorphology = entry.members.filter((member) => member.morphology !== undefined);
  if (membersWithMorphology.length > 0 && membersWithMorphology.length !== entry.members.length) {
    throw new Error(
      `Prepared reference ${entry.id} has incomplete chromosome morphology and cannot be admitted.`
    );
  }
  const hasPreparedMorphology = membersWithMorphology.length === entry.members.length;
  const morphologyByChrom = hasPreparedMorphology
    ? new Map<string, ReferenceAssemblyMember['morphology']>()
    : hostedMorphologyByChrom(definition);
  return {
    ...entry,
    members: entry.members.map((member, index) => {
      const { cytobandId: _cachedCytobandId, ...memberWithoutCatalogCytoband } = member;
      const cytobandId = definition.contigs[index]?.cytobandId;
      const morphology = morphologyByChrom.get(member.chrom);
      return {
        ...memberWithoutCatalogCytoband,
        ...(cytobandId ? { cytobandId } : {}),
        ...(morphology ? { morphology } : {}),
      };
    }),
  };
}

function hostedMorphologyByChrom(definition: HostedReferenceCatalogDefinitionV1) {
  if (!hasHostedReferenceSemanticDispositionV1(definition)) {
    return new Map<string, ReferenceAssemblyMember['morphology']>();
  }
  return new Map(
    matureHostedReferenceSemanticsV1(definition).members.map(({ chrom, morphology }) => [
      chrom,
      morphology,
    ])
  );
}

function hostedExpectedSource(
  definition: HostedReferenceCatalogDefinitionV1
): Readonly<{ fastaSha256: string; gffSha256: string }> {
  return {
    fastaSha256: definition.sources.fasta.sha256,
    gffSha256: definition.sources.annotations.sha256,
  };
}

function preparedEntryMatchesHostedDefinition(
  entry: PreparedReferenceAssemblyEntryV1,
  definition: HostedReferenceCatalogDefinitionV1
): boolean {
  if (
    entry.id !== definition.id ||
    entry.assetCacheKey !== definition.id ||
    entry.organism !== definition.organism ||
    entry.taxId !== definition.taxId ||
    entry.assembly !== definition.assembly ||
    entry.members.length !== definition.contigs.length
  ) {
    return false;
  }
  return entry.members.every((member, index) => {
    const contig = definition.contigs[index];
    return Boolean(
      contig &&
      member.chrom === contig.chrom &&
      member.displayName === contig.displayName &&
      member.lengthBp === contig.lengthBp &&
      member.role === contig.role &&
      member.circular === contig.circular &&
      JSON.stringify(member.aliases ?? {}) === JSON.stringify(contig.aliases ?? {})
    );
  });
}

async function downloadHostedSourcesConcurrently(input: {
  readonly assetBaseUrl: URL;
  readonly allowLoopbackHttpForTests: boolean;
  readonly fetchAsset: HostedReferenceFetch;
  readonly openDestinationFile: (
    path: string,
    flags: 'wx',
    mode: number
  ) => Promise<HostedReferenceDestinationFile>;
  readonly downloads: ReadonlyArray<{
    readonly source: HostedReferenceSourceAssetV1;
    readonly destinationPath: string;
    readonly label: string;
  }>;
  readonly onDownloadedBytes: (bytes: number) => void;
}): Promise<void> {
  const abortController = new AbortController();
  const downloads = input.downloads.map(async (download) => {
    try {
      await streamHostedSourceToFile({
        url: resolveHostedReferenceAssetUrl(input.assetBaseUrl, download.source.relativePath),
        source: download.source,
        destinationPath: download.destinationPath,
        label: download.label,
        fetchAsset: input.fetchAsset,
        openDestinationFile: input.openDestinationFile,
        signal: abortController.signal,
        onDownloadedBytes: input.onDownloadedBytes,
      });
    } catch (error) {
      abortController.abort(error);
    }
  });
  await Promise.all(downloads);
  abortController.signal.throwIfAborted();
}

async function streamHostedSourceToFile(input: {
  readonly url: URL;
  readonly source: HostedReferenceSourceAssetV1;
  readonly destinationPath: string;
  readonly label: string;
  readonly fetchAsset: HostedReferenceFetch;
  readonly openDestinationFile: (
    path: string,
    flags: 'wx',
    mode: number
  ) => Promise<HostedReferenceDestinationFile>;
  readonly signal: AbortSignal;
  readonly onDownloadedBytes: (bytes: number) => void;
}): Promise<void> {
  const response = await requestHostedReferenceAsset({
    url: input.url,
    label: input.label,
    fetchAsset: input.fetchAsset,
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Could not download hosted ${input.label}: HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error(`Could not download hosted ${input.label}: response body was empty.`);
  }

  const hash = createHash('sha256');
  let byteLength = 0;
  const destination = await input.openDestinationFile(input.destinationPath, 'wx', 0o600);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (input.signal.aborted) {
        throw new Error(`Could not download hosted ${input.label}: download was cancelled.`);
      }
      const chunk = Buffer.from(value);
      byteLength += chunk.byteLength;
      if (byteLength > input.source.byteLength) {
        throw new Error(
          `Hosted ${input.label} byte length does not match its catalog admission record.`
        );
      }
      hash.update(chunk);
      await writeFileHandleCompletely(destination, chunk);
      input.onDownloadedBytes(chunk.byteLength);
    }
    await destination.sync();
  } finally {
    reader.releaseLock();
    await destination.close();
  }

  if (byteLength !== input.source.byteLength) {
    throw new Error(
      `Hosted ${input.label} byte length does not match its catalog admission record.`
    );
  }
  if (hash.digest('hex') !== input.source.sha256) {
    throw new Error(`Hosted ${input.label} checksum does not match its catalog admission record.`);
  }
}

async function hostedPreparationManifest(
  definition: HostedReferenceCatalogDefinitionV1,
  fastaPath: string,
  annotationsPath: string
): Promise<unknown> {
  const fasta = (await inspectLocalReferenceSources([fastaPath])).fasta;
  if (fasta.sha256 !== definition.sources.fasta.sha256) {
    throw new Error('Hosted FASTA inspection does not match its catalog checksum.');
  }
  const inspectedBySourceSeqId = new Map(
    fasta.contigs.map((contig) => [contig.sourceSeqId, contig] as const)
  );
  if (inspectedBySourceSeqId.size !== definition.contigs.length) {
    throw new Error('Hosted FASTA contig roster does not match its catalog definition.');
  }
  const identityContigs = definition.contigs.map((contig) => {
    const inspected = inspectedBySourceSeqId.get(contig.sourceSeqId);
    if (!inspected || inspected.lengthBp !== contig.lengthBp) {
      throw new Error(
        `Hosted FASTA member ${contig.sourceSeqId} does not match its catalog definition.`
      );
    }
    return {
      sourceSeqId: contig.sourceSeqId,
      lengthBp: contig.lengthBp,
      circular: contig.circular,
      normalizedSequenceSha256: inspected.normalizedSequenceSha256,
    };
  });
  return {
    contract: REFERENCE_PREPARATION_MANIFEST_V2,
    assemblyIdentity: {
      contract: REFERENCE_ASSEMBLY_IDENTITY_V2,
      sha256: referenceAssemblyIdentitySha256V2(identityContigs),
    },
    assembly: {
      id: definition.id,
      name: definition.name,
      organism: definition.organism,
      taxId: definition.taxId,
      accession: definition.assembly,
      description: definition.description,
    },
    sources: {
      fasta: {
        path: fastaPath,
        sha256: definition.sources.fasta.sha256,
      },
      annotations: {
        format: 'gff3',
        path: annotationsPath,
        sha256: definition.sources.annotations.sha256,
      },
    },
    provenance: definition.provenance,
    contigs: definition.contigs.map((contig, index) => ({
      chrom: contig.chrom,
      sourceSeqId: contig.sourceSeqId,
      displayName: contig.displayName,
      lengthBp: contig.lengthBp,
      role: contig.role,
      aliases: contig.aliases,
      circular: contig.circular,
      normalizedSequenceSha256: identityContigs[index].normalizedSequenceSha256,
    })),
  };
}

function progressForEngineMessage(
  referenceName: string,
  message: string
): ReferenceAssetPreparationProgressUpdateV1 {
  const normalized = message.trim();
  if (/published source generation/i.test(normalized)) {
    return {
      phase: 'source-published',
      label: `${referenceName} sequence and coordinates are ready`,
      completed: 1,
      total: 1,
    };
  }
  if (/source summary/i.test(normalized)) {
    return {
      phase: 'summarizing-annotations',
      label: `Summarizing ${referenceName} annotations`,
    };
  }
  if (/search/i.test(normalized)) {
    return {
      phase: 'building-search',
      label: `Building ${referenceName} search`,
    };
  }
  if (/raster|scene|product/i.test(normalized)) {
    return {
      phase: 'building-visualization',
      label: `Building ${referenceName} visualization`,
    };
  }
  return {
    phase: 'indexing-reference',
    label: `Indexing ${referenceName}`,
  };
}

function progressForPortableHydration(
  referenceName: string,
  progress: PortablePreparedReferenceHydrationProgress
): ReferenceAssetPreparationProgressUpdateV1 {
  const labels = {
    manifest: `Verifying prepared ${referenceName}`,
    transport: `Downloading prepared ${referenceName}`,
    expanding: `Expanding prepared ${referenceName}`,
    objects: `Preparing ${referenceName}`,
    materializing: `Materializing prepared ${referenceName}`,
    ready: `Prepared ${referenceName} is cached`,
  } as const;
  return {
    phase: `prepared-bundle-${progress.phase}`,
    label: labels[progress.phase],
    completed: progress.completedBytes,
    total: progress.totalBytes,
  };
}
