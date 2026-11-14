import {
  referenceViewCompatibility,
  reconcileReferenceAnnotationTracks,
} from './reference-view-compatibility';
import { useCanvasStore } from '../canvas/public/store';
import { presentDocument } from '../canvas/public/present-document';
import type { OpenStrategy } from '../canvas/public/document-presentation';
import { platform } from '../../platform';
import {
  type ReferenceAssemblyEntry,
  buildGenomeAssembly,
  anchorChromosomeOf,
  joinProjectPath,
  referenceAssemblyCacheRoot,
} from './reference-catalog';
import {
  requiredReferenceAssetAnnotationProductV1,
  resolveCurrentReferenceAssetPublicationV1,
} from './reference-asset-publication';
import { extensionForPath } from './indexed-genome-paths';
import { registerIndexedGenomeOpen } from './indexed-genome-lifecycle-telemetry';
import {
  ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
  DEFAULT_INDEXED_ANNOTATION_MAPPER_POLICY,
  type AssemblyReferenceAssetGenerationByThemeV1,
  type IndexedGenomeDataTrackState,
  type IndexedGenomeScope,
  type IndexedGenomeTabState,
  type IndexedGenomeViewRestoreCommand,
  type IndexedGenomeInitialAnnotationMapperPolicy,
} from '../../shared/indexed-genome';
import {
  assemblyHasCompleteSequenceSource,
  assemblyHasAnnotationSource,
  LEGACY_PORTABLE_ANNOTATION_DATASET_VERSION,
  prepareCurrentAssemblyAnnotationProductSet,
  preparePortableAssemblyAnnotationProductSet,
} from './prepareAssemblyAnnotationProductSet';
import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '@waypoint/genome-renderer/pure';

export interface OpenAssemblyOptions {
  placement?: OpenStrategy;
  intoTabId?: string;
  viewEntity?: { id: string; name: string };
  validateReference?: (reference: IndexedGenomeTabState) => void;
  initialAnnotationMapperPolicy?: IndexedGenomeInitialAnnotationMapperPolicy;
  annotationThemeMode?: 'light' | 'dark';
  onProgress?: (progress: OpenAssemblyProgress) => void;
  refreshExistingTabOnly?: boolean;
  commitGuard?: () => boolean;
  restoreView?: OpenAssemblyViewRestore;
}

export interface OpenAssemblyViewRestore {
  readonly bamTracks?: IndexedGenomeTabState['bamTracks'];
  readonly signalReadPileupViews?: IndexedGenomeTabState['signalReadPileupViews'];
  readonly variantSource?: IndexedGenomeTabState['variantSource'];
  readonly scope: IndexedGenomeScope;
  readonly dataTracks: ReadonlyArray<IndexedGenomeDataTrackState>;
  readonly annotationTrackTypes: ReadonlyArray<string>;
  readonly indexedViewport: Readonly<{ start0: number; end0: number }>;
  readonly command: IndexedGenomeViewRestoreCommand;
  readonly primerBindings?: IndexedGenomeTabState['primerBindings'];
  readonly userAnnotations?: IndexedGenomeTabState['userAnnotations'];
}

export type OpenAssemblyProgressPhase =
  | 'validating-reference'
  | 'reading-annotation-inventory'
  | 'building-annotation-indexes'
  | 'opening-indexed-genome';

export interface OpenAssemblyProgress {
  readonly phase: OpenAssemblyProgressPhase;
  readonly label: string;
}

const OPEN_ASSEMBLY_PROGRESS_LABELS: Record<OpenAssemblyProgressPhase, string> = {
  'validating-reference': 'Validating reference files',
  'reading-annotation-inventory': 'Reading annotation inventory',
  'building-annotation-indexes': 'Building annotation indexes',
  'opening-indexed-genome': 'Opening indexed genome',
};

function reportOpenAssemblyProgress(
  observer: OpenAssemblyOptions['onProgress'],
  phase: OpenAssemblyProgressPhase
): void {
  observer?.({ phase, label: OPEN_ASSEMBLY_PROGRESS_LABELS[phase] });
}

