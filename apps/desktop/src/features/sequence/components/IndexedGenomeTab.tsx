import {
  usePresentationListener,
  usePresentationScope,
} from '../../../presentation/PresentationSurface';
import {
  toOptionalUserMessage,
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';

import { TrackViewActions } from './TrackViewActions';
import { assertTrackViewReference, trackViewReference } from '../open-track-view';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tab } from '../../canvas/public/types';
import { useCanvasStore } from '../../canvas/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useToastStore } from '../../../stores/toast-store';
import { useWorkspace } from '../../../hooks/useWorkspace';
import { platform } from '../../../platform';
import type { PreparedReferenceAssemblyEntryV1 } from '../../../shared/reference-assets-ipc';
import type {
  AssemblyAnnotationSceneSourceRequest,
  AssemblySequenceSearchSourceV1,
  GenomeOpenSource,
  GenomeSessionShell,
  GenomeSessionUpdate,
  GenomeTrackDescriptor,
  IndexedGenomeManifest,
  IndexedGenomePrimerBinding,
  IndexedGenomeTabState,
  IndexedGenomeUserAnnotation,
} from '../../../shared/indexed-genome';
import {
  ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
  DEFAULT_INDEXED_ANNOTATION_MAPPER_POLICY,
  assemblyAnnotationSceneScopeForRequest,
  assemblyReferenceAssetGenerationForThemeV1,
} from '../../../shared/indexed-genome';
import { extensionForPath } from '../indexed-genome-paths';
import {
  beginIndexedGenomeOpen,
  claimIndexedGenomeOpen,
  type IndexedGenomeOpenTelemetry,
} from '../indexed-genome-lifecycle-telemetry';
import { completeManifestFromIndexedGff3Source } from '../assembly-indexed-manifest';
import {
  REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP,
  assemblyTotalLengthBp,
} from '@waypoint/genome-data';
import type { Annotation } from '@waypoint/sequence-utils';
import { SequenceContextMenu } from '@waypoint/ui-components';
import { matchesShortcut } from '@waypoint/ui-components/keyboard';
import type { IndexedGenomeAnnotationMapperPolicy } from './IndexedGenomeViewer';
import { buildIndexedGenomeScene, type IndexedGenomeSceneViewport } from './indexed-genome-scene';
import {
  computeLoadPhase,
  type IndexedGenomePrepareLoadPhase,
  type IndexedGenomePrepareStatus,
  type IndexedGenomeViewerLoadPhase,
} from './indexed-genome-load-phase';
import { useAssemblyAnnotationFeatures } from './useAssemblyAnnotationFeatures';
import { assemblyOverviewTextureReadRequestForAssembly } from './useAssemblyOverviewTexture';
import { useAssemblyPrepackedAnnotationSceneCache } from './useAssemblyPrepackedAnnotationSceneCache';
import type { AssemblySessionChromConfig } from './assembly-session-registry';
import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '@waypoint/genome-renderer/pure';
import { IndexedGenomeTabChrome, IndexedGenomeTabShell } from './IndexedGenomeTabChrome';
import { IndexedGenomeTabRuntime } from './IndexedGenomeTabRuntime';
import type {
  IndexedGenomeContextMenuHandler,
  IndexedGenomeSelectionChangeHandler,
} from './IndexedGenomeTileNativeMap';
import {
  IndexedGenomeAnnotationDialog,
  type IndexedGenomeAnnotationDialogState,
} from './IndexedGenomeAnnotationDialog';
import { useIndexedGenomeTools } from './IndexedGenomeTools';
import { buildStructureDrawerRequestFromIndexedCds } from '../../structure-drawer/public/api/build-structure-request';
import {
  indexedAnnotationBadgeType,
  type HostedBackgroundPreparationState,
} from './indexed-genome-tab-status';
import {
  firstPresent,
  indexedGenomeAssemblyAdmissionReady,
  indexedGenomeAssemblyAnnotationProductsReady,
  indexedGenomeAssemblyAnnotationsNotApplicable,
  indexedGenomeAssemblyIdeogramOnly,
  indexedGenomeAssemblySourceReady,
  indexedGenomeAxisLength,
  indexedGenomeDisplayedViewportRange,
  indexedGenomeFullAssemblyReadinessRequired,
  indexedGenomeLaneAssemblyId,
  indexedGenomeOpenSourceSizeBytes,
  indexedGenomePrepareLoadPhase,
  indexedGenomeRangeEnd,
  indexedGenomeAdmittedAnnotationSceneRequest,
  indexedGenomeSearchSources,
  indexedGenomeTabViewerGate,
  indexedGenomeViewerAnnotationSceneRequest,
  indexedGenomeThemeMode,
  indexedGenomeViewerPresentationOwnerKey,
  indexedGenomeVisibleHostedBackgroundPreparation,
} from './indexed-genome-tab-readiness';
import { useGenomeSearch, type IndexedGenomeSearchMatch } from '../hooks/useGenomeSearch';
import { autoZoomToFeature } from '../auto-zoom-to-feature';
import { pickIndexedGenomeWorkspaceRoot } from '../indexed-genome-workspace-root';
import {
  prepareCurrentAssemblyAnnotationProductSet,
  type PreparedAssemblyAnnotationProductSet,
  type PrepareCurrentAssemblyAnnotationProductSetOptions,
} from '../prepareAssemblyAnnotationProductSet';
import type { AnnotationIndex } from '../genome-annotation-index';
import { useCommandHandler, useCommandScope, COMMAND_IDS, COMMAND_SCOPES } from '../../../commands';
import { useDarkMode } from '../../../shared/context/DarkModeContext';
import { usePersistedBamTracks } from './usePersistedBamTracks';
import { openAssembly } from '../openAssembly';
import { savePortableGenomeViewDocument } from '../portable-genome-view-file';
import {
  createPortableGenomeViewDocument,
  portableReferenceFromIndexedGenome,
  resolvePortableGenomeViewViewport,
} from '../portable-genome-view-roundtrip';
import { indexedGenomeDataTrackFromLane } from '../ucsc-track-persistence';
import { indexedGenomeSignalReadPileupViewFromLane } from '../experimental-hybrid-pileup';
import { usePersistedVariantTrack } from './usePersistedVariantTrack';
import { usePersistedDataTracks } from './usePersistedUcscTracks';
import { usePersistedSignalReadPileupViews } from './usePersistedSignalReadPileupViews';
import type { FeatureDetailsState } from './useIndexedFeatureDetails';
import {
  formatIndexedCoordinateInput,
  parseIndexedCoordinateInput,
} from './indexed-coordinate-input';
import { useIndexedGenomeTabPersist } from './useIndexedGenomeTabPersist';
import { retainLaneOwner } from '../lane-owner-lifecycle';
import { useLaneContractStore } from '../lane-contract-store';
import { useMutationNavigator } from './useMutationNavigator';
import {
  mutationChromosomeGlobalRange,
  mutationGlobalRange,
  mutationViewport,
} from '../mutation-navigation';
import type { VariantSummary } from '../variant-client';
import {
  registerIndexedLiveViewportReader,
  type IndexedViewportCommandReceipt,
} from '../indexed-live-viewport';
import {
  normalizeIndexedViewportForPersistence,
  projectIndexedAssemblyLiveViewport,
  projectIndexedLiveViewport,
  projectIndexedViewportCommand,
  takeIndexedViewportCommand,
} from '../indexed-viewport-command';
import { isLocalReferenceAssemblyId } from '../reference-asset-publication';
import {
  indexedManifestForTarget,
  projectIndexedRendererRange,
  projectIndexedRendererSelection,
  runIndexedSequenceAction,
  type IndexedSequenceActionTarget,
} from '../indexed-sequence-actions';
import {
  deleteIndexedUserAnnotation,
  findIndexedUserAnnotationAtRendererPosition,
  indexedUserAnnotationDataset,
  trackViewUserLayers,
  upsertIndexedUserAnnotation,
} from '../indexed-user-annotations';
import { showCopiedSequenceToast } from './useSequenceClipboardActions';
import { useTranslationDialogStore } from '../translation-dialog-store';
import { recordProtein } from '../../proteins/public/record-proteins';
import {
  CreateAminoAcidSequenceDialog,
  type PendingAminoAcidCreation,
} from '../../proteins/public/components/CreateAminoAcidSequenceDialog';
import { openLimsEntity } from '../../lims/public/open-entity';
import {
  createPlatformIndexedGenomeDataSource,
  isIndexedSourceUnavailable,
} from '../../../shared/platform-indexed-genome-data-source';
import { withoutSessionReadinessDemotion } from '../../../shared/genome-session-readiness';
import {
  IndexedGenomeIsoformDialog,
  type IndexedGenomeIsoformDialogState,
} from './IndexedGenomeIsoformDialog';
import {
  isIndexedTranscriptFeatureType,
  resolveIndexedTranscriptIsoforms,
  type IndexedTranscriptIsoform,
} from './indexed-transcript-isoforms';
import type { PrimerArtifactLocation } from '../primer-menu-actions';

const NO_PRIMER_BINDINGS: readonly IndexedGenomePrimerBinding[] = [];

interface IndexedGenomeTabProps {
  tab: Tab;
  isActive?: boolean;
}

type PrepareStatus = IndexedGenomePrepareStatus;
type PrepareLoadPhase = IndexedGenomePrepareLoadPhase;
type ViewerLoadPhase = IndexedGenomeViewerLoadPhase;
type RangeStatus = 'idle' | 'loading' | 'error';

type IndexedCdsActionTarget = {
  kind: 'reference' | 'user';
  annotation: Annotation;
  target: IndexedSequenceActionTarget;
  strand: '+' | '-';
  featureId?: string;
};

type IndexedTranscriptActionTarget = {
  name: string;
  target: IndexedSequenceActionTarget;
  strand: '+' | '-';
  featureId: string;
};

type IndexedSequenceContextMenuState = {
  x: number;
  y: number;
  selectionTarget: IndexedSequenceActionTarget | null;
  clickedPrimer: IndexedGenomePrimerBinding | null;
  clickedUserAnnotation: IndexedGenomeUserAnnotation | null;
  clickedCds: IndexedCdsActionTarget | null;
  clickedTranscript: IndexedTranscriptActionTarget | null;
};

type IndexedCdsTranslation = {
  protein: string;
  incompleteCodon: boolean;
};

function transcriptActionTargetFromIsoform(
  isoform: IndexedTranscriptIsoform
): IndexedTranscriptActionTarget {
  return {
    name: isoform.name,
    target: { chrom: isoform.chrom, start0: isoform.start0, end0: isoform.end0 },
    strand: isoform.strand,
    featureId: isoform.featureId,
  };
}

const EMPTY_INDEXED_USER_ANNOTATIONS: ReadonlyArray<IndexedGenomeUserAnnotation> = [];

function preparedAssemblyProductFromAdmittedTabState(
  state: IndexedGenomeTabState | null
): PreparedAssemblyAnnotationProductSet | null {
  if (
    !state?.assembly ||
    state.assemblyAnnotationProductsReadiness !== 'ready' ||
    !state.assemblyAssetGeneration ||
    !state.assemblySearchSource
  ) {
    return null;
  }
  return {
    assembly: state.assembly,
    annotationProductsReadiness: 'ready',
    searchReadiness: state.assemblySearchReadiness === 'ready' ? 'ready' : 'pending',
    generation: state.assemblyAssetGeneration,
    searchSource: state.assemblySearchSource,
    ...(state.assemblyAnnotationTrackTypes
      ? { trackTypes: [...state.assemblyAnnotationTrackTypes] }
      : {}),
  };
}

export function tabStateWithPreparedAssemblyProduct(
  tabState: IndexedGenomeTabState,
  prepared: PreparedAssemblyAnnotationProductSet | null
): IndexedGenomeTabState {
  if (!prepared) return tabState;
  return {
    ...tabState,
    assembly: prepared.assembly,
    assemblySourceReadiness: 'ready',
    assemblyAnnotationProductsReadiness: prepared.annotationProductsReadiness,
    assemblySearchReadiness: prepared.searchReadiness,
    ...(prepared.searchSource ? { assemblySearchSource: prepared.searchSource } : {}),
    ...(prepared.generation ? { assemblyAssetGeneration: prepared.generation } : {}),
    ...(prepared.trackTypes ? { assemblyAnnotationTrackTypes: [...prepared.trackTypes] } : {}),
  };
}

export function genomeSessionCapabilityUpgradeSource(input: {
  indexedState: IndexedGenomeTabState | null;
  workspaceRoot: string | null;
}): GenomeOpenSource | null {
  const state = input.indexedState;
  if (
    !state?.assembly ||
    !state.manifest ||
    !input.workspaceRoot ||
    state.assemblyAnnotationProductsReadiness !== 'ready' ||
    !state.assemblyAssetGeneration ||
    !state.assemblySearchSource
  ) {
    return null;
  }
  return {
    sourcePath: state.sourcePath,
    workspaceRoot: input.workspaceRoot,
    chrom: state.chrom,
    sourceSizeBytes: state.sourceSizeBytes,
    sourceExt: state.sourceExt,
    manifest: state.manifest,
    intent: {
      kind: 'reference-assembly',
      annotationProductsReadiness: 'ready',
      searchReadiness: state.assemblySearchReadiness === 'ready' ? 'ready' : 'pending',
      assetGeneration: state.assemblyAssetGeneration,
      searchSource: state.assemblySearchSource,
    },
  };
}

function deriveHostedBackgroundPreparation(
  indexedState: IndexedGenomeTabState | null
): HostedBackgroundPreparationState {
  const assembly = indexedState?.assembly;
  if (!assembly) return { status: 'idle' };
  if (indexedState.assemblySourceReadiness === 'pending') {
    return {
      status: 'preparing',
      label: `Preparing ${assembly.displayName} reference`,
    };
  }
  if (
    indexedState.assemblyAnnotationProductsReadiness === 'pending' ||
    indexedState.assemblySearchReadiness === 'pending'
  ) {
    return {
      status: 'preparing',
      label: `Preparing ${assembly.displayName} annotations and search`,
    };
  }
  return { status: 'idle' };
}

const DEFAULT_WINDOW_SIZE = 2_000;
const INDEXED_VIEWPORT_PERSIST_DEBOUNCE_MS = 120;

function annotationDirectionForRenderer(
  direction: 'forward' | 'reverse' | 'none' | undefined
): -1 | 0 | 1 {
  if (direction === 'forward') return 1;
  if (direction === 'reverse') return -1;
  return 0;
}

function chromosomeLengthForIndexedTarget(
  chrom: string,
  assembly: IndexedGenomeTabState['assembly'],
  manifest: IndexedGenomeManifest | null,
  fallbackLength: number
): number {
  return (
    assembly?.chromosomes.find((candidate) => candidate.chrom === chrom)?.length ??
    (manifest?.chrom === chrom ? (manifest.length ?? fallbackLength) : fallbackLength)
  );
}

let fallbackIndexedAnnotationId = 0;

function allocateIndexedAnnotationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  fallbackIndexedAnnotationId += 1;
  return `indexed-annotation-${Date.now()}-${fallbackIndexedAnnotationId}`;
}

type IndexedViewportRange = { start: number; end: number };

export { indexedAnnotationBadgeType };

