'use client';

import { toUserMessage, userMessage } from '@waypoint/user-messages';
import React, { useRef, useState, useLayoutEffect, useEffect, useMemo, useCallback } from 'react';
import {
  type Structure3dAttrs,
  type StructureViewState,
  type StructureScene,
  type StructureChainColoring,
} from './types';
import {
  viewerCache,
  pendingCreations,
  startCacheCleanup,
  getStructureKey,
  getPaneRendererHostCacheKey,
  getViewerCacheKey,
  clearViewerCache,
  recordCacheInsert,
  recordPendingCreationAdd,
  recordPendingCreationDelete,
  deleteCachedViewer,
  registerActiveWrapper,
  unregisterActiveWrapper,
  setPluginSpin,
  type CachedViewer,
} from './viewerCache';
import type { MolstarPlugin } from './molstar/cache';
import {
  attachHandoffPoster,
  attachLoadingViewerContainer,
  attachViewerContainer,
  captureViewerPosterDataUrl,
  clearViewerWrapper,
  detachCachedViewerContainer,
  getPreviewPosterForLoadedViewer,
  hasHandoffPoster,
  previewCompanionCacheEntry,
  releaseHandoffPosterAfterLoadedPaint,
  revealViewerContainer,
  schedulePreviewPosterCapture,
  setCachedViewerCanvasVisibility,
  shouldKeepExistingViewerUntilReveal,
} from './molstar/viewerDomHandoff';
import {
  restartMolstarPaneAnimationLoop,
  resizeMolstarViewer,
  scheduleMolstarFrameKicks,
} from './molstar/viewerFrameKicks';
import { bindMolstarCanvasCursor } from './molstar/viewerPointer';
import { useMolstarVisibilityPause } from './hooks/useMolstarVisibilityPause';
import { useScrollIdleGate } from '../../hooks/useScrollIdleGate';
import {
  applyMolstarRenderPlanAfterReady,
  applyMolstarRenderPlanBeforeReveal,
  didRenderPlanApplyKeyChange,
  isMolstarRenderPlanApplyCancelledError,
  renderPlanApplyKeys,
  renderPlanApplySignature,
  shouldSkipInitialPostReadyRenderPlanApply,
  type MolstarRenderPlanApplyKeys,
} from './molstar/applyMolstarRenderPlan';
import {
  compileMolstarRenderPlanFromTransaction,
  type MolstarRenderPlan,
} from './molstar/molstarRenderPlan';
import type { StructureRenderModel } from './utils/structureRenderModel';
import {
  compileStructureRenderTransaction,
  type StructureRenderTransaction,
} from './utils/structureRenderTransaction';
import { assertStructureRenderPlanSatisfiedForViewer } from './molstar/renderPlanInvariant';
import {
  activeMolViewSpecScene,
  activeMolViewSpecResourceNames,
  bindMolViewSpecPinnedAssets,
  sameLoadedMolViewSpecScene,
  activeMolViewSpecSnapshotIndex,
  clearMolViewSpecScene,
  loadMolViewSpecScene,
  MolViewSpecSceneError,
  registerMolViewSpecController,
  hasMolViewSpecController,
  selectMolViewSpecSnapshot,
  validateMolViewSpecScene,
} from './molstar/molViewSpec';
import {
  recordStructureRenderTransactionDiagnostic,
  removeStructureRenderTransactionDiagnostic,
} from './utils/structureRenderTransactionDiagnostics';
import { createDefaultStructureViewState } from './utils/viewRecipe';
import type { PinnedMolecularAsset } from './utils/molecularView';
import {
  fetchStructureData,
  fetchStructureFromUrl,
  type StructureFetchIdentity,
} from './utils/structureData';
import { createViewerContainer } from './molstar/createViewer';
import { activateViewerStructure } from './molstar/activateViewerStructure';
import {
  requestRendererHostStructure,
  enqueueRendererHostSceneOperation,
} from './molstar/rendererHostActivation';
import { waitForPluginInteractionReady } from './molstar/viewerReadiness';
import {
  formatMolstarViewerDisplayError,
  MOLSTAR_VIEWER_GENERIC_RENDER_ERROR,
  CANCELLED_VIEWER_LOAD_ERROR,
} from './molstar-viewer-error';

export type { MolstarColorMode, MolstarRepresentation } from './molstar/viewerTypes';
export { scheduleMolstarFrameKicks } from './molstar/viewerFrameKicks';
export { shouldSkipInitialPostReadyRenderPlanApply } from './molstar/applyMolstarRenderPlan';
export { formatMolstarViewerDisplayError, MOLSTAR_VIEWER_GENERIC_RENDER_ERROR };

function recordMolstarViewerErrorForTest(input: {
  viewerCacheKey: string;
  structureKey: string;
  phase: string;
  rawError: string;
  displayError: string;
}): void {
  if (!(import.meta.env.DEV || import.meta.env.MODE === 'test')) return;
  const globalWindow = window as typeof window & {
    __WAYPOINT_MOLSTAR_VIEWER_ERRORS__?: Array<{
      at: number;
      viewerCacheKey: string;
      structureKey: string;
      phase: string;
      rawError: string;
      displayError: string;
    }>;
  };
  const next = [
    ...(globalWindow.__WAYPOINT_MOLSTAR_VIEWER_ERRORS__ ?? []),
    { at: Date.now(), ...input },
  ];
  globalWindow.__WAYPOINT_MOLSTAR_VIEWER_ERRORS__ = next.slice(-25);
}

declare global {
  interface Window {
    __WAYPOINT_E2E_MOLSTAR_STUB__?: boolean;
    __WAYPOINT_E2E_MOLSTAR_FETCH_BYTES__?: boolean;
  }
}

export interface MolstarViewerProps {
  pdbId?: string;
  uniprotId?: string;
  url?: string;
  structureData?: string | Uint8Array;
  structureDataFormat?: 'pdb' | 'mmcif';
  coordinateModel?: { blockIndex: number; modelIndex: number };
  structureKeyOverride?: string;
  structureIdentity?: StructureFetchIdentity;
  height?: number;
  fillContainer?: boolean;
  view?: StructureViewState;
  molViewSpec?: string;
  molViewSpecAssets?: readonly PinnedMolecularAsset[];
  molViewSpecSnapshotIndex?: number;
  molViewSpecSelectionRevision?: number;
  scene?: StructureScene;
  chainColoring?: StructureChainColoring;
  renderModel?: StructureRenderModel | undefined;
  sourceColorContext?: Partial<Structure3dAttrs>;
  cameraSnapshot?: string;
  scrollZoom?: boolean;
  deferWhileScrolling?: boolean;
  viewerInstanceId?: string;
  rendererHostId?: string;
  onCameraChange?: (snapshot: string) => void;
  onError?: (error: string) => void;
  onSlowLoad?: () => void;
  onLoad?: () => void;
  loadRequestKey?: string;
  onPluginReady?: (plugin: MolstarPlugin | null) => void;
}

const latestRevealPlanByViewerCacheKey = new Map<string, MolstarRenderPlan>();
const latestRevealPlanKeysByViewerCacheKey = new Map<string, MolstarRenderPlanApplyKeys>();
const latestRevealTransactionByViewerCacheKey = new Map<string, StructureRenderTransaction>();
const MAX_REVEAL_STYLE_SNAPSHOTS = 64;
const CAMERA_SNAPSHOT_PERSIST_IDLE_MS = 500;

type CameraPersistenceDiagnosticEvent = {
  stage: 'scheduled' | 'rescheduled' | 'persisted' | 'spin-skip';
  at: number;
  elapsedSinceChangeMs?: number;
};

function recordCameraPersistenceDiagnostic(event: CameraPersistenceDiagnosticEvent) {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __WAYPOINT_MOLSTAR_CAMERA_PERSISTENCE__?: {
      last: CameraPersistenceDiagnosticEvent;
      events: CameraPersistenceDiagnosticEvent[];
    };
  };
  const current = testWindow.__WAYPOINT_MOLSTAR_CAMERA_PERSISTENCE__;
  testWindow.__WAYPOINT_MOLSTAR_CAMERA_PERSISTENCE__ = {
    last: event,
    events: [...(current?.events ?? []), event].slice(-100),
  };
}

function latestRevealPlanForViewerCacheKey(
  viewerCacheKey: string,
  fallback: MolstarRenderPlan
): MolstarRenderPlan {
  return latestRevealPlanByViewerCacheKey.get(viewerCacheKey) ?? fallback;
}

function latestRevealPlanKeysForViewerCacheKey(
  viewerCacheKey: string,
  fallback: MolstarRenderPlanApplyKeys
): MolstarRenderPlanApplyKeys {
  return latestRevealPlanKeysByViewerCacheKey.get(viewerCacheKey) ?? fallback;
}