function assertOpenAssemblyPreparedManifests(args: {
  catalogAnchor: { chrom: string; manifest: { gffPath?: string | null; tbiPath?: string | null } };
  members: ReadonlyArray<{ manifest?: unknown }>;
}): number {
  const hasAnchorGff = Boolean(args.catalogAnchor.manifest.gffPath);
  const hasAnchorTbi = Boolean(args.catalogAnchor.manifest.tbiPath);
  if (hasAnchorGff !== hasAnchorTbi) {
    throw new Error(
      `Reference assembly anchor has a partial annotation manifest: ${args.catalogAnchor.chrom}`
    );
  }
  const preparedMemberCount = args.members.filter((member) => Boolean(member.manifest)).length;
  if (preparedMemberCount > 0 && preparedMemberCount !== args.members.length) {
    throw new Error(
      'The prepared reference has an incomplete member manifest. Add the reference again from its original source.'
    );
  }
  return preparedMemberCount;
}

function collectPreparedReferenceMemberPaths(
  catalogAssembly: ReturnType<typeof buildGenomeAssembly>
): Array<{ chrom: string; path: string }> {
  return catalogAssembly.chromosomes.flatMap((chromosome) => {
    const { manifest } = chromosome;
    if (!manifest.fastaPath || !manifest.faiPath) {
      throw new Error(
        `Prepared reference ${chromosome.chrom} is missing its sequence index. Add the reference again from its original source.`
      );
    }
    const hasGff = Boolean(manifest.gffPath);
    const hasTbi = Boolean(manifest.tbiPath);
    if (hasGff !== hasTbi) {
      throw new Error(
        `Prepared reference ${chromosome.chrom} has an incomplete annotation index. Add the reference again from its original source.`
      );
    }
    return [
      { chrom: chromosome.chrom, path: manifest.fastaPath },
      { chrom: chromosome.chrom, path: manifest.faiPath },
      ...(hasGff
        ? [
            { chrom: chromosome.chrom, path: manifest.gffPath! },
            { chrom: chromosome.chrom, path: manifest.tbiPath! },
          ]
        : []),
    ];
  });
}

async function resolvePreparedReferenceSourceReadiness(args: {
  hasCurrentPublication: boolean;
  requiredMemberPaths: Array<{ chrom: string; path: string }>;
  allowPendingSource: boolean;
}): Promise<boolean> {
  if (!args.hasCurrentPublication || args.requiredMemberPaths.length === 0) return false;
  const memberExistence = await Promise.all(
    args.requiredMemberPaths.map(async ({ chrom, path }) => ({
      chrom,
      exists: await platform()
        .fs.exists(path)
        .catch(() => false),
    }))
  );
  const missingChroms = [
    ...new Set(memberExistence.filter(({ exists }) => !exists).map(({ chrom }) => chrom)),
  ];
  if (missingChroms.length > 0) {
    if (args.allowPendingSource) return false;
    throw new Error(
      `Prepared reference files are missing for ${missingChroms.join(
        ', '
      )}. Add the reference again from its original folder or package.`
    );
  }
  return true;
}

