import { isAbsolute, join } from 'path';
import { readFile } from 'node:fs/promises';
import { app, BrowserWindow } from 'electron';
import { sendRendererIpc } from '../../shared/ipc-contract';
import {
  REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
  type ReferenceAssetHostedInstallProgressV1,
  type PreparedReferenceAssemblyEntryV1,
} from '../../shared/reference-assets-ipc';
import { isExplicitE2eTestRuntime } from '../config';
import { activeGenomeReferencePaths } from '../ipc/genome-data';
import {
  registerReferenceAssetIpcHandlers,
  type RegisterReferenceAssetIpcHandlersDeps,
} from '../ipc/reference-assets';
import { setBgzfFastaMigrationIndexerBinary } from '../reference-assets/bgzf-fasta-migration';
import { createHostedReferenceAssetAuthority } from '../reference-assets/hosted-reference-asset-authority';
import {
  DNAFORGE_HOSTED_REFERENCE_BASE_URL_ENV,
  HOSTED_REFERENCE_CATALOG_V1,
} from '../reference-assets/hosted-reference-catalog';
import {
  hostedReferenceCatalogForRuntime,
  HOSTED_REFERENCE_CATALOG_FIXTURE_ENV,
} from '../reference-assets/hosted-reference-catalog-fixture';
import {
  HostedReferenceCacheReconciler,
  hostedReferenceCacheVersionsV1,
} from '../reference-assets/hosted-reference-cache-reconciler';
import { installHostedReferenceBodyReadGate } from '../reference-assets/hosted-reference-transport';
import { hostedReferenceCatalogForDistribution } from '../distribution';
import {
  createLocalReferenceAssetAuthority,
  resolveDnaIndexerHelperPath,
} from '../reference-assets/local-reference-asset-authority';
import { OfficeResourcesDownloadGate } from '../reference-assets/office-resources-download-gate';
import { portablePreparedReferenceViewAuthorityV1 } from '../reference-assets/portable-prepared-reference-view-authority';
import { resolveReferenceAssetRootLayout } from '../reference-assets/reference-asset-cache-root';
import { acquireReferenceAssetWriterLock } from '../reference-assets/reference-asset-writer-lock';
import { ReferenceGenerationRetention } from '../reference-assets/reference-generation-retention';
import type { MainFeature } from './main-feature';
import {
  buildGenomeAssembly,
  joinProjectPath,
  referenceAssemblyCacheRoot,
} from '../../features/sequence/reference-catalog';
import { resolveCurrentReferenceAssetPublicationV1 } from '../../features/sequence/reference-asset-publication';
import {
  parsePreparedReferenceDefinition,
  preparedReferenceAssemblyEntry,
  PREPARED_REFERENCE_DEFINITION_FILE,
} from '../reference-assets/reference-preparation-manifest';

interface PreparedReferenceAssets {
  readonly cacheRoot: string;
  readonly publicationRoot: string;
  readonly fallbackPublicationRoot: string | null;
  readonly runtimeHostedCatalog: Awaited<ReturnType<typeof hostedReferenceCatalogForRuntime>>;
  readonly retention: ReferenceGenerationRetention;
  readonly hostedReferenceAssets: ReturnType<typeof createHostedReferenceAssetAuthority>;
  readonly ipc: RegisterReferenceAssetIpcHandlersDeps;
}

let prepared: PreparedReferenceAssets | null = null;
let reconciler: HostedReferenceCacheReconciler | null = null;
let downloadGate: OfficeResourcesDownloadGate | null = null;
let uninstallDownloadGate: (() => void) | null = null;

export async function listTrackViewReferences() {
  if (!prepared) throw new Error('Reference assets are unavailable.');
  const local = await prepared.ipc.listLocal();
  const ids = new Set(local.map((entry) => entry.id));
  return [
    ...local,
    ...prepared.runtimeHostedCatalog
      .filter((entry) => !ids.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        organism: entry.organism,
        description: entry.description,
        assetCacheKey: entry.id,
        members: entry.contigs.map((contig) => ({
          chrom: contig.chrom,
          lengthBp: contig.lengthBp,
        })),
      })),
  ];
}

