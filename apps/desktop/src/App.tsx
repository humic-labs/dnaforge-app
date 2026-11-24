import { AI_ONLY_INPUT } from './lib/ai-only-input';
import { AiOnlyWorkbench } from './components/AiOnlyWorkbench';
import { WorkTaskDialogHost } from './features/work/public/work';
import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { TerminalDock } from './features/terminal/TerminalDock';
import { COMMAND_IDS, useCommandRegistry } from './commands';
import {
  openReleaseNotes,
  openSelectedDocument,
  RendererFeatureActivations,
  rendererFeatureView,
  rendererFeatureSidebarView,
  isRendererFeatureSidebarView,
  beginAIChatNavigation,
  resumeAIConversation,
} from './feature-registry';
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  useReducer,
  useSyncExternalStore,
} from 'react';
import type { BenchlingMigrationRunView } from './shared/benchling-migration-ipc';
import { useAISettingsStore } from './features/ai/settings';
import { useChatStore } from './features/ai/hooks/useChat';
import { safeFocus } from './shared/utils/safeFocus';
import { subscribeRegistryOpen } from './shared/registry-events';
import { AppBar } from './components/AppBar';
import { hostedAbsolutePath, hostedWorkspaceRoot, isHostedWorkspaceId } from './hosted/paths';
import { rememberHostedWorkspaces } from './hosted/workspace-roster';
import {
  HostedShareButton,
  HostedWorkspaceChrome,
  type HostedBrowserReadTarget,
  type HostedShareTarget,
} from './hosted/HostedWorkspaceChrome';

if (
  (import.meta.env.DEV === true || import.meta.env.MODE === 'test') &&
  import.meta.env.MODE !== 'hosted'
) {
  import('./test/mock-setup');
}
import { MOCK_WORKSPACE_PATH } from './utils/browser-mocks';
import { platform } from './platform';
import { StartupSurface } from './startup/StartupSurface';
import { isBrowserOnly, isDesktopRuntime, isHostedBrowserRuntime } from './utils/environment';
import { useWorkspace } from './hooks/useWorkspace';
import { useWorkspaceStore } from './stores/workspaceStore';
import { useDevFixturesMounted } from './dev/dev-fixtures-mount';
import { FileBrowser, type WorkspaceCreationContext } from './components/FileBrowser';
import type { ExplorerEntityCreateRequest } from './components/ExplorerAddPicker';
import { ProjectHome } from './components/ProjectHome';
import { ProjectSwitcherPopover } from './components/ProjectSwitcherPopover';
import { ActivityBar, type ActivityView } from './components/ActivityBar';
import { AccountActivityButton } from './features/auth/AccountActivityButton';
import { subscribeSettingsEntry } from './features/auth/cloud-surface-store';
import {
  OPEN_FILE_HANDLING_SETTINGS_EVENT,
  REVEAL_OPEN_DOCUMENT_EVENT,
} from './features/file-associations/handler-status-source';
import { useToolboxBadge } from './hooks/useToolboxStatus';
import { SettingsPanel, type SettingsPanelFocusTarget } from './components/SettingsPanel';
import { SearchPanel } from './components/SearchPanel';
import { WorkspaceMain } from './components/workspace/WorkspaceMain';
import { WorkspaceSidebar } from './components/workspace/WorkspaceSidebar';
import { refreshRecentlyEdited } from './features/home/recently-edited';
import {
  enqueueRecentlyEditedPreparation,
  mountedWorkspaceAccessKey,
} from './features/home/prepare-recently-edited';
import { useWorkspaceMainMode } from './hooks/useWorkspaceMainMode';
import { Toolbox } from './components/Toolbox';
import { LimsPanel } from './features/lims/components/LimsPanel';
import { useActionablePendingRefs } from './features/lims/use-actionable-pending-refs';
import {
  RegistryCreateDestinationDialog,
  type CreateDestinationRequest,
} from './features/lims/components/RegistryCreateDestinationDialog';
import { useLimsOverlayStore } from './features/lims/lims-overlay-store';
import { useDevLimsSeedPrompt } from './features/lims/useDevLimsSeedPrompt';
import { ToastContainer } from './components/ToastContainer';
import { TelemetryBlockedSurface } from './components/TelemetryBlockedSurface';
import { ScreenViewTelemetryObserver } from './components/ScreenViewTelemetryObserver';
import {
  loadAnnotationCatalogs,
  startTrackRegistrationRefresh,
} from './features/sequence/annotation-catalog';
import { OversizedDialogHost } from './features/sequence/components/OversizedDialogHost';
import {
  ReferenceGenomePicker,
  ReferenceLibrary,
} from './features/sequence/public/components/ReferenceGenomePicker';
import {
  GENOME_VIEW_OPEN_FINISHED,
  GENOME_VIEW_OPEN_REQUESTED,
  pendingGenomeViewFileOpen,
} from './features/sequence/public/genome-view-open-request';

import { AgentConfirmController } from './features/ai/agent-confirm/AgentConfirmController';
import { AskAiPickerHost } from './components/chat/AskAiPickerHost';
import { AskAiInlineChatHost } from './components/chat/AskAiInlineChatHost';
import { TranslationDialogHost } from './features/sequence/components/TranslationDialogHost';
import { ConfirmDialogHost } from './components/ConfirmDialogHost';
import { ConnectComputeProviderDialog, PredictStructureDialog } from './features/compute';
import { LargeFileImportDialogHost } from './components/LargeFileImportDialogHost';
import { AuthFlowHost } from './features/auth/AuthFlowHost';
import { createEmptyDnaSequence } from './features/sequence/create-empty-dna-sequence';
import {
  UNTITLED_DNA_OLIGO_NAME,
  UNTITLED_PRIMER_NAME,
  UNTITLED_RNA_OLIGO_NAME,
} from './features/primers/primer-draft-name';
import { findContainingPathBoundary } from './shared/path-boundary';
import { getTabTypeForFile } from './utils/fileTypes';
import { GoToFileDialog } from './keyboard/GoToFileDialog';
import { useAppShortcutActions } from './keyboard/useAppShortcutActions';
import { startReferenceInvalidationListeners } from './features/page/entity-ref/reference-generation';
import { useUpdateToasts } from './hooks/useUpdateToasts';
import { useFileAssociationOpportunities } from './hooks/use-file-association-opportunities';
import { SetupBanner } from './components/SetupBanner';
import {
  BenchlingMigrationWizard,
  createDesktopBenchlingMigrationWizardBridge,
  initialMigrationSessionSelection,
  reduceMigrationSessionSelection,
  type MigrationSessionOpenEvent,
  useBenchlingMigrationNotifications,
  useBenchlingMigrationHistory,
  useBenchlingMigrationStatus,
} from './features/benchling-migration';
import { SourceControlPanel } from './components/SourceControlPanel';
import { CanvasLayout, useCanvasStore } from './features/canvas';
import { usePageStore } from './features/page';
import { useWindowState } from './hooks/useWindowState';
import { useDebugSnapshot } from './hooks/use-debug-snapshot';
import { captureAndSaveSnapshot } from './features/ai/snapshot';
import {
  getWebGLTrace,
  isWebGLTraceActive,
  snapshotWebGLState,
  startWebGLTrace,
  stopWebGLTrace,
} from '@waypoint/genome-renderer';
import { useFileDrag } from './hooks/useFileDrag';
import { useJobsSidebar } from './hooks/useJobsSidebar';
import { useWorkspaceLibrary } from './hooks/useWorkspaceLibrary';
import { useWorkspaceProjectActions } from './hooks/useWorkspaceProjectActions';
import { useAppStartup } from './hooks/useAppStartup';
import { useAppTestBridges } from './hooks/useAppTestBridges';
import { useAppRuntimeCommands } from './hooks/useAppRuntimeCommands';
import { useImportWizard } from './features/import-wizard/useImportWizard';
import { useWorkspaceFileRelocatedRetarget } from './features/workspace/useWorkspaceFileRelocatedRetarget';
import { ImportWizardHost } from './features/import-wizard/ImportWizardHost';
import { TabularImportWizardHost } from './features/import-wizard/TabularImportWizardHost';
import { QuickLookImportHost } from './components/QuickLookImportHost';
import { EntityCreationHost } from './features/entity-creation/EntityCreationHost';
import { openEntityCreation } from './features/entity-creation/entity-creation-store';
import { useSidebar } from './hooks/useSidebar';
import { DevConsoleCapture } from './shared/components';
import { trackRendererEvent, trackToolOpened } from './lib/analytics';
import { installTelemetryEpisodeCorrelationBridge } from './lib/telemetry-correlation';
import { installWorkflowTelemetryObservers } from './lib/workflow-telemetry-observers';
import { getConversationHistory } from './db';
import { findWorkspaceRootForPath, repairDuplicateCurrentBindings } from './db/workspace-catalog';
import { sweepExpandedPathRoots } from './shared/ui-persistence';
import { artifactStemFromFileName } from './db/workspace-artifacts';
import { useToastStore } from './stores/toast-store';
import { getDevSurfaceState } from './lib/dev-surface-gates';
import type { TabType } from './features/canvas/types';
import type { AssistantHostId } from './features/ai/assistant-hosts';
import { openWorkspaceFromSource } from './features/workspace-loader/open-workspace-from-source';
import { observeWorkspaceSetPath } from './features/workspace-loader/workspace-telemetry';
import {
  loadWorkspaceDeliveryReceipts,
  rememberWorkspaceDeliveryReceipt,
} from './features/workspace-loader/workspace-delivery-receipts';
import { resolveChatWorkspacePath } from './features/canvas/components/chat-workspace';
import { soleWritableProjectRoot } from './shared/project-root-selection';