function buildOpenAssemblyIndexedGenomeFields(args: {
  retainedViewState: Partial<IndexedGenomeTabState>;
  anchorSource: string;
  activeProductWorkspaceRoot: string;
  catalogAnchor: { chrom: string; manifest: IndexedGenomeTabState['manifest'] };
  assembly: ReturnType<typeof buildGenomeAssembly>;
  sourceReady: boolean;
  productAdmission: {
    annotationProductsReadiness: IndexedGenomeTabState['assemblyAnnotationProductsReadiness'];
    searchReadiness: IndexedGenomeTabState['assemblySearchReadiness'];
    searchSource?: IndexedGenomeTabState['assemblySearchSource'];
    generation?: IndexedGenomeTabState['assemblyAssetGeneration'];
    trackTypes?: readonly string[];
  };
  assemblyAssetGenerationsByTheme: AssemblyReferenceAssetGenerationByThemeV1 | undefined;
  usingPortableProductAdmission: boolean;
  portableBundleFingerprint?: string;
  referenceIdentity?: IndexedGenomeTabState['assemblyReferenceIdentity'];
  referenceVersionHistory?: IndexedGenomeTabState['assemblyReferenceVersionHistory'];
  restoreView?: OpenAssemblyViewRestore;
}): IndexedGenomeTabState {
  const { retainedViewState, productAdmission } = args;
  return {
    ...retainedViewState,
    sourcePath: args.anchorSource,
    workspaceRoot: args.activeProductWorkspaceRoot,
    sourceExt: extensionForPath(args.anchorSource),
    chrom: args.catalogAnchor.chrom,
    manifest: args.catalogAnchor.manifest,
    assembly: args.assembly,
    assemblyReferenceIdentity: args.referenceIdentity,
    assemblyReferenceVersionHistory: args.referenceVersionHistory,
    assemblySourceReadiness: args.sourceReady ? 'ready' : 'pending',
    assemblyAnnotationProductsReadiness: productAdmission.annotationProductsReadiness,
    assemblySearchReadiness: productAdmission.searchReadiness,
    ...(productAdmission.searchSource
      ? { assemblySearchSource: productAdmission.searchSource }
      : {}),
    ...(productAdmission.generation
      ? { assemblyAssetGeneration: productAdmission.generation }
      : {}),
    ...(args.assemblyAssetGenerationsByTheme
      ? { assemblyAssetGenerationsByTheme: args.assemblyAssetGenerationsByTheme }
      : {}),
    ...(args.usingPortableProductAdmission
      ? { assemblyPortableBundleFingerprint: args.portableBundleFingerprint! }
      : {}),
    ...(args.restoreView
      ? { assemblyAnnotationTrackTypes: [...args.restoreView.annotationTrackTypes] }
      : productAdmission.trackTypes
        ? { assemblyAnnotationTrackTypes: [...productAdmission.trackTypes] }
        : {}),
    ...(args.restoreView
      ? {
          scope: { ...args.restoreView.scope },
          dataTracks: args.restoreView.dataTracks.map((track) => ({ ...track })),
          bamTracks: args.restoreView.bamTracks?.map((track) => ({ ...track })) ?? [],
          signalReadPileupViews:
            args.restoreView.signalReadPileupViews?.map((view) => ({ ...view })) ?? [],
          ucscTracks: undefined,
          variantSource: args.restoreView.variantSource,
          primerBindings: args.restoreView.primerBindings?.map((binding) => ({ ...binding })),
          userAnnotations: args.restoreView.userAnnotations?.map((entry) => ({
            ...entry,
            annotation: { ...entry.annotation },
          })),
        }
      : { scope: retainedViewState.scope ?? { kind: 'all' } }),
  };
}

function buildPublishedAssetGenerationsByTheme(args: {
  expectedLightProduct: ReturnType<typeof requiredReferenceAssetAnnotationProductV1> | null;
  expectedDarkProduct: ReturnType<typeof requiredReferenceAssetAnnotationProductV1> | null;
}): AssemblyReferenceAssetGenerationByThemeV1 | undefined {
  const { expectedLightProduct, expectedDarkProduct } = args;
  if (!expectedLightProduct) return undefined;
  return {
    light: {
      contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
      sourceFingerprint: expectedLightProduct.sourceFingerprint,
      inventoryFingerprint: expectedLightProduct.inventoryFingerprint,
      themeMode: 'light',
    },
    ...(expectedDarkProduct
      ? {
          dark: {
            contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
            sourceFingerprint: expectedDarkProduct.sourceFingerprint,
            inventoryFingerprint: expectedDarkProduct.inventoryFingerprint,
            themeMode: 'dark' as const,
          },
        }
      : {}),
  };
}