export async function withLocalTrackViewReference<T>(
  id: string,
  use: (entry: PreparedReferenceAssemblyEntryV1) => Promise<T>
): Promise<T> {
  const owner = prepared;
  if (!owner) throw new Error('Reference assets are unavailable.');
  const local = (await owner.ipc.listLocal()).filter((entry) => entry.id === id);
  if (prepared !== owner) throw new Error('Reference assets are unavailable.');
  if (local.length !== 1) throw new Error('REFERENCE_NOT_PREPARED');
  const entry = local[0];
  const memberPaths = entry.members.flatMap((member) =>
    member.manifest
      ? Object.values(member.manifest).filter((path): path is string => typeof path === 'string')
      : []
  );
  const hasRelativePaths = memberPaths.some((path) => !isAbsolute(path));
  let root = entry.portableView?.generationRoot ?? entry.members[0]?.manifest?.fastaPath;
  if (hasRelativePaths) {
    const current = await resolveCurrentReferenceAssetPublicationV1({
      assemblyCacheRoot: referenceAssemblyCacheRoot(owner.cacheRoot, entry),
      publicationAssemblyRoot: referenceAssemblyCacheRoot(owner.publicationRoot, entry),
      fallbackPublicationAssemblyRoot: owner.fallbackPublicationRoot
        ? referenceAssemblyCacheRoot(owner.fallbackPublicationRoot, entry)
        : null,
      assetCacheKey: entry.assetCacheKey,
      readTextFile: (path) => readFile(path, 'utf8'),
    });
    const portable =
      entry.portableView && /^[a-f0-9]{64}$/u.test(entry.portableView.bundleFingerprint)
        ? entry.portableView
        : null;
    root =
      portable && Object.keys(portable.assetGenerationsByTheme ?? {}).length > 0
        ? portable.generationRoot
        : (current?.sourceGenerationRoot ?? portable?.generationRoot);
  }
  if (!root || !isAbsolute(root)) throw new Error('REFERENCE_NOT_PREPARED');
  const release = await owner.retention.retainPreparation(root);
  try {
    if (prepared !== owner) throw new Error('Reference assets are unavailable.');
    if (!hasRelativePaths) return await use(entry);
    const definition = parsePreparedReferenceDefinition(
      JSON.parse(await readFile(join(root, PREPARED_REFERENCE_DEFINITION_FILE), 'utf8')) as unknown,
      entry.assetCacheKey
    );
    const sourceEntry = preparedReferenceAssemblyEntry(definition);
    if (
      sourceEntry.id !== entry.id ||
      sourceEntry.referenceIdentity?.sequenceIdentity !==
        entry.referenceIdentity?.sequenceIdentity ||
      sourceEntry.referenceIdentity?.annotationIdentity !==
        entry.referenceIdentity?.annotationIdentity
    )
      throw new Error('The prepared reference generation changed while resolving its source.');
    const assembly = buildGenomeAssembly(sourceEntry, (path) =>
      isAbsolute(path) ? path : joinProjectPath(root!, path)
    );
    const byChrom = new Map(assembly.chromosomes.map((member) => [member.chrom, member.manifest]));
    return await use({
      ...entry,
      members: sourceEntry.members.map((member) => {
        const manifest = byChrom.get(member.chrom)!;
        return {
          ...member,
          manifest: {
            fastaPath: manifest.fastaPath,
            faiPath: manifest.faiPath,
            ...(manifest.gffPath ? { gffPath: manifest.gffPath } : {}),
            ...(manifest.tbiPath ? { tbiPath: manifest.tbiPath } : {}),
          },
        };
      }),
    });
  } finally {
    release();
  }
}

export async function resolveTrackViewReference(id: string) {
  if (!prepared) throw new Error('Reference assets are unavailable.');
  const local = (await prepared.ipc.listLocal()).find((entry) => entry.id === id);
  if (local) return local;
  if (!prepared.runtimeHostedCatalog.some((entry) => entry.id === id))
    throw new Error('REFERENCE_NOT_FOUND');
  return prepared.ipc.installHosted({
    catalogId: id,
    themeMode: 'light',
    onProgress: () => undefined,
  });
}

