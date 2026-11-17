import {
  SCIENTIFIC_COLOR_PALETTES,
  TRACK_COLOR_PRESETS,
  TRACK_DEFAULT_COLORS,
} from '@waypoint/sequence-utils';
import { usePresentationListener } from '../../../presentation/PresentationSurface';
import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { confirmDialog } from '../../../components/confirm-dialog-store';
import { RefreshIcon } from '../../../components/icons';
import { PortalMenu } from '../../../components/PortalMenu';
import { Button, UI_PROSE_WRAP_CLASS } from '../../../components/ui';
import { platform } from '../../../platform';
import { isIndexedBbiTrackSource } from '@waypoint/genome-data';
import { relinkIndexedBbiTrack } from '../relink-indexed-bbi-track';
import { useToastStore } from '../../../stores/toast-store';
import type { GenomeSourceCredentialInput } from '../../../shared/genome-source-credentials';
import { safeFocus } from '../../../shared/utils/safeFocus';
import type { AlignmentReferenceIdentity } from '../alignment-header-client';
import {
  DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
  MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS,
  QUANTITATIVE_SMOOTHING_SIGMA_STEP_BINS,
  createUcscTrackId,
  normalizeQuantitativeTrackPresentation,
  parseTrackAdmissionRequestV1,
  TRACK_ADMISSION_REQUEST_V1,
  type QuantitativeScaleMode,
  type QuantitativeTrackPresentationV1,
  type TrackAdmissionRequestV1,
  type UcscCatalogLeaf,
} from '@waypoint/genome-data';
import {
  BUILTIN_TRACK_TYPES,
  defaultBuiltinRegistry,
  type TrackPresentationDrag,
} from '@waypoint/genome-renderer';
import type { AnnotationTrackDefinition } from '../annotation-track-registry';
import {
  LEGACY_BUCKET,
  applyTrackPresentationPatch,
  useLaneContractStore,
  type Lane,
  type TrackPresentationPatch,
  type UpdateLanePresentationResult,
} from '../lane-contract-store';
import {
  alignedReadStatusWithRemoteConnection,
  alignedReadTrackStatusView,
  type AlignedReadTrackStatusSnapshot,
} from '../aligned-read-track-lifecycle';
import type { HostedReferenceUcscTrackTargetV1 } from '../../../shared/hosted-reference-ucsc-targets';
import { ucscTrackTargetForAssembly } from '../ucsc-assembly-alias';
import { catalogIdsInView } from '../ucsc-catalog-membership';
import {
  admitUcscCatalogTrackSource,
  hubDataTrackAdmissionRequest,
  ucscCatalogTargetForTrack,
} from '../ucsc-track-admission';
import { classifyUcscCatalogTrackSupport } from '../ucsc-track-support';
import { UCSC_TRACK_RECOVERING_STATUS } from '../ucsc-streaming-status';
import {
  datasetForAdmittedTrack,
  trackHeightForAdmittedScientificKind,
} from '../admitted-track-dataset';
import {
  AddTrackDialog,
  type NetworkTrackImportInput,
  type SignalReadPileupCompositionInput,
} from './AddTrackDialog';
import { RemoteTrackConnectionDialog } from './RemoteTrackConnectionDialog';
import { RemoteSignalConnectionDialog } from './RemoteSignalConnectionDialog';
import { CoverageCutoffControl } from './CoverageCutoffControl';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import {
  IndexedQuantitativeTrackAxes,
  isQuantitativeDataset,
} from './IndexedQuantitativeTrackAxes';
import type { LaneLimit } from './indexed-genome-legacy-adapter';
import type { TranscriptDisplayMode } from './isoform-collapse';
import { ReferenceTrackControls } from './ReferenceTrackControls';
import {
  READ_PILEUP_DEFAULT_MAX_ROWS,
  READ_PILEUP_DEFAULT_ROW_HEIGHT_PX,
  READ_PILEUP_DEFAULT_TRACK_HEIGHT_PX,
} from '../read-pileup-import';
import { buildLaneGutterRows, type GutterRow } from './track-gutter-rows';
import {
  applyPresentedTrackScrollReceipt,
  GUTTER_ADD_ROW_HEIGHT_PX,
  GUTTER_UNBANDED_ROW_HEIGHT_PX,
  TRACK_HEIGHT_MAX_PX,
  TRACK_HEIGHT_MIN_PX,
  TrackGutter,
  type TrackGutterDataTone,
} from './TrackGutter';
import type { BamTrackImportController } from './useBamTrackImport';
import { useDataFileImport } from './useDataFileImport';
import { useIndexedTrackImport } from './useIndexedTrackImport';
import type { LaneScreenBands } from './lane-screen-bands';
import { useTrackGutterLayoutStore } from './track-gutter-layout-store';
import type {
  RemoteAlignmentLocatorV1,
  RemoteEndpointProfileV1,
} from '../../../shared/remote-genomics-ipc';
import {
  buildExperimentalHybridPileupDataset,
  createSignalReadPileupViewState,
} from '../experimental-hybrid-pileup';

const EMPTY_LANES: ReadonlyArray<Lane> = [];
const TRACK_TYPE_REGISTRY = defaultBuiltinRegistry();

function TrackStreamErrorDetails({ message, trackLabel }: { message: string; trackLabel: string }) {
  const detailsId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const focusDetails = useCallback((node: HTMLParagraphElement | null) => {
    safeFocus(node, { preventScroll: true });
  }, []);

  return (
    <>
      <div className="min-w-0 flex-1">
        <Button
          ref={trigger}
          variant="link"
          aria-label={`Show load failure details for ${trackLabel}`}
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          Couldn&apos;t load
        </Button>
      </div>
      <span className="sr-only">: {message}</span>
      <PortalMenu
        id={detailsId}
        open={open}
        anchorRef={trigger}
        onRequestClose={() => {
          setOpen(false);
          safeFocus(trigger.current, { preventScroll: true });
        }}
        role="dialog"
        horizontalAlign="start"
        aria-label={`Load failure details for ${trackLabel}`}
        className="w-max p-2 text-xs text-fg"
      >
        <p
          ref={focusDetails}
          tabIndex={-1}
          className={`${UI_PROSE_WRAP_CLASS} max-w-lg focus:outline-none`}
        >
          {message}
        </p>
      </PortalMenu>
    </>
  );
}

const TRACK_SETTING_ROW_CLASS =
  'relative grid min-w-0 grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-2';
const TRACK_SETTING_CONTROL_CLASS =
  'h-7 min-w-0 w-full rounded-md border border-border bg-bg px-2 text-[11px] text-fg shadow-sm outline-none transition-[border-color,box-shadow,background-color] hover:border-fg-subtle/60 focus:border-fg-subtle focus:ring-1 focus:ring-fg-subtle/20';

export function remoteEndpointDisplayLabel(
  locator: RemoteAlignmentLocatorV1,
  endpoints: readonly RemoteEndpointProfileV1[]
): string {
  const endpoint = endpoints.find(
    (candidate) =>
      candidate.endpointId === locator.endpointId || candidate.target === locator.target
  );
  return endpoint?.displayName.trim() || locator.target.trim() || 'Remote source';
}
interface IndexedViewerTrackGutterProps {
  laneOwnerId: string;
  assemblyId: string;
  assemblyDisplayName?: string;
  assemblyReferences?: ReadonlyArray<AlignmentReferenceIdentity>;
  assemblyUcscTrackTarget?: HostedReferenceUcscTrackTargetV1 | null;
  visibleTypes: ReadonlySet<string>;
  onToggleAnnotationLane: () => void;
  annotationTrackRegistry: ReadonlyArray<AnnotationTrackDefinition>;
  onToggleVisibleType: (type: string) => void;
  onSetVisibleTypes: (types: ReadonlySet<string>) => void;
  temporaryAnnotationReveal?: {
    trackId: string;
    onShowTrack: () => void;
  } | null;
  visibleAnnotationSearchFocus?: {
    trackId: string;
    canonicalIdentity: string;
    onKeepAdditionalLane?: () => void;
  } | null;
  laneLimit: LaneLimit;
  onChangeLaneLimit: (next: LaneLimit) => void;
  maxSupportedFiniteLaneLimit?: number;
  transcriptDisplayMode: TranscriptDisplayMode;
  onToggleTranscriptDisplayMode: () => void;
  expandedGeneCount: number;
  annotationPreparationState?: 'idle' | 'preparing' | 'error';
  rendererReadyEpoch: number;
  ucscTrackErrors?: Readonly<Record<string, string>>;
  onRetryUcscTracks?: () => void;
  pileupTrackStatuses?: AlignedReadTrackStatusSnapshot;
  onRetryPileupTrack?: (trackId: string) => void;
  bamImport: BamTrackImportController;
  onAddVariantTrackRequest?: (request: TrackAdmissionRequestV1) => Promise<void>;
  onOpenMutationNavigator?: () => void;
  bands: LaneScreenBands;
  webglRef: RefObject<IndexedGenomeTileNativeMapHandle | null>;
}