async function admitOrdinaryOpenAssemblyProductSet(args: {
  sourceReady: boolean;
  explicitProductMissing: boolean;
  portableViewAvailable: boolean;
  currentPublication: Awaited<ReturnType<typeof resolveCurrentReferenceAssetPublicationV1>>;
  productWorkspaceRoot: string;
  sourceGenerationRoot: string;
  assemblyCacheRoot: string;
  catalogAssembly: ReturnType<typeof buildGenomeAssembly>;
  annotationThemeMode: typeof INDEXED_ANNOTATION_COLOR_BASIS_THEME;
  initialAnnotationMapperPolicy: IndexedGenomeInitialAnnotationMapperPolicy;
  expectedProduct: ReturnType<typeof requiredReferenceAssetAnnotationProductV1> | null;
  onProgress: OpenAssemblyOptions['onProgress'];
}): Promise<{
  admission: Awaited<ReturnType<typeof prepareCurrentAssemblyAnnotationProductSet>>;
  productWorkspaceRoot: string;
}> {
  if (!args.sourceReady || args.explicitProductMissing || args.portableViewAvailable) {
    return { admission: null, productWorkspaceRoot: args.productWorkspaceRoot };
  }
  let productWorkspaceRoot = args.productWorkspaceRoot;
  let admission: Awaited<ReturnType<typeof prepareCurrentAssemblyAnnotationProductSet>> = null;
  const candidateProductRoots = args.currentPublication?.publication.productLayout
    ? [productWorkspaceRoot]
    : [args.sourceGenerationRoot, args.assemblyCacheRoot].filter(
        (root, index, roots) => roots.indexOf(root) === index
      );
  for (const candidateProductRoot of candidateProductRoots) {
    const candidateAdmission = await prepareCurrentAssemblyAnnotationProductSet(
      args.catalogAssembly,
      {
        workspaceRoot: candidateProductRoot,
        themeMode: args.annotationThemeMode,
        policy: args.initialAnnotationMapperPolicy,
        ...(args.expectedProduct
          ? {
              expectedGeneration: {
                sourceFingerprint: args.expectedProduct.sourceFingerprint,
                inventoryFingerprint: args.expectedProduct.inventoryFingerprint,
              },
            }
          : {}),
        onProgress: (phase) => reportOpenAssemblyProgress(args.onProgress, phase),
      }
    );
    admission = candidateAdmission;
    if (candidateAdmission && candidateAdmission.annotationProductsReadiness !== 'pending') {
      productWorkspaceRoot = candidateProductRoot;
      break;
    }
  }
  return { admission, productWorkspaceRoot };
}

function resolveOpenAssemblyAssetGenerationsByTheme(args: {
  usingPortableProductAdmission: boolean;
  ordinaryProductAdmitted: boolean;
  portableAssetGenerationsByTheme: AssemblyReferenceAssetGenerationByThemeV1 | undefined;
  publishedAssetGenerationsByTheme: AssemblyReferenceAssetGenerationByThemeV1 | undefined;
}): AssemblyReferenceAssetGenerationByThemeV1 | undefined {
  if (args.usingPortableProductAdmission) return args.portableAssetGenerationsByTheme;
  if (args.ordinaryProductAdmitted) return args.publishedAssetGenerationsByTheme;
  return undefined;
}

