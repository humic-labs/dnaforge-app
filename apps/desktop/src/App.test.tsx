import { userMessage } from '@waypoint/user-messages';
import { expectToastCall, expectNoToastCall } from './test/toast-assertions';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { DESKTOP_ANALYTICS_TOAST_MESSAGE } from '@waypoint/analytics-policy';
import { StrictMode } from 'react';
import type { PlatformBridge } from './platform/types';

type WorkspaceStore = typeof import('./stores/workspaceStore').useWorkspaceStore;
type WorkspaceState = ReturnType<WorkspaceStore['getState']>;

const appTestMocks = vi.hoisted(() => ({
  workspaceOwner: null as WorkspaceStore | null,
  readWorkspaceSelection: vi.fn().mockResolvedValue([]),
  readWorkspaceOwners: vi.fn().mockResolvedValue([]),
  writeWorkspaceSelection: vi.fn(),
  persistedWorkspacePath: null as string | null,
  addFolder: vi.fn(),
  getFolders: vi.fn(
    () => [] as Array<{ path: string; name: string; addedAt: number; pinned?: boolean }>
  ),
  openInFocusedPanel: vi.fn(),
  openWithSmartPlacement: vi.fn(),
  createPage: vi.fn(),
  createDesign: vi.fn(),
  createDraftDesign: vi.fn(() => 'new-assembly-draft'),
  createNotebookArtifactFile: vi.fn(),
  createDesignArtifactFile: vi.fn(),
  beginWorkspaceMutation: vi.fn(async () => 'app-test-workspace-mutation'),
  endWorkspaceMutation: vi.fn(async () => undefined),
  registerWorkspaceFile: vi.fn(),
  registerContextualCatalogEntity: vi.fn(),
  addRichToast: vi.fn(),
  addToast: vi.fn(),
  dismissToast: vi.fn(),
  latestFileBrowserProps: null as Record<string, any> | null,
  latestActivityBarProps: null as Record<string, any> | null,
  managedOperationsSnapshot: {
    status: 'detached',
    scopeId: null,
    ownerId: null,
    ownerInstanceId: null,
    records: [],
    historySummary: null,
    supportedActionsByKind: {},
    kindCatalogByKind: {},
    reconnectAvailable: false,
  } as Record<string, any>,
  selectedPath: null as string | null,
  revealPath: vi.fn(),
  bumpFileTreeRefresh: vi.fn(),
  reconcileWorkspaceOnMount: vi.fn().mockResolvedValue(undefined),
  reconcileWorkspaceAfterFilesChanged: vi.fn().mockResolvedValue(null),
  pages: {} as Record<string, { title: string; content: unknown }>,
  designs: {} as Record<string, { id: string; name: string }>,
  platformListeners: new Map<string, (...args: unknown[]) => void>(),
  notebook: {
    onMarkdownAdopted: vi.fn<NonNullable<PlatformBridge['notebook']['onMarkdownAdopted']>>(
      () => () => {}
    ),
    onMarkdownAdoptionFailed: vi.fn<
      NonNullable<PlatformBridge['notebook']['onMarkdownAdoptionFailed']>
    >(() => () => {}),
  },
  ensureWorkspaceOwner: vi.fn().mockResolvedValue(1),
  setWorkspaceState: vi.fn(),
  resetWorkspaceState: vi.fn(),
  canvasPanels: {} as Record<
    string,
    {
      tabs: Array<{ id: string; entityId?: string; label?: string; type?: string }>;
      activeTabId?: string | null;
    }
  >,
  canvasFocusedPanelId: null as string | null,
  homePanelMounts: 0,
  releaseManagedOperationResult: vi.fn(),
  getManagedOperation: vi.fn(),
  getManagedOperationActions: vi.fn(),
  openAnnotationOperationResult: vi.fn(),
  recordSelectedAnnotationReceipt: vi.fn(),
  refreshComputeJobs: vi.fn().mockResolvedValue(undefined),
  invalidateComputeJobsRuntime: vi.fn(),
  invalidateAgentJobsRuntime: vi.fn(),
  refreshAgentJobs: vi.fn().mockResolvedValue(undefined),
  cancelAgentJob: vi.fn().mockResolvedValue(undefined),
  computeJobsState: {
    jobs: [],
    loading: false,
    error: null,
    observedAtMs: null,
  } as Record<string, any>,
  agentJobsState: {
    jobs: [],
    jobCount: 0,
    activeCount: 0,
    terminalCount: 0,
    historyComplete: true,
    loading: false,
    error: null,
    observedAtMs: null,
  } as Record<string, any>,
}));

const mockAddFolder = appTestMocks.addFolder;
const mockGetFolders = appTestMocks.getFolders;
const mockOpenInFocusedPanel = appTestMocks.openInFocusedPanel;
const mockCreatePage = appTestMocks.createPage;
const mockCreateDesign = appTestMocks.createDesign;
const mockCreateNotebookArtifactFile = appTestMocks.createNotebookArtifactFile;
const mockCreateDesignArtifactFile = appTestMocks.createDesignArtifactFile;

vi.mock('./db', () => {
  const settings = { key: 'key' };
  return {
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn().mockResolvedValue(undefined),
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: () =>
            table === settings
              ? appTestMocks.readWorkspaceSelection()
              : appTestMocks.readWorkspaceOwners(),
        })),
      })),
      insert: vi.fn(() => ({
        values: ({ value }: { value: string }) => ({
          onConflictDoUpdate: async () => {
            appTestMocks.writeWorkspaceSelection(value);
            appTestMocks.persistedWorkspacePath = value;
          },
        }),
      })),
      delete: vi.fn().mockReturnValue({
        where: vi.fn(async () => {
          appTestMocks.persistedWorkspacePath = null;
        }),
      }),
    },
    settings,
    workspaces: { path: 'path', archivedAt: 'archivedAt', trashedAt: 'trashedAt' },
  };
});
vi.mock('./db/connection', async () => ({ db: (await import('./db')).db }));
vi.mock('./db/schema', async () => {
  const { settings, workspaces } = await import('./db');
  return { settings, workspaces };
});

vi.mock('./platform', () => ({
  platform: vi.fn(() => ({
    db: {
      execute: vi.fn(),
      select: vi.fn().mockResolvedValue([]),
      ensureWorkspaceOwner: appTestMocks.ensureWorkspaceOwner,
    },
    fs: {
      readTextFile: vi.fn(),
      readFile: vi.fn(),
      writeTextFile: vi.fn(),
      readDir: vi.fn(),
      mkdir: vi.fn(),
      stat: vi.fn(),
      exists: vi.fn(),
      rename: vi.fn(),
      beginWorkspaceMutation: appTestMocks.beginWorkspaceMutation,
      endWorkspaceMutation: appTestMocks.endWorkspaceMutation,
    },
    dialog: { open: vi.fn(), save: vi.fn() },
    path: { appDataDir: vi.fn().mockResolvedValue('/tmp/test') },
    runtime: {
      getProfile: vi.fn(() => ({
        kind: 'browser-mock',
        isElectron: false,
        isE2e: false,
        scenarioMutationAllowed: true,
        scenarioMutationReason: 'App unit-test browser runtime.',
      })),
    },
    notebook: appTestMocks.notebook,
    cloudSync: {
      onReplicaLifecycle: vi.fn(() => () => {}),
    },
    workspace: {
      onImportProgress: vi.fn(() => () => {}),
    },
    fileAssociations: {
      onOpenFiles: vi.fn(() => () => {}),
      takePendingActivations: vi.fn().mockResolvedValue([]),
    },
    shell: { revealItemInDir: vi.fn() },
    window: {
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn(),
      isMaximized: vi.fn(),
      setSize: vi.fn(),
      setPosition: vi.fn(),
      getSize: vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
      getPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
      setZoomLevel: vi.fn(),
    },
    on: vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
      appTestMocks.platformListeners.set(channel, callback);
      return () => appTestMocks.platformListeners.delete(channel);
    }),
    agentConfirm: {
      onRequest: vi.fn(() => () => {}),
      onCancel: vi.fn(() => () => {}),
      respond: vi.fn(),
    },
    largeFileImportDialog: {
      onRequest: vi.fn(() => () => {}),
      onCancel: vi.fn(() => () => {}),
      respond: vi.fn(),
    },
    keyring: {
      getPassword: vi.fn(),
      hasPassword: vi.fn().mockResolvedValue(false),
      setPassword: vi.fn(),
      deletePassword: vi.fn(),
    },
    convertFileSrc: vi.fn().mockResolvedValue(''),
  })),
  initPlatform: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./utils/environment', () => ({
  isBrowserOnly: vi.fn(() => true),
  isDesktopRuntime: vi.fn(() => false),
  isElectron: vi.fn(() => false),
  isHostedBrowserRuntime: vi.fn(() => false),
}));

vi.mock('./lib/applyZoomLevel', () => ({
  applyZoomLevel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./test/initializeTestSchema', () => ({
  initializeTestSchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./lib/analytics', async () => {
  const { resolveConsentPolicy } = await import('@waypoint/analytics-policy');
  const { getSetting: readSetting } = await import('./db');
  return {
    readAnalyticsConsentPolicy: vi.fn(async () =>
      resolveConsentPolicy({
        surface: 'desktop',
        regime: 'opt_out',
        storedConsent: await readSetting('analytics_consent'),
        storedVersion: await readSetting('analytics_consent_version'),
      })
    ),
    failClosedAnalyticsForSession: vi.fn().mockResolvedValue(undefined),
    hasTelemetryDestination: vi.fn().mockResolvedValue(true),
    optInAnalytics: vi.fn().mockResolvedValue(undefined),
    optOutAnalytics: vi.fn().mockResolvedValue(undefined),
    setAnalyticsConsent: vi.fn().mockResolvedValue(true),
    trackRendererEvent: vi.fn(() => true),
    trackToolOpened: vi.fn(),
    setAnalyticsScreenCategory: vi.fn(),
    isAnalyticsCaptureReady: vi.fn(() => true),
    subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@waypoint/workspace-editor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@waypoint/workspace-editor')>()),
  SequenceViewer: ({ sequence }: { sequence: { name: string } }) => (
    <div data-testid="sequence-viewer">Mock SequenceViewer: {sequence.name}</div>
  ),
}));

vi.mock('./hooks/useWorkspace', () => ({
  useWorkspace: vi.fn(),
}));

vi.mock('./hooks/useWindowState', () => ({
  useWindowState: vi.fn(),
}));

vi.mock('./shared/hooks/useKeyboard', () => ({
  useKeyboard: vi.fn(),
}));

vi.mock('./hooks/use-debug-snapshot', () => ({
  useDebugSnapshot: vi.fn(() => ({ capture: vi.fn() })),
}));

vi.mock('./features/ai/settings', () => ({
  useAISettingsStore: Object.assign(
    vi.fn(() => ({
      isConfigured: true,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      setApiKey: vi.fn(),
      setProvider: vi.fn(),
    })),
    {
      getState: vi.fn(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        isConfigured: true,
      })),
    }
  ),
}));

