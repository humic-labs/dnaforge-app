import { usePresentationListener } from '../../../presentation/PresentationSurface';
import { importReceiptMessage, sequenceRegistrationFailureMessage } from '../import-user-messages';
import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
  toUserMessage,
} from '@waypoint/user-messages';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ChevronRightIcon } from '../../../components/icons/glyphs';
import { openSettingsEntry } from '../../auth/public/registry-settings';
import { ExplorerAddButton } from '../../../components/ExplorerAddButton';
import {
  ExplorerAddPicker,
  type ExplorerEntityCreateRequest,
  type ExplorerEntityImportRequest,
} from '../../../components/ExplorerAddPicker';
import {
  listImportableSheets,
  type LimsEntityKind,
  type LimsIdScheme,
  type LimsImportPlan,
  type LimsRegistrationStatus,
  type LimsRegistryPreview,
  type LimsRegistrySort,
  type LimsRegistrySummary,
  type LimsRegistrySummaryPage,
  type LimsSchemaDefinitionView,
} from '../../../shared/lims';
import { safeFocus, scheduleFocus } from '../../../shared/utils/safeFocus';
import { findContainingPathBoundary, pathRelativeToBoundary } from '../../../shared/path-boundary';
import { DEFAULT_PROJECT_DISPLAY_NAME } from '../../../shared/first-project';
import { platform } from '../../../platform';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useProjectEditFolders } from '../../workspace-loader/public/use-project-edit-folders';
import { createTrackedEmptyWorkspace } from '../../workspace-loader/public/workspace-created-telemetry';
import {
  createImportAttemptId,
  importElapsedMs,
  importStartMark,
  trackImportCompleted,
  trackImportFailed,
  trackImportStarted,
  type ImportFailureStage,
} from '../../import-wizard/public/import-telemetry';
import type {
  RegisterableSequenceKind,
  RegisterImportedSequenceResult,
} from '../../../shared/workspace-git-types';
import { buildWorkbookSheetPreviews, type LimsImportFileProvenance } from '../ingress';
import {
  prepareLimsImportReview as createLimsImportPlan,
  mapLimsImportReview as applyImportPlanColumnMappings,
  acceptLimsImportReviewRecords,
  inspectLimsImportReview,
  applyLimsImportReview,
  executeLimsImportReview,
  cancelLimsImportReview,
} from '../import-review-client';
import { copyTabularSourceIntoWorkspace } from './tabular-file-copy';
import {
  persistImportedPrimerImportSet,
  recordImportedPrimers,
  type ImportedPrimerImportPartition,
} from '../import-primer-bridge';
import {
  EntityArtifactProjectionError,
  recordImportedEntityArtifacts,
  type ImportedEntityImportPartition,
} from '../import-entity-artifact-bridge';
import {
  recordImportedProteins,
  type ImportedProteinImportPartition,
} from '../import-protein-bridge';
import { persistImportSet } from '../import-set';
import { resolveImportSource } from './lims-import-source';
import {
  getLimsIdSchemes,
  getLimsRegistryPreview,
  getLimsSchemas,
  queryLimsRegistrySummaries,
  resetLimsRegistry,
  seedLimsDemoDataset,
  seedLimsMockDemo,
  seedLimsPracticeDemo,
  seedLimsStarterRegistry,
  undoLimsImportBatch,
} from '../operations';
import { isLimsEntityOpened, openLimsEntity } from '../open-entity';
import {
  emitLimsRegistrationChanged,
  isRegisterableOpenSequenceKind,
  subscribeLimsRegistryChanged,
} from '../register-open-sequence';
import type { TabViewState } from '../../canvas/public/types';
import {
  LimsImportWizard,
  type ImportDoorKind,
  type WizardStep,
  type WorkbookReviewView,
} from './LimsImportWizard';
import { useLimsImportLaunchStore } from '../lims-import-launch-store';
import { type WorkbookReviewState, type WorkbookReviewTab } from './workbook-review';
import { computeImportPlanView } from './import-plan-view';
import {
  REGISTRY_GRID_BASE,
  REGISTRY_PAGE_SIZE,
  REGISTRY_SORT_OPTIONS,
  STATUS_FILTER_OPTIONS,
  registryColumnsForSchema,
  type DevScenario,
  type RegistryColumnDef,
} from './registry/registry-columns';
import {
  observeRegistryPresentation,
  useLimsOverlayStore,
  type RegistryPresentationRequest,
} from '../lims-overlay-store';
import { useRegistryColumnResize } from './registry/useRegistryColumnResize';
import { RegistryFilterPopover } from './registry/RegistryFilterPopover';
import { RegistryFilters, type RegistryFilterFacet } from './registry/RegistryFilters';
import { RegistryCompactDrawer } from './registry/RegistryCompactDrawer';
import { RegistryClaimDialog } from './registry/RegistryClaimDialog';
import { RegistryPreviewPane } from './registry/RegistryPreviewPane';
import { OrganizationRegistryPreviewPane } from './registry/OrganizationRegistryPreviewPane';
import { useOrganizationRegistry } from './registry/useOrganizationRegistry';
import { useActionablePendingRefs } from '../use-actionable-pending-refs';
import { OriginalProviderSourceDialog } from './registry/OriginalProviderSourceDialog';
import { RegistryOverlayTable } from './registry/RegistryOverlayTable';
import {
  OrganizationRegistryTable,
  organizationRegistryRecords,
  RegistryScopeControls,
  type OrganizationRegistryRecord,
} from './registry/RegistryScopeSurface';
import { RegistryCreateDestinationDialog } from './RegistryCreateDestinationDialog';
import { registerWorkspaceDisplayParticipant } from '../../../services/workspace-display-participants';

const PRIMER_CSV_SCENARIO_SOURCE_NAME = 'primers-alt-headers.csv';
const PRIMER_CSV_SCENARIO_TEXT = [
  'Primer ID,Oligo Sequence,Notes,Melting Temp',
  'OL001,ATGCGATCGATCGATCG,Colony PCR forward,54.2',
  'OL002,GCTAGCTAGCTAGCTAG,Colony PCR reverse,52.8',
  'OL003,AATTCCGGAATTCCGG,Restriction site check,51.5',
  'OL004,GGATCCGGATCCGGATCC,BamHI site verification,58.3',
  'OL005,GAATTCGAATTCGAATTC,EcoRI site verification,52.1',
  'OL006,CTCGAGCTCGAGCTCGAG,XhoI site verification,58.0',
  'OL007,AAGCTTAAGCTTAAGCTT,HindIII site verification,50.4',
  'OL008,GCGGCCGCGGCCGCGGCC,NotI site verification,72.5',
].join('\n');

const MESSY_PRIMER_CSV_SCENARIO_SOURCE_NAME = 'messy-primer-order-sheet.csv';
const MESSY_PRIMER_CSV_SCENARIO_TEXT = [
  'Primer ID,Oligo Sequence,Owner,Order Date,Supplier,Plate,Well,Project,Notes,Melting Temp,QC Flag,Freezer Box,Legacy ID',
  'MP001,GTAAAACGACGGCCAGT,Peter,2026-06-01,IDT,Plate-7,A01,pUC19 checks,M13 forward control,54.1,pass,Box A,old-001',
  'MP002,CAGGAAACAGCTATGAC,Peter,2026-06-01,IDT,Plate-7,A02,pUC19 checks,M13 reverse control,52.9,pass,Box A,old-002',
  'MP003,ATGACCATGATTACGCCAAG,Alex,2026-06-03,IDT,Plate-8,B01,colony PCR,Screening forward,58.4,review,Box C,legacy-F3',
].join('\n');

function errorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LimsImportTelemetrySession {
  operationId: string;
  sourceNames: readonly string[];
  startedAt: number;
}

function startLimsImport(sourceNames: readonly string[]): LimsImportTelemetrySession {
  const operationId = createImportAttemptId();
  trackImportStarted(sourceNames, operationId);
  return { operationId, sourceNames, startedAt: importStartMark() };
}

function finishLimsImport(
  session: LimsImportTelemetrySession,
  input: {
    importedCount: number;
    hasDurableWrite?: boolean;
    failure?: { stage: ImportFailureStage; errorClass: string };
  }
): void {
  const completed = input.importedCount > 0 || input.hasDurableWrite === true;
  if (completed) {
    trackImportCompleted({
      operationId: session.operationId,
      sourcePaths: session.sourceNames,
      importedCount: input.importedCount,
      durationMs: importElapsedMs(session.startedAt),
    });
  }
  if (input.failure) {
    trackImportFailed({ operationId: session.operationId, ...input.failure });
  } else if (!completed) {
    trackImportFailed({
      operationId: session.operationId,
      stage: 'validate',
      errorClass: 'import_nothing_registered',
    });
  }
}

function reviewToJob(review: WorkbookReviewState | null): WorkbookReviewView | undefined {
  if (!review) return undefined;
  return {
    fileName: review.fileName,
    kind: review.kind,
    phase: review.phase,
    activeSheet: review.activeSheet,
    activeGrid: review.gridPreviews[review.activeSheet],
    tabs: review.tabs.map((tab) => ({
      sheetName: tab.sheetName,
      verdict: tab.verdict,
      rowCount: tab.rowCount,
      selected: tab.selected,
      planError: tab.planError,
      outcome: tab.outcome,
    })),
  };
}

declare const __DEV_WP_ASSETS_PATH__: string;

interface LimsPanelProps {
  onHide?: () => void;
  onCreateEntity?: (request: ExplorerEntityCreateRequest) => void;
  onImportEntity?: (request: ExplorerEntityImportRequest) => void;
  onImportProject?: () => void;
  onImportProjectWithAgent?: () => void;
  onMigrateFromBenchling?: () => void;
}

function searchRegistryClaimRecords(search: string): Promise<LimsRegistrySummaryPage> {
  return queryLimsRegistrySummaries({
    search,
    limit: REGISTRY_PAGE_SIZE,
    offset: 0,
    includeArchived: false,
  });
}