import {
  reconcileWorkspaceAfterFilesChanged,
  reconcileWorkspaceOnMount,
} from './services/workspace-operations';
import { waitForWorkspaceReconcileIdle } from './services/workspace-reconcile-lifecycle';
import {
  installWorkspaceFilesChangedAdapter,
  WORKSPACE_FILES_CHANGED_EVENT,
  type WorkspaceFilesChangedDetail,
} from './services/workspace-files-changed-adapter';
import { installComputeJobTerminalAdapter } from './features/compute/job-terminal-adapter';
import {
  registerAllEntityAdapters,
  assertRequiredEntityAdaptersRegistered,
} from './db/entity-substrate/register';
import { ENTITY_PROJECTION_UPDATED_EVENT } from './db/entity-substrate/adapter-events';
import { handleWorkspaceSyncReplicaLifecycleWithStores } from './services/workspace-sync-renderer-refresh';
import { isDeveloperImportSourcePath } from './shared/developer-import-sources';
import {
  configureElectronWorkspaceSessionCanvasSource,
  electronWorkspaceSessionController,
  initializeElectronWorkspaceSession,
  refreshElectronWorkspaceSessionForPath,
} from './features/workspace-session/electron-session';
import { JobsSidebar } from './features/jobs';
import { managedOperations } from './services/managed-operations';

configureElectronWorkspaceSessionCanvasSource({
  getState: useCanvasStore.getState,
  subscribe: (listener) => useCanvasStore.subscribe(listener),
});

declare const __DEV_WP_ASSETS_PATH__: string;
declare const __DEV_TEST_FIXTURES_PATH__: string;
const DEV_ASSETS_PATH = __DEV_WP_ASSETS_PATH__ || import.meta.env.VITE_WP_ASSETS_PATH || '';
const DEV_TEST_FIXTURES_PATH =
  typeof __DEV_TEST_FIXTURES_PATH__ === 'undefined' ? '' : __DEV_TEST_FIXTURES_PATH__;
const IS_DEV = import.meta.env.DEV;
const DEV_SURFACES = getDevSurfaceState(import.meta.env, DEV_ASSETS_PATH);
const DEV_SCENARIO_RUNTIME_ENABLED =
  (import.meta.env.DEV === true || import.meta.env.MODE === 'test') &&
  import.meta.env.MODE !== 'hosted';
const BENCHLING_FILE_MIGRATION_ENABLED =
  import.meta.env.DEV === true ||
  import.meta.env.MODE === 'test' ||
  import.meta.env.VITE_BENCHLING_FILE_MIGRATION_ENABLED === '1';
const DEV_SCENARIO_REPLAY_EPOCH = Date.now();

function workspaceRootFromCreationContext(
  context: WorkspaceCreationContext | undefined,
  folders: Array<{ path: string }>
): string | null {
  if (context?.workspaceRoot) return context.workspaceRoot;
  const path = context?.targetPath ?? context?.parentPath;
  return findWorkspaceRootForPath(folders, path) ?? soleWritableProjectRoot(folders)?.path ?? null;
}

function artifactTitleFromCreationContext(
  context: WorkspaceCreationContext | undefined,
  type: 'notebook' | 'design',
  fallback: string
): string {
  const title = context?.artifactTitle?.trim();
  if (title) return title;
  if (context?.artifactFileName) {
    const stem = artifactStemFromFileName(context.artifactFileName, type).trim();
    if (stem) return stem;
  }
  return fallback;
}

const DevPanel = DEV_SCENARIO_RUNTIME_ENABLED
  ? lazy(() => import('./components/DevPanel').then((mod) => ({ default: mod.DevPanel })))
  : null;

const ActivityBarDevButtons = import.meta.env.DEV
  ? lazy(() =>
      import('./components/ActivityBarDevButtons').then((mod) => ({
        default: mod.ActivityBarDevButtons,
      }))
    )
  : null;

const E2E_FIXTURES_PATH = DEV_ASSETS_PATH
  ? `${DEV_ASSETS_PATH}/test-data/desktop-perf/plasmid-variants`
  : '';
function trackFirstProductActionProxyOnce(): void {
  try {
    const key = 'dnaforge:first_product_action_completed';
    if (window.localStorage.getItem(key) === 'true') return;
    window.localStorage.setItem(key, 'true');
  } catch {}

  trackRendererEvent('first_product_action_completed', { feature_area: 'project' });
}

type DevTestWindow = Window & {
  __chatStore?: unknown;
  __canvasStore?: unknown;
  __workspaceStore?: unknown;
  __aiSettingsStore?: unknown;
  __attachedReadsStore?: unknown;
  __storeRefs?: Record<string, unknown>;
  __scenarios?: Record<string, unknown>;
  __test?: Record<string, unknown>;
  __perfEntries?: () => unknown[];
  __dumpWebGLSelectionDebug?: () => unknown[];
  __shellPreparedAt?: number;
  __webglMapRenderCount?: number;
};

function getDevTestWindow(): DevTestWindow | null {
  return typeof window === 'undefined' ? null : (window as DevTestWindow);
}

if (
  (import.meta.env.DEV === true || import.meta.env.MODE === 'test') &&
  import.meta.env.MODE !== 'hosted' &&
  getDevTestWindow()
) {
  const testWindow = getDevTestWindow()!;
  testWindow.__chatStore = useChatStore;
  testWindow.__canvasStore = useCanvasStore;
  testWindow.__workspaceStore = useWorkspaceStore;
  testWindow.__aiSettingsStore = useAISettingsStore;

  import('./features/sequence/tracks/attached-reads-store').then((mod) => {
    const testWindow = getDevTestWindow();
    if (!testWindow) return;
    testWindow.__attachedReadsStore = mod.useAttachedReadsStore;
  });

  import('./features/alignment-manager').then((mod) => {
    const testWindow = getDevTestWindow();
    if (!testWindow) return;
    testWindow.__storeRefs = {
      ...(testWindow.__storeRefs || {}),
      verificationStore: mod.useVerificationStore,
    };
  });

  import('./test/scenarios/apply-dev').then((mod) => {
    const testWindow = getDevTestWindow();
    if (!testWindow) return;
    testWindow.__scenarios = {
      ...(testWindow.__scenarios || {}),
      applyScenarioDev: mod.applyScenarioDev,
      applyDevScenarioPreset: mod.applyDevScenarioPreset,
      replayLastAppliedDevScenario: mod.replayLastAppliedDevScenario,
      getActiveDevScenarioPresetId: mod.getActiveDevScenarioPresetId,
      getLastAppliedDevScenarioPresetId: mod.getLastAppliedDevScenarioPresetId,
      cancelSequenceDrawerToolbarRetry: mod.cancelSequenceDrawerToolbarRetry,
      resetToLiveState: mod.resetToLiveState,
    };

    void import('./test/cold-start-reload-bridge').then(
      ({ installDna708bColdStartReloadBridge }) => {
        const liveWindow = getDevTestWindow();
        if (!liveWindow) return;
        installDna708bColdStartReloadBridge({
          target: liveWindow,
          resetColdCaches: async () => {
            const [scene, cache] = await Promise.all([
              import('./features/sequence/components/usePrepackedAssemblyAnnotationScene'),
              import('./features/sequence/components/useAssemblyPrepackedAnnotationSceneCache'),
            ]);
            scene.resetPrepackedAssemblyAnnotationSceneTasksForTest();
            cache.resetAssemblyPrepackedAnnotationSceneCacheTasksForTest();
          },
          closeAllTabs: () => {
            const closeAllTabs = liveWindow.__test?.closeAllTabs;
            if (typeof closeAllTabs === 'function') (closeAllTabs as () => void)();
          },
          applyPreset: (presetId) => mod.applyDevScenarioPreset(presetId),
          mainIpcHeartbeat: (sessionId) => platform().genome.getDebugSnapshot(sessionId),
          getAppliedPresetId: () =>
            mod.getActiveDevScenarioPresetId() ?? mod.getLastAppliedDevScenarioPresetId(),
        });
      }
    );
  });

  import('./test/scenarios/presets').then((mod) => {
    const testWindow = getDevTestWindow();
    if (!testWindow) return;
    testWindow.__scenarios = {
      ...(testWindow.__scenarios || {}),
      sangerCleanFwdSession: mod.sangerCleanFwdSession,
      sangerCleanRcSession: mod.sangerCleanRcSession,
      sangerRcWithIndelsSession: mod.sangerRcWithIndelsSession,
      sangerHeterozygousSession: mod.sangerHeterozygousSession,
      sangerFailedSession: mod.sangerFailedSession,
      agentTraceCliSession: mod.agentTraceCliSession,

      sangerSession: mod.sangerSession,
      staleAlignmentSession: mod.staleAlignmentSession,
      realAssemblyGibsonPcrPcr: mod.realAssemblyGibsonPcrPcr,
      realAssemblyGibsonPcrPcrSpacer: mod.realAssemblyGibsonPcrPcrSpacer,
      realAssemblyGibsonPcrRdPcr: mod.realAssemblyGibsonPcrRdPcr,
      realAssemblyGibsonPcrRdPcrTwoSpacers: mod.realAssemblyGibsonPcrRdPcrTwoSpacers,
      realAssemblyNebuilderRdSpacer: mod.realAssemblyNebuilderRdSpacer,
      realAssemblyGoldenGatePcrPcr: mod.realAssemblyGoldenGatePcrPcr,
      realAssemblyGoldenGatePcrPcrSpacer: mod.realAssemblyGoldenGatePcrPcrSpacer,
      realAssemblyGoldenGatePcrRdPcr: mod.realAssemblyGoldenGatePcrRdPcr,
      realAssemblyGoldenGateRdEnzymeMismatchInvalid:
        mod.realAssemblyGoldenGateRdEnzymeMismatchInvalid,
      realAssemblyGoldenGateInternalSite: mod.realAssemblyGoldenGateInternalSite,
      ytkMocloFactoryExpressionCassette: mod.ytkMocloFactoryExpressionCassette,

      cdsExtensionIncompleteCdsScenario: mod.cdsExtensionIncompleteCdsScenario,
      cdsExtensionOriginSpanScenario: mod.cdsExtensionOriginSpanScenario,
      cdsExtensionStopJustPastOriginScenario: mod.cdsExtensionStopJustPastOriginScenario,
      cdsExtensionStopFarPastOriginScenario: mod.cdsExtensionStopFarPastOriginScenario,
    };
  });
}

function getE2EParams(): { workspace?: string; openFile?: string; e2e?: boolean } {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  return {
    workspace: params.get('workspace') || undefined,
    openFile: params.get('openFile') || undefined,

    e2e: params.get('e2e') === 'true',
  };
}