vi.mock('./stores/workspaceStore', () => {
  let expandedPaths = new Set<string>();
  const snapshot = () => ({
    folders: mockGetFolders(),
    selectedPath: appTestMocks.selectedPath,
    expandedPaths,
    revealRequestId: 0,
    activeWorkspaceFile: null,
    lastRemovedFolderPath: null,
    addFolder: mockAddFolder,
    clearWorkspace: vi.fn(),
    revealPath: appTestMocks.revealPath,
    fileTreeRefreshToken: 0,
    bumpFileTreeRefresh: appTestMocks.bumpFileTreeRefresh,
  });
  const listeners = new Set<
    (current: ReturnType<typeof snapshot>, previous: ReturnType<typeof snapshot>) => void
  >();
  appTestMocks.resetWorkspaceState.mockImplementation(() => {
    expandedPaths = new Set();
    listeners.clear();
  });
  appTestMocks.setWorkspaceState.mockImplementation(
    (patch: Partial<ReturnType<typeof snapshot>>) => {
      if (appTestMocks.workspaceOwner) {
        appTestMocks.workspaceOwner.setState(patch);
        return;
      }
      const previous = snapshot();
      if (patch.folders) mockGetFolders.mockReturnValue(patch.folders);
      if (patch.expandedPaths) expandedPaths = patch.expandedPaths;
      if (patch.selectedPath !== undefined) appTestMocks.selectedPath = patch.selectedPath;
      const current = snapshot();
      for (const listener of listeners) listener(current, previous);
    }
  );
  return {
    useWorkspaceStore: Object.assign(
      vi.fn((selector?: (state: WorkspaceState) => unknown) => {
        const owner = appTestMocks.workspaceOwner;
        if (owner) return selector ? owner(selector) : owner();
        return selector ? selector(snapshot() as WorkspaceState) : snapshot();
      }),
      {
        getState: vi.fn(() => appTestMocks.workspaceOwner?.getState() ?? snapshot()),
        setState: appTestMocks.setWorkspaceState,
        subscribe: (
          listener: (
            current: ReturnType<typeof snapshot>,
            previous: ReturnType<typeof snapshot>
          ) => void
        ) => {
          if (appTestMocks.workspaceOwner) {
            return appTestMocks.workspaceOwner.subscribe((current, previous) =>
              listener(
                current as ReturnType<typeof snapshot>,
                previous as ReturnType<typeof snapshot>
              )
            );
          }
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }
    ),
  };
});

vi.mock('./features/canvas', () => ({
  CanvasLayout: () => <div data-testid="canvas-layout">Mock Canvas</div>,
  useCanvasStore: Object.assign(
    vi.fn((selector?: (state: unknown) => unknown) => {
      const mockState = {
        openInFocusedPanel: appTestMocks.openInFocusedPanel,
        openWithSmartPlacement: appTestMocks.openWithSmartPlacement,
        panels: appTestMocks.canvasPanels,
        focusedPanelId: appTestMocks.canvasFocusedPanelId,
      };
      return selector ? selector(mockState) : mockState;
    }),
    {
      getState: vi.fn(() => ({
        openInFocusedPanel: appTestMocks.openInFocusedPanel,
        openWithSmartPlacement: appTestMocks.openWithSmartPlacement,
        panels: appTestMocks.canvasPanels,
        focusedPanelId: appTestMocks.canvasFocusedPanelId,
      })),
    }
  ),
}));

vi.mock('./features/page', () => ({
  usePageStore: Object.assign(
    vi.fn((selector?: (state: unknown) => unknown) => {
      const mockState = {
        createPage: appTestMocks.createPage,
        upsertPageFromArtifact: vi.fn().mockResolvedValue(undefined),
        initialize: vi.fn().mockResolvedValue(undefined),
        pages: appTestMocks.pages,
      };
      return selector ? selector(mockState) : mockState;
    }),
    {
      getState: vi.fn(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        pages: appTestMocks.pages,
      })),
    }
  ),
}));

vi.mock('./features/design', () => ({
  startDesignArtifactMirroring: vi.fn(),
  startMocloFactoryStageOutputSync: vi.fn(),
  useDesignStore: Object.assign(
    vi.fn((selector?: (state: unknown) => unknown) => {
      const mockState = {
        createDesign: appTestMocks.createDesign,
        createDraftDesign: appTestMocks.createDraftDesign,
        upsertDesignFromArtifact: vi.fn(),
      };
      return selector ? selector(mockState) : mockState;
    }),
    {
      getState: vi.fn(() => ({ designs: appTestMocks.designs })),
    }
  ),
}));