export function LimsPanel({
  onHide,
  onCreateEntity,
  onImportEntity,
  onImportProject,
  onImportProjectWithAgent,
  onMigrateFromBenchling,
}: LimsPanelProps = {}) {
  const presentationEvents = usePresentationListener();

  const registryRequest = useLimsOverlayStore((state) => state.registryRequest);
  const consumeRegistryRequest = useLimsOverlayStore((state) => state.consumeRegistryRequest);
  const [seedingDemo, setSeedingDemo] = useState(false);
  const [message, setMessage] = useState<UserMessage | null>(null);

  const [messageTone, setMessageTone] = useState<'success' | 'error'>('success');
  const [preview, setPreview] = useState<LimsImportPlan | null>(null);

  const [idSchemes, setIdSchemes] = useState<LimsIdScheme[]>([]);
  const showDevScenarios = platform().runtime.getProfile().scenarioMutationAllowed;
  const [registrySearch, setRegistrySearch] = useState('');
  const [registryProjectIds, setRegistryProjectIds] = useState<number[]>([]);
  const [registryRemoteFilterProjectIds, setRegistryRemoteFilterProjectIds] = useState<string[]>(
    []
  );
  const [registryFiltersOpen, setRegistryFiltersOpen] = useState(false);

  const [registryTextFilters, setRegistryTextFilters] = useState<Record<string, string>>({});

  const [openFilterKey, setOpenFilterKey] = useState<string | null>(null);
  const [filterAnchor, setFilterAnchor] = useState<{ top: number; left: number } | null>(null);
  const [registryPage, setRegistryPage] = useState<LimsRegistrySummaryPage>({
    summaries: [],
    totalCount: 0,
    limit: 100,
    offset: 0,
  });
  const [registryPreview, setRegistryPreview] = useState<LimsRegistryPreview | null>(null);
  const registryPreviewRef = useRef(registryPreview);
  registryPreviewRef.current = registryPreview;
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryLoadingMore, setRegistryLoadingMore] = useState(false);

  const [registryExpanded, setRegistryExpanded] = useState(false);

  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sortMenuPos, setSortMenuPos] = useState<{ top: number; right: number } | null>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const openSortMenu = useCallback(() => {
    const rect = sortTriggerRef.current?.getBoundingClientRect();
    if (rect) setSortMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setSortMenuOpen(true);
  }, []);

  const [registryOverlayMounted, setRegistryOverlayMounted] = useState(false);
  const [registryOverlayShown, setRegistryOverlayShown] = useState(false);

  const [registryMorphRect, setRegistryMorphRect] = useState<{
    top: number;
    left: number;
    right: number;
    bottom: number;
  } | null>(null);

  const [registryMorphing, setRegistryMorphing] = useState(false);
  const registryActionTimersRef = useRef<Set<number>>(new Set());

  const [registryCategoricalFilters, setRegistryCategoricalFilters] = useState<
    Record<string, string[]>
  >({});

  const [registryUpdatedFilter, setRegistryUpdatedFilter] = useState<{
    mode: 'before' | 'on' | 'after';
    date: string;
  } | null>(null);
  const [registrySort, setRegistrySort] = useState<LimsRegistrySort>('updated_desc');
  const [registryShowArchived, setRegistryShowArchived] = useState(false);
  const [registryReveal, setRegistryReveal] = useState<{
    entityId: string;
    archived: boolean;
  } | null>(null);
  const [limsSchemas, setLimsSchemas] = useState<LimsSchemaDefinitionView[]>([]);
  const [originalSourceDialog, setOriginalSourceDialog] = useState<{
    request: ComponentProps<typeof OriginalProviderSourceDialog>['request'];
    label: string;
  } | null>(null);

  const registryReqRef = useRef(0);

  const registryPreviewReqRef = useRef(0);
  const registryPreviewPublishedReqRef = useRef(0);
  const pendingRegistryPresentationRef = useRef<{
    request: RegistryPresentationRequest;
    ready: boolean;
    previewGeneration: number;
    accountId?: string | null;
  } | null>(null);
  const registryWasExpandedRef = useRef(false);
  const registryPresentationMountRef = useRef(0);
  const cancelRegistryPresentation = useCallback(() => {
    const pending = pendingRegistryPresentationRef.current;
    if (!pending) return;
    pendingRegistryPresentationRef.current = null;
    registryPreviewReqRef.current += 1;
    observeRegistryPresentation(pending.request, { kind: 'cancelled' });
  }, []);
  useEffect(() => {
    const mount = ++registryPresentationMountRef.current;
    return () => {
      queueMicrotask(() => {
        if (registryPresentationMountRef.current === mount) cancelRegistryPresentation();
      });
    };
  }, [cancelRegistryPresentation]);
  const { registryColumnWidths, startRegistryColumnResize } = useRegistryColumnResize();
  const selectedSchemaKinds = registryCategoricalFilters.kind ?? [];
  const selectedTableSchema =
    selectedSchemaKinds.length === 1
      ? limsSchemas.find((schema) => schema.entityKind === selectedSchemaKinds[0])
      : undefined;
  const registryColumns = useMemo(
    () =>
      registryColumnsForSchema(
        selectedTableSchema,
        limsSchemas.map((schema) => ({ value: schema.entityKind, label: schema.displayName }))
      ),
    [limsSchemas, selectedTableSchema]
  );

  const registryColTrack = (column: RegistryColumnDef) =>
    column.key === 'name'
      ? registryColumnWidths['name'] != null
        ? `${registryColumnWidths['name']}px`
        : 'minmax(120px, 480px)'
      : `${registryColumnWidths[column.key] ?? column.width}px`;

  const registryGridTemplateFull = registryColumns.map(registryColTrack).join(' ');
  const registryGridTemplateCollapsed = registryColumns
    .map((column) =>
      column.key === 'name' ? 'minmax(120px, 480px)' : column.key === 'registryId' ? '64px' : '0px'
    )
    .join(' ');
  const registryGridTemplate = registryOverlayShown
    ? registryGridTemplateFull
    : registryGridTemplateCollapsed;
  const registryGridColumnGap = registryOverlayShown ? '1rem' : '0px';

  const registryGridRowProps = (extra = ''): { className: string; style: CSSProperties } => ({
    className: `${REGISTRY_GRID_BASE} ${extra} ${
      registryMorphing ? 'transition-[grid-template-columns,column-gap] duration-200 ease-out' : ''
    }`,
    style: { gridTemplateColumns: registryGridTemplate, columnGap: registryGridColumnGap },
  });
  const [importPlanDirty, setImportPlanDirty] = useState(false);
  const [lastImportBatch, setLastImportBatch] = useState<{
    batchId: string;
    sourceName: string;
  } | null>(null);
  const previewRef = useRef<LimsImportPlan | null>(null);
  const importMappingQueueRef = useRef<Promise<void>>(Promise.resolve());

  const applyingRef = useRef(false);

  const pendingSequenceSourcePathRef = useRef<string | undefined>(undefined);

  const pendingSequenceContentRef = useRef<string | undefined>(undefined);

  const pendingImportArrayBufferRef = useRef<ArrayBuffer | undefined>(undefined);

  const [destinationRoot, setDestinationRoot] = useState<string | null>(null);
  const folders = useWorkspaceStore((state) => state.folders);
  const registryOwningPaths = useMemo(
    () =>
      registryPage.summaries.flatMap((summary) => {
        const target = summary.representation.openTarget;
        return target?.kind === 'managed_sequence' ? [target.document.packageRoot] : [];
      }),
    [registryPage.summaries]
  );
  const projectEditFolders = useProjectEditFolders(registryOwningPaths);
  const {
    registryAccountId,
    registryScope,
    setRegistryScope,
    organizationRegistrySearch,
    setOrganizationRegistrySearch,
    registryOrganizations,
    selectedRegistryOrgId,
    organizationRegistry,
    organizationRegistryLoading,
    organizationRegistryError,
    registryClaimOpen,
    setRegistryClaimOpen,
    registryPlacementBusyId,
    registryProjects,
    registryRemoteProjectId,
    setRegistryRemoteProjectId,
    registryProject,
    selectedOrganizationRecordId,
    setSelectedOrganizationRecordId,
    visibleOrganizationDetails,
    organizationDetailsLoading,
    organizationDetailsError,
    organizationRecordOpening,
    refreshOrganizationRegistry,
    chooseRegistryOrganization,
    claimLocalRecords,
    addRegistryProjectPlacement,
    removeRegistryProjectPlacement,
    prepareRegistryClaim,
    openOrganizationRecord: openOrganizationRegistryRecord,
  } = useOrganizationRegistry({ setMessage, setMessageTone });
  useEffect(() => {
    setRegistryRemoteFilterProjectIds([]);
  }, [selectedRegistryOrgId]);
  const visibleRegistrySearch =
    registryScope === 'local' ? registrySearch : organizationRegistrySearch;
  const setVisibleRegistrySearch =
    registryScope === 'local' ? setRegistrySearch : setOrganizationRegistrySearch;
  const registryAddButtonRef = useRef<HTMLButtonElement>(null);
  const [registryAddPickerOpen, setRegistryAddPickerOpen] = useState(false);
  const [registryCreateRequest, setRegistryCreateRequest] =
    useState<ExplorerEntityCreateRequest | null>(null);

  const [wizardStep, setWizardStep] = useState<WizardStep | null>(null);
  const [chosenKind, setChosenKind] = useState<ImportDoorKind | null>(null);
  const sharedImportLaunch = useLimsImportLaunchStore((state) => state.request);
  const consumeSharedImportLaunch = useLimsImportLaunchStore((state) => state.consume);
  const chosenKindRef = useRef<ImportDoorKind | null>(null);
  useEffect(() => {
    chosenKindRef.current = chosenKind;
  }, [chosenKind]);

  const pendingDropFileRef = useRef<File | null>(null);
  const [draggingToImport, setDraggingToImport] = useState(false);
  const registrySearchRef = useRef<HTMLInputElement>(null);
  const registryRowRefs = useRef(new Map<string, HTMLDivElement>());
  const registryScrollRef = useRef<HTMLDivElement>(null);
  const filterPopoverRef = useRef<HTMLDivElement>(null);
  const registrySentinelRef = useRef<HTMLDivElement>(null);
  const registryPanelRef = useRef<HTMLDivElement>(null);
  const registryCompactScrollRef = useRef<HTMLDivElement>(null);
  const registryCompactSentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRegistryRef = useRef<() => void>(() => {});

  const measurePanelRect = useCallback(() => {
    const el = registryPanelRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      top: r.top,
      left: r.left,
      right: Math.max(0, window.innerWidth - r.right),
      bottom: Math.max(0, window.innerHeight - r.bottom),
    };
  }, []);

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  const [workbookReview, setWorkbookReview] = useState<WorkbookReviewState | null>(null);
  const workbookReviewRef = useRef<WorkbookReviewState | null>(null);
  useEffect(() => {
    workbookReviewRef.current = workbookReview;
  }, [workbookReview]);

  const unconnected = useActionablePendingRefs();
  const [unconnectedOnly, setUnconnectedOnly] = useState(false);
  const unconnectedEntityIds = useMemo(
    () => new Set(unconnected.entityIds),
    [unconnected.entityIds]
  );

  const registryQueryFilters = useCallback(() => {
    const updatedMs = registryUpdatedFilter?.date
      ? new Date(`${registryUpdatedFilter.date}T00:00:00`).getTime()
      : undefined;
    const kinds = registryCategoricalFilters.kind ?? [];
    const statuses = registryCategoricalFilters.status ?? [];
    const organismTaxids = registryCategoricalFilters.organism ?? [];
    return {
      workspaceIds: registryProjectIds.length > 0 ? registryProjectIds : undefined,
      search: registrySearch.trim() || undefined,
      nameLike: registryTextFilters.name?.trim() || undefined,
      sequenceLike: registryTextFilters.sequence?.trim() || undefined,
      registryIdLike: registryTextFilters.registryId?.trim() || undefined,
      kinds: kinds.length > 0 ? kinds : undefined,
      registrationStatuses:
        statuses.length > 0 ? (statuses as LimsRegistrationStatus[]) : undefined,
      speciesTaxids: organismTaxids.length > 0 ? organismTaxids : undefined,
      updatedOn: registryUpdatedFilter?.mode === 'on' ? updatedMs : undefined,
      updatedAfter: registryUpdatedFilter?.mode === 'after' ? updatedMs : undefined,
      updatedBefore: registryUpdatedFilter?.mode === 'before' ? updatedMs : undefined,
      sort: registrySort,
      includeArchived: registryShowArchived || undefined,
      ...(registryReveal
        ? { ids: [registryReveal.entityId] }
        : unconnectedOnly
          ? { ids: unconnected.entityIds }
          : {}),
    };
  }, [
    registryProjectIds,
    registryTextFilters,
    registryCategoricalFilters,
    registrySearch,
    registryShowArchived,
    registrySort,
    registryUpdatedFilter,
    unconnectedOnly,
    unconnected.entityIds,
    registryReveal,
  ]);
  const currentRegistryQueryFilters = useRef(registryQueryFilters);
  currentRegistryQueryFilters.current = registryQueryFilters;

  const registryQueryKey = JSON.stringify(registryQueryFilters());
  const registryFilterGenerationRef = useRef(0);
  useEffect(() => {
    registryFilterGenerationRef.current += 1;
  }, [registryQueryKey]);
  useEffect(() => {
    if (!registryReveal) return;
    if (
      registrySearch.trim() ||
      Object.values(registryTextFilters).some((value) => value.trim()) ||
      Object.values(registryCategoricalFilters).some((values) => values.length) ||
      registryUpdatedFilter?.date ||
      unconnectedOnly ||
      registryScope !== 'local' ||
      registryShowArchived !== registryReveal.archived
    )
      setRegistryReveal(null);
  }, [
    registryReveal,
    registrySearch,
    registryTextFilters,
    registryCategoricalFilters,
    registryUpdatedFilter,
    unconnectedOnly,
    registryScope,
    registryShowArchived,
  ]);
  const clearRegistryFilters = useCallback(() => {
    setRegistryProjectIds([]);
    setRegistryReveal(null);
    setRegistrySearch('');
    setRegistryTextFilters({});
    setRegistryCategoricalFilters({});
    setRegistryUpdatedFilter(null);
    setRegistryShowArchived(false);
    setRegistryRemoteFilterProjectIds([]);
    setOrganizationRegistrySearch('');
    setUnconnectedOnly(false);
    setOpenFilterKey(null);
  }, [setOrganizationRegistrySearch]);

  const getColumnTextFilter = (key: string): string => registryTextFilters[key] ?? '';
  const setColumnTextFilter = (key: string, value: string) =>
    setRegistryTextFilters((prev) => ({ ...prev, [key]: value }));
  const getColumnCategoricalFilter = (key: string): string[] =>
    registryCategoricalFilters[key] ?? [];
  const setColumnCategoricalFilter = (key: string, values: string[]) =>
    setRegistryCategoricalFilters((prev) => ({ ...prev, [key]: values }));

  const columnHasFilter = (key: string): boolean => {
    if (key === 'updated') return Boolean(registryUpdatedFilter?.date);
    if (key === 'kind' || key === 'status') {
      return getColumnCategoricalFilter(key).length > 0;
    }
    return getColumnTextFilter(key).trim() !== '';
  };

  const describeColumnFilter = (rawColumn: RegistryColumnDef): string => {
    const column = rawColumn;
    if (column.filter === 'categorical') {
      const selected = getColumnCategoricalFilter(column.key);
      if (selected.length === 0) return '';
      return selected
        .map((value) => (column.options ?? []).find((o) => o.value === value)?.label ?? value)
        .join(', ');
    }
    if (column.filter === 'date' && registryUpdatedFilter?.date) {
      const when = new Date(`${registryUpdatedFilter.date}T00:00:00`);
      const formatted = Number.isNaN(when.getTime())
        ? registryUpdatedFilter.date
        : when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return `${registryUpdatedFilter.mode} ${formatted}`;
    }
    return '';
  };

  const renderColumnFilterControl = (column: RegistryColumnDef) => (
    <RegistryFilterPopover
      column={column}
      getColumnCategoricalFilter={getColumnCategoricalFilter}
      setColumnCategoricalFilter={setColumnCategoricalFilter}
      registryUpdatedFilter={registryUpdatedFilter}
      setRegistryUpdatedFilter={setRegistryUpdatedFilter}
    />
  );

  const reloadRegistry = useCallback(
    async (beforePublish?: () => void): Promise<LimsRegistrySummaryPage | null> => {
      beforePublish?.();
      const reqId = ++registryReqRef.current;
      setRegistryLoading(true);
      try {
        const filters = registryQueryFilters();
        const page = await queryLimsRegistrySummaries({
          ...currentRegistryQueryFilters.current(),
          limit: REGISTRY_PAGE_SIZE,
          offset: 0,
        });
        if (reqId !== registryReqRef.current) return null;
        const previewId = registryPreviewRef.current?.entity.id;
        let previewMatches = page.summaries.some((summary) => summary.id === previewId);

        if (previewId && !previewMatches && (!filters.ids || filters.ids.includes(previewId))) {
          const selectedPage = await queryLimsRegistrySummaries({
            ...filters,
            ids: [previewId],
            limit: 1,
            offset: 0,
          });
          previewMatches = selectedPage.summaries.some((summary) => summary.id === previewId);
        }
        if (reqId !== registryReqRef.current) return null;
        beforePublish?.();
        setRegistryPage(page);
        if (registryScrollRef.current) registryScrollRef.current.scrollTop = 0;
        setRegistryPreview((current) => {
          if (current?.entity.id !== previewId) return current;
          return previewMatches ? current : null;
        });
        return page;
      } finally {
        if (reqId === registryReqRef.current) setRegistryLoading(false);
      }
    },
    []
  );

  const loadMoreRegistry = useCallback(async () => {
    if (registryLoading || registryLoadingMore) return;
    if (registryPage.summaries.length >= registryPage.totalCount) return;
    const reqId = registryReqRef.current;
    setRegistryLoadingMore(true);
    try {
      const page = await queryLimsRegistrySummaries({
        ...registryQueryFilters(),
        limit: REGISTRY_PAGE_SIZE,
        offset: registryPage.summaries.length,
      });
      setRegistryPage((current) => {
        if (reqId !== registryReqRef.current) return current;
        const seen = new Set(current.summaries.map((summary) => summary.id));
        return {
          ...page,
          summaries: [
            ...current.summaries,
            ...page.summaries.filter((summary) => !seen.has(summary.id)),
          ],
        };
      });
    } finally {
      setRegistryLoadingMore(false);
    }
  }, [
    registryLoading,
    registryLoadingMore,
    registryPage.summaries.length,
    registryPage.totalCount,
    registryQueryFilters,
  ]);

  useEffect(() => {
    loadMoreRegistryRef.current = () => {
      void loadMoreRegistry();
    };
  }, [loadMoreRegistry]);

  const registryHasMore = registryPage.summaries.length < registryPage.totalCount;

  const multiSheetTotalCount = (() => {
    const review = workbookReview;
    if (!review) return 0;
    const schema = limsSchemas.find((s) => s.entityKind === review.kind);
    return review.tabs
      .filter((tab) => tab.selected)
      .reduce((sum, tab) => {
        const plan = tab.sheetName === review.activeSheet ? (preview ?? tab.plan) : tab.plan;
        if (!plan) return sum;
        return sum + computeImportPlanView(plan, idSchemes, undefined, schema).acceptedCount;
      }, 0);
  })();

  useEffect(() => {
    const sentinel = registrySentinelRef.current;

    if (!sentinel || !registryOverlayMounted || !registryHasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRegistryRef.current();
      },
      { root: registryScrollRef.current ?? null, rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [registryOverlayMounted, registryHasMore]);

  useEffect(() => {
    void reloadRegistry();
  }, [reloadRegistry, registryQueryFilters]);

  useEffect(() => {
    let active = true;
    void getLimsSchemas()
      .then((schemas) => {
        if (active) setLimsSchemas(schemas);
      })
      .catch(() => {
        if (active) setLimsSchemas([]);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (registryExpanded) {
      setRegistryOverlayMounted(true);
      const raf = requestAnimationFrame(() => setRegistryOverlayShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setRegistryOverlayShown(false);

    const timer = window.setTimeout(() => setRegistryOverlayMounted(false), 260);
    return () => window.clearTimeout(timer);
  }, [registryExpanded]);

  useEffect(() => {
    if (!registryMorphing) return;
    const timer = window.setTimeout(() => setRegistryMorphing(false), 220);
    return () => window.clearTimeout(timer);
  }, [registryExpanded, registryMorphing]);

  useLayoutEffect(() => {
    useLimsOverlayStore.getState().setActive(registryExpanded || registryOverlayMounted);
  }, [registryExpanded, registryOverlayMounted]);
  useEffect(() => () => useLimsOverlayStore.getState().setActive(false), []);

  useEffect(() => {
    const sentinel = registryCompactSentinelRef.current;
    if (!sentinel || registryExpanded || !registryHasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRegistryRef.current();
      },
      { root: registryCompactScrollRef.current ?? null, rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [registryExpanded, registryHasMore]);

  useEffect(() => {
    if (!openFilterKey) return;
    const activeKey = openFilterKey;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;

      if (target?.closest('[data-testid^="lims-registry-filter-toggle-"]')) return;
      if (filterPopoverRef.current && !filterPopoverRef.current.contains(target as Node)) {
        setOpenFilterKey(null);
      }

      const activeColumn = registryColumns.find((c) => c.key === activeKey);
      if (
        activeColumn?.filter === 'text' &&
        !target?.closest('[data-testid^="lims-registry-filter-input-"]')
      ) {
        setColumnTextFilter(activeKey, '');
        setOpenFilterKey(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenFilterKey(null);
    };
    document.addEventListener('mousedown', onDown);
    presentationEvents.add(document, 'keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      presentationEvents.remove(document, 'keydown', onKey);
    };
  }, [openFilterKey, registryColumns, presentationEvents]);

  useEffect(() => {
    if (!sortMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setSortMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSortMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    presentationEvents.add(document, 'keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      presentationEvents.remove(document, 'keydown', onKey);
    };
  }, [sortMenuOpen, presentationEvents]);

  useEffect(() => {
    if (!registryExpanded || preview) return;
    return scheduleFocus(registrySearchRef.current);
  }, [preview, registryExpanded]);

  const handleImportFile = useCallback(
    async (file: File) => {
      setMessage(null);
      setLastImportBatch(null);

      const doorKind = chosenKindRef.current;
      if (!doorKind) return;

      const forcedKind: LimsEntityKind | undefined = doorKind === 'sequence' ? undefined : doorKind;
      const { fileName, isWorkbook, text, arrayBuffer, sourcePath } = await resolveImportSource(
        { kind: 'file', file },
        (f) => platform().workspace.getPathForFile(f)
      );

      pendingSequenceSourcePathRef.current = sourcePath;
      pendingSequenceContentRef.current = text;
      pendingImportArrayBufferRef.current = arrayBuffer;
      const nextPreview = await createLimsImportPlan({
        fileName,
        sourcePath,
        forcedKind,
        text,
        arrayBuffer,
      });

      if (isWorkbook && arrayBuffer && forcedKind) {
        const sheets = listImportableSheets(nextPreview.sheetDispositions);
        if (sheets.length > 1) {
          const tabs: WorkbookReviewTab[] = await Promise.all(
            sheets.map(async (sheet) => {
              try {
                const plan = await createLimsImportPlan({
                  fileName,
                  sourcePath,
                  forcedKind,
                  arrayBuffer,
                  sheetName: sheet.sheetName,
                });
                return {
                  sheetName: sheet.sheetName,
                  verdict: sheet.verdict,
                  rowCount: sheet.rowCount,
                  selected: true,
                  plan,
                };
              } catch (error) {
                return {
                  sheetName: sheet.sheetName,
                  verdict: sheet.verdict,
                  rowCount: sheet.rowCount,
                  selected: true,
                  plan: null,
                  planError: errorMessageText(error),
                };
              }
            })
          );
          const activeSheet = sheets[0].sheetName;
          const review: WorkbookReviewState = {
            fileName,
            arrayBuffer,
            sourcePath,
            kind: forcedKind,
            schemas: limsSchemas,
            tabs,
            activeSheet,
            gridPreviews: buildWorkbookSheetPreviews(
              arrayBuffer,
              sheets.map((sheet) => sheet.sheetName),
              { maxRows: 50, maxCols: 40 }
            ),
            phase: 'review',
          };
          workbookReviewRef.current = review;
          setWorkbookReview(review);

          const activePlan = tabs[0]?.plan ?? null;
          previewRef.current = activePlan;
          setPreview(activePlan);
          setImportPlanDirty(false);
          setWizardStep('file');
          return;
        }
      }

      previewRef.current = nextPreview;
      setPreview(nextPreview);
      setImportPlanDirty(false);
      setWizardStep('review');
    },
    [limsSchemas]
  );

  const handlePasteImport = useCallback(
    async (raw: string, hasHeader: boolean) => {
      setMessage(null);
      setLastImportBatch(null);
      const doorKind = chosenKindRef.current;

      if (!doorKind || doorKind === 'sequence' || isRegisterableOpenSequenceKind(doorKind)) return;
      const forcedKind: LimsEntityKind = doorKind;
      const { fileName, text } = await resolveImportSource(
        { kind: 'paste', text: raw, kindLabel: forcedKind },
        (file) => platform().workspace.getPathForFile(file)
      );

      pendingSequenceSourcePathRef.current = undefined;
      pendingSequenceContentRef.current = text;
      pendingImportArrayBufferRef.current = undefined;
      const nextPreview = await createLimsImportPlan({ fileName, forcedKind, text, hasHeader });
      previewRef.current = nextPreview;
      setPreview(nextPreview);
      setImportPlanDirty(false);
      setWizardStep('review');
    },
    [limsSchemas]
  );

  const openReviewScenario = useCallback(async (fileName: string, text: string) => {
    setMessage(null);
    setLastImportBatch(null);
    const nextPreview = await createLimsImportPlan({ fileName, text, forcedKind: 'oligo' });
    setChosenKind('oligo');
    chosenKindRef.current = 'oligo';
    previewRef.current = nextPreview;
    setPreview(nextPreview);
    setImportPlanDirty(false);
    setWizardStep('review');
    setRegistryExpanded(false);
  }, []);
  const openPrimerCsvScenario = useCallback(
    () => openReviewScenario(PRIMER_CSV_SCENARIO_SOURCE_NAME, PRIMER_CSV_SCENARIO_TEXT),
    [openReviewScenario]
  );
  const openMessyPrimerCsvScenario = useCallback(
    () => openReviewScenario(MESSY_PRIMER_CSV_SCENARIO_SOURCE_NAME, MESSY_PRIMER_CSV_SCENARIO_TEXT),
    [openReviewScenario]
  );

  const startImport = useCallback((initialDestinationPath: string | null = null) => {
    setMessage(null);
    void getLimsSchemas()
      .then(setLimsSchemas)
      .catch(() => {});
    setChosenKind(null);
    chosenKindRef.current = null;
    setWorkbookReview(null);
    workbookReviewRef.current = null;
    setPreview(null);
    previewRef.current = null;

    setDestinationRoot(initialDestinationPath);
    setImportPlanDirty(false);

    pendingDropFileRef.current = null;
    setWizardStep('type');
  }, []);

  const handleDroppedFileToOpen = useCallback(
    (file: File) => {
      startImport();
      pendingDropFileRef.current = file;
    },
    [startImport]
  );

  const chooseType = useCallback(
    (kind: ImportDoorKind) => {
      setChosenKind(kind);
      chosenKindRef.current = kind;
      setPreview(null);
      previewRef.current = null;
      setWorkbookReview(null);
      workbookReviewRef.current = null;
      setImportPlanDirty(false);

      const pendingFile = pendingDropFileRef.current;
      if (pendingFile) {
        pendingDropFileRef.current = null;
        void handleImportFile(pendingFile);
        return;
      }
      setWizardStep('file');
    },
    [handleImportFile]
  );

  useEffect(() => {
    if (!sharedImportLaunch) return;
    startImport(sharedImportLaunch.destinationPath);
    if (sharedImportLaunch.kind) chooseType(sharedImportLaunch.kind);
    consumeSharedImportLaunch(sharedImportLaunch.requestId);
  }, [chooseType, consumeSharedImportLaunch, sharedImportLaunch, startImport]);

  const gotoWizardStep = useCallback(
    (step: WizardStep) => {
      if (step === 'type') {
        if (importPlanDirty && !window.confirm('Discard changes to this import?')) return;
        setChosenKind(null);
        chosenKindRef.current = null;
        setPreview(null);
        previewRef.current = null;
        setWorkbookReview(null);
        workbookReviewRef.current = null;
        setImportPlanDirty(false);
      }
      setWizardStep(step);
    },
    [importPlanDirty]
  );

  const workspaceNameForRoot = useCallback(
    (root: string): string | null => folders.find((folder) => folder.path === root)?.name ?? null,
    [folders]
  );

  const applySequenceFileImport = useCallback(
    async (currentPreview: LimsImportPlan, sourceName: string) => {
      const telemetry = startLimsImport([sourceName]);
      const record = currentPreview.records[0];
      const draftSequence = record?.entityDraft.fields.sequence as
        | { mode?: string; relPath?: string }
        | undefined;

      const sourcePath =
        (draftSequence?.mode === 'file' ? draftSequence.relPath : undefined) ??
        pendingSequenceSourcePathRef.current;

      const pendingContent = pendingSequenceContentRef.current;
      if (!sourcePath && !pendingContent) {
        finishLimsImport(telemetry, {
          importedCount: 0,
          failure: { stage: 'validate', errorClass: 'sequence_source_missing' },
        });
        setMessageTone('error');
        setMessage(
          userMessage(
            'registry.notice.cannot-register-this-sequence-no-source-file-or-content-re-drop-the-file-to-impo'
          )
        );
        return;
      }

      const kind: RegisterableSequenceKind = 'sequence';
      const previewFileContentHash = record?.source.fileContentHash;
      const expectedSourceSha256 =
        typeof previewFileContentHash === 'string' &&
        /^sha256:[0-9a-f]{64}$/i.test(previewFileContentHash)
          ? previewFileContentHash.slice('sha256:'.length)
          : undefined;

      let targetRoot = destinationRoot;
      let createdWorkspaceName: string | null = null;
      const mintWorkspace = async (): Promise<void> => {
        const minted = await createTrackedEmptyWorkspace({ name: DEFAULT_PROJECT_DISPLAY_NAME });
        targetRoot = minted.rootPath;
        createdWorkspaceName = minted.displayName;
      };
      if (!targetRoot) {
        try {
          await mintWorkspace();
        } catch (error) {
          finishLimsImport(telemetry, {
            importedCount: 0,
            failure: { stage: 'write', errorClass: 'workspace_create_failed' },
          });
          throw error;
        }
      }

      setMessage(
        userMessageWithValues('registry.notice.importing-into', {
          value0: userMessageValue(
            createdWorkspaceName ?? workspaceNameForRoot(targetRoot!) ?? 'project'
          ),
        })
      );

      const runRegister = (): Promise<RegisterImportedSequenceResult> =>
        sourcePath
          ? platform().workspace.registerImportedSequence({
              sourcePath,
              targetRoot: targetRoot!,
              kind,
              expectedSourceSha256,
            })
          : platform().workspace.registerImportedSequenceFromContent({
              content: pendingContent!,
              fileName: sourceName,
              targetRoot: targetRoot!,
              kind,
              expectedSourceSha256,
            });

      let result: RegisterImportedSequenceResult;
      try {
        try {
          result = await runRegister();
        } catch (err) {
          if (/unknown (?:workspace|project) root/i.test(errorMessageText(err))) {
            await mintWorkspace();
            result = await runRegister();
          } else {
            throw err;
          }
        }
      } catch (err) {
        finishLimsImport(telemetry, {
          importedCount: 0,
          failure: { stage: 'write', errorClass: 'sequence_registration_failed' },
        });
        setMessageTone('error');
        setMessage(toUserMessage(err, 'registry.importFailed'));
        setPreview(null);
        setChosenKind(null);
        chosenKindRef.current = null;
        setWizardStep(null);
        setDestinationRoot(null);
        setImportPlanDirty(false);
        await reloadRegistry();
        setRegistryMorphRect(measurePanelRect());
        setRegistryExpanded(true);
        return;
      }

      pendingSequenceSourcePathRef.current = undefined;
      pendingSequenceContentRef.current = undefined;

      if (result.registered) {
        finishLimsImport(telemetry, { importedCount: result.entityIds.length });
        setMessage(
          userMessageWithValues('registry.notice.imported-into', {
            value0: userMessageValue(record?.entityDraft.name ?? sourceName),
            value1: userMessageValue(
              createdWorkspaceName ?? workspaceNameForRoot(targetRoot!) ?? 'the project'
            ),
          })
        );

        if (result.batchId) setLastImportBatch({ batchId: result.batchId, sourceName });
      } else {
        finishLimsImport(telemetry, {
          importedCount: 1,
          failure: { stage: 'validate', errorClass: 'sequence_not_registered' },
        });
        setMessageTone('error');
        setMessage(sequenceRegistrationFailureMessage(result));
      }

      setPreview(null);
      setChosenKind(null);
      chosenKindRef.current = null;
      setWizardStep(null);
      setDestinationRoot(null);
      setImportPlanDirty(false);
      try {
        emitLimsRegistrationChanged();
        await reloadRegistry();

        window.dispatchEvent(
          new CustomEvent('waypoint:workspace-files-changed', {
            detail: {
              workspaceRoot: targetRoot,
              createdNewWorkspace: Boolean(createdWorkspaceName),
              createdWorkspaceName,
              revealPath: result.destPath,
            },
          })
        );
        setRegistryMorphRect(measurePanelRect());
        setRegistryExpanded(true);
      } catch (error) {
        setMessageTone('error');
        setMessage(toUserMessage(error, 'registry.refreshFailed'));
        setRegistryMorphRect(measurePanelRect());
        setRegistryExpanded(true);
      }
    },
    [folders, destinationRoot, measurePanelRect, reloadRegistry, workspaceNameForRoot]
  );

  const applyPrimerFileImport = useCallback(
    async (currentPreview: LimsImportPlan) => {
      const telemetry = startLimsImport([currentPreview.sourceName]);
      const orderLabel = currentPreview.records.some(
        (record) => record.entityDraft.kind === 'rna_oligo'
      )
        ? 'RNA oligos'
        : 'DNA oligos';
      let targetRoot = destinationRoot;
      let createdWorkspaceName: string | null = null;

      if (!targetRoot) {
        try {
          const minted = await createTrackedEmptyWorkspace({ name: DEFAULT_PROJECT_DISPLAY_NAME });
          targetRoot = minted.rootPath;
          createdWorkspaceName = minted.displayName;
        } catch (error) {
          finishLimsImport(telemetry, {
            importedCount: 0,
            failure: { stage: 'write', errorClass: 'workspace_create_failed' },
          });
          throw error;
        }
      }
      setMessage(
        userMessageWithValues('registry.notice.importing-into-1', {
          value0: userMessageValue(orderLabel),
          value1: userMessageValue(
            createdWorkspaceName ?? workspaceNameForRoot(targetRoot) ?? 'project'
          ),
        })
      );
      const workspaceRoot = findContainingPathBoundary(folders, targetRoot)?.path ?? targetRoot;
      let summary: Awaited<ReturnType<typeof recordImportedPrimers>>;
      try {
        const sourcePath = pendingSequenceSourcePathRef.current;
        const text = pendingSequenceContentRef.current;
        const arrayBuffer = pendingImportArrayBufferRef.current;
        summary = await recordImportedPrimers(currentPreview, {
          workspaceRoot,
          destinationDir: targetRoot,
          source: {
            ...(sourcePath ? { sourcePath } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(arrayBuffer ? { arrayBuffer } : {}),
          },
        });
      } catch (err) {
        finishLimsImport(telemetry, {
          importedCount: 0,
          failure: { stage: 'write', errorClass: 'primer_import_failed' },
        });
        setMessageTone('error');
        setMessage(toUserMessage(err, 'registry.importFailed'));
        return;
      }
      finishLimsImport(telemetry, {
        importedCount: summary.added,
        failure:
          summary.failed > 0 ? { stage: 'write', errorClass: 'primer_items_failed' } : undefined,
      });

      setMessageTone(
        summary.importSetError || (summary.failed > 0 && summary.added === 0) ? 'error' : 'success'
      );
      setMessage(
        userMessageWithValues('registry.notice.entities-0-links-skipped', {
          value0: userMessageValue(summary.added),
          value1: userMessageValue(summary.skipped),
          value2: userMessageValue(summary.failed ? ` (${summary.failed} failed)` : ''),
          value3: userMessageValue(
            summary.importSetError
              ? ` — entities were saved, but spreadsheet provenance failed: ${toUserMessage(summary.importSetError, 'registry.provenanceFailed')}`
              : ''
          ),
        })
      );
      emitLimsRegistrationChanged();
      await reloadRegistry();

      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-files-changed', {
          detail: { workspaceRoot },
        })
      );
      previewRef.current = null;
      setPreview(null);
      setChosenKind(null);
      chosenKindRef.current = null;
      setWizardStep(null);
      setDestinationRoot(null);
      pendingSequenceSourcePathRef.current = undefined;
      pendingSequenceContentRef.current = undefined;
      pendingImportArrayBufferRef.current = undefined;
      setImportPlanDirty(false);

      setRegistryMorphRect(measurePanelRect());
      setRegistryExpanded(true);
    },
    [destinationRoot, folders, measurePanelRect, reloadRegistry, workspaceNameForRoot]
  );

  const applyProteinFileImport = useCallback(
    async (currentPreview: LimsImportPlan) => {
      const telemetry = startLimsImport([currentPreview.sourceName]);
      let destinationDir = destinationRoot;
      if (!destinationDir) {
        const minted = await createTrackedEmptyWorkspace({ name: DEFAULT_PROJECT_DISPLAY_NAME });
        destinationDir = minted.rootPath;
      }
      const workspaceRoot =
        findContainingPathBoundary(folders, destinationDir)?.path ?? destinationDir;
      const sourcePath = pendingSequenceSourcePathRef.current;
      const text = pendingSequenceContentRef.current;
      const arrayBuffer = pendingImportArrayBufferRef.current;
      let summary: Awaited<ReturnType<typeof recordImportedProteins>>;
      try {
        summary = await recordImportedProteins(currentPreview, {
          workspaceRoot,
          destinationDir,
          source: {
            ...(sourcePath ? { sourcePath } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(arrayBuffer ? { arrayBuffer } : {}),
          },
        });
      } catch (error) {
        finishLimsImport(telemetry, {
          importedCount: 0,
          failure: { stage: 'write', errorClass: 'protein_import_failed' },
        });
        setMessageTone('error');
        setMessage(toUserMessage(error, 'registry.importFailed'));
        return;
      }
      finishLimsImport(telemetry, {
        importedCount: summary.added,
        failure:
          summary.failed > 0 ? { stage: 'write', errorClass: 'protein_items_failed' } : undefined,
      });
      setMessageTone(
        summary.importSetError || summary.reconciliationRequired.length > 0 || summary.failed > 0
          ? 'error'
          : 'success'
      );
      setMessage(
        userMessageWithValues('registry.notice.entities-0-links-skipped-2', {
          value0: userMessageValue(summary.added),
          value1: userMessageValue(summary.skipped),
          value2: userMessageValue(summary.failed ? ` (${summary.failed} failed)` : ''),
          value3: userMessageValue(
            summary.reconciliationRequired.length > 0
              ? ` (${summary.reconciliationRequired.length} saved; Registry reconciliation required)`
              : ''
          ),
          value4: userMessageValue(
            summary.importSetError
              ? ` — proteins were saved, but spreadsheet provenance failed: ${toUserMessage(summary.importSetError, 'registry.provenanceFailed')}`
              : ''
          ),
        })
      );
      emitLimsRegistrationChanged();
      try {
        await reloadRegistry();
        window.dispatchEvent(
          new CustomEvent('waypoint:workspace-files-changed', {
            detail: { workspaceRoot, revealPath: summary.artifactRelativePaths[0] ?? null },
          })
        );
      } catch (error) {
        setMessageTone('error');
        setMessage(toUserMessage(error, 'registry.refreshFailed'));
      }
      previewRef.current = null;
      setPreview(null);
      setChosenKind(null);
      chosenKindRef.current = null;
      setWizardStep(null);
      setDestinationRoot(null);
      pendingSequenceSourcePathRef.current = undefined;
      pendingSequenceContentRef.current = undefined;
      pendingImportArrayBufferRef.current = undefined;
      setImportPlanDirty(false);
      setRegistryMorphRect(measurePanelRect());
      setRegistryExpanded(true);
    },
    [destinationRoot, folders, measurePanelRect, reloadRegistry]
  );

  const saveActiveTabIntoReview = useCallback(
    (review: WorkbookReviewState): WorkbookReviewState => {
      const activePlan = previewRef.current;
      if (!activePlan) return review;
      return {
        ...review,
        tabs: review.tabs.map((tab) =>
          tab.sheetName === review.activeSheet ? { ...tab, plan: activePlan } : tab
        ),
      };
    },
    []
  );

  const commitReview = useCallback((review: WorkbookReviewState) => {
    workbookReviewRef.current = review;
    setWorkbookReview(review);
  }, []);

  const selectReviewTab = useCallback(
    async (sheetName: string) => {
      const before = workbookReviewRef.current;
      if (!before || before.activeSheet === sheetName || before.phase !== 'review') return;
      await importMappingQueueRef.current;
      const review = workbookReviewRef.current;
      if (!review || review.activeSheet === sheetName || review.phase !== 'review') return;
      const saved = saveActiveTabIntoReview(review);
      const next = { ...saved, activeSheet: sheetName };
      commitReview(next);
      const incoming = next.tabs.find((tab) => tab.sheetName === sheetName)?.plan ?? null;
      previewRef.current = incoming;
      setPreview(incoming);
      setImportPlanDirty(false);
    },
    [saveActiveTabIntoReview, commitReview]
  );

  const toggleReviewTabSelected = useCallback((sheetName: string) => {
    setWorkbookReview((review) => {
      if (!review || review.phase !== 'review') return review;
      const next = {
        ...review,
        tabs: review.tabs.map((tab) =>
          tab.sheetName === sheetName ? { ...tab, selected: !tab.selected } : tab
        ),
      };
      workbookReviewRef.current = next;
      return next;
    });
  }, []);

  const cancelReview = useCallback(() => {
    for (const tab of workbookReviewRef.current?.tabs ?? [])
      if (tab.plan)
        void cancelLimsImportReview(tab.plan).catch((error) =>
          setMessage(toUserMessage(error, 'registry.importFailed'))
        );
    workbookReviewRef.current = null;
    setWorkbookReview(null);
    previewRef.current = null;
    setPreview(null);
    setChosenKind(null);
    chosenKindRef.current = null;
    setWizardStep(null);
    setImportPlanDirty(false);
  }, []);

  const finishReview = useCallback(() => {
    cancelReview();
    setRegistryMorphRect(measurePanelRect());
    setRegistryExpanded(true);
  }, [cancelReview, measurePanelRect]);

  const importAllReviewTabs = useCallback(async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    try {
      await importMappingQueueRef.current;
      const base = workbookReviewRef.current;
      if (!base) return;
      const review = saveActiveTabIntoReview(base);
      const telemetry = startLimsImport([review.fileName]);

      const isPrimerImport = review.kind === 'oligo' || review.kind === 'rna_oligo';
      const isProteinImport = review.kind === 'protein';
      let targetRoot = destinationRoot;
      if (!targetRoot) {
        try {
          const minted = await createTrackedEmptyWorkspace({ name: DEFAULT_PROJECT_DISPLAY_NAME });
          targetRoot = minted.rootPath;
        } catch (error) {
          finishLimsImport(telemetry, {
            importedCount: 0,
            failure: { stage: 'write', errorClass: 'workspace_create_failed' },
          });
          throw error;
        }
      }
      const workspaceRoot = findContainingPathBoundary(folders, targetRoot)?.path ?? targetRoot;
      let fileProvenance: LimsImportFileProvenance | undefined;
      if (
        !platform().runtime.getProfile().isElectron &&
        (review.sourcePath || review.arrayBuffer)
      ) {
        if (!isPrimerImport) {
          try {
            const copy = await copyTabularSourceIntoWorkspace(targetRoot, {
              fileName: review.fileName,
              sourcePath: review.sourcePath,
              arrayBuffer: review.arrayBuffer,
            });
            fileProvenance = {
              managedRelPath: pathRelativeToBoundary(copy.destPath, workspaceRoot) ?? copy.relPath,
              workspaceRootPath: workspaceRoot,
            };
          } catch (error) {
            finishLimsImport(telemetry, {
              importedCount: 0,
              failure: { stage: 'write', errorClass: 'tabular_copy_failed' },
            });
            setMessageTone('error');
            setMessage(toUserMessage(error, 'registry.importFailed'));
            return;
          }
        }
      }
      const importing = { ...review, phase: 'importing' as const };
      commitReview(importing);

      let importedAny = false;
      let importedCount = 0;
      let failedCount = 0;
      let firstArtifactPath: string | null = null;
      const importedPrimerPartitions: ImportedPrimerImportPartition[] = [];
      const importedProteinPartitions: ImportedProteinImportPartition[] = [];
      const importedEntityPartitions: ImportedEntityImportPartition[] = [];
      const tabs: WorkbookReviewTab[] = [];
      for (const tab of importing.tabs) {
        if (!tab.selected) {
          tabs.push({ ...tab, outcome: undefined });
          continue;
        }

        let plan = tab.plan;
        if (!plan) {
          try {
            plan = await createLimsImportPlan({
              fileName: importing.fileName,
              sourcePath: importing.sourcePath,
              forcedKind: importing.kind,
              arrayBuffer: importing.arrayBuffer,
              sheetName: tab.sheetName,
            });
          } catch (error) {
            failedCount += 1;
            tabs.push({
              ...tab,
              outcome: {
                sheetName: tab.sheetName,
                status: 'failed',
                added: 0,
                skipped: 0,
                flagged: 0,
                error: toUserMessage(errorMessageText(error), 'operation.failed'),
              },
            });
            continue;
          }
        }
        try {
          if (isPrimerImport) {
            const summary = await recordImportedPrimers(plan, {
              workspaceRoot,
              destinationDir: targetRoot,
              persistImportSet: false,
            });
            if (summary.members.length > 0) importedPrimerPartitions.push(summary.partition);
            firstArtifactPath ??= summary.artifactRelativePaths[0] ?? null;
            importedAny = true;
            importedCount += summary.added;
            failedCount += summary.failed;
            tabs.push({
              ...tab,
              plan,
              outcome: {
                sheetName: tab.sheetName,
                status: 'imported',
                kind: review.kind,
                added: summary.added,
                skipped: summary.skipped,
                flagged: summary.failed,
              },
            });
            continue;
          }
          if (isProteinImport) {
            const summary = await recordImportedProteins(plan, {
              workspaceRoot,
              destinationDir: targetRoot,
              fileProvenance,
              persistImportSet: false,
            });
            if (summary.members.length > 0) importedProteinPartitions.push(summary.partition);
            firstArtifactPath ??= summary.artifactRelativePaths[0] ?? null;
            importedAny = true;
            importedCount += summary.added;
            failedCount += summary.failed;
            tabs.push({
              ...tab,
              plan,
              outcome: {
                sheetName: tab.sheetName,
                status: 'imported',
                kind: 'protein',
                added: summary.added,
                skipped: summary.skipped,
                flagged: summary.failed + summary.reconciliationRequired.length,
              },
            });
            continue;
          }
          const recorded = await recordImportedEntityArtifacts({
            plan,
            workspaceRoot,
            destinationDir: targetRoot,
            fileProvenance,
            persistImportSet: false,
          });
          const result = recorded.applyResult;
          if (recorded.members.length > 0) importedEntityPartitions.push(recorded.partition);
          firstArtifactPath ??= recorded.artifactPaths[0] ?? null;
          importedAny = true;
          importedCount += result.insertedEntities;
          const flagged = plan.records.filter(
            (r) =>
              r.accepted &&
              r.action === 'create' &&
              r.entityDraft.registrationStatus === 'unresolved'
          ).length;
          tabs.push({
            ...tab,
            plan,
            outcome: {
              sheetName: tab.sheetName,
              status: 'imported',
              kind: plan.records.find((r) => r.accepted)?.entityDraft.kind ?? importing.kind,
              added: result.insertedEntities,
              skipped: result.skipped,
              flagged,
            },
          });
        } catch (error) {
          failedCount += 1;
          tabs.push({
            ...tab,
            plan,
            outcome: {
              sheetName: tab.sheetName,
              status: 'failed',
              added: 0,
              skipped: 0,
              flagged: 0,
              error: toUserMessage(errorMessageText(error), 'operation.failed'),
            },
          });
        }
      }

      if (isPrimerImport && importedPrimerPartitions.length > 0) {
        try {
          await persistImportedPrimerImportSet({
            partitions: importedPrimerPartitions,
            workspaceRoot,
            destinationDir: targetRoot,
            source: {
              ...(review.sourcePath ? { sourcePath: review.sourcePath } : {}),
              ...(review.arrayBuffer ? { arrayBuffer: review.arrayBuffer } : {}),
            },
            commitMessage: `Record ${importedPrimerPartitions.length}-sheet oligo import set`,
          });
        } catch (error) {
          failedCount += 1;
          setMessageTone('error');
          setMessage(toUserMessage(error, 'registry.provenanceFailed'));
        }
      }
      if (isProteinImport && importedProteinPartitions.length > 0 && failedCount === 0) {
        try {
          await persistImportSet({
            partitions: importedProteinPartitions,
            workspaceRoot,
            destinationDir: targetRoot,
            source: {
              ...(review.sourcePath ? { sourcePath: review.sourcePath } : {}),
              ...(review.arrayBuffer ? { arrayBuffer: review.arrayBuffer } : {}),
            },
            commitMessage: `Record ${importedProteinPartitions.length}-sheet protein import set`,
          });
        } catch (error) {
          failedCount += 1;
          setMessageTone('error');
          setMessage(toUserMessage(error, 'registry.provenanceFailed'));
        }
      }
      if (!isPrimerImport && !isProteinImport && importedEntityPartitions.length > 0) {
        try {
          await persistImportSet({
            partitions: importedEntityPartitions,
            workspaceRoot,
            destinationDir: targetRoot,
            source: {
              ...(review.sourcePath ? { sourcePath: review.sourcePath } : {}),
              ...(review.arrayBuffer ? { arrayBuffer: review.arrayBuffer } : {}),
            },
            commitMessage: `Record ${importedEntityPartitions.length}-sheet entity import set`,
          });
        } catch (error) {
          failedCount += 1;
          setMessageTone('error');
          setMessage(toUserMessage(error, 'registry.provenanceFailed'));
        }
      }

      finishLimsImport(telemetry, {
        importedCount,
        failure:
          failedCount > 0 ? { stage: 'write', errorClass: 'workbook_items_failed' } : undefined,
      });

      if (importedAny) {
        emitLimsRegistrationChanged();
        await reloadRegistry();

        const revealPath = firstArtifactPath ?? fileProvenance?.managedRelPath;
        if (revealPath) {
          window.dispatchEvent(
            new CustomEvent('waypoint:workspace-files-changed', {
              detail: {
                workspaceRoot,
                revealPath: revealPath ?? fileProvenance?.managedRelPath ?? null,
              },
            })
          );
        }
        setDestinationRoot(null);
      }

      if (workbookReviewRef.current !== importing) return;
      const done: WorkbookReviewState = { ...importing, tabs, phase: 'done' };
      commitReview(done);
      previewRef.current = null;
      setPreview(null);
      setImportPlanDirty(false);
    } finally {
      applyingRef.current = false;
    }
  }, [saveActiveTabIntoReview, commitReview, reloadRegistry, destinationRoot, folders]);

  const applyImport = useCallback(async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    try {
      await importMappingQueueRef.current;
      const currentPreview = previewRef.current ?? preview;
      if (!currentPreview) return;
      const sourceName = currentPreview.sourceName;
      setMessageTone('success');
      if (currentPreview.review) {
        const telemetry = startLimsImport([sourceName]);
        let targetRoot = destinationRoot;
        if (!targetRoot)
          targetRoot = (await createTrackedEmptyWorkspace({ name: DEFAULT_PROJECT_DISPLAY_NAME }))
            .rootPath;
        const workspaceRoot = findContainingPathBoundary(folders, targetRoot)?.path ?? targetRoot;
        let document;
        try {
          document = await applyLimsImportReview(currentPreview, workspaceRoot, targetRoot);
        } catch (error) {
          finishLimsImport(telemetry, {
            importedCount: 0,
            failure: { stage: 'write', errorClass: 'import_review_apply_failed' },
          });
          setMessageTone('error');
          setMessage(toUserMessage(error, 'registry.importFailed'));
          return;
        }
        const receipt = document.receipt!;
        const partialErrorClass = currentPreview.records.some(
          (record) => record.accepted && record.entityDraft.kind === 'protein'
        )
          ? 'protein_items_failed'
          : currentPreview.records.some(
                (record) =>
                  record.accepted &&
                  (record.entityDraft.kind === 'oligo' || record.entityDraft.kind === 'rna_oligo')
              )
            ? 'primer_items_failed'
            : 'import_review_partial';
        finishLimsImport(telemetry, {
          importedCount: receipt.imported,
          hasDurableWrite: receipt.changed === true && receipt.artifactPaths.length > 0,
          ...(receipt.failed
            ? { failure: { stage: 'write' as const, errorClass: partialErrorClass } }
            : {}),
        });
        setMessageTone(receipt.failed ? 'error' : 'success');
        setMessage(importReceiptMessage(receipt));
        if (receipt.batchId) setLastImportBatch({ batchId: receipt.batchId, sourceName });
        emitLimsRegistrationChanged();
        try {
          await reloadRegistry();
        } catch (error) {
          setMessageTone('error');
          setMessage(toUserMessage(error, 'registry.refreshFailed'));
        }
        window.dispatchEvent(
          new CustomEvent('waypoint:workspace-files-changed', {
            detail: { workspaceRoot, revealPath: receipt.artifactPaths[0] ?? null },
          })
        );
        previewRef.current = null;
        setPreview(null);
        setChosenKind(null);
        chosenKindRef.current = null;
        setWizardStep(null);
        setDestinationRoot(null);
        setImportPlanDirty(false);
        setRegistryMorphRect(measurePanelRect());
        setRegistryExpanded(true);
        return;
      }

      const hasAcceptedDnaSequenceRecord = currentPreview.records.some(
        (record) => record.accepted && isRegisterableOpenSequenceKind(record.entityDraft.kind)
      );
      if (
        (currentPreview.sourceKind === 'genbank' || currentPreview.sourceKind === 'fasta') &&
        hasAcceptedDnaSequenceRecord
      ) {
        await applySequenceFileImport(currentPreview, sourceName);
        return;
      }

      if (
        currentPreview.records.some(
          (r) =>
            r.accepted &&
            r.action === 'create' &&
            (r.entityDraft.kind === 'oligo' || r.entityDraft.kind === 'rna_oligo')
        )
      ) {
        await applyPrimerFileImport(currentPreview);
        return;
      }
      if (
        currentPreview.records.some(
          (record) =>
            record.accepted && record.action === 'create' && record.entityDraft.kind === 'protein'
        )
      ) {
        await applyProteinFileImport(currentPreview);
        return;
      }
      const telemetry = startLimsImport([sourceName]);

      let fileProvenance: LimsImportFileProvenance | undefined;
      let tabularRoot = destinationRoot;
      if (!tabularRoot) {
        const minted = await createTrackedEmptyWorkspace({ name: DEFAULT_PROJECT_DISPLAY_NAME });
        tabularRoot = minted.rootPath;
      }
      const workspaceRoot = findContainingPathBoundary(folders, tabularRoot)?.path ?? tabularRoot;
      const srcPath = pendingSequenceSourcePathRef.current;
      const srcText = pendingSequenceContentRef.current;
      const srcBuf = pendingImportArrayBufferRef.current;
      if (!currentPreview.review && (srcPath || srcText || srcBuf)) {
        try {
          const copy = await copyTabularSourceIntoWorkspace(tabularRoot, {
            fileName: sourceName,
            sourcePath: srcPath,
            text: srcText,
            arrayBuffer: srcBuf,
          });
          fileProvenance = {
            managedRelPath: pathRelativeToBoundary(copy.destPath, workspaceRoot) ?? copy.relPath,
            workspaceRootPath: workspaceRoot,
          };
        } catch (err) {
          finishLimsImport(telemetry, {
            importedCount: 0,
            failure: { stage: 'write', errorClass: 'tabular_copy_failed' },
          });
          setMessageTone('error');
          setMessage(toUserMessage(err, 'registry.importFailed'));
          return;
        }
      }
      let recorded: Awaited<ReturnType<typeof recordImportedEntityArtifacts>>;
      try {
        recorded = await recordImportedEntityArtifacts({
          plan: currentPreview,
          workspaceRoot,
          destinationDir: tabularRoot,
          fileProvenance,
          source: {
            ...(srcPath ? { sourcePath: srcPath } : {}),
            ...(srcText !== undefined ? { text: srcText } : {}),
            ...(srcBuf ? { arrayBuffer: srcBuf } : {}),
          },
        });
      } catch (error) {
        finishLimsImport(telemetry, {
          importedCount: 0,
          failure: {
            stage: 'write',
            errorClass:
              error instanceof EntityArtifactProjectionError
                ? 'tabular_projection_failed'
                : 'tabular_artifact_write_failed',
          },
        });
        setMessageTone('error');
        setMessage(toUserMessage(error, 'registry.importFailed'));
        if (error instanceof EntityArtifactProjectionError) {
          window.dispatchEvent(
            new CustomEvent('waypoint:workspace-files-changed', {
              detail: {
                workspaceRoot,
                revealPath: error.artifactPaths[0] ?? null,
              },
            })
          );
        }
        return;
      }
      const result = recorded.applyResult;
      finishLimsImport(telemetry, { importedCount: result.insertedEntities });
      if (recorded.importSetError) {
        setMessageTone('error');
        setMessage(
          userMessageWithValues(
            'registry.notice.entities-were-saved-but-spreadsheet-provenance-failed',
            {
              value0: userMessageValue(result.insertedEntities),
              value1: userMessageValue(
                toUserMessage(recorded.importSetError, 'registry.provenanceFailed')
              ),
            }
          )
        );
      } else {
        setMessage(
          userMessageWithValues('registry.notice.entities-links-skipped', {
            value0: userMessageValue(result.insertedEntities),
            value1: userMessageValue(result.insertedLinks),
            value2: userMessageValue(result.skipped),
          })
        );
      }
      setLastImportBatch({
        batchId: result.batchId,
        sourceName,
      });
      emitLimsRegistrationChanged();
      await reloadRegistry();

      const revealPath = recorded.artifactPaths[0] ?? fileProvenance?.managedRelPath;
      if (revealPath) {
        window.dispatchEvent(
          new CustomEvent('waypoint:workspace-files-changed', {
            detail: {
              workspaceRoot,
              revealPath,
            },
          })
        );
      }

      previewRef.current = null;
      setPreview(null);
      setChosenKind(null);
      chosenKindRef.current = null;
      setWizardStep(null);
      setDestinationRoot(null);
      pendingSequenceSourcePathRef.current = undefined;
      pendingSequenceContentRef.current = undefined;
      pendingImportArrayBufferRef.current = undefined;
      setImportPlanDirty(false);
      setRegistryMorphRect(measurePanelRect());
      setRegistryExpanded(true);
    } finally {
      applyingRef.current = false;
    }
  }, [
    applySequenceFileImport,
    applyProteinFileImport,
    measurePanelRect,
    preview,
    reloadRegistry,
    destinationRoot,
    folders,
  ]);

  const enqueueImportPlanUpdate = useCallback(
    (updater: (plan: LimsImportPlan) => Promise<LimsImportPlan>) => {
      setImportPlanDirty(true);
      const task = importMappingQueueRef.current.then(async () => {
        const current = previewRef.current;
        if (!current) return;
        const next = await updater(current);

        if (previewRef.current !== current) return;
        previewRef.current = next;
        setPreview(next);
      });
      importMappingQueueRef.current = task.catch((error) => {
        setMessage(toUserMessage(error, 'registry.importFailed'));
      });
    },
    []
  );

  useEffect(() => {
    const id = preview?.review?.id;
    if (!id) return;
    let disposed = false;
    let generation = 0;
    const detach = platform().importReview.onChanged((notice) => {
      if (notice.id !== id) return;
      const requested = ++generation;
      void inspectLimsImportReview(id)
        .then(({ document, plan }) => {
          if (disposed || requested !== generation || previewRef.current?.review?.id !== id) return;
          if (document.phase === 'applied' || document.phase === 'partial') {
            if (applyingRef.current) return;
            setMessageTone(document.phase === 'partial' ? 'error' : 'success');
            setMessage(importReceiptMessage(document.receipt, false));
            previewRef.current = null;
            setPreview(null);
            setWizardStep(null);
            emitLimsRegistrationChanged();
            void reloadRegistry();
            window.dispatchEvent(
              new CustomEvent('waypoint:workspace-files-changed', {
                detail: {
                  workspaceRoot: document.workspaceRoot,
                  revealPath: document.receipt?.artifactPaths[0] ?? null,
                },
              })
            );
          } else if (document.phase === 'cancelled') {
            previewRef.current = null;
            setPreview(null);
            setWizardStep(null);
          } else {
            previewRef.current = plan;
            setPreview(plan);
            if (document.error) {
              setMessageTone('error');
              setMessage(
                document.receipt
                  ? importReceiptMessage(document.receipt, false)
                  : toUserMessage(document.error, 'registry.importFailed')
              );
            }
          }
        })
        .catch((error) => {
          if (!disposed && requested === generation)
            setMessage(toUserMessage(error, 'registry.importFailed'));
        });
    });
    return () => {
      disposed = true;
      detach();
    };
  }, [preview?.review?.id, reloadRegistry]);

  const applyImportColumnMappings = useCallback(
    (
      mappings: Array<{
        sourceColumn: string;
        mappedField?: string;
        mappingMode?: 'mapped' | 'source_only' | 'ignored';
      }>
    ) => {
      enqueueImportPlanUpdate((current) =>
        applyImportPlanColumnMappings(
          current,
          mappings.map((mapping) => ({ ...mapping, confidence: 'user_overridden' }))
        )
      );
    },
    [enqueueImportPlanUpdate]
  );

  const reloadIdSchemes = useCallback(async () => {
    try {
      setIdSchemes(await getLimsIdSchemes());
    } catch {}
  }, []);

  useEffect(() => {
    if (preview) void reloadIdSchemes();
  }, [preview?.sourceName, reloadIdSchemes]);

  const undoLastImport = useCallback(async () => {
    if (!lastImportBatch) return;
    if (!window.confirm(`Undo import from ${lastImportBatch.sourceName}?`)) return;
    let result: Awaited<ReturnType<typeof undoLimsImportBatch>>;
    try {
      result = await undoLimsImportBatch({
        batchId: lastImportBatch.batchId,
        actor: 'local-user',
      });
    } catch (error) {
      setMessageTone('error');
      setMessage(toUserMessage(error, 'registry.importFailed'));
      return;
    }
    setLastImportBatch(null);
    setMessage(
      userMessageWithValues('registry.notice.undid-import-entities-links-archived', {
        value0: userMessageValue(result.tombstonedEntities),
        value1: userMessageValue(result.tombstonedLinks),
      })
    );
    emitLimsRegistrationChanged();
    await reloadRegistry();
    setRegistryMorphRect(measurePanelRect());
    setRegistryExpanded(true);
  }, [lastImportBatch, measurePanelRect, reloadRegistry]);

  const scheduleRegistryAction = useCallback((callback: () => void, delayMs: number) => {
    let timer = 0;
    timer = window.setTimeout(() => {
      registryActionTimersRef.current.delete(timer);
      callback();
    }, delayMs);
    registryActionTimersRef.current.add(timer);
  }, []);

  useEffect(
    () => () => {
      for (const timer of registryActionTimersRef.current) window.clearTimeout(timer);
      registryActionTimersRef.current.clear();
    },
    []
  );

  const beginExpandMorph = useCallback(() => {
    setRegistryMorphRect(measurePanelRect());
    setRegistryMorphing(true);
  }, [measurePanelRect]);
  const expandRegistry = useCallback(() => {
    beginExpandMorph();
    setRegistryExpanded(true);
  }, [beginExpandMorph]);

  const selectOrganizationRecord = useCallback(
    (record: OrganizationRegistryRecord) => {
      setSelectedOrganizationRecordId(record.id);
      expandRegistry();
    },
    [expandRegistry]
  );

  const openOrganizationRecord = useCallback(
    (record?: OrganizationRegistryRecord) =>
      openOrganizationRegistryRecord(record, selectOrganizationRecord, () =>
        setRegistryExpanded(false)
      ),
    [openOrganizationRegistryRecord, selectOrganizationRecord]
  );

  const closeRegistryOverlay = useCallback(() => {
    setRegistryMorphing(true);
    setRegistryExpanded(false);
    scheduleRegistryAction(() => {
      safeFocus(document.querySelector<HTMLElement>('[data-testid="lims-registry-expand"]'));
    }, 0);
  }, [scheduleRegistryAction]);

  const dismissImportPlan = useCallback(() => {
    const current = previewRef.current;
    if (current)
      void cancelLimsImportReview(current).catch((error) =>
        setMessage(toUserMessage(error, 'registry.importFailed'))
      );
    previewRef.current = null;
    setPreview(null);
    setChosenKind(null);
    chosenKindRef.current = null;
    setWizardStep(null);
    setDestinationRoot(null);
    setImportPlanDirty(false);
    setRegistryMorphRect(measurePanelRect());
    setRegistryExpanded(true);
  }, [measurePanelRect]);

  const closeImportPlan = useCallback(() => {
    if (importPlanDirty && !window.confirm('Discard changes to this import plan?')) return;
    dismissImportPlan();
  }, [importPlanDirty, dismissImportPlan]);

  const focusRegistryRowAt = useCallback(
    (index: number) => {
      const row = registryPage.summaries[index];
      if (!row) return;
      safeFocus(registryRowRefs.current.get(row.id));
    },
    [registryPage.summaries]
  );

  const handleRegistrySearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusRegistryRowAt(0);
      }
    },
    [focusRegistryRowAt]
  );

  const loadDemoDataset = useCallback(async () => {
    setMessage(null);
    setLastImportBatch(null);
    setSeedingDemo(true);
    try {
      const result = await seedLimsDemoDataset({ actor: 'local-user', reset: true });
      setMessage(
        userMessageWithValues(
          'registry.notice.replaced-the-registry-with-the-demo-dataset-entities-links',
          {
            value0: userMessageValue(result.insertedEntities),
            value1: userMessageValue(result.insertedLinks),
          }
        )
      );
      emitLimsRegistrationChanged({ entityId: result.strainSummary.strain.id });
      await reloadRegistry();
    } catch (error) {
      setMessage(toUserMessage(error, 'registry.importFailed'));
    } finally {
      setSeedingDemo(false);
    }
  }, [reloadRegistry]);

  const loadMockPrimerDemo = useCallback(async () => {
    setMessage(null);
    setLastImportBatch(null);
    setSeedingDemo(true);
    try {
      const result = await seedLimsMockDemo({ actor: 'local-user', reset: true });
      setMessage(
        userMessageWithValues(
          'registry.notice.replaced-the-registry-with-the-mock-primer-demo-oligos-hero-links-to-puc19-and-s',
          { value0: userMessageValue(result.insertedOligos) }
        )
      );
      emitLimsRegistrationChanged({ entityId: result.plasmidId });
      await reloadRegistry();
    } catch (error) {
      setMessage(toUserMessage(error, 'registry.importFailed'));
    } finally {
      setSeedingDemo(false);
    }
  }, [reloadRegistry]);

  const loadPracticeDemo = useCallback(async () => {
    setMessage(null);
    setLastImportBatch(null);
    setSeedingDemo(true);
    try {
      const result = await seedLimsPracticeDemo({ actor: 'local-user', reset: true });
      setMessage(
        userMessageWithValues(
          'registry.notice.replaced-the-registry-with-the-practice-dataset-file-backed-synthetic-plasmids-p',
          {
            value0: userMessageValue(result.insertedPlasmids),
            value1: userMessageValue(result.insertedOligos),
            value2: userMessageValue(result.insertedGenomeEntities),
          }
        )
      );
      if (result.sampleEntityId) emitLimsRegistrationChanged({ entityId: result.sampleEntityId });
      await reloadRegistry();
    } catch (error) {
      setMessage(toUserMessage(error, 'registry.importFailed'));
    } finally {
      setSeedingDemo(false);
    }
  }, [reloadRegistry]);

  const loadStarterRegistry = useCallback(async () => {
    setMessage(null);
    setLastImportBatch(null);
    setSeedingDemo(true);
    try {
      const result = await seedLimsStarterRegistry({ actor: 'local-user', reset: true });
      setMessage(
        userMessageWithValues(
          'registry.notice.replaced-the-registry-with-the-starter-test-dataset-strains-genome-assemblies-16',
          {
            value0: userMessageValue(result.strainIds.length),
            value1: userMessageValue(result.genomeIds.length),
            value2: userMessageValue(result.oligoIds.length),
          }
        )
      );
      if (result.strainIds[0]) emitLimsRegistrationChanged({ entityId: result.strainIds[0] });
      await reloadRegistry();
    } catch (error) {
      setMessage(toUserMessage(error, 'registry.importFailed'));
    } finally {
      setSeedingDemo(false);
    }
  }, [reloadRegistry]);

  const clearRegistry = useCallback(async () => {
    setMessage(null);
    setLastImportBatch(null);
    setPreview(null);
    setSeedingDemo(true);
    try {
      await resetLimsRegistry();
      setMessage(userMessage('registry.notice.cleared-the-registry-default-schemas-were-kept'));

      emitLimsRegistrationChanged();
      await reloadRegistry();
    } catch (error) {
      setMessage(toUserMessage(error, 'registry.importFailed'));
    } finally {
      setSeedingDemo(false);
    }
  }, [reloadRegistry]);

  const DEV_SCENARIOS: DevScenario[] = [
    {
      id: 'demo',
      group: 'Load test database (replaces registry)',
      label: 'Demo demo dataset',
      run: loadDemoDataset,
    },
    {
      id: 'mock-primer-demo',
      group: 'Load test database (replaces registry)',
      label: 'Mock primer demo (~1,090 designed primers + pUC19/chrIV links)',
      run: loadMockPrimerDemo,
    },
    {
      id: 'practice-demo',
      group: 'Load test database (replaces registry)',
      label: 'Practice registry (~500 synthetic plasmids + primers, interleaved)',
      run: loadPracticeDemo,
    },
    {
      id: 'starter-registry',
      group: 'Load test database (replaces registry)',
      label: 'Starter strains & genomes (E. coli, S. cerevisiae + lineage)',
      run: loadStarterRegistry,
    },
    { id: 'clear-registry', group: 'Registry', label: 'Clear registry', run: clearRegistry },
    {
      id: 'primer-csv',
      group: 'Import scenarios (append)',
      label: 'Primer CSV',
      run: openPrimerCsvScenario,
    },
    {
      id: 'messy-primer-csv',
      group: 'Import scenarios (append)',
      label: 'Messy primer CSV',
      run: openMessyPrimerCsvScenario,
    },
  ];

  const selectRegistrySummary = useCallback(
    async (summary: LimsRegistrySummary) => {
      useLimsOverlayStore.getState().supersedeRegistryRequest();
      if (!registryExpanded) {
        beginExpandMorph();
        setRegistryExpanded(true);
      }
      const reqId = ++registryPreviewReqRef.current;
      const queryGeneration = registryFilterGenerationRef.current;
      const nextPreview = await getLimsRegistryPreview({ entityId: summary.id });
      if (
        reqId !== registryPreviewReqRef.current ||
        queryGeneration !== registryFilterGenerationRef.current
      ) {
        return;
      }
      registryPreviewPublishedReqRef.current = reqId;
      setRegistryPreview(nextPreview);
    },
    [beginExpandMorph, registryExpanded]
  );

  const organizationNavigationRef = useRef<{ id: number; accountId: string | null } | null>(null);
  useEffect(() => {
    if (!registryRequest?.organizationId) return;
    const navigation = organizationNavigationRef.current;
    if (
      navigation?.id === registryRequest.requestId &&
      navigation.accountId !== registryAccountId
    ) {
      consumeRegistryRequest(registryRequest.requestId);
      observeRegistryPresentation(registryRequest, { kind: 'cancelled' });
      setMessageTone('error');
      setMessage(
        userMessage(
          'registry.notice.the-account-changed-while-opening-this-registry-open-it-again-from-the-current-a'
        )
      );
      return;
    }
    if (navigation?.id !== registryRequest.requestId || registryScope === 'local') {
      organizationNavigationRef.current = {
        id: registryRequest.requestId,
        accountId: registryAccountId,
      };
      setRegistryScope('organization');
      chooseRegistryOrganization(registryRequest.organizationId);
      return;
    }
    if (organizationRegistryLoading) return;
    if (organizationRegistry?.orgId !== registryRequest.organizationId) {
      if (!organizationRegistryError) return;
      consumeRegistryRequest(registryRequest.requestId);
      observeRegistryPresentation(registryRequest, { kind: 'missing' });
      setMessageTone('error');
      setMessage(toUserMessage(organizationRegistryError, 'account.failed'));
      return;
    }
    const previous = pendingRegistryPresentationRef.current;
    if (previous) observeRegistryPresentation(previous.request, { kind: 'superseded' });
    pendingRegistryPresentationRef.current = {
      request: registryRequest,
      ready: true,
      previewGeneration: ++registryPreviewReqRef.current,
      accountId: registryAccountId,
    };
    consumeRegistryRequest(registryRequest.requestId);
    beginExpandMorph();
    setRegistryExpanded(true);
    setOrganizationRegistrySearch('');
    setRegistryRemoteFilterProjectIds([]);
    if (registryRequest.entityId) {
      const record = organizationRegistry.entities.find(
        (entity) => entity.id === registryRequest.entityId
      );
      setRegistryShowArchived(record?.archivedAt != null);
      setSelectedOrganizationRecordId(registryRequest.entityId);
    }
    if (registryRequest.action === 'claim') setRegistryClaimOpen(true);
  }, [
    registryRequest,
    registryAccountId,
    registryScope,
    organizationRegistry,
    organizationRegistryLoading,
    organizationRegistryError,
    selectedRegistryOrgId,
    chooseRegistryOrganization,
    setRegistryScope,
    consumeRegistryRequest,
    beginExpandMorph,
    setOrganizationRegistrySearch,
    setSelectedOrganizationRecordId,
  ]);

  useEffect(() => {
    if (!registryRequest || registryRequest.organizationId) return;
    if (pendingRegistryPresentationRef.current?.request === registryRequest) return;
    const previous = pendingRegistryPresentationRef.current;
    if (previous) observeRegistryPresentation(previous.request, { kind: 'superseded' });
    const reqId = ++registryPreviewReqRef.current;
    const pending = { request: registryRequest, ready: false, previewGeneration: reqId };
    pendingRegistryPresentationRef.current = pending;
    consumeRegistryRequest(registryRequest.requestId);
    beginExpandMorph();
    setRegistryExpanded(true);
    setRegistryScope('local');
    setMessage(null);
    clearRegistryFilters();
    if (!registryRequest.entityId) {
      setRegistrySearch(registryRequest.fallbackSearch);
      pending.ready = true;
      setRegistryPreview(null);
      return;
    }
    void getLimsRegistryPreview({ entityId: registryRequest.entityId })
      .then((nextPreview) => {
        if (reqId !== registryPreviewReqRef.current) {
          observeRegistryPresentation(registryRequest, { kind: 'superseded' });
          return;
        }
        const current = useLimsOverlayStore.getState().registryRequestResult;
        if (current?.requestId !== registryRequest.requestId || current.status !== 'pending')
          return;
        if (
          !nextPreview ||
          nextPreview.entity.id !== registryRequest.entityId ||
          nextPreview.summary.id !== registryRequest.entityId
        ) {
          pendingRegistryPresentationRef.current = null;
          setRegistryPreview(null);
          setRegistrySearch(registryRequest.fallbackSearch);
          setMessage(
            userMessageWithValues('registry.notice.couldn-t-find-in-the-registry', {
              value0: userMessageValue(registryRequest.fallbackSearch),
            })
          );
          setMessageTone('error');
          observeRegistryPresentation(registryRequest, { kind: 'mismatch' });
          return;
        }
        setRegistryShowArchived(nextPreview.summary.archived);
        setRegistryReveal({
          entityId: nextPreview.entity.id,
          archived: nextPreview.summary.archived,
        });
        pending.ready = true;
        registryPreviewPublishedReqRef.current = reqId;
        setRegistryPreview(nextPreview);
      })
      .catch(() => {
        if (reqId !== registryPreviewReqRef.current) {
          observeRegistryPresentation(registryRequest, { kind: 'superseded' });
          return;
        }
        const current = useLimsOverlayStore.getState().registryRequestResult;
        if (current?.requestId !== registryRequest.requestId || current.status !== 'pending')
          return;
        pendingRegistryPresentationRef.current = null;
        setRegistryPreview(null);
        setRegistrySearch(registryRequest.fallbackSearch);
        setMessage(
          userMessageWithValues('registry.notice.couldn-t-find-in-the-registry', {
            value0: userMessageValue(registryRequest.fallbackSearch),
          })
        );
        setMessageTone('error');
        observeRegistryPresentation(registryRequest, { kind: 'missing' });
      });
  }, [beginExpandMorph, consumeRegistryRequest, registryRequest, clearRegistryFilters]);

  useLayoutEffect(() => {
    const wasExpanded = registryWasExpandedRef.current;
    registryWasExpandedRef.current = registryExpanded;
    if (wasExpanded && !registryExpanded) {
      cancelRegistryPresentation();
      return;
    }
    const pending = pendingRegistryPresentationRef.current;
    if (
      !pending?.ready ||
      !registryExpanded ||
      !registryOverlayMounted ||
      !registryOverlayShown ||
      registryMorphing
    )
      return;
    const request = pending.request;
    const current = useLimsOverlayStore.getState().registryRequestResult;
    if (current?.requestId !== request.requestId || current.status !== 'pending') return;
    if (request.organizationId) {
      if (pending.accountId !== registryAccountId) {
        pendingRegistryPresentationRef.current = null;
        observeRegistryPresentation(request, { kind: 'cancelled' });
      } else if (
        registryScope !== 'local' &&
        organizationRegistry?.orgId === request.organizationId &&
        !organizationRegistryLoading
      ) {
        if (!request.entityId) {
          pendingRegistryPresentationRef.current = null;
          observeRegistryPresentation(request, { kind: 'search' });
        } else if (
          selectedOrganizationRecordId === request.entityId &&
          visibleOrganizationDetails?.entity.id === request.entityId
        ) {
          pendingRegistryPresentationRef.current = null;
          observeRegistryPresentation(request, { kind: 'record', entityId: request.entityId });
        } else if (!organizationDetailsLoading && organizationDetailsError) {
          pendingRegistryPresentationRef.current = null;
          observeRegistryPresentation(request, { kind: 'missing' });
        }
      }
      return;
    }
    if (registryScope !== 'local') return;
    if (
      request.entityId &&
      registryPreview?.entity.id === request.entityId &&
      registryPreviewReqRef.current === pending.previewGeneration &&
      registryPreviewPublishedReqRef.current === pending.previewGeneration
    ) {
      pendingRegistryPresentationRef.current = null;
      observeRegistryPresentation(request, { kind: 'record', entityId: request.entityId });
    } else if (
      !request.entityId &&
      registryPreview === null &&
      registrySearch === request.fallbackSearch
    ) {
      pendingRegistryPresentationRef.current = null;
      observeRegistryPresentation(request, { kind: 'search' });
    }
  }, [
    cancelRegistryPresentation,
    registryExpanded,
    registryOverlayMounted,
    registryOverlayShown,
    registryMorphing,
    registryPreview,
    registryRequest,
    registryScope,
    registrySearch,
    registryAccountId,
    organizationRegistry,
    organizationRegistryLoading,
    organizationDetailsLoading,
    organizationDetailsError,
    selectedOrganizationRecordId,
    visibleOrganizationDetails,
  ]);

  const openRegistrySummary = useCallback(
    async (summary: LimsRegistrySummary, focus?: TabViewState) => {
      setMessage(null);
      const result = await openLimsEntity({
        entityId: summary.id,
        strategy: { kind: 'focused' },
        focus,
      });
      if (isLimsEntityOpened(result)) {
        setRegistryExpanded(false);
      } else if (result.status === 'not_found') {
        setRegistryPreview(null);
        await reloadRegistry();
      } else {
        setMessage(toUserMessage(result.message, 'registry.importFailed'));
      }
    },
    [reloadRegistry]
  );

  const refreshPreviewFor = useCallback(async (entityId: string, beforePublish?: () => void) => {
    const reqId = ++registryPreviewReqRef.current;
    const next = await getLimsRegistryPreview({ entityId });
    if (reqId !== registryPreviewReqRef.current) return;
    beforePublish?.();
    registryPreviewPublishedReqRef.current = reqId;
    setRegistryPreview(next);
  }, []);

  useEffect(
    () =>
      subscribeLimsRegistryChanged(() => {
        void reloadRegistry();
        const selectedId = registryPreview?.entity.id;

        if (!selectedId || registryPreviewPublishedReqRef.current !== registryPreviewReqRef.current)
          return;
        void refreshPreviewFor(selectedId).catch((error: unknown) => {
          console.warn('[LIMS] Could not refresh the edited record preview:', error);
        });
      }),
    [reloadRegistry, refreshPreviewFor, registryPreview?.entity.id]
  );

  useEffect(
    () =>
      registerWorkspaceDisplayParticipant(async ({ assertCurrent }) => {
        const selectedEntityId = registryPreview?.entity.id;

        let page: LimsRegistrySummaryPage | null = null;
        for (let attempt = 0; attempt < 3 && page === null; attempt += 1) {
          page = await reloadRegistry(assertCurrent);
        }
        if (!page) {
          throw new Error(
            'Registry reload was superseded before it could publish rebuilt records.'
          );
        }
        if (selectedEntityId && page.summaries.some((summary) => summary.id === selectedEntityId)) {
          await refreshPreviewFor(selectedEntityId, assertCurrent);
        }
      }),
    [refreshPreviewFor, registryPreview?.entity.id, reloadRegistry]
  );

  const handleRegistryRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, summary: LimsRegistrySummary, index: number) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusRegistryRowAt(Math.min(index + 1, registryPage.summaries.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (index <= 0) safeFocus(registrySearchRef.current);
        else focusRegistryRowAt(index - 1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void selectRegistrySummary(summary);
      }
    },
    [focusRegistryRowAt, registryPage.summaries.length, selectRegistrySummary]
  );

  const registryAddButton = (
    <ExplorerAddButton
      ref={registryAddButtonRef}
      data-testid="lims-registry-add-button"
      aria-haspopup="menu"
      aria-expanded={registryAddPickerOpen}
      onClick={() => setRegistryAddPickerOpen((open) => !open)}
    />
  );

  const beginRegistryCreate = (request: ExplorerEntityCreateRequest) => {
    setRegistryCreateRequest(request);
  };

  const scenarioFloat = showDevScenarios ? (
    <div
      data-testid="lims-dev-scenario-float"
      className="pointer-events-none fixed bottom-4 left-14 z-[60]"
    >
      <select
        data-testid="lims-dev-scenario-picker"
        value=""
        disabled={seedingDemo}
        title="Load a development scenario into the registry (dev only)"
        className="pointer-events-auto h-9 max-w-[220px] rounded border border-border bg-bg-subtle/95 px-2 text-xs font-medium text-fg shadow-lg outline-none hover:bg-bg-muted focus:border-accent disabled:opacity-60"
        onChange={(event) => {
          const scenario = DEV_SCENARIOS.find((s) => s.id === event.target.value);
          if (scenario) void scenario.run();
        }}
      >
        <option value="" disabled>
          {seedingDemo ? 'Loading…' : 'Load scenario…'}
        </option>
        {[...new Set(DEV_SCENARIOS.map((s) => s.group))].map((group) => (
          <optgroup key={group} label={group}>
            {DEV_SCENARIOS.filter((s) => s.group === group).map((s) => (
              <option key={s.id} value={s.id} data-testid={`lims-dev-scenario-${s.id}`}>
                {s.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  ) : null;

  const messageBar = message ? (
    <div
      className={`flex items-center justify-between gap-3 border-b border-border bg-bg-muted px-4 py-2 text-xs ${
        messageTone === 'error' ? 'text-error' : 'text-success'
      }`}
    >
      <span data-testid="lims-message" className="min-w-0 truncate">
        {message}
      </span>
      {lastImportBatch && (
        <button
          type="button"
          data-testid="lims-undo-last-import"
          className="inline-flex h-7 flex-shrink-0 items-center rounded border border-border bg-bg px-2 text-[11px] font-medium text-fg-muted hover:bg-bg-subtle hover:text-fg"
          onClick={() => void undoLastImport()}
          title="Reverses the registry registration. A managed project copy of an imported sequence file intentionally stays on disk."
        >
          Undo registry registration
        </button>
      )}
    </div>
  ) : null;

  const selectedRegistryOrganization =
    registryOrganizations.find((organization) => organization.orgId === selectedRegistryOrgId) ??
    null;
  const registryFilterFacets: RegistryFilterFacet[] = [
    ...(registryOrganizations.length > 0 || registryScope !== 'local'
      ? [
          {
            key: 'registry',
            label: 'Registry',
            searchLabel: 'Search registries',
            single: true,
            context: true,
            defaultValue: 'local',
            options: [
              { value: 'local', label: 'On this computer' },
              ...registryOrganizations.map((organization) => ({
                value: organization.orgId,
                label: organization.displayName,
              })),
            ],
            selected: [registryScope === 'local' ? 'local' : (selectedRegistryOrgId ?? '')],
            onChange: (values: string[]) => {
              const value = values[0];
              setRegistryRemoteFilterProjectIds([]);
              if (value === 'local') setRegistryScope('local');
              else if (value) {
                chooseRegistryOrganization(value);
                setRegistryScope('organization');
              }
            },
          },
        ]
      : []),
    {
      key: 'project',
      label: 'Project',
      searchLabel: 'Search projects',
      options:
        registryScope === 'local'
          ? (registryPage.availableProjects ?? []).map((project) => ({
              value: String(project.workspaceId),
              label: project.name,
              count: project.count,
            }))
          : registryProjects.map((project) => ({
              value: project.remoteWorkspaceId,
              label: project.displayName,
            })),
      selected:
        registryScope === 'local' ? registryProjectIds.map(String) : registryRemoteFilterProjectIds,
      onChange: (values) =>
        registryScope === 'local'
          ? setRegistryProjectIds(values.map(Number))
          : setRegistryRemoteFilterProjectIds(values),
      description:
        registryScope === 'local'
          ? 'Records saved in any selected project.'
          : 'Records with a home or reference in any selected project.',
    },
    {
      key: 'kind',
      label: 'Schema',
      searchLabel: 'Search schemas',
      options:
        registryScope === 'local'
          ? limsSchemas.map((schema) => ({ value: schema.entityKind, label: schema.displayName }))
          : [
              ...new Set(
                (organizationRegistry?.entities ?? []).map((entity) =>
                  typeof entity.kind === 'string'
                    ? entity.kind
                    : String(entity.entityKind ?? 'record')
                )
              ),
            ].map((kind) => ({
              value: kind,
              label: limsSchemas.find((schema) => schema.entityKind === kind)?.displayName ?? kind,
            })),
      selected: getColumnCategoricalFilter('kind'),
      onChange: (values) => setColumnCategoricalFilter('kind', values),
    },
    ...(registryScope === 'local'
      ? [
          {
            key: 'status',
            label: 'Status',
            searchLabel: 'Search statuses',
            options: [...STATUS_FILTER_OPTIONS],
            selected: getColumnCategoricalFilter('status'),
            onChange: (values: string[]) => setColumnCategoricalFilter('status', values),
          },
        ]
      : []),
  ];
  const organizationRecordFilters = {
    projectIds: registryRemoteFilterProjectIds,
    kinds: registryCategoricalFilters.kind,
    nameLike: registryTextFilters.name,
    registryIdLike: registryTextFilters.registryId,
    includeArchived: registryShowArchived,
  };
  const visibleOrganizationSelection =
    selectedOrganizationRecordId &&
    organizationRegistry &&
    organizationRegistryRecords(
      organizationRegistry,
      registryScope === 'local' ? 'organization' : registryScope,
      registryProject,
      organizationRegistrySearch,
      organizationRecordFilters
    ).some((record) => record.id === selectedOrganizationRecordId)
      ? selectedOrganizationRecordId
      : null;
  useEffect(() => {
    if (registryScope !== 'local' && selectedOrganizationRecordId && !visibleOrganizationSelection)
      setSelectedOrganizationRecordId(null);
  }, [
    registryScope,
    selectedOrganizationRecordId,
    visibleOrganizationSelection,
    setSelectedOrganizationRecordId,
  ]);
  const registryHasFilters =
    registryProjectIds.length > 0 ||
    registrySearch.trim() !== '' ||
    Object.values(registryTextFilters).some((value) => value.trim() !== '') ||
    Object.values(registryCategoricalFilters).some((values) => values.length > 0) ||
    Boolean(registryUpdatedFilter?.date) ||
    unconnectedOnly;
  const registryScopeControls = (
    <RegistryFilters
      facets={registryFilterFacets}
      textFilters={registryTextFilters}
      onTextFilterChange={setColumnTextFilter}
      updatedFilter={registryScope === 'local' ? registryUpdatedFilter : undefined}
      onUpdatedFilterChange={registryScope === 'local' ? setRegistryUpdatedFilter : undefined}
      showArchived={registryShowArchived}
      onShowArchivedChange={setRegistryShowArchived}
      unresolvedOnly={registryScope === 'local' ? unconnectedOnly : undefined}
      unresolvedCount={unconnectedEntityIds.size}
      onUnresolvedChange={registryScope === 'local' ? setUnconnectedOnly : undefined}
      search={visibleRegistrySearch}
      onClearSearch={() => setVisibleRegistrySearch('')}
      onClearAll={clearRegistryFilters}
      open={registryFiltersOpen}
      onOpenChange={setRegistryFiltersOpen}
      actions={
        <RegistryScopeControls
          scope={registryScope}
          setScope={setRegistryScope}
          organizations={registryOrganizations}
          selectedOrgId={selectedRegistryOrgId}
          setSelectedOrgId={chooseRegistryOrganization}
          loading={organizationRegistryLoading}
          registry={organizationRegistry}
          projects={registryProjects}
          selectedProjectId={registryRemoteProjectId}
          setSelectedProjectId={setRegistryRemoteProjectId}
          onSync={() => {
            if (registryScope !== 'local') void refreshOrganizationRegistry(registryScope);
          }}
          onClaimLocal={
            selectedRegistryOrgId && organizationRegistry
              ? () => setRegistryClaimOpen(true)
              : undefined
          }
        />
      }
    />
  );

  return (
    <div
      ref={registryPanelRef}
      data-testid="lims-panel"
      tabIndex={-1}
      className="relative flex h-full min-h-0 flex-col bg-bg outline-none"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;

        if (sortMenuOpen || openFilterKey || registryFiltersOpen) return;
        if (registryExpanded || registryOverlayMounted) return;
        if (wizardStep !== null) return;
        event.preventDefault();
        onHide?.();
      }}
      onDragOver={(event) => {
        if (wizardStep !== null) return;
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        setDraggingToImport(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDraggingToImport(false);
      }}
      onDrop={(event) => {
        if (wizardStep !== null) return;
        event.preventDefault();
        setDraggingToImport(false);
        const file = event.dataTransfer.files?.[0];
        if (file) handleDroppedFileToOpen(file);
      }}
    >
      <ExplorerAddPicker
        open={registryAddPickerOpen}
        anchorRef={registryAddButtonRef}
        launchSource="registry"
        destinationLabel="project or folder"
        destinationPath={null}
        hasWorkspace={folders.some((folder) => !folder.pinned)}
        onRequestClose={() => setRegistryAddPickerOpen(false)}
        onCreateEntity={onCreateEntity ? beginRegistryCreate : undefined}
        onImportEntity={onImportEntity}
        onImportProject={onImportProject}
        onImportProjectWithAgent={onImportProjectWithAgent}
        onMigrateFromBenchling={onMigrateFromBenchling}
      />
      {registryCreateRequest ? (
        <RegistryCreateDestinationDialog
          request={registryCreateRequest}
          folders={folders}
          onCancel={() => setRegistryCreateRequest(null)}
          onConfirm={(request) => {
            setRegistryCreateRequest(null);
            onCreateEntity?.(request);
          }}
        />
      ) : null}
      {draggingToImport && (
        <div
          data-testid="lims-registry-drop-overlay"
          className="pointer-events-none absolute inset-0 z-[60] m-2 flex items-center justify-center rounded-lg border-4 border-dashed border-accent bg-accent/10 text-center text-sm font-semibold text-accent"
        >
          Drop a file to import into the registry
        </div>
      )}
      {}
      {}
      {!registryExpanded && !registryOverlayMounted && (
        <RegistryCompactDrawer
          registrySearch={visibleRegistrySearch}
          setRegistrySearch={setVisibleRegistrySearch}
          expandRegistry={expandRegistry}
          actionsMenu={registryScope === 'local' ? registryAddButton : null}
          scopeControls={registryScopeControls}
          alternateBody={
            registryScope === 'local' ? null : (
              <OrganizationRegistryTable
                scope={registryScope}
                organization={selectedRegistryOrganization}
                registry={organizationRegistry}
                search={organizationRegistrySearch}
                loading={organizationRegistryLoading}
                error={organizationRegistryError}
                project={registryProject}
                filters={organizationRecordFilters}
                compact
                placementBusyId={registryPlacementBusyId}
                onAddProjectPlacement={addRegistryProjectPlacement}
                onRemoveProjectPlacement={removeRegistryProjectPlacement}
                selectedEntityId={visibleOrganizationSelection}
                onSelectRecord={selectOrganizationRecord}
                onOpenRecord={(record) => void openOrganizationRecord(record)}
              />
            )
          }
          bottomInset={showDevScenarios}
          messageBar={messageBar}
          registryCompactScrollRef={registryCompactScrollRef}
          registryCompactSentinelRef={registryCompactSentinelRef}
          summaries={registryPage.summaries}
          filtered={registryHasFilters}
          selectRegistrySummary={selectRegistrySummary}
          openRegistrySummary={openRegistrySummary}
          registryLoading={registryLoading}
          registryHasMore={registryHasMore}
          registryLoadingMore={registryLoadingMore}
          unconnectedEntityIds={unconnectedEntityIds}
        />
      )}

      {(registryExpanded || registryOverlayMounted) && (
        <div
          data-testid="lims-registry-overlay"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              if (sortMenuOpen || registryFiltersOpen) return;
              event.preventDefault();

              if (openFilterKey) {
                setOpenFilterKey(null);
                return;
              }
              if (registryScope !== 'local' && selectedOrganizationRecordId) {
                setSelectedOrganizationRecordId(null);
                return;
              }
              if (registryPreview) {
                setRegistryPreview(null);
                return;
              }
              setRegistryExpanded(false);

              safeFocus(registryPanelRef.current);
            }
          }}
          className={`fixed z-30 flex min-h-0 flex-col overflow-hidden border-y border-border bg-bg shadow-xl transition-[top,left,right,bottom] duration-200 ease-out ${
            registryOverlayShown ? '' : 'pointer-events-none'
          }`}
          style={
            registryMorphRect
              ? {
                  top: registryMorphRect.top,
                  left: registryMorphRect.left,
                  bottom: registryMorphRect.bottom,
                  right: registryOverlayShown ? 0 : registryMorphRect.right,
                }
              : { top: 58, left: 48, right: 0, bottom: 0 }
          }
        >
          {}
          <div className="flex flex-nowrap items-center gap-2 overflow-hidden border-b border-border px-4 py-3">
            <button
              type="button"
              data-testid="lims-registry-collapse"
              title="Collapse to the compact registry"
              aria-label="Collapse registry"
              onClick={closeRegistryOverlay}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-border text-fg-muted hover:bg-bg-muted hover:text-fg"
            >
              <ChevronRightIcon className="h-4 w-4 rotate-180" />
            </button>
            <input
              ref={registrySearchRef}
              value={visibleRegistrySearch}
              onChange={(event) => setVisibleRegistrySearch(event.target.value)}
              onKeyDown={registryScope === 'local' ? handleRegistrySearchKeyDown : undefined}
              data-testid="lims-registry-search"
              placeholder="Search registry"
              className="h-9 min-w-52 flex-1 rounded border border-border bg-bg px-3 text-sm text-fg outline-none focus:border-accent"
            />
            {registryScope === 'local' ? (
              <div ref={sortMenuRef} className="relative flex-shrink-0">
                <button
                  ref={sortTriggerRef}
                  type="button"
                  data-testid="lims-registry-sort"
                  aria-haspopup="listbox"
                  aria-expanded={sortMenuOpen}
                  aria-label="Sort registry"
                  onClick={() => (sortMenuOpen ? setSortMenuOpen(false) : openSortMenu())}
                  className="inline-flex h-9 items-center gap-1.5 rounded border border-border bg-bg px-2.5 text-xs font-medium text-fg outline-none hover:bg-bg-muted focus:border-accent"
                >
                  <span>
                    {REGISTRY_SORT_OPTIONS.find((option) => option.value === registrySort)?.label ??
                      'Sort'}
                  </span>
                  <svg
                    viewBox="0 0 10 6"
                    width="9"
                    height="6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden
                    className={`flex-shrink-0 text-fg-subtle transition-transform ${
                      sortMenuOpen ? 'rotate-180' : ''
                    }`}
                  >
                    <path d="M1 1l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {sortMenuOpen && sortMenuPos && (
                  <div
                    role="listbox"
                    data-testid="lims-registry-sort-menu"
                    style={{ top: sortMenuPos.top, right: sortMenuPos.right }}
                    className="fixed z-[70] w-44 overflow-hidden rounded-md border border-border bg-bg py-1 shadow-lg"
                  >
                    {REGISTRY_SORT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={option.value === registrySort}
                        data-testid={`lims-registry-sort-option-${option.value}`}
                        onClick={() => {
                          setRegistrySort(option.value);
                          setSortMenuOpen(false);
                        }}
                        className={`flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-bg-subtle ${
                          option.value === registrySort ? 'font-medium text-accent' : 'text-fg'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            {registryScope === 'local' ? registryAddButton : null}
            {registryScope === 'local' ? (
              <button
                type="button"
                onClick={() => {
                  closeRegistryOverlay();
                  onHide?.();
                  openSettingsEntry('registry');
                }}
                className="h-9 shrink-0 rounded border border-border px-3 text-xs font-medium text-fg hover:bg-bg-muted"
              >
                Schemas
              </button>
            ) : null}
          </div>
          {registryScopeControls}
          {messageBar}
          {registryScope === 'local' ? (
            <div
              className={`grid min-h-0 flex-1 ${
                registryPreview ? 'grid-cols-[minmax(420px,1fr)_minmax(320px,38%)]' : 'grid-cols-1'
              }`}
            >
              <RegistryOverlayTable
                columns={registryColumns}
                filtered={registryHasFilters}
                hasPreview={Boolean(registryPreview)}
                selectedEntityId={registryPreview?.entity.id ?? null}
                registryGridRowProps={registryGridRowProps}
                registrySort={registrySort}
                setRegistrySort={setRegistrySort}
                openFilterKey={openFilterKey}
                setOpenFilterKey={setOpenFilterKey}
                filterAnchor={filterAnchor}
                setFilterAnchor={setFilterAnchor}
                filterPopoverRef={filterPopoverRef}
                columnHasFilter={columnHasFilter}
                getColumnTextFilter={getColumnTextFilter}
                setColumnTextFilter={setColumnTextFilter}
                describeColumnFilter={describeColumnFilter}
                renderColumnFilterControl={renderColumnFilterControl}
                registryColumnWidths={registryColumnWidths}
                startRegistryColumnResize={startRegistryColumnResize}
                registryOverlayShown={registryOverlayShown}
                registryMorphing={registryMorphing}
                registryScrollRef={registryScrollRef}
                registryRowRefs={registryRowRefs}
                registrySentinelRef={registrySentinelRef}
                summaries={registryPage.summaries}
                selectRegistrySummary={selectRegistrySummary}
                openRegistrySummary={openRegistrySummary}
                handleRegistryRowKeyDown={handleRegistryRowKeyDown}
                registryLoading={registryLoading}
                registryHasMore={registryHasMore}
                registryLoadingMore={registryLoadingMore}
                totalCount={registryPage.totalCount}
                unconnectedEntityIds={unconnectedEntityIds}
                workspaceFolders={projectEditFolders}
              />
              {registryPreview && (
                <RegistryPreviewPane
                  onClose={() => setRegistryPreview(null)}
                  registryPreview={registryPreview}
                  openRegistrySummary={openRegistrySummary}
                  onViewOriginalSource={setOriginalSourceDialog}
                  onMetadataSaved={async () => {
                    await refreshPreviewFor(registryPreview.entity.id);
                    await reloadRegistry();
                  }}
                  onClassificationApplied={async () => {
                    await refreshPreviewFor(registryPreview.entity.id);
                    await reloadRegistry();
                    emitLimsRegistrationChanged({ entityId: registryPreview.entity.id });
                  }}
                />
              )}
            </div>
          ) : (
            <div
              className={`grid min-h-0 flex-1 ${visibleOrganizationSelection ? 'grid-cols-[minmax(420px,1fr)_minmax(320px,38%)]' : 'grid-cols-1'}`}
            >
              <OrganizationRegistryTable
                scope={registryScope}
                organization={selectedRegistryOrganization}
                registry={organizationRegistry}
                search={organizationRegistrySearch}
                loading={organizationRegistryLoading}
                error={organizationRegistryError}
                project={registryProject}
                filters={organizationRecordFilters}
                placementBusyId={registryPlacementBusyId}
                onAddProjectPlacement={addRegistryProjectPlacement}
                onRemoveProjectPlacement={removeRegistryProjectPlacement}
                selectedEntityId={visibleOrganizationSelection}
                onSelectRecord={selectOrganizationRecord}
                onOpenRecord={(record) => void openOrganizationRecord(record)}
              />
              {visibleOrganizationSelection ? (
                <OrganizationRegistryPreviewPane
                  details={visibleOrganizationDetails}
                  loading={organizationDetailsLoading}
                  error={organizationDetailsError}
                  opening={organizationRecordOpening}
                  projects={registryProjects}
                  entities={organizationRegistry?.entities ?? []}
                  onOpen={() => void openOrganizationRecord()}
                />
              ) : null}
            </div>
          )}
        </div>
      )}

      {}
      {wizardStep && (
        <LimsImportWizard
          step={wizardStep}
          onGotoStep={gotoWizardStep}
          schemas={limsSchemas}
          chosenKind={chosenKind}
          onChooseKind={chooseType}
          onFile={(file) => void handleImportFile(file)}
          onPasteImport={(text, hasHeader) => void handlePasteImport(text, hasHeader)}
          plan={preview}
          idSchemes={idSchemes}
          folders={folders}
          destinationRoot={destinationRoot}
          onChooseDestination={(path) => {
            setDestinationRoot(path);
            if (path && previewRef.current?.review)
              enqueueImportPlanUpdate((plan) =>
                executeLimsImportReview(plan, {
                  kind: 'set-destination',
                  workspaceRoot: findContainingPathBoundary(folders, path)?.path ?? path,
                  destinationDir: path,
                })
              );
          }}
          onColumnMappingsChange={(mappings) => void applyImportColumnMappings(mappings)}
          onRecordAcceptedChange={(recordId, accepted) => {
            const current = previewRef.current ?? preview;
            if (!current) return;
            setImportPlanDirty(true);
            enqueueImportPlanUpdate((plan) =>
              acceptLimsImportReviewRecords(plan, [recordId], accepted)
            );
          }}
          onRecordsAcceptedChange={(recordIds, accepted) => {
            const current = previewRef.current ?? preview;
            if (!current) return;
            setImportPlanDirty(true);
            enqueueImportPlanUpdate((plan) =>
              acceptLimsImportReviewRecords(plan, recordIds, accepted)
            );
          }}
          onApply={() => void applyImport()}
          onCancel={() => {
            if (workbookReviewRef.current) cancelReview();
            else closeImportPlan();
          }}
          onDone={() => {
            const review = workbookReviewRef.current;
            if (review?.phase === 'done') finishReview();
            else if (review) cancelReview();
            else dismissImportPlan();
          }}
          job={reviewToJob(workbookReview)}
          onSelectTab={selectReviewTab}
          onToggleTabSelected={toggleReviewTabSelected}
          onImportAll={() => void importAllReviewTabs()}
          onNext={() => setWizardStep('review')}
          totalCount={multiSheetTotalCount}
        />
      )}
      {originalSourceDialog ? (
        <OriginalProviderSourceDialog
          request={originalSourceDialog.request}
          label={originalSourceDialog.label}
          onClose={() => setOriginalSourceDialog(null)}
        />
      ) : null}
      {registryClaimOpen && selectedRegistryOrganization && organizationRegistry ? (
        <RegistryClaimDialog
          key={`${registryAccountId}:${selectedRegistryOrganization.orgId}`}
          organizationName={selectedRegistryOrganization.displayName}
          localRecords={registryPage.summaries}
          searchRecords={searchRegistryClaimRecords}
          schemas={organizationRegistry.schemas}
          prepareClaim={prepareRegistryClaim}
          onConfirm={claimLocalRecords}
          onCancel={() => setRegistryClaimOpen(false)}
        />
      ) : null}
      {scenarioFloat}
    </div>
  );
}