function latestRevealTransactionForViewerCacheKey(
  viewerCacheKey: string,
  fallback: StructureRenderTransaction
): StructureRenderTransaction {
  return latestRevealTransactionByViewerCacheKey.get(viewerCacheKey) ?? fallback;
}

function isLatestRevealPlanKeysForViewerCacheKey(
  viewerCacheKey: string,
  planKeys: MolstarRenderPlanApplyKeys
): boolean {
  const latest = latestRevealPlanKeysByViewerCacheKey.get(viewerCacheKey);
  if (!latest) return true;
  return renderPlanApplySignature(latest) === renderPlanApplySignature(planKeys);
}

function rememberLatestRevealPlanForViewerCacheKey(
  viewerCacheKey: string,
  plan: MolstarRenderPlan,
  planKeys: MolstarRenderPlanApplyKeys,
  transaction: StructureRenderTransaction
): void {
  if (!viewerCacheKey) return;
  latestRevealPlanByViewerCacheKey.delete(viewerCacheKey);
  latestRevealPlanKeysByViewerCacheKey.delete(viewerCacheKey);
  latestRevealTransactionByViewerCacheKey.delete(viewerCacheKey);
  latestRevealPlanByViewerCacheKey.set(viewerCacheKey, plan);
  latestRevealPlanKeysByViewerCacheKey.set(viewerCacheKey, planKeys);
  latestRevealTransactionByViewerCacheKey.set(viewerCacheKey, transaction);
  while (latestRevealPlanByViewerCacheKey.size > MAX_REVEAL_STYLE_SNAPSHOTS) {
    const oldestKey = latestRevealPlanByViewerCacheKey.keys().next().value;
    if (!oldestKey) break;
    latestRevealPlanByViewerCacheKey.delete(oldestKey);
    latestRevealPlanKeysByViewerCacheKey.delete(oldestKey);
    latestRevealTransactionByViewerCacheKey.delete(oldestKey);
  }
}

function notifyPluginReady(
  structureKey: string,
  viewerCacheKey: string,
  wrapper: HTMLDivElement | null,
  plugin: Parameters<typeof registerActiveWrapper>[2],
  onPluginReady: ((plugin: MolstarPlugin | null) => void) | undefined
): void {
  if (wrapper) {
    registerActiveWrapper(structureKey, wrapper, plugin, viewerCacheKey);
  }
  onPluginReady?.(plugin);
}

function hasPreviousPaneError(cached: CachedViewer | undefined, structureKey: string): boolean {
  const requested = cached?.rendererHostActivation?.requestedStructureKey;
  return !!cached?.error && !cached.isLoading && !!requested && requested !== structureKey;
}

function isMolstarE2eStubEnabled(): boolean {
  return typeof window !== 'undefined' && window.__WAYPOINT_E2E_MOLSTAR_STUB__ === true;
}

function isMolstarE2eStubByteFetchEnabled(): boolean {
  return typeof window !== 'undefined' && window.__WAYPOINT_E2E_MOLSTAR_FETCH_BYTES__ === true;
}

function stableStructureIdentityKey(identity: StructureFetchIdentity | undefined): string {
  if (!identity) return '';
  return JSON.stringify({
    provider: identity.provider,
    externalId: identity.externalId,
    fetchExternalId: identity.fetchExternalId,
    format: identity.format,
    pdbId: identity.pdbId,
    pdbEntityId: identity.pdbEntityId,
    labelAsymIds: [...(identity.labelAsymIds ?? [])].sort(),
    authAsymIds: [...(identity.authAsymIds ?? [])].sort(),
    assemblyId: identity.assemblyId,
    accession: identity.accession,
    fragment: identity.fragment,
    version: identity.version,
    modelId: identity.modelId,
  });
}