export function IndexedViewerTrackGutter({
  laneOwnerId,
  assemblyId,
  assemblyDisplayName = assemblyId,
  assemblyReferences,
  assemblyUcscTrackTarget = null,
  visibleTypes,
  onToggleAnnotationLane,
  annotationTrackRegistry,
  onToggleVisibleType,
  onSetVisibleTypes,
  temporaryAnnotationReveal,
  visibleAnnotationSearchFocus,
  laneLimit,
  onChangeLaneLimit,
  maxSupportedFiniteLaneLimit,
  transcriptDisplayMode,
  onToggleTranscriptDisplayMode,
  expandedGeneCount,
  annotationPreparationState,
  rendererReadyEpoch,
  ucscTrackErrors,
  onRetryUcscTracks,
  pileupTrackStatuses,
  onRetryPileupTrack,
  bamImport,
  onAddVariantTrackRequest,
  onOpenMutationNavigator,
  bands,
  webglRef,
}: IndexedViewerTrackGutterProps) {
  const width = useTrackGutterLayoutStore((state) => state.width);
  const handleResize = useTrackGutterLayoutStore((state) => state.setWidth);
  const collapsed = useTrackGutterLayoutStore(
    (state) => state.collapsedByTabId[laneOwnerId] ?? false
  );
  const cytobandVisible = useTrackGutterLayoutStore((state) => state.cytobandVisible);
  const setCytobandVisible = useTrackGutterLayoutStore((state) => state.setCytobandVisible);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [rememberedCatalogLanes, setRememberedCatalogLanes] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const [remoteDetailsTrackId, setRemoteDetailsTrackId] = useState<string | null>(null);
  const [relinkingTrackId, setRelinkingTrackId] = useState<string | null>(null);
  const locateTrack = useCallback(
    async (trackId: string, label: string) => {
      if (!assemblyReferences?.length || relinkingTrackId) return;
      setRelinkingTrackId(trackId);
      try {
        const selected = await platform().dialog.open({
          multiple: false,
          title: `Locate ${label}`,
          filters: [{ name: 'BigWig or BigBed', extensions: ['bw', 'bigwig', 'bb', 'bigbed'] }],
        });
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (path)
          await relinkIndexedBbiTrack({ ownerId: laneOwnerId, trackId, path, assemblyReferences });
      } catch (error) {
        console.error('[TrackView] Could not relink local track:', {
          trackId,
          message: error instanceof Error ? error.message : String(error),
        });
        useToastStore.getState().addToast(toUserMessage(error, 'tracks.relinkFailed'), {
          definition: 'track-view-failed',
        });
      } finally {
        setRelinkingTrackId(null);
      }
    },
    [assemblyReferences, laneOwnerId, relinkingTrackId]
  );
  const axisPortalAnchorRef = useRef<HTMLSpanElement | null>(null);
  const [axisPortalHost, setAxisPortalHost] = useState<HTMLElement | null>(null);
  const ownedLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[laneOwnerId] ?? EMPTY_LANES
  );
  const legacyLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[LEGACY_BUCKET] ?? EMPTY_LANES
  );
  const setLaneVisible = useLaneContractStore((state) => state.setLaneVisible);
  const removeLane = useLaneContractStore((state) => state.removeLane);
  const moveLane = useLaneContractStore((state) => state.moveLane);
  const setLaneOrder = useLaneContractStore((state) => state.setLaneOrder);
  const updateLanePresentation = useLaneContractStore((state) => state.updateLanePresentation);
  const commitLaneHeightResize = useLaneContractStore((state) => state.commitLaneHeightResize);
  const addLane = useLaneContractStore((state) => state.addLane);
  const composableReadTracks = useMemo(
    () =>
      ownedLanes.flatMap((lane) =>
        lane.dataset.kind === 'pileup' && lane.dataset.source && !lane.dataset.experimentalHybrid
          ? [{ trackId: lane.dataset.trackId, label: lane.dataset.label }]
          : []
      ),
    [ownedLanes]
  );
  const composableSignalTracks = useMemo(
    () =>
      ownedLanes.flatMap((lane) =>
        lane.dataset.kind !== 'pileup' &&
        lane.dataset.trackType === BUILTIN_TRACK_TYPES.quantitative &&
        lane.source?.formatId === 'bigwig' &&
        lane.source.scientificKind === 'quantitative'
          ? [{ trackId: lane.dataset.trackId, label: lane.dataset.label }]
          : []
      ),
    [ownedLanes]
  );
  const gutterScrollLayerRef = useRef<HTMLDivElement | null>(null);
  const previewOrderRef = useRef<ReadonlyArray<string> | null>(null);
  const previewDragRef = useRef<TrackPresentationDrag | null>(null);
  const lastAppliedScrollRef = useRef<{
    target: HTMLDivElement;
    trackScrollTop: number;
  } | null>(null);
  const setGutterScrollLayer = useCallback(
    (target: HTMLDivElement | null) => {
      gutterScrollLayerRef.current = target;
      const receipt = webglRef.current?.getLinearRenderer?.()?.getPresentedTrackScrollReceipt?.();
      if (!target || !receipt) return;
      applyPresentedTrackScrollReceipt(target, receipt);
      lastAppliedScrollRef.current = { target, trackScrollTop: receipt.trackScrollTop };
    },
    [webglRef]
  );
  useEffect(() => {
    const parent = axisPortalAnchorRef.current?.parentElement;
    if (!parent) return;
    const syncPortalHost = () => {
      const next = parent.querySelector<HTMLElement>(
        ':scope > [data-testid="indexed-genome-canvas-host"]'
      );
      setAxisPortalHost((current) => (current === next ? current : next));
    };
    syncPortalHost();
    const observer = new MutationObserver(syncPortalHost);
    observer.observe(parent, { childList: true });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let retryFrame: number | null = null;
    let disposed = false;

    const syncPresentedScroll = () => {
      const target = gutterScrollLayerRef.current;
      const receipt = webglRef.current?.getLinearRenderer?.()?.getPresentedTrackScrollReceipt?.();
      const applied = lastAppliedScrollRef.current;
      if (
        !target ||
        !receipt ||
        (applied?.target === target && applied.trackScrollTop === receipt.trackScrollTop)
      ) {
        return;
      }
      applyPresentedTrackScrollReceipt(target, receipt);
      lastAppliedScrollRef.current = { target, trackScrollTop: receipt.trackScrollTop };
    };
    const attach = () => {
      if (disposed) return;
      const map = webglRef.current;
      if (!map) {
        retryFrame = requestAnimationFrame(attach);
        return;
      }
      syncPresentedScroll();
      unsubscribe = map.subscribeToPresentedFrames(syncPresentedScroll);
      map.requestRender();
    };
    attach();
    return () => {
      disposed = true;
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
      unsubscribe?.();
    };
  }, [webglRef]);
  const handleVerticalScroll = useCallback(
    (deltaY: number) => webglRef.current?.scrollTracksBy(deltaY) ?? false,
    [webglRef]
  );
  const dataLanes = useMemo(
    () => [
      ...ownedLanes.map((lane) => ({ ...lane, bucket: laneOwnerId })),
      ...legacyLanes.map((lane) => ({ ...lane, bucket: LEGACY_BUCKET })),
    ],
    [laneOwnerId, legacyLanes, ownedLanes]
  );
  const presentCatalogIds = useMemo(() => {
    const ids = new Set(catalogIdsInView(dataLanes));
    if (rememberedCatalogLanes.size === 0) return ids;
    const liveTrackIds = new Set(dataLanes.map((lane) => lane.dataset.trackId));
    for (const [catalogId, trackId] of rememberedCatalogLanes) {
      if (liveTrackIds.has(trackId)) ids.add(catalogId);
    }
    return ids;
  }, [dataLanes, rememberedCatalogLanes]);
  const rememberCatalogLane = useCallback(
    (catalogId: string, beforeTrackIds: ReadonlySet<string>) => {
      const created = useLaneContractStore
        .getState()
        .lanesForOwner(laneOwnerId)
        .filter((lane) => !beforeTrackIds.has(lane.dataset.trackId));
      if (created.length !== 1) return;
      const trackId = created[0]!.dataset.trackId;
      setRememberedCatalogLanes((current) => {
        if (current.get(catalogId) === trackId) return current;
        const next = new Map(current);
        next.set(catalogId, trackId);
        return next;
      });
    },
    [laneOwnerId]
  );
  const remoteDetailsLane = remoteDetailsTrackId
    ? dataLanes.find((lane) => lane.dataset.trackId === remoteDetailsTrackId)
    : undefined;
  const hasRemotePileupSource = useMemo(
    () =>
      dataLanes.some(
        (lane) =>
          (lane.dataset.kind === 'pileup' && lane.dataset.source?.remote != null) ||
          lane.dataset.remoteSignal != null
      ),
    [dataLanes]
  );
  const refreshRemoteEndpoints = bamImport.refreshRemoteEndpoints;
  useEffect(() => {
    if (!hasRemotePileupSource) return;
    void refreshRemoteEndpoints();
  }, [hasRemotePileupSource, refreshRemoteEndpoints]);
  const durableOwnerOrder = useMemo(
    () => ownedLanes.map((lane) => lane.dataset.trackId),
    [ownedLanes]
  );
  const rendererOrderForOwnerOrder = useCallback(
    (ownerOrder: ReadonlyArray<string>) => {
      const visibleOwnerIds = new Set(
        ownedLanes.filter((lane) => lane.visible).map((lane) => lane.dataset.trackId)
      );
      return [
        ...ownerOrder.filter((trackId) => visibleOwnerIds.has(trackId)),
        ...legacyLanes.filter((lane) => lane.visible).map((lane) => lane.dataset.trackId),
      ];
    },
    [legacyLanes, ownedLanes]
  );
  const applyPresentationOrder = useCallback(
    (ownerOrder: ReadonlyArray<string>) =>
      webglRef.current?.setTrackPresentationOrder(rendererOrderForOwnerOrder(ownerOrder)) ?? false,
    [rendererOrderForOwnerOrder, webglRef]
  );
  const rows = useMemo(
    () =>
      buildLaneGutterRows({
        bands,
        referenceLabel: assemblyDisplayName,
        cytobandVisible,
        annotationVisibleCount: visibleTypes.size,
        dataLanes: dataLanes.map((lane) => ({
          dataset: lane.dataset,
          visible: lane.visible,
          bucket: lane.bucket,
          reorderable: lane.bucket === laneOwnerId,
        })),
      }),
    [assemblyDisplayName, bands, cytobandVisible, dataLanes, laneOwnerId, visibleTypes.size]
  );
  const trackStackEndReservePx = useMemo(
    () =>
      GUTTER_ADD_ROW_HEIGHT_PX +
      rows.filter((row) => !row.band).length * GUTTER_UNBANDED_ROW_HEIGHT_PX,
    [rows]
  );
  useEffect(() => {
    let retryFrame: number | null = null;
    let disposed = false;
    const apply = () => {
      if (disposed) return;
      if (webglRef.current?.setTrackStackEndReserve(trackStackEndReservePx)) return;
      retryFrame = requestAnimationFrame(apply);
    };
    apply();
    return () => {
      disposed = true;
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
    };
  }, [rendererReadyEpoch, trackStackEndReservePx, webglRef]);

  const handleToggleVisible = useCallback(
    (row: GutterRow) => {
      if (row.kind === 'reference') {
        onToggleAnnotationLane();
      } else if (row.kind === 'cytoband') {
        setCytobandVisible(!row.visible);
      } else if (row.bucket && row.trackId) {
        setLaneVisible(row.bucket, row.trackId, !row.visible);
      }
    },
    [onToggleAnnotationLane, setCytobandVisible, setLaneVisible]
  );

  const handleRemove = useCallback(
    async (row: GutterRow) => {
      if (row.kind !== 'data' || !row.bucket || !row.trackId) return;
      const dependentCount = useLaneContractStore
        .getState()
        .lanesForOwner(row.bucket)
        .filter(
          (lane) =>
            lane.dataset.experimentalHybrid?.alignmentTrackId === row.trackId ||
            lane.dataset.experimentalHybrid?.quantitativeTrackId === row.trackId
        ).length;
      const confirmed = await confirmDialog({
        title: userMessage('dialog.remove-track'),
        message:
          dependentCount > 0
            ? userMessageWithValues('dialog.remove-value-and-value-combined-value-on-it', {
                value0: userMessageValue(row.label),
                value1: userMessageValue(dependentCount),
                value2: userMessageValue(
                  dependentCount === 1 ? 'view that depends' : 'views that depend'
                ),
              })
            : userMessageWithValues('dialog.are-you-sure-you-want-to-remove-value-from-this-view', {
                value0: userMessageValue(row.label),
              }),
        confirmLabel: userMessage('dialog.remove-track-other'),
        cancelLabel: userMessage('dialog.keep-track'),
        tone: 'danger',
        safeDefault: true,
      });
      if (confirmed) removeLane(row.bucket, row.trackId);
    },
    [removeLane]
  );

  const handleMoveDataRow = useCallback(
    (trackId: string, targetTrackId: string, placement: 'before' | 'after') => {
      moveLane(laneOwnerId, trackId, targetTrackId, placement);
      const nextOrder = useLaneContractStore
        .getState()
        .lanesForOwner(laneOwnerId)
        .map((lane) => lane.dataset.trackId);
      applyPresentationOrder(nextOrder);
    },
    [applyPresentationOrder, laneOwnerId, moveLane]
  );
  const handlePreviewDataRowOrder = useCallback(
    (orderedTrackIds: ReadonlyArray<string>) => {
      previewOrderRef.current = orderedTrackIds;
      applyPresentationOrder(orderedTrackIds);
    },
    [applyPresentationOrder]
  );
  const handlePreviewDataRowDrag = useCallback(
    (preview: TrackPresentationDrag | null) => {
      previewDragRef.current = preview;
      webglRef.current?.setTrackPresentationDrag(preview);
    },
    [webglRef]
  );
  const handleCommitDataRowOrder = useCallback(
    (orderedTrackIds: ReadonlyArray<string>) => {
      previewOrderRef.current = null;
      if (setLaneOrder(laneOwnerId, orderedTrackIds)) return;
      const currentOrder = useLaneContractStore
        .getState()
        .lanesForOwner(laneOwnerId)
        .map((lane) => lane.dataset.trackId);
      applyPresentationOrder(currentOrder);
    },
    [applyPresentationOrder, laneOwnerId, setLaneOrder]
  );
  const handleCancelDataRowOrder = useCallback(() => {
    previewOrderRef.current = null;
    applyPresentationOrder(durableOwnerOrder);
  }, [applyPresentationOrder, durableOwnerOrder]);
  const handlePreviewDataRowHeight = useCallback(
    (row: GutterRow, heightPx: number) => {
      if (!row.bucket || !row.trackId) return;
      updateLanePresentation(row.bucket, row.trackId, { heightPx }, 'skip');
    },
    [updateLanePresentation]
  );
  const handleCommitDataRowHeight = useCallback(
    (row: GutterRow, startingHeightPx: number, heightPx: number) => {
      if (!row.bucket || !row.trackId) return;
      commitLaneHeightResize(row.bucket, row.trackId, startingHeightPx, heightPx);
    },
    [commitLaneHeightResize]
  );
  const handleCancelDataRowHeight = useCallback(
    (row: GutterRow, startingHeightPx: number) => {
      if (!row.bucket || !row.trackId) return;
      updateLanePresentation(row.bucket, row.trackId, { heightPx: startingHeightPx }, 'skip');
    },
    [updateLanePresentation]
  );
  useEffect(() => {
    const previewOrder = previewOrderRef.current;
    if (!previewOrder) return;
    const desiredRendererOrder = rendererOrderForOwnerOrder(previewOrder);
    let retryFrame: number | null = null;
    let disposed = false;
    const restorePreview = () => {
      if (disposed) return;
      const map = webglRef.current;
      const renderer = map?.getLinearRenderer?.();
      if (
        !map ||
        !renderer ||
        desiredRendererOrder.some((trackId) => !renderer.hasTrackInstance(trackId))
      ) {
        retryFrame = requestAnimationFrame(restorePreview);
        return;
      }
      map.setTrackPresentationOrder(desiredRendererOrder);
      map.setTrackPresentationDrag(previewDragRef.current);
    };
    restorePreview();
    return () => {
      disposed = true;
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
    };
  }, [rendererOrderForOwnerOrder, rendererReadyEpoch, webglRef]);

  const renderDataControls = useCallback(
    (row: GutterRow, settingsExpanded: boolean) => {
      const lane = dataLanes.find(
        (candidate) => candidate.bucket === row.bucket && candidate.dataset.trackId === row.trackId
      );
      const trackId = row.trackId;
      const bucket = row.bucket;
      if (!lane || !trackId || !bucket) return null;
      const controls: ReactNode = settingsExpanded ? (
        <TrackSettingsPanel lane={lane} bucket={bucket} webglRef={webglRef} />
      ) : null;
      const streamErrorTrackId = lane.dataset.experimentalHybrid?.quantitativeTrackId ?? trackId;
      const hybridSignalError = lane.dataset.experimentalHybrid?.sourceError;
      const streamStatus = ucscTrackErrors?.[streamErrorTrackId];
      const streamRecovering = streamStatus === UCSC_TRACK_RECOVERING_STATUS;
      const streamError = streamRecovering
        ? hybridSignalError
        : (streamStatus ?? hybridSignalError);
      const canLocate =
        lane.bucket === laneOwnerId &&
        lane.source &&
        isIndexedBbiTrackSource(lane.source) &&
        lane.source.input?.kind === 'path' &&
        Boolean(assemblyReferences?.length);
      const streamErrorMessage = canLocate
        ? userMessage('tracks.localSourceUnavailable')
        : toUserMessage(streamError, 'sequence.failed');
      const pileupStatusTrackId = lane.dataset.experimentalHybrid?.alignmentTrackId ?? trackId;
      const pileupSourceLane = dataLanes.find(
        (candidate) => candidate.dataset.trackId === pileupStatusTrackId
      );
      const pileupSource =
        pileupSourceLane?.dataset.kind === 'pileup' ? pileupSourceLane.dataset.source : undefined;
      const pileupStatus = pileupSource?.bamPath
        ? alignedReadStatusWithRemoteConnection(
            pileupTrackStatuses?.[pileupStatusTrackId] ?? { phase: 'loading' },
            pileupSource.admissionError ? undefined : pileupSource.remote?.connection
          )
        : null;
      const pileupStatusView = pileupStatus
        ? alignedReadTrackStatusView(pileupStatus, {
            remote: pileupSource?.remote != null,
            remoteEndpointLabel: pileupSource?.remote
              ? remoteEndpointDisplayLabel(
                  pileupSource.remote.locator,
                  bamImport.recentRemoteEndpoints
                )
              : undefined,
          })
        : null;
      const pileupStatusAction =
        pileupStatus?.phase === 'blocked' && pileupStatus.action === 'repair'
          ? bamImport.repairTrack
          : onRetryPileupTrack;
      const remoteSignal = lane.dataset.remoteSignal;
      const signalError =
        remoteSignal?.admissionError ?? remoteSignal?.connection?.lastFailure?.message;
      const signalOpening = signalError?.startsWith('Opening') === true;
      if (!streamError && !streamRecovering && !pileupStatusView && !remoteSignal) return controls;
      return (
        <div className="flex min-w-0 flex-col gap-1">
          {controls}
          {remoteSignal ? (
            <div
              role={signalError && !signalOpening ? 'alert' : 'status'}
              className={`flex min-w-0 items-center gap-1 text-[10px] ${signalError && !signalOpening ? 'text-danger' : 'text-fg-muted'}`}
            >
              <span
                className="min-w-0 flex-1 truncate"
                title={toUserMessage(signalError, 'sequence.failed')}
              >
                {signalError != null
                  ? toUserMessage(signalError, 'failure.remote-histogram')
                  : remoteSignal.connection?.state === 'online'
                    ? userMessage('notice.connected')
                    : remoteSignal.connection?.state === 'retrying'
                      ? userMessage('notice.reconnecting')
                      : remoteSignal.connection?.state === 'needs-authentication'
                        ? userMessage('notice.authentication-needed')
                        : remoteSignal.connection?.state === 'blocked'
                          ? userMessage('notice.connection-needs-repair')
                          : userMessage('failure.remote-histogram')}
              </span>
              <button
                type="button"
                aria-label={`Connection details for ${lane.dataset.label}`}
                onClick={() => {
                  bamImport.clearNotice();
                  setRemoteDetailsTrackId(trackId);
                }}
                className="shrink-0 rounded px-1 py-0.5 font-semibold hover:bg-bg-muted"
              >
                Details
              </button>
            </div>
          ) : null}
          {pileupStatus && pileupStatusView ? (
            <div
              role={pileupStatus.phase === 'blocked' ? 'alert' : 'status'}
              data-testid={`aligned-read-gutter-status-${trackId}`}
              data-status-phase={pileupStatus.phase}
              className={`flex min-w-0 items-center gap-1 text-[10px] ${
                pileupStatus.phase === 'blocked'
                  ? 'text-danger'
                  : pileupStatus.phase === 'recovering' ||
                      pileupStatus.phase === 'stalled' ||
                      pileupStatus.phase === 'waiting-for-authentication'
                    ? 'text-amber-700'
                    : 'text-fg-muted'
              }`}
            >
              <span className="min-w-0 flex-1 truncate" title={pileupStatusView.gutterLabel}>
                {pileupStatusView.gutterLabel}
              </span>
              {pileupSource?.remote ? (
                <button
                  type="button"
                  onClick={() => {
                    bamImport.clearNotice();
                    setRemoteDetailsTrackId(pileupStatusTrackId);
                  }}
                  aria-label={`Connection details for ${lane.dataset.label}`}
                  className="shrink-0 rounded px-1 py-0.5 font-semibold hover:bg-bg-muted"
                >
                  Details
                </button>
              ) : null}
              {pileupStatusView.actionLabel && pileupStatusAction ? (
                <button
                  type="button"
                  onClick={() => pileupStatusAction(pileupStatusTrackId)}
                  aria-label={`${pileupStatusView.actionLabel} ${lane.dataset.label}`}
                  className="shrink-0 rounded px-1 py-0.5 font-semibold hover:bg-danger/10"
                >
                  {pileupStatusView.actionLabel}
                </button>
              ) : null}
            </div>
          ) : null}
          {streamError ? (
            <div
              role="alert"
              data-testid={`ucsc-track-stream-error-${trackId}`}
              className="flex min-w-0 items-center gap-1 text-[10px] text-danger"
            >
              <TrackStreamErrorDetails
                message={streamErrorMessage}
                trackLabel={lane.dataset.label}
              />
              {hybridSignalError ? (
                <button
                  type="button"
                  onClick={() => bamImport.repairTrack(pileupStatusTrackId)}
                  aria-label={`Repair ${lane.dataset.label}`}
                  className="shrink-0 rounded px-1 py-0.5 font-semibold hover:bg-danger/10"
                >
                  Repair
                </button>
              ) : canLocate ? (
                <button
                  type="button"
                  disabled={relinkingTrackId !== null}
                  onClick={() => void locateTrack(trackId, lane.dataset.label)}
                  aria-label={`Locate file for ${lane.dataset.label}`}
                  className="shrink-0 rounded px-1 py-0.5 font-semibold hover:bg-danger/10"
                >
                  {relinkingTrackId === trackId ? 'Checking…' : 'Locate file'}
                </button>
              ) : onRetryUcscTracks ? (
                <button
                  type="button"
                  onClick={onRetryUcscTracks}
                  aria-label={`Retry ${lane.dataset.label}`}
                  className="shrink-0 rounded px-1 py-0.5 font-semibold hover:bg-danger/10"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {streamRecovering ? (
            <div
              role="status"
              data-testid={`ucsc-track-stream-recovering-${trackId}`}
              className="text-[10px] text-amber-700"
            >
              Reconnecting…
            </div>
          ) : null}
        </div>
      );
    },
    [
      bamImport,
      bamImport.repairTrack,
      bamImport.recentRemoteEndpoints,
      dataLanes,
      laneOwnerId,
      assemblyReferences,
      locateTrack,
      relinkingTrackId,
      onRetryPileupTrack,
      onRetryUcscTracks,
      pileupTrackStatuses,
      ucscTrackErrors,
      webglRef,
    ]
  );
  const dataRowTone = useCallback(
    (row: GutterRow): TrackGutterDataTone => {
      const trackId = row.trackId;
      if (!trackId) return 'default';
      const lane = dataLanes.find((candidate) => candidate.dataset.trackId === trackId);
      if (!lane) return 'default';
      const pileupStatusTrackId = lane.dataset.experimentalHybrid?.alignmentTrackId ?? trackId;
      const pileupSourceLane = dataLanes.find(
        (candidate) => candidate.dataset.trackId === pileupStatusTrackId
      );
      if (
        pileupSourceLane?.dataset.kind !== 'pileup' ||
        !pileupSourceLane.dataset.source?.bamPath
      ) {
        return 'default';
      }
      const status = alignedReadStatusWithRemoteConnection(
        pileupTrackStatuses?.[pileupStatusTrackId] ?? { phase: 'loading' },
        pileupSourceLane.dataset.source.admissionError
          ? undefined
          : pileupSourceLane.dataset.source.remote?.connection
      );
      if (status.phase === 'loading' || status.phase === 'refreshing') return 'loading';
      if (status.phase === 'stalled') return 'stalled';
      if (status.phase === 'recovering' || status.phase === 'waiting-for-authentication') {
        return 'recovering';
      }
      if (status.phase === 'blocked') return 'blocked';
      return status.kind === 'empty' ? 'empty' : 'default';
    },
    [dataLanes, pileupTrackStatuses]
  );
  const ucscTarget = useMemo(
    () => ucscTrackTargetForAssembly(assemblyId) ?? assemblyUcscTrackTarget ?? null,
    [assemblyId, assemblyUcscTrackTarget]
  );
  const indexedTrackImport = useIndexedTrackImport({
    laneOwnerId,
    assemblyId,
    assemblyDisplayName,
    assemblyReferences: assemblyReferences ?? [],
  });
  const dataFileImport = useDataFileImport({
    laneOwnerId,
    assemblyId,
    assemblyDisplayName,
    assemblyReferences: assemblyReferences ?? [],
    assemblyUcscGenomeId: ucscTarget?.genomeId ?? null,
    bamImport,
    indexedImport: indexedTrackImport,
  });
  const handleCreateSignalReadPileup = useCallback(
    (composition: SignalReadPileupCompositionInput): 'added' | 'duplicate' => {
      const lanes = useLaneContractStore.getState().lanesForOwner(laneOwnerId);
      const alignmentLane = lanes.find((lane) => lane.dataset.trackId === composition.readsTrackId);
      const signalLane = lanes.find((lane) => lane.dataset.trackId === composition.signalTrackId);
      if (alignmentLane?.dataset.kind !== 'pileup' || !alignmentLane.dataset.source) {
        throw new Error('The selected BAM or CRAM is no longer attached to this view.');
      }
      if (
        !signalLane ||
        signalLane.dataset.kind === 'pileup' ||
        signalLane.dataset.trackType !== BUILTIN_TRACK_TYPES.quantitative ||
        signalLane.source?.formatId !== 'bigwig' ||
        signalLane.source.scientificKind !== 'quantitative'
      ) {
        throw new Error('The selected quantitative BigWig is no longer attached to this view.');
      }
      const existing = lanes.find(
        (lane) =>
          lane.dataset.experimentalHybrid?.alignmentTrackId === composition.readsTrackId &&
          lane.dataset.experimentalHybrid.quantitativeTrackId === composition.signalTrackId
      );
      if (existing) {
        setLaneVisible(laneOwnerId, existing.dataset.trackId, true);
        setLaneVisible(laneOwnerId, alignmentLane.dataset.trackId, composition.showSourceTracks);
        setLaneVisible(laneOwnerId, signalLane.dataset.trackId, composition.showSourceTracks);
        return 'duplicate';
      }
      const view = createSignalReadPileupViewState({
        assemblyId,
        alignment: alignmentLane.dataset,
        signal: signalLane.dataset,
        label: composition.label,
        order: Math.max(-1, ...lanes.map((lane) => lane.order)) + 1,
      });
      const result = addLane(
        laneOwnerId,
        assemblyId,
        buildExperimentalHybridPileupDataset({
          alignment: alignmentLane.dataset,
          signal: signalLane.dataset,
          view,
        }),
        true,
        undefined,
        view.order
      );
      setLaneVisible(laneOwnerId, alignmentLane.dataset.trackId, composition.showSourceTracks);
      setLaneVisible(laneOwnerId, signalLane.dataset.trackId, composition.showSourceTracks);
      return result;
    },
    [addLane, assemblyId, laneOwnerId, setLaneVisible]
  );
  const handleAddUcscTrack = useCallback(
    async (track: UcscCatalogLeaf) => {
      const catalogTarget = ucscCatalogTargetForTrack(track, ucscTarget);
      if (!catalogTarget) {
        throw new Error(`UCSC loading is not mapped for ${assemblyDisplayName}.`);
      }
      const support = classifyUcscCatalogTrackSupport(track);
      if (!support.supported) throw new Error(support.reason);
      if (support.path === 'hub-reads') {
        const beforeTrackIds = new Set(
          useLaneContractStore
            .getState()
            .lanesForOwner(laneOwnerId)
            .map((lane) => lane.dataset.trackId)
        );
        await bamImport.addRequests([
          hubDataTrackAdmissionRequest({ assemblyId, ucscTarget: catalogTarget, track }),
        ]);
        rememberCatalogLane(track.catalogId, beforeTrackIds);
        return 'added' as const;
      }
      if (support.path === 'hub-variants') {
        if (!onAddVariantTrackRequest) {
          throw new Error('Variant navigation is unavailable for this reference.');
        }
        const beforeTrackIds = new Set(
          useLaneContractStore
            .getState()
            .lanesForOwner(laneOwnerId)
            .map((lane) => lane.dataset.trackId)
        );
        await onAddVariantTrackRequest(
          hubDataTrackAdmissionRequest({ assemblyId, ucscTarget: catalogTarget, track })
        );
        rememberCatalogLane(track.catalogId, beforeTrackIds);
        setAddDialogOpen(false);
        return 'added' as const;
      }
      const trackId = createUcscTrackId({
        sourceKind: track.sourceKind,
        ucscGenome: catalogTarget.genomeId,
        track: track.track,
        hubUrl: catalogTarget.hubUrl,
      });
      if (
        useLaneContractStore
          .getState()
          .lanesForOwner(laneOwnerId)
          .some((lane) => lane.dataset.trackId === trackId)
      ) {
        return 'duplicate' as const;
      }
      const source = await admitUcscCatalogTrackSource({
        assemblyId,
        assemblyReferences: assemblyReferences ?? [],
        ucscTarget: catalogTarget,
        track,
      });
      return addLane(
        laneOwnerId,
        assemblyId,
        datasetForAdmittedTrack({ trackId, label: track.shortLabel, source }),
        true,
        source
      );
    },
    [
      addLane,
      assemblyDisplayName,
      assemblyId,
      assemblyReferences,
      bamImport,
      laneOwnerId,
      onAddVariantTrackRequest,
      rememberCatalogLane,
      ucscTarget,
    ]
  );
  const handleSaveNetworkCredential = useCallback(
    async (credential: GenomeSourceCredentialInput): Promise<void> => {
      await platform().genomeCredentials.save(credential);
    },
    []
  );
  const handleAddNetworkSource = useCallback(
    async (input: NetworkTrackImportInput): Promise<void> => {
      const reads = input.formatId === 'bam' || input.formatId === 'cram';
      const variants = input.formatId === 'vcf' || input.formatId === 'bcf';
      const request = parseTrackAdmissionRequestV1({
        contract: TRACK_ADMISSION_REQUEST_V1,
        assemblyId,
        source: input.source,
        ...(input.index ? { index: input.index } : {}),
        ...(input.formatId ? { formatId: input.formatId } : {}),
        ...(input.scientificKind
          ? { scientificKind: input.scientificKind }
          : reads
            ? { scientificKind: 'reads' as const }
            : variants
              ? { scientificKind: 'variants' as const }
              : {}),
        ingress: {
          kind: input.source.kind === 's3' || input.source.kind === 'gcs' ? 'cloud' : 'url',
        },
        ...(input.label ? { label: input.label } : {}),
      });
      if (reads) {
        await bamImport.addRequests([request]);
        return;
      }
      if (variants) {
        if (!onAddVariantTrackRequest) {
          throw new Error('Remote variant navigation is unavailable for this reference.');
        }
        await onAddVariantTrackRequest(request);
        setAddDialogOpen(false);
        return;
      }
      const [outcome] = await indexedTrackImport.addRequests([request]);
      if (outcome?.status === 'error') throw new Error(outcome.message);
    },
    [assemblyId, bamImport, indexedTrackImport, onAddVariantTrackRequest]
  );

  return (
    <>
      <span ref={axisPortalAnchorRef} className="hidden" aria-hidden />
      <TrackGutter
        rows={rows}
        onToggleVisible={handleToggleVisible}
        onRemove={handleRemove}
        onMoveDataRow={handleMoveDataRow}
        dataRowOrder={durableOwnerOrder}
        onPreviewDataRowOrder={handlePreviewDataRowOrder}
        onPreviewDataRowDrag={handlePreviewDataRowDrag}
        onCommitDataRowOrder={handleCommitDataRowOrder}
        onCancelDataRowOrder={handleCancelDataRowOrder}
        onPreviewDataRowHeight={handlePreviewDataRowHeight}
        onCommitDataRowHeight={handleCommitDataRowHeight}
        onCancelDataRowHeight={handleCancelDataRowHeight}
        onAddTrack={() => {
          bamImport.clearNotice();
          dataFileImport.clearNotice();
          indexedTrackImport.clearNotice();
          setAddDialogOpen(true);
        }}
        onOpenMutationNavigator={onOpenMutationNavigator}
        width={width}
        onResize={handleResize}
        collapsed={collapsed}
        annotationTrackRegistry={annotationTrackRegistry}
        visibleTypes={visibleTypes}
        onToggleVisibleType={onToggleVisibleType}
        onSetVisibleTypes={onSetVisibleTypes}
        temporaryAnnotationReveal={temporaryAnnotationReveal}
        visibleAnnotationSearchFocus={
          visibleAnnotationSearchFocus &&
          bands.annotationSearchFocusPresentation?.trackId ===
            visibleAnnotationSearchFocus.trackId &&
          bands.annotationSearchFocusPresentation.canonicalIdentity ===
            visibleAnnotationSearchFocus.canonicalIdentity
            ? visibleAnnotationSearchFocus
            : null
        }
        referenceControls={
          <ReferenceTrackControls
            laneLimit={laneLimit}
            onChangeLaneLimit={onChangeLaneLimit}
            maxSupportedFiniteLaneLimit={maxSupportedFiniteLaneLimit}
            transcriptDisplayMode={transcriptDisplayMode}
            onToggleTranscriptDisplayMode={onToggleTranscriptDisplayMode}
            expandedGeneCount={expandedGeneCount}
            annotationPreparationState={annotationPreparationState}
          />
        }
        renderDataControls={renderDataControls}
        dataRowTone={dataRowTone}
        onVerticalScroll={handleVerticalScroll}
        scrollLayerRef={setGutterScrollLayer}
      />
      {axisPortalHost
        ? createPortal(
            <IndexedQuantitativeTrackAxes
              laneOwnerId={laneOwnerId}
              bands={bands}
              rendererReadyEpoch={rendererReadyEpoch}
              webglRef={webglRef}
            />,
            axisPortalHost
          )
        : null}
      <AddTrackDialog
        open={addDialogOpen}
        assemblyDisplayName={assemblyDisplayName}
        ucscTarget={ucscTarget}
        busy={bamImport.busy}
        progress={bamImport.progress}
        notice={bamImport.notice}
        dataFileNotice={dataFileImport.notice}
        indexedBusy={indexedTrackImport.busy}
        indexedNotice={indexedTrackImport.notice}
        recentRemoteEndpoints={bamImport.recentRemoteEndpoints}
        onChooseDataFiles={() => void dataFileImport.openFiles()}
        onImportDataFilePaths={dataFileImport.importPaths}
        onAddNetworkSource={handleAddNetworkSource}
        onSaveCredential={handleSaveNetworkCredential}
        remoteVariantsAvailable={Boolean(onAddVariantTrackRequest)}
        onAddUcscTrack={handleAddUcscTrack}
        presentCatalogIds={presentCatalogIds}
        onAddRemoteBam={bamImport.addRemote}
        remoteConnecting={bamImport.remoteConnecting}
        onCancelRemoteConnect={() => bamImport.cancelRemoteConnect()}
        onRefreshRemoteEndpoints={bamImport.refreshRemoteEndpoints}
        composableReadTracks={composableReadTracks}
        composableSignalTracks={composableSignalTracks}
        onCreateSignalReadPileup={handleCreateSignalReadPileup}
        onClose={() => setAddDialogOpen(false)}
      />
      {remoteDetailsLane?.dataset.kind === 'pileup' &&
      remoteDetailsLane.dataset.source?.remote?.locator &&
      remoteDetailsTrackId
        ? createPortal(
            <RemoteTrackConnectionDialog
              key={remoteDetailsTrackId}
              trackLabel={remoteDetailsLane.dataset.label}
              locator={remoteDetailsLane.dataset.source.remote.locator}
              connection={remoteDetailsLane.dataset.source.remote.connection}
              assemblyDisplayName={assemblyDisplayName}
              endpoints={bamImport.recentRemoteEndpoints}
              onRefreshEndpoints={bamImport.refreshRemoteEndpoints}
              busy={Boolean(bamImport.busy)}
              connecting={bamImport.remoteConnecting}
              onCancelConnection={() => bamImport.cancelRemoteConnect()}
              notice={bamImport.notice}
              onRetry={() => bamImport.repairTrack(remoteDetailsTrackId)}
              onSave={(request) => bamImport.editRemoteTrack(remoteDetailsTrackId, request)}
              onRemove={async () => {
                const row = rows.find((candidate) => candidate.trackId === remoteDetailsTrackId);
                if (!row) return;
                setRemoteDetailsTrackId(null);
                await handleRemove(row);
                if (
                  useLaneContractStore
                    .getState()
                    .lanesForOwner(row.bucket ?? laneOwnerId)
                    .some((lane) => lane.dataset.trackId === remoteDetailsTrackId)
                ) {
                  setRemoteDetailsTrackId(remoteDetailsTrackId);
                }
              }}
              onClose={() => setRemoteDetailsTrackId(null)}
            />,
            document.body
          )
        : null}
      {remoteDetailsLane?.dataset.remoteSignal && remoteDetailsTrackId
        ? createPortal(
            <RemoteSignalConnectionDialog
              key={remoteDetailsTrackId}
              trackLabel={remoteDetailsLane.dataset.label}
              locator={remoteDetailsLane.dataset.remoteSignal.locator}
              connection={remoteDetailsLane.dataset.remoteSignal.connection}
              admissionError={remoteDetailsLane.dataset.remoteSignal.admissionError}
              busy={Boolean(bamImport.busy)}
              connecting={
                bamImport.remoteConnecting ||
                remoteDetailsLane.dataset.remoteSignal.admissionError?.startsWith('Opening') ===
                  true
              }
              onCancelConnection={() => bamImport.cancelRemoteSignalConnect?.(remoteDetailsTrackId)}
              notice={bamImport.notice}
              onRetry={() => bamImport.repairTrack(remoteDetailsTrackId)}
              onSave={async (request) => {
                if (!bamImport.editRemoteSignalTrack)
                  throw new Error('Remote histogram source editing is unavailable.');
                await bamImport.editRemoteSignalTrack(remoteDetailsTrackId, request);
              }}
              onRemove={async () => {
                const row = rows.find((candidate) => candidate.trackId === remoteDetailsTrackId);
                if (!row) return;
                setRemoteDetailsTrackId(null);
                await handleRemove(row);
                if (
                  useLaneContractStore
                    .getState()
                    .lanesForOwner(row.bucket ?? laneOwnerId)
                    .some((lane) => lane.dataset.trackId === remoteDetailsTrackId)
                ) {
                  setRemoteDetailsTrackId(remoteDetailsTrackId);
                }
              }}
              onClose={() => setRemoteDetailsTrackId(null)}
            />,
            document.body
          )
        : null}
    </>
  );
}

function TrackSettingsPanel({
  lane,
  bucket,
  webglRef,
}: {
  lane: Lane;
  bucket: string;
  webglRef: RefObject<IndexedGenomeTileNativeMapHandle | null>;
}) {
  const updateLanePresentation = useLaneContractStore((state) => state.updateLanePresentation);
  const [error, setError] = useState<string | null>(null);
  const { dataset } = lane;
  const commit = (patch: TrackPresentationPatch): UpdateLanePresentationResult => {
    const result = updateLanePresentation(bucket, dataset.trackId, patch);
    setError(result.status === 'updated' ? null : toUserMessage(result, 'sequence.failed'));
    return result;
  };
  const canSetColor =
    dataset.kind === 'pileup' ||
    TRACK_TYPE_REGISTRY.getTrackTypeDefinition(dataset.trackType)?.presentationControls
      ?.colorOverride === true;
  const isQuantitative = isQuantitativeDataset(dataset);
  const defaults = defaultTrackPresentationPatch(lane, canSetColor);
  const resetDisabled = presentationPatchMatchesDataset(dataset, defaults);

  return (
    <div
      data-testid={`track-settings-form-${dataset.trackId}`}
      className="flex min-w-0 flex-col gap-2.5 text-[10px] text-fg-muted"
    >
      <TrackLabelControl
        trackId={dataset.trackId}
        value={dataset.label}
        onCommit={(label) => commit({ label })}
      />
      {canSetColor && dataset.quantitativePresentation?.graph !== 'band' ? (
        <TrackColorControl
          trackId={dataset.trackId}
          label={dataset.label}
          value={dataset.color}
          onChange={(color) => commit({ color })}
          controlLabel={dataset.kind === 'pileup' ? 'Light' : 'Color'}
          lightModeOnly={dataset.kind === 'pileup'}
        />
      ) : null}
      <NumberSetting
        label="Track height"
        ariaLabel={`Track height for ${dataset.label}`}
        testId={`track-height-${dataset.trackId}`}
        value={dataset.trackPx}
        min={TRACK_HEIGHT_MIN_PX}
        max={TRACK_HEIGHT_MAX_PX}
        suffix="px"
        onCommit={(heightPx) => commit({ heightPx })}
      />
      {dataset.kind === 'pileup' ? (
        <>
          <NumberSetting
            label="Read row"
            ariaLabel={`Read row height for ${dataset.label}`}
            testId={`track-row-height-${dataset.trackId}`}
            value={dataset.laneHeightPx ?? 3}
            min={1}
            max={128}
            suffix="px"
            onCommit={(rowHeightPx) => commit({ rowHeightPx })}
          />
          <NumberSetting
            label="Max rows"
            ariaLabel={`Maximum read rows for ${dataset.label}`}
            testId={`track-max-rows-${dataset.trackId}`}
            value={dataset.maxLanes ?? 80}
            min={1}
            max={1000}
            onCommit={(maxRows) => commit({ maxRows })}
          />
          <CoverageCutoffControl
            trackId={dataset.trackId}
            label={dataset.label}
            value={dataset.coverageCutoffDepth ?? 0}
            onChange={(coverageCutoffDepth) => commit({ coverageCutoffDepth })}
            webglRef={webglRef}
          />
        </>
      ) : null}
      {isQuantitative ? <QuantitativeTrackSettings lane={lane} onCommit={commit} /> : null}
      {error ? (
        <div role="alert" className="rounded bg-danger/10 px-1.5 py-1 text-danger">
          {toUserMessage(error, 'sequence.failed')}
        </div>
      ) : null}
      <div className="border-t border-border/60 pt-2">
        <button
          type="button"
          onClick={() => commit(defaults)}
          disabled={resetDisabled}
          aria-label="Reset to defaults"
          title="Restore the default appearance and scale; keeps the track name and data"
          className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-bg text-[10px] font-medium text-fg-muted shadow-sm outline-none transition-colors hover:border-fg-subtle/60 hover:bg-bg-subtle hover:text-fg focus-visible:border-fg-subtle focus-visible:ring-1 focus-visible:ring-fg-subtle/20 disabled:cursor-default disabled:opacity-40"
        >
          <RefreshIcon size={12} />
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

function TrackLabelControl({
  trackId,
  value,
  onCommit,
}: {
  trackId: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  return (
    <label className={TRACK_SETTING_ROW_CLASS}>
      <span className="font-medium">Name</span>
      <input
        key={value}
        type="text"
        defaultValue={value}
        maxLength={200}
        aria-label={`Track name for ${value}`}
        data-testid={`track-label-${trackId}`}
        onBlur={(event) => {
          if (event.target.value !== value) onCommit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className={TRACK_SETTING_CONTROL_CLASS}
      />
    </label>
  );
}

function NumberSetting({
  label,
  ariaLabel,
  testId,
  value,
  min,
  max,
  step = 1,
  suffix,
  onCommit,
}: {
  label: string;
  ariaLabel: string;
  testId: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onCommit: (value: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const stepValue = (direction: -1 | 1) => {
    const draft = Number(inputRef.current?.value);
    const current = Number.isFinite(draft) ? draft : value;
    const decimalPlaces = Math.min(
      12,
      Math.max(decimalPlacesForStep(current), decimalPlacesForStep(step))
    );
    const next = Math.max(
      min,
      Math.min(max, Number((current + direction * step).toFixed(decimalPlaces)))
    );
    if (inputRef.current) inputRef.current.value = String(next);
    if (next !== value) onCommit(next);
  };
  const settingName = `${ariaLabel.charAt(0).toLowerCase()}${ariaLabel.slice(1)}`;

  return (
    <div className={TRACK_SETTING_ROW_CLASS}>
      <span className="font-medium">{label}</span>
      <span className="relative min-w-0">
        <input
          ref={inputRef}
          key={value}
          type="number"
          defaultValue={value}
          min={min}
          max={max}
          step={step}
          aria-label={ariaLabel}
          data-testid={testId}
          onBlur={(event) => {
            const next = Number(event.target.value);
            if (next !== value) onCommit(next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          className={`${TRACK_SETTING_CONTROL_CLASS} [appearance:textfield] text-right tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${suffix ? 'pr-12' : 'pr-7'}`}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-6 top-1/2 -translate-y-1/2 text-[9px] text-fg-subtle">
            {suffix}
          </span>
        ) : null}
        <span className="absolute bottom-px right-px top-px flex w-5 flex-col overflow-hidden rounded-r-[5px] border-l border-border/70 bg-bg-subtle/70">
          <NumberStepButton
            direction="up"
            label={`Increase ${settingName}`}
            disabled={value >= max}
            onStep={() => stepValue(1)}
          />
          <NumberStepButton
            direction="down"
            label={`Decrease ${settingName}`}
            disabled={value <= min}
            onStep={() => stepValue(-1)}
          />
        </span>
      </span>
    </div>
  );
}

function NumberStepButton({
  direction,
  label,
  disabled,
  onStep,
}: {
  direction: 'up' | 'down';
  label: string;
  disabled: boolean;
  onStep: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onStep}
      className={`flex min-h-0 flex-1 items-center justify-center text-fg-subtle outline-none transition-colors hover:bg-bg-muted hover:text-fg focus-visible:bg-bg-muted focus-visible:text-fg disabled:pointer-events-none disabled:opacity-25 ${
        direction === 'up' ? 'border-b border-border/60' : ''
      }`}
    >
      <svg aria-hidden viewBox="0 0 10 6" className="h-1.5 w-2.5" fill="none">
        <path
          d={direction === 'up' ? 'm1.5 4.5 3.5-3 3.5 3' : 'm1.5 1.5 3.5 3 3.5-3'}
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function decimalPlacesForStep(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = String(value).toLowerCase();
  if (!text.includes('e')) return text.split('.')[1]?.length ?? 0;
  const [coefficient, exponentText] = text.split('e');
  const exponent = Number(exponentText);
  const coefficientPlaces = coefficient?.split('.')[1]?.length ?? 0;
  return Math.max(0, coefficientPlaces - exponent);
}

function SelectSetting<T extends string>({
  label,
  value,
  ariaLabel,
  testId,
  options,
  onChange,
}: {
  label: string;
  value: T;
  ariaLabel: string;
  testId: string;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
}) {
  return (
    <label className={TRACK_SETTING_ROW_CLASS}>
      <span className="font-medium">{label}</span>
      <span className="relative min-w-0">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          aria-label={ariaLabel}
          data-testid={testId}
          className={`${TRACK_SETTING_CONTROL_CLASS} cursor-pointer appearance-none py-0 pl-2 pr-8`}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-subtle"
          fill="none"
        >
          <path
            d="m3 4.5 3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </label>
  );
}

function QuantitativeTrackSettings({
  lane,
  onCommit,
}: {
  lane: Lane;
  onCommit: (patch: TrackPresentationPatch) => UpdateLanePresentationResult;
}) {
  const { dataset } = lane;
  const presentation = normalizeQuantitativeTrackPresentation(
    dataset.quantitativePresentation ?? DEFAULT_QUANTITATIVE_TRACK_PRESENTATION
  );
  const summary = dataset.quantitativeSourceSummary;
  const signed = summary !== undefined && summary.fullMin < 0;
  const update = (next: QuantitativeTrackPresentationV1) => onCommit({ quantitative: next });
  const committedSmoothing = presentation.smoothingSigmaBins ?? 0;
  const [smoothingDraft, setSmoothingDraft] = useState(committedSmoothing);
  const lastCommittedSmoothingRef = useRef(committedSmoothing);
  useEffect(() => {
    setSmoothingDraft(committedSmoothing);
    lastCommittedSmoothingRef.current = committedSmoothing;
  }, [committedSmoothing, dataset.trackId]);
  const commitSmoothing = () => {
    if (smoothingDraft === lastCommittedSmoothingRef.current) return;
    lastCommittedSmoothingRef.current = smoothingDraft;
    update({ ...presentation, smoothingSigmaBins: smoothingDraft });
  };
  const updateScale = (scale: QuantitativeTrackPresentationV1['scale']) =>
    update({ ...presentation, scale });
  const fixedMin =
    presentation.scale.mode === 'fixed'
      ? (presentation.scale.min ?? 0)
      : Math.min(0, summary?.robustMin ?? 0);
  const candidateFixedMax =
    presentation.scale.mode === 'fixed'
      ? (presentation.scale.max ?? 1)
      : Math.max(0, summary?.robustMax ?? 1);
  const fixedMax = candidateFixedMax > fixedMin ? candidateFixedMax : fixedMin + 1;

  const selectMode = (mode: QuantitativeScaleMode) => {
    updateScale(
      mode === 'fixed'
        ? {
            mode,
            transform: presentation.scale.transform,
            min: fixedMin,
            max: fixedMax,
          }
        : { mode, transform: presentation.scale.transform }
    );
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-2 border-t border-border/60 pt-2.5">
      <legend className="mb-0.5 font-semibold text-fg">Signal</legend>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Draw as</span>
        <div
          role="group"
          aria-label={`Drawing style for ${dataset.label}`}
          className="flex overflow-hidden rounded-md border border-border"
        >
          {(['bar', 'band', 'points'] as const).map((graph) => {
            const name = graph === 'bar' ? 'Bars' : graph === 'band' ? 'Heatmap' : 'Points';
            return (
              <button
                key={graph}
                type="button"
                aria-label={`${name} for ${dataset.label}`}
                title={name}
                aria-pressed={presentation.graph === graph}
                onClick={() => update({ ...presentation, graph })}
                className="flex h-7 w-9 items-center justify-center border-l border-border text-fg-muted outline-none first:border-l-0 hover:bg-bg-muted aria-pressed:bg-fg/10 aria-pressed:text-fg focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg-subtle"
              >
                <svg aria-hidden viewBox="0 0 20 16" className="h-4 w-5" fill="currentColor">
                  {graph === 'bar' ? (
                    <path d="M2 9h3v5H2zm6-6h3v11H8zm6 3h3v8h-3z" />
                  ) : graph === 'band' ? (
                    <>
                      <path opacity=".3" d="M1 3h5v10H1z" />
                      <path opacity=".6" d="M7 3h5v10H7z" />
                      <path d="M13 3h6v10h-6z" />
                    </>
                  ) : (
                    <>
                      <circle cx="4" cy="11" r="2" />
                      <circle cx="10" cy="4" r="2" />
                      <circle cx="16" cy="8" r="2" />
                    </>
                  )}
                </svg>
              </button>
            );
          })}
        </div>
      </div>
      {presentation.graph === 'band' ? (
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Palette</span>
          <div className="flex gap-1.5">
            {Object.entries(SCIENTIFIC_COLOR_PALETTES).map(([key, palette]) => (
              <button
                key={key}
                type="button"
                aria-label={`${palette.name} palette for ${dataset.label}`}
                title={palette.name}
                aria-pressed={(presentation.palette ?? 'viridis') === key}
                onClick={() =>
                  update({
                    ...presentation,
                    palette: key as NonNullable<QuantitativeTrackPresentationV1['palette']>,
                  })
                }
                className="h-5 w-7 rounded border border-border outline-none ring-offset-1 ring-offset-bg aria-pressed:ring-1 aria-pressed:ring-fg focus-visible:ring-1 focus-visible:ring-fg"
                style={{ background: `linear-gradient(to right, ${palette.colors.join(', ')})` }}
              />
            ))}
          </div>
        </div>
      ) : null}
      <SelectSetting
        label="Range"
        value={presentation.scale.mode}
        onChange={selectMode}
        ariaLabel={`Signal range for ${dataset.label}`}
        testId={`quantitative-scale-mode-${dataset.trackId}`}
        options={[
          { value: 'robust-global', label: 'Stable whole track' },
          { value: 'full-global', label: 'Exact whole track' },
          { value: 'visible-window', label: 'Visible window' },
          { value: 'fixed', label: 'Fixed range' },
        ]}
      />
      <SelectSetting
        label="Transform"
        value={presentation.scale.transform}
        onChange={(transform) => updateScale({ ...presentation.scale, transform })}
        ariaLabel={`Signal transform for ${dataset.label}`}
        testId={`quantitative-scale-transform-${dataset.trackId}`}
        options={[
          { value: 'linear', label: 'Linear' },
          { value: 'log1p', label: 'Log (log1p)', disabled: signed || !summary },
        ]}
      />
      {dataset.trackType === BUILTIN_TRACK_TYPES.quantitative ? (
        <label
          className="flex min-w-0 flex-col gap-1"
          title="Gaussian standard deviation in source bins. Smoothing never crosses missing genomic regions."
        >
          <span className="flex items-center justify-between gap-2">
            <span className="font-medium">Gaussian smoothing</span>
            <output
              htmlFor={`quantitative-smoothing-${dataset.trackId}`}
              className="tabular-nums text-fg-subtle"
            >
              {smoothingDraft === 0
                ? 'Off'
                : `${smoothingDraft} ${smoothingDraft === 1 ? 'bin' : 'bins'}`}
            </output>
          </span>
          <input
            id={`quantitative-smoothing-${dataset.trackId}`}
            type="range"
            min={0}
            max={MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS}
            step={QUANTITATIVE_SMOOTHING_SIGMA_STEP_BINS}
            value={smoothingDraft}
            onChange={(event) => setSmoothingDraft(Number(event.target.value))}
            onPointerUp={commitSmoothing}
            onKeyUp={commitSmoothing}
            onBlur={commitSmoothing}
            aria-label={`Gaussian smoothing for ${dataset.label}`}
            aria-valuetext={
              smoothingDraft === 0
                ? 'Off'
                : `${smoothingDraft} ${smoothingDraft === 1 ? 'bin' : 'bins'}`
            }
            data-testid={`quantitative-smoothing-${dataset.trackId}`}
            className="h-4 w-full cursor-pointer accent-blue-500 outline-none focus-visible:ring-1 focus-visible:ring-fg-subtle/25"
          />
        </label>
      ) : null}
      {presentation.scale.mode === 'fixed' ? (
        <div className="flex flex-col gap-1">
          <NumberSetting
            label="Minimum"
            ariaLabel={`Fixed signal minimum for ${dataset.label}`}
            testId={`quantitative-fixed-min-${dataset.trackId}`}
            value={presentation.scale.min ?? fixedMin}
            min={-1_000_000_000}
            max={1_000_000_000}
            onCommit={(min) => updateScale({ ...presentation.scale, min })}
          />
          <NumberSetting
            label="Maximum"
            ariaLabel={`Fixed signal maximum for ${dataset.label}`}
            testId={`quantitative-fixed-max-${dataset.trackId}`}
            value={presentation.scale.max ?? fixedMax}
            min={-1_000_000_000}
            max={1_000_000_000}
            onCommit={(max) => updateScale({ ...presentation.scale, max })}
          />
        </div>
      ) : null}
      <label className="flex h-7 cursor-pointer items-center justify-between rounded-md px-0.5 outline-none">
        <span className="font-medium">
          {presentation.graph === 'band' ? 'Show color scale' : 'Show y-axis'}
        </span>
        <span className="relative inline-flex h-4 w-7 shrink-0">
          <input
            type="checkbox"
            checked={presentation.showRange}
            onChange={(event) => update({ ...presentation, showRange: event.target.checked })}
            aria-label={`Show ${presentation.graph === 'band' ? 'color scale' : 'y-axis'} for ${dataset.label}`}
            className="peer sr-only"
          />
          <span className="absolute inset-0 rounded-full border border-border bg-bg-muted transition-colors peer-checked:border-blue-500/70 peer-checked:bg-blue-500 peer-focus-visible:ring-1 peer-focus-visible:ring-fg-subtle/30" />
          <span className="absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-3" />
        </span>
      </label>
      {signed ? <div>Log is unavailable because this source contains negative values.</div> : null}
    </fieldset>
  );
}

function TrackColorControl({
  trackId,
  label,
  value,
  onChange,
  controlLabel = 'Color',
  lightModeOnly = false,
}: {
  trackId: string;
  label: string;
  value: number;
  onChange: (color: number) => void;
  controlLabel?: string;
  lightModeOnly?: boolean;
}) {
  const presentationEvents = usePresentationListener();

  const color = `#${Math.max(0, Math.min(0xff_ffff, Math.round(value)))
    .toString(16)
    .padStart(6, '0')}`;
  const colorLabel = lightModeOnly ? `Light read color for ${label}` : `Color for ${label}`;
  const hexLabel = lightModeOnly ? `Light read hex color for ${label}` : `Hex color for ${label}`;
  const pickerLabel = lightModeOnly
    ? `Light read color picker for ${label}`
    : `Color picker for ${label}`;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(color);
  const rootRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLButtonElement>(null);
  const pickerId = `track-color-picker-${trackId}`;
  const normalizedDraft = normalizeHexColor(draft);

  useEffect(() => {
    setDraft(color);
    setOpen(false);
  }, [color]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (commit: boolean) => {
      if (commit && normalizedDraft && normalizedDraft !== color) {
        onChange(Number.parseInt(normalizedDraft.slice(1), 16));
      }
      if (!commit) setDraft(color);
      setOpen(false);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      dismiss(true);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(false);
      safeFocus(controlRef.current);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    presentationEvents.add(window, 'keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      presentationEvents.remove(window, 'keydown', handleKeyDown, true);
    };
  }, [color, normalizedDraft, onChange, open, presentationEvents]);

  const commit = (next: string) => {
    const normalized = normalizeHexColor(next);
    if (!normalized) return;
    setDraft(normalized);
    if (normalized !== color) onChange(Number.parseInt(normalized.slice(1), 16));
    setOpen(false);
    safeFocus(controlRef.current);
  };

  return (
    <div ref={rootRef} className={TRACK_SETTING_ROW_CLASS}>
      <span className="font-medium">{controlLabel}</span>
      <button
        ref={controlRef}
        type="button"
        onClick={() => {
          setDraft(color);
          setOpen((current) => !current);
        }}
        aria-label={colorLabel}
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        data-color={color}
        data-testid={`track-color-control-${trackId}`}
        className="relative flex h-7 min-w-0 items-center gap-2 overflow-hidden rounded-md border border-border bg-bg px-2 text-left shadow-sm outline-none transition-[border-color,box-shadow,background-color] hover:border-fg-subtle/60 focus-visible:border-fg-subtle focus-visible:ring-1 focus-visible:ring-fg-subtle/20"
      >
        <span
          aria-hidden
          className="h-3.5 w-6 shrink-0 rounded-sm border border-black/10 shadow-inner"
          style={{ backgroundColor: color }}
        />
        <span aria-hidden className="truncate font-mono text-[10px] uppercase text-fg-muted">
          {color}
        </span>
      </button>
      {open ? (
        <div
          id={pickerId}
          role="dialog"
          aria-label={pickerLabel}
          className="col-span-2 mt-0.5 rounded-lg border border-border/80 bg-bg-subtle/90 p-2 shadow-inner"
        >
          <div className="grid grid-cols-6 gap-1.5" aria-label="Suggested track colors">
            {TRACK_COLOR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => commit(preset)}
                aria-label={`Use ${preset}`}
                aria-pressed={color === preset}
                className="h-5 rounded border border-black/10 shadow-sm outline-none transition-transform hover:scale-105 focus-visible:ring-1 focus-visible:ring-fg-subtle/40 aria-pressed:ring-2 aria-pressed:ring-blue-500/70"
                style={{ backgroundColor: preset }}
              />
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2">
            <span className="shrink-0 font-medium">Hex</span>
            <input
              autoFocus
              type="text"
              value={draft}
              maxLength={7}
              spellCheck={false}
              aria-label={hexLabel}
              aria-invalid={normalizedDraft === null}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !normalizedDraft) return;
                event.preventDefault();
                commit(normalizedDraft);
              }}
              className={`${TRACK_SETTING_CONTROL_CLASS} flex-1 font-mono uppercase aria-[invalid=true]:border-danger aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-danger/20`}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function normalizeHexColor(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : null;
}

function defaultTrackPresentationPatch(lane: Lane, canSetColor: boolean): TrackPresentationPatch {
  const { dataset } = lane;
  const definition = TRACK_TYPE_REGISTRY.getTrackTypeDefinition(dataset.trackType);
  const defaultHeight =
    dataset.kind === 'pileup'
      ? READ_PILEUP_DEFAULT_TRACK_HEIGHT_PX
      : definition?.defaultSizing.kind === 'fixed'
        ? definition.defaultSizing.pixels
        : dataset.trackType === BUILTIN_TRACK_TYPES.genericInterval
          ? trackHeightForAdmittedScientificKind('interval')
          : dataset.trackPx;
  return {
    ...(canSetColor
      ? {
          color:
            dataset.kind === 'pileup'
              ? TRACK_DEFAULT_COLORS.pileupLight
              : dataset.trackType === BUILTIN_TRACK_TYPES.peak
                ? TRACK_DEFAULT_COLORS.peak
                : TRACK_DEFAULT_COLORS.importedData,
        }
      : {}),
    heightPx: defaultHeight,
    ...(dataset.kind === 'pileup'
      ? {
          rowHeightPx: READ_PILEUP_DEFAULT_ROW_HEIGHT_PX,
          maxRows: READ_PILEUP_DEFAULT_MAX_ROWS,
          coverageCutoffDepth: 0,
        }
      : {}),
    ...(isQuantitativeDataset(dataset)
      ? { quantitative: DEFAULT_QUANTITATIVE_TRACK_PRESENTATION }
      : {}),
  };
}

function presentationPatchMatchesDataset(
  dataset: Lane['dataset'],
  patch: TrackPresentationPatch
): boolean {
  const next = applyTrackPresentationPatch(dataset, patch);
  const currentQuantitative = isQuantitativeDataset(dataset)
    ? normalizeQuantitativeTrackPresentation(dataset.quantitativePresentation)
    : undefined;
  const nextQuantitative = isQuantitativeDataset(next)
    ? normalizeQuantitativeTrackPresentation(next.quantitativePresentation)
    : undefined;
  return (
    next.color === dataset.color &&
    next.trackPx === dataset.trackPx &&
    next.laneHeightPx === dataset.laneHeightPx &&
    next.maxLanes === dataset.maxLanes &&
    next.coverageCutoffDepth === dataset.coverageCutoffDepth &&
    JSON.stringify(nextQuantitative) === JSON.stringify(currentQuantitative)
  );
}