function mountOpenAssemblyTab(args: {
  options: OpenAssemblyOptions;
  assemblyEntityId: string;
  entryName: string;
  initialAnnotationMapperPolicy: IndexedGenomeInitialAnnotationMapperPolicy;
  indexedGenome: IndexedGenomeTabState;
}): string | null {
  args.options.validateReference?.(args.indexedGenome);
  const assemblyEntityId = args.assemblyEntityId;
  const currentExistingTab = Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((tab) =>
      args.options.intoTabId ? tab.id === args.options.intoTabId : tab.entityId === assemblyEntityId
    );
  if (args.options.intoTabId && !currentExistingTab) return null;
  const previousIdentity = currentExistingTab?.indexedGenome?.assemblyReferenceIdentity;
  const nextIdentity = args.indexedGenome.assemblyReferenceIdentity;
  if (previousIdentity && nextIdentity) {
    const compatibility = referenceViewCompatibility(previousIdentity, nextIdentity);
    if (!compatibility.compatible) {
      throw new Error(
        'This reference sequence changed. The open view has been kept on its original sequence.'
      );
    }
    if (compatibility.annotationsUpdated) {
      args.indexedGenome.referenceAnnotationUpdateNotice = reconcileReferenceAnnotationTracks(
        {
          orderedTrackIds: currentExistingTab?.indexedGenome?.assemblyAnnotationTrackTypes ?? [],
          visibilityByTrackId: {},
        },
        args.indexedGenome.assemblyAnnotationTrackTypes ?? []
      ).notice;
    }
  }
  if (args.options.refreshExistingTabOnly && !currentExistingTab) return null;
  if (args.options.commitGuard && !args.options.commitGuard()) return null;
  const presentation =
    args.options.refreshExistingTabOnly || args.options.intoTabId
      ? null
      : presentDocument(
          {
            type: 'sequence',
            entityId: assemblyEntityId,
            label: args.options.viewEntity?.name ?? args.entryName,
            sequenceDocument: { kind: 'indexed-sequence', documentId: assemblyEntityId },
          },
          args.options.placement
        );
  const tabId = args.options.intoTabId
    ? currentExistingTab?.id
    : args.options.refreshExistingTabOnly
      ? currentExistingTab?.id
      : presentation?.status === 'presented'
        ? presentation.tabId
        : null;
  if (!tabId) return null;
  if (presentation?.status === 'presented' && presentation.disposition === 'created') {
    registerIndexedGenomeOpen(tabId, assemblyEntityId);
  }
  for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
    const currentTab = panel.tabs.find((candidate) => candidate.id === tabId);
    if (currentTab) {
      const updates: import('../canvas/types').TabUpdates = {
        loadStatus: 'indexed-pending',
        initialAnnotationMapperPolicy: { ...args.initialAnnotationMapperPolicy },
        indexedGenome: args.indexedGenome,
        ...(!args.options.viewEntity && !args.options.refreshExistingTabOnly
          ? { isDirty: true }
          : {}),
        ...(args.options.restoreView
          ? {
              viewState: {
                ...currentTab.viewState,
                indexedViewport: { ...args.options.restoreView.indexedViewport },
                indexedViewportCommand: null,
                indexedGenomeViewRestoreCommand: {
                  ...args.options.restoreView.command,
                  viewport: { ...args.options.restoreView.command.viewport },
                  annotationPolicy: { ...args.options.restoreView.command.annotationPolicy },
                  visibleAnnotationTrackIds: [
                    ...args.options.restoreView.command.visibleAnnotationTrackIds,
                  ],
                  orderedAnnotationTrackIds: [
                    ...args.options.restoreView.command.orderedAnnotationTrackIds,
                  ],
                },
              },
            }
          : {}),
      };
      const canvas = useCanvasStore.getState();
      if (args.options.intoTabId) {
        canvas.retargetTab(
          panelId,
          tabId,
          {
            type: 'sequence',
            sequenceDocument: { kind: 'indexed-sequence', documentId: assemblyEntityId },
          },
          { ...updates, label: args.options.viewEntity?.name ?? args.entryName }
        );
      } else {
        canvas.updateTab(panelId, tabId, updates);
      }
      break;
    }
  }
  return tabId;
}