vi.mock('./db/workspace-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/workspace-catalog')>();
  return {
    ...actual,
    findWorkspaceRootForPath: actual.findWorkspaceRootForPath,
    getCatalogEntityForFilePath: vi.fn().mockResolvedValue(null),
    getCurrentCatalogFileForEntity: vi.fn().mockResolvedValue(null),
    registerContextualCatalogEntity: appTestMocks.registerContextualCatalogEntity,
    registerWorkspaceFile: appTestMocks.registerWorkspaceFile,
    repairDuplicateCurrentBindings: vi.fn().mockResolvedValue({ entities: 0, demoted: 0 }),
    resolveWorkspaceScope: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('./db/workspace-artifacts', () => ({
  artifactStemFromFileName: (fileName: string) =>
    fileName.replace(/\.wpnote\.json$/i, '').replace(/\.wpdesign\.json$/i, ''),
  createDesignArtifactFile: appTestMocks.createDesignArtifactFile,
  createNotebookArtifactFile: appTestMocks.createNotebookArtifactFile,
  resolveArtifactFile: vi.fn(),
  writeDesignArtifactSnapshot: vi.fn(),
}));

vi.mock('./services/workspace-reconcile', () => ({
  reconcileWorkspaceRoot: vi.fn().mockResolvedValue({
    scanned: 0,
    registered: 0,
    repaired: 0,
    missing: 0,
    externalMovesRelinked: 0,
    externalMovesAmbiguous: 0,
    primerArtifactsDiscovered: 0,
    primerArtifactsReconciled: 0,
    primerArtifactErrors: [],
    errors: [],
  }),
}));

vi.mock('./services/mounted-workspace-reconcile', () => ({
  reconcileMountedWorkspaceRoot: vi.fn().mockResolvedValue({
    result: {
      scanned: 0,
      registered: 0,
      repaired: 0,
      missing: 0,
      externalMovesRelinked: 0,
      externalMovesAmbiguous: 0,
      primerArtifactsDiscovered: 0,
      primerArtifactsReconciled: 0,
      primerArtifactErrors: [],
      errors: [],
    },
    entityResult: {
      scanned: 0,
      reconciled: 0,
      conflicts: 0,
      errors: [],
    },
  }),
}));

vi.mock('./services/workspace-operations', () => ({
  reconcileWorkspaceOnMount: appTestMocks.reconcileWorkspaceOnMount,
  reconcileWorkspaceAfterFilesChanged: appTestMocks.reconcileWorkspaceAfterFilesChanged,
  runWorkspaceReconcileOperation: vi.fn(),
  resolveReconcileWorkspaceRoot: (root: string | null | undefined, path: string | null) => {
    const folders = mockGetFolders();
    const resolved =
      root ?? folders.find((folder) => path?.startsWith(`${folder.path}/`))?.path ?? null;
    if (!resolved) appTestMocks.bumpFileTreeRefresh();
    return null;
  },
}));

vi.mock('./shared/components', () => ({
  DevConsoleCapture: () => null,
}));

vi.mock('./stores/toast-store', () => ({
  useToastStore: Object.assign(
    vi.fn(() => []),
    {
      getState: vi.fn(() => ({
        addRichToast: appTestMocks.addRichToast,
        addToast: appTestMocks.addToast,
        dismissToast: appTestMocks.dismissToast,
        clearToastGroup: vi.fn(),
      })),
    }
  ),
}));

vi.mock('./components/AppBar', () => ({
  AppBar: () => null,
}));

vi.mock('./components/HomePanel', async () => {
  const { useRef } = await import('react');
  return {
    HomePanel: () => {
      const mountId = useRef<number | null>(null);
      if (mountId.current == null) {
        appTestMocks.homePanelMounts += 1;
        mountId.current = appTestMocks.homePanelMounts;
      }
      return (
        <div data-testid="home-panel" data-home-panel-mount={String(mountId.current)}>
          Home
        </div>
      );
    },
  };
});

vi.mock('./components/FileBrowser', () => ({
  FileBrowser: (props: Record<string, any>) => {
    appTestMocks.latestFileBrowserProps = props;
    return <div data-testid="file-browser">Mock FileBrowser</div>;
  },
}));

vi.mock('./components/WorkspaceFolderPicker', () => ({
  WorkspaceFolderPicker: ({
    roots,
    onSelectFolder,
  }: {
    roots: Array<{ path: string; name: string }>;
    onSelectFolder: (path: string) => void;
  }) => (
    <div>
      {roots.map((root) => (
        <button key={root.path} onClick={() => onSelectFolder(root.path)}>
          {root.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./components/SourceControlPanel', () => ({
  SourceControlPanel: () => <div>Source Control</div>,
}));

vi.mock('./services/managed-operations', () => ({
  managedOperations: {
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => appTestMocks.managedOperationsSnapshot),
    attach: vi.fn(() => () => undefined),
    startAnnotation: vi.fn(),
    getOperation: appTestMocks.getManagedOperation,
    getActions: appTestMocks.getManagedOperationActions,
    getResult: vi.fn(),
    requestCancel: vi.fn(),
    releaseResult: appTestMocks.releaseManagedOperationResult,
    reconnect: vi.fn(),
  },
}));

vi.mock('./features/sequence/annotation-operation-review', () => ({
  canOpenAnnotationOperationResult: vi.fn(() => true),
  openAnnotationOperationResult: appTestMocks.openAnnotationOperationResult,
}));

vi.mock('./features/sequence/record-annotation-receipt', () => ({
  recordedReceiptDependencies: vi.fn(() => ({ source: 'app-test' })),
  recordSelectedAnnotationReceipt: appTestMocks.recordSelectedAnnotationReceipt,
}));

vi.mock('./features/compute/jobs-store', () => ({
  useComputeJobsStore: Object.assign(
    vi.fn((selector?: (state: unknown) => unknown) => {
      const state = {
        ...appTestMocks.computeJobsState,
        refresh: appTestMocks.refreshComputeJobs,
        invalidateRuntime: appTestMocks.invalidateComputeJobsRuntime,
      };
      return selector ? selector(state) : state;
    }),
    {
      getState: vi.fn(() => ({
        ...appTestMocks.computeJobsState,
        refresh: appTestMocks.refreshComputeJobs,
        invalidateRuntime: appTestMocks.invalidateComputeJobsRuntime,
      })),
    }
  ),
}));

vi.mock('./features/jobs/agent-jobs-store', () => ({
  useAgentJobsStore: Object.assign(
    vi.fn((selector?: (state: unknown) => unknown) => {
      const state = {
        ...appTestMocks.agentJobsState,
        refresh: appTestMocks.refreshAgentJobs,
        invalidateRuntime: appTestMocks.invalidateAgentJobsRuntime,
        cancel: appTestMocks.cancelAgentJob,
      };
      return selector ? selector(state) : state;
    }),
    {
      getState: vi.fn(() => ({
        ...appTestMocks.agentJobsState,
        refresh: appTestMocks.refreshAgentJobs,
        invalidateRuntime: appTestMocks.invalidateAgentJobsRuntime,
        cancel: appTestMocks.cancelAgentJob,
      })),
    }
  ),
}));

vi.mock('./components/ActivityBar', () => ({
  ActivityBar: (props: {
    activeView: string;
    sidebarVisible: boolean;
    onViewChange: (
      view: 'home' | 'files' | 'search' | 'jobs' | 'settings' | 'lims' | 'references'
    ) => void;
    onOpenReferenceGenome?: () => void;
    jobsActiveCount?: number;
    jobsAttentionCount?: number;
  }) => {
    appTestMocks.latestActivityBarProps = props;
    return (
      <div
        data-testid="activity-bar"
        data-active-view={props.activeView}
        data-sidebar-visible={String(props.sidebarVisible)}
      >
        <button type="button" data-testid="home-button" onClick={() => props.onViewChange('home')}>
          Home
        </button>
        <button
          type="button"
          data-testid="files-button"
          onClick={() => props.onViewChange('files')}
        >
          Files
        </button>
        <button
          type="button"
          data-testid="search-button"
          onClick={() => props.onViewChange('search')}
        >
          Search
        </button>
        <button type="button" data-testid="jobs-button" onClick={() => props.onViewChange('jobs')}>
          Jobs
        </button>
        <button
          type="button"
          data-testid="settings-button"
          onClick={() => props.onViewChange('settings')}
        >
          Settings
        </button>
        <button
          type="button"
          data-testid="reference-picker-open"
          onClick={props.onOpenReferenceGenome ?? (() => props.onViewChange('references'))}
        >
          References
        </button>
      </div>
    );
  },
  FULL_SCREEN_ACTIVITY_VIEWS: new Set(['settings', 'home', 'references']),
}));

vi.mock('./components/SettingsPanel', () => ({
  SettingsPanel: () => <div>Settings</div>,
}));

vi.mock('./components/SearchPanel', () => ({
  SearchPanel: () => <div data-testid="search-panel">Search</div>,
}));

vi.mock('./features/sequence/public/components/ReferenceGenomePicker', () => ({
  ReferenceLibrary: () => <div data-testid="reference-library">Reference library</div>,
}));

vi.mock('./components/ReleaseNotesModal', () => ({
  ReleaseNotesModal: () => (
    <button type="button" data-testid="ordinary-modal-control">
      Ordinary modal control
    </button>
  ),
}));

vi.mock('./components/ToastContainer', async () => {
  const { createPortal } = await import('react-dom');
  return {
    ToastContainer: () =>
      createPortal(
        <button type="button" data-testid="ordinary-portaled-control">
          Ordinary portaled control
        </button>,
        document.body
      ),
  };
});

vi.mock('./features/auth/AuthFlowHost', () => ({
  AuthFlowHost: () => <input data-testid="credential-input" type="password" />,
}));

import { getSetting, setSetting } from './db';
import App from './App';
import { __resetWorkspaceTelemetryForTests } from './features/workspace-loader/workspace-telemetry';
import { loadWorkspaceDeliveryReceipts } from './features/workspace-loader/workspace-delivery-receipts';
import { setAnalyticsConsent } from './lib/analytics';
import { CommandScopeProviderForTest } from './commands';
import { useWorkspace } from './hooks/useWorkspace';
import { useSequenceStore } from './features/sequence';
import { isBrowserOnly } from './utils/environment';

type MockRichToastInput = {
  message: string;
  dismissOn?: string;
  onDismiss?: () => void | Promise<void>;
  actions?: Array<{ label: string; onClick: () => void }>;
};

function renderApp() {
  return render(
    <CommandScopeProviderForTest>
      <App />
    </CommandScopeProviderForTest>
  );
}

async function workspaceOwnerFixture() {
  const { useWorkspaceStore } =
    await vi.importActual<typeof import('./stores/workspaceStore')>('./stores/workspaceStore');
  const { useWorkspace: useWorkspaceOwner } =
    await vi.importActual<typeof import('./hooks/useWorkspace')>('./hooks/useWorkspace');
  const electronSession = await import('./features/workspace-session/electron-session');
  const initializeSession = vi
    .spyOn(electronSession, 'initializeElectronWorkspaceSession')
    .mockResolvedValue(undefined);
  onTestFinished(() => initializeSession.mockRestore());
  await useWorkspaceStore.getState().clearWorkspaceSelection();
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  appTestMocks.workspaceOwner = useWorkspaceStore;
  vi.mocked(isBrowserOnly).mockReturnValue(false);
  vi.mocked(useWorkspace).mockImplementation(useWorkspaceOwner);
  const publishedRoots = vi.fn();
  onTestFinished(
    useWorkspaceStore.subscribe((state, previous) => {
      if (state.folders !== previous.folders) publishedRoots(state.folders);
    })
  );
  return { store: useWorkspaceStore, publishedRoots };
}

describe('App', () => {
  it('retires both Jobs mirrors on native runtime status and reuses the existing ready refresh path', async () => {
    const environment = await import('./utils/environment');
    vi.mocked(environment.isDesktopRuntime).mockReturnValue(true);
    window.history.replaceState({}, '', '/?e2e=true');
    const root = '/workspace/jobs-runtime-status';
    mockGetFolders.mockReturnValue([{ path: root, name: 'Jobs status', addedAt: 1 }]);
    vi.mocked(useWorkspace).mockReturnValue({
      path: root,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });
    const view = renderApp();
    let initialComputeRetirements = 0;
    let initialAgentRetirements = 0;
    try {
      await waitFor(() => expect(appTestMocks.platformListeners.has('sidecar:status')).toBe(true));
      appTestMocks.refreshComputeJobs.mockClear();
      appTestMocks.refreshAgentJobs.mockClear();
      initialComputeRetirements = appTestMocks.invalidateComputeJobsRuntime.mock.calls.length;
      initialAgentRetirements = appTestMocks.invalidateAgentJobsRuntime.mock.calls.length;
      const emitStatus = (status: 'starting' | 'ready') => {
        const listener = appTestMocks.platformListeners.get('sidecar:status');
        expect(listener).toBeTypeOf('function');
        if (!listener) throw new Error('No live sidecar status subscription');
        listener(status);
      };
      act(() => emitStatus('starting'));
      expect(appTestMocks.invalidateComputeJobsRuntime).toHaveBeenCalledTimes(
        initialComputeRetirements + 1
      );
      expect(appTestMocks.invalidateAgentJobsRuntime).toHaveBeenCalledTimes(
        initialAgentRetirements + 1
      );
      expect(appTestMocks.refreshComputeJobs).not.toHaveBeenCalled();
      act(() => emitStatus('ready'));
      expect(appTestMocks.invalidateComputeJobsRuntime).toHaveBeenCalledTimes(
        initialComputeRetirements + 2
      );
      expect(appTestMocks.invalidateAgentJobsRuntime).toHaveBeenCalledTimes(
        initialAgentRetirements + 2
      );
      expect(appTestMocks.refreshComputeJobs).toHaveBeenCalledWith({ limit: 200 });
      expect(appTestMocks.refreshAgentJobs).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      vi.mocked(environment.isDesktopRuntime).mockReturnValue(false);
    }
    expect(appTestMocks.invalidateComputeJobsRuntime).toHaveBeenCalledTimes(
      initialComputeRetirements + 3
    );
    expect(appTestMocks.invalidateAgentJobsRuntime).toHaveBeenCalledTimes(
      initialAgentRetirements + 3
    );
    expect(appTestMocks.platformListeners.has('sidecar:status')).toBe(false);
  });
  it('reconciles a restored root after startup cancels its first mount', async () => {
    const environment = await import('./utils/environment');
    vi.mocked(environment.isDesktopRuntime).mockReturnValue(true);
    window.history.replaceState({}, '', '/?e2e=true');
    const folders = [{ path: '/workspace/restored', name: 'Restored', addedAt: 1 }];
    mockGetFolders.mockReturnValue(folders);
    vi.mocked(useWorkspace).mockReturnValue({
      path: folders[0].path,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });
    appTestMocks.reconcileWorkspaceOnMount.mockImplementation(
      (_root: string, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(
        <StrictMode>
          <CommandScopeProviderForTest>
            <App />
          </CommandScopeProviderForTest>
        </StrictMode>
      );
      await waitFor(() => expect(appTestMocks.reconcileWorkspaceOnMount).toHaveBeenCalledTimes(2));
      const [[, first], [, second]] = appTestMocks.reconcileWorkspaceOnMount.mock.calls;
      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(false);
    } finally {
      view?.unmount();
      vi.mocked(environment.isDesktopRuntime).mockReturnValue(false);
      appTestMocks.reconcileWorkspaceOnMount.mockResolvedValue(undefined);
    }
  });

  it('retries only a failed mounted project and admits one recovery while pending', async () => {
    const environment = await import('./utils/environment');
    vi.mocked(environment.isDesktopRuntime).mockReturnValue(true);
    window.history.replaceState({}, '', '/?e2e=true');
    const root = '/workspace/index-retry';
    mockGetFolders.mockReturnValue([{ path: root, name: 'Retry', addedAt: 1 }]);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    appTestMocks.reconcileWorkspaceOnMount
      .mockRejectedValueOnce(new Error('controlled index failure'))
      .mockReturnValueOnce(pending);
    let view: ReturnType<typeof render> | undefined;
    try {
      view = renderApp();
      await waitFor(() =>
        expect(appTestMocks.latestFileBrowserProps?.failedProjectIndexRoots.has(root)).toBe(true)
      );
      expect(appTestMocks.reconcileWorkspaceOnMount).toHaveBeenCalledTimes(1);
      const retry = appTestMocks.latestFileBrowserProps!.onRetryProjectIndex as (
        path: string
      ) => void;
      act(() => retry('/not-mounted'));
      expect(appTestMocks.reconcileWorkspaceOnMount).toHaveBeenCalledTimes(1);
      act(() => {
        retry(root);
        retry(root);
      });
      await waitFor(() => expect(appTestMocks.reconcileWorkspaceOnMount).toHaveBeenCalledTimes(2));
      expect(appTestMocks.latestFileBrowserProps?.failedProjectIndexRoots.has(root)).toBe(false);
      await act(async () => {
        finish();
        await pending;
      });
    } finally {
      finish();
      view?.unmount();
      vi.mocked(environment.isDesktopRuntime).mockReturnValue(false);
      appTestMocks.reconcileWorkspaceOnMount.mockResolvedValue(undefined);
    }
  });

  it('installs the files-changed notification adapter and owns no reconcile command', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });
    renderApp();
    await waitFor(() => expect(mockAddFolder).toHaveBeenCalled());

    act(() =>
      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-files-changed', {
          detail: { path: '/elsewhere/not-mounted.gb' },
        })
      )
    );
    expect(appTestMocks.bumpFileTreeRefresh).toHaveBeenCalledOnce();
    act(() =>
      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-files-changed', {
          detail: { workspaceRoot: '/Users/test/my-workspace' },
        })
      )
    );
    expect(appTestMocks.reconcileWorkspaceAfterFilesChanged).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    appTestMocks.workspaceOwner = null;
    appTestMocks.readWorkspaceSelection.mockResolvedValue([]);
    appTestMocks.readWorkspaceOwners.mockResolvedValue([]);
    appTestMocks.persistedWorkspacePath = null;
    vi.mocked(isBrowserOnly).mockReturnValue(true);
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(setSetting).mockResolvedValue(undefined);
    window.history.replaceState({}, '', '/');
    __resetWorkspaceTelemetryForTests();
    appTestMocks.resetWorkspaceState();
    mockGetFolders.mockReturnValue([]);
    appTestMocks.selectedPath = null;
    appTestMocks.latestFileBrowserProps = null;
    appTestMocks.latestActivityBarProps = null;
    appTestMocks.managedOperationsSnapshot = {
      status: 'detached',
      scopeId: null,
      ownerId: null,
      ownerInstanceId: null,
      records: [],
      historySummary: null,
      supportedActionsByKind: {},
      kindCatalogByKind: {},
      reconnectAvailable: false,
    };
    appTestMocks.computeJobsState = {
      jobs: [],
      loading: false,
      error: null,
      observedAtMs: null,
    };
    appTestMocks.agentJobsState = {
      jobs: [],
      jobCount: 0,
      activeCount: 0,
      terminalCount: 0,
      historyComplete: true,
      loading: false,
      error: null,
      observedAtMs: null,
    };
    appTestMocks.pages = {};
    appTestMocks.designs = {};
    appTestMocks.canvasPanels = {};
    appTestMocks.canvasFocusedPanelId = null;
    appTestMocks.homePanelMounts = 0;
    appTestMocks.releaseManagedOperationResult.mockResolvedValue({
      disposition: 'released',
      reason: 'Retained result released; execution history remains.',
    });
    appTestMocks.getManagedOperationActions.mockResolvedValue({
      actions: [],
      total: 0,
      next_offset: null,
    });
    appTestMocks.openAnnotationOperationResult.mockResolvedValue(undefined);
    appTestMocks.recordSelectedAnnotationReceipt.mockResolvedValue({ status: 'canceled' });
    useSequenceStore.setState({ sequences: {}, savedSequences: {} });
    appTestMocks.platformListeners.clear();
    mockCreatePage.mockImplementation(async (title: string, requestedId?: string) => {
      const pageId = requestedId ?? 'test-page-id';
      appTestMocks.pages[pageId] = {
        title,
        content: { type: 'doc', content: [] },
      };
      return pageId;
    });
    mockCreateDesign.mockImplementation((name: string) => {
      appTestMocks.designs['test-design-id'] = { id: 'test-design-id', name };
      return 'test-design-id';
    });
    appTestMocks.registerWorkspaceFile.mockResolvedValue({ id: 'workspace-folder' });
    appTestMocks.registerContextualCatalogEntity.mockImplementation(
      async (input: { id: string }) => ({
        id: input.id,
      })
    );
    mockCreateNotebookArtifactFile.mockResolvedValue({
      path: '/Users/test/my-workspace/Notebook 1',
      name: 'Notebook 1',
    });
    mockCreateDesignArtifactFile.mockResolvedValue({
      path: '/Users/test/my-workspace/Assembly 1.wpdesign.json',
      name: 'Assembly 1.wpdesign.json',
    });
  });

  it('shows loading state initially', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: true,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();
    expect(screen.getByTestId('startup-surface')).toHaveAttribute(
      'data-startup-stage',
      'workspace'
    );
  });

  it('keeps Files available when no workspace is selected', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => {
      expect(screen.getByTestId('file-browser')).toBeInTheDocument();
    });
  });

  it('shows Home in the Files main pane when no tabs are open ', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(screen.getByTestId('home-panel')).toBeInTheDocument());
    expect(screen.queryByTestId('welcome-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('files-sidebar')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByTestId('canvas-layout')).toBeInTheDocument();
    expect(screen.getByTestId('file-browser')).toBeInTheDocument();
  });

  it('hides the Files Home overlay once a tab is open ', async () => {
    appTestMocks.canvasPanels = { main: { tabs: [{ id: 'open-tab' }] } };
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(screen.getByTestId('canvas-layout')).toBeInTheDocument());
    expect(screen.queryByTestId('home-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('welcome-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('files-sidebar')).toHaveAttribute('aria-hidden', 'false');
  });

  it('keeps Home full-screen and hides the file tree ', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(screen.getByTestId('home-button')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('home-button'));

    expect(screen.getByTestId('home-panel')).toBeInTheDocument();
    expect(screen.getByTestId('files-sidebar')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('canvas-layout')).toBeInTheDocument();
  });

  it('opens References as a permanent workspace tool without creating a tab', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(screen.getByTestId('reference-picker-open')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('reference-picker-open'));

    expect(appTestMocks.openWithSmartPlacement).not.toHaveBeenCalled();
    expect(screen.getByTestId('reference-library')).toBeInTheDocument();
    expect(screen.getByTestId('activity-bar')).toHaveAttribute('data-active-view', 'references');
    expect(screen.getByTestId('files-sidebar')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('canvas-layout')).toBeInTheDocument();
  });

  it('does not infer the permanent References tool from a legacy persisted tab', async () => {
    appTestMocks.canvasPanels = {
      main: {
        activeTabId: 'reference-library-tab',
        tabs: [{ id: 'reference-library-tab', type: 'reference-library' }],
      },
    };
    appTestMocks.canvasFocusedPanelId = 'main';
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(screen.getByTestId('activity-bar')).toBeInTheDocument());
    expect(screen.getByTestId('activity-bar')).not.toHaveAttribute(
      'data-active-view',
      'references'
    );
    expect(screen.queryByTestId('reference-library')).not.toBeInTheDocument();
  });

  it('keeps the same Home panel instance across Files ↔ Home switches ', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(screen.getByTestId('home-panel')).toBeInTheDocument());
    const first = screen.getByTestId('home-panel');
    expect(first).toHaveAttribute('data-home-panel-mount', '1');
    expect(appTestMocks.homePanelMounts).toBe(1);

    fireEvent.click(screen.getByTestId('home-button'));
    expect(screen.getByTestId('home-panel')).toBe(first);
    expect(screen.getByTestId('home-panel')).toHaveAttribute('data-home-panel-mount', '1');
    expect(appTestMocks.homePanelMounts).toBe(1);
    expect(screen.getByTestId('files-sidebar')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByTestId('files-button'));
    expect(screen.getByTestId('home-panel')).toBe(first);
    expect(appTestMocks.homePanelMounts).toBe(1);
    expect(screen.getByTestId('files-sidebar')).toHaveAttribute('aria-hidden', 'false');

    fireEvent.click(screen.getByTestId('home-button'));
    fireEvent.click(screen.getByTestId('files-button'));
    fireEvent.click(screen.getByTestId('home-button'));
    fireEvent.click(screen.getByTestId('files-button'));
    expect(screen.getByTestId('home-panel')).toBe(first);
    expect(screen.getByTestId('home-panel')).toHaveAttribute('data-home-panel-mount', '1');
    expect(appTestMocks.homePanelMounts).toBe(1);
  });

  it('may unmount Home on Search/Settings and still remount it ', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();
    await waitFor(() => expect(screen.getByTestId('home-panel')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('search-button'));
    expect(screen.queryByTestId('home-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('home-button'));
    expect(screen.getByTestId('home-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('settings-button'));
    expect(screen.queryByTestId('home-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('home-button'));
    expect(screen.getByTestId('home-panel')).toBeInTheDocument();
  });

  it('opens Jobs in the existing left sidebar while preserving the document layout', async () => {
    const operation = {
      kind: 'annotation',
      kind_contract_version: 1,
      subject: { scope_id: 'scope-a', subject_id: 'document-a', input_revision: 'revision-a' },
      actor_kind: 'human',
      actor_id: 'peter@example.test',
      channel: 'desktop_ui',
      owner_instance_id: 'owner-a',
      created_at: 1,
      updated_at: 2,
      cancellation_mode: 'cooperative',
      result_status: 'none',
      version: 1,
    };
    appTestMocks.managedOperationsSnapshot = {
      status: 'connected',
      scopeId: 'scope-a',
      ownerId: 'local-human',
      ownerInstanceId: 'owner-a',
      historySummary: null,
      supportedActionsByKind: {
        annotation: ['list', 'get', 'result', 'request_cancel', 'release_result'],
      },
      kindCatalogByKind: {
        annotation: {
          kind: 'annotation',
          registration: 'executable',
          title: 'Annotation',
          contract_version: 1,
          result_schema_version: 1,
          executable: true,
          actions: ['list', 'get', 'result', 'request_cancel', 'release_result'],
          start_capabilities: ['operations.start'],
          recorded_import_capabilities: ['operations.import'],
          surfaces: {},
          input_schema: {},
          result_schema: {},
        },
      },
      reconnectAvailable: false,
      records: [
        {
          snapshot: {
            ...operation,
            id: 'running-operation',
            state: 'running',
            cancellation_availability: 'available',
          },
          observation: { freshness: 'current', observedAtMs: 2_000 },
        },
        {
          snapshot: {
            ...operation,
            id: 'failed-operation',
            state: 'failed',
            cancellation_availability: 'already_settled',
            error: { code: 'annotation_failed', message: 'Reference data is unavailable' },
          },
          observation: { freshness: 'current', observedAtMs: 2_000 },
        },
      ],
    };
    appTestMocks.canvasPanels = {
      main: { tabs: [{ id: 'open-tab', entityId: 'document-a', label: 'pUC19.gb' }] },
    };
    appTestMocks.computeJobsState = {
      jobs: [
        {
          id: 'compute-local-1',
          provider: 'tamarind',
          toolId: 'esmfold',
          label: 'Hosted folding proof',
          settingsHash: 'settings-hash',
          settings: {},
          remoteId: 'provider-job-1',
          state: 'submitted',
          providerState: 'QUEUED',
          costEstimate: null,
          costEstimateUnit: null,
          costActual: null,
          costActualUnit: null,
          workspaceRoot: '/Users/test/my-workspace',
          importedPaths: [],
          lastError: null,
          pollCount: 0,
          nextPollAt: null,
          createdAt: new Date(1_000).toISOString(),
          updatedAt: new Date(2_000).toISOString(),
        },
      ],
      loading: false,
      error: null,
      observedAtMs: 2_000,
      collectionStale: false,
      coverage: {
        jobCount: 1,
        activeCount: 1,
        terminalCount: 0,
        activeComplete: true,
        historyComplete: true,
        historyLimit: 200,
      },
    };
    appTestMocks.agentJobsState = {
      jobs: [
        {
          id: 'agent-action-1',
          tool_name: 'analysis.long',
          duration: 'long-running',
          pool: 'cpu_slow',
          state: 'running',
          cancelable: true,
          can_cancel: true,
          requested_at: new Date(1_500).toISOString(),
          completed_at: null,
          error_code: null,
          agent_identity: { id: 'agent-1', label: 'Research CLI', kind: 'cli' },
        },
      ],
      jobCount: 1,
      activeCount: 1,
      terminalCount: 0,
      historyComplete: true,
      loading: false,
      error: null,
      observedAtMs: 2_000,
    };
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();
    await waitFor(() => expect(screen.getByTestId('canvas-layout')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('jobs-button'));

    expect(screen.getByTestId('files-sidebar')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByTestId('jobs-sidebar')).toBeInTheDocument();
    expect(screen.getAllByText('pUC19.gb')).toHaveLength(2);
    expect(screen.queryByText('document-a')).not.toBeInTheDocument();
    expect(appTestMocks.latestActivityBarProps).toMatchObject({
      jobsActiveCount: 3,
      jobsAttentionCount: 1,
    });
    expect(appTestMocks.latestFileBrowserProps?.active).toBe(false);
    expect(screen.getByTestId('canvas-layout')).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByTestId('job-row-running-operation')).getByRole('button', {
        name: /^Show details for Annotate sequence\b/,
      })
    );
    await waitFor(() =>
      expect(appTestMocks.getManagedOperationActions).toHaveBeenCalledWith('running-operation')
    );
    expect(screen.getByText('No retained actions.')).toBeInTheDocument();

    const computeRow = screen.getByTestId('job-row-compute:compute-local-1');
    expect(within(computeRow).getByText('Hosted folding proof')).toBeInTheDocument();
    fireEvent.click(
      within(computeRow).getByRole('button', { name: /^Show details for Hosted folding proof\b/ })
    );
    expect(within(computeRow).getByText('Connected execution')).toBeInTheDocument();
    expect(within(computeRow).queryByRole('button', { name: 'Stop', exact: true })).toBeNull();
    expect(appTestMocks.getManagedOperationActions).toHaveBeenCalledTimes(1);

    const agentRow = screen.getByTestId('job-row-agent-action:agent-action-1');
    expect(within(agentRow).getByText('analysis.long')).toBeInTheDocument();
    fireEvent.click(within(agentRow).getByRole('button', { name: 'Stop', exact: true }));
    await waitFor(() => expect(appTestMocks.cancelAgentJob).toHaveBeenCalledWith('agent-action-1'));
  });

  it('offers manual receipt recording only when the connected owner supports it', async () => {
    appTestMocks.managedOperationsSnapshot = {
      status: 'connected',
      scopeId: 'scope-a',
      ownerId: 'local-human',
      ownerInstanceId: 'owner-a',
      records: [],
      historySummary: {
        operationCount: 0,
        activeCount: 0,
        terminalCount: 0,
        historyComplete: true,
      },
      supportedActionsByKind: { annotation: ['import_recorded'] },
      kindCatalogByKind: {},
      reconnectAvailable: false,
    };
    let finishRecording!: (result: { status: 'recorded'; operationId: string }) => void;
    appTestMocks.recordSelectedAnnotationReceipt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRecording = resolve;
        })
    );
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();
    await waitFor(() => expect(screen.getByTestId('canvas-layout')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('jobs-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Record completed run…' }));

    expect(screen.getByRole('button', { name: 'Recording completed run…' })).toBeDisabled();
    expect(appTestMocks.recordSelectedAnnotationReceipt).toHaveBeenCalledOnce();

    await act(async () => finishRecording({ status: 'recorded', operationId: 'recorded-1' }));
    await waitFor(() =>
      expectToastCall(appTestMocks.addToast, 'Completed run recorded in Jobs.', 'success')
    );
  });

  it('derives applied review truth from a loaded saved sequence and confirms result release', async () => {
    const operation = {
      kind: 'annotation',
      kind_contract_version: 1,
      subject: { scope_id: 'scope-a', subject_id: 'document-a', input_revision: 'revision-a' },
      actor_kind: 'human',
      actor_id: 'peter@example.test',
      channel: 'desktop_ui',
      owner_instance_id: 'owner-a',
      state: 'succeeded',
      created_at: 1,
      updated_at: 2,
      settled_at: 2,
      cancellation_mode: 'cooperative',
      cancellation_availability: 'already_settled',
      result_status: 'available',
      version: 2,
    };
    appTestMocks.managedOperationsSnapshot = {
      status: 'connected',
      scopeId: 'scope-a',
      ownerId: 'local-human',
      ownerInstanceId: 'owner-a',
      historySummary: {
        operationCount: 2,
        activeCount: 0,
        terminalCount: 2,
        historyComplete: true,
      },
      supportedActionsByKind: { annotation: ['release_result'] },
      kindCatalogByKind: {
        annotation: {
          kind: 'annotation',
          registration: 'executable',
          title: 'Annotation',
          contract_version: 1,
          result_schema_version: 1,
          executable: true,
          actions: ['list', 'get', 'result', 'release_result'],
          start_capabilities: ['operations.start'],
          recorded_import_capabilities: ['operations.import'],
          surfaces: {},
          input_schema: {},
          result_schema: {},
        },
      },
      records: [
        {
          snapshot: { ...operation, id: 'applied-operation' },
          observation: { freshness: 'current', observedAtMs: 2_000 },
        },
        {
          snapshot: {
            ...operation,
            id: 'historical-operation',
            subject: {
              scope_id: 'scope-a',
              subject_id: 'document-b',
              input_revision: 'revision-b',
            },
          },
          observation: { freshness: 'current', observedAtMs: 2_000 },
        },
      ],
    };
    useSequenceStore.setState({
      savedSequences: {
        'document-a': {
          id: 'document-a',
          name: 'pUC19',
          sequence: 'ATGC',
          length: 4,
          circular: true,
          annotations: [
            {
              name: 'Applied feature',
              type: 'misc_feature',
              start: 1,
              end: 2,
              direction: 1,
              color: '#000000',
              qualifiers: { dnaforge_operation_id: ['applied-operation'] },
            },
          ],
        },
      },
    });
    vi.mocked(useWorkspace).mockReturnValue({
      path: '/Users/test/my-workspace',
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();
    await waitFor(() => expect(screen.getByTestId('canvas-layout')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('jobs-button'));

    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
    const appliedRow = screen.getByTestId('job-row-applied-operation');
    fireEvent.click(
      within(appliedRow).getByRole('button', { name: /^Show details for Annotate sequence\b/ })
    );
    expect(within(appliedRow).getByText('Applied')).toBeInTheDocument();
    const historicalRow = screen.getByTestId('job-row-historical-operation');
    fireEvent.click(
      within(historicalRow).getByRole('button', {
        name: /^Show details for Annotate sequence\b/,
      })
    );
    expect(within(historicalRow).getByText('Not checked')).toBeInTheDocument();

    const historicalSnapshot = appTestMocks.managedOperationsSnapshot.records[1].snapshot;
    appTestMocks.getManagedOperation.mockResolvedValue(historicalSnapshot);
    fireEvent.click(within(historicalRow).getByRole('button', { name: 'Open result' }));
    await waitFor(() =>
      expect(appTestMocks.openAnnotationOperationResult).toHaveBeenCalledWith(historicalSnapshot)
    );
    expect(appTestMocks.getManagedOperation).toHaveBeenCalledWith('historical-operation');

    fireEvent.click(within(historicalRow).getByRole('button', { name: 'Release result' }));
    expect(appTestMocks.releaseManagedOperationResult).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog', { name: 'Release retained result?' });
    expect(
      within(dialog).getByText(/execution history.*annotations already applied/)
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release result' }));
    await waitFor(() =>
      expect(appTestMocks.releaseManagedOperationResult).toHaveBeenCalledWith(
        'historical-operation'
      )
    );
  });

  it('keeps the usable shell mounted during later workspace loading and errors', async () => {
    const workspace = {
      path: null,
      loading: false,
      error: null as string | null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    };
    vi.mocked(useWorkspace).mockReturnValue(workspace);
    const view = renderApp();
    await waitFor(() => expect(screen.getByTestId('file-browser')).toBeInTheDocument());
    for (const next of [
      { loading: true, error: null },
      { loading: false, error: 'Later workspace failure' },
    ]) {
      vi.mocked(useWorkspace).mockReturnValue({ ...workspace, ...next });
      view.rerender(
        <CommandScopeProviderForTest>
          <App />
        </CommandScopeProviderForTest>
      );
      expect(screen.queryByTestId('startup-surface')).not.toBeInTheDocument();
      expect(screen.getByTestId('file-browser')).toBeInTheDocument();
    }
  });

  it('keeps ordinary workspace, sidebar, modal, and portaled controls observable', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(screen.getByTestId('workspace-main')).toBeInTheDocument());
    const blockedSelector =
      '.ph-no-capture,[data-ph-no-capture],[data-analytics-block],[data-analytics-blocked]';
    for (const testId of [
      'workspace-main',
      'files-sidebar',
      'ordinary-modal-control',
      'ordinary-portaled-control',
    ]) {
      const root = screen.getByTestId(testId);
      expect(root.closest(blockedSelector)).toBeNull();
    }

    const credentialInput = screen.getByTestId('credential-input');
    const credentialBoundary = credentialInput.closest(blockedSelector);
    expect(credentialBoundary).not.toBeNull();
    expect(credentialBoundary).toHaveClass('ph-no-capture');
    expect(credentialBoundary).toHaveAttribute('data-ph-no-capture');
    expect(credentialBoundary).toHaveAttribute('data-analytics-block', 'true');
  });

  it('defaults analytics on and acknowledges the surface-dismissible disclosure only on dismiss', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => {
      expect(setAnalyticsConsent).toHaveBeenCalledWith(true, {
        resumeExistingEpisode: false,
      });
      expectToastCall(
        appTestMocks.addRichToast,
        expect.objectContaining({
          message: DESKTOP_ANALYTICS_TOAST_MESSAGE,
          dismissOn: 'surface',
          duration: 0,
        })
      );
    });

    const privacyToast = appTestMocks.addRichToast.mock.calls.find(
      ([toast]) => (toast as MockRichToastInput).message === DESKTOP_ANALYTICS_TOAST_MESSAGE
    )?.[0] as MockRichToastInput | undefined;
    expect(privacyToast?.message).toMatch(/turn this off in Settings/i);
    expect(privacyToast?.actions?.map((action) => action.label)).toEqual(['Privacy details']);
    expect(setSetting).not.toHaveBeenCalledWith('analytics_banner_seen', 'true');

    await privacyToast?.onDismiss?.();
    expect(setSetting).toHaveBeenCalledWith('analytics_banner_seen', 'true');
  });

  it('starts analytics on a fresh desktop profile without waiting for a toast action', async () => {
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() =>
      expect(setAnalyticsConsent).toHaveBeenCalledWith(true, {
        resumeExistingEpisode: false,
      })
    );
  });

  it('restores analytics only when the stored consent and disclosure version are current', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === 'analytics_consent') return 'true';
      if (key === 'analytics_consent_version') return '3';
      if (key === 'analytics_banner_seen') return 'true';
      if (key === 'privacy_policy_update_seen') return '2026-10-31';
      return null;
    });
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() =>
      expect(setAnalyticsConsent).toHaveBeenCalledWith(true, {
        resumeExistingEpisode: true,
      })
    );
    expect(appTestMocks.addRichToast).not.toHaveBeenCalled();
  });

  it('never re-shows the privacy toast after it was closed, even across a consent version bump', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === 'analytics_consent') return 'true';
      if (key === 'analytics_consent_version') return '2';
      if (key === 'analytics_banner_seen') return 'true';
      return null;
    });
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(setAnalyticsConsent).toHaveBeenCalled());
    const privacyToasts = appTestMocks.addRichToast.mock.calls.filter(
      ([toast]: [{ message?: string }]) => toast?.message === DESKTOP_ANALYTICS_TOAST_MESSAGE
    );
    expect(privacyToasts).toHaveLength(0);
    expect(setSetting).not.toHaveBeenCalledWith('analytics_banner_seen', 'false');
  });

  it('re-shows the privacy toast when current consent has no durable acknowledgement', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === 'analytics_consent') return 'true';
      if (key === 'analytics_consent_version') return '3';
      if (key === 'analytics_banner_seen') return 'false';
      return null;
    });
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(appTestMocks.addRichToast).toHaveBeenCalled());
    expect(setAnalyticsConsent).toHaveBeenCalledWith(true, {
      resumeExistingEpisode: true,
    });
    expectToastCall(
      appTestMocks.addRichToast,
      expect.objectContaining({ dismissOn: 'surface', onDismiss: expect.any(Function) })
    );
  });

  it('re-discloses and restamps prior true/v2 consent while keeping capture on', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === 'analytics_consent') return 'true';
      if (key === 'analytics_consent_version') return '2';
      return null;
    });
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => expect(appTestMocks.addRichToast).toHaveBeenCalled());
    expect(setAnalyticsConsent).toHaveBeenCalledWith(true, {
      resumeExistingEpisode: false,
    });
    expect(setSetting).not.toHaveBeenCalledWith('analytics_banner_seen', 'false');
    expect(setSetting).not.toHaveBeenCalledWith('analytics_banner_seen', 'true');
  });

  it('does not init or opt into analytics when the user has explicitly opted out', async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === 'analytics_consent' ? 'false' : null
    );
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => {
      expect(getSetting).toHaveBeenCalledWith('analytics_consent');
    });
    await waitFor(() => expect(setAnalyticsConsent).toHaveBeenCalledWith(false));
    expect(appTestMocks.addRichToast).not.toHaveBeenCalled();
  });

  it('marks the first-launch privacy toast seen without rendering it in E2E mode', async () => {
    window.history.replaceState({}, '', '/?e2e=true');
    vi.mocked(useWorkspace).mockReturnValue({
      path: null,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith('analytics_banner_seen', 'true');
    });

    const privacyToast = appTestMocks.addRichToast.mock.calls.find(([toast]) =>
      String((toast as MockRichToastInput).message).includes('PostHog interaction analytics')
    );
    expect(privacyToast).toBeUndefined();
    expect(setAnalyticsConsent).toHaveBeenCalledWith(false);
  });

  it('mounts and persists the workspace selected through its owner', async () => {
    const testPath = '/Users/test/my-workspace';
    const { store } = await workspaceOwnerFixture();
    renderApp();
    await waitFor(() => expect(store.getState().workspaceSelection.phase).toBe('ready'));

    await act(async () => store.getState().activateWorkspace(testPath));

    expect(store.getState().folders.map((folder) => folder.path)).toEqual([testPath]);
    expect(store.getState().workspaceSelection.path).toBe(testPath);
    expect(appTestMocks.persistedWorkspacePath).toBe(testPath);
    expect(appTestMocks.ensureWorkspaceOwner).toHaveBeenCalledWith(testPath, undefined, {
      recordOpen: true,
    });
  });

  it('does not resurrect a replaced root while its compatibility pointer is unchanged', async () => {
    const oldPath = '/Users/test/replaced-project';
    const newPath = '/Users/test/replacement-project';
    const { store } = await workspaceOwnerFixture();
    await store.getState().activateWorkspace(oldPath);
    renderApp();

    act(() => {
      store.getState().commitMountedFolders({
        folders: [{ path: newPath, name: 'New project', addedAt: 2 }],
        expandedPaths: new Set([newPath]),
        activeWorkspaceFile: null,
      });
    });
    expect(store.getState().workspaceSelection.path).toBe(oldPath);
    expect(store.getState().folders.map((folder) => folder.path)).toEqual([newPath]);

    await act(async () => store.getState().acceptMountedWorkspaceSelection());
    expect(store.getState().workspaceSelection.path).toBe(newPath);
    expect(appTestMocks.persistedWorkspacePath).toBe(newPath);

    await act(async () => store.getState().activateWorkspace('/Users/test/new-selection'));
    expect(store.getState().folders.map((folder) => folder.path)).toEqual([
      newPath,
      '/Users/test/new-selection',
    ]);
    expect(appTestMocks.persistedWorkspacePath).toBe('/Users/test/new-selection');
  });

  it('does not add duplicate folders to workspaceStore', async () => {
    const testPath = '/Users/test/my-workspace';
    const { store } = await workspaceOwnerFixture();
    await store.getState().activateWorkspace(testPath);
    renderApp();

    await act(async () => store.getState().activateWorkspace(testPath));

    expect(store.getState().folders.map((folder) => folder.path)).toEqual([testPath]);
    expect(store.getState().workspaceSelection.path).toBe(testPath);
    expect(appTestMocks.persistedWorkspacePath).toBe(testPath);
  });

  it('restores the persisted current workspace even when another project mounted first', async () => {
    const persistedCurrentPath = '/Users/test/persisted-current-workspace';
    const mountedDefaultPath = '/Users/test/default-workspace';
    const { store } = await workspaceOwnerFixture();
    appTestMocks.persistedWorkspacePath = persistedCurrentPath;
    appTestMocks.readWorkspaceSelection.mockResolvedValue([{ value: persistedCurrentPath }]);
    appTestMocks.readWorkspaceOwners.mockResolvedValue([{ path: persistedCurrentPath }]);
    store.getState().addFolder(mountedDefaultPath, 'My Workspace');

    renderApp();

    await waitFor(() =>
      expect(store.getState().workspaceSelection).toEqual({
        phase: 'ready',
        path: persistedCurrentPath,
        error: null,
      })
    );
    expect(store.getState().folders.map((folder) => folder.path)).toEqual([
      mountedDefaultPath,
      persistedCurrentPath,
    ]);
    expect(appTestMocks.persistedWorkspacePath).toBe(persistedCurrentPath);
  });

  it('applies each main-process workspace delivery exactly once across transport retries', async () => {
    const originalPath = '/Users/test/original-workspace';
    const replacementPath = '/Users/test/scenario-workspace';
    const { store, publishedRoots } = await workspaceOwnerFixture();
    await store.getState().activateWorkspace(originalPath);
    renderApp();
    await waitFor(() =>
      expect(appTestMocks.platformListeners.has('workspace:set-path')).toBe(true)
    );
    const deliver = appTestMocks.platformListeners.get('workspace:set-path');
    appTestMocks.ensureWorkspaceOwner.mockClear();
    appTestMocks.writeWorkspaceSelection.mockClear();
    publishedRoots.mockClear();

    act(() => deliver?.(originalPath, 'delivery-a'));
    await waitFor(() =>
      expect(loadWorkspaceDeliveryReceipts(sessionStorage)).toContain('delivery-a')
    );
    expect(publishedRoots).toHaveBeenCalledWith([expect.objectContaining({ path: originalPath })]);
    expect(appTestMocks.ensureWorkspaceOwner).toHaveBeenCalledExactlyOnceWith(
      originalPath,
      undefined,
      {
        name: 'original-workspace',
        recordOpen: true,
      }
    );
    expect(appTestMocks.ensureWorkspaceOwner.mock.invocationCallOrder[0]).toBeLessThan(
      publishedRoots.mock.invocationCallOrder[0]
    );
    expect(appTestMocks.writeWorkspaceSelection).toHaveBeenCalledExactlyOnceWith(originalPath);
    expect(appTestMocks.persistedWorkspacePath).toBe(originalPath);

    appTestMocks.ensureWorkspaceOwner.mockClear();
    appTestMocks.writeWorkspaceSelection.mockClear();
    publishedRoots.mockClear();
    act(() => deliver?.(originalPath, 'delivery-a'));
    expect(appTestMocks.ensureWorkspaceOwner).not.toHaveBeenCalled();
    expect(publishedRoots).not.toHaveBeenCalled();
    expect(appTestMocks.writeWorkspaceSelection).not.toHaveBeenCalled();

    act(() => deliver?.(replacementPath, 'delivery-b'));
    await waitFor(() =>
      expect(loadWorkspaceDeliveryReceipts(sessionStorage)).toContain('delivery-b')
    );
    expect(publishedRoots).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ path: replacementPath })])
    );
    expect(store.getState().workspaceSelection.path).toBe(replacementPath);
    expect(appTestMocks.writeWorkspaceSelection).toHaveBeenCalledExactlyOnceWith(replacementPath);
    expect(appTestMocks.persistedWorkspacePath).toBe(replacementPath);
  });

  it('does not replay an acknowledged workspace delivery after the renderer reloads', async () => {
    const originalPath = '/Users/test/original-workspace';
    const replacementPath = '/Users/test/scenario-workspace';
    const { store, publishedRoots } = await workspaceOwnerFixture();
    await store.getState().activateWorkspace(replacementPath);
    const firstRenderer = renderApp();
    await waitFor(() =>
      expect(appTestMocks.platformListeners.has('workspace:set-path')).toBe(true)
    );
    act(() =>
      appTestMocks.platformListeners.get('workspace:set-path')?.(originalPath, 'delivery-a')
    );
    await waitFor(() =>
      expect(loadWorkspaceDeliveryReceipts(sessionStorage)).toContain('delivery-a')
    );
    expect(store.getState().workspaceSelection.path).toBe(originalPath);
    expect(appTestMocks.persistedWorkspacePath).toBe(originalPath);

    firstRenderer.unmount();
    store.setState(store.getInitialState(), true);
    appTestMocks.readWorkspaceSelection.mockResolvedValue([{ value: originalPath }]);
    appTestMocks.readWorkspaceOwners.mockResolvedValue([{ path: originalPath }]);
    renderApp();
    await waitFor(() =>
      expect(store.getState().workspaceSelection).toEqual({
        phase: 'ready',
        path: originalPath,
        error: null,
      })
    );
    await waitFor(() =>
      expect(appTestMocks.platformListeners.has('workspace:set-path')).toBe(true)
    );
    appTestMocks.ensureWorkspaceOwner.mockClear();
    appTestMocks.writeWorkspaceSelection.mockClear();
    publishedRoots.mockClear();
    act(() =>
      appTestMocks.platformListeners.get('workspace:set-path')?.(originalPath, 'delivery-a')
    );

    expect(appTestMocks.ensureWorkspaceOwner).not.toHaveBeenCalled();
    expect(publishedRoots).not.toHaveBeenCalled();
    expect(appTestMocks.writeWorkspaceSelection).not.toHaveBeenCalled();
    expect(store.getState().workspaceSelection.path).toBe(originalPath);
    expect(appTestMocks.persistedWorkspacePath).toBe(originalPath);
  });

  it('retries a main-process workspace delivery when registration fails before publication', async () => {
    const workspacePath = '/Users/test/retry-workspace';
    const { store, publishedRoots } = await workspaceOwnerFixture();
    appTestMocks.ensureWorkspaceOwner.mockRejectedValueOnce(new Error('database unavailable'));
    renderApp();
    await waitFor(() => expect(store.getState().workspaceSelection.phase).toBe('ready'));
    await waitFor(() =>
      expect(appTestMocks.platformListeners.has('workspace:set-path')).toBe(true)
    );
    const deliver = appTestMocks.platformListeners.get('workspace:set-path');

    act(() => deliver?.(workspacePath, 'delivery-retry'));
    await waitFor(() =>
      expectToastCall(appTestMocks.addToast, userMessage('failure.failed-to-open-project'), 'error')
    );
    expect(publishedRoots).not.toHaveBeenCalled();
    expect(appTestMocks.writeWorkspaceSelection).not.toHaveBeenCalled();
    expect(store.getState().folders).toEqual([]);
    expect(store.getState().workspaceSelection.path).toBeNull();
    expect(appTestMocks.persistedWorkspacePath).toBeNull();
    expect(loadWorkspaceDeliveryReceipts(sessionStorage)).not.toContain('delivery-retry');

    act(() => deliver?.(workspacePath, 'delivery-retry'));
    await waitFor(() =>
      expect(loadWorkspaceDeliveryReceipts(sessionStorage)).toContain('delivery-retry')
    );
    expect(publishedRoots).toHaveBeenCalledWith([expect.objectContaining({ path: workspacePath })]);
    expect(appTestMocks.ensureWorkspaceOwner).toHaveBeenCalledTimes(2);
    expect(store.getState().workspaceSelection.path).toBe(workspacePath);
    expect(appTestMocks.writeWorkspaceSelection).toHaveBeenCalledExactlyOnceWith(workspacePath);
    expect(appTestMocks.persistedWorkspacePath).toBe(workspacePath);
  });

  it('passes the workspace selected path into FileBrowser for tab reveal', async () => {
    const testPath = '/Users/test/my-workspace';
    const selectedPath = `${testPath}/nested/inside.txt`;
    mockGetFolders.mockReturnValue([{ path: testPath, name: 'my-workspace', addedAt: Date.now() }]);
    appTestMocks.selectedPath = selectedPath;

    vi.mocked(useWorkspace).mockReturnValue({
      path: testPath,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();

    await waitFor(() => {
      expect(appTestMocks.latestFileBrowserProps?.selectedPath).toBe(selectedPath);
    });
  });

  it('opens the Search sidebar when FileBrowser requests Find in Folder', async () => {
    const testPath = '/Users/test/my-workspace';
    mockGetFolders.mockReturnValue([{ path: testPath, name: 'my-workspace', addedAt: Date.now() }]);
    vi.mocked(useWorkspace).mockReturnValue({
      path: testPath,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();
    await screen.findByTestId('file-browser');

    await act(async () => {
      appTestMocks.latestFileBrowserProps?.onFindInFolder(testPath);
    });

    expect(screen.getByTestId('search-panel')).toBeInTheDocument();
  });

  it('opens a notebook tab and writes the requested notebook artifact from FileBrowser creation context', async () => {
    const testPath = '/Users/test/my-workspace';
    mockGetFolders.mockReturnValue([{ path: testPath, name: 'my-workspace', addedAt: Date.now() }]);
    vi.mocked(useWorkspace).mockReturnValue({
      path: testPath,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();
    await screen.findByTestId('file-browser');

    await act(async () => {
      await appTestMocks.latestFileBrowserProps?.onNewNotebook({
        targetPath: testPath,
        targetKind: 'folder',
        parentPath: testPath,
        workspaceRoot: testPath,
        artifactFileName: 'Notebook 1',
        artifactTitle: 'Notebook 1',
      });
    });

    expect(mockCreatePage).toHaveBeenCalledWith(
      'Notebook 1',
      expect.any(String),
      'app-test-workspace-mutation'
    );
    const createdPageId = String(mockCreatePage.mock.calls[0]?.[1]);
    expect(mockOpenInFocusedPanel).toHaveBeenCalledWith('page', createdPageId, 'Notebook 1');
    expect(mockCreateNotebookArtifactFile).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: createdPageId,
        pageId: createdPageId,
        title: 'Notebook 1',
        fileName: 'Notebook 1',
        workspaceRoot: testPath,
        mutationToken: 'app-test-workspace-mutation',
      })
    );
    expect(appTestMocks.endWorkspaceMutation).toHaveBeenCalledWith('app-test-workspace-mutation');
  });

  it('keeps a created notebook visible and writes its package when catalog registration fails', async () => {
    const testPath = '/Users/test/my-workspace';
    mockGetFolders.mockReturnValue([{ path: testPath, name: 'my-workspace', addedAt: Date.now() }]);
    vi.mocked(useWorkspace).mockReturnValue({
      path: testPath,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });
    appTestMocks.registerContextualCatalogEntity.mockRejectedValueOnce(
      new Error('catalog unavailable')
    );

    renderApp();
    await screen.findByTestId('file-browser');

    await act(async () => {
      await appTestMocks.latestFileBrowserProps?.onNewNotebook({
        targetPath: testPath,
        targetKind: 'folder',
        parentPath: testPath,
        workspaceRoot: testPath,
        artifactFileName: 'Notebook 1',
        artifactTitle: 'Notebook 1',
      });
    });

    const createdPageId = String(mockCreatePage.mock.calls[0]?.[1]);
    expect(mockOpenInFocusedPanel).toHaveBeenCalledWith('page', createdPageId, 'Notebook 1');
    expect(mockCreateNotebookArtifactFile).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: createdPageId,
        pageId: createdPageId,
        title: 'Notebook 1',
        workspaceRoot: testPath,
      })
    );
    expectNoToastCall(
      appTestMocks.addToast,
      expect.stringMatching(/notebook was created.*project file could not be created/i),
      'error'
    );
  });

  describe('New Assembly project selection', () => {
    const project = { path: '/projects/lab', name: 'Lab', addedAt: 1 };
    const samples = { path: '/projects/samples', name: 'Samples', addedAt: 2 };
    const pinned = { path: '/fixtures', name: 'Fixtures', addedAt: 3, pinned: true };

    async function openWith(folders: (typeof project)[]) {
      mockGetFolders.mockReturnValue(folders);
      vi.mocked(useWorkspace).mockReturnValue({
        path: null,
        loading: false,
        error: null,
        selectWorkspace: vi.fn(),
        setWorkspacePath: vi.fn(),
        clearWorkspace: vi.fn(),
        refresh: vi.fn(),
      });
      renderApp();
      await screen.findByTestId('file-browser');
    }

    it.each([
      { mode: 'blank', reversed: false, method: 'gibson' },
      { mode: 'schema', reversed: false, method: 'goldengate' },
      { mode: 'blank', reversed: true, method: 'gibson' },
      { mode: 'schema', reversed: true, method: 'goldengate' },
    ])(
      'asks for the project for $mode, independent of mounted order ($reversed)',
      async ({ mode, reversed, method }) => {
        await openWith([pinned, ...(reversed ? [samples, project] : [project, samples])]);
        act(() =>
          appTestMocks.latestFileBrowserProps?.onCreateAssembly({ mode, destinationPath: null })
        );
        expect(screen.getByRole('dialog', { name: 'Create assembly' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Fixtures' })).toBeNull();
        expect(screen.getByTestId('registry-create-destination-continue')).toBeDisabled();
        expect(appTestMocks.createDraftDesign).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Samples', exact: true }));
        fireEvent.click(screen.getByTestId('registry-create-destination-continue'));
        expect(appTestMocks.createDraftDesign).toHaveBeenCalledWith('Untitled Assembly', method);
        expect(mockOpenInFocusedPanel).toHaveBeenCalledWith(
          'design',
          'new-assembly-draft',
          'Untitled Assembly',
          {
            artifactDocument: {
              kind: 'assembly',
              persistence: 'draft',
              workspaceRoot: samples.path,
              destinationPath: samples.path,
            },
          }
        );
        expect(mockCreateDesignArtifactFile).not.toHaveBeenCalled();
        expectNoToastCall(
          appTestMocks.addToast,
          expect.stringMatching(/writable project/),
          expect.anything()
        );
      }
    );

    it('cancels without creating a draft or file', async () => {
      await openWith([project, samples]);
      act(() =>
        appTestMocks.latestFileBrowserProps?.onCreateAssembly({
          mode: 'blank',
          destinationPath: null,
        })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
      expect(screen.queryByRole('dialog', { name: 'Create assembly' })).toBeNull();
      expect(appTestMocks.createDraftDesign).not.toHaveBeenCalled();
      expect(mockCreateDesignArtifactFile).not.toHaveBeenCalled();
    });

    it('uses the sole writable project without asking', async () => {
      await openWith([pinned, samples]);
      act(() =>
        appTestMocks.latestFileBrowserProps?.onCreateAssembly({
          mode: 'blank',
          destinationPath: null,
        })
      );
      expect(mockOpenInFocusedPanel).toHaveBeenCalledWith(
        'design',
        'new-assembly-draft',
        'Untitled Assembly',
        expect.objectContaining({
          artifactDocument: expect.objectContaining({ workspaceRoot: samples.path }),
        })
      );
      expect(screen.queryByRole('dialog', { name: 'Create assembly' })).toBeNull();
    });

    it.each(['/fixtures/subfolder', '/closed-project/subfolder'])(
      'does not redirect invalid destination %s to the sole writable project',
      async (destinationPath) => {
        await openWith([pinned, samples]);
        act(() =>
          appTestMocks.latestFileBrowserProps?.onCreateAssembly({ mode: 'blank', destinationPath })
        );
        expect(appTestMocks.createDraftDesign).not.toHaveBeenCalled();
        expectToastCall(
          appTestMocks.addToast,
          expect.stringMatching(/writable project/),
          'warning'
        );
      }
    );
  });

  it('opens a design tab and writes the requested assembly artifact from FileBrowser creation context', async () => {
    const testPath = '/Users/test/my-workspace';
    mockGetFolders.mockReturnValue([{ path: testPath, name: 'my-workspace', addedAt: Date.now() }]);
    vi.mocked(useWorkspace).mockReturnValue({
      path: testPath,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });

    renderApp();
    await screen.findByTestId('file-browser');

    await act(async () => {
      await appTestMocks.latestFileBrowserProps?.onNewAssembly({
        targetPath: testPath,
        targetKind: 'folder',
        parentPath: testPath,
        workspaceRoot: testPath,
        artifactFileName: 'Assembly 1.wpdesign.json',
        artifactTitle: 'Assembly 1',
      });
    });

    expect(mockCreateDesign).toHaveBeenCalledWith('Assembly 1');
    expect(appTestMocks.beginWorkspaceMutation).toHaveBeenCalledWith(testPath, undefined);
    expect(mockCreateDesign.mock.invocationCallOrder[0]).toBeGreaterThan(
      appTestMocks.beginWorkspaceMutation.mock.invocationCallOrder[0]
    );
    expect(mockOpenInFocusedPanel).toHaveBeenCalledWith('design', 'test-design-id', 'Assembly 1');
    expect(mockCreateDesignArtifactFile).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'test-design-id',
        designId: 'test-design-id',
        name: 'Assembly 1',
        fileName: 'Assembly 1.wpdesign.json',
        workspaceRoot: testPath,
        mutationToken: 'app-test-workspace-mutation',
      })
    );
    expect(appTestMocks.endWorkspaceMutation).toHaveBeenCalledWith('app-test-workspace-mutation');
    await waitFor(() => {
      expect(appTestMocks.revealPath).toHaveBeenCalledWith(
        '/Users/test/my-workspace/Assembly 1.wpdesign.json'
      );
    });
  });

  it('keeps a created design visible when its workspace artifact cannot be registered', async () => {
    const testPath = '/Users/test/my-workspace';
    mockGetFolders.mockReturnValue([{ path: testPath, name: 'my-workspace', addedAt: Date.now() }]);
    vi.mocked(useWorkspace).mockReturnValue({
      path: testPath,
      loading: false,
      error: null,
      selectWorkspace: vi.fn(),
      setWorkspacePath: vi.fn(),
      clearWorkspace: vi.fn(),
      refresh: vi.fn(),
    });
    appTestMocks.registerContextualCatalogEntity.mockRejectedValueOnce(
      new Error('catalog unavailable')
    );

    renderApp();
    await screen.findByTestId('file-browser');

    await act(async () => {
      await appTestMocks.latestFileBrowserProps?.onNewAssembly({
        targetPath: testPath,
        targetKind: 'folder',
        parentPath: testPath,
        workspaceRoot: testPath,
        artifactFileName: 'Assembly 1.wpdesign.json',
        artifactTitle: 'Assembly 1',
      });
    });

    expect(mockOpenInFocusedPanel).toHaveBeenCalledWith('design', 'test-design-id', 'Assembly 1');
    expect(mockCreateDesignArtifactFile).not.toHaveBeenCalled();
    expectToastCall(
      appTestMocks.addToast,
      expect.stringMatching(/assembly was created.*project file could not be created/i),
      'error'
    );
  });
});