function sourceColorContextFromMolstarProps(input: {
  pdbId?: string;
  uniprotId?: string;
  url?: string;
  structureData?: string | Uint8Array;
  structureIdentity?: StructureFetchIdentity;
}): Partial<Structure3dAttrs> {
  const { pdbId, uniprotId, url, structureData, structureIdentity } = input;
  const provider = structureIdentity?.provider;
  const source =
    provider === 'alphafold'
      ? 'alphafold'
      : provider === 'rcsb'
        ? 'pdb'
        : uniprotId
          ? 'alphafold'
          : pdbId
            ? 'pdb'
            : url
              ? 'url'
              : structureData
                ? 'file'
                : undefined;

  const sourceId = structureIdentity?.externalId ?? uniprotId ?? pdbId ?? url;
  const providerIdentityKey = structureIdentity?.externalId;
  const resolvedPdbId = structureIdentity?.pdbId ?? pdbId;
  const resolvedUniprotId = structureIdentity?.accession ?? uniprotId;

  return {
    ...(source ? { source } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(providerIdentityKey ? { providerIdentityKey } : {}),
    ...(resolvedPdbId ? { pdbId: resolvedPdbId } : {}),
    ...(resolvedUniprotId ? { uniprotId: resolvedUniprotId, accession: resolvedUniprotId } : {}),
    ...(url ? { url } : {}),
  };
}

function MolstarReactLoadingOverlay() {
  return (
    <div
      data-testid="molstar-react-loading-overlay"
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/80 text-xs text-fg-muted"
    >
      <div className="flex min-w-[220px] max-w-[min(320px,calc(100%-32px))] flex-col gap-2 rounded-md border border-border/70 bg-bg/95 px-3.5 py-3 shadow-lg">
        <div className="flex items-center gap-2.5">
          <span
            data-testid="molstar-react-loading-spinner"
            aria-hidden="true"
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-accent"
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-fg">
              Preparing 3D structure...
            </span>
            <span className="mt-0.5 block text-[11px] text-fg-muted">
              Fetching, parsing, and drawing the preview.
            </span>
          </span>
        </div>
        <span
          data-testid="molstar-react-loading-progress"
          aria-hidden="true"
          className="relative h-[3px] overflow-hidden rounded-full bg-bg-muted"
        >
          <span className="absolute inset-y-0 left-0 w-full animate-pulse rounded-full bg-accent/60" />
        </span>
      </div>
    </div>
  );
}

const MolstarViewerComponent: React.FC<MolstarViewerProps> = ({
  pdbId,
  uniprotId,
  url,
  structureData,
  structureDataFormat,
  coordinateModel,
  structureKeyOverride,
  structureIdentity,
  height = 400,
  fillContainer = false,
  view,
  molViewSpec,
  molViewSpecAssets,
  molViewSpecSnapshotIndex = 0,
  molViewSpecSelectionRevision = 0,
  scene,
  renderModel,
  sourceColorContext,
  cameraSnapshot,
  scrollZoom = false,
  deferWhileScrolling = false,
  viewerInstanceId,
  rendererHostId,
  onCameraChange,
  onError,
  onSlowLoad,
  onLoad,
  loadRequestKey,
  onPluginReady,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const molViewSpecRef = useRef(molViewSpec);
  molViewSpecRef.current = molViewSpec;
  const molViewSpecAssetsRef = useRef(molViewSpecAssets);
  molViewSpecAssetsRef.current = molViewSpecAssets;
  const molViewSpecSnapshotIndexRef = useRef(molViewSpecSnapshotIndex);
  molViewSpecSnapshotIndexRef.current = molViewSpecSnapshotIndex;
  const appliedStorySelectionRevisionRef = useRef(molViewSpecSelectionRevision);
  const effectiveSourceColorContext = useMemo(
    () => ({
      ...sourceColorContextFromMolstarProps({
        pdbId,
        uniprotId,
        url,
        structureData,
        structureIdentity,
      }),
      ...(sourceColorContext ?? {}),
    }),
    [pdbId, uniprotId, url, structureData, structureIdentity, sourceColorContext]
  );
  const effectiveView = useMemo<StructureViewState>(
    () =>
      view ??
      createDefaultStructureViewState({
        ...(cameraSnapshot ? { cameraSnapshot } : {}),
      }),
    [view, cameraSnapshot]
  );
  const isPreviewRender =
    effectiveView.renderIntent === 'preview' ||
    effectiveView.activeRecipeId === 'query-in-complex-preview';
  const structureIdentityKey = useMemo(
    () => stableStructureIdentityKey(structureIdentity),
    [structureIdentity]
  );
  const structureKey = useMemo(
    () =>
      structureKeyOverride ??
      getStructureKey(
        pdbId,
        uniprotId,
        url,
        structureData,
        structureIdentity,
        structureDataFormat,
        coordinateModel
      ),
    [
      structureKeyOverride,
      pdbId,
      uniprotId,
      url,
      structureData,
      structureIdentity,
      structureIdentityKey,
      structureDataFormat,
      coordinateModel?.blockIndex,
      coordinateModel?.modelIndex,
    ]
  );
  const generatedViewerInstanceIdRef = useRef(
    `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
  const effectiveViewerInstanceId = viewerInstanceId ?? generatedViewerInstanceIdRef.current;
  const previewCacheScope = isPreviewRender ? ':preview' : '';
  const viewerCacheKey = rendererHostId
    ? getPaneRendererHostCacheKey(rendererHostId, isPreviewRender ? 'preview' : 'loaded')
    : getViewerCacheKey(structureKey, `${effectiveViewerInstanceId}${previewCacheScope}`);
  const renderTransaction = useMemo(
    () =>
      compileStructureRenderTransaction({
        scene,
        view: effectiveView,
        renderModel,
        sourceColorContext: effectiveSourceColorContext,
      }),
    [scene, effectiveView, renderModel, effectiveSourceColorContext]
  );
  const molstarRenderPlan = useMemo(
    () =>
      compileMolstarRenderPlanFromTransaction(renderTransaction, {
        scene,
        uniprotId,
      }),
    [renderTransaction, scene, uniprotId]
  );
  const renderPlanApplyKeySet = useMemo(
    () => renderPlanApplyKeys(molstarRenderPlan),
    [molstarRenderPlan]
  );
  const renderPlanApplyKeySignature = useMemo(
    () => renderPlanApplySignature(renderPlanApplyKeySet),
    [
      renderPlanApplyKeySet.representation,
      renderPlanApplyKeySet.detailComponents,
      renderPlanApplyKeySet.surfaceOverlay,
    ]
  );
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [cacheRecoveryRevision, bumpCacheErrorRevision] = useState(0);

  const getVisibilityPlugin = useCallback(
    () => viewerCache.get(viewerCacheKey)?.plugin ?? null,
    [viewerCacheKey]
  );
  const isVisibilityCurrent = useCallback(() => viewerCache.has(viewerCacheKey), [viewerCacheKey]);
  useMolstarVisibilityPause({
    wrapperRef,
    viewerReady,
    getPlugin: getVisibilityPlugin,
    isCurrent: isVisibilityCurrent,
    pauseWhileScrolling: deferWhileScrolling,
  });

  const scrollIdleGate = useScrollIdleGate(wrapperRef, {
    idleMs: 150,
    noInteractionFallbackMs: 1500,
    waitUntilVisible: deferWhileScrolling,
  });
  const scrollIdle = deferWhileScrolling ? scrollIdleGate : true;

  const initialRenderPlanRef = useRef<MolstarRenderPlan>(molstarRenderPlan);
  initialRenderPlanRef.current = molstarRenderPlan;
  rememberLatestRevealPlanForViewerCacheKey(
    viewerCacheKey,
    initialRenderPlanRef.current,
    renderPlanApplyKeySet,
    renderTransaction
  );

  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const heightRef = useRef(height);
  heightRef.current = height;

  const prevViewerCacheKeyRef = useRef<string>(viewerCacheKey);

  const spinRef = useRef(molstarRenderPlan.controls.spin);
  spinRef.current = molstarRenderPlan.controls.spin;

  const isInitialLoadRef = useRef(true);

  const wasRestoredFromCacheRef = useRef(false);

  const cameraSnapshotRef = useRef(cameraSnapshot);
  cameraSnapshotRef.current = cameraSnapshot;
  const savedCameraIntentRef = useRef<{
    plugin: MolstarPlugin;
    structureKey: string;
    snapshot: string | undefined;
    pending: boolean;
  } | null>(null);

  const cameraPersistenceOwner = useMemo(
    () => ({
      cacheKey: viewerCacheKey,
      structureKey,
      save: undefined as typeof onCameraChange,
      spin: false,
    }),
    [viewerCacheKey, structureKey]
  );
  cameraPersistenceOwner.save = onCameraChange;
  cameraPersistenceOwner.spin = spinRef.current;

  const onPluginReadyRef = useRef(onPluginReady);
  onPluginReadyRef.current = onPluginReady;

  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  const loadRequestKeyRef = useRef(loadRequestKey);
  loadRequestKeyRef.current = loadRequestKey;

  const notifiedLoadKeyRef = useRef<string | null>(null);
  const notifyLoadReady = useCallback(() => {
    const cached = viewerCache.get(viewerCacheKey);
    if (!cached?.plugin || cached.isLoading || cached.error) return;
    if (!hasMolViewSpecController(cached.plugin)) return;
    if (rendererHostId && cached.loadedStructureKey !== structureKey) return;
    if (
      molViewSpecRef.current &&
      (!sameLoadedMolViewSpecScene(activeMolViewSpecScene(cached.plugin), molViewSpecRef.current) ||
        activeMolViewSpecSnapshotIndex(cached.plugin) !== molViewSpecSnapshotIndexRef.current)
    )
      return;

    if (molViewSpecRef.current) {
      const cameraIntent = savedCameraIntentRef.current;
      if (
        !cameraIntent ||
        cameraIntent.plugin !== cached.plugin ||
        cameraIntent.structureKey !== structureKey ||
        cameraIntent.snapshot !== cameraSnapshotRef.current ||
        cameraIntent.pending
      )
        return;
    }
    const notificationKey = JSON.stringify([structureKey, loadRequestKeyRef.current ?? null]);
    if (notifiedLoadKeyRef.current === notificationKey) return;
    notifiedLoadKeyRef.current = notificationKey;
    onLoadRef.current?.();
  }, [structureKey, viewerCacheKey, rendererHostId]);

  useLayoutEffect(() => {
    if (viewerReady) notifyLoadReady();
  }, [loadRequestKey, viewerReady, notifyLoadReady]);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSlowLoadRef = useRef(onSlowLoad);
  onSlowLoadRef.current = onSlowLoad;
  const notifyViewerError = useCallback(
    (phase: string, rawError: string) => {
      const displayError =
        formatMolstarViewerDisplayError(rawError) ?? MOLSTAR_VIEWER_GENERIC_RENDER_ERROR;
      recordMolstarViewerErrorForTest({
        viewerCacheKey,
        structureKey,
        phase,
        rawError,
        displayError,
      });
      setViewerError(toUserMessage(displayError, 'structure.failed'));
      onErrorRef.current?.(displayError);
    },
    [structureKey, viewerCacheKey]
  );

  const surfaceOverlayRefsRef = useRef<string[]>([]);
  const lastAppliedRenderPlanKeysRef = useRef<MolstarRenderPlanApplyKeys | null>(null);

  const representationApplyGenerationRef = useRef(0);
  const representationApplyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const runPaneSceneOperation = useCallback(
    async (
      cached: CachedViewer,
      operation: (isCurrent: () => boolean) => Promise<void>,
      isCurrent: () => boolean
    ) => {
      if (!rendererHostId || !cached.rendererHostActivation) {
        await operation(isCurrent);
        return isCurrent();
      }
      const result = await enqueueRendererHostSceneOperation(
        cached.rendererHostActivation,
        structureKey,
        operation,
        isCurrent
      );
      return result.status === 'applied';
    },
    [rendererHostId, structureKey]
  );

  const loadingPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const e2eStubEnabled = isMolstarE2eStubEnabled();
  const e2eStubByteFetchEnabled = isMolstarE2eStubByteFetchEnabled();
  const [e2eStubLoadStatus, setE2eStubLoadStatus] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [e2eStubError, setE2eStubError] = useState<string | null>(null);

  useEffect(() => {
    if (!e2eStubEnabled) return;
    let cancelled = false;

    async function loadStubStructureBytes(): Promise<void> {
      setE2eStubError(null);
      if (!e2eStubByteFetchEnabled) {
        setE2eStubLoadStatus('loaded');
        onLoadRef.current?.();
        return;
      }

      setE2eStubLoadStatus('loading');
      try {
        // eslint-disable-next-line no-empty
        if (structureData) {
        } else if (pdbId) {
          await fetchStructureData(structureIdentity ?? pdbId, 'rcsb');
        } else if (uniprotId) {
          await fetchStructureData(structureIdentity ?? uniprotId, 'alphafold');
        } else if (url) {
          await fetchStructureFromUrl(url);
        }
        if (cancelled) return;
        setE2eStubLoadStatus('loaded');
        onLoadRef.current?.();
      } catch (err) {
        if (cancelled) return;
        const message = (err as Error).message || 'Failed to fetch structure bytes';
        setE2eStubError(toUserMessage(message, 'structure.failed'));
        setE2eStubLoadStatus('idle');
        notifyViewerError('e2e-stub-load', message);
      }
    }

    void loadStubStructureBytes();
    return () => {
      cancelled = true;
    };
  }, [
    e2eStubEnabled,
    e2eStubByteFetchEnabled,
    structureKey,
    pdbId,
    uniprotId,
    url,
    structureData,
    structureIdentityKey,
    notifyViewerError,
  ]);

  useEffect(() => {
    mountedRef.current = true;

    if (e2eStubEnabled) return;
    if (!wrapperRef.current || !structureKey || !viewerCacheKey) return;
    let existingCached = viewerCache.get(viewerCacheKey);
    if (rendererHostId && existingCached && hasPreviousPaneError(existingCached, structureKey)) {
      if (existingCached.plugin && existingCached.rendererHostActivation) {
        existingCached.error = null;
        existingCached.loadedStructureKey = null;
        existingCached.rendererHostActivation.loadedStructureKey = null;
      } else {
        deleteCachedViewer(viewerCacheKey, 'pane-request-changed-after-error');
        recordPendingCreationDelete(viewerCacheKey, 'pane-request-changed-after-error');
        existingCached = undefined;
      }
    }
    const isJoiningExistingWork = !!existingCached || pendingCreations.has(viewerCacheKey);
    if (!scrollIdle && !isJoiningExistingWork) return;
    const loadGeneration = ++loadGenerationRef.current;
    const isCurrentLoad = () => mountedRef.current && loadGenerationRef.current === loadGeneration;
    const wrapper = wrapperRef.current;
    const renderPlanAbortController = new AbortController();

    const handleCachedError = (error: string) => {
      const staleCachedViewer = viewerCache.get(viewerCacheKey);
      if (!rendererHostId) {
        detachCachedViewerContainer(staleCachedViewer, wrapperRef.current);
        deleteCachedViewer(viewerCacheKey, `main-effect-cached-error:${error}`);
      }
      recordPendingCreationDelete(viewerCacheKey, `main-effect-cached-error:${error}`);
      if (error === CANCELLED_VIEWER_LOAD_ERROR) {
        if (isCurrentLoad()) {
          setViewerReady(false);
          bumpCacheErrorRevision((value) => value + 1);
        }
        startCacheCleanup();
        return;
      }
      if (isCurrentLoad()) {
        setViewerReady(false);
        notifyViewerError('main-effect-cached-error', error);
      }
      startCacheCleanup();
    };

    const previousViewerCacheKey = prevViewerCacheKeyRef.current;
    const keepExistingViewerUntilReveal = shouldKeepExistingViewerUntilReveal(
      previousViewerCacheKey,
      viewerCacheKey
    );
    const previewPlaceholderEntry =
      !keepExistingViewerUntilReveal && effectiveViewerInstanceId
        ? previewCompanionCacheEntry(viewerCacheKey, effectiveViewerInstanceId)
        : undefined;
    const previewPlaceholder = previewPlaceholderEntry?.[1];
    const keepPreviewPlaceholderUntilReveal =
      !keepExistingViewerUntilReveal &&
      !!previewPlaceholder?.plugin &&
      !previewPlaceholder.isLoading &&
      !previewPlaceholder.error;
    const keepVisibleViewerUntilReveal =
      keepExistingViewerUntilReveal || keepPreviewPlaceholderUntilReveal;

    if (keepPreviewPlaceholderUntilReveal && previewPlaceholder) {
      attachViewerContainer(wrapper, previewPlaceholder.container, {
        keepExistingUntilReveal: false,
      });
      setCachedViewerCanvasVisibility(previewPlaceholder.container, 'visible');
      scheduleMolstarFrameKicks(previewPlaceholder.plugin);
      const handoffPoster =
        getPreviewPosterForLoadedViewer(viewerCacheKey) ??
        captureViewerPosterDataUrl(previewPlaceholder.container);
      attachHandoffPoster(wrapper, handoffPoster);
      if (previewPlaceholderEntry?.[0]) {
        schedulePreviewPosterCapture(previewPlaceholderEntry[0], previewPlaceholder);
      }
    }

    if (
      previousViewerCacheKey !== viewerCacheKey ||
      existingCached?.logicalViewInstanceId !== effectiveViewerInstanceId
    ) {
      if (!keepVisibleViewerUntilReveal) clearViewerWrapper(wrapper);
      prevViewerCacheKeyRef.current = viewerCacheKey;
      notifiedLoadKeyRef.current = null;
      isInitialLoadRef.current = true;
      surfaceOverlayRefsRef.current = [];
      lastAppliedRenderPlanKeysRef.current = null;
      representationApplyGenerationRef.current += 1;
      wasRestoredFromCacheRef.current = false;
      setViewerReady(false);
      setViewerError(null);
    }

    const revealCachedViewer = async (currentCached: CachedViewer): Promise<void> => {
      const requiresPaneActivation =
        !!rendererHostId && currentCached.loadedStructureKey !== structureKey;
      if (
        !currentCached.plugin ||
        currentCached.error ||
        (currentCached.isLoading &&
          (!requiresPaneActivation || currentCached.isInitializing === true))
      ) {
        return;
      }

      let overlayRefs = requiresPaneActivation ? [] : surfaceOverlayRefsRef.current;
      const revealPlan = latestRevealPlanForViewerCacheKey(
        viewerCacheKey,
        initialRenderPlanRef.current
      );
      const revealPlanKeys = latestRevealPlanKeysForViewerCacheKey(
        viewerCacheKey,
        renderPlanApplyKeySet
      );
      const savedScene = molViewSpecRef.current;
      const matchesCurrentAppearance = () =>
        molViewSpecRef.current === savedScene &&
        (!!savedScene || isLatestRevealPlanKeysForViewerCacheKey(viewerCacheKey, revealPlanKeys));
      const isCurrentRevealPlan = () => isCurrentLoad() && matchesCurrentAppearance();
      const revealUpdatedAppearance = () => {
        if (isCurrentLoad() && !matchesCurrentAppearance()) void revealCachedViewer(currentCached);
      };
      const applyPlanBeforeReveal = async (
        trackedOverlayRefs: string[],
        isCurrent = isCurrentRevealPlan
      ) => {
        if (!isCurrent() || !currentCached.plugin) return;
        const document = molViewSpecRef.current;
        if (document) {
          bindMolViewSpecPinnedAssets(currentCached.plugin, molViewSpecAssetsRef.current);
          if (
            currentCached.logicalViewInstanceId !== effectiveViewerInstanceId ||
            !sameLoadedMolViewSpecScene(activeMolViewSpecScene(currentCached.plugin), document)
          ) {
            await loadMolViewSpecScene(currentCached.plugin, document, isCurrent);
          }
          if (
            molViewSpecSnapshotIndexRef.current !==
            activeMolViewSpecSnapshotIndex(currentCached.plugin)
          )
            await selectMolViewSpecSnapshot(
              currentCached.plugin,
              molViewSpecSnapshotIndexRef.current,
              isCurrent
            );
          if (!isCurrent()) return;
          currentCached.logicalViewInstanceId = effectiveViewerInstanceId;
          overlayRefs = [];
          return;
        }
        clearMolViewSpecScene(currentCached.plugin);
        overlayRefs = await applyMolstarRenderPlanBeforeReveal(currentCached.plugin, revealPlan, {
          isCurrent,
          signal: renderPlanAbortController.signal,
          trackedOverlayRefs,
          forceRepresentationApply: true,
        });
        if (!isCurrent()) return;
        assertStructureRenderPlanSatisfiedForViewer({
          viewerCacheKey,
          transaction: renderTransaction,
          molstarPlan: revealPlan,
          phase: 'before-reveal',
          detailChainTargets: revealPlan.detailChainTargets,
        });
      };

      try {
        if (requiresPaneActivation) {
          wasRestoredFromCacheRef.current = false;
          surfaceOverlayRefsRef.current = [];
          lastAppliedRenderPlanKeysRef.current = null;
          setViewerReady(false);
          setViewerError(null);
          if (wrapperRef.current && !hasHandoffPoster(wrapperRef.current)) {
            attachHandoffPoster(
              wrapperRef.current,
              captureViewerPosterDataUrl(currentCached.container)
            );
          }
          const activation = await activateViewerStructure(currentCached, {
            structureKey,
            pdbId,
            uniprotId,
            url,
            structureData,
            structureDataFormat,
            coordinateModel,
            structureIdentity,
            coordinatesOnly: !!molViewSpecRef.current,
            height: heightRef.current,
            cameraSnapshot: cameraSnapshotRef.current,
            onBeforeReveal: () => applyPlanBeforeReveal([]),
            onSlowLoad: () => {
              if (isCurrentLoad()) onSlowLoadRef.current?.();
            },
          });
          if (activation.status === 'stale' || !isCurrentRevealPlan()) {
            revealUpdatedAppearance();
            return;
          }
          if (
            !(await runPaneSceneOperation(
              currentCached,
              (token) => applyPlanBeforeReveal([], token),
              isCurrentRevealPlan
            ))
          ) {
            revealUpdatedAppearance();
            return;
          }
        } else {
          wasRestoredFromCacheRef.current = true;
          if (
            !(await runPaneSceneOperation(
              currentCached,
              (token) => applyPlanBeforeReveal(surfaceOverlayRefsRef.current, token),
              isCurrentRevealPlan
            ))
          ) {
            revealUpdatedAppearance();
            return;
          }
        }
      } catch (err) {
        if (isMolstarRenderPlanApplyCancelledError(err)) {
          revealUpdatedAppearance();
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Failed to activate cached Mol* structure';
        handleCachedError(message);
        return;
      }

      if (
        !isCurrentRevealPlan() ||
        (rendererHostId && currentCached.loadedStructureKey !== structureKey)
      ) {
        revealUpdatedAppearance();
        return;
      }
      if (wrapperRef.current) {
        const preserveHandoffPoster = !isPreviewRender && hasHandoffPoster(wrapperRef.current);
        revealViewerContainer(wrapperRef.current, currentCached.container, {
          preserveHandoffPoster,
        });
        if (preserveHandoffPoster) {
          releaseHandoffPosterAfterLoadedPaint(wrapperRef.current, currentCached.container);
        }
      }
      setCachedViewerCanvasVisibility(currentCached.container, 'visible');
      if (requiresPaneActivation) {
        restartMolstarPaneAnimationLoop(currentCached.plugin);
      }
      surfaceOverlayRefsRef.current = overlayRefs;
      lastAppliedRenderPlanKeysRef.current = revealPlanKeys;
      currentCached.logicalViewInstanceId = effectiveViewerInstanceId;
      setViewerError(null);
      setViewerReady(true);
      notifyPluginReady(
        structureKey,
        viewerCacheKey,
        wrapperRef.current,
        currentCached.plugin,
        onPluginReadyRef.current
      );
      scheduleMolstarFrameKicks(currentCached.plugin, {
        isCurrent: () => viewerCache.get(viewerCacheKey) === currentCached,
      });
      if (isPreviewRender) schedulePreviewPosterCapture(viewerCacheKey, currentCached);
    };

    const cached = viewerCache.get(viewerCacheKey);

    if (cached) {
      cached.lastUsed = Date.now();
      if (rendererHostId && cached.rendererHostActivation) {
        requestRendererHostStructure(cached.rendererHostActivation, structureKey);
      }

      const needsReattach =
        !cached.container.isConnected || cached.container.parentElement !== wrapper;

      if (needsReattach) {
        attachViewerContainer(wrapper, cached.container, {
          keepExistingUntilReveal: keepVisibleViewerUntilReveal,
        });
      }

      if (!cached.isLoading && cached.error) {
        handleCachedError(cached.error);
      } else if (!cached.isLoading && !cached.error && isCurrentLoad()) {
        void revealCachedViewer(cached);
      } else if (cached.isLoading) {
        if (loadingPollIntervalRef.current) {
          clearInterval(loadingPollIntervalRef.current);
        }
        loadingPollIntervalRef.current = setInterval(() => {
          const currentCached = viewerCache.get(viewerCacheKey);
          if (!currentCached) {
            clearInterval(loadingPollIntervalRef.current!);
            loadingPollIntervalRef.current = null;
            return;
          }
          if (!currentCached.isLoading) {
            clearInterval(loadingPollIntervalRef.current!);
            loadingPollIntervalRef.current = null;
            if (currentCached.error) {
              handleCachedError(currentCached.error);
            } else if (isCurrentLoad()) {
              void revealCachedViewer(currentCached);
            }
          }
        }, 100);
      }
      startCacheCleanup();
    } else if (!pendingCreations.has(viewerCacheKey)) {
      recordPendingCreationAdd(viewerCacheKey, 'main-effect-create-viewer');
      wasRestoredFromCacheRef.current = false;
      if (!keepVisibleViewerUntilReveal) clearViewerWrapper(wrapper);

      createViewerContainer({
        structureKey,
        pdbId,
        uniprotId,
        url,
        structureData,
        structureDataFormat,
        coordinateModel,
        structureIdentity,
        coordinatesOnly: !!molViewSpecRef.current,
        height: heightRef.current,
        onComplete: () => {
          recordPendingCreationDelete(viewerCacheKey, 'createViewerContainer:onComplete');
          if (isCurrentLoad()) {
            const cached = viewerCache.get(viewerCacheKey);
            if (cached?.plugin && !cached.isLoading && !cached.error) {
              if (wrapperRef.current) {
                const preserveHandoffPoster =
                  !isPreviewRender && hasHandoffPoster(wrapperRef.current);
                revealViewerContainer(wrapperRef.current, cached.container, {
                  preserveHandoffPoster,
                });
                if (preserveHandoffPoster) {
                  releaseHandoffPosterAfterLoadedPaint(wrapperRef.current, cached.container);
                }
              }
              setViewerError(null);
              setViewerReady(true);
              setPluginSpin(cached.plugin, spinRef.current);
              notifyPluginReady(
                structureKey,
                viewerCacheKey,
                wrapperRef.current,
                cached.plugin,
                onPluginReadyRef.current
              );
              scheduleMolstarFrameKicks(cached.plugin, {
                isCurrent: () => viewerCache.get(viewerCacheKey) === cached,
              });
              if (isPreviewRender) schedulePreviewPosterCapture(viewerCacheKey, cached);
            }
          }
        },
        onError: (error) => {
          if (isCurrentLoad()) {
            notifyViewerError('create-viewer-error', error);
          }
        },
        onBeforeReveal: async (plugin) => {
          const paneRequestStillTargetsConstruction = () =>
            !rendererHostId ||
            viewerCache.get(viewerCacheKey)?.rendererHostActivation?.requestedStructureKey ===
              structureKey;
          if (!paneRequestStillTargetsConstruction()) return;
          if (molViewSpecRef.current) {
            bindMolViewSpecPinnedAssets(plugin, molViewSpecAssetsRef.current);
            await loadMolViewSpecScene(
              plugin,
              molViewSpecRef.current,
              paneRequestStillTargetsConstruction
            );
            if (molViewSpecSnapshotIndexRef.current !== activeMolViewSpecSnapshotIndex(plugin))
              await selectMolViewSpecSnapshot(
                plugin,
                molViewSpecSnapshotIndexRef.current,
                paneRequestStillTargetsConstruction
              );
            surfaceOverlayRefsRef.current = [];
            lastAppliedRenderPlanKeysRef.current = null;
            return;
          }
          let forceRepresentationApply = false;
          while (paneRequestStillTargetsConstruction()) {
            const initialPlan = latestRevealPlanForViewerCacheKey(
              viewerCacheKey,
              initialRenderPlanRef.current
            );
            const initialPlanKeys = latestRevealPlanKeysForViewerCacheKey(
              viewerCacheKey,
              renderPlanApplyKeySet
            );
            const initialTransaction = latestRevealTransactionForViewerCacheKey(
              viewerCacheKey,
              renderTransaction
            );
            const isCurrentInitialPlan = () =>
              paneRequestStillTargetsConstruction() &&
              isLatestRevealPlanKeysForViewerCacheKey(viewerCacheKey, initialPlanKeys);
            let overlayRefs: string[];
            try {
              overlayRefs = await applyMolstarRenderPlanBeforeReveal(plugin, initialPlan, {
                isCurrent: isCurrentInitialPlan,
                trackedOverlayRefs: surfaceOverlayRefsRef.current,
                forceRepresentationApply,
              });
            } catch (error) {
              if (
                isMolstarRenderPlanApplyCancelledError(error) &&
                paneRequestStillTargetsConstruction()
              ) {
                forceRepresentationApply = true;
                continue;
              }
              throw error;
            }
            if (!paneRequestStillTargetsConstruction()) return;
            if (!isCurrentInitialPlan()) {
              forceRepresentationApply = true;
              continue;
            }
            surfaceOverlayRefsRef.current = overlayRefs;
            lastAppliedRenderPlanKeysRef.current = initialPlanKeys;
            assertStructureRenderPlanSatisfiedForViewer({
              viewerCacheKey,
              transaction: initialTransaction,
              molstarPlan: initialPlan,
              phase: 'before-reveal',
              detailChainTargets: initialPlan.detailChainTargets,
            });
            return;
          }
        },
        onSlowLoad: () => {
          if (isCurrentLoad()) onSlowLoadRef.current?.();
        },
      }).then((newCached) => {
        newCached.logicalViewInstanceId ??= effectiveViewerInstanceId;
        recordCacheInsert(viewerCacheKey, newCached);
        if (isCurrentLoad() && wrapperRef.current) {
          attachViewerContainer(wrapperRef.current, newCached.container, {
            keepExistingUntilReveal: keepVisibleViewerUntilReveal,
          });
        }
        startCacheCleanup();
      });
    } else {
      if (loadingPollIntervalRef.current) {
        clearInterval(loadingPollIntervalRef.current);
      }
      loadingPollIntervalRef.current = setInterval(() => {
        const currentCached = viewerCache.get(viewerCacheKey);
        if (!currentCached) {
          if (!pendingCreations.has(viewerCacheKey)) {
            clearInterval(loadingPollIntervalRef.current!);
            loadingPollIntervalRef.current = null;
          }
          return;
        }
        if (currentCached.isLoading) {
          if (isCurrentLoad()) {
            attachLoadingViewerContainer(wrapperRef.current, currentCached, {
              keepExistingUntilReveal: keepVisibleViewerUntilReveal,
            });
          }
          return;
        }
        if (!currentCached.isLoading) {
          clearInterval(loadingPollIntervalRef.current!);
          loadingPollIntervalRef.current = null;
          if (currentCached.error) {
            handleCachedError(currentCached.error);
          } else if (isCurrentLoad()) {
            if (wrapperRef.current) {
              attachViewerContainer(wrapperRef.current, currentCached.container, {
                keepExistingUntilReveal: keepVisibleViewerUntilReveal,
              });
            }
            if (rendererHostId && currentCached.rendererHostActivation) {
              requestRendererHostStructure(currentCached.rendererHostActivation, structureKey);
            }
            void revealCachedViewer(currentCached);
          }
        }
      }, 100);
    }

    return () => {
      renderPlanAbortController.abort();
      unregisterActiveWrapper(structureKey, wrapper, viewerCacheKey);
      mountedRef.current = false;
      if (loadingPollIntervalRef.current) {
        clearInterval(loadingPollIntervalRef.current);
        loadingPollIntervalRef.current = null;
      }
    };
  }, [
    structureKey,
    viewerCacheKey,
    pdbId,
    uniprotId,
    url,
    structureData,
    structureDataFormat,
    coordinateModel?.blockIndex,
    coordinateModel?.modelIndex,
    structureIdentityKey,
    rendererHostId,
    effectiveViewerInstanceId,
    e2eStubEnabled,
    cacheRecoveryRevision,
    notifyViewerError,
    scrollIdle,
    runPaneSceneOperation,
  ]);

  useLayoutEffect(() => {
    if (!wrapperRef.current || !viewerReady) return;

    const cached = viewerCache.get(viewerCacheKey);
    if (!cached?.plugin?.canvas3d) return;

    const resize = () => {
      if (viewerCache.get(viewerCacheKey) === cached) resizeMolstarViewer(cached.plugin!);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(wrapperRef.current);

    return () => {
      observer.disconnect();
    };
  }, [viewerCacheKey, viewerReady, height, fillContainer]);

  useEffect(() => {
    if (!viewerReady) return;
    const canvas = viewerCache.get(viewerCacheKey)?.plugin?.canvas3d?.webgl?.gl?.canvas;
    if (canvas instanceof HTMLCanvasElement) return bindMolstarCanvasCursor(canvas);
  }, [viewerCacheKey, viewerReady]);

  useEffect(() => {
    if (!viewerReady || !viewerCacheKey) return;

    const cached = viewerCache.get(viewerCacheKey);
    if (!cached) return;

    const canvas = cached.container.querySelector('canvas') as HTMLCanvasElement | null;

    const handleContextLost = () => {
      console.error('[MolstarViewer] WebGL context lost for:', structureKey);
    };
    const handleContextRestored = () => {
      console.warn('[MolstarViewer] WebGL context restored for:', structureKey);
      scheduleMolstarFrameKicks(cached.plugin, {
        isCurrent: () => viewerCache.get(viewerCacheKey) === cached,
      });
    };

    if (canvas) {
      canvas.addEventListener('webglcontextlost', handleContextLost);
      canvas.addEventListener('webglcontextrestored', handleContextRestored);
    }

    let wasWrapperConnected = wrapperRef.current?.isConnected ?? false;
    const initialCached = cached;

    const healthInterval = setInterval(() => {
      const currentCached = viewerCache.get(viewerCacheKey);
      if (!currentCached || currentCached !== initialCached) {
        clearInterval(healthInterval);
        return;
      }

      const wrapper = wrapperRef.current;
      const wrapperInDoc = wrapper?.isConnected ?? false;

      if (wrapperInDoc && !wasWrapperConnected) {
        scheduleMolstarFrameKicks(currentCached.plugin, {
          isCurrent: () => viewerCache.get(viewerCacheKey) === currentCached,
        });
      }
      wasWrapperConnected = wrapperInDoc;
    }, 2000);

    return () => {
      clearInterval(healthInterval);
      if (canvas) {
        canvas.removeEventListener('webglcontextlost', handleContextLost);
        canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      }
    };
  }, [structureKey, viewerCacheKey, viewerReady]);

  useLayoutEffect(() => {
    if (!viewerReady) return;

    const cached = viewerCache.get(viewerCacheKey);
    if (!cached?.plugin || cached.isLoading || cached.error) return;
    if (molViewSpec || activeMolViewSpecScene(cached.plugin)) {
      return;
    }

    const plugin = cached.plugin;
    const generation = representationApplyGenerationRef.current + 1;
    representationApplyGenerationRef.current = generation;
    const renderPlanAbortController = new AbortController();
    const loadGeneration = loadGenerationRef.current;
    const isViewerCurrent = () =>
      mountedRef.current &&
      loadGenerationRef.current === loadGeneration &&
      viewerCache.get(viewerCacheKey)?.plugin === plugin &&
      (!rendererHostId || cached.loadedStructureKey === structureKey) &&
      !activeMolViewSpecScene(plugin);
    const isCurrent = () =>
      isViewerCurrent() &&
      representationApplyGenerationRef.current === generation &&
      isLatestRevealPlanKeysForViewerCacheKey(viewerCacheKey, renderPlanApplyKeySet);
    const isSurfaceCurrent = () =>
      isViewerCurrent() &&
      latestRevealPlanKeysByViewerCacheKey.get(viewerCacheKey)?.surfaceOverlay ===
        renderPlanApplyKeySet.surfaceOverlay;
    let applyStarted = false;
    let applyCompleted = false;

    representationApplyQueueRef.current = representationApplyQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) return;
        applyStarted = true;
        const currentRenderPlan = initialRenderPlanRef.current;
        const currentApplyKeys = renderPlanApplyKeys(currentRenderPlan);

        const previousApplyKeys = lastAppliedRenderPlanKeysRef.current;
        let applyVisualLayer =
          previousApplyKeys !== null &&
          didRenderPlanApplyKeyChange(previousApplyKeys, currentApplyKeys, 'representation');
        let applyDetailComponentsLayer =
          previousApplyKeys !== null &&
          didRenderPlanApplyKeyChange(previousApplyKeys, currentApplyKeys, 'detailComponents');
        let applySurfaceOverlayLayer =
          previousApplyKeys !== null &&
          didRenderPlanApplyKeyChange(previousApplyKeys, currentApplyKeys, 'surfaceOverlay');
        if (isInitialLoadRef.current) {
          isInitialLoadRef.current = false;
          const forceInitialReconcile = !shouldSkipInitialPostReadyRenderPlanApply({
            wasRestoredFromCache: wasRestoredFromCacheRef.current,
            sceneKind: scene?.sceneKind,
            isPreviewRender,
            hadBeforeRevealReconcile: previousApplyKeys !== null,
            renderPlanChangedSinceBeforeReveal:
              applyVisualLayer || applyDetailComponentsLayer || applySurfaceOverlayLayer,
          });
          applyVisualLayer = forceInitialReconcile;
          applyDetailComponentsLayer = forceInitialReconcile;
          applySurfaceOverlayLayer = forceInitialReconcile;
        } else if (previousApplyKeys === null) {
          applyVisualLayer = true;
          applyDetailComponentsLayer = true;
          applySurfaceOverlayLayer = true;
        }

        const overlayRefs = await applyMolstarRenderPlanAfterReady(plugin, currentRenderPlan, {
          isCurrent,
          isSurfaceCurrent,
          signal: renderPlanAbortController.signal,
          trackedOverlayRefs: surfaceOverlayRefsRef.current,
          applyVisuals: applyVisualLayer,
          applyDetailComponents: applyDetailComponentsLayer,
          applySurfaceOverlay: applySurfaceOverlayLayer,
        });
        const interactionReadiness = await waitForPluginInteractionReady(plugin, { isCurrent });
        if (!interactionReadiness) return;
        const currentPlugin = cached.plugin;
        if (isCurrent() && currentPlugin) {
          setPluginSpin(currentPlugin, spinRef.current);
          assertStructureRenderPlanSatisfiedForViewer({
            viewerCacheKey,
            transaction: renderTransaction,
            molstarPlan: currentRenderPlan,
            phase: 'after-ready',
            detailChainTargets: currentRenderPlan.detailChainTargets,
          });
          surfaceOverlayRefsRef.current = overlayRefs;
          lastAppliedRenderPlanKeysRef.current = currentApplyKeys;
          applyCompleted = true;
          notifyLoadReady();
        }
      })
      .catch((err) => {
        const shouldReportError = isCurrent();
        if (applyStarted && !applyCompleted) {
          lastAppliedRenderPlanKeysRef.current = null;
        }
        if (isMolstarRenderPlanApplyCancelledError(err) || !shouldReportError) return;
        const message =
          err instanceof Error ? err.message : 'Failed to reconcile Mol* viewer style';
        console.error('[MolstarViewer] Render reconciliation failed:', err);
        notifyViewerError('after-ready-reconcile', message);
      });
    void representationApplyQueueRef.current;

    return () => {
      renderPlanAbortController.abort();
      representationApplyGenerationRef.current += 1;
      if (applyStarted && !applyCompleted) {
        lastAppliedRenderPlanKeysRef.current = null;
      }
    };
  }, [
    viewerCacheKey,
    viewerReady,
    renderPlanApplyKeySignature,
    molViewSpec,
    notifyViewerError,
    notifyLoadReady,
  ]);

  useLayoutEffect(() => {
    const cached = viewerCache.get(viewerCacheKey);
    if (!viewerReady || !cached?.plugin || cached.isLoading || cached.error) return;
    if (rendererHostId && cached.loadedStructureKey !== structureKey) return;
    const plugin = cached.plugin;
    const unregister = registerMolViewSpecController(
      plugin,
      async (document, onRendered, options) => {
        validateMolViewSpecScene(document, activeMolViewSpecResourceNames(plugin));
        representationApplyGenerationRef.current += 1;
        const isCurrent = () =>
          (options?.isCurrent?.() ?? true) &&
          mountedRef.current &&
          viewerCache.get(viewerCacheKey)?.plugin === plugin &&
          (!rendererHostId || cached.loadedStructureKey === structureKey);
        const operation = representationApplyQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            if (!isCurrent())
              throw new MolViewSpecSceneError(
                'VIEW_CHANGED',
                'The structure view changed before scene control.'
              );
            const applied = await runPaneSceneOperation(
              cached,
              async (token) => {
                options?.beforeApply?.();
                await loadMolViewSpecScene(plugin, document, token, {
                  ...options,
                  rejectDuplicateGeometry: true,
                });
              },
              isCurrent
            );
            if (!applied)
              throw new MolViewSpecSceneError(
                'VIEW_CHANGED',
                'The structure view changed during scene control.'
              );
            if (options?.appearanceOnly) {
              savedCameraIntentRef.current = {
                plugin,
                structureKey,
                snapshot: cameraSnapshotRef.current,
                pending: false,
              };
            }
            onRendered?.();
            surfaceOverlayRefsRef.current = [];
            lastAppliedRenderPlanKeysRef.current = null;
          });
        representationApplyQueueRef.current = operation.catch(() => undefined);
        await operation;
      }
    );
    notifyLoadReady();
    return unregister;
  }, [
    viewerReady,
    viewerCacheKey,
    structureKey,
    rendererHostId,
    runPaneSceneOperation,
    notifyLoadReady,
  ]);

  const failedSceneIntentRef = useRef({
    rendererHostId,
    viewerCacheKey,
    structureKey,
    molViewSpec,
    molViewSpecSnapshotIndex,
  });
  useLayoutEffect(() => {
    const previous = failedSceneIntentRef.current;
    failedSceneIntentRef.current = {
      rendererHostId,
      viewerCacheKey,
      structureKey,
      molViewSpec,
      molViewSpecSnapshotIndex,
    };
    const changed =
      previous.rendererHostId !== rendererHostId ||
      previous.viewerCacheKey !== viewerCacheKey ||
      previous.structureKey !== structureKey ||
      previous.molViewSpec !== molViewSpec ||
      previous.molViewSpecSnapshotIndex !== molViewSpecSnapshotIndex;
    if (!changed) return;
    const cached = viewerCache.get(viewerCacheKey);
    if (!rendererHostId || !cached?.plugin || cached.isLoading || !cached.error) return;
    cached.error = null;
    cached.loadedStructureKey = null;
    setViewerError(null);
    setViewerReady(false);
    bumpCacheErrorRevision((value) => value + 1);
  }, [rendererHostId, viewerCacheKey, structureKey, molViewSpec, molViewSpecSnapshotIndex]);

  useLayoutEffect(() => {
    const cached = viewerCache.get(viewerCacheKey);
    if (!molViewSpec || !viewerReady || !cached?.plugin || cached.isLoading || cached.error) return;
    const plugin = cached.plugin;
    let cameraIntent = savedCameraIntentRef.current;
    if (
      !cameraIntent ||
      cameraIntent.plugin !== plugin ||
      cameraIntent.structureKey !== structureKey ||
      cameraIntent.snapshot !== cameraSnapshot
    ) {
      cameraIntent = { plugin, structureKey, snapshot: cameraSnapshot, pending: !!cameraSnapshot };
      savedCameraIntentRef.current = cameraIntent;
    }
    const explicitSelection =
      appliedStorySelectionRevisionRef.current !== molViewSpecSelectionRevision;
    const cameraMatches = () => {
      if (!cameraSnapshot) return true;
      const desired = JSON.parse(cameraSnapshot) as Record<string, unknown>;
      const actual = plugin.canvas3d?.camera.getSnapshot() as unknown as Record<string, unknown>;
      return Object.entries(desired).every(
        ([key, value]) => JSON.stringify(actual?.[key]) === JSON.stringify(value)
      );
    };
    try {
      if (
        sameLoadedMolViewSpecScene(activeMolViewSpecScene(plugin), molViewSpec) &&
        activeMolViewSpecSnapshotIndex(plugin) === molViewSpecSnapshotIndex &&
        (!cameraIntent.pending || cameraMatches()) &&
        !explicitSelection
      ) {
        cameraIntent.pending = false;
        notifyLoadReady();
        return;
      }
    } catch (error) {
      notifyViewerError('saved-view-camera', String(error));
      return;
    }
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      mountedRef.current &&
      savedCameraIntentRef.current === cameraIntent &&
      viewerCache.get(viewerCacheKey)?.plugin === plugin &&
      (!rendererHostId || cached.loadedStructureKey === structureKey);
    const operation = representationApplyQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) return;
        await runPaneSceneOperation(
          cached,
          async (token) => {
            bindMolViewSpecPinnedAssets(plugin, molViewSpecAssetsRef.current);
            if (!sameLoadedMolViewSpecScene(activeMolViewSpecScene(plugin), molViewSpec))
              await loadMolViewSpecScene(plugin, molViewSpec, token);
            if (!token()) return;
            if (
              explicitSelection ||
              activeMolViewSpecSnapshotIndex(plugin) !== molViewSpecSnapshotIndex
            )
              await selectMolViewSpecSnapshot(plugin, molViewSpecSnapshotIndex, token);
            if (!token()) return;
            if ((cameraIntent.pending || explicitSelection) && cameraSnapshot && !cameraMatches())
              plugin.canvas3d?.camera.setState(JSON.parse(cameraSnapshot), 0);
            cameraIntent.pending = false;
            appliedStorySelectionRevisionRef.current = molViewSpecSelectionRevision;
            scheduleMolstarFrameKicks(plugin, { isCurrent });
          },
          isCurrent
        );
        if (isCurrent()) notifyLoadReady();
      });
    representationApplyQueueRef.current = operation.catch((error) => {
      if (isCurrent()) notifyViewerError('saved-view-restore', String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [
    molViewSpec,
    molViewSpecSnapshotIndex,
    molViewSpecSelectionRevision,
    runPaneSceneOperation,
    cameraSnapshot,
    viewerReady,
    viewerCacheKey,
    structureKey,
    rendererHostId,
    notifyViewerError,
    notifyLoadReady,
  ]);

  useLayoutEffect(() => {
    const cached = viewerCache.get(viewerCacheKey);
    if (!cached?.plugin || cached.isLoading || cached.error) return;
    if (molViewSpec || activeMolViewSpecScene(cached.plugin)) return;

    setPluginSpin(cached.plugin, molstarRenderPlan.controls.spin);
    scheduleMolstarFrameKicks(cached.plugin, {
      isCurrent: () => viewerCache.get(viewerCacheKey) === cached,
    });
  }, [molstarRenderPlan.controls.spin, viewerCacheKey]);

  useLayoutEffect(() => {
    if (!viewerReady) return;
    const cached = viewerCache.get(viewerCacheKey);
    if (!cached?.plugin || cached.isLoading || cached.error) return;

    const plugin = cached.plugin;
    const camera = plugin.canvas3d?.camera;
    if (!camera) return;

    if (!wasRestoredFromCacheRef.current && cameraSnapshotRef.current) {
      try {
        const snapshot = JSON.parse(cameraSnapshotRef.current);
        camera.setState(snapshot, 0);
      } catch (e) {
        console.warn('[MolstarViewer] Failed to restore camera:', e);
      }
    }
    wasRestoredFromCacheRef.current = false;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCameraChangeAt = 0;
    let pendingCameraPersistence = false;
    const readCameraSnapshot = () => {
      const snapshot = camera.getSnapshot();
      return {
        position: snapshot.position,
        target: snapshot.target,
        up: snapshot.up,
        radius: snapshot.radius,
        fog: snapshot.fog,
        fov: snapshot.fov,
      };
    };
    let lastDrawSnapshot = JSON.stringify(readCameraSnapshot());
    const persistCameraSnapshot = (force = false) => {
      debounceTimer = null;
      if (
        (!force && !mountedRef.current) ||
        !cameraPersistenceOwner.save ||
        !pendingCameraPersistence
      )
        return;
      if (cameraPersistenceOwner.spin) {
        pendingCameraPersistence = false;
        recordCameraPersistenceDiagnostic({ stage: 'spin-skip', at: performance.now() });
        return;
      }
      const now = performance.now();
      const elapsedSinceChangeMs = now - lastCameraChangeAt;
      if (!force && elapsedSinceChangeMs < CAMERA_SNAPSHOT_PERSIST_IDLE_MS) {
        debounceTimer = setTimeout(
          persistCameraSnapshot,
          CAMERA_SNAPSHOT_PERSIST_IDLE_MS - elapsedSinceChangeMs
        );
        recordCameraPersistenceDiagnostic({
          stage: 'rescheduled',
          at: now,
          elapsedSinceChangeMs,
        });
        return;
      }
      pendingCameraPersistence = false;
      try {
        cameraPersistenceOwner.save(JSON.stringify(readCameraSnapshot()));
        recordCameraPersistenceDiagnostic({
          stage: 'persisted',
          at: performance.now(),
          elapsedSinceChangeMs,
        });
      } catch (e) {
        console.warn('[MolstarViewer] Failed to save camera:', e);
      }
    };
    const scheduleCameraPersistence = () => {
      if (!mountedRef.current || !cameraPersistenceOwner.save) return;
      if (cameraPersistenceOwner.spin) {
        pendingCameraPersistence = false;
        recordCameraPersistenceDiagnostic({ stage: 'spin-skip', at: performance.now() });
        return;
      }
      lastCameraChangeAt = performance.now();
      pendingCameraPersistence = true;
      if (!debounceTimer) {
        debounceTimer = setTimeout(persistCameraSnapshot, CAMERA_SNAPSHOT_PERSIST_IDLE_MS);
        recordCameraPersistenceDiagnostic({ stage: 'scheduled', at: lastCameraChangeAt });
      }
    };
    const subscription = camera.stateChanged.subscribe(scheduleCameraPersistence);
    const drawSubscription = plugin.canvas3d?.didDraw?.subscribe(() => {
      if (!mountedRef.current || !cameraPersistenceOwner.save) return;
      const snapshot = JSON.stringify(readCameraSnapshot());
      if (snapshot === lastDrawSnapshot) return;
      lastDrawSnapshot = snapshot;
      scheduleCameraPersistence();
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      persistCameraSnapshot(true);
      subscription.unsubscribe();
      drawSubscription?.unsubscribe();
    };
  }, [viewerCacheKey, viewerReady, cameraPersistenceOwner]);

  const cached = viewerCache.get(viewerCacheKey);
  const cacheError =
    rendererHostId && hasPreviousPaneError(cached, structureKey) ? null : cached?.error;
  const error = formatMolstarViewerDisplayError(cacheError) ?? viewerError;

  useEffect(() => {
    if (e2eStubEnabled || !viewerCacheKey) return;
    const cachedViewer = viewerCache.get(viewerCacheKey);
    if (
      !cachedViewer?.error ||
      cachedViewer.isLoading ||
      (rendererHostId && hasPreviousPaneError(cachedViewer, structureKey))
    )
      return;
    const cachedError = cachedViewer.error;
    if (!rendererHostId) {
      detachCachedViewerContainer(cachedViewer, wrapperRef.current);
      deleteCachedViewer(viewerCacheKey, `cached-error-effect:${cachedError}`);
    }
    recordPendingCreationDelete(viewerCacheKey, `cached-error-effect:${cachedError}`);
    setViewerReady(false);
    startCacheCleanup();
    if (cachedError === CANCELLED_VIEWER_LOAD_ERROR) {
      bumpCacheErrorRevision((value) => value + 1);
    } else {
      notifyViewerError('cached-error-effect', cachedError);
    }
  }, [e2eStubEnabled, notifyViewerError, rendererHostId, structureKey, viewerCacheKey]);

  useEffect(() => {
    if (!viewerCacheKey || !structureKey) return;
    recordStructureRenderTransactionDiagnostic({
      key: viewerCacheKey,
      structureKey,
      viewerReady,
      isConnected: wrapperRef.current?.isConnected === true,
      transaction: renderTransaction,
      molstarPlan: molstarRenderPlan,
    });
    return () => {
      removeStructureRenderTransactionDiagnostic(viewerCacheKey);
    };
  }, [molstarRenderPlan, renderTransaction, structureKey, viewerCacheKey, viewerReady]);

  if (e2eStubEnabled) {
    return (
      <div
        data-testid="molstar-viewer-stub"
        data-load-status={e2eStubError ? 'error' : e2eStubLoadStatus}
        data-structure-key={structureKey}
        data-viewer-cache-key={viewerCacheKey}
        data-render-intent={renderTransaction.renderIntent}
        data-structure-render-plan-hash={renderTransaction.planHash}
        data-chain-catalog-status={renderTransaction.chainCatalogStatus}
        data-error={e2eStubError ?? undefined}
        className="flex items-center justify-center rounded bg-bg-subtle text-xs text-fg-muted"
        style={{ height: fillContainer ? '100%' : height, width: '100%' }}
      >
        {e2eStubError
          ? toUserMessage(e2eStubError, 'failure.3d-viewer-stub')
          : userMessage('notice.3d-viewer-stub')}
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="molstar-viewer-error"
        role="alert"
        style={{
          height: fillContainer ? '100%' : height,
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#ef4444',
          background: '#fef2f2',
          borderRadius: '8px',
          fontSize: '14px',
        }}
      >
        <span>{toUserMessage(error, 'structure.failed')}</span>
        <button
          type="button"
          aria-label="Retry 3D structure"
          className="rounded border border-error/40 bg-bg px-3 py-1.5 text-xs font-medium text-fg wp-interactive"
          onClick={() => {
            const cachedViewer = viewerCache.get(viewerCacheKey);
            if (rendererHostId && cachedViewer?.plugin) {
              cachedViewer.error = null;
              cachedViewer.isLoading = false;
              cachedViewer.loadedStructureKey = null;
              if (cachedViewer.rendererHostActivation) {
                requestRendererHostStructure(cachedViewer.rendererHostActivation, structureKey);
              }
            } else {
              detachCachedViewerContainer(cachedViewer, wrapperRef.current);
              deleteCachedViewer(viewerCacheKey, 'user-retry-after-error');
            }
            recordPendingCreationDelete(viewerCacheKey, 'user-retry-after-error');
            setViewerError(null);
            setViewerReady(false);
            bumpCacheErrorRevision((value) => value + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      className="molstar-viewer-shell"
      data-render-intent={renderTransaction.renderIntent}
      data-structure-render-plan-hash={renderTransaction.planHash}
      data-chain-catalog-status={renderTransaction.chainCatalogStatus}
      style={{
        height: fillContainer ? '100%' : height,
        width: '100%',
        background: 'transparent',
        borderRadius: '8px',
        overflow: 'hidden',
        position: 'relative',
        cursor: 'default',
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onWheelCapture={(e) => {
        if (scrollZoom) return;
        if (!e.ctrlKey && !e.altKey) {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
        }
      }}
    >
      <div
        ref={wrapperRef}
        className="molstar-viewer-container"
        data-structure-key={structureKey}
        data-viewer-cache-key={viewerCacheKey}
        data-render-intent={renderTransaction.renderIntent}
        data-structure-render-plan-hash={renderTransaction.planHash}
        data-chain-catalog-status={renderTransaction.chainCatalogStatus}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
        }}
      />
      {!viewerReady && <MolstarReactLoadingOverlay />}
    </div>
  );
};

export const MolstarViewer = MolstarViewerComponent;

export default MolstarViewer;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearViewerCache('hmr-dispose');
  });
}