export async function openAssembly(
  entry: ReferenceAssemblyEntry,
  options: OpenAssemblyOptions = {}
): Promise<string | null> {
  reportOpenAssemblyProgress(options.onProgress, 'validating-reference');
  const assemblyEntityId =
    options.viewEntity?.id ??
    (options.refreshExistingTabOnly ? `assembly:${entry.id}` : `track-view-${crypto.randomUUID()}`);
  const initialExistingTab = Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((tab) =>
      options.intoTabId ? tab.id === options.intoTabId : tab.entityId === assemblyEntityId
    );
  if (options.refreshExistingTabOnly && !initialExistingTab) return null;
  const sharedCacheRoot = await platform()
    .path.referenceAssetCacheRoot()
    .catch(() => null);
  if (!sharedCacheRoot) return null;
  const publicationRoot = await (
    platform().path.referenceAssetPublicationRoot?.() ?? Promise.resolve(sharedCacheRoot)
  ).catch(() => sharedCacheRoot);
  const assemblyCacheRoot = referenceAssemblyCacheRoot(sharedCacheRoot, entry);
  const publicationAssemblyRoot = referenceAssemblyCacheRoot(publicationRoot, entry);
  const currentPublication = await resolveCurrentReferenceAssetPublicationV1({
    assemblyCacheRoot,
    publicationAssemblyRoot,
    fallbackPublicationAssemblyRoot:
      publicationAssemblyRoot === assemblyCacheRoot ? null : assemblyCacheRoot,
    assetCacheKey: entry.assetCacheKey,
    readTextFile: (path) => platform().fs.readTextFile(path),
  });
  const portableViewAvailable = Boolean(
    entry.portableView && /^[0-9a-f]{64}$/.test(entry.portableView.bundleFingerprint)
  );
  const portableSourcesAdmitted =
    portableViewAvailable &&
    Object.keys(entry.portableView?.assetGenerationsByTheme ?? {}).length > 0;
  let sourceGenerationRoot = portableSourcesAdmitted
    ? entry.portableView!.generationRoot
    : (currentPublication?.sourceGenerationRoot ?? assemblyCacheRoot);
  let catalogAssembly = buildGenomeAssembly(entry, (rel) =>
    joinProjectPath(sourceGenerationRoot, rel)
  );
  let productWorkspaceRoot = currentPublication?.productWorkspaceRoot ?? assemblyCacheRoot;
  const annotationThemeMode = INDEXED_ANNOTATION_COLOR_BASIS_THEME;
  const expectedProduct = currentPublication
    ? requiredReferenceAssetAnnotationProductV1(
        currentPublication.publication,
        entry.id,
        annotationThemeMode
      )
    : null;
  const expectedLightProduct = currentPublication
    ? requiredReferenceAssetAnnotationProductV1(currentPublication.publication, entry.id, 'light')
    : null;
  const expectedDarkProduct = currentPublication
    ? requiredReferenceAssetAnnotationProductV1(currentPublication.publication, entry.id, 'dark')
    : null;
  const publishedAssetGenerationsByTheme = buildPublishedAssetGenerationsByTheme({
    expectedLightProduct,
    expectedDarkProduct,
  });
  const retainedPortableAssetGenerationsByTheme =
    options.refreshExistingTabOnly &&
    portableViewAvailable &&
    initialExistingTab?.indexedGenome?.assemblyPortableBundleFingerprint ===
      entry.portableView!.bundleFingerprint
      ? initialExistingTab.indexedGenome.assemblyAssetGenerationsByTheme
      : undefined;
  const portableAssetGenerationsByTheme =
    entry.portableView?.assetGenerationsByTheme ?? retainedPortableAssetGenerationsByTheme;
  const portableAssetGeneration = portableAssetGenerationsByTheme?.[annotationThemeMode];
  let catalogAnchor = anchorChromosomeOf(catalogAssembly) ?? catalogAssembly.chromosomes[0];
  if (!catalogAnchor) return null;
  const preparedMemberCount = assertOpenAssemblyPreparedManifests({
    catalogAnchor,
    members: entry.members,
  });
  const requiredMemberPaths =
    preparedMemberCount === 0 ? [] : collectPreparedReferenceMemberPaths(catalogAssembly);
  const sourceReady = await resolvePreparedReferenceSourceReadiness({
    hasCurrentPublication: Boolean(currentPublication),
    requiredMemberPaths,
    allowPendingSource: portableViewAvailable,
  });
  if (!sourceReady && portableViewAvailable) {
    sourceGenerationRoot = entry.portableView!.generationRoot;
    catalogAssembly = buildGenomeAssembly(entry, (rel) =>
      joinProjectPath(sourceGenerationRoot, rel)
    );
    catalogAnchor = anchorChromosomeOf(catalogAssembly) ?? catalogAssembly.chromosomes[0];
    if (!catalogAnchor) return null;
  }
  const anchorManifest = catalogAnchor.manifest;
  const anchorSource =
    anchorManifest.gffPath ||
    anchorManifest.fastaPath ||
    joinProjectPath(assemblyCacheRoot, `${entry.id}.source-pending`);

  const initialAnnotationMapperPolicy =
    initialExistingTab?.initialAnnotationMapperPolicy ??
    options.initialAnnotationMapperPolicy ??
    DEFAULT_INDEXED_ANNOTATION_MAPPER_POLICY;
  const explicitProductMissing =
    Boolean(currentPublication?.publication.productLayout) && !expectedProduct;
  const ordinaryAdmission = await admitOrdinaryOpenAssemblyProductSet({
    sourceReady,
    explicitProductMissing,
    portableViewAvailable,
    currentPublication,
    productWorkspaceRoot,
    sourceGenerationRoot,
    assemblyCacheRoot,
    catalogAssembly,
    annotationThemeMode,
    initialAnnotationMapperPolicy,
    expectedProduct,
    onProgress: options.onProgress,
  });
  const ordinaryProductAdmission = ordinaryAdmission.admission;
  productWorkspaceRoot = ordinaryAdmission.productWorkspaceRoot;
  const ordinaryProductAdmitted =
    ordinaryProductAdmission?.annotationProductsReadiness !== undefined &&
    ordinaryProductAdmission.annotationProductsReadiness !== 'pending';
  const usingPortableProductAdmission = portableViewAvailable;
  const annotationCapabilityReadiness =
    !assemblyHasAnnotationSource(catalogAssembly) &&
    assemblyHasCompleteSequenceSource(catalogAssembly)
      ? ('not-applicable' as const)
      : ('pending' as const);
  const portableProductAdmission = usingPortableProductAdmission
    ? await preparePortableAssemblyAnnotationProductSet(catalogAssembly, {
        workspaceRoot: assemblyCacheRoot,
        themeMode: annotationThemeMode,
        policy: initialAnnotationMapperPolicy,
        trackTypes: entry.portableView!.trackTypes,
        datasetVersion:
          entry.portableView!.datasetVersion ?? LEGACY_PORTABLE_ANNOTATION_DATASET_VERSION,
        searchReady: sourceReady && entry.portableView?.searchReady === true,
        ...(portableAssetGeneration ? { annotationAssetGeneration: portableAssetGeneration } : {}),
      })
    : null;
  const productAdmission = portableProductAdmission ??
    ordinaryProductAdmission ?? {
      assembly: catalogAssembly,
      annotationProductsReadiness: annotationCapabilityReadiness,
      searchReadiness: annotationCapabilityReadiness,
    };
  if (!productAdmission) return null;
  const assembly = productAdmission.assembly;
  const activeProductWorkspaceRoot = usingPortableProductAdmission
    ? assemblyCacheRoot
    : productWorkspaceRoot;
  const assemblyAssetGenerationsByTheme = resolveOpenAssemblyAssetGenerationsByTheme({
    usingPortableProductAdmission,
    ordinaryProductAdmitted,
    portableAssetGenerationsByTheme,
    publishedAssetGenerationsByTheme,
  });

  reportOpenAssemblyProgress(options.onProgress, 'opening-indexed-genome');

  const currentExistingTab = Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((tab) => tab.entityId === assemblyEntityId);
  if (options.refreshExistingTabOnly && !currentExistingTab) return null;
  const retainedViewState = retainViewStateAcrossAssemblyRefresh(currentExistingTab?.indexedGenome);
  return mountOpenAssemblyTab({
    options,
    assemblyEntityId,
    entryName: entry.name,
    initialAnnotationMapperPolicy,
    indexedGenome: buildOpenAssemblyIndexedGenomeFields({
      retainedViewState,
      anchorSource,
      activeProductWorkspaceRoot,
      catalogAnchor: { chrom: catalogAnchor.chrom, manifest: anchorManifest },
      assembly,
      sourceReady,
      productAdmission,
      assemblyAssetGenerationsByTheme,
      usingPortableProductAdmission,
      portableBundleFingerprint: entry.portableView?.bundleFingerprint,
      referenceIdentity: entry.referenceIdentity,
      referenceVersionHistory: entry.referenceVersionHistory,
      restoreView: options.restoreView,
    }),
  });
}