export function IndexedGenomeTab({ tab, isActive = true }: IndexedGenomeTabProps) {
  const presentationEvents = usePresentationListener();
  const presentation = usePresentationScope();

  useEffect(() => retainLaneOwner(tab.id), [tab.id]);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const workspace = useWorkspace();
  const { darkMode } = useDarkMode();
  const viewerThemeMode = indexedGenomeThemeMode(darkMode);
  const annotationProductThemeMode = INDEXED_ANNOTATION_COLOR_BASIS_THEME;
  const workspaceFolders = useWorkspaceStore((s) => s.folders);

  const initialIndexedState = tab.indexedGenome;
  const [localIndexedState, setIndexedState] = useState<IndexedGenomeTabState | null>(
    initialIndexedState ?? null
  );
  const storedIndexedState = useCanvasStore(
    (state) =>
      Object.values(state.panels)
        .flatMap((panel) => panel.tabs)
        .find((candidate) => candidate.id === tab.id)?.indexedGenome
  );
  const indexedState = storedIndexedState ?? localIndexedState;
  const assembly = indexedState?.assembly;
  const scope = indexedState?.scope;
  const assemblySourceReady = indexedGenomeAssemblySourceReady(
    Boolean(assembly),
    indexedState?.assemblySourceReadiness
  );
  const assemblyAnnotationsNotApplicable = indexedGenomeAssemblyAnnotationsNotApplicable(
    Boolean(assembly),
    indexedState?.assemblyAnnotationProductsReadiness
  );
  const assemblyAnnotationProductsReady = indexedGenomeAssemblyAnnotationProductsReady(
    Boolean(assembly),
    indexedState?.assemblyAnnotationProductsReadiness
  );
  const [hostedBackgroundPreparation, setHostedBackgroundPreparation] =
    useState<HostedBackgroundPreparationState>({ status: 'idle' });
  const visibleHostedBackgroundPreparation = indexedGenomeVisibleHostedBackgroundPreparation(
    hostedBackgroundPreparation,
    deriveHostedBackgroundPreparation(indexedState)
  );
  const [annotationProductAdmissionGeneration, setAnnotationProductAdmissionGeneration] =
    useState(0);
  const assemblyReferenceKindRef = useRef<'hosted' | 'local' | null>(null);
  const [assemblyAdmission, setAssemblyAdmission] = useState<{
    assemblyId: string | null;
    status: 'checking' | 'ready';
  }>(() => ({
    assemblyId: assembly?.assemblyId ?? null,
    status: assembly ? 'checking' : 'ready',
  }));
  const assemblyAdmissionReady = indexedGenomeAssemblyAdmissionReady({
    hasAssembly: Boolean(assembly),
    assemblyId: assembly?.assemblyId,
    admissionAssemblyId: assemblyAdmission.assemblyId,
    admissionStatus: assemblyAdmission.status,
  });
  const assemblyIdeogramOnly = indexedGenomeAssemblyIdeogramOnly(
    Boolean(assembly),
    assemblySourceReady
  );
  const allowTrackOnlyInteraction = assemblyIdeogramOnly;
  const assemblyChromIds = useMemo(() => assembly?.chromosomes.map((c) => c.chrom), [assembly]);
  const chromGffPaths = useMemo<ReadonlyMap<string, string> | undefined>(() => {
    if (!assembly || !assemblySourceReady) return undefined;
    return new Map(
      assembly.chromosomes.flatMap((chromosome) => {
        const gffPath = chromosome.manifest.gffPath;
        return typeof gffPath === 'string' && gffPath.length > 0
          ? ([[chromosome.chrom, gffPath]] as const)
          : [];
      })
    );
  }, [assembly, assemblySourceReady]);
  const indexedStateRef = useRef<IndexedGenomeTabState | null>(indexedState);
  const latestAdmittedAssemblyProductRef = useRef<PreparedAssemblyAnnotationProductSet | null>(
    null
  );
  const lastAppliedSessionUpdateFingerprintRef = useRef<string | null>(null);
  const capabilityUpgradeTailRef = useRef<Promise<void>>(Promise.resolve());
  const requestedCapabilityUpgradeKeyRef = useRef<string | null>(null);
  indexedStateRef.current = indexedState;
  useEffect(() => {
    const next = tab.indexedGenome ?? null;
    if (indexedStateRef.current === next) return;
    indexedStateRef.current = next;
    setIndexedState(next);
  }, [tab.indexedGenome]);

  useEffect(() => {
    assemblyReferenceKindRef.current = null;
    latestAdmittedAssemblyProductRef.current = null;
    setHostedBackgroundPreparation({ status: 'idle' });
    setAnnotationProductAdmissionGeneration(0);
  }, [assembly?.assemblyId]);

  useEffect(() => {
    const assemblyId = assembly?.assemblyId;
    if (!assemblyId) return;
    const referenceAssets = platform().referenceAssets;
    if (!referenceAssets) return;

    let cancelled = false;
    let refreshing = false;
    type PublicationRefreshRequest =
      | Readonly<{ kind: 'hosted'; intent: 'open-view' | 'require-ready' }>
      | Readonly<{ kind: 'hosted-entry'; entry: PreparedReferenceAssemblyEntryV1 }>
      | Readonly<{ kind: 'local' }>;
    let queuedRefresh: PublicationRefreshRequest | null = null;
    let unsubscribeHosted = (): void => undefined;
    let unsubscribeLocal = (): void => undefined;
    let localStatusReconciliationTimer: ReturnType<typeof setTimeout> | null = null;
    let localReadyAdmissionAttempts = 0;
    let reconcileDurableLocalPreparation: (() => Promise<void>) | null = null;
    const localCapabilitiesPending = (): boolean => {
      const current = indexedStateRef.current;
      return (
        current?.assemblyAnnotationProductsReadiness === 'pending' ||
        current?.assemblySearchReadiness === 'pending'
      );
    };
    const scheduleLocalStatusReconciliation = (delayMs = 250): void => {
      if (
        cancelled ||
        assemblyReferenceKindRef.current !== 'local' ||
        !localCapabilitiesPending() ||
        localStatusReconciliationTimer !== null ||
        !reconcileDurableLocalPreparation
      ) {
        return;
      }
      localStatusReconciliationTimer = setTimeout(() => {
        localStatusReconciliationTimer = null;
        void reconcileDurableLocalPreparation?.();
      }, delayMs);
    };
    const markAdmissionReady = (): void => {
      if (cancelled) return;
      setAssemblyAdmission({ assemblyId, status: 'ready' });
      setHostedBackgroundPreparation({ status: 'idle' });
    };
    const refreshCurrentPublication = async (
      request: PublicationRefreshRequest
    ): Promise<boolean> => {
      if (refreshing) return false;
      refreshing = true;
      try {
        const entry =
          request.kind === 'hosted'
            ? (
                await referenceAssets.installHosted({
                  catalogId: assemblyId,
                  themeMode: annotationProductThemeMode,
                  intent: request.intent,
                })
              ).entry
            : request.kind === 'hosted-entry'
              ? request.entry
              : (await referenceAssets.listLocal()).find(
                  (candidate) => candidate.id === assemblyId
                );
        if (!entry) {
          throw new Error('The prepared local reference is no longer available.');
        }
        if (cancelled) return false;
        const refreshedTabId = await openAssembly(entry, {
          annotationThemeMode: annotationProductThemeMode,
          refreshExistingTabOnly: true,
          viewEntity: { id: tab.entityId, name: tab.label },
          ...(tab.trackView
            ? {
                validateReference: (state: IndexedGenomeTabState) =>
                  assertTrackViewReference(tab.trackView!.document, state),
              }
            : {}),
        });
        if (cancelled) return false;
        if (!refreshedTabId) {
          throw new Error('The open reference tab could not be refreshed.');
        }
        const refreshedState = Object.values(useCanvasStore.getState().panels)
          .flatMap((panel) => panel.tabs)
          .find((candidate) => candidate.entityId === tab.entityId)?.indexedGenome;
        if (refreshedState) {
          latestAdmittedAssemblyProductRef.current =
            preparedAssemblyProductFromAdmittedTabState(refreshedState);
          indexedStateRef.current = refreshedState;
          setIndexedState(refreshedState);
        }
        return true;
      } catch (error) {
        if (!cancelled) {
          setHostedBackgroundPreparation({
            status: 'failed',
            message: toUserMessage(error, 'failure.the-prepared-reference-could-not-be-admitted'),
          });
        }
        return false;
      } finally {
        refreshing = false;
      }
    };
    const requestRefresh = (request: PublicationRefreshRequest): void => {
      if (refreshing) {
        if (queuedRefresh?.kind !== 'hosted' || queuedRefresh.intent !== 'require-ready') {
          queuedRefresh = request;
        }
        return;
      }
      void refreshCurrentPublication(request)
        .then((admitted) => {
          if (admitted) markAdmissionReady();
        })
        .finally(() => {
          const queued = queuedRefresh;
          queuedRefresh = null;
          if (queued && !cancelled) {
            requestRefresh(queued);
          } else if (request.kind === 'local') {
            scheduleLocalStatusReconciliation();
          }
        });
    };

    reconcileDurableLocalPreparation = async (): Promise<void> => {
      if (
        cancelled ||
        assemblyReferenceKindRef.current !== 'local' ||
        !localCapabilitiesPending() ||
        typeof referenceAssets.getLocalPreparationStatus !== 'function'
      ) {
        return;
      }
      const durableStatus = await referenceAssets
        .getLocalPreparationStatus({ assemblyId })
        .catch(() => null);
      if (cancelled || !localCapabilitiesPending()) return;
      if (durableStatus?.status === 'failed') {
        setHostedBackgroundPreparation({
          status: 'failed',
          message: durableStatus.label,
        });
        return;
      }
      if (durableStatus?.status !== 'ready') {
        scheduleLocalStatusReconciliation(500);
        return;
      }
      if (localReadyAdmissionAttempts >= 3) {
        setHostedBackgroundPreparation({
          status: 'failed',
          message:
            'Reference preparation finished, but the published annotation and search generation could not be admitted.',
        });
        return;
      }
      localReadyAdmissionAttempts += 1;
      setAnnotationProductAdmissionGeneration((generation) => generation + 1);
      requestRefresh({ kind: 'local' });
    };

    const classifyAndAdmit = async (): Promise<void> => {
      if (typeof referenceAssets.listHosted !== 'function') {
        markAdmissionReady();
        return;
      }
      let hostedEntries: Awaited<ReturnType<typeof referenceAssets.listHosted>>;
      try {
        hostedEntries = isLocalReferenceAssemblyId(assemblyId)
          ? []
          : await referenceAssets.listHosted();
      } catch (error) {
        if (!cancelled) {
          setHostedBackgroundPreparation({
            status: 'failed',
            message: toUserMessage(
              error,
              'failure.the-hosted-reference-catalog-could-not-be-checked'
            ),
          });
        }
        return;
      }
      if (cancelled) return;
      if (!hostedEntries.some((entry) => entry.id === assemblyId)) {
        assemblyReferenceKindRef.current = 'local';
        markAdmissionReady();
        if (
          typeof referenceAssets.onPreparationProgress === 'function' &&
          typeof referenceAssets.listLocal === 'function'
        ) {
          unsubscribeLocal = referenceAssets.onPreparationProgress((progress) => {
            if (progress.assemblyId !== assemblyId) return;
            if (progress.phase === 'background-preparation-failed') {
              setHostedBackgroundPreparation({
                status: 'failed',
                message: progress.label,
              });
            } else if (progress.phase === 'ready') {
              setAnnotationProductAdmissionGeneration((generation) => generation + 1);
              requestRefresh({ kind: 'local' });
            } else {
              setHostedBackgroundPreparation((current) =>
                current.status === 'retrying'
                  ? { status: 'retrying', label: progress.label }
                  : { status: 'preparing', label: progress.label }
              );
            }
          });
          const current = indexedStateRef.current;
          const canReconcileDurableStatus =
            typeof referenceAssets.getLocalPreparationStatus === 'function';
          const durableStatus = canReconcileDurableStatus
            ? await referenceAssets.getLocalPreparationStatus({ assemblyId }).catch(() => null)
            : null;
          if (cancelled) return;
          if (durableStatus?.status === 'failed') {
            setHostedBackgroundPreparation({
              status: 'failed',
              message: durableStatus.label,
            });
          } else if (
            canReconcileDurableStatus &&
            durableStatus === null &&
            (current?.assemblyAnnotationProductsReadiness === 'pending' ||
              current?.assemblySearchReadiness === 'pending')
          ) {
            setHostedBackgroundPreparation({
              status: 'failed',
              message:
                'Reference preparation was interrupted before its status was saved. Retry to finish annotations and search.',
            });
          } else if (
            current?.assemblyAnnotationProductsReadiness === 'pending' ||
            current?.assemblySearchReadiness === 'pending'
          ) {
            requestRefresh({ kind: 'local' });
          }
        }
        return;
      }
      assemblyReferenceKindRef.current = 'hosted';
      unsubscribeHosted = referenceAssets.onHostedInstallProgress((progress) => {
        if (progress.catalogId !== assemblyId) return;
        if (progress.phase === 'background-preparation-failed') {
          setHostedBackgroundPreparation({
            status: 'failed',
            message: progress.label,
          });
        } else if (progress.phase === 'ready') {
          requestRefresh({ kind: 'hosted', intent: 'require-ready' });
        } else if (progress.phase === 'detail-ready') {
          void referenceAssets
            .getHostedPreparationStatus({
              catalogId: assemblyId,
              themeMode: annotationProductThemeMode,
            })
            .then((status) => {
              if (
                !cancelled &&
                (status?.status === 'annotation-ready' || status?.status === 'ready')
              ) {
                requestRefresh({ kind: 'hosted-entry', entry: status.entry });
              }
            })
            .catch((error) => {
              if (!cancelled) {
                setHostedBackgroundPreparation({
                  status: 'failed',
                  message: toUserMessage(
                    error,
                    'failure.prepared-annotation-detail-could-not-be-admitted'
                  ),
                });
              }
            });
        } else {
          const current = indexedStateRef.current;
          const alreadyFullyAdmitted =
            current?.assemblySourceReadiness === 'ready' &&
            (current.assemblyAnnotationProductsReadiness === 'ready' ||
              current.assemblyAnnotationProductsReadiness === 'not-applicable') &&
            (current.assemblySearchReadiness === 'ready' ||
              current.assemblySearchReadiness === 'not-applicable');
          setHostedBackgroundPreparation((current) =>
            alreadyFullyAdmitted
              ? { status: 'idle' }
              : current.status === 'retrying'
                ? { status: 'retrying', label: progress.label }
                : { status: 'preparing', label: progress.label }
          );
        }
      });
      requestRefresh({ kind: 'hosted', intent: 'open-view' });
    };
    void classifyAndAdmit();

    return () => {
      cancelled = true;
      if (localStatusReconciliationTimer !== null) {
        clearTimeout(localStatusReconciliationTimer);
        localStatusReconciliationTimer = null;
      }
      unsubscribeHosted();
      unsubscribeLocal();
    };
  }, [annotationProductThemeMode, assembly?.assemblyId, tab.entityId]);

  const externallyAttachedVariantSource = tab.indexedGenome?.variantSource;
  useEffect(() => {
    if (!externallyAttachedVariantSource) return;
    const current = indexedStateRef.current;
    if (
      !current ||
      current.variantSource?.sourceIdentity === externallyAttachedVariantSource.sourceIdentity
    ) {
      return;
    }
    const next = { ...current, variantSource: externallyAttachedVariantSource };
    indexedStateRef.current = next;
    setIndexedState(next);
  }, [externallyAttachedVariantSource]);
  const genomeOpenSourcePath = indexedState?.sourcePath ?? tab.entityId;
  const viewerPresentationOwnerKey = indexedGenomeViewerPresentationOwnerKey(
    assembly?.assemblyId,
    genomeOpenSourcePath
  );
  const [prepareStatus, setPrepareStatus] = useState<PrepareStatus>('preparing');
  const viewerPresentationRef = useRef<string | null>(null);
  const [prepareLoadPhase, setPrepareLoadPhase] = useState<PrepareLoadPhase>(
    indexedGenomePrepareLoadPhase(Boolean(initialIndexedState?.manifest))
  );
  const [prepareError, setPrepareError] = useState<UserMessage | null>(
    toOptionalUserMessage(initialIndexedState?.error, 'tracks.loadFailed') ?? null
  );
  const [viewerLoadPhase, setViewerLoadPhase] = useState<ViewerLoadPhase>('loading');
  const [viewerLoadError, setViewerLoadError] = useState<UserMessage | null>(null);
  const [sessionShell, setSessionShell] = useState<GenomeSessionShell | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  currentSessionIdRef.current = sessionShell?.sessionId ?? null;
  const lifecycleOwnerRef = useRef<{
    source: string;
    sessionId: string | null;
    operation: IndexedGenomeOpenTelemetry;
  } | null>(null);
  const handleViewportPresented = useCallback((sessionId: string, commandId: number | null) => {
    const owner = lifecycleOwnerRef.current;
    if (owner?.sessionId !== sessionId || currentSessionIdRef.current !== sessionId) return;
    if (commandId === null) owner.operation.firstViewportPresented();
    else owner.operation.viewportPresented(commandId);
  }, []);
  const [rangeStatus, setRangeStatus] = useState<RangeStatus>('idle');
  const [rangeError, setRangeError] = useState<UserMessage | null>(null);
  const [rangeStart, setRangeStart] = useState(0);
  const [liveViewportRange, setLiveViewportRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const liveViewportRangeRef = useRef<{ start: number; end: number } | null>(null);
  const [viewportCommand, setViewportCommand] = useState<{
    id: number;
    start: number;
    end: number;
  } | null>(null);
  const [searchHighlight, setSearchHighlight] = useState<{
    id: number;
    start: number;
    end: number;
    featureType?: string;
    annotationTrackId?: string;
    canonicalIdentity?: string;
    annotationFeatureIndex?: number;
    proteinSegments?: ReadonlyArray<Readonly<{ start: number; end: number }>>;
  } | null>(null);
  const [selectedRendererRange, setSelectedRendererRange] = useState<
    readonly [number, number] | null
  >(null);
  const [sequenceContextMenu, setSequenceContextMenu] =
    useState<IndexedSequenceContextMenuState | null>(null);
  const [annotationDialog, setAnnotationDialog] =
    useState<IndexedGenomeAnnotationDialogState | null>(null);
  const [isoformDialog, setIsoformDialog] = useState<IndexedGenomeIsoformDialogState | null>(null);
  const [pendingProteinCreation, setPendingProteinCreation] =
    useState<PendingAminoAcidCreation | null>(null);
  const [isCreatingProtein, setIsCreatingProtein] = useState(false);
  const [annotationIndex, setAnnotationIndex] = useState<AnnotationIndex | null>(null);
  const [visibleAnnotationTrackIds, setVisibleAnnotationTrackIds] =
    useState<ReadonlySet<string> | null>(null);
  const [orderedAnnotationTrackIds, setOrderedAnnotationTrackIds] =
    useState<ReadonlyArray<string> | null>(null);
  const [positionInput, setPositionInput] = useState('1');
  const [featureDetailsState, setFeatureDetailsState] = useState<FeatureDetailsState>({
    kind: 'idle',
  });
  const [windowSize, setWindowSize] = useState(DEFAULT_WINDOW_SIZE);
  const viewportCommandIdRef = useRef(0);
  const isoformRequestIdRef = useRef(0);
  const searchHighlightIdRef = useRef(0);
  const indexedViewportCommandIdRef = useRef<number | null>(null);
  const indexedViewportCommandReceiptRef = useRef<IndexedViewportCommandReceipt | null>(null);
  const initialIndexedViewportRef = useRef<{
    tabId: string;
    range: { start0: number; end0: number } | null;
  }>({
    tabId: tab.id,
    range: tab.viewState?.indexedViewport ?? null,
  });
  if (initialIndexedViewportRef.current.tabId !== tab.id) {
    initialIndexedViewportRef.current = {
      tabId: tab.id,
      range: tab.viewState?.indexedViewport ?? null,
    };
  }
  const appliedInitialIndexedViewportRef = useRef<string | null>(null);
  const pendingIndexedViewportCommitRef = useRef<number | null>(null);
  const pendingIndexedViewportPersistRef = useRef<IndexedViewportRange | null>(null);
  const indexedViewportPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indexedViewportLengthRef = useRef(0);
  const pendingIndexedViewportCommandRef = useRef<{
    viewerCommandId: number;
    toolCommandId: number;
    requested: { chrom: string; start0: number; end0: number };
  } | null>(null);

  const flushIndexedViewportPersist = useCallback(() => {
    if (indexedViewportPersistTimerRef.current !== null) {
      clearTimeout(indexedViewportPersistTimerRef.current);
      indexedViewportPersistTimerRef.current = null;
    }
    const pending = pendingIndexedViewportPersistRef.current;
    pendingIndexedViewportPersistRef.current = null;
    if (!pending) return;

    const canvas = useCanvasStore.getState();
    for (const [panelId, panel] of Object.entries(canvas.panels)) {
      const currentTab = panel.tabs.find((candidate) => candidate.id === tab.id);
      if (!currentTab) continue;
      if (currentTab.type !== 'sequence' || currentTab.entityId !== tab.entityId) return;
      const currentViewport = currentTab.viewState?.indexedViewport;
      if (
        currentViewport &&
        currentViewport.start0 === pending.start &&
        currentViewport.end0 === pending.end
      ) {
        return;
      }
      canvas.setTabViewState(panelId, currentTab.id, {
        indexedViewport: { start0: pending.start, end0: pending.end },
      });
      return;
    }
  }, [tab.entityId, tab.id]);

  const scheduleIndexedViewportPersist = useCallback(
    (range: IndexedViewportRange | null) => {
      const normalized = normalizeIndexedViewportForPersistence(
        range,
        indexedViewportLengthRef.current
      );
      if (!normalized) return;
      pendingIndexedViewportPersistRef.current = {
        start: normalized.start0,
        end: normalized.end0,
      };
      if (indexedViewportPersistTimerRef.current !== null) {
        clearTimeout(indexedViewportPersistTimerRef.current);
      }
      indexedViewportPersistTimerRef.current = setTimeout(
        flushIndexedViewportPersist,
        INDEXED_VIEWPORT_PERSIST_DEBOUNCE_MS
      );
    },
    [flushIndexedViewportPersist]
  );

  useEffect(() => {
    const flush = () => flushIndexedViewportPersist();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flushIndexedViewportPersist();
    };
  }, [flushIndexedViewportPersist]);

  useEffect(() => {
    const command = tab.viewState?.indexedViewportCommand;
    const local = takeIndexedViewportCommand(indexedViewportCommandIdRef.current, command);
    if (!local || !command) return;
    const next = projectIndexedViewportCommand(local, assembly);
    if (!next) return;
    const viewerCommandId = ++viewportCommandIdRef.current;
    lifecycleOwnerRef.current?.operation.acceptViewport(viewerCommandId);
    pendingIndexedViewportCommandRef.current = {
      viewerCommandId,
      toolCommandId: command.id,
      requested: { chrom: local.chrom, start0: local.start0, end0: local.end0 },
    };
    pendingIndexedViewportCommitRef.current = viewerCommandId;
    setViewportCommand({
      id: viewerCommandId,
      start: next.start,
      end: next.end,
    });
    setRangeStart(local.start0);
    setPositionInput(formatIndexedCoordinateInput(String(local.start0 + 1)));
  }, [assembly, tab.viewState?.indexedViewportCommand]);

  const pendingPortableViewportRef = useRef<{ viewerCommandId: number; restoreId: string } | null>(
    null
  );
  const [committedViewRestoreId, setCommittedViewRestoreId] = useState<string | null>(null);
  const handleTargetViewportCommitted = useCallback(
    (committed: { id: number; start: number; end: number }) => {
      if (pendingIndexedViewportCommitRef.current !== committed.id) return;
      pendingIndexedViewportCommitRef.current = null;
      scheduleIndexedViewportPersist(committed);
      const restoring = pendingPortableViewportRef.current;
      if (restoring?.viewerCommandId === committed.id) {
        pendingPortableViewportRef.current = null;
        const range = { start: committed.start, end: committed.end };
        liveViewportRangeRef.current = range;
        setLiveViewportRange(range);
        setCommittedViewRestoreId(restoring.restoreId);
      }
      const pending = pendingIndexedViewportCommandRef.current;
      if (!pending || pending.viewerCommandId !== committed.id) return;
      const range = { start: committed.start, end: committed.end };
      const projected = assembly
        ? projectIndexedAssemblyLiveViewport(range, assembly)
        : projectIndexedLiveViewport(pending.requested.chrom, range);
      if (!projected) return;
      liveViewportRangeRef.current = range;
      indexedViewportCommandReceiptRef.current = {
        commandId: pending.toolCommandId,
        requested: pending.requested,
        committed: projected,
        globalRange: range,
      };
      indexedViewportCommandIdRef.current = pending.toolCommandId;
      pendingIndexedViewportCommandRef.current = null;
    },
    [assembly, scheduleIndexedViewportPersist]
  );

  const manifest = indexedState?.manifest ?? null;
  const sourceExtForValidation = indexedState?.sourceExt ?? extensionForPath(genomeOpenSourcePath);
  const length = indexedGenomeAxisLength(
    assembly,
    assemblyTotalLengthBp,
    indexedState?.metadata?.length,
    manifest?.length
  );
  indexedViewportLengthRef.current = length;
  useEffect(() => {
    const saved = initialIndexedViewportRef.current.range;
    if (
      !saved ||
      !manifest ||
      length <= 0 ||
      tab.viewState?.indexedViewportCommand ||
      tab.viewState?.indexedGenomeViewRestoreCommand
    ) {
      return;
    }
    const key = `${initialIndexedViewportRef.current.tabId}:${saved.start0}:${saved.end0}`;
    if (appliedInitialIndexedViewportRef.current === key) return;
    const start = Math.max(0, Math.min(Math.max(0, length - 1), Math.floor(saved.start0)));
    const end = Math.max(start + 1, Math.min(length, Math.ceil(saved.end0)));
    const viewerCommandId = ++viewportCommandIdRef.current;
    pendingIndexedViewportCommitRef.current = viewerCommandId;
    appliedInitialIndexedViewportRef.current = key;
    setViewportCommand({ id: viewerCommandId, start, end });
    setRangeStart(start);
    setPositionInput(String(start + 1));
  }, [
    length,
    manifest,
    tab.viewState?.indexedGenomeViewRestoreCommand,
    tab.viewState?.indexedViewportCommand,
  ]);
  const variantReferences = useMemo(
    () =>
      assembly
        ? assembly.chromosomes.map(({ chrom, length: chromosomeLength }) => ({
            name: chrom,
            length: chromosomeLength,
          }))
        : manifest && length > 0
          ? [{ name: manifest.chrom, length }]
          : [],
    [assembly, length, manifest]
  );
  const mutationAnnotationManifests = useMemo<ReadonlyMap<string, IndexedGenomeManifest>>(
    () =>
      new Map(
        assembly
          ? assembly.chromosomes.map(
              ({ chrom, manifest: chromosomeManifest }) => [chrom, chromosomeManifest] as const
            )
          : manifest
            ? [[manifest.chrom, manifest] as const]
            : []
      ),
    [assembly, manifest]
  );
  const genomeOpenSourceSizeBytes = indexedGenomeOpenSourceSizeBytes(
    Boolean(assembly),
    tab.fileSizeBytes
  );
  const sourceMtimeMs = indexedState?.sourceMtimeMs;
  const sourceCtimeMs = indexedState?.sourceCtimeMs;
  const sourceTimestamps = useMemo(
    () => ({
      ...(typeof sourceMtimeMs === 'number' ? { sourceMtimeMs } : {}),
      ...(typeof sourceCtimeMs === 'number' ? { sourceCtimeMs } : {}),
    }),
    [sourceCtimeMs, sourceMtimeMs]
  );
  const workspaceRoot = useMemo(
    () =>
      indexedState?.workspaceRoot ??
      pickIndexedGenomeWorkspaceRoot(
        genomeOpenSourcePath,
        workspace.path,
        workspaceFolders.map((folder) => folder.path)
      ),
    [genomeOpenSourcePath, indexedState?.workspaceRoot, workspace.path, workspaceFolders]
  );
  const fileName = useMemo(
    () => genomeOpenSourcePath.replace(/\\/g, '/').split('/').pop() || tab.label,
    [genomeOpenSourcePath, tab.label]
  );
  const sourceChrom = firstPresent(
    indexedState?.chrom,
    initialIndexedState?.chrom,
    fileName.replace(/\.[^.]+$/, '')
  );
  useEffect(
    () =>
      registerIndexedLiveViewportReader(tab.id, () => {
        const range = liveViewportRangeRef.current;
        if (!range) return null;
        const projected = assembly
          ? projectIndexedAssemblyLiveViewport(range, assembly)
          : projectIndexedLiveViewport(
              indexedState?.chrom ?? manifest?.chrom ?? sourceChrom,
              range
            );
        return projected
          ? {
              ...projected,
              commandId: indexedViewportCommandIdRef.current,
              commandReceipt: indexedViewportCommandReceiptRef.current,
              globalRange: range,
            }
          : null;
      }),
    [assembly, indexedState?.chrom, manifest?.chrom, sourceChrom, tab.id]
  );
  const rangeEnd = indexedGenomeRangeEnd(length, rangeStart, windowSize);
  const displayedViewportRange = indexedGenomeDisplayedViewportRange(
    liveViewportRange,
    rangeStart,
    rangeEnd
  );
  const [annotationMapperPolicy, setAnnotationMapperPolicy] =
    useState<IndexedGenomeAnnotationMapperPolicy>(() => {
      const requested = tab.initialAnnotationMapperPolicy;
      const modeIsValid =
        requested?.isoformMode === 'canonical' || requested?.isoformMode === 'expanded';
      const laneIsValid =
        requested?.laneLimit === null ||
        (Number.isSafeInteger(requested?.laneLimit) && (requested?.laneLimit ?? 0) > 0);
      return modeIsValid && laneIsValid
        ? { isoformMode: requested.isoformMode, laneLimit: requested.laneLimit }
        : { ...DEFAULT_INDEXED_ANNOTATION_MAPPER_POLICY };
    });
  const portableViewRestoreCommand = tab.viewState?.indexedGenomeViewRestoreCommand;
  const appliedPortableViewRestoreCommandRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !portableViewRestoreCommand ||
      !assembly ||
      appliedPortableViewRestoreCommandRef.current === portableViewRestoreCommand.id
    ) {
      return;
    }
    const restoredViewport = resolvePortableGenomeViewViewport(
      portableViewRestoreCommand.viewport,
      assembly
    );
    appliedPortableViewRestoreCommandRef.current = portableViewRestoreCommand.id;
    setAnnotationMapperPolicy({ ...portableViewRestoreCommand.annotationPolicy });
    const viewerCommandId = ++viewportCommandIdRef.current;
    pendingPortableViewportRef.current = {
      viewerCommandId,
      restoreId: portableViewRestoreCommand.id,
    };
    pendingIndexedViewportCommitRef.current = viewerCommandId;
    setViewportCommand({
      id: viewerCommandId,
      start: restoredViewport.globalStart0,
      end: restoredViewport.globalEnd0,
    });
    setRangeStart(restoredViewport.globalStart0);
    setPositionInput(formatIndexedCoordinateInput(String(restoredViewport.globalStart0 + 1)));
    setSearchHighlight(null);
  }, [assembly, portableViewRestoreCommand]);
  const nextAnnotationMapperPolicyRequestIdRef = useRef(1);
  const allocateAnnotationMapperPolicyRequestId = useCallback(
    () => nextAnnotationMapperPolicyRequestIdRef.current++,
    []
  );
  const commitAnnotationMapperPolicy = useCallback((next: IndexedGenomeAnnotationMapperPolicy) => {
    setAnnotationMapperPolicy(next);
  }, []);
  const [savingPortableView, setSavingPortableView] = useState(false);
  const savePortableView = useCallback(async () => {
    const current = indexedStateRef.current;
    if (!current || savingPortableView) return;
    setSavingPortableView(true);
    try {
      const normalizedViewport = normalizeIndexedViewportForPersistence(
        liveViewportRangeRef.current,
        length
      );
      const liveViewport = normalizedViewport
        ? { start: normalizedViewport.start0, end: normalizedViewport.end0 }
        : null;
      const projectedLiveViewport = liveViewport
        ? assembly
          ? projectIndexedAssemblyLiveViewport(liveViewport, assembly)
          : projectIndexedLiveViewport(current.chrom, liveViewport)
        : null;
      const assemblyViewportRange =
        liveViewport && assembly && !projectedLiveViewport
          ? { start0: liveViewport.start, end0: liveViewport.end }
          : null;
      const currentVisible = visibleAnnotationTrackIds ?? new Set<string>();
      const currentOrder = orderedAnnotationTrackIds ?? [
        ...(current.assemblyAnnotationTrackTypes ?? []),
        ...[...currentVisible].filter(
          (trackId) => !(current.assemblyAnnotationTrackTypes ?? []).includes(trackId)
        ),
      ];
      const liveDataTracks = useLaneContractStore
        .getState()
        .lanesForOwner(tab.id)
        .flatMap((lane) => {
          const track = indexedGenomeDataTrackFromLane(lane);
          return track ? [track] : [];
        });
      const now = new Date().toISOString();
      const id = `view-${
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      }`;
      const projection = await createPortableGenomeViewDocument({
        id,
        name: `${current.assembly?.displayName ?? fileName} view`,
        createdAt: now,
        indexedGenome: {
          ...current,
          dataTracks: liveDataTracks,
          ucscTracks: undefined,
        },
        liveViewport: projectedLiveViewport,
        assemblyViewportRange,
        annotation: {
          policy: { ...annotationMapperPolicy },
          visibilityByTrackId: Object.fromEntries(
            currentOrder.map((trackId) => [trackId, currentVisible.has(trackId)])
          ),
          orderedTrackIds: currentOrder,
        },
      });
      if (projection.status === 'unsupported') {
        throw new Error(projection.issues.map((issue) => issue.message).join(' '));
      }
      const savedPath = await savePortableGenomeViewDocument(projection.document);
      if (!savedPath) return;
      const fileLabel = savedPath.replace(/\\/gu, '/').split('/').pop() ?? 'genome view';
      useToastStore
        .getState()
        .addToast(
          userMessageWithValues('notice.saved-value', { value0: userMessageValue(fileLabel) }),
          { definition: 'indexed-genome-tab-saved-example' }
        );
    } catch (error) {
      useToastStore
        .getState()
        .addToast(toUserMessage(error, 'failure.could-not-save-this-genome-view'), {
          definition: 'indexed-genome-tab-could-not-save-this-genome-view',
        });
    } finally {
      setSavingPortableView(false);
    }
  }, [
    annotationMapperPolicy,
    assembly,
    fileName,
    length,
    orderedAnnotationTrackIds,
    savingPortableView,
    tab.id,
    visibleAnnotationTrackIds,
  ]);
  useEffect(() => {
    const bridge = (
      window as Window & { __test?: { writeLegacyPortableGenomeViewFixture?: () => Promise<void> } }
    ).__test;
    if (!bridge || !isActive || !assembly) return;
    bridge.writeLegacyPortableGenomeViewFixture = savePortableView;
    return () => {
      if (bridge.writeLegacyPortableGenomeViewFixture === savePortableView)
        delete bridge.writeLegacyPortableGenomeViewFixture;
    };
  }, [assembly, isActive, savePortableView]);
  const assemblyTextureSourceRequest = useMemo(
    () => assemblyOverviewTextureReadRequestForAssembly(assembly, workspaceRoot),
    [assembly, workspaceRoot]
  );
  const fullAssemblyReadinessRequired = indexedGenomeFullAssemblyReadinessRequired(
    assemblyAnnotationProductsReady,
    assemblyTextureSourceRequest
  );
  const expectedPublishedAnnotationAssetGeneration =
    indexedState?.assemblyAssetGenerationsByTheme?.[annotationProductThemeMode];
  const activeAnnotationAssetGeneration = assemblyReferenceAssetGenerationForThemeV1(
    indexedState,
    annotationProductThemeMode
  );
  const admittedAnnotationDatasetVersion =
    sessionShell?.assemblySearchSource?.datasetContract.datasetVersion ??
    indexedState?.assemblySearchSource?.datasetContract.datasetVersion;
  const completeAssemblyAnnotationSceneRequest =
    useMemo<AssemblyAnnotationSceneSourceRequest | null>(() => {
      const request = assemblyTextureSourceRequest;
      if (!request) return null;
      return {
        ...request,
        ...(admittedAnnotationDatasetVersion
          ? { datasetVersion: admittedAnnotationDatasetVersion }
          : {}),
        scope: assemblyAnnotationSceneScopeForRequest('complete-assembly', request.chromosomes),
        ...(expectedPublishedAnnotationAssetGeneration
          ? { expectedAssetGeneration: expectedPublishedAnnotationAssetGeneration }
          : {}),
      };
    }, [
      admittedAnnotationDatasetVersion,
      assemblyTextureSourceRequest,
      expectedPublishedAnnotationAssetGeneration,
    ]);
  const admittedAssemblyAnnotationSceneRequest = indexedGenomeAdmittedAnnotationSceneRequest(
    sessionShell?.assemblySearchSource,
    indexedState?.assemblySearchSource
  );
  const viewerAnnotationSceneSourceRequest = indexedGenomeViewerAnnotationSceneRequest(
    admittedAssemblyAnnotationSceneRequest,
    assembly?.assemblyId,
    completeAssemblyAnnotationSceneRequest
  );
  const initialAssemblyProductPreparationOptionsRef = useRef<
    Pick<
      PrepareCurrentAssemblyAnnotationProductSetOptions,
      'themeMode' | 'policy' | 'expectedGeneration'
    >
  >({
    themeMode: annotationProductThemeMode,
    policy: { ...annotationMapperPolicy },
    ...(activeAnnotationAssetGeneration
      ? {
          expectedGeneration: {
            sourceFingerprint: activeAnnotationAssetGeneration.sourceFingerprint,
            inventoryFingerprint: activeAnnotationAssetGeneration.inventoryFingerprint,
          },
        }
      : {}),
  });
  const interactionPayloadEnabled = assemblySourceReady;
  const prepackedAnnotationSceneCache = useAssemblyPrepackedAnnotationSceneCache({
    interactionPayloadEnabled:
      assemblyAnnotationProductsReady &&
      !fullAssemblyReadinessRequired &&
      interactionPayloadEnabled,
    prepareProductOnly: !assemblyAnnotationProductsReady,
    prepareOnMiss: false,
    preparationGeneration: annotationProductAdmissionGeneration,
    assetGeneration: activeAnnotationAssetGeneration,
    request: completeAssemblyAnnotationSceneRequest,
    themeMode: annotationProductThemeMode,
    policy: {
      trackType: 'mRNA',
      isoformMode: annotationMapperPolicy.isoformMode,
      laneLimit: annotationMapperPolicy.laneLimit,
    },
  });
  const deferGenomeWideFeatures = Boolean(assembly);

  const assemblyAnnotations = useAssemblyAnnotationFeatures(
    assembly,
    workspaceRoot,
    deferGenomeWideFeatures,
    annotationMapperPolicy.isoformMode
  );
  const totalAnnotationCount = useMemo<number | null>(() => {
    if (assemblyAnnotationsNotApplicable) return 0;
    if (!assembly) {
      const count = indexedState?.metadata?.featureCount;
      return typeof count === 'number' && Number.isFinite(count) ? Math.max(0, count) : null;
    }
    const admittedCount = sessionShell?.assemblyAnnotationFeatureCount;
    if (typeof admittedCount === 'number' && Number.isFinite(admittedCount)) {
      return Math.max(0, admittedCount);
    }
    if (prepackedAnnotationSceneCache.status === 'hit') {
      const count = prepackedAnnotationSceneCache.result.manifest.featureCount;
      if (Number.isFinite(count)) return Math.max(0, count);
    }
    if (
      assemblyAnnotations &&
      assemblyAnnotations.totalChroms > 0 &&
      assemblyAnnotations.loadedChroms === assemblyAnnotations.totalChroms
    ) {
      return assemblyAnnotations.features.length;
    }
    return null;
  }, [
    assembly,
    assemblyAnnotations,
    assemblyAnnotationsNotApplicable,
    indexedState?.metadata?.featureCount,
    prepackedAnnotationSceneCache,
    sessionShell?.assemblyAnnotationFeatureCount,
  ]);

  const assemblySessionConfigs = useMemo<AssemblySessionChromConfig[] | undefined>(() => {
    if (!assembly || !workspaceRoot || !assemblySourceReady) return undefined;
    const configs = assembly.chromosomes
      .filter((c) => Boolean(c.manifest.fastaPath && c.manifest.faiPath))
      .map((c) => {
        const manifest = completeManifestFromIndexedGff3Source(c.manifest);
        const sourcePath = manifest.gffPath ?? manifest.fastaPath;
        return {
          chrom: c.chrom,
          source: {
            sourcePath,
            workspaceRoot,
            chrom: c.chrom,
            sourceExt: extensionForPath(sourcePath),
            manifest,
            intent: activeAnnotationAssetGeneration
              ? {
                  kind: 'internal-assembly-segment' as const,
                  assetGeneration: activeAnnotationAssetGeneration,
                }
              : { kind: 'internal-assembly-segment' as const },
          },
          manifest,
        };
      });
    return configs.length > 0 ? configs : undefined;
  }, [activeAnnotationAssetGeneration, assembly, assemblySourceReady, workspaceRoot]);
  const assemblySequenceSearchSource = useMemo<AssemblySequenceSearchSourceV1 | null>(
    () =>
      assembly
        ? {
            contract: ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
            assemblyId: assembly.assemblyId,
            chromosomes: assembly.chromosomes.map(({ chrom, length, manifest }) => ({
              chrom,
              length,
              manifest,
            })),
          }
        : null,
    [assembly]
  );

  const {
    persistIndexedState,
    persistBamTracks,
    persistDataTracks,
    persistSignalReadPileupViews,
    persistVariantSource,
    persistUserAnnotations,
    persistPrimerBindings,
  } = useIndexedGenomeTabPersist({
    entityId: tab.entityId,
    indexedStateRef,
    setIndexedState,
  });

  const bamTrackRestore = usePersistedBamTracks({
    laneOwnerId: tab.id,
    assemblyId: indexedGenomeLaneAssemblyId(assembly?.assemblyId, manifest?.chrom, sourceChrom),
    assemblyDisplayName: indexedGenomeLaneAssemblyId(
      assembly?.displayName,
      manifest?.chrom,
      sourceChrom
    ),
    references: variantReferences,
    persistedTracks: firstPresent(indexedState?.bamTracks, undefined, []),
    onChange: persistBamTracks,
  });
  const dataTrackRestore = usePersistedDataTracks({
    laneOwnerId: tab.id,
    assemblyId: indexedGenomeLaneAssemblyId(assembly?.assemblyId, manifest?.chrom, sourceChrom),
    persistedTracks: firstPresent(indexedState?.dataTracks, indexedState?.ucscTracks, []),
    references: variantReferences,
    pairedBamTracks: firstPresent(indexedState?.bamTracks, undefined, []),
    pairedSourcesReady: bamTrackRestore.status === 'ready',
    onChange: persistDataTracks,
  });
  usePersistedSignalReadPileupViews({
    laneOwnerId: tab.id,
    assemblyId: indexedGenomeLaneAssemblyId(assembly?.assemblyId, manifest?.chrom, sourceChrom),
    persistedViews: firstPresent(indexedState?.signalReadPileupViews, undefined, []),
    sourcesReady: bamTrackRestore.status === 'ready' && dataTrackRestore.status === 'ready',
    onChange: persistSignalReadPileupViews,
  });

  const mutationNavigator = useMutationNavigator({
    assemblyId: indexedGenomeLaneAssemblyId(assembly?.assemblyId, manifest?.chrom, sourceChrom),
    references: variantReferences,
    annotationManifests: mutationAnnotationManifests,
    persistedSource: firstPresent(indexedState?.variantSource, undefined, null),
    onSourcePrepared: persistVariantSource,
  });
  usePersistedVariantTrack({
    laneOwnerId: tab.id,
    assemblyId: indexedGenomeLaneAssemblyId(assembly?.assemblyId, manifest?.chrom, sourceChrom),
    source: mutationNavigator.source,
    onChange: persistVariantSource,
  });
  const selectMutationVariant = mutationNavigator.selectVariant;

  const [sessionActivated, setSessionActivated] = useState(isActive);
  useEffect(() => {
    if (isActive) setSessionActivated(true);
  }, [isActive]);

  useEffect(() => {
    if (!sessionActivated) return;
    if (!workspace.loading && !workspaceRoot) {
      claimIndexedGenomeOpen(tab.id)?.end({ outcome: 'refused', reason: 'source_unavailable' });
      setPrepareError(
        userMessage('failure.open-a-project-containing-this-genome-before-indexing-it')
      );
      setPrepareStatus('error');
      return;
    }
    if (workspace.loading || !workspaceRoot) return;
    if (assemblyIdeogramOnly) {
      setSessionShell(null);
      setPrepareLoadPhase('opening');
      setPrepareError(null);
      setPrepareStatus('ready');
      setViewerLoadPhase('loading');
      setViewerLoadError(null);
      return;
    }

    const previousOwner = lifecycleOwnerRef.current;
    const lifecycle: NonNullable<typeof lifecycleOwnerRef.current> = {
      source: viewerPresentationOwnerKey,
      sessionId: null,
      operation:
        claimIndexedGenomeOpen(tab.id) ??
        beginIndexedGenomeOpen(
          !previousOwner
            ? 'restored'
            : previousOwner.source === viewerPresentationOwnerKey
              ? 'retry'
              : 'source_switch'
        ),
    };
    lifecycleOwnerRef.current = lifecycle;

    const manifestAtOpen = indexedStateRef.current?.manifest ?? null;
    const continuingPresentedOwner =
      viewerPresentationRef.current === viewerPresentationOwnerKey &&
      assemblyReferenceKindRef.current === 'hosted';
    if (!continuingPresentedOwner) {
      viewerPresentationRef.current = null;
    }

    let isCurrent = true;
    let activeSessionId: string | null = null;
    let pendingSessionUpdate: GenomeSessionUpdate | null = null;
    let terminalSessionUpdateSeen = false;
    let recoveryPoll: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let preparedAssemblyProduct: PreparedAssemblyAnnotationProductSet | null = null;
    const sourceBase = {
      sourcePath: genomeOpenSourcePath,
      workspaceRoot,
      sourceExt: sourceExtForValidation,
      sourceSizeBytes: genomeOpenSourceSizeBytes,
      chrom: sourceChrom,
    };

    const stopRecoveryPoll = () => {
      if (recoveryPoll === null) return;
      clearInterval(recoveryPoll);
      recoveryPoll = null;
    };

    const applyPreparationError = (message: string, tabState?: IndexedGenomeTabState) => {
      terminalSessionUpdateSeen = true;
      stopRecoveryPoll();
      if (tabState) persistIndexedState(tabState, 'indexed-error');
      if (viewerPresentationRef.current === viewerPresentationOwnerKey) {
        setSessionShell((current) =>
          current ? markGenomeSessionTrackError(current, 'sequence', message) : current
        );
        setPrepareError(null);
        setPrepareStatus('ready');
        return;
      }
      lifecycle.operation.end({ outcome: 'failed', reason: 'index' });
      setPrepareError(toUserMessage(message, 'tracks.loadFailed'));
      setPrepareStatus('error');
    };

    const assemblyProductForSessionUpdate = (): PreparedAssemblyAnnotationProductSet | null => {
      const latestAdmitted = latestAdmittedAssemblyProductRef.current;
      if (
        latestAdmitted &&
        (!preparedAssemblyProduct ||
          latestAdmitted.assembly.assemblyId === preparedAssemblyProduct.assembly.assemblyId)
      ) {
        return latestAdmitted;
      }
      return preparedAssemblyProduct;
    };

    const recoverSessionFromMain = async (sessionId: string) => {
      if (terminalSessionUpdateSeen) return;
      const latestShell = await platform().genome.getSession(sessionId);
      if (terminalSessionUpdateSeen || !isCurrent || latestShell.sessionId !== activeSessionId) {
        return;
      }
      if (latestShell.coordinateReady) lifecycle.operation.coordinateReady();
      setSessionShell((current) => withoutSessionReadinessDemotion(current, latestShell));

      if (latestShell.preparationError !== undefined) {
        applyPreparationError(latestShell.preparationError, {
          sourcePath: latestShell.sourcePath,
          sourceSizeBytes: latestShell.sourceSizeBytes,
          ...sourceTimestamps,
          sourceExt: sourceExtForValidation,
          chrom: latestShell.chrom,
          error: latestShell.preparationError,
        });
        return;
      }

      const recoveredTabState = tabStateFromReadySessionShell({
        shell: latestShell,
        sourceExt: sourceExtForValidation,
        sourceTimestamps,
      });
      if (!recoveredTabState) return;

      terminalSessionUpdateSeen = true;
      stopRecoveryPoll();
      persistIndexedState(
        tabStateWithPreparedAssemblyProduct(recoveredTabState, assemblyProductForSessionUpdate()),
        'indexed'
      );
      setPrepareLoadPhase('opening');
      setPrepareError(null);
      setPrepareStatus('ready');
    };

    const startRecoveryPoll = (sessionId: string) => {
      stopRecoveryPoll();
      void recoverSessionFromMain(sessionId).catch(() => undefined);
      recoveryPoll = setInterval(() => {
        void recoverSessionFromMain(sessionId).catch(() => undefined);
      }, 750);
    };

    setSessionShell(null);
    setPrepareLoadPhase(manifestAtOpen ? 'opening' : 'indexing');
    setPrepareError(null);
    setViewerLoadError(null);
    if (!continuingPresentedOwner) {
      setPrepareStatus('preparing');
      setViewerLoadPhase('loading');
    }

    const applySessionUpdate = (update: GenomeSessionUpdate) => {
      const fingerprint = JSON.stringify(update);
      if (fingerprint === lastAppliedSessionUpdateFingerprintRef.current) return;
      lastAppliedSessionUpdateFingerprintRef.current = fingerprint;

      if (update.shell.coordinateReady) lifecycle.operation.coordinateReady();
      setSessionShell((current) => withoutSessionReadinessDemotion(current, update.shell));
      setPrepareLoadPhase(update.prepareLoadPhase);

      if (update.prepareStatus === 'ready') {
        terminalSessionUpdateSeen = true;
        stopRecoveryPoll();
        if (update.tabState) {
          persistIndexedState(
            tabStateWithPreparedAssemblyProduct(update.tabState, assemblyProductForSessionUpdate()),
            'indexed'
          );
        }
        setPrepareError(null);
        setPrepareStatus('ready');
        return;
      }

      if (update.prepareStatus === 'error') {
        const message = update.error ?? update.tabState?.error ?? 'Failed to index genome';
        applyPreparationError(message, update.tabState);
        return;
      }

      if (update.tabState)
        persistIndexedState(
          update.tabState,
          update.tabState.manifest ? 'indexed' : 'indexed-pending'
        );
      setPrepareStatus('preparing');
    };

    const openPreparedSession = async () => {
      const persistedAtOpen = indexedStateRef.current;
      const portableAdmissionReady = Boolean(
        assembly &&
        persistedAtOpen?.assemblyAnnotationProductsReadiness === 'ready' &&
        /^[0-9a-f]{64}$/.test(persistedAtOpen.assemblyPortableBundleFingerprint ?? '')
      );
      const productReady = assembly
        ? portableAdmissionReady
          ? {
              assembly,
              ...(persistedAtOpen?.assemblySearchSource
                ? { searchSource: persistedAtOpen.assemblySearchSource }
                : {}),
              ...(persistedAtOpen?.assemblyAssetGeneration
                ? { generation: persistedAtOpen.assemblyAssetGeneration }
                : {}),
              ...(persistedAtOpen?.assemblyAnnotationTrackTypes
                ? { trackTypes: persistedAtOpen.assemblyAnnotationTrackTypes }
                : {}),
              annotationProductsReadiness: 'ready' as const,
              searchReadiness:
                persistedAtOpen?.assemblySearchReadiness === 'ready'
                  ? ('ready' as const)
                  : ('pending' as const),
            }
          : await prepareCurrentAssemblyAnnotationProductSet(assembly, {
              workspaceRoot,
              ...initialAssemblyProductPreparationOptionsRef.current,
            })
        : null;
      if (!isCurrent) return;
      preparedAssemblyProduct = productReady;
      const openedManifest = productReady
        ? (productReady.assembly.chromosomes.find((chromosome) => chromosome.chrom === sourceChrom)
            ?.manifest ?? null)
        : manifestAtOpen;
      const source: GenomeOpenSource = {
        ...sourceBase,
        ...(openedManifest ? { manifest: openedManifest } : {}),
        intent: assembly
          ? {
              kind: 'reference-assembly',
              annotationProductsReadiness: productReady?.annotationProductsReadiness ?? 'pending',
              searchReadiness: productReady?.searchReadiness ?? 'pending',
              ...(productReady?.searchSource ? { searchSource: productReady.searchSource } : {}),
              ...(productReady?.generation ? { assetGeneration: productReady.generation } : {}),
            }
          : { kind: 'reference-single' },
      };

      unsubscribe = platform().on('genome:sessionUpdated', (payload) => {
        const update = payload as GenomeSessionUpdate;
        if (!isCurrent) return;
        if (activeSessionId === null && update.shell.sourcePath === genomeOpenSourcePath) {
          pendingSessionUpdate = update;
          return;
        }
        if (update.sessionId !== activeSessionId) return;
        applySessionUpdate(update);
      });

      try {
        const shell = await platform().genome.open(source);
        if (!isCurrent) {
          await platform()
            .genome.closeSession(shell.sessionId)
            .catch(() => false);
          return;
        }
        activeSessionId = shell.sessionId;
        lifecycle.sessionId = shell.sessionId;
        if (shell.coordinateReady) lifecycle.operation.coordinateReady();
        setSessionShell(shell);
        if (pendingSessionUpdate?.sessionId === shell.sessionId) {
          const update = pendingSessionUpdate;
          pendingSessionUpdate = null;
          applySessionUpdate(update);
        }
        if (!terminalSessionUpdateSeen) startRecoveryPoll(shell.sessionId);
      } catch (err) {
        if (!isCurrent) return;
        lifecycle.operation.end(
          isIndexedSourceUnavailable(err)
            ? { outcome: 'refused', reason: 'source_unavailable' }
            : { outcome: 'failed', reason: 'session' }
        );
        const message = toUserMessage(err, 'tracks.loadFailed');
        const failed: IndexedGenomeTabState = {
          sourcePath: genomeOpenSourcePath,
          sourceSizeBytes: genomeOpenSourceSizeBytes,
          ...sourceTimestamps,
          sourceExt: extensionForPath(genomeOpenSourcePath),
          chrom: initialIndexedState?.chrom ?? fileName.replace(/\.[^.]+$/, ''),
          error: message,
        };
        persistIndexedState(failed, 'indexed-error');
        setPrepareError(message);
        setPrepareStatus('error');
      }
    };

    void openPreparedSession();

    return () => {
      isCurrent = false;
      lifecycle.sessionId = null;
      lifecycle.operation.end(
        mountedRef.current
          ? { outcome: 'superseded', reason: 'superseded' }
          : { outcome: 'cancelled', reason: 'closed' }
      );
      stopRecoveryPoll();
      unsubscribe?.();
      const sessionId = activeSessionId;
      activeSessionId = null;
      if (sessionId) {
        void platform()
          .genome.closeSession(sessionId)
          .catch(() => false);
      }
    };
  }, [
    assembly?.assemblyId,
    assemblyIdeogramOnly,
    genomeOpenSourcePath,
    persistIndexedState,
    sessionActivated,
    sourceChrom,
    sourceExtForValidation,
    viewerPresentationOwnerKey,
    tab.id,
    genomeOpenSourceSizeBytes,
    workspace.loading,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (!sessionShell?.openReady) return;
    const source = genomeSessionCapabilityUpgradeSource({ indexedState, workspaceRoot });
    if (!source || source.intent.kind !== 'reference-assembly') return;
    const requestedSearchReadiness = source.intent.searchReadiness;
    const alreadyAdmitted =
      sessionShell.assemblyAnnotationProductsReadiness === 'ready' &&
      (requestedSearchReadiness !== 'ready' || sessionShell.assemblySearchReadiness === 'ready') &&
      sessionShell.assemblyAssetGeneration?.sourceFingerprint ===
        source.intent.assetGeneration?.sourceFingerprint &&
      sessionShell.assemblyAssetGeneration?.inventoryFingerprint ===
        source.intent.assetGeneration?.inventoryFingerprint;
    if (alreadyAdmitted) return;

    const requestKey = [
      sessionShell.sessionId,
      source.intent.assetGeneration?.sourceFingerprint,
      source.intent.assetGeneration?.inventoryFingerprint,
      requestedSearchReadiness,
    ].join(':');
    if (requestedCapabilityUpgradeKeyRef.current === requestKey) return;
    requestedCapabilityUpgradeKeyRef.current = requestKey;
    const sessionId = sessionShell.sessionId;
    const queued = capabilityUpgradeTailRef.current
      .catch(() => undefined)
      .then(async () => {
        const upgraded = await platform().genome.upgradeSessionCapabilities(sessionId, source);
        if (
          mountedRef.current &&
          currentSessionIdRef.current === sessionId &&
          requestedCapabilityUpgradeKeyRef.current === requestKey
        ) {
          setSessionShell((current) => {
            if (current?.sessionId !== sessionId || upgraded.sessionId !== sessionId)
              return current;
            if (
              (current.assemblyAnnotationProductsReadiness === 'ready' &&
                upgraded.assemblyAnnotationProductsReadiness !== 'ready') ||
              (current.assemblySearchReadiness === 'ready' &&
                upgraded.assemblySearchReadiness !== 'ready')
            ) {
              return current;
            }
            return upgraded;
          });
        }
      })
      .catch((error) => {
        if (requestedCapabilityUpgradeKeyRef.current === requestKey) {
          requestedCapabilityUpgradeKeyRef.current = null;
        }
        if (mountedRef.current && currentSessionIdRef.current === sessionId) {
          setHostedBackgroundPreparation({
            status: 'failed',
            message: toUserMessage(
              error,
              'failure.prepared-genome-capabilities-could-not-be-admitted'
            ),
          });
        }
      });
    capabilityUpgradeTailRef.current = queued;
  }, [
    indexedState,
    sessionShell?.assemblyAnnotationProductsReadiness,
    sessionShell?.assemblyAssetGeneration,
    sessionShell?.assemblySearchReadiness,
    sessionShell?.openReady,
    sessionShell?.sessionId,
    workspaceRoot,
  ]);

  const loadRange = useCallback(
    (
      nextStart: number,
      nextWindowSize = windowSize,
      options: { commitViewport?: boolean } = {}
    ) => {
      if (!manifest || length <= 0) return;
      const coordinate = Math.max(0, Math.min(nextStart, length - 1));
      const visibleSize = Math.min(length, nextWindowSize);
      const boundedStart = Math.min(coordinate, length - visibleSize);
      const boundedEnd = boundedStart + visibleSize;
      setRangeStart(boundedStart);
      setPositionInput(formatIndexedCoordinateInput(String(coordinate + 1)));
      setRangeStatus('idle');
      setRangeError(null);
      if (options.commitViewport ?? true) {
        const viewerCommandId = ++viewportCommandIdRef.current;
        lifecycleOwnerRef.current?.operation.acceptViewport(viewerCommandId);
        pendingIndexedViewportCommitRef.current = viewerCommandId;
        setViewportCommand({
          id: viewerCommandId,
          start: boundedStart,
          end: boundedEnd,
        });
      }
    },
    [length, manifest, windowSize]
  );

  useEffect(() => {
    if (prepareStatus !== 'ready' || !manifest || length <= 0) return;
    void loadRange(rangeStart, windowSize, { commitViewport: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepareStatus, manifest?.fastaPath, length]);

  const handleWindowSizeChange = (value: string) => {
    const next = Number.parseInt(value, 10);
    if (!Number.isFinite(next)) return;
    setWindowSize(next);
    void loadRange(displayedViewportRange.start, next);
  };

  const goToInputPosition = () => {
    const parsed = parseIndexedCoordinateInput(positionInput);
    if (parsed === null) {
      lifecycleOwnerRef.current?.operation.refuseViewport();
      useToastStore
        .getState()
        .addToast(userMessage('notice.enter-one-assembly-coordinate-using-numbers-only'), {
          definition: 'indexed-genome-tab-enter-one-assembly-coordinate-using-numbers-only',
        });
      return;
    }
    void loadRange(parsed - 1);
  };

  const handleViewportRangeChange = useCallback(
    (range: { start: number; end: number } | null) => {
      liveViewportRangeRef.current = range;
      setLiveViewportRange((current) => {
        if (current === range) return current;
        if (
          current != null &&
          range != null &&
          current.start === range.start &&
          current.end === range.end
        ) {
          return current;
        }
        return range;
      });
      if (pendingIndexedViewportCommitRef.current === null) {
        scheduleIndexedViewportPersist(range);
      }
    },
    [scheduleIndexedViewportPersist]
  );
  const handleVisibleAnnotationTypesChange = useCallback((next: ReadonlySet<string>) => {
    setVisibleAnnotationTrackIds((current) => {
      if (
        current &&
        current.size === next.size &&
        [...current].every((trackId) => next.has(trackId))
      ) {
        return current;
      }
      return new Set(next);
    });
  }, []);

  const markVisibleTrackError = useCallback(
    (kind: GenomeTrackDescriptor['kind'], message: string) => {
      setSessionShell((current) =>
        current ? markGenomeSessionTrackError(current, kind, message) : current
      );
    },
    []
  );

  const loadPhase = computeLoadPhase({
    prepareStatus,
    prepareLoadPhase,
    viewerLoadPhase,
    hasManifest: !!manifest,
  });
  const {
    visualChrom,
    displayedChrom,
    canShowViewer,
    canNavigate,
    sequenceSearchReady,
    assemblyAnnotationSearchNotApplicable,
    assemblyAnnotationSearchReady,
  } = indexedGenomeTabViewerGate({
    chrom: indexedState?.chrom,
    manifestChrom: manifest?.chrom,
    sourceChrom,
    hasManifest: Boolean(manifest),
    length,
    loadPhase,
    assemblySourceReady,
    assemblyAdmissionReady,
    hasAssembly: Boolean(assembly),
    sessionSearchReadiness: sessionShell?.assemblySearchReadiness,
    indexedSearchReadiness: indexedState?.assemblySearchReadiness,
    sessionSearchSourceDefined: sessionShell?.assemblySearchSource !== undefined,
  });
  const userAnnotations = indexedState?.userAnnotations ?? EMPTY_INDEXED_USER_ANNOTATIONS;
  const userAnnotationDataset = useMemo(
    () => indexedUserAnnotationDataset(userAnnotations, assembly),
    [assembly, userAnnotations]
  );
  const userAnnotationValues = useMemo(
    () => userAnnotations.map((value) => value.annotation),
    [userAnnotations]
  );
  const selectedActionTarget = useMemo(
    () =>
      selectedRendererRange
        ? projectIndexedRendererSelection(selectedRendererRange, displayedChrom, assembly)
        : null,
    [assembly, displayedChrom, selectedRendererRange]
  );
  const openTranslationDialog = useTranslationDialogStore((state) => state.open);
  const proteinSaveLocationRoots = useMemo(() => {
    const roots = workspaceFolders.map((folder) => ({ path: folder.path, name: folder.name }));
    if (roots.length === 0 && workspaceRoot) {
      roots.push({
        path: workspaceRoot,
        name: workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot,
      });
    }
    return roots;
  }, [workspaceFolders, workspaceRoot]);

  useEffect(() => {
    if (!isActive) {
      setSequenceContextMenu(null);
      setIsoformDialog(null);
      isoformRequestIdRef.current += 1;
    }
  }, [isActive]);

  useEffect(() => {
    setSelectedRendererRange(null);
    setSequenceContextMenu(null);
    setAnnotationDialog(null);
    setIsoformDialog(null);
    isoformRequestIdRef.current += 1;
  }, [assembly?.assemblyId, genomeOpenSourcePath]);

  const executeIndexedAction = useCallback(
    async (
      target: IndexedSequenceActionTarget,
      operation: 'read' | 'read_spliced' | 'reverse_complement' | 'translate' | 'translate_spliced',
      options: { strand?: '+' | '-'; featureId?: string } = {}
    ) => {
      const current = indexedStateRef.current;
      const targetManifest = indexedManifestForTarget(current, target);
      if (!current || !targetManifest) {
        useToastStore.getState().addToast(
          userMessageWithValues('notice.the-indexed-source-for-value-is-not-available', {
            value0: userMessageValue(target.chrom),
          }),
          {
            definition: 'indexed-genome-tab-source-unavailable',
          }
        );
        return null;
      }
      try {
        const result = await runIndexedSequenceAction({
          target,
          manifest: targetManifest,
          sourceId: current.sourcePath,
          ...(current.assembly?.assemblyId ? { assemblyId: current.assembly.assemblyId } : {}),
          operation,
          strand: options.strand,
          ...(options.featureId ? { featureId: options.featureId } : {}),
          workspaceRootPaths: workspaceRoot ? [workspaceRoot] : [],
        });
        if (result.ok !== true) {
          useToastStore.getState().addToast(toUserMessage(result.error, 'tracks.loadFailed'), {
            definition: 'indexed-genome-tab-reference-action-failed',
          });
          return null;
        }
        return result;
      } catch (error) {
        console.error('Indexed reference action failed:', error);
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.the-indexed-reference-action-failed'), {
            definition: 'indexed-genome-tab-reference-action-failed',
          });
        return null;
      }
    },
    [workspaceRoot]
  );

  const handleIndexedSelectionChange = useCallback<IndexedGenomeSelectionChangeHandler>(
    (start, end) => setSelectedRendererRange([start, end]),
    []
  );
  const handleIndexedSelectionClear = useCallback(() => setSelectedRendererRange(null), []);

  const primerBindingAtHitRef = useRef<
    (
      hit: { kind: string; payload?: unknown } | null | undefined
    ) => IndexedGenomePrimerBinding | null
  >(() => null);
  const handleIndexedContextMenu = useCallback<IndexedGenomeContextMenuHandler>(
    (event, context) => {
      event.preventDefault();
      const selectionTarget = context.highlightRange
        ? projectIndexedRendererSelection(context.highlightRange, displayedChrom, assembly)
        : null;
      if (context.highlightRange) {
        setSelectedRendererRange([context.highlightRange[0], context.highlightRange[1]]);
        if (!selectionTarget) {
          useToastStore
            .getState()
            .addToast(
              userMessage(
                'notice.select-bases-within-one-chromosome-before-using-sequence-actions'
              ),
              {
                definition: 'indexed-genome-tab-select-one-chromosome',
              }
            );
        }
      }

      const clickedUserAnnotation =
        context.position == null
          ? null
          : findIndexedUserAnnotationAtRendererPosition(
              userAnnotations,
              context.position,
              assembly
            );
      const clickedPrimer = primerBindingAtHitRef.current(context.hitResult);
      let clickedCds: IndexedCdsActionTarget | null = null;
      let clickedTranscript: IndexedTranscriptActionTarget | null = null;
      if (clickedUserAnnotation?.annotation.type.toUpperCase() === 'CDS') {
        const annotation = clickedUserAnnotation.annotation;
        clickedCds = {
          kind: 'user',
          annotation,
          target: {
            chrom: clickedUserAnnotation.chrom,
            start0: annotation.start - 1,
            end0: annotation.end,
          },
          strand: annotation.direction === -1 ? '-' : '+',
        };
      }
      if (!clickedCds && !clickedPrimer && context.hitResult?.kind === 'feature') {
        const feature = context.hitResult.payload;
        const featureType = feature.type?.toUpperCase();
        const transcriptFeatureId = feature.transcriptId ?? feature.sourceId;
        const isTranscript = isIndexedTranscriptFeatureType(feature.type ?? '');
        const target = projectIndexedRendererRange(
          { start: feature.start, end: feature.end },
          displayedChrom,
          assembly
        );
        if (isTranscript && transcriptFeatureId && target) {
          const direction = annotationDirectionForRenderer(feature.direction);
          clickedTranscript = {
            name: feature.displayName ?? transcriptFeatureId,
            target,
            strand: direction === -1 ? '-' : '+',
            featureId: transcriptFeatureId,
          };
        }
        const isCodingCarrier =
          featureType === 'CDS' || (isTranscript && Boolean(transcriptFeatureId));
        if (isCodingCarrier) {
          if (target) {
            const direction = annotationDirectionForRenderer(feature.direction);
            const annotation: Annotation = {
              name: feature.displayName ?? transcriptFeatureId ?? 'CDS',
              type: 'CDS',
              start: target.start0 + 1,
              end: target.end0,
              direction,
            };
            clickedCds = {
              kind: 'reference',
              annotation,
              target,
              strand: direction === -1 ? '-' : '+',
              ...(transcriptFeatureId ? { featureId: transcriptFeatureId } : {}),
            };
          }
        }
      }

      if (
        !selectionTarget &&
        !clickedUserAnnotation &&
        !clickedCds &&
        !clickedTranscript &&
        !clickedPrimer
      ) {
        setSequenceContextMenu(null);
        return;
      }
      setSequenceContextMenu({
        x: event.clientX,
        y: event.clientY,
        selectionTarget,
        clickedPrimer,
        clickedUserAnnotation,
        clickedCds,
        clickedTranscript,
      });
    },
    [assembly, displayedChrom, userAnnotations]
  );

  const copyIndexedSelection = useCallback(
    async (
      operation: 'read' | 'reverse_complement',
      target: IndexedSequenceActionTarget | null
    ) => {
      if (!target) return;
      const result = await executeIndexedAction(target, operation);
      if (!result?.sequence) {
        if (result) {
          useToastStore
            .getState()
            .addToast(userMessage('notice.the-indexed-interval-returned-no-bases'), {
              definition: 'indexed-genome-tab-interval-no-bases',
            });
        }
        return;
      }
      try {
        await navigator.clipboard.writeText(result.sequence);
        showCopiedSequenceToast(
          result.sequence,
          operation === 'reverse_complement' ? 'reverse-complement' : 'forward'
        );
      } catch (error) {
        console.error('Failed to copy indexed reference interval:', error);
        useToastStore
          .getState()
          .addToast(userMessage('notice.failed-to-write-the-sequence-to-the-clipboard'), {
            definition: 'indexed-genome-tab-copy-sequence-failed',
          });
      }
    },
    [executeIndexedAction]
  );

  const copyIndexedTranscript = useCallback(
    async (transcript: IndexedTranscriptActionTarget, molecule: 'dna' | 'rna') => {
      const result = await executeIndexedAction(transcript.target, 'read_spliced', {
        strand: transcript.strand,
        featureId: transcript.featureId,
      });
      const dna = result?.splicedSequence?.sequence;
      if (!dna) {
        if (result) {
          useToastStore
            .getState()
            .addToast(userMessage('notice.the-transcript-returned-no-exon-bases'), {
              definition: 'indexed-genome-tab-transcript-no-exon-bases',
            });
        }
        return;
      }
      const sequence = molecule === 'rna' ? dna.replace(/T/g, 'U') : dna;
      try {
        await navigator.clipboard.writeText(sequence);
        useToastStore.getState().addToast(
          userMessageWithValues('notice.copied-value-value-value', {
            value0: userMessageValue(sequence.length),
            value1: userMessageValue(molecule === 'rna' ? 'nt RNA' : 'bp DNA'),
            value2: userMessageValue(transcript.name),
          }),
          { definition: 'indexed-genome-tab-copied-transcript' }
        );
      } catch (error) {
        console.error('Failed to copy indexed transcript sequence:', error);
        useToastStore.getState().addToast(
          userMessageWithValues('notice.failed-to-write-the-transcript-value-to-the-clipboard', {
            value0: userMessageValue(molecule.toUpperCase()),
          }),
          {
            definition: 'indexed-genome-tab-copy-transcript-failed',
          }
        );
      }
    },
    [executeIndexedAction]
  );

  const openIsoformChooser = useCallback(
    async (transcript: IndexedTranscriptActionTarget) => {
      const requestId = ++isoformRequestIdRef.current;
      setIsoformDialog({ kind: 'loading', transcriptName: transcript.name });
      const targetManifest = indexedManifestForTarget(indexedStateRef.current, transcript.target);
      if (!targetManifest) {
        setIsoformDialog({
          kind: 'error',
          message: userMessageWithValues('notice.the-indexed-source-for-value-is-not-available', {
            value0: userMessageValue(transcript.target.chrom),
          }),
        });
        return;
      }
      try {
        const source = createPlatformIndexedGenomeDataSource(
          targetManifest,
          workspaceRoot ? [workspaceRoot] : []
        );
        if (!source.getFeatureDetails) {
          throw new Error('The indexed annotation source cannot load transcript isoforms.');
        }
        const details = await source.getFeatureDetails({
          chrom: transcript.target.chrom,
          start: transcript.target.start0,
          end: transcript.target.end0,
          featureId: transcript.featureId,
          maxWindowBp: REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP,
        });
        if (requestId !== isoformRequestIdRef.current) return;
        const isoforms = resolveIndexedTranscriptIsoforms(details, transcript.featureId);
        setIsoformDialog({
          kind: 'ready',
          isoforms,
          selectedFeatureId: transcript.featureId,
        });
      } catch (error) {
        if (requestId !== isoformRequestIdRef.current) return;
        setIsoformDialog({
          kind: 'error',
          message: toUserMessage(error, 'failure.the-transcript-isoforms-could-not-be-loaded'),
        });
      }
    },
    [workspaceRoot]
  );

  const handleCopyTranslation = useCallback(async () => {
    const target = sequenceContextMenu?.selectionTarget;
    if (!target) return;
    const result = await executeIndexedAction(target, 'read');
    if (!result?.sequence) return;
    openTranslationDialog({
      sequence: result.sequence,
      label: `${target.end0 - target.start0} bp selected · ${target.chrom}`,
    });
  }, [executeIndexedAction, openTranslationDialog, sequenceContextMenu?.selectionTarget]);

  const translateClickedCds = useCallback(async (): Promise<IndexedCdsTranslation | null> => {
    const cds = sequenceContextMenu?.clickedCds;
    if (!cds) return null;
    if (cds.kind === 'reference') {
      const result = await executeIndexedAction(cds.target, 'translate_spliced', {
        strand: cds.strand,
        featureId: cds.featureId,
      });
      if (!result?.spliced) return null;
      return {
        protein: result.spliced.protein,
        incompleteCodon: result.spliced.incompleteCodon,
      };
    }
    const result = await executeIndexedAction(cds.target, 'translate', { strand: cds.strand });
    const row = result?.translations?.find(
      (translation) => translation.strand === cds.strand && translation.frame === 0
    );
    if (!row) return null;
    return {
      protein: row.protein.endsWith('*') ? row.protein.slice(0, -1) : row.protein,
      incompleteCodon: row.incompleteCodon,
    };
  }, [executeIndexedAction, sequenceContextMenu?.clickedCds]);

  const handleCopyCdsTranslation = useCallback(async () => {
    const translated = await translateClickedCds();
    if (!translated) return;
    try {
      await navigator.clipboard.writeText(translated.protein);
      useToastStore.getState().addToast(
        userMessageWithValues('notice.copied-value-amino-acids', {
          value0: userMessageValue(translated.protein.length),
        }),
        {
          definition: 'indexed-genome-tab-copied-translation',
        }
      );
    } catch (error) {
      console.error('Failed to copy indexed CDS translation:', error);
      useToastStore
        .getState()
        .addToast(userMessage('notice.failed-to-write-the-translation-to-the-clipboard'), {
          definition: 'indexed-genome-tab-copy-translation-failed',
        });
    }
  }, [translateClickedCds]);

  const handleCreateAminoAcidSequence = useCallback(async () => {
    const cds = sequenceContextMenu?.clickedCds;
    if (!cds) return;
    if (!workspaceRoot) {
      useToastStore
        .getState()
        .addToast(userMessage('notice.open-this-reference-inside-a-project-to-create-a-protein'), {
          definition: 'indexed-genome-tab-protein-needs-project',
        });
      return;
    }
    const translated = await translateClickedCds();
    if (!translated) return;
    if (translated.incompleteCodon || translated.protein.includes('*')) {
      useToastStore
        .getState()
        .addToast(
          userMessage(
            'notice.this-cds-cannot-create-a-protein-because-it-has-an-incomplete-codon-or'
          ),
          { definition: 'indexed-genome-tab-cds-incomplete-codon' }
        );
      return;
    }
    const targetManifest = indexedManifestForTarget(indexedStateRef.current, cds.target);
    setPendingProteinCreation({
      suggestedName: cds.annotation.name || 'Protein',
      sequence: translated.protein,
      workspaceRoot,
      sourceFilePath: targetManifest?.fastaPath ?? genomeOpenSourcePath,
    });
  }, [genomeOpenSourcePath, sequenceContextMenu?.clickedCds, translateClickedCds, workspaceRoot]);

  const handleConfirmCreateAminoAcidSequence = useCallback(
    async (name: string, dir: string, destinationWorkspaceRoot: string) => {
      if (!pendingProteinCreation) return;
      setIsCreatingProtein(true);
      try {
        const result = await recordProtein({
          name,
          sequence: pendingProteinCreation.sequence,
          workspaceRoot: destinationWorkspaceRoot,
          sourceCds: pendingProteinCreation.suggestedName,
          dir,
        });
        setPendingProteinCreation(null);
        useToastStore.getState().addToast(
          userMessageWithValues('notice.registered-protein-value-value-at-value', {
            value0: userMessageValue(result.limsEntity.name),
            value1: userMessageValue(result.limsEntity.id),
            value2: userMessageValue(result.artifactPath),
          }),
          { definition: 'indexed-genome-tab-protein-registered' }
        );
        await openLimsEntity({ entityId: result.limsEntity.id });
      } catch (error) {
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.failed-to-create-amino-acid-sequence'), {
            definition: 'indexed-genome-tab-protein-create-failed',
          });
      } finally {
        setIsCreatingProtein(false);
      }
    },
    [pendingProteinCreation]
  );

  const openAddAnnotationDialog = useCallback(() => {
    const target = sequenceContextMenu?.selectionTarget;
    if (!target) return;
    setAnnotationDialog({
      kind: 'add',
      chrom: target.chrom,
      range: { start: target.start0 + 1, end: target.end0 },
      sequenceLength: chromosomeLengthForIndexedTarget(target.chrom, assembly, manifest, length),
    });
  }, [assembly, length, manifest, sequenceContextMenu?.selectionTarget]);

  const openEditAnnotationDialog = useCallback(() => {
    const value = sequenceContextMenu?.clickedUserAnnotation;
    if (!value) return;
    setAnnotationDialog({
      kind: 'edit',
      value,
      sequenceLength: chromosomeLengthForIndexedTarget(value.chrom, assembly, manifest, length),
    });
  }, [assembly, length, manifest, sequenceContextMenu?.clickedUserAnnotation]);

  const removeUserAnnotation = useCallback(
    (value: IndexedGenomeUserAnnotation) => {
      persistUserAnnotations((previous) => deleteIndexedUserAnnotation(previous, value.id));
      setAnnotationDialog(null);
      useToastStore.getState().addToast(
        userMessageWithValues('notice.deleted-annotation-value', {
          value0: userMessageValue(value.annotation.name),
        }),
        {
          definition: 'indexed-genome-tab-annotation-deleted',
        }
      );
    },
    [persistUserAnnotations]
  );

  const removeContextUserAnnotation = useCallback(() => {
    const value = sequenceContextMenu?.clickedUserAnnotation;
    if (value) removeUserAnnotation(value);
  }, [removeUserAnnotation, sequenceContextMenu?.clickedUserAnnotation]);

  const saveNewUserAnnotation = useCallback(
    (chrom: string, annotation: Annotation) => {
      persistUserAnnotations((previous) =>
        upsertIndexedUserAnnotation(previous, {
          id: allocateIndexedAnnotationId(),
          chrom,
          annotation,
        })
      );
      setAnnotationDialog(null);
      useToastStore.getState().addToast(
        userMessageWithValues('notice.added-annotation-value', {
          value0: userMessageValue(annotation.name),
        }),
        {
          definition: 'indexed-genome-tab-annotation-added',
        }
      );
    },
    [persistUserAnnotations]
  );

  const saveEditedUserAnnotation = useCallback(
    (value: IndexedGenomeUserAnnotation, annotation: Annotation) => {
      persistUserAnnotations((previous) =>
        upsertIndexedUserAnnotation(previous, { ...value, annotation })
      );
      setAnnotationDialog(null);
      useToastStore.getState().addToast(
        userMessageWithValues('notice.updated-annotation-value', {
          value0: userMessageValue(annotation.name),
        }),
        {
          definition: 'indexed-genome-tab-annotation-updated',
        }
      );
    },
    [persistUserAnnotations]
  );

  useEffect(() => {
    if (!isActive || !selectedActionTarget) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, ['cmd', 'c'])) return;
      const nativeSelection = window.getSelection();
      if (
        nativeSelection &&
        !nativeSelection.isCollapsed &&
        nativeSelection.toString().length > 0
      ) {
        return;
      }
      event.preventDefault();
      void copyIndexedSelection('read', selectedActionTarget);
    };
    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => presentationEvents.remove(document, 'keydown', handleKeyDown);
  }, [copyIndexedSelection, isActive, selectedActionTarget, presentationEvents]);

  const handleSelectMutation = useCallback(
    (variant: VariantSummary) => {
      if (!canNavigate) return;
      const globalRange = mutationGlobalRange({
        ...(assembly ? { assembly } : {}),
        activeChrom: displayedChrom,
        singleChromLength: length,
        variant,
      });
      const chromosomeGlobalRange = mutationChromosomeGlobalRange({
        ...(assembly ? { assembly } : {}),
        activeChrom: displayedChrom,
        singleChromLength: length,
        variant,
      });
      const viewport = mutationViewport({ globalRange, chromosomeGlobalRange });
      const viewerCommandId = ++viewportCommandIdRef.current;
      lifecycleOwnerRef.current?.operation.acceptViewport(viewerCommandId);
      pendingIndexedViewportCommitRef.current = viewerCommandId;
      setViewportCommand({
        id: viewerCommandId,
        start: viewport.start,
        end: viewport.end,
      });
      setSearchHighlight({
        id: ++searchHighlightIdRef.current,
        start: globalRange.start,
        end: globalRange.end,
      });
      selectMutationVariant(variant.id);
    },
    [assembly, canNavigate, displayedChrom, length, selectMutationVariant]
  );
  const sceneViewport = useMemo<IndexedGenomeSceneViewport | null>(() => {
    if (length <= 0) return null;
    return {
      chrom: displayedChrom,
      startBp: rangeStart,
      endBp: rangeEnd,
      widthPx: 1,
      heightPx: 1,
      pixelsPerBp: 1 / Math.max(1, rangeEnd - rangeStart),
      generation: viewportCommand?.id ?? 0,
    };
  }, [displayedChrom, length, rangeEnd, rangeStart, viewportCommand?.id]);
  const sessionScene = useMemo(
    () =>
      sessionShell
        ? buildIndexedGenomeScene({
            shell: sessionShell,
            viewport: sceneViewport,
          })
        : null,
    [sceneViewport, sessionShell]
  );
  const sessionSequenceTrack = sessionScene?.tracks.find((track) => track.kind === 'sequence');
  const sessionAnnotationTrack = sessionScene?.tracks.find((track) => track.kind === 'annotation');

  const handleJumpToSearchResult = useCallback(
    (match: IndexedGenomeSearchMatch) => {
      if (!canNavigate || length <= 0) return;
      const start = match.start;
      const end = match.end + 1;
      const currentViewport = liveViewportRange
        ? liveViewportRange
        : viewportCommand
          ? { start: viewportCommand.start, end: viewportCommand.end }
          : { start: rangeStart, end: rangeEnd };
      const zoomed = autoZoomToFeature({
        featureStart: start,
        featureEnd: end,
        viewport: currentViewport,
        genomeLength: length,
      });
      const nextViewportId = ++viewportCommandIdRef.current;
      const nextHighlightId = ++searchHighlightIdRef.current;
      lifecycleOwnerRef.current?.operation.acceptViewport(nextViewportId);
      pendingIndexedViewportCommitRef.current = nextViewportId;
      setViewportCommand({ id: nextViewportId, start: zoomed.start, end: zoomed.end });
      setSearchHighlight({
        id: nextHighlightId,
        start,
        end,
        ...(match.featureType ? { featureType: match.featureType } : {}),
        ...(match.annotationTrackId ? { annotationTrackId: match.annotationTrackId } : {}),
        ...(match.canonicalIdentity ? { canonicalIdentity: match.canonicalIdentity } : {}),
        ...(match.annotationFeatureIndex === undefined
          ? {}
          : { annotationFeatureIndex: match.annotationFeatureIndex }),
        ...(match.protein?.segments?.length ? { proteinSegments: match.protein.segments } : {}),
      });
    },
    [canNavigate, length, liveViewportRange, rangeEnd, rangeStart, viewportCommand]
  );

  const [viewerWidthPx, setViewerWidthPx] = useState(0);
  const toolChromosomes = useMemo(
    () =>
      assembly
        ? assembly.chromosomes.map(({ chrom, length: chromosomeLength }) => ({
            chrom,
            length: chromosomeLength,
          }))
        : [{ chrom: indexedState?.chrom ?? manifest?.chrom ?? sourceChrom, length }],
    [assembly, indexedState?.chrom, length, manifest?.chrom, sourceChrom]
  );
  const readToolSequence = useCallback(
    async (chrom: string, start0: number, end0: number) => {
      const targetManifest = indexedManifestForTarget(indexedStateRef.current, {
        chrom,
        start0,
        end0,
      });
      if (!targetManifest) throw new Error(`The indexed source for ${chrom} is not available.`);
      return createPlatformIndexedGenomeDataSource(
        targetManifest,
        workspaceRoot ? [workspaceRoot] : []
      ).getSequence(chrom, start0, end0);
    },
    [workspaceRoot]
  );
  const revealToolRange = useCallback(
    (start: number, end: number) =>
      handleJumpToSearchResult({ start, end: end - 1, strand: 'forward', type: 'nucleotide' }),
    [handleJumpToSearchResult]
  );
  const primerWorkspaceRoot = useMemo(() => {
    const containing = workspaceRoot
      ? workspaceFolders.find(
          (folder) => workspaceRoot === folder.path || workspaceRoot.startsWith(`${folder.path}/`)
        )
      : undefined;
    return (containing ?? workspaceFolders[0])?.path ?? null;
  }, [workspaceFolders, workspaceRoot]);
  const reportToolError = useCallback(
    (message: string) =>
      useToastStore.getState().addToast(toUserMessage(message, 'tracks.loadFailed'), {
        definition: 'indexed-genome-tab-tool-error',
      }),
    []
  );
  const openInFocusedPanel = useCanvasStore((state) => state.openInFocusedPanel);
  const openPrimerDocument = useCallback(
    (location: PrimerArtifactLocation, name: string) =>
      openInFocusedPanel('primer', location.artifactPath, name, {
        artifactDocument: { kind: 'primer', persistence: 'persisted', ...location },
      }),
    [openInFocusedPanel]
  );
  const indexedTools = useIndexedGenomeTools({
    scopeKey: assembly?.assemblyId ?? indexedState?.sourcePath ?? tab.id,
    structureEntityId: `indexed-genome:${tab.id}`,
    viewport: liveViewportRange,
    selection: selectedActionTarget,
    viewerWidthPx,
    chromosomes: toolChromosomes,
    readSequence: readToolSequence,
    onRevealRange: revealToolRange,
    primerBindings: indexedState?.primerBindings ?? NO_PRIMER_BINDINGS,
    persistPrimerBindings,
    primerWorkspaceRoot,
    onError: reportToolError,
    workspaceFolders,
    openPrimerDocument,
  });
  primerBindingAtHitRef.current = indexedTools.bindingAtHit;

  const { openStructure } = indexedTools;
  const handleViewCdsStructure = useCallback(async () => {
    const cds = sequenceContextMenu?.clickedCds;
    if (!cds) return;
    const translated = await translateClickedCds();
    if (!translated) return;
    const request = buildStructureDrawerRequestFromIndexedCds({
      cds: cds.annotation,
      protein: translated.protein,
      location: {
        referenceId: assembly?.assemblyId ?? indexedStateRef.current?.sourcePath ?? tab.id,
        chrom: cds.target.chrom,
        start0: cds.target.start0,
        end0: cds.target.end0,
        strand: cds.strand === '-' ? -1 : 1,
      },
      entityId: `indexed-genome:${tab.id}`,
    });
    if (!request) {
      useToastStore
        .getState()
        .addToast(userMessage('notice.this-cds-does-not-translate-to-a-complete-protein'), {
          definition: 'indexed-genome-tab-cds-not-complete-protein',
        });
      return;
    }
    openStructure(request);
  }, [
    assembly?.assemblyId,
    openStructure,
    sequenceContextMenu?.clickedCds,
    tab.id,
    translateClickedCds,
  ]);

  const searchSources = indexedGenomeSearchSources({
    completeAssemblyRequest: completeAssemblyAnnotationSceneRequest,
    annotationIndex,
    isActive,
    assemblySearchSource: sessionShell?.assemblySearchSource,
    assemblySequenceSearchSource,
  });
  const search = useGenomeSearch({
    manifest,
    chrom: displayedChrom,
    annotationIndex: searchSources.annotationIndex,
    assemblyAnnotationSearchSource: searchSources.assemblyAnnotationSearchSource,
    assemblySequenceSearchSource: searchSources.assemblySequenceSearchSource,
    annotationIndexError: null,
    visibleAnnotationTrackIds,
    onJumpToMatch: handleJumpToSearchResult,
  });

  useEffect(() => {
    if (assemblyAnnotationSearchReady || search.mode !== 'aminoAcid') return;
    search.setMode('nucleotide');
  }, [assemblyAnnotationSearchReady, search.mode, search.setMode]);

  useEffect(() => {
    setSearchHighlight(null);
  }, [search.mode, search.query]);
  useEffect(() => {
    setSearchHighlight(null);
  }, [search.annotationAuthorityRevision]);
  useEffect(() => {
    if (!isActive || !search.isOpen) setSearchHighlight(null);
  }, [isActive, search.isOpen, presentation]);

  useEffect(() => {
    if (!isActive || !search.isOpen) return;
    const lease = presentation.owner.captureFocus(presentation.id);
    const id = requestAnimationFrame(() => {
      if (!presentation.owner.isCurrent(lease)) return;
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="findbar-shell"] input[aria-label="Search pattern"]'
      );
      input?.focus();
      input?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [isActive, search.isOpen, presentation]);

  const sequenceScope = useCommandScope(COMMAND_SCOPES.tabSequence, {
    claimOnMount: true,
    enabled: isActive,
  });

  useCommandHandler(
    COMMAND_IDS.sequenceFind,
    () => {
      if (!sequenceSearchReady || !isActive) return false;
      search.openInMode(
        search.isOpen && search.mode === 'nucleotide' && assemblyAnnotationSearchReady
          ? 'aminoAcid'
          : 'nucleotide'
      );
      return true;
    },
    {
      scope: COMMAND_SCOPES.tabSequence,
      enabled: () => sequenceSearchReady && isActive,
    }
  );

  return (
    <IndexedGenomeTabShell
      sessionScene={sessionScene}
      sessionShell={sessionShell}
      sessionSequenceTrack={sessionSequenceTrack}
      sessionAnnotationTrack={sessionAnnotationTrack}
      assembly={assembly}
      assemblySourceReady={assemblySourceReady}
      assemblyAnnotationsNotApplicable={assemblyAnnotationsNotApplicable}
      assemblyAnnotationProductsReady={assemblyAnnotationProductsReady}
      assemblyAnnotationSearchNotApplicable={assemblyAnnotationSearchNotApplicable}
      assemblyAnnotationSearchReady={assemblyAnnotationSearchReady}
      hostedBackgroundPreparation={visibleHostedBackgroundPreparation}
      eventHandlers={sequenceScope.eventHandlers}
    >
      {indexedState?.referenceAnnotationUpdateNotice && (
        <div
          role="status"
          data-testid="reference-annotation-update-notice"
          className="px-3 py-1 text-xs text-fg-muted bg-surface-secondary"
        >
          {indexedState.referenceAnnotationUpdateNotice}
        </div>
      )}
      <IndexedGenomeTabChrome
        tabId={tab.id}
        assembly={assembly}
        fileName={fileName}
        length={length}
        assemblySourceReady={assemblySourceReady}
        assemblyAnnotationsNotApplicable={assemblyAnnotationsNotApplicable}
        assemblyAnnotationSearchReady={assemblyAnnotationSearchReady}
        assemblyAnnotationSearchNotApplicable={assemblyAnnotationSearchNotApplicable}
        totalAnnotationCount={totalAnnotationCount}
        positionInput={positionInput}
        onPositionInputChange={setPositionInput}
        onGoToPosition={goToInputPosition}
        canNavigate={canNavigate}
        windowSize={windowSize}
        onWindowSizeChange={handleWindowSizeChange}
        displayedViewportRange={displayedViewportRange}
        displayedViewportSpan={Math.max(
          0,
          displayedViewportRange.end - displayedViewportRange.start
        )}
        sequenceSearchReady={sequenceSearchReady}
        searchMode={search.mode}
        onOpenSearch={search.openInMode}
        savingPortableView={savingPortableView}
        onSavePortableView={() => void savePortableView()}
        dataRestoreIssues={[
          ...dataTrackRestore.issues,
          ...bamTrackRestore.issues.filter((issue) => issue.kind === 'remote-signal'),
        ]}
        featureDetailsState={featureDetailsState}
        viewActions={
          assembly ? (
            <TrackViewActions
              readyForDirtyCheck={
                liveViewportRange !== null &&
                visibleAnnotationTrackIds !== null &&
                orderedAnnotationTrackIds !== null &&
                bamTrackRestore.status === 'ready' &&
                dataTrackRestore.status === 'ready' &&
                (!portableViewRestoreCommand ||
                  committedViewRestoreId === portableViewRestoreCommand.id)
              }
              isActive={isActive}
              tab={tab}
              referenceName={assembly.displayName}
              capturePortableReference={async () => {
                const current = indexedStateRef.current;
                if (!current) throw new Error('The reference is still opening.');
                return portableReferenceFromIndexedGenome(current);
              }}
              capture={() => {
                const current = indexedStateRef.current;
                if (!current) throw new Error('The reference is still opening.');
                const visible = visibleAnnotationTrackIds ?? new Set<string>();
                const order = orderedAnnotationTrackIds ?? [
                  ...(current.assemblyAnnotationTrackTypes ?? []),
                ];
                const viewport = liveViewportRangeRef.current ?? displayedViewportRange;
                const savedViewport = normalizeIndexedViewportForPersistence(viewport, length);
                if (!savedViewport) throw new Error('The displayed view has no valid viewport.');
                const liveLanes = useLaneContractStore.getState().lanesForOwner(tab.id);
                return {
                  reference: trackViewReference(current),
                  viewport: savedViewport,
                  scope: current.scope ?? { kind: 'all' },
                  annotation: {
                    policy: { ...annotationMapperPolicy },
                    orderedTrackIds: [...order],
                    visibilityByTrackId: Object.fromEntries(
                      order.map((id) => [id, visible.has(id)])
                    ),
                  },
                  dataTracks: liveLanes.flatMap((lane) => {
                    const track = indexedGenomeDataTrackFromLane(lane);
                    return track ? [track] : [];
                  }),
                  bamTracks: current.bamTracks ?? [],
                  signalReadPileupViews: liveLanes.flatMap((lane) => {
                    const view = indexedGenomeSignalReadPileupViewFromLane(lane);
                    return view ? [view] : [];
                  }),
                  ...(current.variantSource ? { variantSource: current.variantSource } : {}),
                  ...trackViewUserLayers(current),
                };
              }}
            />
          ) : undefined
        }
      />
      <IndexedGenomeTabRuntime
        tabId={tab.id}
        allowAutomaticSignalReadPileupViews={!tab.trackView && !portableViewRestoreCommand}
        assembly={assembly}
        canShowViewer={canShowViewer}
        rangeStatus={rangeStatus}
        rangeError={toOptionalUserMessage(rangeError)}
        manifest={manifest}
        sessionId={sessionShell?.sessionId}
        themeMode={viewerThemeMode}
        length={length}
        isActive={isActive}
        targetViewport={viewportCommand}
        searchHighlight={searchHighlight}
        onContextMenu={handleIndexedContextMenu}
        onSelectionChange={handleIndexedSelectionChange}
        onSelectionClear={handleIndexedSelectionClear}
        userAnnotationDataset={userAnnotationDataset}
        onTargetViewportCommitted={handleTargetViewportCommitted}
        onViewportPresented={handleViewportPresented}
        onViewportRangeChange={handleViewportRangeChange}
        onAnnotationIndexBuilt={setAnnotationIndex}
        onVisibleAnnotationTypesChange={handleVisibleAnnotationTypesChange}
        onAnnotationTrackOrderChange={setOrderedAnnotationTrackIds}
        annotationVisibilityCommand={
          portableViewRestoreCommand
            ? {
                id: portableViewRestoreCommand.id,
                visibleTrackIds: portableViewRestoreCommand.visibleAnnotationTrackIds,
                orderedTrackIds: portableViewRestoreCommand.orderedAnnotationTrackIds,
              }
            : null
        }
        onViewerLoadPhase={(phase, message) => {
          if (phase === 'ready') {
            viewerPresentationRef.current = viewerPresentationOwnerKey;
          }
          const owner = lifecycleOwnerRef.current;
          if (
            phase === 'error' &&
            owner?.sessionId &&
            owner.sessionId === sessionShell?.sessionId
          ) {
            owner.operation.end({ outcome: 'failed', reason: 'renderer' });
          }
          setViewerLoadPhase(phase);
          setViewerLoadError(
            phase === 'error'
              ? message != null
                ? toUserMessage(message, 'tracks.loadFailed')
                : null
              : null
          );
        }}
        onTrackError={markVisibleTrackError}
        onFeatureDetailsStateChange={setFeatureDetailsState}
        assemblyChromIds={assemblyChromIds}
        chromGffPaths={chromGffPaths}
        scope={scope}
        assemblyAnnotations={assemblyAnnotations}
        assemblyAnnotationTrackTypes={indexedState?.assemblyAnnotationTrackTypes}
        assemblySessionConfigs={assemblySessionConfigs}
        annotationSceneSourceRequest={viewerAnnotationSceneSourceRequest}
        prepackedAnnotationSceneCache={prepackedAnnotationSceneCache}
        annotationAssetGeneration={activeAnnotationAssetGeneration}
        annotationProductPublicationReady={assemblyAnnotationProductsReady}
        annotationInteractionPayloadEnabled={interactionPayloadEnabled}
        annotationInteractionPreparationGeneration={annotationProductAdmissionGeneration}
        annotationMapperPolicy={annotationMapperPolicy}
        onAnnotationMapperPolicyChange={commitAnnotationMapperPolicy}
        allocateAnnotationMapperPolicyRequestId={allocateAnnotationMapperPolicyRequestId}
        requireFullAssemblyReadiness={fullAssemblyReadinessRequired}
        allowTrackOnlyInteraction={allowTrackOnlyInteraction}
        loadPhase={loadPhase}
        visualChrom={visualChrom}
        fileName={fileName}
        sourceSizeBytes={indexedState?.sourceSizeBytes}
        tabFileSizeBytes={tab.fileSizeBytes}
        prepareError={toOptionalUserMessage(prepareError)}
        viewerLoadError={toOptionalUserMessage(viewerLoadError)}
        sequenceSearchReady={sequenceSearchReady}
        search={search}
        assemblyAnnotationSearchReady={assemblyAnnotationSearchReady}
        assemblyAnnotationSearchNotApplicable={assemblyAnnotationSearchNotApplicable}
        mutationNavigator={mutationNavigator}
        onSelectMutation={handleSelectMutation}
        sequenceOverlays={indexedTools.sequenceOverlays}
        onCameraSample={indexedTools.onCameraSample}
        toolRail={indexedTools.toolRail}
        drawerSlot={indexedTools.drawerSlot}
        onViewerWidthChange={setViewerWidthPx}
      />
      <SequenceContextMenu
        x={sequenceContextMenu?.x ?? 0}
        y={sequenceContextMenu?.y ?? 0}
        isOpen={sequenceContextMenu !== null}
        onClose={() => setSequenceContextMenu(null)}
        hasSelection={Boolean(sequenceContextMenu?.selectionTarget)}
        selectionRange={
          sequenceContextMenu?.selectionTarget
            ? {
                start: sequenceContextMenu.selectionTarget.start0 + 1,
                end: sequenceContextMenu.selectionTarget.end0,
              }
            : null
        }
        onCopySequence={
          sequenceContextMenu?.selectionTarget
            ? () => void copyIndexedSelection('read', sequenceContextMenu.selectionTarget)
            : undefined
        }
        onCopyReverseComplement={
          sequenceContextMenu?.selectionTarget
            ? () =>
                void copyIndexedSelection('reverse_complement', sequenceContextMenu.selectionTarget)
            : undefined
        }
        onCopyTranslation={
          sequenceContextMenu?.selectionTarget ? () => void handleCopyTranslation() : undefined
        }
        clickedTranscript={
          sequenceContextMenu?.clickedTranscript
            ? { name: sequenceContextMenu.clickedTranscript.name }
            : null
        }
        onCopyTranscriptDna={
          sequenceContextMenu?.clickedTranscript
            ? () => {
                const transcript = sequenceContextMenu?.clickedTranscript;
                if (transcript) void copyIndexedTranscript(transcript, 'dna');
              }
            : undefined
        }
        onCopyTranscriptRna={
          sequenceContextMenu?.clickedTranscript
            ? () => {
                const transcript = sequenceContextMenu?.clickedTranscript;
                if (transcript) void copyIndexedTranscript(transcript, 'rna');
              }
            : undefined
        }
        onChooseTranscriptIsoform={
          sequenceContextMenu?.clickedTranscript
            ? () => {
                const transcript = sequenceContextMenu?.clickedTranscript;
                if (transcript) void openIsoformChooser(transcript);
              }
            : undefined
        }
        clickedCDS={sequenceContextMenu?.clickedCds?.annotation ?? null}
        onCopyCDSTranslation={
          sequenceContextMenu?.clickedCds ? () => void handleCopyCdsTranslation() : undefined
        }
        onCreateAminoAcidSequence={
          sequenceContextMenu?.clickedCds ? () => void handleCreateAminoAcidSequence() : undefined
        }
        onViewStructure={
          sequenceContextMenu?.clickedCds ? () => void handleViewCdsStructure() : undefined
        }
        clickedPrimer={
          sequenceContextMenu?.clickedPrimer
            ? {
                id: sequenceContextMenu.clickedPrimer.id,
                name: sequenceContextMenu.clickedPrimer.primerName,
                start: sequenceContextMenu.clickedPrimer.start0,
                end: sequenceContextMenu.clickedPrimer.end0,
                direction: sequenceContextMenu.clickedPrimer.strand === '+' ? 'forward' : 'reverse',
              }
            : null
        }
        {...(sequenceContextMenu?.clickedPrimer
          ? indexedTools.primerMenuActions(sequenceContextMenu.clickedPrimer)
          : {})}
        onAttachPrimers={() =>
          indexedTools.attachPrimers(sequenceContextMenu?.selectionTarget ?? null)
        }
        onCreateForwardPrimer={
          sequenceContextMenu?.selectionTarget
            ? () => {
                const target = sequenceContextMenu?.selectionTarget;
                if (target) indexedTools.createPrimerFromSelection(target, 'forward');
              }
            : undefined
        }
        onCreateReversePrimer={
          sequenceContextMenu?.selectionTarget
            ? () => {
                const target = sequenceContextMenu?.selectionTarget;
                if (target) indexedTools.createPrimerFromSelection(target, 'reverse');
              }
            : undefined
        }
        clickedAnnotation={sequenceContextMenu?.clickedUserAnnotation?.annotation ?? null}
        onAddAnnotation={sequenceContextMenu?.selectionTarget ? openAddAnnotationDialog : undefined}
        onEditAnnotation={
          sequenceContextMenu?.clickedUserAnnotation ? openEditAnnotationDialog : undefined
        }
        onDeleteAnnotation={
          sequenceContextMenu?.clickedUserAnnotation ? removeContextUserAnnotation : undefined
        }
      />
      <IndexedGenomeAnnotationDialog
        state={annotationDialog}
        allAnnotations={userAnnotationValues}
        onSaveNew={saveNewUserAnnotation}
        onSaveEdit={saveEditedUserAnnotation}
        onDelete={removeUserAnnotation}
        onCancel={() => setAnnotationDialog(null)}
      />
      <IndexedGenomeIsoformDialog
        state={isoformDialog}
        onSelect={(isoform) =>
          setIsoformDialog((current) =>
            current?.kind === 'ready'
              ? { ...current, selectedFeatureId: isoform.featureId }
              : current
          )
        }
        onCopy={(isoform, molecule) =>
          void copyIndexedTranscript(transcriptActionTargetFromIsoform(isoform), molecule)
        }
        onCancel={() => {
          isoformRequestIdRef.current += 1;
          setIsoformDialog(null);
        }}
      />
      <CreateAminoAcidSequenceDialog
        pending={pendingProteinCreation}
        onCancel={() => setPendingProteinCreation(null)}
        onConfirm={handleConfirmCreateAminoAcidSequence}
        isCreating={isCreatingProtein}
        roots={proteinSaveLocationRoots}
      />
    </IndexedGenomeTabShell>
  );
}