async function prepareReferenceAssets(): Promise<void> {
  const referenceAssetRoots = resolveReferenceAssetRootLayout({
    appDataRoot: app.getPath('appData'),
    userDataRoot: app.getPath('userData'),
    env: process.env,
  });
  const dnaIndexerBinary = resolveDnaIndexerHelperPath({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    explicitPath: process.env.DNA_INDEXER_PATH,
    developmentSnapshotRoot: join(referenceAssetRoots.publicationRoot, '.native-helper-snapshots'),
  });
  setBgzfFastaMigrationIndexerBinary(dnaIndexerBinary);
  const referenceAssetAuthorityInput = {
    cacheRoot: referenceAssetRoots.cacheRoot,
    publicationRoot: referenceAssetRoots.publicationRoot,
    fallbackPublicationRoot: referenceAssetRoots.fallbackPublicationRoot,
    projectRoot: app.getAppPath(),
    sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
    indexerBinary: dnaIndexerBinary,
  };
  const allowLoopbackHttpForTests =
    !app.isPackaged && isExplicitE2eTestRuntime(process.argv, process.env.WAYPOINT_TEST);
  const localReferenceAssets = createLocalReferenceAssetAuthority({
    ...referenceAssetAuthorityInput,
    hubGenomePolicy: { allowLoopbackHttpForTests },
  });
  const officeResourcesDownloadGate = new OfficeResourcesDownloadGate();
  downloadGate = officeResourcesDownloadGate;
  uninstallDownloadGate = installHostedReferenceBodyReadGate(officeResourcesDownloadGate);
  const runtimeHostedCatalog = await hostedReferenceCatalogForRuntime({
    catalog: hostedReferenceCatalogForDistribution(
      HOSTED_REFERENCE_CATALOG_V1,
      process.env[DNAFORGE_HOSTED_REFERENCE_BASE_URL_ENV]
    ),
    isPackaged: app.isPackaged,
    explicitE2e: allowLoopbackHttpForTests,
    fixturePath: process.env[HOSTED_REFERENCE_CATALOG_FIXTURE_ENV],
  });
  const retention = new ReferenceGenerationRetention({
    cacheRoot: referenceAssetRoots.cacheRoot,
    ownedPublicationRoot: referenceAssetRoots.publicationRoot,
    publicationRoots: [
      referenceAssetRoots.publicationRoot,
      ...(referenceAssetRoots.fallbackPublicationRoot
        ? [referenceAssetRoots.fallbackPublicationRoot]
        : []),
    ],
    catalogIds: runtimeHostedCatalog.map((definition) => definition.id),
    pinnedVersions: runtimeHostedCatalog.flatMap((definition) =>
      [
        definition.preparedBundle?.firstViewPack?.bundleFingerprint,
        definition.preparedBundle?.fullTierShards?.bundleFingerprint,
      ]
        .filter((generationId): generationId is string => Boolean(generationId))
        .map((generationId) => ({ catalogId: definition.id, generationId }))
    ),
    sessionPaths: activeGenomeReferencePaths,
    onCollected: (root) => portablePreparedReferenceViewAuthorityV1.releaseGeneration(root),
    acquireWriterLease: (root) => acquireReferenceAssetWriterLock(root, dnaIndexerBinary),
  });
  retention.start();
  await retention.checkpoint();
  const { trackAllowedEvent } = await import('../analytics');
  const hostedReferenceAssets = createHostedReferenceAssetAuthority({
    ...referenceAssetAuthorityInput,
    assetBaseUrl: process.env[DNAFORGE_HOSTED_REFERENCE_BASE_URL_ENV],
    catalog: runtimeHostedCatalog,
    retainInstalledGeneration: (root) => retention.retainPreparation(root),
    collectSupersededVersions: () => retention.collect(),
    allowLoopbackHttpForTests,
    observeInstall: (observation) =>
      trackAllowedEvent('hosted_reference_install_observed', observation),
  });
  prepared = {
    cacheRoot: referenceAssetRoots.cacheRoot,
    publicationRoot: referenceAssetRoots.publicationRoot,
    fallbackPublicationRoot: referenceAssetRoots.fallbackPublicationRoot,
    runtimeHostedCatalog,
    retention,
    hostedReferenceAssets,
    ipc: {
      ...localReferenceAssets,
      ...hostedReferenceAssets,
      setOpenVersions: (owner, versions) => retention.setRendererVersions(owner, versions),
      releaseRendererVersions: (owner) => retention.releaseRenderer(owner),
      retainOpenedVersion: async (owner, entry) => {
        const root = entry.portableView?.generationRoot ?? entry.members[0]?.manifest?.fastaPath;
        const generationId = root?.match(/[/\\]generations[/\\]([^/\\]+)/)?.[1];
        if (generationId)
          await retention.pinOpening(owner, { catalogId: entry.assetCacheKey, generationId });
      },
    },
  };
}

function publishHostedCacheProgress(progress: ReferenceAssetHostedInstallProgressV1): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      sendRendererIpc(
        window.webContents,
        REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
        progress
      );
    } catch {
      continue;
    }
  }
}

function startHostedCacheReconciler(): void {
  if (!prepared) return;
  const { cacheRoot, runtimeHostedCatalog, hostedReferenceAssets, retention } = prepared;
  reconciler = new HostedReferenceCacheReconciler({
    cacheRoot,
    versionsByCatalogId: hostedReferenceCacheVersionsV1(
      runtimeHostedCatalog,
      __WAYPOINT_BUILD_SOURCE_FINGERPRINT__
    ),
    listHosted: hostedReferenceAssets.listHosted,
    installHosted: hostedReferenceAssets.installHosted,
    onProgress: publishHostedCacheProgress,
    collectSupersededVersions: () => retention.collect(),
  });
  const explicitE2e = isExplicitE2eTestRuntime(process.argv, process.env.WAYPOINT_TEST);
  if (!explicitE2e || process.env.DNAFORGE_ENABLE_HOSTED_REFERENCE_CACHE_RECONCILER === '1') {
    reconciler.start();
  }
}

function stopReferenceAssets(): void {
  void prepared?.retention.stop();
  prepared = null;
  reconciler?.stop();
  reconciler = null;
  uninstallDownloadGate?.();
  uninstallDownloadGate = null;
  downloadGate?.dispose();
  downloadGate = null;
}

export const referenceAssetsFeature: MainFeature = {
  id: 'reference-assets',
  prepare: prepareReferenceAssets,
  registerIpc: () => {
    if (prepared) registerReferenceAssetIpcHandlers(prepared.ipc);
    return () => undefined;
  },
  onMainWindow: startHostedCacheReconciler,
  willQuit: stopReferenceAssets,
};