function retainViewStateAcrossAssemblyRefresh(
  current: IndexedGenomeTabState | undefined
): Partial<IndexedGenomeTabState> {
  if (!current) return {};
  const {
    sourcePath: _sourcePath,
    workspaceRoot: _workspaceRoot,
    sourceSizeBytes: _sourceSizeBytes,
    sourceMtimeMs: _sourceMtimeMs,
    sourceCtimeMs: _sourceCtimeMs,
    sourceExt: _sourceExt,
    chrom: _chrom,
    outputDir: _outputDir,
    manifest: _manifest,
    metadata: _metadata,
    indexedAt: _indexedAt,
    error: _error,
    assembly: _assembly,
    assemblySearchSource: _assemblySearchSource,
    assemblyAssetGeneration: _assemblyAssetGeneration,
    assemblyAssetGenerationsByTheme: _assemblyAssetGenerationsByTheme,
    assemblyPortableBundleFingerprint: _assemblyPortableBundleFingerprint,
    assemblyReferenceIdentity: _assemblyReferenceIdentity,
    assemblyReferenceVersionHistory: _assemblyReferenceVersionHistory,
    assemblyAnnotationTrackTypes: _assemblyAnnotationTrackTypes,
    assemblySourceReadiness: _assemblySourceReadiness,
    assemblyAnnotationProductsReadiness: _assemblyAnnotationProductsReadiness,
    assemblySearchReadiness: _assemblySearchReadiness,
    ...viewState
  } = current;
  return viewState;
}
