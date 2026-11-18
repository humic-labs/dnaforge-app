import {
  usePresentationOverlay,
  usePresentationScope,
  PresentationScopeContext,
  usePresentationListener,
} from '../../../presentation/PresentationSurface';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import {
  reconcileReferenceAnnotationTracks,
  restoredReferenceAnnotationVisibility,
} from '../reference-view-compatibility';
import { SavedTrackViews } from './SavedTrackViews';
import { Button, TextField, UI_MODAL_LAYER_CLASS } from '../../../components/ui';
import { INTERACTION_CLASS, MenuSearchInput } from '@waypoint/ui-components';
import { ReferenceSavedViewMenu } from './ReferenceSavedViewMenu';
import { projectSavedTrackView } from '../track-view-library';
import { assertTrackViewReference, openSavedTrackView } from '../open-track-view';
import { recoverScenarioTrackView } from '../recover-scenario-track-view';
import { validateTrackViewDocument, type SavedTrackView } from '../../../shared/track-view';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  REFERENCE_ASSEMBLY_CATALOG,
  buildGenomeAssembly,
  type ReferenceAssemblyEntry,
  formatLengthForPicker,
  referenceAssemblyLengthBp,
} from '../reference-catalog';
import { CloseIcon, ImportIcon, OpenExternalIcon } from '../../../components/icons';
import { platform } from '../../../platform';
import { openAssembly } from '../openAssembly';
import { useCanvasStore } from '../../canvas/public/store';
import { captureDocumentActivation } from '../../canvas/public/present-document';
import type { OpenAssemblyProgress } from '../openAssembly';
import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '@waypoint/genome-renderer/pure';
import type {
  HostedReferenceCatalogEntryV1,
  HubGenomeReferenceSourceV1,
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetHostedInstallProgressV1,
  ReferenceAssetPreparationProgressV1,
} from '../../../shared/reference-assets-ipc';
import { HubGenomeImportPanel } from './HubGenomeImportPanel';
import { chooseGenomeViewFile, readGenomeViewFile } from '../genome-view-file';
import {
  finishGenomeViewFileOpen,
  GENOME_VIEW_OPEN_REQUESTED,
  pendingGenomeViewFileOpen,
  startPendingGenomeViewFileOpen,
} from '../public/genome-view-open-request';
import { managedRestoredTracks, trackViewRecoveryDocument } from '../track-view-recovery-document';
import {
  restorePortableGenomeView,
  type RestoredPortableGenomeViewState,
} from '../portable-genome-view-adapter';
import {
  admitPortableTracks,
  planPortableTrackRestore,
  relinkPortableTrack,
  summarizePortableTrackOutcomes,
  type PortableLocatorRole,
  type PortableTrackResolution,
} from '../portable-genome-view-restore';
import type { PortableGenomeViewTrack } from '@waypoint/genome-data';
import type { GenomeSourceCredentialInput } from '../../../shared/genome-source-credentials';
import { useToastStore } from '../../../stores/toast-store';
import {
  PortableViewRecoveryPanel,
  credentialKindsForAuthRef,
  type PortableCredentialPrompt,
} from './PortableViewRecoveryPanel';
import {
  assertPreparedReferenceMatchesPortableView,
  assertReferenceSignatureMatchesPortableView,
  PortableReferenceMissingError,
  portableReferenceSignatureMatches,
  resolvePortableGenomeViewViewport,
  workspaceReferenceContentFingerprint,
  type PortableWorkspaceReference,
} from '../portable-genome-view-roundtrip';
import { PortableReferenceRecoveryPanel } from './PortableReferenceRecoveryPanel';

interface ReferenceGenomePickerProps {
  embedded?: boolean;
  backgroundFileOpen?: boolean;
  backgroundFileOpenRequestId?: number;
  open: boolean;
  onClose: () => void;
}

const RETIRED_REFERENCE_IDS = new Set(['puc19-l09137-2']);

function ReferenceOpenButton({
  name,
  onClick,
  disabled,
}: {
  name: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <span className="pointer-events-auto relative z-20 inline-flex">
      <Button type="button" aria-label={`Open ${name}`} onClick={onClick} disabled={disabled}>
        Open
      </Button>
    </span>
  );
}

function isSelectableWholeAssembly(
  entry: Pick<ReferenceAssemblyEntry, 'id' | 'assetCacheKey'>
): boolean {
  return entry.id === entry.assetCacheKey && !RETIRED_REFERENCE_IDS.has(entry.id);
}

function formatDownloadBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${formatCompactNumber(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${formatCompactNumber(bytes / 1_000_000)} MB`;
  return `${formatCompactNumber(bytes / 1_000_000_000)} GB`;
}

function formatGenomeLength(lengthBp: number): string {
  if (lengthBp >= 1_000_000_000) return `${formatCompactNumber(lengthBp / 1_000_000_000)} Gb`;
  if (lengthBp >= 1_000_000) return `${formatCompactNumber(lengthBp / 1_000_000)} Mb`;
  if (lengthBp >= 1_000) return `${formatCompactNumber(lengthBp / 1_000)} kb`;
  return `${lengthBp.toLocaleString('en-US')} bp`;
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

type ReferenceAvailability =
  | 'cached'
  | 'downloadable'
  | 'preparing'
  | 'stale'
  | 'failed'
  | 'opening';

type ReferenceRowStatus = 'idle' | 'opening' | 'downloading' | 'missing' | 'error' | 'open-error';
type ReferenceSortColumn =
  | 'reference'
  | 'assembly'
  | 'source-version'
  | 'genome-size'
  | 'availability';
type ReferenceSort = Readonly<{
  column: ReferenceSortColumn;
  direction: 'ascending' | 'descending';
}>;

function hostedAvailability(
  entry: HostedReferenceCatalogEntryV1,
  status: ReferenceRowStatus
): ReferenceAvailability {
  if (status === 'opening') return 'opening';
  if (status === 'downloading') return 'preparing';
  if (status === 'error' || entry.preparation?.status === 'failed') return 'failed';
  if (entry.preparation?.active || entry.preparation?.status === 'preparing') return 'preparing';
  if (
    entry.cacheStatus === 'stale' ||
    entry.cacheStatusReason === 'reference-definition-changed' ||
    entry.cacheStatusReason === 'local-files-invalid' ||
    entry.cacheStatusReason === 'prepared-files-incomplete'
  ) {
    return 'stale';
  }
  if (entry.cacheStatus === 'cached') return 'cached';
  return 'downloadable';
}

export function canOpenHostedReference(
  entry: HostedReferenceCatalogEntryV1,
  admittedIds: ReadonlySet<string>
): boolean {
  return (
    entry.currentVersionAvailable === true ||
    entry.cacheStatus === 'cached' ||
    entry.preparation?.status === 'annotation-ready' ||
    admittedIds.has(entry.id)
  );
}

function availabilityTextClasses(availability: ReferenceAvailability): string {
  switch (availability) {
    case 'cached':
      return 'text-green-600 dark:text-green-400';
    case 'downloadable':
      return 'text-fg-subtle';
    case 'preparing':
    case 'stale':
      return 'text-amber-600 dark:text-amber-400';
    case 'failed':
      return 'text-red-600 dark:text-red-400';
    case 'opening':
      return 'text-accent';
  }
}

function activeHostedPreparationLabel(phase: string | undefined): string {
  if (!phase) return 'Preparing for use';
  if (phase.includes('download') || phase.includes('transport')) return 'Downloading';
  if (
    phase.includes('verify') ||
    phase.includes('manifest') ||
    phase.includes('resolving') ||
    phase.includes('checking')
  ) {
    return 'Checking download';
  }
  if (phase.includes('search')) return 'Building search';
  if (phase.includes('visualization') || phase.includes('raster')) {
    return 'Building visualization';
  }
  if (phase.includes('queued')) return 'Download queued';
  return 'Preparing for use';
}

function hostedReadinessLabel(entry: HostedReferenceCatalogEntryV1, activePhase?: string): string {
  if (entry.currentVersionAvailable && entry.cacheStatus !== 'cached') return 'Updating';
  if (entry.preparation?.status === 'failed') return 'Setup failed';
  if (entry.preparation?.status === 'annotation-ready') return 'Finishing search';
  if (entry.preparation?.status === 'preparing') {
    return entry.preparation.active
      ? activeHostedPreparationLabel(activePhase ?? entry.preparation.phase)
      : 'Setup incomplete';
  }
  if (entry.cacheStatusReason === 'reference-definition-changed') return 'Updating';
  if (entry.cacheStatusReason === 'local-files-invalid' || entry.cacheStatus === 'stale') {
    return 'Checking readiness';
  }
  if (entry.cacheStatusReason === 'prepared-files-incomplete') return 'Setup incomplete';
  if (entry.cacheStatus === 'cached') return 'Ready';
  return 'Download';
}

function compareSortValues(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), 'en-US', {
    numeric: true,
    sensitivity: 'base',
  });
}

function SortableReferenceHeader({
  label,
  column,
  sort,
  onSort,
}: Readonly<{
  label: string;
  column: ReferenceSortColumn;
  sort: ReferenceSort | null;
  onSort: (column: ReferenceSortColumn) => void;
}>) {
  const active = sort?.column === column;
  return (
    <span role="columnheader" aria-sort={active ? sort.direction : 'none'}>
      <button
        type="button"
        aria-label={`Sort by ${label}`}
        className={`${INTERACTION_CLASS} inline-flex w-full items-center gap-1 text-left ${
          active ? 'font-bold text-accent' : ''
        }`}
        onClick={() => onSort(column)}
      >
        <span>{label}</span>
        <span
          aria-hidden="true"
          className="flex flex-shrink-0 flex-col items-center font-normal leading-none tracking-normal"
        >
          <span
            data-sort-arrow="ascending"
            className={`text-[8px] leading-[7px] ${
              active && sort.direction === 'ascending' ? 'text-accent' : 'text-fg-subtle/40'
            }`}
          >
            ▲
          </span>
          <span
            data-sort-arrow="descending"
            className={`text-[8px] leading-[7px] ${
              active && sort.direction === 'descending' ? 'text-accent' : 'text-fg-subtle/40'
            }`}
          >
            ▼
          </span>
        </span>
      </button>
    </span>
  );
}

function createReferenceOperationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `reference-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

interface PortableRecoverySession {
  readonly operationId: string;
  readonly name: string;
  readonly restored: RestoredPortableGenomeViewState;
  readonly managedView?: SavedTrackView;
  readonly prepared: PreparedReferenceAssemblyEntryV1;
  readonly tracks: ReadonlyArray<PortableGenomeViewTrack>;
  readonly resolutions: ReadonlyArray<PortableTrackResolution>;
  readonly skipped: ReadonlySet<string>;
  readonly relinked: ReadonlySet<string>;
  readonly acceptChangedData: boolean;
  readonly requireEveryTrack: boolean;
}

interface PortableReferenceRecoverySession {
  readonly operationId: string;
  readonly name: string;
  readonly restored: RestoredPortableGenomeViewState;
  readonly managedView?: SavedTrackView;
  readonly reference: PortableWorkspaceReference;
  readonly candidates: ReadonlyArray<PreparedReferenceAssemblyEntryV1>;
  readonly busy: boolean;
  readonly error: string | null;
}

async function preparedReferenceNote(
  tabId: string,
  reference: RestoredPortableGenomeViewState['reference'],
  entryName: string
): Promise<string | null> {
  if (reference.kind !== 'workspace-reference') return null;
  const opened = Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((tab) => tab.id === tabId)?.indexedGenome;
  try {
    const contentFingerprint = await workspaceReferenceContentFingerprint(
      (opened?.assembly?.chromosomes ?? []).map((chromosome) => chromosome.manifest?.faiPath)
    );
    return contentFingerprint === reference.contentFingerprint
      ? null
      : `Reference ${entryName} is a different prepared copy than the one this view was saved with; its chromosome table matches.`;
  } catch {
    return null;
  }
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

function restoredAnnotationTrackOrder(
  entry: PreparedReferenceAssemblyEntryV1,
  orderedTrackIds: ReadonlyArray<string>,
  visibilityByTrackId: Readonly<Record<string, boolean>>
): string[] {
  const requested = new Set([...orderedTrackIds, ...Object.keys(visibilityByTrackId)]);
  if (!entry.portableView) {
    return [
      ...orderedTrackIds,
      ...Object.keys(visibilityByTrackId).filter((trackId) => !orderedTrackIds.includes(trackId)),
    ];
  }
  const available = [...entry.portableView.trackTypes];
  const missing = [...requested].filter((trackId) => !available.includes(trackId));
  if (missing.length > 0) {
    throw new Error(
      `Hosted reference ${entry.name} no longer publishes saved annotation track${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`
    );
  }
  return [...orderedTrackIds, ...available.filter((trackId) => !requested.has(trackId))];
}

export function ReferenceGenomePicker({
  open,
  onClose,
  embedded = false,
  backgroundFileOpen = false,
  backgroundFileOpenRequestId,
}: ReferenceGenomePickerProps) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationParent = usePresentationScope();

  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<ReferenceSort | null>(null);
  const [statusByEntry, setStatusByEntry] = useState<Record<string, ReferenceRowStatus>>({});
  const [openErrorByEntry, setOpenErrorByEntry] = useState<Record<string, string>>({});
  const [assemblyProgressByEntry, setAssemblyProgressByEntry] = useState<
    Record<string, OpenAssemblyProgress>
  >({});
  const [localReferences, setLocalReferences] = useState<
    ReadonlyArray<PreparedReferenceAssemblyEntryV1>
  >([]);
  const [hostedReferences, setHostedReferences] = useState<
    ReadonlyArray<HostedReferenceCatalogEntryV1>
  >([]);
  const [hostedProgressByEntry, setHostedProgressByEntry] = useState<
    Record<string, ReferenceAssetHostedInstallProgressV1>
  >({});
  const [admittedHostedIds, setAdmittedHostedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [importState, setImportState] = useState<'idle' | 'preparing' | 'success' | 'error'>(
    'idle'
  );
  const [importModalOpen, setImportModalOpen] = useState(false);
  const presentationEvents = usePresentationListener(
    importModalOpen ? presentationOverlay.scope : presentationParent
  );
  const [importedReference, setImportedReference] =
    useState<PreparedReferenceAssemblyEntryV1 | null>(null);
  const [importProgress, setImportProgress] = useState<ReferenceAssetPreparationProgressV1 | null>(
    null
  );
  const [importRecognizedLabel, setImportRecognizedLabel] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [ncbiAssemblyLink, setNcbiAssemblyLink] = useState('');
  const [customReferenceJobs, setCustomReferenceJobs] = useState<
    ReadonlyArray<{
      operationId: string;
      title: string;
      label: string;
      phase: 'running' | 'error';
    }>
  >([]);
  const [activeImportOperationId, setActiveImportOperationId] = useState<string | null>(null);
  const [portableViewState, setPortableViewState] = useState<'idle' | 'opening' | 'recovering'>(
    'idle'
  );
  const [expandedReferenceId, setExpandedReferenceId] = useState<string | null>(null);
  const [portableRecovery, setPortableRecovery] = useState<PortableRecoverySession | null>(null);
  const [portableReferenceRecovery, setPortableReferenceRecovery] =
    useState<PortableReferenceRecoverySession | null>(null);
  const portableReferenceRecoveryRef = useRef<PortableReferenceRecoverySession | null>(null);
  portableReferenceRecoveryRef.current = portableReferenceRecovery;
  const [portableCredentialPrompt, setPortableCredentialPrompt] =
    useState<PortableCredentialPrompt | null>(null);
  const portableRecoveryRef = useRef<PortableRecoverySession | null>(null);
  portableRecoveryRef.current = portableRecovery;
  const [portableViewCommitInProgress, setPortableViewCommitInProgress] = useState(false);
  const [portableViewError, setPortableViewError] = useState<string | null>(null);
  const activeImportOperationIdRef = useRef<string | null>(null);
  const customReferenceJobIdsRef = useRef(new Set<string>());
  const portableViewOpenInFlightRef = useRef(false);
  const portableViewOperationIdRef = useRef<string | null>(null);
  const portableViewActivationRef = useRef<ReturnType<typeof captureDocumentActivation> | null>(
    null
  );
  const openLifecycleGenerationRef = useRef(0);
  const isCurrentPortableViewOperation = useCallback(
    (operationId: string) =>
      portableViewOperationIdRef.current === operationId &&
      (!backgroundFileOpen || pendingGenomeViewFileOpen()?.id === backgroundFileOpenRequestId),
    [backgroundFileOpen, backgroundFileOpenRequestId]
  );
  const portableViewCommitInProgressRef = useRef(false);
  const finishBackgroundFileOpen = useCallback(
    (tabId: string | null) => {
      if (backgroundFileOpenRequestId !== undefined) {
        finishGenomeViewFileOpen(tabId, backgroundFileOpenRequestId);
      }
    },
    [backgroundFileOpenRequestId]
  );
  const closePicker = useCallback(() => {
    if (portableViewCommitInProgressRef.current) return;
    activeImportOperationIdRef.current = null;
    portableViewOperationIdRef.current = null;
    portableViewActivationRef.current?.dispose();
    portableViewActivationRef.current = null;
    portableViewOpenInFlightRef.current = false;
    finishBackgroundFileOpen(null);
    onClose();
  }, [finishBackgroundFileOpen, onClose]);
  const completePortableViewOpen = useCallback(() => {
    portableViewCommitInProgressRef.current = false;
    setPortableViewCommitInProgress(false);
    setPortableViewState('idle');
    activeImportOperationIdRef.current = null;
    portableViewOperationIdRef.current = null;
    portableViewOpenInFlightRef.current = false;
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const generation = ++openLifecycleGenerationRef.current;
    let cancelled = false;
    void platform()
      .referenceAssets.listLocal()
      .then((entries) => {
        if (!cancelled) {
          setLocalReferences(entries.filter(isSelectableWholeAssembly));
        }
      })
      .catch(() => {
        if (!cancelled) setLocalReferences([]);
      });
    let hostedRefreshRevision = 0;
    const refreshHosted = () => {
      const revision = ++hostedRefreshRevision;
      void platform()
        .referenceAssets.listHosted()
        .then(
          (entries) => {
            if (!cancelled && revision === hostedRefreshRevision) {
              setHostedReferences(entries.filter((entry) => !RETIRED_REFERENCE_IDS.has(entry.id)));
            }
          },
          () => {}
        );
    };
    refreshHosted();
    const unsubscribe = platform().referenceAssets.onPreparationProgress((progress) => {
      if (cancelled) return;
      if (customReferenceJobIdsRef.current.has(progress.operationId)) {
        setCustomReferenceJobs((current) =>
          current.map((job) =>
            job.operationId === progress.operationId
              ? {
                  ...job,
                  phase: progress.phase === 'background-preparation-failed' ? 'error' : 'running',
                  label:
                    progress.phase === 'background-preparation-failed'
                      ? toUserMessage(progress.label, 'tracks.loadFailed')
                      : progress.label,
                }
              : job
          )
        );
        return;
      }
      if (progress.operationId !== activeImportOperationIdRef.current) return;
      if (progress.phase === 'ready') {
        setImportState('idle');
        setImportProgress(null);
        setImportRecognizedLabel(null);
        setImportError(null);
        return;
      }
      if (progress.phase === 'background-preparation-failed') {
        setImportState('error');
        setImportProgress(null);
        setImportRecognizedLabel(null);
        setImportError(toUserMessage(progress.label, 'tracks.loadFailed'));
        return;
      }
      if (progress.phase === 'source-recognized') {
        setImportRecognizedLabel(progress.label);
      }
      setImportState('preparing');
      setImportProgress(progress);
    });
    const unsubscribeHosted = platform().referenceAssets.onHostedInstallProgress((progress) => {
      if (!cancelled) {
        setHostedProgressByEntry((current) => ({
          ...current,
          [progress.catalogId]: progress,
        }));
        if (
          [
            'cache-reconcile-checking',
            'queued-hosted-reference',
            'resolving-hosted-reference',
            'detail-ready',
            'ready',
            'cache-reconcile-ready',
            'background-preparation-failed',
          ].includes(progress.phase)
        ) {
          refreshHosted();
        }
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeHosted();
      queueMicrotask(() => {
        if (openLifecycleGenerationRef.current !== generation) return;
        activeImportOperationIdRef.current = null;
        portableViewOperationIdRef.current = null;
        portableViewActivationRef.current?.dispose();
        portableViewActivationRef.current = null;
        portableViewOpenInFlightRef.current = false;
        if (backgroundFileOpen) finishBackgroundFileOpen(null);
      });
    };
  }, [backgroundFileOpen, finishBackgroundFileOpen, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (importModalOpen) {
        if (activeImportOperationIdRef.current !== null) return;
        setImportModalOpen(false);
        setImportState('idle');
        setImportProgress(null);
        setImportRecognizedLabel(null);
        setImportError(null);
        setImportedReference(null);
        return;
      }
      if (!embedded) closePicker();
    };
    presentationEvents.add(window, 'keydown', onKeyDown);
    return () => presentationEvents.remove(window, 'keydown', onKeyDown);
  }, [closePicker, importModalOpen, open, embedded, presentationEvents]);

  useEffect(() => {
    if (open) {
      setFilter('');
      return;
    }
    activeImportOperationIdRef.current = null;
    portableViewOperationIdRef.current = null;
    portableViewActivationRef.current?.dispose();
    portableViewActivationRef.current = null;
    portableViewOpenInFlightRef.current = false;
    portableViewCommitInProgressRef.current = false;
    setActiveImportOperationId(null);
    setImportModalOpen(false);
    setImportState('idle');
    setImportProgress(null);
    setImportRecognizedLabel(null);
    setImportError(null);
    setImportedReference(null);
    setPortableViewState('idle');
    setPortableViewCommitInProgress(false);
    setPortableViewError(null);
  }, [open]);

  const handleOpenAssembly = useCallback(
    async (entry: ReferenceAssemblyEntry) => {
      setStatusByEntry((s) => ({ ...s, [entry.id]: 'opening' }));
      setOpenErrorByEntry((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
      try {
        const tabId = await openAssembly(entry, {
          annotationThemeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
          onProgress: (progress) => {
            setAssemblyProgressByEntry((current) => ({
              ...current,
              [entry.id]: progress,
            }));
          },
        });
        if (tabId) {
          setStatusByEntry((s) => ({ ...s, [entry.id]: 'idle' }));
          setAssemblyProgressByEntry((current) => {
            const next = { ...current };
            delete next[entry.id];
            return next;
          });
          closePicker();
        } else {
          setStatusByEntry((s) => ({ ...s, [entry.id]: 'error' }));
          setOpenErrorByEntry((current) => ({
            ...current,
            [entry.id]:
              'The prepared reference is unavailable. Add it again from its original folder or package.',
          }));
        }
      } catch (error) {
        setStatusByEntry((s) => ({ ...s, [entry.id]: 'error' }));
        setOpenErrorByEntry((current) => ({
          ...current,
          [entry.id]:
            error instanceof Error
              ? error.message
              : 'The prepared reference could not be opened. Add it again from its original source.',
        }));
      }
    },
    [closePicker]
  );

  const beginImportOperation = useCallback((preparing = true): string => {
    const operationId = createReferenceOperationId();
    activeImportOperationIdRef.current = operationId;
    setActiveImportOperationId(operationId);
    if (preparing) setImportState('preparing');
    setImportProgress(null);
    setImportRecognizedLabel(null);
    setImportError(null);
    setImportedReference(null);
    return operationId;
  }, []);

  const settleImportedReference = useCallback(
    async (operationId: string, entry: PreparedReferenceAssemblyEntryV1) => {
      setLocalReferences((current) => [entry, ...current.filter((item) => item.id !== entry.id)]);
      setImportedReference(entry);
      setImportState('success');
      setImportProgress(null);
      setImportRecognizedLabel(null);
      const tabId = await openAssembly(entry, {
        annotationThemeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
        onProgress: (progress) => {
          setAssemblyProgressByEntry((current) => ({
            ...current,
            [entry.id]: progress,
          }));
        },
      });
      if (activeImportOperationIdRef.current !== operationId) return;
      if (tabId) {
        activeImportOperationIdRef.current = null;
        setActiveImportOperationId(null);
        setImportState('idle');
        setImportProgress(null);
        setImportRecognizedLabel(null);
        setImportedReference(null);
        setImportModalOpen(false);
        closePicker();
      } else {
        activeImportOperationIdRef.current = null;
        setActiveImportOperationId(null);
        setImportState('error');
        setImportError(userMessage('reference.preparedOpenFailed'));
      }
    },
    [closePicker]
  );

  const failImportOperation = useCallback(
    (operationId: string, error: unknown, _fallback: string) => {
      if (activeImportOperationIdRef.current !== operationId) return;
      activeImportOperationIdRef.current = null;
      setActiveImportOperationId(null);
      setImportState('error');
      setImportError(toUserMessage(error, 'tracks.loadFailed'));
    },
    []
  );

  const handleImportCustom = useCallback(
    async (sourcePath?: string) => {
      const operationId = beginImportOperation(Boolean(sourcePath));
      try {
        const result = await platform().referenceAssets.importLocal({
          operationId,
          themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
          ...(sourcePath ? { sourcePath } : {}),
        });
        if (activeImportOperationIdRef.current !== operationId) return;
        if (result.status !== 'ready') {
          activeImportOperationIdRef.current = null;
          setActiveImportOperationId(null);
          setImportState('idle');
          setImportProgress(null);
          setImportRecognizedLabel(null);
          setImportError(null);
          return;
        }
        await settleImportedReference(operationId, result.entry);
      } catch (error) {
        failImportOperation(operationId, error, 'Could not import this reference.');
      }
    },
    [beginImportOperation, failImportOperation, settleImportedReference]
  );

  const handleImportHubGenome = useCallback(
    async (source: HubGenomeReferenceSourceV1) => {
      const operationId = beginImportOperation();
      try {
        const result = await platform().referenceAssets.importHubGenome({
          operationId,
          themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
          ...source,
        });
        if (activeImportOperationIdRef.current !== operationId) return;
        await settleImportedReference(operationId, result.entry);
      } catch (error) {
        failImportOperation(operationId, error, `Could not add ${source.genome} from its hub.`);
      }
    },
    [beginImportOperation, failImportOperation, settleImportedReference]
  );

  const handleImportNcbiAssemblyLink = useCallback(async () => {
    const assemblyLink = ncbiAssemblyLink.trim();
    if (!assemblyLink) {
      setImportState('error');
      setImportError(userMessage('reference.assemblyInput'));
      return;
    }
    const operationId = createReferenceOperationId();
    const accession = assemblyLink.match(/GC[AF]_[0-9]+\.[0-9]+/)?.[0];
    const hostedAlready = accession
      ? hostedReferences.find((entry) => entry.sourceUrl?.includes(`/${accession}`))
      : undefined;
    if (hostedAlready) {
      setNcbiAssemblyLink('');
      setImportModalOpen(false);
      setFilter('');
      setExpandedReferenceId(hostedAlready.id);
      return;
    }
    const existingLocal = accession
      ? localReferences.find((entry) => entry.assembly === accession || entry.name === accession)
      : undefined;
    if (existingLocal) {
      setNcbiAssemblyLink('');
      setImportModalOpen(false);
      setExpandedReferenceId(existingLocal.id);
      return;
    }
    customReferenceJobIdsRef.current.add(operationId);
    setCustomReferenceJobs((current) => [
      {
        operationId,
        title: accession ?? assemblyLink,
        label: 'Checking the library',
        phase: 'running',
      },
      ...current,
    ]);
    setNcbiAssemblyLink('');
    setImportModalOpen(false);
    setImportState('idle');
    setImportProgress(null);
    setImportRecognizedLabel(null);
    setImportError(null);
    setImportedReference(null);
    try {
      const result = await platform().referenceAssets.importLocal({
        operationId,
        themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
        assemblyLink,
      });
      customReferenceJobIdsRef.current.delete(operationId);
      if (result.status === 'hosted') {
        setCustomReferenceJobs((current) =>
          current.filter((job) => job.operationId !== operationId)
        );
        setExpandedReferenceId(result.catalogId);
        setFilter('');
        return;
      }
      if (result.status === 'cancelled') {
        setCustomReferenceJobs((current) =>
          current.filter((job) => job.operationId !== operationId)
        );
        return;
      }
      setLocalReferences((current) => [
        result.entry,
        ...current.filter((entry) => entry.id !== result.entry.id),
      ]);
      setCustomReferenceJobs((current) => current.filter((job) => job.operationId !== operationId));
    } catch (error) {
      customReferenceJobIdsRef.current.delete(operationId);
      const message = error instanceof Error ? error.message : 'Could not import this reference.';
      setCustomReferenceJobs((current) =>
        current.map((job) =>
          job.operationId === operationId
            ? { ...job, phase: 'error', label: toUserMessage(message, 'tracks.loadFailed') }
            : job
        )
      );
    }
  }, [hostedReferences, localReferences, ncbiAssemblyLink]);

  const closeImportModal = useCallback(() => {
    if (activeImportOperationIdRef.current !== null) return;
    setImportModalOpen(false);
    setImportState('idle');
    setImportProgress(null);
    setImportRecognizedLabel(null);
    setImportError(null);
    setImportedReference(null);
    setNcbiAssemblyLink('');
  }, []);

  const handleImportDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (activeImportOperationIdRef.current !== null) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length !== 1) {
        setImportState('error');
        setImportError(userMessage('reference.dropInput'));
        return;
      }
      const sourcePath = platform().workspace.getPathForFile(files[0]);
      if (!sourcePath) {
        setImportState('error');
        setImportError(userMessage('reference.dropUnavailable'));
        return;
      }
      void handleImportCustom(sourcePath);
    },
    [handleImportCustom]
  );

  const handleDownloadHosted = useCallback(async (hosted: HostedReferenceCatalogEntryV1) => {
    setStatusByEntry((current) => ({ ...current, [hosted.id]: 'downloading' }));
    try {
      const result = await platform().referenceAssets.installHosted({
        catalogId: hosted.id,
        themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
        intent: 'open-view',
      });
      const prepared = result.entry;
      setLocalReferences((current) => [
        prepared,
        ...current.filter((entry) => entry.id !== prepared.id),
      ]);
      setAdmittedHostedIds((current) => {
        const next = new Set(current);
        next.add(hosted.id);
        return next;
      });
      const refreshed = await platform()
        .referenceAssets.listHosted()
        .catch(() => null);
      if (refreshed) {
        setHostedReferences(refreshed.filter((entry) => !RETIRED_REFERENCE_IDS.has(entry.id)));
      }
      setStatusByEntry((current) => ({ ...current, [hosted.id]: 'idle' }));
      setHostedProgressByEntry((current) => {
        const next = { ...current };
        delete next[hosted.id];
        return next;
      });
    } catch {
      setStatusByEntry((current) => ({ ...current, [hosted.id]: 'error' }));
    }
  }, []);
  const handleOpenHosted = useCallback(
    async (hosted: HostedReferenceCatalogEntryV1) => {
      if (!canOpenHostedReference(hosted, admittedHostedIds)) return;
      setStatusByEntry((current) => ({ ...current, [hosted.id]: 'opening' }));
      let failureStage: 'acquisition' | 'opening' = 'acquisition';
      try {
        const result = await platform().referenceAssets.installHosted({
          catalogId: hosted.id,
          themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
          intent: 'open-view',
        });
        const prepared = result.entry;
        failureStage = 'opening';
        setLocalReferences((current) => [
          prepared,
          ...current.filter((entry) => entry.id !== prepared.id),
        ]);
        const tabId = await openAssembly(prepared, {
          annotationThemeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
          onProgress: (progress) => {
            setAssemblyProgressByEntry((current) => ({
              ...current,
              [hosted.id]: progress,
            }));
          },
        });
        if (tabId) {
          setStatusByEntry((current) => ({ ...current, [hosted.id]: 'idle' }));
          setHostedProgressByEntry((current) => {
            const next = { ...current };
            delete next[hosted.id];
            return next;
          });
          setAssemblyProgressByEntry((current) => {
            const next = { ...current };
            delete next[hosted.id];
            return next;
          });
          closePicker();
        } else {
          setStatusByEntry((current) => ({ ...current, [hosted.id]: 'open-error' }));
        }
      } catch {
        setStatusByEntry((current) => ({
          ...current,
          [hosted.id]: failureStage === 'opening' ? 'open-error' : 'error',
        }));
      }
    },
    [admittedHostedIds, closePicker]
  );

  const resolvePortableReference = useCallback(
    async (
      reference: RestoredPortableGenomeViewState['reference'],
      managedView?: SavedTrackView
    ): Promise<PreparedReferenceAssemblyEntryV1> => {
      if (reference.kind === 'hosted-reference') {
        const hosted = (await platform().referenceAssets.listHosted()).find(
          (entry) => entry.id === reference.catalogId
        );
        if (!hosted) {
          const local = (await platform().referenceAssets.listLocal()).find(
            (entry) => entry.id === reference.catalogId
          );
          if (!local) {
            throw new Error(
              `Saved view reference ${reference.catalogId} is not available in this library.`
            );
          }
          if (!managedView || local.portableView) {
            assertPreparedReferenceMatchesPortableView(local, reference);
          }
          return local;
        }
        let installed = await platform().referenceAssets.installHosted({
          catalogId: reference.catalogId,
          themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
          intent: 'open-view',
        });
        if (!Object.keys(installed.entry.portableView?.assetGenerationsByTheme ?? {}).length) {
          installed = await platform().referenceAssets.installHosted({
            catalogId: reference.catalogId,
            themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
            intent: 'require-ready',
          });
        }
        assertPreparedReferenceMatchesPortableView(installed.entry, reference);
        return installed.entry;
      }
      const library = await platform().referenceAssets.listLocal();
      const local = library.find(
        (entry) => entry.id === reference.entityId || entry.id === reference.assemblyId
      );
      if (!local) {
        const candidates: PreparedReferenceAssemblyEntryV1[] = [];
        for (const entry of library.filter(isSelectableWholeAssembly)) {
          const chromosomes = buildGenomeAssembly(
            entry,
            (relativePath) => relativePath
          ).chromosomes;
          if (
            await portableReferenceSignatureMatches(
              chromosomes.map((chromosome) => ({
                name: chromosome.chrom,
                length: chromosome.length,
              })),
              reference
            )
          ) {
            candidates.push(entry);
          }
        }
        throw new PortableReferenceMissingError(reference, candidates);
      }
      const assembly = buildGenomeAssembly(local, (relativePath) => relativePath);
      await assertReferenceSignatureMatchesPortableView(
        local.name,
        assembly.chromosomes.map((chromosome) => ({
          name: chromosome.chrom,
          length: chromosome.length,
        })),
        reference
      );
      return local;
    },
    []
  );

  const openRestoredPortableView = useCallback(
    async (session: PortableRecoverySession) => {
      const { operationId, restored, prepared, managedView } = session;
      const useManagedReferenceAdmission =
        managedView && restored.reference.kind === 'hosted-reference' && !prepared.portableView;
      const assembly = buildGenomeAssembly(prepared, (relativePath) => relativePath);
      const reboundReference =
        managedView &&
        restored.reference.kind === 'workspace-reference' &&
        managedView.document.reference.assemblyId !== assembly.assemblyId;
      const validationDocument =
        reboundReference && managedView
          ? {
              ...managedView.document,
              reference: {
                ...managedView.document.reference,
                assemblyId: assembly.assemblyId,
              },
            }
          : managedView?.document;
      const restoredViewport = resolvePortableGenomeViewViewport(
        restored.indexedGenomeView.viewport,
        assembly
      );
      const assemblyReferences = assembly.chromosomes.map((chromosome) => ({
        name: chromosome.chrom,
        length: chromosome.length,
      }));
      const compatibility =
        restored.reference.kind === 'hosted-reference' && !useManagedReferenceAdmission
          ? assertPreparedReferenceMatchesPortableView(prepared, restored.reference)
          : { annotationsUpdated: false };
      const annotation =
        compatibility.annotationsUpdated && prepared.portableView
          ? {
              ...restored.annotation,
              ...reconcileReferenceAnnotationTracks(
                restored.annotation,
                prepared.portableView.trackTypes
              ),
            }
          : restored.annotation;
      const annotationTrackTypes = restoredAnnotationTrackOrder(
        prepared,
        annotation.orderedTrackIds,
        annotation.visibilityByTrackId
      );
      const admitted = await admitPortableTracks({
        tracks: session.tracks,
        relinkedTrackIds: session.relinked,
        skippedTrackIds: session.skipped,
        acceptChangedData: session.acceptChangedData,
        assemblyId: assembly.assemblyId,
        assemblyDisplayName: prepared.name,
        assemblyReferences,
      });
      if (!isCurrentPortableViewOperation(operationId)) return;
      const report = summarizePortableTrackOutcomes(admitted.outcomes);
      const unrestored = admitted.outcomes.filter(
        (outcome) =>
          outcome.status === 'failed' ||
          (outcome.status === 'skipped' && !session.skipped.has(outcome.trackId))
      );
      if (unrestored.length > 0 && session.requireEveryTrack) {
        throw new Error(
          `${report} ${unrestored
            .map((outcome) => outcome.message ?? `${outcome.label} was not restored.`)
            .join(' ')} Nothing was opened.`
        );
      }
      const managedTracks = managedView
        ? managedRestoredTracks(managedView.document, admitted, { assemblyId: assembly.assemblyId })
        : null;
      const restoredTracks = managedTracks ?? admitted;
      portableViewCommitInProgressRef.current = true;
      setPortableViewCommitInProgress(true);
      const visibleAnnotationTrackIds = restoredReferenceAnnotationVisibility(
        annotation.visibilityByTrackId,
        annotationTrackTypes
      );
      const restoreCommand = {
        id: createReferenceOperationId(),
        viewport: { ...restored.indexedGenomeView.viewport },
        annotationPolicy: { ...restored.annotation.policy },
        visibleAnnotationTrackIds,
        orderedAnnotationTrackIds: [...annotation.orderedTrackIds],
      };
      const placementOptions = {
        ...(backgroundFileOpen && pendingGenomeViewFileOpen()?.tabId
          ? { intoTabId: pendingGenomeViewFileOpen()!.tabId }
          : {}),
        ...(pendingGenomeViewFileOpen()?.placement
          ? { placement: pendingGenomeViewFileOpen()!.placement }
          : {}),
        commitGuard: () => isCurrentPortableViewOperation(operationId),
      };
      const tabId = useManagedReferenceAdmission
        ? await openSavedTrackView(
            {
              ...managedView,
              document: validateTrackViewDocument({
                ...managedView.document,
                ...managedTracks,
                dataTracks: [...restoredTracks.dataTracks],
                bamTracks: [...restoredTracks.bamTracks],
              }),
            },
            placementOptions
          )
        : await openAssembly(prepared, {
            ...placementOptions,
            ...(managedView
              ? {
                  viewEntity: {
                    id: managedView.document.id,
                    name: managedView.document.name,
                  },
                  validateReference: (state: Parameters<typeof assertTrackViewReference>[1]) =>
                    assertTrackViewReference(validationDocument!, state),
                }
              : {}),
            initialAnnotationMapperPolicy: { ...restored.annotation.policy },
            annotationThemeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
            restoreView: {
              scope: managedView?.document.scope ?? restoredViewport.scope,
              dataTracks: restoredTracks.dataTracks,
              bamTracks: [...restoredTracks.bamTracks],
              ...(managedTracks
                ? {
                    sequenceDataLayers: managedTracks.sequenceDataLayers,
                    contactProjection: managedTracks.contactProjection,
                    comparisonProjection: managedTracks.comparisonProjection,
                    signalReadPileupViews: managedTracks.signalReadPileupViews,
                    primerBindings: managedTracks.primerBindings,
                    userAnnotations: managedTracks.userAnnotations,
                  }
                : {}),
              ...(restoredTracks.variantSource
                ? { variantSource: restoredTracks.variantSource }
                : {}),
              annotationTrackTypes,
              indexedViewport: {
                start0: restoredViewport.globalStart0,
                end0: restoredViewport.globalEnd0,
              },
              command: restoreCommand,
            },
          });
      if (!isCurrentPortableViewOperation(operationId)) return;
      if (!tabId) {
        throw new Error(`Reference ${prepared.name} was admitted but could not be opened.`);
      }
      if (managedView) {
        const changedSource =
          reboundReference || admitted.outcomes.some((outcome) => outcome.status !== 'restored');
        for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
          if (panel.tabs.some((tab) => tab.id === tabId)) {
            useCanvasStore.getState().updateTab(panelId, tabId, {
              trackView: managedView,
              isDirty: changedSource,
            });
            break;
          }
        }
        await projectSavedTrackView(managedView).catch(() => undefined);
      }
      if (compatibility.annotationsUpdated && prepared.portableView) {
        const notice = reconcileReferenceAnnotationTracks(
          restored.annotation,
          prepared.portableView.trackTypes
        ).notice;
        for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
          const opened = panel.tabs.find((candidate) => candidate.id === tabId);
          if (opened?.indexedGenome)
            useCanvasStore.getState().updateTab(panelId, tabId, {
              indexedGenome: { ...opened.indexedGenome, referenceAnnotationUpdateNotice: notice },
            });
        }
      }
      const referenceNote = await preparedReferenceNote(tabId, restored.reference, prepared.name);
      if (!isCurrentPortableViewOperation(operationId)) return;
      if (unrestored.length > 0 || referenceNote) {
        useToastStore.getState().addToast(userMessage('reference.openedWithWarnings'), {
          definition: 'reference-view-open-attention',
          variant: unrestored.length > 0 ? 'error' : 'warning',
        });
      }
      finishBackgroundFileOpen(tabId);
      completePortableViewOpen();
    },
    [
      backgroundFileOpen,
      completePortableViewOpen,
      finishBackgroundFileOpen,
      isCurrentPortableViewOperation,
    ]
  );

  const continuePortableViewOpen = useCallback(
    async (
      operationId: string,
      name: string,
      restored: RestoredPortableGenomeViewState,
      prepared: PreparedReferenceAssemblyEntryV1,
      managedView?: SavedTrackView
    ): Promise<'opened' | 'recovering' | 'superseded'> => {
      const resolutions = await planPortableTrackRestore(restored.tracks);
      if (!isCurrentPortableViewOperation(operationId)) return 'superseded';
      const session: PortableRecoverySession = {
        operationId,
        name,
        restored,
        ...(managedView ? { managedView } : {}),
        prepared,
        tracks: restored.tracks,
        resolutions,
        skipped: new Set(),
        relinked: new Set(),
        acceptChangedData: false,
        requireEveryTrack: true,
      };
      if (resolutions.every((resolution) => resolution.status === 'ready')) {
        await openRestoredPortableView(session);
        return 'opened';
      }
      setPortableRecovery(session);
      setPortableViewState('recovering');
      return 'recovering';
    },
    [isCurrentPortableViewOperation, openRestoredPortableView]
  );

  const resetPortableViewOperation = useCallback(() => {
    portableViewCommitInProgressRef.current = false;
    setPortableViewCommitInProgress(false);
    portableViewOperationIdRef.current = null;
    portableViewOpenInFlightRef.current = false;
    setPortableViewState('idle');
  }, []);

  const handleOpenPortableView = useCallback(
    async (path?: string) => {
      if (portableViewOpenInFlightRef.current) return;
      const operationId = createReferenceOperationId();
      portableViewOpenInFlightRef.current = true;
      portableViewOperationIdRef.current = operationId;
      const activation = captureDocumentActivation();
      portableViewActivationRef.current = activation;
      setPortableViewState('opening');
      setPortableViewError(null);
      setPortableRecovery(null);
      setPortableReferenceRecovery(null);
      setPortableCredentialPrompt(null);
      let awaitingRecovery = false;
      try {
        const selected = path ? await readGenomeViewFile(path) : await chooseGenomeViewFile();
        if (!isCurrentPortableViewOperation(operationId)) return;
        if (!selected) return;
        let managedView = selected.kind === 'track-view' ? selected.saved : undefined;
        if (managedView) {
          const managedViewId = managedView.document.id;
          const existing = Object.entries(useCanvasStore.getState().panels)
            .flatMap(([panelId, panel]) => panel.tabs.map((tab) => ({ panelId, tab })))
            .find(({ tab }) => tab.entityId === managedViewId);
          if (existing) {
            if (activation.isCurrent()) {
              useCanvasStore.getState().setActiveTab(existing.panelId, existing.tab.id);
              useCanvasStore.getState().focusPanel(existing.panelId);
            }
            finishBackgroundFileOpen(existing.tab.id);
            completePortableViewOpen();
            return;
          }
          if (!managedView.document.portableReference) {
            const tabId = await openSavedTrackView(managedView, {
              ...(backgroundFileOpen && pendingGenomeViewFileOpen()?.tabId
                ? { intoTabId: pendingGenomeViewFileOpen()!.tabId }
                : {}),
              commitGuard: () => isCurrentPortableViewOperation(operationId),
            });
            if (!isCurrentPortableViewOperation(operationId)) return;
            finishBackgroundFileOpen(tabId);
            completePortableViewOpen();
            return;
          }
          managedView = await recoverScenarioTrackView(managedView);
          if (!isCurrentPortableViewOperation(operationId)) return;
        }
        const recoveryDocument = managedView
          ? await trackViewRecoveryDocument(managedView.document)
          : selected.saved.document;
        const restored = restorePortableGenomeView(recoveryDocument);
        let prepared: PreparedReferenceAssemblyEntryV1;
        try {
          prepared = await resolvePortableReference(restored.reference, managedView);
        } catch (error) {
          if (!isCurrentPortableViewOperation(operationId)) return;
          if (!(error instanceof PortableReferenceMissingError)) throw error;
          awaitingRecovery = true;
          setPortableReferenceRecovery({
            operationId,
            name: selected.saved.document.name,
            restored,
            ...(managedView ? { managedView } : {}),
            reference: error.reference,
            candidates: error.candidates,
            busy: false,
            error: null,
          });
          setPortableViewState('recovering');
          return;
        }
        if (!isCurrentPortableViewOperation(operationId)) return;
        const outcome = await continuePortableViewOpen(
          operationId,
          selected.saved.document.name,
          restored,
          prepared,
          managedView
        );
        awaitingRecovery = outcome === 'recovering';
      } catch (error) {
        if (!isCurrentPortableViewOperation(operationId)) return;
        setPortableViewError(toUserMessage(error, 'tracks.loadFailed'));
      } finally {
        activation.dispose();
        if (portableViewActivationRef.current === activation)
          portableViewActivationRef.current = null;
        if (portableViewOperationIdRef.current === operationId && !awaitingRecovery) {
          resetPortableViewOperation();
        }
      }
    },
    [
      backgroundFileOpen,
      completePortableViewOpen,
      continuePortableViewOpen,
      finishBackgroundFileOpen,
      isCurrentPortableViewOperation,
      resetPortableViewOperation,
      resolvePortableReference,
    ]
  );

  useEffect(() => {
    if (!open || !backgroundFileOpen) return;
    const beginRequestedOpen = () => {
      if (pendingGenomeViewFileOpen()?.id !== backgroundFileOpenRequestId) return;
      const path = startPendingGenomeViewFileOpen();
      if (path) void handleOpenPortableView(path);
    };
    beginRequestedOpen();
    window.addEventListener(GENOME_VIEW_OPEN_REQUESTED, beginRequestedOpen);
    return () => window.removeEventListener(GENOME_VIEW_OPEN_REQUESTED, beginRequestedOpen);
  }, [backgroundFileOpen, backgroundFileOpenRequestId, handleOpenPortableView, open]);

  const adoptPortableReference = useCallback(
    async (session: PortableReferenceRecoverySession, entry: PreparedReferenceAssemblyEntryV1) => {
      const assembly = buildGenomeAssembly(entry, (relativePath) => relativePath);
      await assertReferenceSignatureMatchesPortableView(
        entry.name,
        assembly.chromosomes.map((chromosome) => ({
          name: chromosome.chrom,
          length: chromosome.length,
        })),
        session.reference
      );
      if (portableReferenceRecoveryRef.current?.operationId !== session.operationId) return;
      setLocalReferences((current) => [entry, ...current.filter((item) => item.id !== entry.id)]);
      setPortableReferenceRecovery(null);
      setPortableViewState('opening');
      let awaitingRecovery = false;
      try {
        const outcome = await continuePortableViewOpen(
          session.operationId,
          session.name,
          session.restored,
          entry,
          session.managedView
        );
        awaitingRecovery = outcome === 'recovering';
      } catch (error) {
        if (!isCurrentPortableViewOperation(session.operationId)) return;
        setPortableViewError(toUserMessage(error, 'tracks.loadFailed'));
      } finally {
        if (isCurrentPortableViewOperation(session.operationId) && !awaitingRecovery) {
          resetPortableViewOperation();
        }
      }
    },
    [continuePortableViewOpen, isCurrentPortableViewOperation, resetPortableViewOperation]
  );

  const failPortableReferenceRecovery = useCallback((operationId: string, error: unknown) => {
    setPortableReferenceRecovery((current) =>
      current && current.operationId === operationId
        ? {
            ...current,
            busy: false,
            error: toUserMessage(error, 'tracks.loadFailed'),
          }
        : current
    );
  }, []);

  const handleAddPortableReference = useCallback(async () => {
    const session = portableReferenceRecoveryRef.current;
    if (!session || session.busy || activeImportOperationIdRef.current !== null) return;
    const importOperationId = createReferenceOperationId();
    activeImportOperationIdRef.current = importOperationId;
    setActiveImportOperationId(importOperationId);
    setImportState('preparing');
    setImportProgress(null);
    setImportRecognizedLabel(null);
    setImportError(null);
    setPortableReferenceRecovery({ ...session, busy: true, error: null });
    try {
      const result = await platform().referenceAssets.importLocal({
        operationId: importOperationId,
        themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
      });
      if (portableReferenceRecoveryRef.current?.operationId !== session.operationId) return;
      if (result.status !== 'ready') {
        setPortableReferenceRecovery((current) =>
          current && current.operationId === session.operationId
            ? { ...current, busy: false }
            : current
        );
        return;
      }
      await adoptPortableReference(session, result.entry);
    } catch (error) {
      failPortableReferenceRecovery(session.operationId, error);
    } finally {
      if (activeImportOperationIdRef.current === importOperationId) {
        activeImportOperationIdRef.current = null;
        setActiveImportOperationId(null);
        setImportState('idle');
        setImportProgress(null);
        setImportRecognizedLabel(null);
      }
    }
  }, [adoptPortableReference, failPortableReferenceRecovery]);

  const handleUsePortableReferenceCandidate = useCallback(
    async (entry: PreparedReferenceAssemblyEntryV1) => {
      const session = portableReferenceRecoveryRef.current;
      if (!session || session.busy) return;
      setPortableReferenceRecovery({ ...session, busy: true, error: null });
      try {
        await adoptPortableReference(session, entry);
      } catch (error) {
        failPortableReferenceRecovery(session.operationId, error);
      }
    },
    [adoptPortableReference, failPortableReferenceRecovery]
  );

  const handleCancelPortableReferenceRecovery = useCallback(() => {
    finishBackgroundFileOpen(null);
    setPortableReferenceRecovery(null);
    setPortableViewError(null);
    resetPortableViewOperation();
  }, [finishBackgroundFileOpen, resetPortableViewOperation]);

  const updatePortableRecovery = useCallback(
    (update: (session: PortableRecoverySession) => PortableRecoverySession) => {
      setPortableRecovery((current) => (current ? update(current) : current));
    },
    []
  );

  const handleRelinkPortableTrack = useCallback(async (trackId: string) => {
    const session = portableRecoveryRef.current;
    const resolution = session?.resolutions.find((entry) => entry.track.trackId === trackId);
    if (!session || resolution?.status !== 'relink-required') return;
    setPortableViewError(null);
    try {
      const replacements: Partial<Record<PortableLocatorRole, string>> = {};
      for (const missing of resolution.missing) {
        const selected = await platform().dialog.open({
          multiple: false,
          title: `Locate ${fileNameOf(missing.path)} for ${resolution.track.label}`,
        });
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (!path) return;
        replacements[missing.role] = path;
      }
      const track = relinkPortableTrack(resolution.track, replacements);
      const [replanned] = await planPortableTrackRestore([track]);
      if (!replanned || portableRecoveryRef.current?.operationId !== session.operationId) return;
      setPortableRecovery((current) =>
        current
          ? {
              ...current,
              tracks: current.tracks.map((entry) => (entry.trackId === trackId ? track : entry)),
              resolutions: current.resolutions.map((entry) =>
                entry.track.trackId === trackId ? replanned : entry
              ),
              relinked: new Set([...current.relinked, trackId]),
            }
          : current
      );
    } catch (error) {
      setPortableViewError(toUserMessage(error, 'tracks.loadFailed'));
    }
  }, []);

  const handleConnectPortableCredential = useCallback((trackId: string, authRef: string) => {
    const track = portableRecoveryRef.current?.tracks.find((entry) => entry.trackId === trackId);
    if (!track) return;
    setPortableViewError(null);
    setPortableCredentialPrompt({
      trackId,
      authRef,
      kinds: credentialKindsForAuthRef(track, authRef),
    });
  }, []);

  const handleSubmitPortableCredential = useCallback(
    async (credential: GenomeSourceCredentialInput) => {
      const session = portableRecoveryRef.current;
      if (!session) return;
      setPortableViewError(null);
      try {
        await platform().genomeCredentials.save(credential);
        const affected = session.resolutions.filter(
          (entry) =>
            entry.status === 'credential-required' && entry.authRefs.includes(credential.authRef)
        );
        const replanned = await planPortableTrackRestore(affected.map((entry) => entry.track));
        if (portableRecoveryRef.current?.operationId !== session.operationId) return;
        const byTrackId = new Map(replanned.map((entry) => [entry.track.trackId, entry]));
        setPortableCredentialPrompt(null);
        setPortableRecovery((current) =>
          current
            ? {
                ...current,
                resolutions: current.resolutions.map(
                  (entry) => byTrackId.get(entry.track.trackId) ?? entry
                ),
              }
            : current
        );
      } catch (error) {
        setPortableViewError(toUserMessage(error, 'tracks.loadFailed'));
      }
    },
    []
  );

  const handleTogglePortableSkip = useCallback(
    (trackId: string) => {
      updatePortableRecovery((session) => {
        const skipped = new Set(session.skipped);
        if (skipped.has(trackId)) skipped.delete(trackId);
        else skipped.add(trackId);
        return { ...session, skipped };
      });
    },
    [updatePortableRecovery]
  );

  const handleOpenRecoveredPortableView = useCallback(async () => {
    const session = portableRecoveryRef.current;
    if (!session) return;
    setPortableViewState('opening');
    setPortableViewError(null);
    try {
      await openRestoredPortableView(session);
      setPortableRecovery(null);
    } catch (error) {
      if (!isCurrentPortableViewOperation(session.operationId)) return;
      portableViewCommitInProgressRef.current = false;
      setPortableViewCommitInProgress(false);
      setPortableViewError(toUserMessage(error, 'tracks.loadFailed'));
      setPortableViewState('recovering');
    }
  }, [isCurrentPortableViewOperation, openRestoredPortableView]);

  const handleCancelPortableRecovery = useCallback(() => {
    finishBackgroundFileOpen(null);
    setPortableRecovery(null);
    setPortableCredentialPrompt(null);
    setPortableViewError(null);
    portableViewCommitInProgressRef.current = false;
    setPortableViewCommitInProgress(false);
    portableViewOperationIdRef.current = null;
    portableViewOpenInFlightRef.current = false;
    setPortableViewState('idle');
  }, [finishBackgroundFileOpen]);

  if (!open) return null;

  if (
    backgroundFileOpen &&
    portableViewState === 'opening' &&
    !portableReferenceRecovery &&
    !portableRecovery &&
    !portableViewError
  ) {
    return (
      <div
        data-testid="genome-view-opening-status"
        role="status"
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-bg px-4 py-3 text-sm text-fg shadow-lg"
      >
        <span>Opening saved view…</span>
        <button
          type="button"
          className={`${INTERACTION_CLASS} rounded px-2 py-1 text-fg-muted`}
          onClick={closePicker}
          disabled={portableViewCommitInProgress}
        >
          Cancel
        </button>
      </div>
    );
  }

  const importInFlight = activeImportOperationId !== null;
  const hostedOperationInFlight = Object.values(statusByEntry).some(
    (status) => status === 'opening' || status === 'downloading'
  );
  const pickerOperationInFlight =
    importInFlight || portableViewState !== 'idle' || hostedOperationInFlight;
  const lowerFilter = filter.trim().toLowerCase();
  const filteredHostedReferences = lowerFilter
    ? hostedReferences.filter(
        (entry) =>
          entry.name.toLowerCase().includes(lowerFilter) ||
          entry.organism.toLowerCase().includes(lowerFilter) ||
          entry.description.toLowerCase().includes(lowerFilter) ||
          (entry.assembly ?? '').toLowerCase().includes(lowerFilter) ||
          entry.provider.toLowerCase().includes(lowerFilter) ||
          entry.datasetVersion.toLowerCase().includes(lowerFilter)
      )
    : hostedReferences;
  const localReferenceIds = new Set(localReferences.map((entry) => entry.id));
  const hostedReferenceIds = new Set(hostedReferences.map((entry) => entry.id));
  const selectableLocalReferences = localReferences.filter(
    (entry) => isSelectableWholeAssembly(entry) && !hostedReferenceIds.has(entry.id)
  );
  const availableAssemblies = [
    ...REFERENCE_ASSEMBLY_CATALOG.filter(
      (entry) =>
        isSelectableWholeAssembly(entry) &&
        !localReferenceIds.has(entry.id) &&
        !hostedReferenceIds.has(entry.id)
    ),
  ];
  const filteredAssemblies = lowerFilter
    ? availableAssemblies.filter(
        (a) =>
          a.name.toLowerCase().includes(lowerFilter) ||
          a.organism.toLowerCase().includes(lowerFilter) ||
          a.description.toLowerCase().includes(lowerFilter) ||
          (a.assembly ?? '').toLowerCase().includes(lowerFilter)
      )
    : availableAssemblies;
  const sortMultiplier = sort?.direction === 'descending' ? -1 : 1;
  const sortedHostedReferences = sort
    ? [...filteredHostedReferences].sort((left, right) => {
        const value = (entry: HostedReferenceCatalogEntryV1): string | number => {
          switch (sort.column) {
            case 'reference':
              return entry.name;
            case 'assembly':
              return entry.assembly ?? entry.id;
            case 'source-version':
              return `${entry.datasetVersion} ${entry.provider}`;
            case 'genome-size':
              return entry.lengthBp;
            case 'availability':
              return statusByEntry[entry.id] === 'opening'
                ? 'Opening'
                : hostedReadinessLabel(entry, hostedProgressByEntry[entry.id]?.phase);
          }
        };
        return (
          compareSortValues(value(left), value(right)) * sortMultiplier ||
          left.name.localeCompare(right.name, 'en-US', { numeric: true })
        );
      })
    : filteredHostedReferences;
  const sortedAssemblies = sort
    ? [...filteredAssemblies].sort((left, right) => {
        const value = (entry: ReferenceAssemblyEntry): string | number => {
          const local = localReferenceIds.has(entry.id);
          const status = statusByEntry[entry.id] ?? 'idle';
          switch (sort.column) {
            case 'reference':
              return entry.name;
            case 'assembly':
              return entry.assembly ?? entry.id;
            case 'source-version':
              return local ? 'Local import' : 'Bundled with DNAForge';
            case 'genome-size':
              return referenceAssemblyLengthBp(entry);
            case 'availability':
              return status === 'opening'
                ? 'Opening'
                : status === 'missing' || status === 'error'
                  ? 'Unavailable'
                  : 'Ready';
          }
        };
        return (
          compareSortValues(value(left), value(right)) * sortMultiplier ||
          left.name.localeCompare(right.name, 'en-US', { numeric: true })
        );
      })
    : filteredAssemblies;

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closePicker();
  };

  const filteredLocalReferences = lowerFilter
    ? selectableLocalReferences.filter(
        (entry) =>
          entry.name.toLowerCase().includes(lowerFilter) ||
          entry.organism.toLowerCase().includes(lowerFilter) ||
          entry.description.toLowerCase().includes(lowerFilter) ||
          (entry.assembly ?? '').toLowerCase().includes(lowerFilter)
      )
    : selectableLocalReferences;
  const visibleCustomJobs = lowerFilter
    ? customReferenceJobs.filter(
        (job) =>
          job.title.toLowerCase().includes(lowerFilter) ||
          job.label.toLowerCase().includes(lowerFilter)
      )
    : customReferenceJobs;
  const totalGenomeRows =
    filteredHostedReferences.length +
    filteredAssemblies.length +
    filteredLocalReferences.length +
    visibleCustomJobs.length;
  const hasResults = totalGenomeRows > 0;
  const handleReferenceSort = (column: ReferenceSortColumn) => {
    setSort((current) => ({
      column,
      direction:
        current?.column === column && current.direction === 'ascending'
          ? 'descending'
          : 'ascending',
    }));
  };

  return (
    <div
      data-testid={embedded ? 'reference-library' : 'reference-picker-backdrop'}
      style={
        backgroundFileOpen && !portableReferenceRecovery && !portableRecovery && !portableViewError
          ? { display: 'none' }
          : undefined
      }
      className={
        embedded
          ? 'flex h-full min-h-0 flex-col bg-bg'
          : 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm'
      }
      onClick={embedded ? undefined : onBackdropClick}
      role={embedded ? 'region' : 'dialog'}
      aria-modal={embedded ? undefined : true}
      aria-label="Reference genome library"
    >
      <div
        data-testid={embedded ? 'reference-library-content' : 'reference-picker-modal'}
        className={
          embedded
            ? 'flex h-full min-h-0 w-full flex-col bg-bg'
            : 'flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl'
        }
      >
        <div
          data-testid={embedded ? 'reference-library-toolbar' : undefined}
          className={`flex flex-shrink-0 items-center justify-between gap-4 border-b border-border ${embedded ? 'px-5 py-3' : 'px-5 py-4'}`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <h2
              className={
                embedded
                  ? 'shrink-0 text-lg font-semibold tracking-tight text-fg'
                  : 'shrink-0 text-lg font-semibold text-fg'
              }
            >
              References
            </h2>
            <div className="min-w-0 flex-1">
              <MenuSearchInput
                type="text"
                data-testid="reference-library-search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Search references and saved views"
              />
            </div>
            <span className="shrink-0 text-xs text-fg-subtle">
              {totalGenomeRows} {totalGenomeRows === 1 ? 'genome' : 'genomes'}
            </span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              data-testid="reference-picker-open-saved-view"
              disabled={pickerOperationInFlight}
              onClick={() => void handleOpenPortableView()}
              className={`${INTERACTION_CLASS} h-8 rounded px-3 text-xs font-medium text-fg disabled:cursor-wait`}
            >
              {portableViewState === 'opening' ? 'Opening view file…' : 'Open view file…'}
            </button>
            <button
              type="button"
              data-testid="reference-import-custom"
              aria-label="Add reference"
              disabled={pickerOperationInFlight}
              onClick={() => {
                setImportModalOpen(true);
                setImportState('idle');
                setImportProgress(null);
                setImportRecognizedLabel(null);
                setImportError(null);
                setImportedReference(null);
              }}
              className="h-8 rounded bg-accent px-3 text-xs font-semibold text-white hover:brightness-95 disabled:cursor-wait disabled:opacity-60"
            >
              {importInFlight ? 'Preparing reference…' : '+ Add reference'}
            </button>
            {!embedded && (
              <button
                data-testid="reference-picker-close"
                disabled={portableViewCommitInProgress}
                onClick={closePicker}
                aria-label="Close"
                className={`${INTERACTION_CLASS} ml-1 rounded p-2 text-fg-muted`}
              >
                <CloseIcon size={16} />
              </button>
            )}
          </div>
        </div>

        {portableViewError && !portableRecovery && !portableReferenceRecovery ? (
          <p
            data-testid="reference-picker-open-saved-view-error"
            role="alert"
            className={`flex-shrink-0 border-b border-border py-2 text-xs text-red-700 dark:text-red-300 ${embedded ? 'px-8' : 'px-5'}`}
          >
            {toUserMessage(portableViewError, 'tracks.loadFailed')}
          </p>
        ) : null}
        {portableReferenceRecovery ? (
          <PortableReferenceRecoveryPanel
            viewName={portableReferenceRecovery.name}
            assemblyId={portableReferenceRecovery.reference.assemblyId}
            candidates={portableReferenceRecovery.candidates}
            busy={portableReferenceRecovery.busy}
            progressLabel={importProgress?.label ?? importRecognizedLabel ?? null}
            error={portableReferenceRecovery.error}
            onAddReference={() => void handleAddPortableReference()}
            onUseCandidate={(entry) => void handleUsePortableReferenceCandidate(entry)}
            onCancel={handleCancelPortableReferenceRecovery}
          />
        ) : null}
        {portableRecovery ? (
          <PortableViewRecoveryPanel
            viewName={portableRecovery.name}
            resolutions={portableRecovery.resolutions}
            skippedTrackIds={portableRecovery.skipped}
            relinkedTrackIds={portableRecovery.relinked}
            acceptChangedData={portableRecovery.acceptChangedData}
            requireEveryTrack={portableRecovery.requireEveryTrack}
            busy={portableViewState === 'opening'}
            credentialPrompt={portableCredentialPrompt}
            error={portableViewError}
            onRelink={(trackId) => void handleRelinkPortableTrack(trackId)}
            onConnect={handleConnectPortableCredential}
            onSubmitCredential={(credential) => void handleSubmitPortableCredential(credential)}
            onCancelCredential={() => setPortableCredentialPrompt(null)}
            onToggleSkip={handleTogglePortableSkip}
            onToggleAcceptChangedData={() =>
              updatePortableRecovery((session) => ({
                ...session,
                acceptChangedData: !session.acceptChangedData,
              }))
            }
            onToggleRequireEveryTrack={() =>
              updatePortableRecovery((session) => ({
                ...session,
                requireEveryTrack: !session.requireEveryTrack,
              }))
            }
            onOpen={() => void handleOpenRecoveredPortableView()}
            onCancel={handleCancelPortableRecovery}
          />
        ) : null}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {embedded && (
            <SavedTrackViews
              filter={filter}
              onOpenView={(path) => void handleOpenPortableView(path)}
            />
          )}

          {filteredLocalReferences.length > 0 || visibleCustomJobs.length > 0 ? (
            <section
              aria-label="Custom references"
              className="overflow-hidden border border-border bg-bg"
              data-testid="reference-custom-references"
            >
              <div className="flex h-10 items-center border-b border-border bg-bg-subtle px-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                  Custom references
                </h3>
              </div>
              {visibleCustomJobs.map((job) => (
                <div
                  key={job.operationId}
                  data-testid={`reference-custom-job-${job.operationId}`}
                  className={`border-b border-border px-4 py-2 ${
                    job.phase === 'error' ? 'bg-red-50 dark:bg-red-900/20' : 'bg-bg-subtle/50'
                  }`}
                >
                  <span className="block truncate font-mono text-sm text-fg">{job.title}</span>
                  <span className="block truncate text-[11px] text-fg-muted">{job.label}</span>
                  {job.phase === 'running' ? (
                    <progress
                      aria-label={`${job.title} custom reference progress`}
                      className="mt-2 h-1.5 w-full overflow-hidden rounded-full accent-accent"
                    />
                  ) : null}
                </div>
              ))}
              {filteredLocalReferences.map((entry) => {
                const status = statusByEntry[entry.id] ?? 'idle';
                const expanded = expandedReferenceId === entry.id;
                return (
                  <div key={entry.id}>
                    <div className="relative">
                      <div
                        data-testid={`reference-local-${entry.id}`}
                        className="relative grid min-h-14 w-full grid-cols-[minmax(16rem,1.5fr)_minmax(13rem,1fr)] items-center border-b border-border px-4 py-2 text-left"
                      >
                        <button
                          type="button"
                          aria-label={`Show details for ${entry.assembly ?? entry.name}`}
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedReferenceId((current) =>
                              current === entry.id ? null : entry.id
                            )
                          }
                          disabled={pickerOperationInFlight || status === 'opening'}
                          className="absolute inset-0 z-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60"
                        />
                        <span className="pointer-events-none relative z-10 min-w-0 pr-4">
                          <span className="block truncate font-mono text-sm font-medium text-fg">
                            {entry.assembly ?? entry.name}
                          </span>
                          <span className="block truncate text-[11px] text-fg-muted">
                            {entry.organism} · {entry.members.length}{' '}
                            {entry.members.length === 1 ? 'sequence' : 'sequences'}
                          </span>
                        </span>
                        <span
                          data-testid={`reference-local-${entry.id}-availability`}
                          className="pointer-events-none relative z-10 flex items-center gap-3 text-xs text-fg-muted"
                        >
                          {status === 'opening' ? <span>Opening</span> : null}
                          {status !== 'opening' ? (
                            <ReferenceOpenButton
                              name={entry.assembly ?? entry.name}
                              onClick={() => void handleOpenAssembly(entry)}
                              disabled={pickerOperationInFlight}
                            />
                          ) : null}
                        </span>
                      </div>
                    </div>
                    {expanded ? (
                      <ReferenceSavedViewMenu
                        referenceId={entry.id}
                        referenceKeys={[entry.id, entry.assetCacheKey, entry.assembly, entry.name]}
                        onOpenView={(path) => void handleOpenPortableView(path)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </section>
          ) : null}

          <section
            aria-label="Genome library"
            className="overflow-hidden border border-border bg-bg"
            data-testid="reference-genome-library"
          >
            <div className="flex h-10 items-center border-b border-border bg-bg-subtle px-4">
              <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                Genome library
                <span className="rounded-full bg-bg-muted px-1.5 py-0.5 text-[9px] tracking-normal text-fg-subtle">
                  {totalGenomeRows}
                </span>
              </h3>
            </div>
            <div
              data-testid="reference-genome-library-header"
              className="grid h-8 grid-cols-[minmax(16rem,1.5fr)_minmax(7rem,.65fr)_minmax(9rem,.8fr)_minmax(7rem,.6fr)_minmax(13rem,1fr)] items-center border-b border-border px-4 text-[9px] font-semibold uppercase tracking-wider text-fg-subtle"
            >
              <SortableReferenceHeader
                label="Reference"
                column="reference"
                sort={sort}
                onSort={handleReferenceSort}
              />
              <SortableReferenceHeader
                label="Assembly"
                column="assembly"
                sort={sort}
                onSort={handleReferenceSort}
              />
              <SortableReferenceHeader
                label="Source version"
                column="source-version"
                sort={sort}
                onSort={handleReferenceSort}
              />
              <SortableReferenceHeader
                label="Genome size"
                column="genome-size"
                sort={sort}
                onSort={handleReferenceSort}
              />
              <SortableReferenceHeader
                label="Availability"
                column="availability"
                sort={sort}
                onSort={handleReferenceSort}
              />
            </div>

            {sortedHostedReferences.length > 0 ? (
              <div data-testid="reference-picker-hosted">
                {sortedHostedReferences.map((entry) => {
                  const status = statusByEntry[entry.id] ?? 'idle';
                  const installProgress = hostedProgressByEntry[entry.id];
                  const openProgress = assemblyProgressByEntry[entry.id];
                  const progressLabel = installProgress?.label ?? openProgress?.label;
                  const preparing = status === 'downloading' || entry.preparation?.active === true;
                  const availability = hostedAvailability(entry, status);
                  const readyToOpen = canOpenHostedReference(entry, admittedHostedIds);
                  const needsSetup =
                    !readyToOpen &&
                    !preparing &&
                    status !== 'opening' &&
                    (availability === 'preparing' ||
                      availability === 'stale' ||
                      (availability === 'failed' && status !== 'error' && status !== 'open-error'));
                  const setupAction = availability === 'failed' ? 'Retry setup' : 'Finish setup';
                  const displayAvailability =
                    readyToOpen && availability === 'downloadable' ? 'cached' : availability;
                  const readinessLabel =
                    readyToOpen && availability === 'downloadable'
                      ? 'Ready'
                      : hostedReadinessLabel(entry, installProgress?.phase);
                  const expanded = expandedReferenceId === entry.id;
                  return (
                    <div key={entry.id}>
                      <div
                        data-testid={`reference-hosted-${entry.id}`}
                        className={`relative isolate grid min-h-14 w-full grid-cols-[minmax(16rem,1.5fr)_minmax(7rem,.65fr)_minmax(9rem,.8fr)_minmax(7rem,.6fr)_minmax(13rem,1fr)] items-center border-b border-border text-left last:border-b-0 ${
                          status === 'opening'
                            ? 'cursor-wait bg-bg-subtle'
                            : status === 'error' || status === 'open-error'
                              ? 'bg-red-50 dark:bg-red-900/20'
                              : displayAvailability === 'downloadable'
                                ? 'bg-bg-subtle/50'
                                : ''
                        }`}
                      >
                        <button
                          type="button"
                          aria-label={
                            readyToOpen
                              ? `Show details for ${entry.name}`
                              : `${entry.name} is not ready to open`
                          }
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedReferenceId((current) =>
                              current === entry.id ? null : entry.id
                            )
                          }
                          disabled={!readyToOpen || pickerOperationInFlight || status === 'opening'}
                          className={`absolute inset-0 z-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                            readyToOpen ? 'cursor-pointer' : 'cursor-default disabled:opacity-100'
                          }`}
                        />
                        <span className="pointer-events-none relative z-10 min-w-0 py-2 pl-4 pr-4">
                          <span
                            className={`block truncate text-sm font-medium ${displayAvailability === 'downloadable' ? 'text-fg-muted' : 'text-fg'}`}
                          >
                            {entry.name}
                          </span>
                          <span className="block truncate text-[11px] text-fg-muted">
                            {entry.organism} · {entry.description}
                          </span>
                        </span>
                        <span className="pointer-events-none relative z-10 truncate font-mono text-[11px] text-fg-muted">
                          {entry.assembly ?? entry.id}
                        </span>
                        <span className="pointer-events-none relative z-10 min-w-0 pr-3">
                          {entry.sourceUrl ? (
                            <a
                              href={entry.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${entry.provider} source for ${entry.name}`}
                              className="pointer-events-auto inline-flex max-w-full items-center gap-1 font-mono text-[11px] text-fg-muted underline decoration-border underline-offset-2 transition-colors hover:text-accent hover:decoration-accent focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              <span className="truncate">{entry.datasetVersion}</span>
                              <OpenExternalIcon size={10} className="shrink-0" />
                            </a>
                          ) : (
                            <span className="block truncate font-mono text-[11px] text-fg-muted">
                              {entry.datasetVersion}
                            </span>
                          )}
                          <span className="block truncate text-[10px] text-fg-subtle">
                            {entry.provider}
                          </span>
                        </span>
                        <span className="pointer-events-none relative z-10 text-xs text-fg-muted">
                          <span className="sr-only">Genome length: </span>
                          {formatGenomeLength(entry.lengthBp)}
                        </span>
                        <span
                          data-testid={`reference-hosted-${entry.id}-availability`}
                          data-availability={displayAvailability}
                          className={`pointer-events-none relative z-10 min-w-0 px-4 text-xs ${availabilityTextClasses(displayAvailability)}`}
                        >
                          {status === 'open-error' ? (
                            <span className="flex flex-col items-start gap-1">
                              <span role="status">The reference could not be opened.</span>
                              <span className="pointer-events-auto">
                                <Button
                                  aria-label={`Retry opening ${entry.name}`}
                                  disabled={pickerOperationInFlight}
                                  onClick={() => void handleOpenHosted(entry)}
                                >
                                  Retry opening
                                </Button>
                              </span>
                              {readinessLabel !== 'Ready' && (
                                <span className="max-w-full truncate">{readinessLabel}</span>
                              )}
                            </span>
                          ) : displayAvailability === 'downloadable' ? (
                            <button
                              type="button"
                              data-testid={`reference-hosted-${entry.id}-download`}
                              aria-label={`Download ${entry.name}`}
                              disabled={pickerOperationInFlight}
                              onClick={() => void handleDownloadHosted(entry)}
                              className="pointer-events-auto inline-flex items-center gap-1.5 text-xs text-blue-600 transition-colors hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60 dark:text-blue-400 dark:hover:text-blue-300"
                            >
                              <span>Download ({formatDownloadBytes(entry.downloadBytes)})</span>
                              <ImportIcon size={13} className="h-[13px] w-[13px]" />
                            </button>
                          ) : needsSetup ? (
                            <span className="flex flex-col items-start gap-1">
                              <button
                                type="button"
                                data-testid={`reference-hosted-${entry.id}-download`}
                                aria-label={`${setupAction} ${entry.name}`}
                                disabled={pickerOperationInFlight}
                                onClick={() => void handleDownloadHosted(entry)}
                                className="pointer-events-auto inline-flex items-center gap-1.5 text-xs text-blue-600 transition-colors hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60 dark:text-blue-400 dark:hover:text-blue-300"
                              >
                                {setupAction}
                                <ImportIcon size={13} className="h-[13px] w-[13px]" />
                              </button>
                              {entry.preparation?.status === 'failed' ? (
                                <span
                                  role="status"
                                  title={entry.preparation.label}
                                  className="max-w-full truncate"
                                >
                                  {entry.preparation.label}
                                </span>
                              ) : (
                                <span className="max-w-full truncate">{readinessLabel}</span>
                              )}
                            </span>
                          ) : availability === 'failed' && status === 'error' && !preparing ? (
                            <button
                              type="button"
                              data-testid={`reference-hosted-${entry.id}-download`}
                              aria-label={`Retry download ${entry.name}`}
                              disabled={pickerOperationInFlight}
                              onClick={() => void handleDownloadHosted(entry)}
                              className="pointer-events-auto inline-flex items-center gap-1.5 text-xs text-red-600 transition-colors hover:text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:text-red-400 dark:hover:text-red-300 disabled:cursor-wait disabled:opacity-60"
                            >
                              <span>
                                Retry download ({formatDownloadBytes(entry.downloadBytes)})
                              </span>
                              <ImportIcon size={13} className="h-[13px] w-[13px]" />
                            </button>
                          ) : (
                            <span className="flex items-center gap-2">
                              {status === 'opening' ? (
                                <span className="truncate">Opening</span>
                              ) : readinessLabel === 'Ready' ? null : (
                                <span className="truncate">{readinessLabel}</span>
                              )}
                              {readyToOpen && status !== 'opening' ? (
                                <ReferenceOpenButton
                                  name={entry.name}
                                  onClick={() => void handleOpenHosted(entry)}
                                  disabled={pickerOperationInFlight}
                                />
                              ) : null}
                            </span>
                          )}
                        </span>
                        {status === 'opening' || preparing ? (
                          <progress
                            aria-label={`${entry.name} hosted reference progress`}
                            aria-valuetext={progressLabel ?? 'Starting hosted reference'}
                            className="pointer-events-none relative z-10 col-span-5 mx-4 mb-2 h-1.5 overflow-hidden rounded-full accent-accent"
                            {...(installProgress?.completed !== undefined &&
                            installProgress.total !== undefined
                              ? { value: installProgress.completed, max: installProgress.total }
                              : {})}
                          />
                        ) : null}
                      </div>
                      {expanded ? (
                        <ReferenceSavedViewMenu
                          referenceId={entry.id}
                          referenceKeys={[entry.id, entry.assembly, entry.name]}
                          onOpenView={(path) => void handleOpenPortableView(path)}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {sortedAssemblies.length > 0 ? (
              <div data-testid="reference-picker-assemblies">
                {sortedAssemblies.map((entry) => {
                  const status = statusByEntry[entry.id] ?? 'idle';
                  const progress = assemblyProgressByEntry[entry.id];
                  const indexedCount = entry.members.filter((member) => member.manifest).length;
                  const expanded = expandedReferenceId === entry.id;
                  return (
                    <div key={entry.id}>
                      <div className="relative">
                        <div
                          data-testid={
                            localReferenceIds.has(entry.id)
                              ? `reference-local-${entry.id}`
                              : `reference-assembly-${entry.id}`
                          }
                          className={`relative grid min-h-14 w-full grid-cols-[minmax(16rem,1.5fr)_minmax(7rem,.65fr)_minmax(9rem,.8fr)_minmax(7rem,.6fr)_minmax(13rem,1fr)] items-center border-b border-border px-4 py-2 text-left last:border-b-0 ${
                            status === 'opening'
                              ? 'cursor-wait bg-bg-subtle'
                              : status === 'missing' || status === 'error'
                                ? 'bg-red-50 dark:bg-red-900/20'
                                : ''
                          }`}
                        >
                          <button
                            type="button"
                            aria-label={`Show details for ${entry.name}`}
                            aria-expanded={expanded}
                            onClick={() =>
                              setExpandedReferenceId((current) =>
                                current === entry.id ? null : entry.id
                              )
                            }
                            disabled={pickerOperationInFlight || status === 'opening'}
                            className="absolute inset-0 z-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60"
                          />
                          <span className="pointer-events-none relative z-10 min-w-0 pr-4">
                            <span className="block truncate text-sm font-medium text-fg">
                              {entry.name}
                            </span>
                            <span className="block truncate text-[11px] text-fg-muted">
                              {entry.organism} · {entry.description}
                            </span>
                          </span>
                          <span className="pointer-events-none relative z-10 truncate font-mono text-[11px] text-fg-muted">
                            {entry.assembly ?? entry.id}
                          </span>
                          <span className="pointer-events-none relative z-10 min-w-0 pr-3">
                            <span className="block truncate text-[11px] text-fg-muted">
                              {localReferenceIds.has(entry.id)
                                ? 'Local import'
                                : 'Bundled with DNAForge'}
                            </span>
                            <span className="block truncate text-[10px] text-fg-subtle">
                              {entry.members.length} chr · {indexedCount} indexed
                            </span>
                          </span>
                          <span className="pointer-events-none relative z-10 text-xs text-fg-muted">
                            {formatGenomeLength(referenceAssemblyLengthBp(entry))}
                          </span>
                          <span
                            data-testid={
                              localReferenceIds.has(entry.id)
                                ? `reference-local-${entry.id}-availability`
                                : undefined
                            }
                            data-availability={
                              status === 'opening'
                                ? 'opening'
                                : status === 'missing' || status === 'error'
                                  ? 'failed'
                                  : 'cached'
                            }
                            className={`pointer-events-none relative z-10 flex min-w-0 items-center gap-2 text-xs ${availabilityTextClasses(
                              status === 'opening'
                                ? 'opening'
                                : status === 'missing' || status === 'error'
                                  ? 'failed'
                                  : 'cached'
                            )}`}
                          >
                            {status === 'opening' || status === 'missing' || status === 'error' ? (
                              <span>
                                {status === 'opening'
                                  ? (progress?.label ?? 'Opening reference…')
                                  : 'Unavailable'}
                              </span>
                            ) : null}
                            {status !== 'opening' && status !== 'missing' && status !== 'error' ? (
                              <ReferenceOpenButton
                                name={entry.name}
                                onClick={() => void handleOpenAssembly(entry)}
                                disabled={pickerOperationInFlight}
                              />
                            ) : null}
                          </span>
                          {status === 'opening' && progress ? (
                            <div
                              data-testid={`reference-assembly-progress-${entry.id}`}
                              role="status"
                              aria-live="polite"
                              className="col-span-5 mt-1 space-y-1.5"
                            >
                              <div className="flex items-center justify-between gap-3 text-xs text-fg-muted">
                                <span>{`Current step: ${progress.label}`}</span>
                                <span className="shrink-0 font-mono">
                                  {`${formatLengthForPicker(referenceAssemblyLengthBp(entry))} genomic span · ${entry.members.length} ${entry.members.length === 1 ? 'chromosome' : 'chromosomes'}`}
                                </span>
                              </div>
                              <progress
                                aria-label={`${entry.name} indexing progress`}
                                aria-valuetext={progress.label}
                                className="h-1.5 w-full overflow-hidden rounded-full accent-accent"
                              />
                            </div>
                          ) : null}
                          {status === 'error' ? (
                            <span className="col-span-5 mt-1 text-xs text-red-700 dark:text-red-300">
                              Failed to open.{' '}
                              {openErrorByEntry[entry.id] ??
                                'The prepared reference is unavailable. Add it again from its original folder or package.'}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {expanded ? (
                        <ReferenceSavedViewMenu
                          referenceId={entry.id}
                          referenceKeys={[
                            entry.id,
                            entry.assetCacheKey,
                            entry.assembly,
                            entry.name,
                          ]}
                          onOpenView={(path) => void handleOpenPortableView(path)}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {!hasResults ? (
              <p className="px-4 py-8 text-sm italic text-fg-subtle">
                No references match &ldquo;{filter}&rdquo;.
              </p>
            ) : null}
          </section>
        </div>
      </div>
      {importModalOpen ? (
        <PresentationScopeContext.Provider value={presentationOverlay.scope}>
          <div
            className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm`}
            role="dialog"
            aria-modal="true"
            aria-label="Add reference"
            onClick={(event) => {
              if (event.target === event.currentTarget) closeImportModal();
            }}
            ref={presentationOverlay.bindRef(undefined, '0')}
          >
            <div className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-bg shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                <div>
                  <h3 className="text-lg font-semibold text-fg">Add reference</h3>
                  <p className="mt-1 text-sm text-fg-muted">
                    Add a FASTA file, a folder with FASTA and optional GFF3 annotations, an NCBI
                    Datasets ZIP, an assembly link, or a genome from a UCSC assembly hub or GenArk.
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Cancel adding reference"
                  disabled={importInFlight}
                  onClick={closeImportModal}
                  className={`${INTERACTION_CLASS} rounded p-2 text-fg-muted disabled:cursor-wait`}
                >
                  <CloseIcon size={16} />
                </button>
              </div>

              <div className="space-y-4 p-5">
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleImportNcbiAssemblyLink();
                  }}
                >
                  <label
                    className="block text-xs font-medium text-fg"
                    htmlFor="reference-import-ncbi-link"
                  >
                    Assembly link
                  </label>
                  <div className="flex gap-2">
                    <div className="min-w-0 flex-1">
                      <TextField
                        id="reference-import-ncbi-link"
                        data-testid="reference-import-ncbi-link"
                        value={ncbiAssemblyLink}
                        disabled={importInFlight}
                        placeholder="https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000008865.2/"
                        onChange={(event) => setNcbiAssemblyLink(event.target.value)}
                      />
                    </div>
                    <Button
                      variant="primary"
                      type="submit"
                      data-testid="reference-import-ncbi-open"
                      disabled={importInFlight || ncbiAssemblyLink.trim() === ''}
                    >
                      Open link
                    </Button>
                  </div>
                </form>

                <div
                  data-testid="reference-import-source"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleImportDrop}
                  className="flex min-h-40 flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-bg-subtle px-6 py-8 text-center"
                >
                  <span className="text-sm font-medium text-fg">
                    Drop one reference source here
                  </span>
                  <span className="my-3 text-xs uppercase tracking-wider text-fg-subtle">or</span>
                  <Button
                    variant="primary"
                    type="button"
                    data-testid="reference-import-browse"
                    autoFocus
                    disabled={importInFlight}
                    onClick={() => void handleImportCustom()}
                  >
                    {importState === 'preparing' ? 'Preparing reference…' : 'Browse…'}
                  </Button>
                </div>

                <HubGenomeImportPanel
                  disabled={importInFlight}
                  onImport={(source) => void handleImportHubGenome(source)}
                />

                {importState === 'preparing' ? (
                  <div
                    data-testid="reference-import-progress"
                    role="status"
                    aria-live="polite"
                    className="space-y-2 rounded border border-border bg-bg-subtle p-3 text-xs text-fg-muted"
                  >
                    {importRecognizedLabel ? (
                      <span className="block">{importRecognizedLabel}</span>
                    ) : null}
                    {importProgress?.label !== importRecognizedLabel ? (
                      <span className="block">
                        {importProgress?.label ?? 'Inspecting selected source'}
                      </span>
                    ) : null}
                    <progress
                      aria-label="Custom reference preparation progress"
                      className="h-1.5 w-full overflow-hidden rounded-full accent-accent"
                      {...(importProgress?.completed !== undefined &&
                      importProgress.total !== undefined
                        ? { value: importProgress.completed, max: importProgress.total }
                        : {})}
                    />
                  </div>
                ) : null}
                {importState === 'success' && importedReference ? (
                  <p
                    data-testid="reference-import-success"
                    role="status"
                    className="rounded border border-green-300 bg-green-50 p-3 text-xs text-green-800 dark:border-green-700 dark:bg-green-950/50 dark:text-green-200"
                  >
                    {importedReference.name} is ready. Opening the indexed genome…
                  </p>
                ) : null}
                {importState === 'error' && importError ? (
                  <p
                    data-testid="reference-import-error"
                    role="alert"
                    className="rounded border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-700 dark:bg-red-950/50 dark:text-red-200"
                  >
                    {toUserMessage(importError, 'tracks.loadFailed')}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </PresentationScopeContext.Provider>
      ) : null}
    </div>
  );
}

const keepReferenceLibraryOpen = () => undefined;

export function ReferenceLibrary({ onClose = keepReferenceLibraryOpen }: { onClose?: () => void }) {
  return <ReferenceGenomePicker open embedded onClose={onClose} />;
}