function markGenomeSessionTrackError(
  shell: GenomeSessionShell,
  kind: GenomeTrackDescriptor['kind'],
  message: string
): GenomeSessionShell {
  return {
    ...shell,
    tracks: shell.tracks.map((track) =>
      track.kind === kind
        ? {
            ...track,
            state: 'error',
            userState: 'Needs attention',
            message,
          }
        : track
    ),
  };
}

function tabStateFromReadySessionShell(input: {
  shell: GenomeSessionShell;
  sourceExt: string;
  sourceTimestamps: Pick<IndexedGenomeTabState, 'sourceMtimeMs' | 'sourceCtimeMs'>;
}): IndexedGenomeTabState | null {
  const { shell } = input;
  if (!shell.openReady) return null;
  if (shell.validationState !== 'strong_match') return null;
  if (!shell.coordinateReady || !shell.manifest || typeof shell.length !== 'number') return null;

  return {
    sourcePath: shell.sourcePath,
    sourceSizeBytes: shell.sourceSizeBytes,
    ...input.sourceTimestamps,
    sourceExt: input.sourceExt,
    chrom: shell.chrom,
    manifest: {
      ...shell.manifest,
      length: shell.length,
    },
    metadata: {
      length: shell.length,
      circular: shell.manifest.circular ?? false,
    },
    indexedAt: Date.now(),
  };
}