function App({ onShellReady }: { onShellReady?: () => Promise<void> } = {}) {
  const { dispatchCommand } = useCommandRegistry();
  useEffect(() => {
    const uninstallEpisodeCorrelation = installTelemetryEpisodeCorrelationBridge();
    const uninstallWorkflowTelemetry = installWorkflowTelemetryObservers();
    return () => {
      uninstallEpisodeCorrelation();
      uninstallWorkflowTelemetry();
    };
  }, []);

  const [shellPrepared, setShellPrepared] = useState(() => isHostedBrowserRuntime());
  const [workspaceRestored, setWorkspaceRestored] = useState(() => isHostedBrowserRuntime());
  const [shellError, setShellError] = useState<string | null>(null);
  const [isDevPanelOpen, setIsDevPanelOpen] = useState(false);
  const hostedFileInputRef = useRef<HTMLInputElement>(null);
  const [hostedHistoryOpen, setHostedHistoryOpen] = useState(false);
  const [hostedBrowserReadOpen, setHostedBrowserReadOpen] = useState(false);
  const [hostedShareOpen, setHostedShareOpen] = useState(false);
  const [hostedStatus, setHostedStatus] = useState<string | null>(null);
  const hostedRouteReadiness = useAISettingsStore((state) => state.hostedRouteReadiness);
  const refreshHostedRouteReadiness = useAISettingsStore(
    (state) => state.refreshHostedRouteReadiness
  );
  const hostedAskAiOpeningRef = useRef(false);
  const activeConversationId = useChatStore((state) => state.currentConversationId);
  const [benchlingMigrationOpen, setBenchlingMigrationOpen] = useState(false);
  const [createDestinationRequest, setCreateDestinationRequest] =
    useState<CreateDestinationRequest | null>(null);
  const [benchlingMigrationSession, dispatchBenchlingMigrationSession] = useReducer(
    reduceMigrationSessionSelection,
    initialMigrationSessionSelection
  );
  const showBenchlingMigration = useCallback((event: MigrationSessionOpenEvent) => {
    dispatchBenchlingMigrationSession(event);
    setBenchlingMigrationOpen(true);
  }, []);
  const openBenchlingMigration = useCallback(
    () => showBenchlingMigration({ type: 'new_migration_opened' }),
    [showBenchlingMigration]
  );
  const closeBenchlingMigration = useCallback(() => {
    dispatchBenchlingMigrationSession({ type: 'modal_closed' });
    setBenchlingMigrationOpen(false);
  }, []);
  const benchlingMigrationPlatform = useMemo(() => platform().benchlingMigration, []);
  const benchlingMigrationDialogOpen = useMemo(() => platform().dialog.open, []);
  const benchlingMigrationBridge = useMemo(
    () =>
      createDesktopBenchlingMigrationWizardBridge(
        benchlingMigrationPlatform,
        benchlingMigrationDialogOpen
      ),
    [benchlingMigrationDialogOpen, benchlingMigrationPlatform]
  );
  const projectCollectionRestoredRef = useRef(false);
  const {
    snapshot: benchlingMigrationStatus,
    completedRun: completedBenchlingMigrationRun,
    observeRun: observeBenchlingMigrationRun,
    clear: clearBenchlingMigrationStatus,
  } = useBenchlingMigrationStatus(
    benchlingMigrationPlatform,
    BENCHLING_FILE_MIGRATION_ENABLED && shellPrepared
  );
  const handleBenchlingMigrationRunChange = useCallback(
    (run: BenchlingMigrationRunView | null) => {
      dispatchBenchlingMigrationSession({ type: 'run_observed', runId: run?.id });
      observeBenchlingMigrationRun(run);
    },
    [observeBenchlingMigrationRun]
  );
  const {
    history: benchlingMigrationHistory,
    error: benchlingMigrationHistoryError,
    refresh: refreshBenchlingMigrationHistory,
  } = useBenchlingMigrationHistory(
    benchlingMigrationPlatform,
    BENCHLING_FILE_MIGRATION_ENABLED && shellPrepared
  );
  const benchlingMigrationWasOpen = useRef(false);
  useEffect(() => {
    if (benchlingMigrationOpen) {
      benchlingMigrationWasOpen.current = true;
      return;
    }
    if (!benchlingMigrationWasOpen.current) return;
    benchlingMigrationWasOpen.current = false;
    void refreshBenchlingMigrationHistory();
  }, [benchlingMigrationOpen, refreshBenchlingMigrationHistory]);
  const [goToFileOpen, setGoToFileOpen] = useState(false);
  useAppShortcutActions(() => setGoToFileOpen(true));
  const [settingsFocusTarget, setSettingsFocusTarget] = useState<SettingsPanelFocusTarget | null>(
    null
  );

  const toolboxBadge = useToolboxBadge();
  const {
    activeView,
    sidebarVisible,
    sidebarWidth,
    handleViewChange,
    toggleSidebar,
    commitSidebarWidth,
    handleOpenSettings,
    revealWorkspace,
  } = useSidebar({ toolboxBadge });
  const activeViewRef = useRef(activeView);
  const activeViewGenerationRef = useRef(0);
  if (activeViewRef.current !== activeView) activeViewGenerationRef.current += 1;
  activeViewRef.current = activeView;
  const handleActivityViewChange = useCallback(
    (view: ActivityView) => {
      if (view === 'home') {
        void refreshRecentlyEdited(50).catch((error) => {
          console.error('[App] Failed to refresh Recently Edited:', error);
        });
      }
      handleViewChange(view);
    },
    [handleViewChange]
  );
  const managedOperationsSnapshot = useSyncExternalStore(
    managedOperations.subscribe,
    managedOperations.getSnapshot,
    managedOperations.getSnapshot
  );
  const electronWorkspaceSession = useSyncExternalStore(
    electronWorkspaceSessionController.subscribe,
    electronWorkspaceSessionController.getState,
    electronWorkspaceSessionController.getState
  );
  const hostedBrowserReadTarget = useMemo<HostedBrowserReadTarget | null>(() => {
    if (!isHostedBrowserRuntime() || !electronWorkspaceSession.activeWorkspaceId) return null;
    const workspace = electronWorkspaceSession.workspaces.find(
      (candidate) => candidate.workspaceId === electronWorkspaceSession.activeWorkspaceId
    );
    return workspace
      ? { workspaceId: workspace.workspaceId, displayName: workspace.displayName }
      : null;
  }, [electronWorkspaceSession.activeWorkspaceId, electronWorkspaceSession.workspaces]);
  const hostedShareTarget = useMemo<HostedShareTarget | null>(() => {
    if (!isHostedBrowserRuntime()) return null;
    const workspaceId = electronWorkspaceSession.activeWorkspaceId;
    const revisionId = electronWorkspaceSession.snapshot?.revisionId;
    if (!workspaceId || !revisionId) return null;
    const workspace = electronWorkspaceSession.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!workspace) return null;
    return {
      workspaceId,
      revisionId,
      revisionNumber: electronWorkspaceSession.snapshot?.revisionNumber ?? 0,
      workspaceName: workspace.displayName,
    };
  }, [
    electronWorkspaceSession.activeWorkspaceId,
    electronWorkspaceSession.snapshot?.revisionId,
    electronWorkspaceSession.snapshot?.revisionNumber,
    electronWorkspaceSession.workspaces,
  ]);
  useEffect(() => {
    setHostedBrowserReadOpen(false);
  }, [electronWorkspaceSession.activeWorkspaceId]);
  const {
    jobsSnapshot,
    jobsProjection,
    importingRecordedRun,
    canImportRecordedRun,
    handleStopWorkflow,
    handleImportWorkflowResult,
    handleOpenWorkflowResult,
    handleReleaseWorkflowResult,
    handleReconnectWorkflowOwners,
    handleLoadWorkflowActions,
    handleImportRecordedRun,
  } = useJobsSidebar({
    activeView,
    hostedWorkspaceId: electronWorkspaceSession.activeWorkspaceId,
    managedOperationsSnapshot,
  });
  const unconnectedRegistry = useActionablePendingRefs();

  const openMigrationSettings = useCallback(() => {
    setSettingsFocusTarget('migrations');
    handleViewChange('settings');
  }, [handleViewChange]);
  useBenchlingMigrationNotifications(
    benchlingMigrationStatus,
    openMigrationSettings,
    completedBenchlingMigrationRun
  );
  const viewBenchlingMigrationDetails = useCallback(() => {
    closeBenchlingMigration();
    clearBenchlingMigrationStatus();
    openMigrationSettings();
    void refreshBenchlingMigrationHistory();
  }, [
    clearBenchlingMigrationStatus,
    closeBenchlingMigration,
    openMigrationSettings,
    refreshBenchlingMigrationHistory,
  ]);

  useUpdateToasts();
  useFileAssociationOpportunities();

  useDevLimsSeedPrompt();

  const workspaceOccludedByLimsOverlay = useLimsOverlayStore((s) => s.active);

  const openReferenceLibrary = useCallback(() => {
    handleViewChange('references');
  }, [handleViewChange]);
  const [genomeViewFileOpen, setGenomeViewFileOpen] = useState<number | null>(null);
  useEffect(() => {
    const beginFileOpen = () => setGenomeViewFileOpen(pendingGenomeViewFileOpen()?.id ?? null);
    window.addEventListener(GENOME_VIEW_OPEN_REQUESTED, beginFileOpen);
    window.addEventListener(GENOME_VIEW_OPEN_FINISHED, beginFileOpen);
    return () => {
      window.removeEventListener(GENOME_VIEW_OPEN_REQUESTED, beginFileOpen);
      window.removeEventListener(GENOME_VIEW_OPEN_FINISHED, beginFileOpen);
    };
  }, []);
  const openAssistantSettings = useCallback(() => {
    setSettingsFocusTarget('assistant');
    handleViewChange('settings');
  }, [handleViewChange]);
  const configureAssistantHost = useCallback(
    (hostId: AssistantHostId) => {
      setSettingsFocusTarget(hostId === 'direct-api' ? 'api-keys' : `assistant-host:${hostId}`);
      handleViewChange('settings');
    },
    [handleViewChange]
  );
  useEffect(() => {
    return subscribeSettingsEntry((entry) => {
      setSettingsFocusTarget(entry);
      handleViewChange('settings');
    });
  }, [handleViewChange]);

  useEffect(() => {
    if (isHostedBrowserRuntime()) return;
    const openFileHandling = () => {
      setSettingsFocusTarget('file-handling');
      handleViewChange('settings');
    };
    const revealPreview = () => handleViewChange('files');
    window.addEventListener(OPEN_FILE_HANDLING_SETTINGS_EVENT, openFileHandling);
    window.addEventListener(REVEAL_OPEN_DOCUMENT_EVENT, revealPreview);
    return () => {
      window.removeEventListener(OPEN_FILE_HANDLING_SETTINGS_EVENT, openFileHandling);
      window.removeEventListener(REVEAL_OPEN_DOCUMENT_EVENT, revealPreview);
    };
  }, [handleViewChange]);

  const {
    settingsViewActive,
    homeViewActive,
    referencesViewActive,
    featureViewActive,
    emptyFilesHomeActive,
    homeWorkbenchActive,
    workspaceTakeoverActive,
    sidebarChromeVisible,
  } = useWorkspaceMainMode(activeView, sidebarVisible);

  const workspaceExplorerInsetRef = useRef(sidebarVisible ? sidebarWidth + 2 : 0);
  if (!workspaceTakeoverActive) {
    workspaceExplorerInsetRef.current = sidebarVisible ? sidebarWidth + 2 : 0;
  }

  useEffect(() => {
    sweepExpandedPathRoots();
  }, []);

  const filesPanelActive = !(
    (import.meta.env.DEV && activeView === 'toolbox') ||
    activeView === 'lims' ||
    activeView === 'search' ||
    activeView === 'jobs' ||
    activeView === 'source-control' ||
    isRendererFeatureSidebarView(activeView)
  );

  const clearSettingsFocusTarget = useCallback(() => {
    setSettingsFocusTarget(null);
  }, []);

  const e2eHasInitializedRef = useRef(false);

  const workspaceSetPathDeliveryIdsRef = useRef<Set<string> | null>(null);
  const workspaceSetPathInFlightDeliveryIdsRef = useRef(new Set<string>());
  if (workspaceSetPathDeliveryIdsRef.current === null) {
    workspaceSetPathDeliveryIdsRef.current = loadWorkspaceDeliveryReceipts(sessionStorage);
  }

  const workspace = useWorkspace();
  const { path: workspacePath, loading: workspaceLoading, setWorkspacePath } = workspace;
  const { folders, addFolder, removeFolder, renameFolder, selectedPath, fileTreeRefreshToken } =
    useWorkspaceStore();
  const electronWorkspaceRootsKey = folders
    .map((folder) => `${folder.path}\0${folder.name}`)
    .join('\0');
  const [projectHomePath, setProjectHomePath] = useState<string | null>(null);
  const [projectLibraryPopover, setProjectLibraryPopover] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const { library, libraryLoaded, libraryLoadError, mountedProjects, projectHomeProject } =
    useWorkspaceLibrary({
      shellPrepared,
      workspacePath,
      folders,
      fileTreeRefreshToken,
      projectHomePath,
      renameFolder,
    });

  const revealTerminalTab = useCallback(() => {
    if (workspaceTakeoverActive || workspaceOccludedByLimsOverlay) revealWorkspace();
    setProjectHomePath(null);
  }, [workspaceTakeoverActive, workspaceOccludedByLimsOverlay, revealWorkspace]);

  const [devFixturesMounted] = useDevFixturesMounted();
  const openInFocusedPanel = useCanvasStore((s) => s.openInFocusedPanel);
  const optionalSetupStarted = useRef(false);

  const recentlyEditedWorkspaceAccessKey = useMemo(
    () => mountedWorkspaceAccessKey(folders),
    [folders]
  );
  const [preparedRecentlyEditedAccessKey, setPreparedRecentlyEditedAccessKey] = useState<
    string | null
  >(null);
  const recentlyEditedPreparationQueue = useRef(Promise.resolve());
  useEffect(() => {
    let current = true;
    const preparation = enqueueRecentlyEditedPreparation(
      recentlyEditedPreparationQueue.current,
      folders
    );
    recentlyEditedPreparationQueue.current = preparation;
    void preparation
      .then(() => {
        if (current) setPreparedRecentlyEditedAccessKey(recentlyEditedWorkspaceAccessKey);
      })
      .catch((err) => {
        console.warn('[App] Failed to prepare Recently Edited workspace access:', err);
      });
    return () => {
      current = false;
    };
  }, [folders, recentlyEditedWorkspaceAccessKey]);
  const recentlyEditedReady = preparedRecentlyEditedAccessKey === recentlyEditedWorkspaceAccessKey;

  useEffect(() => {
    try {
      const p = platform();
      if (p?.on) {
        return p.on('workspace:set-path', (...args: unknown[]) => {
          const wsPath = typeof args[0] === 'string' ? args[0] : '';
          if (!wsPath) return;
          const deliveryId = typeof args[1] === 'string' ? args[1] : undefined;
          const telemetryContext = args[2];
          if (deliveryId) {
            const delivered = workspaceSetPathDeliveryIdsRef.current;
            if (!delivered) return;
            if (
              delivered.has(deliveryId) ||
              workspaceSetPathInFlightDeliveryIdsRef.current.has(deliveryId)
            ) {
              return;
            }
            workspaceSetPathInFlightDeliveryIdsRef.current.add(deliveryId);
          }
          console.log('[App] Setting workspace from main process:', wsPath);
          void openWorkspaceFromSource(
            { kind: 'local-folder', path: wsPath },
            { inPlace: true, makeCurrent: true }
          )
            .then(() => {
              if (deliveryId) {
                const delivered = workspaceSetPathDeliveryIdsRef.current;
                if (!delivered) return;
                if (!rememberWorkspaceDeliveryReceipt(delivered, deliveryId, sessionStorage)) {
                  return;
                }
              }

              observeWorkspaceSetPath(wsPath, deliveryId, telemetryContext);
            })
            .catch((error) => {
              console.error('[App] Failed to mount workspace from main process:', error);
              useToastStore
                .getState()
                .addToast(toUserMessage(error, 'failure.failed-to-open-project'), {
                  definition: 'app-failed-to-open-project',
                });
            })
            .finally(() => {
              if (deliveryId) {
                workspaceSetPathInFlightDeliveryIdsRef.current.delete(deliveryId);
              }
            });
        });
      }
    } catch {}
  }, [setWorkspacePath, workspacePath]);

  useEffect(() => {
    if (import.meta.env.DEV !== true) return;
    if (isHostedBrowserRuntime()) return;
    if (!devFixturesMounted) return;
    if (DEV_SURFACES.devAssets && !folders.some((f) => f.path === DEV_ASSETS_PATH)) {
      console.log('[App] Auto-mounting Dev Assets:', DEV_ASSETS_PATH);
      addFolder(DEV_ASSETS_PATH, 'Dev Assets', { pinned: true });
    }
  }, [folders, addFolder, devFixturesMounted]);

  useEffect(() => {
    if (!IS_DEV) return;
    if (isHostedBrowserRuntime()) return;
    if (!devFixturesMounted) return;

    const fixtureRoots = [{ path: DEV_TEST_FIXTURES_PATH, name: 'Test Fixtures' }].filter(
      (root) => root.path
    );

    for (const root of fixtureRoots) {
      if (!folders.some((f) => f.path === root.path)) {
        console.log(`[App] Auto-mounting ${root.name}:`, root.path);
        addFolder(root.path, root.name, { pinned: true });
      }
    }
  }, [folders, addFolder, devFixturesMounted]);

  useEffect(() => {
    if (!IS_DEV || isHostedBrowserRuntime() || devFixturesMounted) return;
    const fixturePaths = [DEV_ASSETS_PATH, DEV_TEST_FIXTURES_PATH].filter(Boolean);
    for (const path of fixturePaths) {
      if (folders.some((f) => f.path === path)) {
        console.log('[App] Unmounting dev fixture (dev toggle):', path);
        removeFolder(path);
      }
    }
  }, [folders, removeFolder, devFixturesMounted]);

  useEffect(() => {
    if (!isBrowserOnly()) return;
    const hasUserFolder = folders.some((f) => !f.pinned);
    if (hasUserFolder) return;
    if (folders.some((f) => f.path === MOCK_WORKSPACE_PATH)) return;
    console.log('[App] Auto-mounting mock workspace for browser-only mode');

    addFolder(MOCK_WORKSPACE_PATH);
  }, [folders, addFolder]);

  useWindowState();

  useFileDrag();

  const { openEntityImport, openProjectImport } = useImportWizard();

  useWorkspaceFileRelocatedRetarget();

  const { capture: captureSnapshot } = useDebugSnapshot({
    getAppState: useCallback(() => {
      let webgl: unknown = null;
      try {
        webgl = snapshotWebGLState();
      } catch (err) {
        webgl = { error: toUserMessage(err, 'operation.failed') };
      }

      let profilerTail: unknown = null;
      try {
        const w = getDevTestWindow();
        if (typeof w?.__perfEntries === 'function') {
          const entries = w.__perfEntries();
          profilerTail = entries.slice(-300);
        }
      } catch (err) {
        profilerTail = { error: toUserMessage(err, 'operation.failed') };
      }

      let webglSelectionDebug: unknown = null;
      try {
        const w = getDevTestWindow();
        if (typeof w?.__dumpWebGLSelectionDebug === 'function') {
          webglSelectionDebug = w.__dumpWebGLSelectionDebug();
        }
      } catch (err) {
        webglSelectionDebug = { error: toUserMessage(err, 'operation.failed') };
      }

      return {
        workspace: useWorkspaceStore.getState(),
        canvas: useCanvasStore.getState(),
        webgl,
        webglTrace: getWebGLTrace(),
        webglSelectionDebug,
        profilerTail,
        viewport: {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
      };
    }, []),
    onCapture: useCallback(() => {
      useToastStore
        .getState()
        .addToast(userMessage('notice.snapshot-saved'), { definition: 'debug-snapshot-saved' });
    }, []),
    onError: useCallback((error: Error) => {
      console.error('[DebugSnapshot] Failed:', error);
      useToastStore.getState().addToast(toUserMessage(error, 'operation.failed'), {
        definition: 'debug-snapshot-failed',
      });
    }, []),
  });

  const handleWebGLTraceToggle = useCallback(async () => {
    if (!isWebGLTraceActive()) {
      startWebGLTrace();
      useToastStore
        .getState()
        .addToast(userMessage('notice.webgl-trace-recording-press-cmd-shift-7-to-stop'), {
          definition: 'debug-webgl-recording',
        });
      return;
    }

    const trace = stopWebGLTrace();
    const result = await captureSnapshot(`WebGL render trace (${trace.entries.length} events)`);
    if (result?.filePath) {
      useToastStore.getState().addToast(
        userMessageWithValues('notice.webgl-trace-saved-value', {
          value0: userMessageValue(result.filePath.split('/').slice(-2).join('/')),
        }),
        {
          definition: 'debug-webgl-saved',
        }
      );
    }
  }, [captureSnapshot]);

  const cpuProfileActiveRef = useRef(false);
  const handleCpuProfileToggle = useCallback(async () => {
    const api = window.electronAPI as typeof window.electronAPI & {
      tracing?: {
        profilerStart: (opts?: {
          samplingIntervalUs?: number;
        }) => Promise<{ ok: boolean; error?: string }>;
        profilerStop: () => Promise<{
          ok: boolean;
          filePath?: string;
          durationMs?: number;
          error?: string;
        }>;
      };
    };
    if (!api?.tracing) {
      useToastStore
        .getState()
        .addToast(userMessage('notice.cpu-profile-unavailable-not-in-electron'), {
          definition: 'debug-cpu-unavailable',
        });

      return;
    }
    try {
      if (!cpuProfileActiveRef.current) {
        const res = await api.tracing.profilerStart();
        if (!res.ok) throw new Error(res.error ?? 'profilerStart failed');
        cpuProfileActiveRef.current = true;
        useToastStore
          .getState()
          .addToast(userMessage('notice.cpu-profile-recording-press-cmd-shift-0-to-stop'), {
            definition: 'debug-cpu-recording',
          });
      } else {
        const res = await api.tracing.profilerStop();
        cpuProfileActiveRef.current = false;
        if (!res.ok) throw new Error(res.error ?? 'profilerStop failed');
        useToastStore.getState().addToast(
          userMessageWithValues('notice.cpu-profile-saved-valuems-value', {
            value0: userMessageValue(res.durationMs),
            value1: userMessageValue(res.filePath?.split('/').slice(-2).join('/')),
          }),
          { definition: 'debug-cpu-saved' }
        );
      }
    } catch (err) {
      cpuProfileActiveRef.current = false;
      console.error('[CPUProfile] toggle failed', err);
      useToastStore.getState().addToast(toUserMessage(err, 'operation.failed'), {
        definition: 'debug-cpu-failed',
      });
    }
  }, []);

  const handleChatSnapshot = useCallback(async () => {
    try {
      const filePath = await captureAndSaveSnapshot();
      useToastStore
        .getState()
        .addToast(userMessage('notice.chat-snapshot-saved'), { definition: 'debug-chat-saved' });

      console.log('[ChatSnapshot] Saved:', filePath);
    } catch (error) {
      console.error('[ChatSnapshot] Failed:', error);
      useToastStore
        .getState()
        .addToast(toUserMessage(error, 'operation.failed'), { definition: 'debug-chat-failed' });
    }
  }, []);

  const focusChatComposer = useCallback(() => {
    const focusVisibleComposer = () => {
      const focusedPanel = document.querySelector<HTMLElement>('[data-panel-focused="true"]');
      const inputs = Array.from(
        document.querySelectorAll<HTMLTextAreaElement>('[data-testid="ai-input"]')
      );
      const input =
        focusedPanel?.querySelector<HTMLTextAreaElement>(
          '[data-testid="ai-input"]:not(:disabled)'
        ) ??
        inputs.find((candidate) => candidate.getClientRects().length > 0 && !candidate.disabled) ??
        inputs.find((candidate) => !candidate.disabled);
      return safeFocus(input, { preventScroll: true });
    };

    focusVisibleComposer();
    window.requestAnimationFrame(() => {
      if (focusVisibleComposer()) return;
      window.setTimeout(() => {
        focusVisibleComposer();
      }, 80);
    });
  }, []);

  useEffect(() => {
    return subscribeRegistryOpen((request) => {
      if (request) {
        useLimsOverlayStore
          .getState()
          .requestRegistryEntity(
            request.entityId,
            request.fallbackSearch,
            request.organizationId
              ? { organizationId: request.organizationId, action: request.action }
              : undefined
          );
      }
      handleViewChange('lims');
    });
  }, [handleViewChange]);

  const openAIChat = useCallback(() => {
    if (isHostedBrowserRuntime() && hostedAskAiOpeningRef.current) return;
    const navigation = beginAIChatNavigation();
    const sourceViewGeneration = activeViewGenerationRef.current;
    const ownsNavigation = () =>
      navigation.isCurrent() && activeViewGenerationRef.current === sourceViewGeneration;
    if (isHostedBrowserRuntime()) {
      hostedAskAiOpeningRef.current = true;
      void (refreshHostedRouteReadiness?.() ?? Promise.resolve(hostedRouteReadiness))
        .then(async (readiness) => {
          const savedChats = readiness === 'ready' ? null : await getConversationHistory();
          if (!ownsNavigation()) return;
          if (readiness !== 'ready' && savedChats?.length === 0) {
            setHostedBrowserReadOpen(true);
            return;
          }
          setHostedBrowserReadOpen(false);
          trackToolOpened('agent_chat', 'command_palette');
          handleViewChange('ai');
          useCanvasStore.getState().openChatTab();
          focusChatComposer();
        })
        .catch(() => {
          if (ownsNavigation()) setHostedBrowserReadOpen(true);
        })
        .finally(() => {
          hostedAskAiOpeningRef.current = false;
        });
      return;
    }
    trackToolOpened('agent_chat', 'command_palette');
    handleViewChange('ai');
    const canvasBeforeOpen = useCanvasStore.getState();
    const focusedPanel = canvasBeforeOpen.focusedPanelId
      ? canvasBeforeOpen.panels[canvasBeforeOpen.focusedPanelId]
      : undefined;
    const retainedChatWasOpen =
      focusedPanel?.tabs.some(
        (tab) => tab.type === 'chat' && tab.id === focusedPanel.activeTabId
      ) ?? false;
    useCanvasStore.getState().openChatTab();

    if (retainedChatWasOpen) {
      void useAISettingsStore.getState().refreshAgentDetection();
    }
    focusChatComposer();
  }, [
    activeView,
    focusChatComposer,
    handleViewChange,
    hostedRouteReadiness,
    refreshHostedRouteReadiness,
  ]);

  const openAIChatWithConversation = useCallback(
    (conversationId: string) => {
      const sourceViewGeneration = activeViewGenerationRef.current;
      void resumeAIConversation({
        conversationId,
        workspacePath: resolveChatWorkspacePath(workspacePath, folders),
        isCurrent: () => activeViewGenerationRef.current === sourceViewGeneration,
      })
        .then((result) => {
          if (result !== 'opened') return;
          trackToolOpened('agent_chat', 'welcome');
          handleViewChange('ai');
          focusChatComposer();
        })
        .catch((error: unknown) => {
          console.error('[App] Failed to open a saved chat:', error);
          useToastStore.getState().addToast(toUserMessage("Couldn't open that chat — try again."), {
            definition: 'chat-history-failed',
          });
        });
    },
    [focusChatComposer, folders, handleViewChange, workspacePath]
  );

  const newChatInFlightRef = useRef(false);
  const openNewAIChat = useCallback(() => {
    if (newChatInFlightRef.current) return;
    newChatInFlightRef.current = true;
    const navigation = beginAIChatNavigation();
    const sourceViewGeneration = activeViewGenerationRef.current;
    const chatWorkspacePath = resolveChatWorkspacePath(workspacePath, folders);
    const canvasState = useCanvasStore.getState();
    const focusedPanel = canvasState.focusedPanelId
      ? canvasState.panels[canvasState.focusedPanelId]
      : undefined;
    const focusedTab = focusedPanel?.tabs.find((tab) => tab.id === focusedPanel.activeTabId);
    const visibleConversationId = focusedTab?.type === 'chat' ? focusedTab.entityId : null;

    void useChatStore
      .getState()
      .newConversation(chatWorkspacePath, { sourceConversationId: visibleConversationId })
      .then((conversationId) => {
        if (
          !navigation.isCurrent() ||
          activeViewGenerationRef.current !== sourceViewGeneration ||
          useChatStore.getState().currentConversationId !== conversationId
        )
          return;
        trackToolOpened('agent_chat', 'command_palette');

        handleViewChange('ai');
        useCanvasStore.getState().retargetChatTab(conversationId);
        focusChatComposer();
      })
      .catch((error: unknown) => {
        if (!navigation.isCurrent() || activeViewGenerationRef.current !== sourceViewGeneration)
          return;
        console.error('[App] Failed to create a new chat:', error);
        useToastStore
          .getState()
          .addToast(userMessage('notice.couldn-t-start-a-new-chat-try-again'), {
            definition: 'app-couldn-t-start-a-new-chat-try-again',
          });
      })
      .finally(() => {
        newChatInFlightRef.current = false;
      });
  }, [focusChatComposer, folders, handleViewChange, workspacePath]);

  useEffect(() => startReferenceInvalidationListeners(), []);

  const reconcileChangedWorkspace = useCallback(
    async (
      rootPath: string | null | undefined,
      options: { rejectOnFailure?: boolean } = {}
    ): Promise<void> => {
      if (!rootPath || !isDesktopRuntime()) return;
      try {
        await reconcileWorkspaceAfterFilesChanged({
          workspaceRoot: rootPath,
          strict: options.rejectOnFailure,
        });
      } catch (err) {
        console.warn('[App] Failed to reconcile workspace root:', err);
        if (options.rejectOnFailure) throw err;
      }
    },
    []
  );

  const handleCreateEntity = useCallback(
    async (request: ExplorerEntityCreateRequest) => {
      if (!request.destinationPath) {
        setCreateDestinationRequest(request);
        return;
      }
      const destinationPath = request.destinationPath;

      if (
        request.entityType === 'primers' ||
        request.entityType === 'dna-oligos' ||
        request.entityType === 'rna-oligos'
      ) {
        const owner = findContainingPathBoundary(folders, destinationPath);
        if (!owner) {
          useToastStore
            .getState()
            .addToast(
              userMessage('notice.choose-a-folder-inside-an-open-project-before-creating-an-oligo'),
              {
                definition: 'app-choose-a-folder-inside-an-open-project-before-creating-an-oligo',
              }
            );
          return;
        }
        const orderType = request.entityType === 'rna-oligos' ? 'rna' : 'dna';
        const label =
          request.entityType === 'primers'
            ? UNTITLED_PRIMER_NAME
            : orderType === 'rna'
              ? UNTITLED_RNA_OLIGO_NAME
              : UNTITLED_DNA_OLIGO_NAME;
        openInFocusedPanel('primer', `primer-draft:${crypto.randomUUID()}`, label, {
          artifactDocument: {
            kind: 'primer',
            persistence: 'draft',
            workspaceRoot: owner.path,
            destinationPath,
            orderType,
          },
        });
        return;
      }

      if (request.entityType === 'strains' || request.entityType === 'registry-types') {
        openEntityCreation({ entityType: request.entityType, destinationPath });
        return;
      }
      if (request.entityType === 'proteins') {
        const owner = findContainingPathBoundary(folders, destinationPath);
        if (!owner) {
          useToastStore
            .getState()
            .addToast(
              userMessage(
                'notice.choose-a-folder-inside-an-open-project-before-creating-a-protein'
              ),
              {
                definition: 'app-choose-a-folder-inside-an-open-project-before-creating-a-protein',
              }
            );
          return;
        }
        openInFocusedPanel('protein', `protein-draft:${crypto.randomUUID()}`, 'Untitled Protein', {
          artifactDocument: {
            kind: 'protein',
            persistence: 'draft',
            workspaceRoot: owner.path,
            destinationPath,
          },
        });
        return;
      }
      if (request.entityType !== 'dna-sequences' || !request.name) return;

      try {
        const created = await createEmptyDnaSequence({
          destinationPath,
          name: request.name,
          ...(request.creationId ? { creationId: request.creationId } : {}),
          ...(request.sequenceCreation ? { publication: request.sequenceCreation } : {}),
        });
        return created;
      } catch (error) {
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.failed-to-create-dna-sequence'), {
            definition: 'app-failed-to-create-dna-sequence',
          });
        throw error;
      }
    },
    [folders, openInFocusedPanel]
  );

  useEffect(() => installWorkspaceFilesChangedAdapter(), []);

  useEffect(
    () =>
      platform().notebook.onMarkdownAdopted?.((adopted) => {
        const canvas = useCanvasStore.getState();
        for (const panel of Object.values(canvas.panels)) {
          for (const tab of panel.tabs) {
            if (tab.type === 'text' && tab.entityId === adopted.sourcePath)
              canvas.retargetTab(
                panel.id,
                tab.id,
                { type: 'page', entityId: adopted.pageId },
                { label: adopted.title }
              );
          }
        }
        useWorkspaceStore.getState().bumpFileTreeRefresh();
        void usePageStore.getState().refreshNewPages();
      }),
    []
  );

  useEffect(
    () =>
      platform().notebook.onMarkdownAdoptionFailed?.((issue) => {
        useToastStore
          .getState()
          .addToast(toUserMessage(new Error(issue.message), 'document.openFailed'), {
            definition: 'markdown-notebook-adoption-failed',
          });
      }),
    []
  );

  useEffect(() => {
    void usePageStore.getState().initialize();
  }, []);

  useEffect(() => {
    if (!shellPrepared || !workspaceRestored || isBrowserOnly()) return;
    const projectFolders = folders.filter((folder) => !isDeveloperImportSourcePath(folder.path));
    const requestedWorkspaceId =
      isHostedBrowserRuntime() && typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('workspaceId')
        : null;
    const currentHostedWorkspaceId = isHostedBrowserRuntime()
      ? electronWorkspaceSessionController.getState().activeWorkspaceId
      : null;
    const preferredWorkspaceId =
      requestedWorkspaceId && isHostedWorkspaceId(requestedWorkspaceId)
        ? requestedWorkspaceId
        : currentHostedWorkspaceId
          ? currentHostedWorkspaceId
          : projectFolders.some((folder) => folder.path === workspacePath)
            ? workspacePath
            : (projectFolders[0]?.path ?? null);
    void initializeElectronWorkspaceSession(preferredWorkspaceId).catch((error: unknown) => {
      console.warn('[WorkspaceSession] Failed to initialize the workspace session:', error);
    });
  }, [electronWorkspaceRootsKey, folders, shellPrepared, workspacePath, workspaceRestored]);

  useEffect(() => {
    if (!isHostedBrowserRuntime()) return;
    rememberHostedWorkspaces(
      electronWorkspaceSession.workspaces.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        clientWorkspaceId: workspace.clientWorkspaceId ?? '',
        displayName: workspace.displayName,
      }))
    );

    if (electronWorkspaceSession.phase !== 'idle' || !electronWorkspaceSession.snapshot) return;
    for (const workspace of electronWorkspaceSession.workspaces) {
      if (!isHostedWorkspaceId(workspace.workspaceId)) continue;
      addFolder(hostedWorkspaceRoot(workspace.workspaceId), workspace.displayName);
    }
  }, [
    addFolder,
    electronWorkspaceSession.phase,
    electronWorkspaceSession.snapshot,
    electronWorkspaceSession.workspaces,
  ]);

  useEffect(() => {
    if (!isHostedBrowserRuntime()) return;
    const snapshot = electronWorkspaceSession.snapshot;
    if (!snapshot?.files.length) return;
    void import('./hosted/hydrate-session')
      .then(({ hydrateHostedSnapshot }) => hydrateHostedSnapshot(snapshot))
      .catch((error: unknown) => {
        console.warn('[Hosted] Failed to hydrate catalog from the accepted snapshot:', error);
      });
  }, [electronWorkspaceSession.snapshot]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const refresh = (event: Event): void => {
      const detail = (event as CustomEvent<WorkspaceFilesChangedDetail | undefined>).detail;
      void refreshElectronWorkspaceSessionForPath(detail?.path, detail?.workspaceRoot).catch(
        (error: unknown) => {
          console.warn('[WorkspaceSession] Failed to refresh the accepted Electron state:', error);
        }
      );
    };
    window.addEventListener(WORKSPACE_FILES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(WORKSPACE_FILES_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => installComputeJobTerminalAdapter(), []);

  const bindingRepairRanRef = useRef(false);
  useEffect(() => {
    if (!isDesktopRuntime() || bindingRepairRanRef.current) return;
    bindingRepairRanRef.current = true;
    void repairDuplicateCurrentBindings()
      .then((r) => {
        if (r.demoted > 0) {
          console.log(
            `[App] binding repair: collapsed ${r.demoted} duplicate current binding(s) across ${r.entities} entity(ies)`
          );
        }
      })
      .catch((err) => console.warn('[App] duplicate-binding repair failed:', err));
  }, []);

  const reconciledRootsRef = useRef<Set<string>>(new Set());
  const reconcileControllersRef = useRef<Map<string, AbortController>>(new Map());
  const [failedProjectIndexRoots, setFailedProjectIndexRoots] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const startProjectIndex = useCallback((path: string) => {
    if (reconciledRootsRef.current.has(path) || reconcileControllersRef.current.has(path)) return;
    reconciledRootsRef.current.add(path);
    const controller = new AbortController();
    reconcileControllersRef.current.set(path, controller);
    setFailedProjectIndexRoots((previous) => {
      if (!previous.has(path)) return previous;
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
    void reconcileWorkspaceOnMount(path, { signal: controller.signal })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          reconcileControllersRef.current.get(path) === controller
        ) {
          reconciledRootsRef.current.delete(path);
          setFailedProjectIndexRoots((previous) => new Set(previous).add(path));
          console.warn('[App] Failed to reconcile workspace on mount:', error);
        }
      })
      .finally(() => {
        if (reconcileControllersRef.current.get(path) === controller)
          reconcileControllersRef.current.delete(path);
      });
  }, []);
  const waitForStartupProjectMounts = useCallback(async () => {
    const roots = useWorkspaceStore.getState().folders.map((folder) => folder.path);
    for (const path of roots) startProjectIndex(path);
    await Promise.all(roots.map(waitForWorkspaceReconcileIdle));
  }, [startProjectIndex]);
  const handleRetryProjectIndex = useCallback(
    (path: string) => {
      if (
        !failedProjectIndexRoots.has(path) ||
        !useWorkspaceStore.getState().folders.some((folder) => folder.path === path)
      )
        return;
      startProjectIndex(path);
    },
    [failedProjectIndexRoots, startProjectIndex]
  );
  useEffect(
    () => () => {
      for (const controller of reconcileControllersRef.current.values()) controller.abort();
      reconcileControllersRef.current.clear();

      reconciledRootsRef.current.clear();
    },
    []
  );
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    registerAllEntityAdapters();
    assertRequiredEntityAdaptersRegistered();
    void loadAnnotationCatalogs().catch((error: unknown) => {
      console.error('[AnnotationCatalog] could not list the track store', error);
    });
    startTrackRegistrationRefresh();
    const currentPaths = new Set(folders.map((folder) => folder.path));

    for (const path of [...reconciledRootsRef.current]) {
      if (!currentPaths.has(path)) {
        reconcileControllersRef.current.get(path)?.abort();
        reconcileControllersRef.current.delete(path);
        reconciledRootsRef.current.delete(path);
      }
    }
    setFailedProjectIndexRoots((previous) => {
      const retained = new Set([...previous].filter((path) => currentPaths.has(path)));
      return retained.size === previous.size ? previous : retained;
    });

    for (const folder of folders) startProjectIndex(folder.path);
  }, [folders, startProjectIndex]);

  useEffect(() => {
    const onProjectionUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; id?: string }>).detail;
      if (detail?.kind === 'notebook' && detail.id) {
        void usePageStore
          .getState()
          .reloadPage(detail.id)
          .catch(() => undefined);
      }
    };
    window.addEventListener(ENTITY_PROJECTION_UPDATED_EVENT, onProjectionUpdated);
    return () => window.removeEventListener(ENTITY_PROJECTION_UPDATED_EVENT, onProjectionUpdated);
  }, []);

  useEffect(() => {
    return platform().cloudSync.onReplicaLifecycle(handleWorkspaceSyncReplicaLifecycleWithStores);
  }, []);

  const handleFileSelect = useCallback(
    async (
      path: string,
      tabType: TabType,
      label?: string,
      signal?: AbortSignal
    ): Promise<TabType> => {
      const result = await openSelectedDocument(path, tabType, label, signal);
      return result.status === 'presented' ? result.tabType : tabType;
    },
    []
  );

  const hostedHandoffOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isHostedBrowserRuntime() || typeof window === 'undefined') return;
    const requestedWorkspaceId = new URLSearchParams(window.location.search).get('workspaceId');
    if (!isHostedWorkspaceId(requestedWorkspaceId)) return;
    const session = electronWorkspaceSession;
    if (
      session.phase !== 'idle' ||
      session.activeWorkspaceId !== requestedWorkspaceId ||
      !session.snapshot ||
      session.activeFilePath
    ) {
      return;
    }
    const sequence = session.snapshot.files.find(
      (file) => getTabTypeForFile(file.path) === 'sequence'
    );
    if (!sequence) return;
    const handoffKey = `${requestedWorkspaceId}:${session.snapshot.revisionId ?? 'empty'}`;
    if (hostedHandoffOpenRef.current === handoffKey) return;
    hostedHandoffOpenRef.current = handoffKey;
    const absolutePath = hostedAbsolutePath(requestedWorkspaceId, sequence.path);
    void handleFileSelect(absolutePath, 'sequence', sequence.path).catch(() => {
      hostedHandoffOpenRef.current = null;
    });
  }, [electronWorkspaceSession, handleFileSelect]);

  const {
    openWorkspaceSource,
    handleBenchlingMigrationUnlocked,
    handleOpenBenchlingWorkspace,
    migrationSettings,
    importFolderWithProgress,
    handleQuickLookDestinationCommit,
    handleAddFolder,
    _handleAddFolderInPlace,
    handleCreateEmptyWorkspace,
    resolveImportRoot,
    runSingleFileImport,
    handleHostedImport,
    handleHostedSignOut,
    handleImportFile,
    handleOpenRecentlyEdited,
    handleOpenLibraryProject,
    handleArchiveProject,
    handleTrashProject,
    handleRenameProject,
    handleOpenProjectHome,
    handleOpenRegistryFromProjectHome,
    handleRevealProject,
    handleOpenProjectSwitcherFromHome,
    handleNewPage,
    handleNewDesign,
    handleCreateEntityFromUi,
    handleCreateAssembly,
    handleFindInFolder,
  } = useWorkspaceProjectActions({
    waitForStartupProjectMounts,
    shellPrepared,
    workspaceLoading,
    workspacePath,
    folders,
    selectedPath,
    projectHomePath,
    library,
    addFolder,
    removeFolder,
    setWorkspacePath,
    setProjectHomePath,
    setProjectLibraryPopover,
    setCreateDestinationRequest,
    setHostedStatus,
    setHostedBrowserReadOpen,
    hostedFileInputRef,
    projectCollectionRestoredRef,
    handleFileSelect,
    reconcileChangedWorkspace,
    handleCreateEntity,
    handleViewChange,
    refreshBenchlingMigrationHistory,
    dispatchBenchlingMigrationSession,
    closeBenchlingMigration,
    clearBenchlingMigrationStatus,
    openBenchlingMigration,
    showBenchlingMigration,
    benchlingMigrationStatus,
    benchlingMigrationHistory,
    benchlingMigrationHistoryError,
    trackFirstProductActionProxyOnce,
    workspaceRootFromCreationContext,
    artifactTitleFromCreationContext,
  });
  useAppStartup({
    shellPrepared,
    setShellPrepared,
    shellError,
    setShellError,
    workspaceRestored,
    setWorkspaceRestored,
    workspaceLoading,
    workspaceError: workspace.error,
    libraryLoaded,
    projectCollectionRestoredRef,
    onShellReady,
    optionalSetupStarted,
    devScenarioRuntimeEnabled: DEV_SCENARIO_RUNTIME_ENABLED,
    devScenarioReplayEpoch: DEV_SCENARIO_REPLAY_EPOCH,
    getE2E: getE2EParams,
    getDevTestWindow,
  });

  useAppTestBridges({
    shellPrepared,
    workspacePath,
    workspaceLoading,
    setWorkspacePath,
    e2eHasInitializedRef,
    openWorkspaceSource,
    importFolderWithProgress,
    resolveImportRoot,
    runSingleFileImport,
    handleNewPage,
    handleNewDesign,
    getE2EParams,
    getDevTestWindow,
    isDev: IS_DEV,
    e2eFixturesPath: E2E_FIXTURES_PATH,
  });

  useAppRuntimeCommands({
    openAIChat,
    openNewAIChat,
    toggleSidebar,
    handleOpenSettings,
    setSettingsFocusTarget,
    handleViewChange,
    handleFindInFolder,
    openWorkspaceSource,
    handleWebGLTraceToggle,
    handleChatSnapshot,
    captureSnapshot: () => {
      void captureSnapshot();
    },
    handleCpuProfileToggle,
    setIsDevPanelOpen,
    devShortcutsEnabled: DEV_SURFACES.devShortcuts,
  });

  const fileBrowserContent = useMemo(
    () => (
      <FileBrowser
        active={filesPanelActive && sidebarChromeVisible}
        onFileSelect={handleFileSelect}
        onAddFolder={handleAddFolder}
        onImportFile={handleImportFile}
        onCreateEntity={handleCreateEntityFromUi}
        onImportEntity={(request) => void openEntityImport(request)}
        onImportProject={() => void handleAddFolder()}
        onImportProjectWithAgent={() => void openProjectImport({ agentRequested: true })}
        onMigrateFromBenchling={
          BENCHLING_FILE_MIGRATION_ENABLED ? openBenchlingMigration : undefined
        }
        mountedProjects={mountedProjects}
        failedProjectIndexRoots={failedProjectIndexRoots}
        onRetryProjectIndex={handleRetryProjectIndex}
        onOpenProject={handleOpenLibraryProject}
        onCreateProject={handleCreateEmptyWorkspace}
        onOpenProjectHome={handleOpenProjectHome}
        onRenameProject={(repoPath) => void handleRenameProject(repoPath)}
        onArchiveProject={(repoPath) => void handleArchiveProject(repoPath)}
        onTrashProject={(repoPath) => void handleTrashProject(repoPath)}
        onNewNotebook={handleNewPage}
        onNewAssembly={handleNewDesign}
        onCreateAssembly={handleCreateAssembly}
        onWorkspaceChanged={reconcileChangedWorkspace}
        onFindInFolder={handleFindInFolder}
        refreshSignal={fileTreeRefreshToken}
        selectedPath={selectedPath}
      />
    ),
    [
      filesPanelActive,
      sidebarChromeVisible,
      handleFileSelect,
      handleAddFolder,
      handleImportFile,
      handleCreateEntityFromUi,
      openEntityImport,
      openProjectImport,
      openBenchlingMigration,
      mountedProjects,
      failedProjectIndexRoots,
      handleRetryProjectIndex,
      handleOpenLibraryProject,
      handleCreateEmptyWorkspace,
      handleOpenProjectHome,
      handleRenameProject,
      handleArchiveProject,
      handleTrashProject,
      handleNewPage,
      handleNewDesign,
      handleCreateAssembly,
      reconcileChangedWorkspace,
      handleFindInFolder,
      fileTreeRefreshToken,
      selectedPath,
    ]
  );
  const explorerContent = useMemo(
    () => (
      <CanvasLayout
        onOpenAssistantSources={openAssistantSettings}
        onConfigureHost={configureAssistantHost}
      />
    ),
    [openAssistantSettings, configureAssistantHost]
  );

  if (shellError || !shellPrepared || !workspaceRestored) {
    return (
      <StartupSurface
        stage={!workspaceRestored ? 'workspace' : 'shell'}
        error={shellError ?? (!workspaceRestored ? (workspace.error ?? libraryLoadError) : null)}
      />
    );
  }

  if (AI_ONLY_INPUT) {
    return (
      <>
        <AiOnlyWorkbench onOpenChat={openAIChat} onNewChat={openNewAIChat}>
          {explorerContent}
        </AiOnlyWorkbench>
        <AgentConfirmController />
        <ToastContainer />
      </>
    );
  }

  return (
    <div
      className="flex flex-col h-screen"
      {...(isHostedBrowserRuntime()
        ? { 'data-testid': 'hosted-dnaforge-app', 'data-runtime': 'hosted-browser' }
        : {})}
    >
      {}
      <span
        hidden
        data-analytics-block
        className="ph-no-capture"
        data-workspace-session-runtime={isHostedBrowserRuntime() ? 'hosted-browser' : 'electron'}
        data-workspace-session-phase={electronWorkspaceSession.phase}
        data-workspace-session-workspace-id={electronWorkspaceSession.activeWorkspaceId ?? ''}
        data-workspace-session-revision-id={electronWorkspaceSession.snapshot?.revisionId ?? ''}
        data-workspace-session-active-file={electronWorkspaceSession.activeFilePath ?? ''}
        data-workspace-session-open-file-count={electronWorkspaceSession.openFiles.length}
      />
      {}
      {!isHostedBrowserRuntime() ? <DevConsoleCapture /> : null}
      <ScreenViewTelemetryObserver
        activeView={activeView}
        hasActiveWorkspace={folders.length > 0 || Boolean(workspacePath)}
        projectHomeVisible={projectHomeProject !== null}
        ready={shellPrepared}
      />

      {}
      {}
      <SetupBanner />

      {}
      <AppBar
        appVersion={__APP_VERSION__}
        extraControls={
          isHostedBrowserRuntime() ? (
            <HostedShareButton target={hostedShareTarget} onOpen={() => setHostedShareOpen(true)} />
          ) : null
        }
      />

      {}
      <div className="relative flex flex-1 overflow-hidden">
        {}
        <ActivityBar
          activeView={activeView}
          sidebarVisible={sidebarVisible}
          referenceLibraryActive={referencesViewActive}
          onViewChange={handleActivityViewChange}
          onToggleSidebar={toggleSidebar}
          onOpenReferenceGenome={openReferenceLibrary}
          onNewTerminalTab={
            isDesktopRuntime()
              ? () => dispatchCommand(COMMAND_IDS.terminalNew, { source: 'ui' })
              : undefined
          }
          toolboxBadge={toolboxBadge}
          jobsActiveCount={jobsProjection.activeCount}
          jobsAttentionCount={jobsProjection.attentionCount}
          limsAttentionCount={unconnectedRegistry.entityIds.length}
          devActions={
            ActivityBarDevButtons && DEV_SURFACES.devScenarios ? (
              <Suspense fallback={null}>
                <ActivityBarDevButtons
                  onToggleDevPanel={() => setIsDevPanelOpen((prev) => !prev)}
                  devPanelOpen={isDevPanelOpen}
                />
              </Suspense>
            ) : null
          }
          accountSlot={<AccountActivityButton />}
        />

        <WorkspaceSidebar
          visible={sidebarChromeVisible}
          width={sidebarWidth}
          onWidthCommit={commitSidebarWidth}
          filesPanelActive={filesPanelActive}
          testId={isHostedBrowserRuntime() ? 'hosted-workspace-sidebar' : undefined}
          tools={
            import.meta.env.DEV && activeView === 'toolbox' ? (
              <Toolbox />
            ) : activeView === 'lims' ? (
              <LimsPanel
                onHide={toggleSidebar}
                onCreateEntity={handleCreateEntityFromUi}
                onImportEntity={(request) => void openEntityImport(request)}
                onImportProject={() => void handleAddFolder()}
                onImportProjectWithAgent={() => void openProjectImport({ agentRequested: true })}
                onMigrateFromBenchling={
                  BENCHLING_FILE_MIGRATION_ENABLED ? openBenchlingMigration : undefined
                }
              />
            ) : activeView === 'search' ? (
              <SearchPanel onClose={() => handleViewChange('files')} />
            ) : activeView === 'jobs' ? (
              <JobsSidebar
                snapshot={jobsSnapshot}
                onStop={handleStopWorkflow}
                onImportResult={handleImportWorkflowResult}
                onOpenResult={handleOpenWorkflowResult}
                onReleaseResult={handleReleaseWorkflowResult}
                onLoadActions={handleLoadWorkflowActions}
                onImportRecordedRun={canImportRecordedRun ? handleImportRecordedRun : undefined}
                importingRecordedRun={importingRecordedRun}
                onReconnect={handleReconnectWorkflowOwners}
              />
            ) : activeView === 'source-control' ? (
              <SourceControlPanel />
            ) : (
              rendererFeatureSidebarView(activeView)
            )
          }
          files={fileBrowserContent}
        />

        <div className="flex-1 flex flex-col overflow-hidden">
          <RendererFeatureActivations openView={handleViewChange} />
          <WorkspaceMain
            occluded={workspaceOccludedByLimsOverlay || Boolean(projectHomeProject)}
            workspaceTakeoverActive={workspaceTakeoverActive}
            emptyFilesHomeActive={emptyFilesHomeActive}
            homeViewActive={homeViewActive}
            homeWorkbenchActive={homeWorkbenchActive}
            recentlyEditedReady={recentlyEditedReady}
            explorerInset={workspaceExplorerInsetRef.current}
            explorer={explorerContent}
            settings={
              settingsViewActive ? (
                <SettingsPanel
                  conversationId={activeConversationId}
                  onChangeWorkspace={handleAddFolder}
                  focusTarget={settingsFocusTarget}
                  onFocusTargetHandled={clearSettingsFocusTarget}
                  onOpenReleaseNotes={(sourceElement) =>
                    openReleaseNotes('settings', undefined, sourceElement)
                  }
                  migrationSettings={
                    BENCHLING_FILE_MIGRATION_ENABLED ? migrationSettings : undefined
                  }
                />
              ) : null
            }
            featureView={featureViewActive ? rendererFeatureView(activeView) : null}
            references={
              referencesViewActive ? (
                <ReferenceLibrary onClose={() => handleViewChange('files')} />
              ) : null
            }
            home={{
              onNavigateToExplorer: () => handleViewChange('files'),
              onOpenRecentlyEdited: handleOpenRecentlyEdited,
              onAskAI: openAIChatWithConversation,
              onViewReleaseNotes: (sourceElement) =>
                openReleaseNotes('home', undefined, sourceElement),
              onMigrateFromBenchling: BENCHLING_FILE_MIGRATION_ENABLED
                ? openBenchlingMigration
                : undefined,
              workspacePath,
              onOpenAssistantSources: openAssistantSettings,
              onConfigureHost: configureAssistantHost,
            }}
          />
          {isDesktopRuntime() ? (
            <TerminalDock
              defaultCwd={workspacePath ?? undefined}
              onRevealWorkspace={revealTerminalTab}
            />
          ) : null}
        </div>
      </div>

      {}
      {DevPanel && DEV_SURFACES.devScenarios ? (
        <Suspense fallback={null}>
          <DevPanel isOpen={isDevPanelOpen} onClose={() => setIsDevPanelOpen(false)} />
        </Suspense>
      ) : null}

      {isHostedBrowserRuntime() ? (
        <HostedWorkspaceChrome
          fileInputRef={hostedFileInputRef}
          historyOpen={hostedHistoryOpen}
          onHistoryToggle={() => setHostedHistoryOpen((open) => !open)}
          onImport={handleHostedImport}
          onSignOut={handleHostedSignOut}
          onHistoryClose={() => setHostedHistoryOpen(false)}
          onRestored={setHostedStatus}
          status={hostedStatus}
          browserReadOpen={hostedBrowserReadOpen}
          browserReadTarget={hostedBrowserReadTarget}
          versionId={electronWorkspaceSession.snapshot?.revisionId ?? null}
          onBrowserReadClose={() => setHostedBrowserReadOpen(false)}
          shareOpen={hostedShareOpen}
          shareTarget={hostedShareTarget}
          onShareClose={() => setHostedShareOpen(false)}
          onShareCreated={setHostedStatus}
        />
      ) : null}

      <>
        {}
        {goToFileOpen ? (
          <GoToFileDialog
            folders={folders}
            onClose={() => setGoToFileOpen(false)}
            onOpen={(path) => {
              void handleFileSelect(path, getTabTypeForFile(path));
            }}
          />
        ) : null}
        <ToastContainer />

        {benchlingMigrationOpen ? (
          <BenchlingMigrationWizard
            bridge={benchlingMigrationBridge}
            onClose={closeBenchlingMigration}
            onUnlocked={handleBenchlingMigrationUnlocked}
            onImportedObjectsChanged={handleBenchlingMigrationUnlocked}
            onOpenWorkspace={handleOpenBenchlingWorkspace}
            onViewMigrationDetails={viewBenchlingMigrationDetails}
            onRunChange={handleBenchlingMigrationRunChange}
            selectedRunId={benchlingMigrationSession.selectedRunId}
            startFresh={benchlingMigrationSession.mode === 'new'}
            initialView={benchlingMigrationSession.initialView}
          />
        ) : null}

        {}
        {genomeViewFileOpen !== null ? (
          <ReferenceGenomePicker
            key={genomeViewFileOpen}
            open
            backgroundFileOpen
            backgroundFileOpenRequestId={genomeViewFileOpen}
            onClose={() =>
              setGenomeViewFileOpen((current) => (current === genomeViewFileOpen ? null : current))
            }
          />
        ) : null}

        {}
        <OversizedDialogHost />

        {}
        <AgentConfirmController />

        {}
        <AskAiPickerHost />

        {}
        <AskAiInlineChatHost />

        {}
        <TranslationDialogHost />

        {}
        <ConfirmDialogHost />
        <WorkTaskDialogHost />

        {}

        {}
        {}
        <PredictStructureDialog />
        <ConnectComputeProviderDialog />

        {}
        <LargeFileImportDialogHost />

        {}
        <ImportWizardHost />

        <QuickLookImportHost onDestinationCommit={handleQuickLookDestinationCommit} />

        {}
        <TabularImportWizardHost />

        {}
        <EntityCreationHost
          onOpenRegistryEntity={(entityId, name) => {
            handleViewChange('lims');
            useLimsOverlayStore.getState().requestRegistryEntity(entityId, name);
          }}
        />

        {createDestinationRequest ? (
          <RegistryCreateDestinationDialog
            request={createDestinationRequest}
            folders={folders}
            onCancel={() => setCreateDestinationRequest(null)}
            onConfirm={(request) => {
              setCreateDestinationRequest(null);
              if (request.entityType === 'assemblies') {
                handleCreateAssembly(request);
              } else {
                void handleCreateEntityFromUi(request);
              }
            }}
          />
        ) : null}

        {}
        <TelemetryBlockedSurface className="contents">
          <AuthFlowHost />
        </TelemetryBlockedSurface>
      </>

      {projectHomeProject && (
        <ProjectHome
          project={projectHomeProject}
          onClose={() => setProjectHomePath(null)}
          onArchiveProject={(repoPath) => void handleArchiveProject(repoPath)}
          onOpenRegistry={handleOpenRegistryFromProjectHome}
          onOpenSwitcher={handleOpenProjectSwitcherFromHome}
          onRevealProject={(repoPath) => void handleRevealProject(repoPath)}
        />
      )}

      {projectLibraryPopover && (
        <ProjectSwitcherPopover
          x={projectLibraryPopover.x}
          y={projectLibraryPopover.y}
          openRepoPaths={mountedProjects.map((project) => project.repoPath)}
          onClose={() => setProjectLibraryPopover(null)}
          onOpenProject={handleOpenLibraryProject}
          onImportProject={() => void handleAddFolder()}
        />
      )}
    </div>
  );
}

export default App;
