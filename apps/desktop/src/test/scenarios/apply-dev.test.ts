import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PlatformBridge } from '../../platform';

import { TRACK_ADMISSION_REQUEST_V1 } from '@waypoint/genome-data';
import { usePageStore } from '../../features/page/store';
import { assertAllowedGitInvocation } from '../../main/ipc/allowed-git-invocation';

const platformMock = vi.hoisted(() => ({
  importSequenceFromContent: vi.fn(
    async ({
      targetRoot,
      relativePath,
    }: {
      targetRoot: string;
      relativePath: string;
      content: string;
      collisionPolicy: string;
    }) => {
      const stem = relativePath
        .split('/')
        .at(-1)!
        .replace(/\.[^.]+$/, '');
      const parent = relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/') + 1)
        : '';
      const packageRoot = `${targetRoot}/${parent}${stem}`;
      return {
        kind: 'imported',
        packageRoots: [packageRoot],
        packageProductPaths: [`${packageRoot}/${stem}.gb`],
      };
    }
  ),
  createEmptyWorkspace: vi.fn(async ({ name }: { name?: string }) => ({
    rootPath: `/Users/test/Library/Application Support/Waypoint Test/managed-workspaces/${name}/repo`,
    displayName: name ?? 'Development project',
    createdAt: Date.now(),
  })),
  ensureWorkspaceOwner: vi.fn(
    async (_root: string, _mode?: string, _options?: unknown) => 'reference-workspace'
  ),
  appDataDir: vi.fn(async () => '/Users/test/Library/Application Support/Waypoint Test'),
  projectRoot: vi.fn(async () => '/repo'),
  retainTrack: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
    path: `/profile/Track assets/verified/${relativePath.split('/').at(-1)}`,
  })),
  adoptMarkdown: vi.fn(
    async ({ workspaceRoot, path }: { workspaceRoot: string; path: string }) => ({
      workspaceRoot,
      sourcePath: path,
      path: path.replace(/\.(?:md|markdown)$/i, ''),
      pageId: `guide:${path}`,
      title: path.split('/').at(-1)!,
    })
  ),
  mkdir: vi.fn(async (_path: string, _options?: { recursive?: boolean }): Promise<void> => {}),
  exists: vi.fn(async () => false),
  readTextFile: vi.fn(async () => {
    throw new Error('mock source path unavailable');
  }),
  writeTextFile: vi.fn(async (_path: string, _content: string): Promise<void> => {}),
  stat: vi.fn(async (path: string) => ({
    canonicalPath: path,
    size: path.endsWith('AGS001841.bw') ? 237_968_484 : 0,
    isFile: true,
    isDirectory: false,
    mtime: 0,
    ctime: 0,
    mtimeNs: '0',
    ctimeNs: '0',
  })),
  resolveInlineReferenceTarget: vi.fn(
    async (input: {
      roots: Array<{ name: string; path: string }>;
      root: string;
      segments: string[];
    }) => {
      const root = input.roots.find((candidate) => candidate.name === input.root);
      if (!root) return { ok: false as const, code: 'root-not-found' as const };
      return {
        ok: true as const,
        path: `${root.path}/${input.segments.join('/')}`,
        rootPath: root.path,
        relativePath: input.segments.join('/'),
        targetType: 'file' as const,
      };
    }
  ),
  shellExecute: vi.fn<PlatformBridge['shell']['execute']>(async () => ({
    stdout: '',
    stderr: '',
    code: 0,
  })),
  listLocalReferences: vi.fn(async () => [] as any[]),
  retryLocalReference: vi.fn<PlatformBridge['referenceAssets']['retryLocal']>(async () => {
    throw new Error('mock local reference retry unavailable');
  }),
  listHostedReferences: vi.fn(async () => [] as any[]),
  installHostedReference: vi.fn<PlatformBridge['referenceAssets']['installHosted']>(async () => {
    throw new Error('mock hosted reference unavailable');
  }),
  limsEntities: [] as any[],
  existingCatalogIds: new Set<string>(),
  applyImportBatch: vi.fn(async (input: any) => {
    let insertedEntities = 0;
    let insertedLinks = 0;
    let skipped = 0;
    const insertedEntityIds: Array<{ recordId: string; entityId: string }> = [];
    const insertedLinkIds: Array<{ recordId: string; linkId: string }> = [];
    const skippedRecordIds: string[] = [];
    const unresolvedLinks = input.records.flatMap((record: any) =>
      (record.unresolvedLinks ?? []).map((link: any) => ({ recordId: record.id, link }))
    );
    for (const record of input.records) {
      if (!record.accepted || record.duplicateOf || (record.errors && record.errors.length > 0)) {
        skipped++;
        skippedRecordIds.push(record.id);
        continue;
      }
      const entityId = record.entity.id ?? `mock-lims-${platformMock.limsEntities.length + 1}`;
      platformMock.limsEntities.push({
        id: entityId,
        kind: record.entity.kind,
        schemaId: null,
        schemaRevisionId: `schema-entity-${record.entity.kind}-v1`,
        name: record.entity.name,
        fields: record.entity.fields,
        registrationStatus: record.entity.registrationStatus ?? 'registered',
        domainStatus: record.entity.domainStatus ?? null,
        workspaceId: record.entity.workspaceId ?? null,
        actor: input.actor ?? record.entity.actor ?? 'local-user',
        eventSeq: platformMock.limsEntities.length + 1,
        tombstone: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archivedAt: null,
      });
      insertedEntityIds.push({ recordId: record.id, entityId });
      insertedEntities++;
      for (let index = 0; index < (record.links?.length ?? 0); index++) {
        insertedLinkIds.push({ recordId: record.id, linkId: `mock-link-${record.id}-${index}` });
        insertedLinks++;
      }
    }
    return {
      batchId: input.batchId ?? 'mock-batch',
      insertedEntities,
      insertedLinks,
      skipped,
      insertedEntityIds,
      insertedLinkIds,
      skippedRecordIds,
      unresolvedLinks,
      errors: [],
    };
  }),
}));

const openAssemblyMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => 'test-assembly-tab')
);
const referenceAssemblyEntryForTestMock = vi.hoisted(() => vi.fn(async (entry: unknown) => entry));
const composeIndexedTrackViewMock = vi.hoisted(() =>
  vi.fn(async (_input: unknown, _dependencies?: { admit?: (input: any) => Promise<unknown> }) => ({
    ok: true as const,
    tabId: 'figure-4n-tab',
    assemblyId: 'danRer11',
    name: 'Pownall 2023 — Figure 4N recreation',
    unsaved: true as const,
    tracks: [],
  }))
);
const admitIndexedBigWigRequestMock = vi.hoisted(() =>
  vi.fn(async (input: { request: { source: { kind: 'local-file'; path: string } } }) => ({
    input: { kind: 'path' as const, path: input.request.source.path },
    scientificKind: 'quantitative' as const,
  }))
);
const saveTrackViewMock = vi.hoisted(() =>
  vi.fn(async (request: { document: any }) => ({
    saved: {
      document: request.document,
      revision: 'a'.repeat(64),
      path: `/track-views/${request.document.id}.dnaforge-track-view.json`,
    },
  }))
);
const rebindAgentBridgeMock = vi.hoisted(() => vi.fn(async () => true));
const registerCatalogEntityMock = vi.hoisted(() =>
  vi.fn(async (input: { id: string }) => ({ id: input.id }))
);
const bindCatalogEntityToFileMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveWorkspaceScopeMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => 'scenario-workspace')
);

vi.mock('../../utils/environment', () => ({
  isHostedBrowserRuntime: vi.fn(() => false),
  isBrowserOnly: vi.fn(() => true),
  isDesktopRuntime: vi.fn(() => false),
  isElectron: vi.fn(() => false),
}));

vi.mock('../../features/sequence/openAssembly', () => ({
  openAssembly: openAssemblyMock,
}));

vi.mock('../reference-assembly-entry', () => ({
  referenceAssemblyEntryForTest: referenceAssemblyEntryForTestMock,
}));

vi.mock('../../features/ai/tools/compose-indexed-track-view', () => ({
  composeIndexedTrackView: composeIndexedTrackViewMock,
}));

vi.mock('../../features/sequence/public/indexed-track-admission', () => ({
  admitIndexedBigWigRequest: admitIndexedBigWigRequestMock,
}));

vi.mock('../../features/sequence/track-view-library', () => ({
  saveTrackView: saveTrackViewMock,
}));

vi.mock('./renderer-agent-bridge-dev', () => ({
  rebindRendererAgentBridgeForTrustedWorkspaceReplacement: rebindAgentBridgeMock,
}));

vi.mock('../../db/workspace-catalog', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../db/workspace-catalog')>();
  return {
    ...original,
    registerCatalogEntity: registerCatalogEntityMock,
    bindCatalogEntityToFile: bindCatalogEntityToFileMock,
    resolveWorkspaceScope: resolveWorkspaceScopeMock,
    getCatalogEntity: vi.fn(async (id: string) =>
      platformMock.existingCatalogIds.has(id) ? { id } : null
    ),
  };
});

vi.mock('../../platform', () => {
  const bridge = {
    internalFixtures: { retainTrack: platformMock.retainTrack },
    notebook: { adoptMarkdown: platformMock.adoptMarkdown },
    workspace: {
      createEmptyWorkspace: platformMock.createEmptyWorkspace,
      importSequenceFromContent: platformMock.importSequenceFromContent,
    },
    db: { ensureWorkspaceOwner: platformMock.ensureWorkspaceOwner },
    path: {
      appDataDir: platformMock.appDataDir,
      projectRoot: platformMock.projectRoot,
    },
    fs: {
      mkdir: platformMock.mkdir,
      exists: platformMock.exists,
      readTextFile: platformMock.readTextFile,
      writeTextFile: platformMock.writeTextFile,
      stat: platformMock.stat,
      resolveInlineReferenceTarget: platformMock.resolveInlineReferenceTarget,
    },
    shell: {
      execute: platformMock.shellExecute,
    },
    referenceAssets: {
      listLocal: platformMock.listLocalReferences,
      retryLocal: platformMock.retryLocalReference,
      listHosted: platformMock.listHostedReferences,
      installHosted: platformMock.installHostedReference,
    },
    lims: {
      queryEntities: async (input: any = {}) =>
        platformMock.limsEntities.filter((entity) => {
          if (input.kind && entity.kind !== input.kind) return false;
          if (
            input.nameLike &&
            !entity.name.toLowerCase().includes(input.nameLike.trim().toLowerCase())
          ) {
            return false;
          }
          if (input.fieldEquals) {
            for (const [key, value] of Object.entries(input.fieldEquals)) {
              if (entity.fields[key] !== value) return false;
            }
          }
          return true;
        }),
      applyImportBatch: platformMock.applyImportBatch,
      resetRegistry: vi.fn(async () => {
        platformMock.limsEntities.length = 0;
      }),
    },
    trackViews: {
      list: vi.fn(async () => ({ views: [], errors: [] })),
    },
  };
  return {
    initPlatform: vi.fn(async () => bridge),
    platform: vi.fn(() => bridge),
  };
});

const openWorkspaceFromSourceMock = vi.hoisted(() => vi.fn());
vi.mock('../../features/sequence/managed-sequence-repository', () => ({
  managedSequenceRepository: {
    openPackage: vi.fn(async (packageRoot: string) => {
      const stem = packageRoot.split('/').at(-1);
      return {
        ref: { kind: 'managed-sequence', packageId: `imported-${stem}`, packageRoot },
        productPath: `${packageRoot}/${stem}.gb`,
      };
    }),
  },
}));
vi.mock('../../features/workspace-loader/open-workspace-from-source', () => ({
  openWorkspaceFromSource: openWorkspaceFromSourceMock,
}));
const reconcileWorkspaceAfterFilesChangedMock = vi.hoisted(() => vi.fn(async () => undefined));
const runWorkspaceReconcileOperationMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../services/workspace-operations', () => ({
  reconcileWorkspaceAfterFilesChanged: reconcileWorkspaceAfterFilesChangedMock,
  runWorkspaceReconcileOperation: runWorkspaceReconcileOperationMock,
}));

import { useCanvasStore } from '../../features/canvas/store';
import { useDesignStore } from '../../features/design/store';
import { useRichSequenceClipboardStore } from '../../features/sequence-clipboard/store';
import { useSequenceStore } from '../../features/sequence/store';
import { useLaneContractStore } from '../../features/sequence/lane-contract-store';
import { useVerificationStore } from '../../features/alignment-manager/store';
import { useAgentJobsStore } from '../../features/jobs/agent-jobs-store';
import { useWorkspaceStore, workspaceScopeFromState } from '../../stores/workspaceStore';
import { useChatStore } from '../../features/ai/hooks/useChat';
import { isDesktopRuntime } from '../../utils/environment';
import { _resetToolboxState } from '../../hooks/useToolboxStatus';
import {
  typicalSession,
  freshSession,
  editingSession,
  downloadingSession,
  errorSession,
  agentTraceCliSession,
  inlineEntityChipsSession,
  assemblyUiCleanupShowcase,
} from './presets';
import {
  LIMS_HEADERLESS_PRIMER_TSV_BATCH_ID,
  LIMS_HEADERLESS_PRIMER_TSV_FALLBACK_TEXT,
  LIMS_HEADERLESS_PRIMER_TSV_SCENARIO_ID,
  LIMS_PRIMER_CSV_FIXTURE_TEXT,
  LIMS_PRIMER_CSV_IMPORT_BATCH_ID,
  LIMS_PRIMER_CSV_IMPORT_SCENARIO_ID,
} from './lims';
import { staleAlignmentSession, ALIGNMENT_STALE_DOCUMENT_ID } from './alignment';
import {
  primerFileAuthorityWorkspace,
  PRIMER_FILE_AUTHORITY_SEQUENCE_DOCUMENT_ID,
} from './primer-file-authority';
import { sequencePackageAttachTwoClones } from './sequence-package-attach';
import {
  cidarMocloRedFluorescentTu,
  realAssemblyGibsonPcrPcrSpacerFinalization,
} from './assembly-real-pipeline';
import {
  parseSequencePackageDocument,
  sequencePackageRootForMetaPath,
} from '../../db/sequence-package';
import { notebookContentExtensionsSession } from './notebook-content-extensions';
import {
  clearRequestedSequenceDrawer,
  takeRequestedSequenceDrawer,
} from '../../features/sequence/hooks/request-sequence-drawer';
import {
  applyDevScenarioPreset,
  applyScenarioDev,
  cancelSequenceDrawerToolbarRetry,
  clickSequenceDrawerToolbar,
  clearLastAppliedDevScenarioPreset,
  getActiveDevScenarioPresetId,
  getLastAppliedDevScenarioPresetId,
  LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY,
  replayLastAppliedDevScenario,
  rebindScenarioWorkspaceAfterRendererSettles,
  resetToLiveState,
} from './apply-dev';
import { _getDevOverrideState } from '../../hooks/useToolboxStatus';
import type { RuntimeProfile } from '../../shared/runtime-profile';

function setElectronRuntimeProfile(overrides: Partial<RuntimeProfile> = {}): void {
  const profile: RuntimeProfile = {
    kind: overrides.scenarioMutationAllowed === false ? 'primary' : 'scenario-e2e',
    isElectron: true,
    isE2e: true,
    scenarioMutationAllowed: true,
    scenarioMutationReason: 'test profile',
    ...overrides,
  };
  (window as any).electronAPI = {
    ...((window as any).electronAPI ?? {}),
    runtime: {
      getProfile: () => profile,
    },
  };
}

function allowElectronScenarioMutation(): void {
  setElectronRuntimeProfile({ scenarioMutationAllowed: true });
}

let nextFixtureMount = 0;
async function projectFixtureWorkspace(
  source: Extract<
    import('../../features/workspace-loader/types').WorkspaceSource,
    { kind: 'local-folder' }
  >,
  _options?: import('../../features/workspace-loader/types').OpenWorkspaceOptions,
  context?: import('../../features/workspace-loader/open-workspace-from-source').OpenWorkspaceContext
): Promise<
  import('../../features/workspace-loader/open-workspace-from-source').OpenWorkspaceResult
> {
  const mountRequest = ++nextFixtureMount;
  const instance: import('../../features/workspace-loader/types').WorkspaceInstance = {
    id: `local:${source.path}`,
    displayName: source.name ?? source.path,
    rootFolders: [
      {
        path: source.path,
        name: source.name ?? source.path,
        ...(source.pinned ? { pinned: true } : {}),
      },
    ],
    source,
    writable: !source.pinned,
    createdAt: Date.now(),
  };
  const current = useWorkspaceStore.getState();
  useWorkspaceStore.setState({
    folders: [
      ...current.folders.filter((folder) => folder.path !== source.path),
      {
        path: source.path,
        name: source.name ?? source.path,
        addedAt: Date.now(),
        mountRequest,
        ...(source.pinned ? { pinned: true } : {}),
      },
    ],
    expandedPaths: new Set([...current.expandedPaths, source.path]),
  });
  await context?.onWorkspaceCommitted?.({ instance, options: _options ?? {} });
  useWorkspaceStore.getState().revealPath(source.path);
  return { instance };
}

beforeEach(() => {
  _resetToolboxState();
  window.localStorage.clear();
  vi.clearAllMocks();
  openWorkspaceFromSourceMock.mockImplementation(projectFixtureWorkspace);

  platformMock.adoptMarkdown.mockReset().mockImplementation(async ({ workspaceRoot, path }) => ({
    workspaceRoot,
    sourcePath: path,
    path: path.replace(/\.(?:md|markdown)$/i, ''),
    pageId: `guide:${path}`,
    title: path.split('/').at(-1)!,
  }));
  platformMock.limsEntities.splice(0);
  platformMock.existingCatalogIds.clear();
  platformMock.exists.mockResolvedValue(false);
  platformMock.readTextFile.mockRejectedValue(new Error('mock source path unavailable'));
  platformMock.shellExecute.mockImplementation(
    async (_program: string, args: string[], root: string) => {
      assertAllowedGitInvocation(args, root);
      return { stdout: args[0] === 'status' ? 'A  PROOF.md\n' : '', stderr: '', code: 0 };
    }
  );
  platformMock.listLocalReferences.mockReset().mockResolvedValue([]);
  platformMock.retryLocalReference
    .mockReset()
    .mockRejectedValue(new Error('mock local reference retry unavailable'));
  platformMock.listHostedReferences.mockReset().mockResolvedValue([]);
  resolveWorkspaceScopeMock.mockResolvedValue('scenario-workspace');
  vi.mocked(isDesktopRuntime).mockReturnValue(false);
  openAssemblyMock.mockReset().mockResolvedValue('test-assembly-tab');
  referenceAssemblyEntryForTestMock.mockReset().mockImplementation(async (entry) => entry);
  platformMock.installHostedReference.mockReset().mockResolvedValue({
    status: 'view-ready',
    entry: {
      id: 'danRer11',
      name: 'GRCz11 (zebrafish)',
      organism: 'Danio rerio',
      description: 'Prepared test reference',
      assetCacheKey: 'danRer11',
      members: [],
    },
  });
  composeIndexedTrackViewMock.mockReset().mockResolvedValue({
    ok: true,
    tabId: 'figure-4n-tab',
    assemblyId: 'danRer11',
    name: 'Pownall 2023 — Figure 4N recreation',
    unsaved: true,
    tracks: [],
  });
  useLaneContractStore.getState().clear();
  clearRequestedSequenceDrawer();
  delete (window as any).electronAPI;
});

afterEach(() => {
  cancelSequenceDrawerToolbarRetry();
  _resetToolboxState();
  clearLastAppliedDevScenarioPreset();
  clearRequestedSequenceDrawer();
  delete (window as any).electronAPI;
});

describe('_setDevOverride / _clearDevOverride', () => {
  it('should inject sidecar data and set state to loaded', async () => {
    const { _setDevOverride } = await import('../../hooks/useToolboxStatus');
    const scenario = typicalSession();

    _setDevOverride(scenario.sidecar!);

    const state = _getDevOverrideState();
    expect(state.data).toEqual(scenario.sidecar);
    expect(state.loadState).toBe('loaded');
  });

  it('should stop polling when override is active', async () => {
    const { _setDevOverride } = await import('../../hooks/useToolboxStatus');
    const scenario = typicalSession();

    _setDevOverride(scenario.sidecar!);

    const state = _getDevOverrideState();
    expect(state.isOverridden).toBe(true);
  });

  it('should resume normal state when cleared', async () => {
    const { _setDevOverride, _clearDevOverride } = await import('../../hooks/useToolboxStatus');
    const scenario = typicalSession();

    _setDevOverride(scenario.sidecar!);
    _clearDevOverride();

    const state = _getDevOverrideState();
    expect(state.isOverridden).toBe(false);
    expect(state.data).toBeNull();
    expect(state.loadState).toBe('loading');
  });
});

describe('stable sequence scenario identity', () => {
  it('registers a stable document ID separately from its private source path', async () => {
    await applyScenarioDev(typicalSession());

    expect(registerCatalogEntityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'fixture:sequence:puc19',
        type: 'sequence',
        locator: 'file:///workspace/pUC19.gb',
      })
    );
    expect(bindCatalogEntityToFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'fixture:sequence:puc19',
        path: '/workspace/pUC19.gb',
      })
    );
    expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
      entityId: 'fixture:sequence:puc19',
      sequenceDocument: {
        kind: 'catalog-sequence',
        entityId: 'fixture:sequence:puc19',
      },
    });
    expect(useSequenceStore.getState().sequences['fixture:sequence:puc19']).toBeDefined();
    expect(useSequenceStore.getState().sequences['/workspace/pUC19.gb']).toBeUndefined();
  });
});

describe('applyScenarioDev', () => {
  it('hydrates and resets deterministic agent-action Jobs rows', async () => {
    await applyScenarioDev({
      agentJobs: {
        jobs: [
          {
            id: 'action-running',
            tool_name: 'align_reads',
            duration: 'long-running',
            pool: 'cpu',
            state: 'running',
            cancelable: true,
            can_cancel: true,
            requested_at: '2026-09-16T08:00:00.000Z',
            completed_at: null,
            error_code: null,
            agent_identity: { id: 'agent-one', label: 'Agent one', kind: 'desktop-chat' },
          },
        ],
        observedAtMs: 1234,
      },
    });

    expect(useAgentJobsStore.getState()).toMatchObject({
      jobCount: 1,
      activeCount: 1,
      terminalCount: 0,
      observedAtMs: 1234,
      jobs: [expect.objectContaining({ id: 'action-running' })],
    });

    await applyScenarioDev({});
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [],
      jobCount: 0,
      activeCount: 0,
      terminalCount: 0,
      observedAtMs: null,
    });
  });

  it('should set sidecar data via dev override', async () => {
    const scenario = typicalSession();
    await applyScenarioDev(scenario);

    const state = _getDevOverrideState();
    expect(state.data).toEqual(scenario.sidecar);
    expect(state.loadState).toBe('loaded');
  });

  it('should set canvas tabs in single-panel layout', async () => {
    const scenario = editingSession();
    await applyScenarioDev(scenario);

    const canvasState = useCanvasStore.getState();
    const mainPanel = canvasState.panels['main'];
    expect(mainPanel).toBeDefined();
    expect(mainPanel.tabs.length).toBeGreaterThan(0);
    expect(mainPanel.tabs[0].type).toBe('sequence');
  });

  it('should set sequences into sequence store', async () => {
    const scenario = typicalSession();
    await applyScenarioDev(scenario);

    const seqState = useSequenceStore.getState();
    expect(Object.keys(seqState.sequences).length).toBeGreaterThan(0);
    const documentId = Object.keys(seqState.sequences)[0];
    expect(seqState.captureForSave(documentId)?.sequence).toEqual(seqState.sequences[documentId]);
    seqState.dispatchEdit(documentId, { type: 'INSERT', text: 'A' });
    expect(useSequenceStore.getState().isDirty(documentId)).toBe(true);
  });

  it('hydrates copied-region provenance for one-click assembly UI scenarios', async () => {
    await applyScenarioDev(assemblyUiCleanupShowcase());

    expect(useRichSequenceClipboardStore.getState().copiedRegion).toEqual(
      expect.objectContaining({
        sourceName: 'pUC19 PCR fragment',
        sourceType: 'pcr',
      })
    );
  });

  it('should set workspace folders in browser mode', async () => {
    const scenario = typicalSession();
    await applyScenarioDev(scenario);

    const wsState = useWorkspaceStore.getState();
    expect(wsState.folders.length).toBeGreaterThan(0);
  });

  it('resolves the one-click  preset through the live inline-reference session', async () => {
    const scenario = inlineEntityChipsSession();
    const conversationId = scenario.chat?.conversationId;
    if (!conversationId) throw new Error('Expected the inline-chip scenario conversation id.');
    useChatStore.setState({
      _convStates: new Map([
        [
          conversationId,
          {
            messages: [
              {
                id: 'stale-history-message',
                role: 'assistant',
                content: 'Stale cached history that must not survive scenario replacement.',
                createdAt: 0,
              },
            ],
            queuedMessages: [],
            turns: {},
            activeTurnId: null,
            streamingBlocks: [],
            isLoading: false,
            isStreaming: false,
            error: null,
          },
        ],
      ]),
    });

    await applyScenarioDev(scenario);

    const chatState = useChatStore.getState();
    const canvasState = useCanvasStore.getState();
    const activeConversationState = chatState._convStates.get(conversationId);
    expect(canvasState.focusedPanelId).toBe('right');
    expect(chatState.currentConversationId).toBe(conversationId);
    expect(chatState.messages).toEqual([
      expect.objectContaining({
        id: `${conversationId}-user`,
        role: 'user',
        content: 'Show pUC19 and where it lives.',
      }),
    ]);
    expect(chatState.isStreaming).toBe(true);
    expect(chatState.streamingBlocks).toHaveLength(1);
    const block = chatState.streamingBlocks[0];
    expect(block.type).toBe('text');
    if (block.type !== 'text') throw new Error('Expected a text block.');
    expect(block.document?.parts).toHaveLength(1);
    expect(block.document?.parts.map((part) => part.state.status)).toEqual(['resolved']);
    expect(block.referenceIds).toHaveLength(1);
    expect(block.content).toContain('dnaforge-chat://reference/');
    expect(block.content).not.toContain('dnaforge-chat://workspace/');
    expect(block.content).not.toContain('.gb');
    expect(usePageStore.getState().pages['fixture-inline-entity-chips-notebook']).toMatchObject({
      title: 'Entity chip comparison',
    });
    expect(platformMock.resolveInlineReferenceTarget).toHaveBeenCalledTimes(1);
    expect(activeConversationState).toEqual({
      messages: chatState.messages,
      queuedMessages: chatState.queuedMessages,
      turns: chatState.turns,
      activeTurnId: chatState.activeTurnId,
      streamingBlocks: chatState.streamingBlocks,
      isLoading: chatState.isLoading,
      isStreaming: chatState.isStreaming,
      error: chatState.error,
    });
  });

  it('hydrates scenario chat into the scoped conversation state and clears stale inline state', async () => {
    useChatStore.setState({
      askAiInlineChat: {
        conversationId: 'stale-inline-conversation',
        workspacePath: '/stale',
      },
      _convStates: new Map([
        [
          'stale-inline-conversation',
          {
            messages: [],
            queuedMessages: [],
            turns: {},
            activeTurnId: null,
            streamingBlocks: [],
            isLoading: false,
            isStreaming: false,
            error: null,
          },
        ],
      ]),
    });
    const messages = [
      {
        id: 'scoped-scenario-message',
        role: 'user' as const,
        content: 'Visible in the scoped scenario chat.',
        createdAt: 1,
      },
    ];

    await applyScenarioDev({
      chat: {
        conversationId: 'scoped-scenario-conversation',
        messages,
      },
    });

    const chatState = useChatStore.getState();
    expect(chatState.askAiInlineChat).toBeNull();
    expect([...chatState._convStates.keys()]).toEqual(['scoped-scenario-conversation']);
    expect(chatState._convStates.get('scoped-scenario-conversation')).toMatchObject({
      messages,
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      error: null,
    });
  });

  it('should skip unmaterialized workspace folders when running in real Electron', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();

    const scenario = {
      sidecar: typicalSession().sidecar,
      workspace: {
        folders: [{ path: '/workspace/unmaterialized', name: 'unmaterialized' }],
        selectedPath: '/workspace/unmaterialized',
      },
    };
    await applyScenarioDev(scenario);

    const wsState = useWorkspaceStore.getState();
    expect(wsState.folders).toHaveLength(0);
  });

  it('blocks primary Electron profile scenario mutation before any live state is reset', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    setElectronRuntimeProfile({
      kind: 'primary',
      isE2e: false,
      scenarioMutationAllowed: false,
      scenarioMutationReason: 'primary dev profile',
    });

    useChatStore.setState({
      currentConversationId: 'live-conversation',
      messages: [
        {
          id: 'live-message',
          role: 'assistant',
          content: 'Existing live DNAForge chat history',
          createdAt: 1,
        },
      ],
      conversations: [
        {
          id: 'live-conversation',
          title: 'Live conversation',
          workspacePath: '/Users/test/live-workspace',
          pinned: false,
          provider: 'codex-sdk',
          model: 'codex-sdk',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    useWorkspaceStore.setState({
      folders: [
        {
          path: '/Users/test/live-workspace',
          name: 'live-workspace',
          addedAt: 1,
        },
      ],
      selectedPath: '/Users/test/live-workspace/input.gb',
    });

    await expect(
      Promise.resolve().then(() => applyScenarioDev(agentTraceCliSession()))
    ).rejects.toThrow(/--e2e plus WAYPOINT_TEST=1/);

    expect(useChatStore.getState().currentConversationId).toBe('live-conversation');
    expect(useChatStore.getState().messages[0]?.content).toBe(
      'Existing live DNAForge chat history'
    );
    expect(useChatStore.getState().conversations).toHaveLength(1);
    expect(useWorkspaceStore.getState().folders[0]?.path).toBe('/Users/test/live-workspace');
    expect(useWorkspaceStore.getState().selectedPath).toBe('/Users/test/live-workspace/input.gb');
    expect(_getDevOverrideState().isOverridden).toBe(false);
    expect(platformMock.mkdir).not.toHaveBeenCalled();
    expect(platformMock.writeTextFile).not.toHaveBeenCalled();
  });

  it('allows a lane-contract DELTA scenario in the BLOCKED primary profile ', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    setElectronRuntimeProfile({
      kind: 'primary',
      isE2e: false,
      scenarioMutationAllowed: false,
      scenarioMutationReason: 'primary dev profile',
    });
    useWorkspaceStore.setState({
      folders: [{ path: '/Users/test/live-workspace', name: 'live-workspace', addedAt: 1 }],
      selectedPath: '/Users/test/live-workspace/input.gb',
    });

    await expect(
      Promise.resolve().then(() => applyScenarioDev({ laneContract: { activeDataset: null } }))
    ).resolves.toBeUndefined();
    expect(useWorkspaceStore.getState().folders[0]?.path).toBe('/Users/test/live-workspace');
  });

  it('owns a realistic BAM scenario lane by the focused assembly tab', async () => {
    const dataset = {
      kind: 'pileup' as const,
      trackType: 'pileup-genomewide',
      trackId: 'pileup-genomewide-grch38',
      label: 'HG002 reads',
      color: 0xa8ceff,
      trackPx: 276,
      records: [],
      source: {
        bamPath: '/data/HG002.bam',
        indexPath: '/data/HG002.bam.bai',
      },
    };

    useCanvasStore.setState({
      focusedPanelId: 'main',
      panels: {
        main: {
          id: 'main',
          activeTabId: 'grch38-tab-b',
          tabs: [
            {
              id: 'grch38-tab-a',
              type: 'sequence',
              entityId: 'assembly:grch38',
              label: 'GRCh38 A',
            },
            {
              id: 'grch38-tab-b',
              type: 'sequence',
              entityId: 'assembly:grch38',
              label: 'GRCh38 B',
            },
          ],
        },
      },
    });

    await applyScenarioDev({
      laneContract: {
        assemblyId: 'grch38',
        activeDataset: dataset,
      },
    });

    expect(useLaneContractStore.getState().lanesForOwner('grch38-tab-b')).toEqual([
      expect.objectContaining({ visible: true, dataset }),
    ]);
    expect(useLaneContractStore.getState().lanesForOwner('grch38-tab-a')).toEqual([]);
    expect(useLaneContractStore.getState().lanesForOwner('grch38')).toEqual([]);
    expect(useLaneContractStore.getState().lanesForOwner('__legacy__')).toEqual([]);
  });

  it('allows Electron scenario mutation when an explicit disposable profile lease is present', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    setElectronRuntimeProfile({
      kind: 'scenario-e2e',
      isE2e: false,
      scenarioMutationAllowed: true,
      scenarioMutationReason: 'Allowed by DNAFORGE_ALLOW_SCENARIO_MUTATION=1 at launch.',
    });

    await applyScenarioDev(agentTraceCliSession());

    expect(useWorkspaceStore.getState().folders[0]?.path).toContain(
      '/managed-workspaces/agent-trace-cli/repo'
    );
    expect(useChatStore.getState().messages[0]?.content).toContain('Agent Trace CLI Test Kit');
  });

  it('should skip assets field (no Node.js fs in browser)', async () => {
    const scenario = typicalSession();
    scenario.assets = [{ wpAssetsPath: 'some/file.gb', mountPath: '/mock/file.gb' }];

    await expect(Promise.resolve(applyScenarioDev(scenario))).resolves.toBeUndefined();
  });

  it('should tolerate files when no browser mock filesystem is present', async () => {
    const scenario = typicalSession();
    scenario.files = { '/some/path.gb': 'LOCUS test' };

    await expect(Promise.resolve(applyScenarioDev(scenario))).resolves.toBeUndefined();
  });

  it('should hydrate alignment sessions with scoped stale state', async () => {
    await applyScenarioDev(staleAlignmentSession());

    const state = useVerificationStore.getState();
    const refState = state.verificationState[ALIGNMENT_STALE_DOCUMENT_ID];

    expect(refState.sessions).toHaveLength(1);
    expect(state.staleReferences[ALIGNMENT_STALE_DOCUMENT_ID]).toBe(true);
    expect(state.staleSessionIds[ALIGNMENT_STALE_DOCUMENT_ID]).toEqual(['alignment-stale-session']);
  });

  it('imports the alignment query as a durable native sequence package', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    const scenario = staleAlignmentSession();
    const queryPath = scenario.alignment!.sessions[0].tracks[0].queryPath;

    await applyScenarioDev(scenario);

    expect(platformMock.importSequenceFromContent).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'puc19-reference-with-substitutions.gb',
        content: scenario.files![queryPath],
        collisionPolicy: 'refuse',
      })
    );
    const documentId = useCanvasStore.getState().panels.main.tabs[0].entityId;
    const track =
      useVerificationStore.getState().verificationState[documentId].sessions[0].tracks[0];
    expect(track.queryPath).toBe(
      '/Users/test/Library/Application Support/Waypoint Test/managed-workspaces/workspace/repo/puc19-reference-with-substitutions/puc19-reference-with-substitutions.gb'
    );
    expect(platformMock.writeTextFile).not.toHaveBeenCalledWith(
      expect.stringMatching(/repo\/puc19-reference-with-substitutions\.gb$/),
      expect.anything()
    );
  });

  it('imports native packages before hydrating alignment identities and paths', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    await applyScenarioDev(staleAlignmentSession());
    const documentId = useCanvasStore.getState().panels.main.tabs[0].entityId;
    expect(documentId).toBe('imported-puc19-reference');
    const state = useVerificationStore.getState();
    const referencePath = state.referenceSourcePaths[documentId];
    const track = state.verificationState[documentId].sessions[0].tracks[0];
    expect(referencePath).toContain(
      '/managed-workspaces/workspace/repo/puc19-reference/puc19-reference.gb'
    );
    expect(track.queryPath).toContain(
      '/managed-workspaces/workspace/repo/puc19-reference-with-substitutions/puc19-reference-with-substitutions.gb'
    );
    expect(useSequenceStore.getState().sequences[documentId]).toBeDefined();
    expect(platformMock.importSequenceFromContent).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'puc19-reference.gb',
        content: expect.stringContaining('LOCUS'),
        collisionPolicy: 'refuse',
      })
    );
    expect(registerCatalogEntityMock).not.toHaveBeenCalled();
    expect(bindCatalogEntityToFileMock).not.toHaveBeenCalled();
  });

  it('keeps assembly source identity resolvable when materializing scenario files', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();

    const scenario = assemblyUiCleanupShowcase();
    const scenarioDesignId = scenario.designs?.activeDesignId;
    const scenarioDesign = scenarioDesignId ? scenario.designs?.designs[scenarioDesignId] : null;
    if (!scenarioDesign) throw new Error('Expected assembly cleanup scenario design.');
    scenarioDesign.backboneSequenceId = scenarioDesign.regions[0].sourceSequenceId;

    await applyScenarioDev(scenario);

    const designState = useDesignStore.getState();
    const activeDesignId = designState.activeDesignId;
    if (!activeDesignId) throw new Error('Expected materialized assembly to be active.');
    const design = designState.designs[activeDesignId];
    const materializedSource = Object.keys(useSequenceStore.getState().sequences)[0];

    expect(materializedSource).toBe('imported-pUC19');
    expect(useSequenceStore.getState().sequences[materializedSource]).toEqual({
      ...scenario.sequences?.[scenarioDesign.regions[0].sourceSequenceId],
      id: materializedSource,
    });
    expect(new Set(design.regions.map((region) => region.sourceSequenceId))).toEqual(
      new Set([materializedSource])
    );
    expect(design.backboneSequenceId).toBe(materializedSource);
    expect(useRichSequenceClipboardStore.getState().copiedRegion?.sourceId).toBe(
      materializedSource
    );
    expect(design.regions.some((region) => region.sourceSequenceId.startsWith('/workspace/'))).toBe(
      false
    );
    expect(platformMock.importSequenceFromContent).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'workspace/real-fixtures/pUC19.gb',
        collisionPolicy: 'refuse',
      })
    );
    expect(registerCatalogEntityMock).not.toHaveBeenCalled();
  });

  it('materializes a file-backed design before committing the finalization scenario baseline', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();

    await applyScenarioDev(realAssemblyGibsonPcrPcrSpacerFinalization());

    const workspaceRoot = useWorkspaceStore.getState().folders[0]?.path;
    const designId = useDesignStore.getState().activeDesignId;
    expect(workspaceRoot).toBeTruthy();
    expect(platformMock.createEmptyWorkspace).toHaveBeenCalledWith({ name: 'real-fixtures' });
    expect(workspaceRoot).toBe(
      (await platformMock.createEmptyWorkspace.mock.results[0].value).rootPath
    );
    expect(designId).toBeTruthy();
    const artifactPath = `${workspaceRoot}/${designId!.replace(/[^a-zA-Z0-9._-]/g, '-')}.wpdesign.json`;
    const artifactWriteIndex = platformMock.writeTextFile.mock.calls.findIndex(
      ([path]) => path === artifactPath
    );
    expect(artifactWriteIndex).toBeGreaterThanOrEqual(0);
    const artifact = JSON.parse(platformMock.writeTextFile.mock.calls[artifactWriteIndex][1]);
    expect(artifact).toMatchObject({
      schema: 'waypoint.design.v1',
      kind: 'assembly-design',
      id: designId,
      design: { id: designId },
    });
    expect(artifact.design).toEqual(
      JSON.parse(JSON.stringify(useDesignStore.getState().designs[designId!]))
    );
    expect(
      artifact.design.regions.every(
        (region: { sourceSequenceId: string }) => !region.sourceSequenceId.startsWith('/workspace/')
      )
    ).toBe(true);
    expect(registerCatalogEntityMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: designId, type: 'design', workspaceRoot })
    );
    expect(bindCatalogEntityToFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: designId,
        path: artifactPath,
        fileKind: 'waypoint-design',
        workspaceRoot,
      })
    );
    const baselineCommitIndex = platformMock.shellExecute.mock.calls.findIndex(
      ([, args]) => args[0] === 'commit'
    );
    expect(baselineCommitIndex).toBeGreaterThanOrEqual(0);
    expect(platformMock.writeTextFile.mock.invocationCallOrder[artifactWriteIndex]).toBeLessThan(
      platformMock.shellExecute.mock.invocationCallOrder[baselineCommitIndex]
    );
  });

  it('materializes agent trace CLI fixture workspace into a real Electron workspace root', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();

    await applyScenarioDev(agentTraceCliSession());

    const workspaceState = useWorkspaceStore.getState();
    expect(workspaceState.folders).toHaveLength(1);
    expect(workspaceState.folders[0].path).toContain('/managed-workspaces/agent-trace-cli/repo');
    expect(workspaceState.folders[0].path).not.toBe('/workspace/agent-trace-cli');
    expect(workspaceState.selectedPath).toBe(workspaceState.folders[0].path);
    expect(useChatStore.getState().messages[0]?.content).toContain('Agent Trace CLI Test Kit');
    expect(platformMock.importSequenceFromContent).not.toHaveBeenCalled();
    for (const file of ['vector.fa', 'insert.fa', 'mutation_case.fa']) {
      expect(platformMock.writeTextFile).toHaveBeenCalledWith(
        `${workspaceState.folders[0].path}/input/${file}`,
        agentTraceCliSession().files![`/workspace/agent-trace-cli/input/${file}`]
      );
    }
    const manifestWrite = platformMock.writeTextFile.mock.calls.find(
      ([path]) => path === `${workspaceState.folders[0].path}/.forge/catalog.json`
    );
    expect(JSON.parse(manifestWrite![1]).entities).toEqual(
      expect.arrayContaining(
        ['vector.fa', 'insert.fa', 'mutation_case.fa'].map((file) =>
          expect.objectContaining({
            type: 'file',
            name: file,
            placement: { kind: 'file', relativePath: `input/${file}`, fileKind: 'fasta' },
          })
        )
      )
    );
    expect(platformMock.writeTextFile).toHaveBeenCalledWith(
      expect.stringContaining('/managed-workspaces/agent-trace-cli/repo/prompts.md'),
      expect.stringContaining('Prompt 1 - workspace audit')
    );
  });

  it('gives copied CIDAR packages independent identities and matching design sources', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    const scenario = cidarMocloRedFluorescentTu();
    const originalFiles = { ...scenario.files };
    const originalIds = new Set(
      Object.entries(originalFiles)
        .filter(([path]) => sequencePackageRootForMetaPath(path))
        .map(([, content]) => parseSequencePackageDocument(String(content)).id)
    );
    for (const id of originalIds) platformMock.existingCatalogIds.add(id);
    await applyScenarioDev(scenario);
    const copies = platformMock.writeTextFile.mock.calls
      .filter(([path]) => sequencePackageRootForMetaPath(path))
      .map(([, content]) => parseSequencePackageDocument(content));
    expect(copies).toHaveLength(originalIds.size);
    const copiedIds = new Set(copies.map(({ id }) => id));
    expect(copiedIds.size).toBe(copies.length);
    expect([...copiedIds].some((id) => originalIds.has(id))).toBe(false);
    const state = useDesignStore.getState();
    const design = state.designs[state.activeDesignId!];
    expect(design.regions.every(({ sourceSequenceId }) => copiedIds.has(sourceSequenceId))).toBe(
      true
    );
    expect(copiedIds.has(design.backboneSequenceId!)).toBe(true);
    expect(scenario.files).toEqual(originalFiles);
  });

  it('passes the reference-root role through the normal native project mount', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    await applyDevScenarioPreset('recently-edited-reference-boundary');
    expect(openWorkspaceFromSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-fixtures', pinned: true }),
      { inPlace: true }
    );
    expect(
      useWorkspaceStore.getState().folders.find((folder) => folder.name === 'test-fixtures')?.pinned
    ).toBe(true);
  });

  it('stages reference fixtures without writing through a registered read-only owner', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    const references = new Set<string>();
    const mkdir = platformMock.mkdir.getMockImplementation();
    const write = platformMock.writeTextFile.getMockImplementation();
    const shell = platformMock.shellExecute.getMockImplementation();
    const assertWritable = (path: string) => {
      if ([...references].some((root) => path === root || path.startsWith(`${root}/`))) {
        throw new Error('This content change requires one active writable owning project.');
      }
    };
    platformMock.ensureWorkspaceOwner.mockImplementationOnce(async (root, mode) => {
      if (mode === 'reference') references.add(root);
      return 'reference-workspace';
    });
    platformMock.mkdir.mockImplementation(async (...args: unknown[]) => {
      if (typeof args[0] === 'string') assertWritable(args[0]);
    });
    platformMock.writeTextFile.mockImplementation(async (path) => assertWritable(path));
    platformMock.shellExecute.mockImplementation(async (_program, args, root) => {
      assertAllowedGitInvocation(args, root);
      if (['add', 'commit', 'init', 'config'].includes(args[0])) assertWritable(root);
      return { stdout: args[0] === 'status' ? 'A  PROOF.md\n' : '', stderr: '', code: 0 };
    });
    try {
      await expect(
        applyDevScenarioPreset('recently-edited-reference-boundary')
      ).resolves.toBeUndefined();
      expect(references.size).toBe(1);
      expect(platformMock.createEmptyWorkspace).not.toHaveBeenCalledWith({ name: 'test-fixtures' });
      expect(openWorkspaceFromSourceMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'test-fixtures', pinned: true }),
        { inPlace: true }
      );
    } finally {
      if (mkdir) platformMock.mkdir.mockImplementation(mkdir);
      if (write) platformMock.writeTextFile.mockImplementation(write);
      if (shell) platformMock.shellExecute.mockImplementation(shell);
    }
  });

  it('registers reference fixtures before their files can produce recent activity', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    await applyDevScenarioPreset('recently-edited-reference-boundary');
    expect(platformMock.createEmptyWorkspace).not.toHaveBeenCalledWith({ name: 'test-fixtures' });
    const registration = platformMock.ensureWorkspaceOwner.mock.calls.find(
      (call) => call[1] === 'reference'
    );
    expect(registration).toEqual([expect.any(String), 'reference', { name: 'test-fixtures' }]);
    const root = registration![0];
    expect(platformMock.mkdir).toHaveBeenCalledWith(root, { recursive: true });
    const directoryIndex = platformMock.mkdir.mock.calls.findIndex(([path]) => path === root);
    expect(platformMock.mkdir.mock.invocationCallOrder[directoryIndex]).toBeLessThan(
      platformMock.ensureWorkspaceOwner.mock.invocationCallOrder[0]
    );
    const writes = platformMock.writeTextFile.mock.calls;
    const referenceWrite = writes.findIndex(([path]) => path.startsWith(`${root}/`));
    expect(referenceWrite).toBeGreaterThanOrEqual(0);
    expect(platformMock.ensureWorkspaceOwner.mock.invocationCallOrder[0]).toBeGreaterThan(
      platformMock.writeTextFile.mock.invocationCallOrder[referenceWrite]
    );
    const referenceMount = openWorkspaceFromSourceMock.mock.calls.findIndex(
      ([source]) => source.path === root
    );
    expect(referenceMount).toBeGreaterThanOrEqual(0);
    expect(platformMock.ensureWorkspaceOwner.mock.invocationCallOrder[0]).toBeLessThan(
      openWorkspaceFromSourceMock.mock.invocationCallOrder[referenceMount]
    );
  });

  it('allocates separate empty reference roots before registration without authoring projects', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    await applyScenarioDev({
      dev: { scenarioId: 'two-empty-reference-roots' },
      workspace: {
        folders: [
          { path: '/reference-a', name: 'Reference A', pinned: true },
          { path: '/reference-b', name: 'Reference B', pinned: true },
        ],
      },
      files: {},
    });
    const registrations = platformMock.ensureWorkspaceOwner.mock.calls;
    expect(registrations).toHaveLength(2);
    expect(new Set(registrations.map(([root]) => root)).size).toBe(2);
    for (const [index, [root, mode]] of registrations.entries()) {
      expect(mode).toBe('reference');
      expect(platformMock.mkdir).toHaveBeenCalledWith(root, { recursive: true });
      const directoryIndex = platformMock.mkdir.mock.calls.findIndex(([path]) => path === root);
      expect(platformMock.mkdir.mock.invocationCallOrder[directoryIndex]).toBeLessThan(
        platformMock.ensureWorkspaceOwner.mock.invocationCallOrder[index]
      );
    }
    expect(platformMock.createEmptyWorkspace).not.toHaveBeenCalled();
    expect(platformMock.writeTextFile).not.toHaveBeenCalled();
  });

  it('imports the assembly demo through its created project without creating unowned or project-root directories', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    const root =
      '/Users/test/Library/Application Support/Waypoint Test/managed-workspaces/assembly-demo/repo';
    const mkdir = platformMock.mkdir.getMockImplementation();
    const write = platformMock.writeTextFile.getMockImplementation();
    const requireOwnedChild = (path: string) => {
      if (!path.startsWith(`${root}/`)) throw new Error('PROJECT_FILESYSTEM_AUTHORITY_REQUIRED');
    };
    platformMock.mkdir.mockImplementation(async (path) => requireOwnedChild(path));
    platformMock.writeTextFile.mockImplementation(async (path) => requireOwnedChild(path));
    try {
      await applyDevScenarioPreset('assembly-demo');
      expect(platformMock.createEmptyWorkspace).toHaveBeenCalledWith({ name: 'assembly-demo' });
      expect(platformMock.importSequenceFromContent).toHaveBeenCalledTimes(5);
      for (const [input] of platformMock.importSequenceFromContent.mock.calls)
        expect(input).toMatchObject({ targetRoot: root, collisionPolicy: 'refuse' });
      expect(platformMock.mkdir).not.toHaveBeenCalledWith(root, expect.anything());
      expect(platformMock.mkdir).toHaveBeenCalledWith(`${root}/plasmids`, { recursive: true });
      expect(platformMock.writeTextFile).toHaveBeenCalledWith(
        `${root}/README.md`,
        expect.stringContaining('Extractable parts')
      );
      expect(useWorkspaceStore.getState().folders).toEqual([
        expect.objectContaining({ path: root, name: 'assembly-demo' }),
      ]);
      const tabs = Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs);
      expect(tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'sequence',
            sequenceDocument: expect.objectContaining({ kind: 'managed-sequence' }),
          }),
          expect.objectContaining({ type: 'chat' }),
        ])
      );
    } finally {
      if (mkdir) platformMock.mkdir.mockImplementation(mkdir);
      if (write) platformMock.writeTextFile.mockImplementation(write);
    }
  });

  it('creates and mounts a regular project before publishing the primer proof sequence', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();

    const priorCanvas = useCanvasStore.getState();
    openWorkspaceFromSourceMock.mockImplementation(async (source, options, context) => {
      if (platformMock.shellExecute.mock.calls.some(([, args]) => args[0] === 'commit')) {
        expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
      } else {
        expect(useCanvasStore.getState()).toBe(priorCanvas);
      }
      return projectFixtureWorkspace(source, options, context);
    });

    await applyScenarioDev(primerFileAuthorityWorkspace());

    const workspaceRoot = useWorkspaceStore.getState().folders[0]?.path;
    expect(platformMock.createEmptyWorkspace).toHaveBeenCalledWith({ name: 'Primer development' });
    expect(workspaceRoot).toContain('/managed-workspaces/Primer development/repo');
    expect(openWorkspaceFromSourceMock).toHaveBeenCalledWith(
      { kind: 'local-folder', path: workspaceRoot, name: 'Primer development' },
      { inPlace: true }
    );
    expect(reconcileWorkspaceAfterFilesChangedMock).toHaveBeenCalledWith({
      workspaceRoot,
      strict: true,
    });
    expect(platformMock.createEmptyWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      platformMock.importSequenceFromContent.mock.invocationCallOrder[0]
    );
    expect(openWorkspaceFromSourceMock.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileWorkspaceAfterFilesChangedMock.mock.invocationCallOrder[0]
    );
    expect(registerCatalogEntityMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().selectedPath).toBe(`${workspaceRoot}/pUC19/pUC19.gb`);
    expect(useSequenceStore.getState().sequences['imported-pUC19']).toBeDefined();
    expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
      entityId: 'imported-pUC19',
      sequenceDocument: {
        kind: 'managed-sequence',
        packageId: 'imported-pUC19',
        packageRoot: `${workspaceRoot}/pUC19`,
      },
    });
    expect(platformMock.writeTextFile).toHaveBeenCalledWith(
      `${workspaceRoot}/PROOF.md`,
      expect.stringContaining('Create and save the primer')
    );
    expect(platformMock.shellExecute).not.toHaveBeenCalledWith('git', ['init'], workspaceRoot);
    expect(platformMock.shellExecute).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'Initialize primer file authority proof workspace'],
      workspaceRoot
    );
  });

  it('scopes materialized notebook pages and their open tabs to the real workspace', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();

    await applyScenarioDev(notebookContentExtensionsSession());

    const workspaceRoot = useWorkspaceStore.getState().folders[0]?.path;
    const scopedPageId = 'scenario-workspace::fixture-notebook-content-extensions';
    expect(resolveWorkspaceScopeMock).toHaveBeenCalledWith(workspaceRoot);
    expect(usePageStore.getState().pages[scopedPageId]).toMatchObject({
      id: scopedPageId,
      title: 'Notebook content extensions',
    });
    expect(usePageStore.getState().dirtyIds).toEqual(new Set());
    expect(useCanvasStore.getState().panels.main.tabs[0]?.entityId).toBe(scopedPageId);
  });

  it('requests the alignments drawer for the  attach preset', async () => {
    const scenario = sequencePackageAttachTwoClones();
    await applyScenarioDev(scenario);

    expect(takeRequestedSequenceDrawer()).toBe('alignments');
  });

  it('clicks the alignments toolbar so DevPanel opens the drawer without SequenceTab', async () => {
    const button = document.createElement('button');
    button.setAttribute('data-testid', 'toolbar-alignments');
    const click = vi.fn();
    button.click = click;
    document.body.appendChild(button);

    await applyScenarioDev(sequencePackageAttachTwoClones());

    expect(click).toHaveBeenCalledTimes(1);
    button.remove();
  });

  it('keeps the replacement sequence tab drawer open through a later state reset', async () => {
    vi.useFakeTimers();
    try {
      const oldButton = document.createElement('button');
      oldButton.setAttribute('data-testid', 'toolbar-metadata');
      oldButton.setAttribute('data-active', 'false');
      const oldClick = vi.fn();
      oldButton.click = oldClick;
      document.body.appendChild(oldButton);

      clickSequenceDrawerToolbar('metadata');
      expect(oldClick).toHaveBeenCalledTimes(1);

      oldButton.remove();
      const currentButton = document.createElement('button');
      currentButton.setAttribute('data-testid', 'toolbar-metadata');
      currentButton.setAttribute('data-active', 'false');
      const currentClick = vi.fn(() => currentButton.setAttribute('data-active', 'true'));
      currentButton.click = currentClick;
      document.body.appendChild(currentButton);

      await vi.advanceTimersByTimeAsync(50);
      expect(currentClick).toHaveBeenCalledTimes(1);

      currentButton.setAttribute('data-active', 'false');
      await vi.advanceTimersByTimeAsync(50);
      expect(currentClick).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(currentClick).toHaveBeenCalledTimes(2);
      currentButton.remove();
    } finally {
      cancelSequenceDrawerToolbarRetry();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['cancel', 'user-close'] as const)(
    'stops a mounted toolbar retry after %s',
    async (stop) => {
      vi.useFakeTimers();
      const button = document.createElement('button');
      button.setAttribute('data-testid', 'toolbar-metadata');
      button.setAttribute('data-active', 'true');
      const click = vi.fn();
      button.click = click;
      document.body.appendChild(button);
      try {
        clickSequenceDrawerToolbar('metadata');
        if (stop === 'cancel') cancelSequenceDrawerToolbarRetry();
        else button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        button.setAttribute('data-active', 'false');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(click).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        cancelSequenceDrawerToolbarRetry();
        button.remove();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }
  );

  it.each(['pointerdown', 'keydown'])(
    'keeps the drawer closed after a user %s during scenario materialization',
    async (eventType) => {
      vi.useFakeTimers();
      const button = document.createElement('button');
      button.setAttribute('data-testid', 'toolbar-metadata');
      button.setAttribute('data-active', 'false');
      const click = vi.fn(() => button.setAttribute('data-active', 'true'));
      button.click = click;
      document.body.appendChild(button);
      try {
        clickSequenceDrawerToolbar('metadata');
        expect(click).toHaveBeenCalledTimes(1);

        document.dispatchEvent(new Event(eventType, { bubbles: true }));
        button.setAttribute('data-active', 'false');
        await vi.advanceTimersByTimeAsync(2_500);

        expect(button.getAttribute('data-active')).toBe('false');
        expect(click).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        cancelSequenceDrawerToolbarRetry();
        button.remove();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }
  );

  it('stops toolbar retries when the document disappears before the button mounts', () => {
    vi.useFakeTimers();
    try {
      clickSequenceDrawerToolbar('alignments');
      expect(vi.getTimerCount()).toBe(1);

      vi.stubGlobal('document', undefined);

      expect(() => vi.advanceTimersByTime(50)).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels an older retry before a later toolbar attempt can double-click', () => {
    vi.useFakeTimers();
    const button = document.createElement('button');
    button.setAttribute('data-testid', 'toolbar-alignments');
    const click = vi.fn();
    button.click = click;
    try {
      clickSequenceDrawerToolbar('alignments');
      expect(vi.getTimerCount()).toBe(1);

      document.body.appendChild(button);
      clickSequenceDrawerToolbar('alignments');
      vi.advanceTimersByTime(2_000);

      expect(click).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      button.remove();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not run the real attach path in browser/mock mode', async () => {
    const createSession = vi.fn(() => 'session-1');
    const runSessionAlignments = vi.fn(async () => undefined);
    useVerificationStore.setState({ createSession, runSessionAlignments } as never);

    await applyScenarioDev(sequencePackageAttachTwoClones());

    expect(createSession).not.toHaveBeenCalled();
    expect(runSessionAlignments).not.toHaveBeenCalled();
  });

  it('materializes the  inbox FASTAs then runs the real attach path', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    const createSession = vi.fn(() => 'session-1');
    const runSessionAlignments = vi.fn(async () => undefined);
    useVerificationStore.setState({ createSession, runSessionAlignments } as never);

    const scenario = sequencePackageAttachTwoClones();
    const packageId = scenario.canvas?.tabs[0]?.entityId;
    await applyScenarioDev(scenario);

    const workspaceRoot = useWorkspaceStore.getState().folders[0]?.path;
    expect(workspaceRoot).toContain('/managed-workspaces/sequence-package-attach/repo');
    const productPath = `${workspaceRoot}/sequences/pUC19/pUC19.gb`;
    expect(useWorkspaceStore.getState().selectedPath).toBe(productPath);
    expect(useCanvasStore.getState().panels.main.tabs[0]?.entityId).toBe(packageId);
    expect(platformMock.writeTextFile).toHaveBeenCalledWith(
      `${workspaceRoot}/sequences/pUC19/.forge/plasmid.json`,
      expect.stringMatching(/"members": \[\]/)
    );
    expect(platformMock.importSequenceFromContent).not.toHaveBeenCalled();
    expect(platformMock.writeTextFile).toHaveBeenCalledWith(
      `${workspaceRoot}/drop-inbox/clone-a/clone-1.fasta`,
      expect.stringContaining('>clone-1')
    );
    expect(platformMock.writeTextFile).toHaveBeenCalledWith(
      `${workspaceRoot}/drop-inbox/clone-b/clone-1.fasta`,
      expect.stringContaining('>clone-1-collision')
    );
    expect(createSession).toHaveBeenCalledWith(packageId, {
      name: ' attached clones',
      mode: 'one-per-clone',
      queryPaths: [
        `${workspaceRoot}/drop-inbox/clone-a/clone-1.fasta`,
        `${workspaceRoot}/drop-inbox/clone-b/clone-1.fasta`,
      ],
    });
    expect(runSessionAlignments).toHaveBeenCalledWith(packageId, 'session-1', [
      `${workspaceRoot}/drop-inbox/clone-a/clone-1.fasta`,
      `${workspaceRoot}/drop-inbox/clone-b/clone-1.fasta`,
    ]);
    expect(takeRequestedSequenceDrawer()).toBe('alignments');
  });

  it('keeps the baseline and scenario content pending until native Markdown adoption settles', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    platformMock.adoptMarkdown.mockImplementationOnce(async ({ workspaceRoot, path }) => {
      await held;
      return {
        workspaceRoot,
        sourcePath: path,
        path: path.replace(/\.md$/, ''),
        pageId: 'guide',
        title: 'Proof',
      };
    });
    const priorCanvas = useCanvasStore.getState();
    const pending = applyScenarioDev(primerFileAuthorityWorkspace());
    try {
      await vi.waitFor(() => expect(platformMock.adoptMarkdown).toHaveBeenCalledOnce());
      expect(platformMock.shellExecute.mock.calls.some(([, args]) => args[0] === 'commit')).toBe(
        false
      );
      expect(useCanvasStore.getState()).toBe(priorCanvas);
    } finally {
      release();
    }
    await pending;
    expect(platformMock.adoptMarkdown).toHaveBeenCalledTimes(2);
    expect(runWorkspaceReconcileOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogSource: 'working-tree',
        healManagedHead: false,
        strict: true,
      })
    );
    const commit = platformMock.shellExecute.mock.calls.findIndex(
      ([, args]) => args[0] === 'commit'
    );
    expect(runWorkspaceReconcileOperationMock.mock.invocationCallOrder[0]).toBeLessThan(
      platformMock.shellExecute.mock.invocationCallOrder[commit]
    );
    expect(useCanvasStore.getState().panels.main.tabs[0].type).toBe('sequence');
  });

  it.each(['adoption', 'reconcile', 'git-status', 'selection-only'] as const)(
    'lets later navigation win during deferred baseline %s',
    async (stage) => {
      vi.mocked(isDesktopRuntime).mockReturnValue(true);
      allowElectronScenarioMutation();
      useWorkspaceStore.setState({
        folders: [
          { path: '/existing/workspace', name: 'Existing', addedAt: 1, mountRequest: 10000 },
        ],
        selectedPath: '/existing/workspace/original.gb',
        expandedPaths: new Set(['/existing/workspace', '/existing/workspace/keep']),
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (stage === 'adoption' || stage === 'selection-only')
        platformMock.adoptMarkdown.mockImplementationOnce(async ({ workspaceRoot, path }) => {
          await held;
          return {
            workspaceRoot,
            sourcePath: path,
            path: path.replace(/\.md$/, ''),
            pageId: 'guide',
            title: 'Proof',
          };
        });
      else if (stage === 'reconcile')
        runWorkspaceReconcileOperationMock.mockImplementationOnce(async () => {
          await held;
        });
      else {
        const execute = platformMock.shellExecute.getMockImplementation();
        if (!execute) throw new Error('The baseline Git owner mock is unavailable.');
        platformMock.shellExecute.mockImplementation(async (program, args, root) => {
          const result = await execute(program, args, root);
          if (args[0] === 'status') await held;
          return result;
        });
      }
      const priorCanvas = useCanvasStore.getState();
      const pending = applyScenarioDev(primerFileAuthorityWorkspace());
      const rejected = expect(pending).rejects.toThrow('DevPanel Markdown baseline was superseded');
      try {
        await vi.waitFor(() => {
          if (stage === 'git-status')
            expect(
              platformMock.shellExecute.mock.calls.some(([, args]) => args[0] === 'status')
            ).toBe(true);
          else
            expect(
              stage === 'adoption' || stage === 'selection-only'
                ? platformMock.adoptMarkdown
                : runWorkspaceReconcileOperationMock
            ).toHaveBeenCalled();
        });
        const temporary = useWorkspaceStore
          .getState()
          .folders.find((folder) => folder.path !== '/existing/workspace');
        expect(temporary?.mountRequest).toBeDefined();
        const laterRoot = stage === 'selection-only' ? '/existing/workspace' : '/later/project';
        if (stage !== 'selection-only') useWorkspaceStore.getState().addFolder(laterRoot, 'Later');
        useWorkspaceStore.getState().expandPath(`${laterRoot}/keep`);
        useWorkspaceStore.getState().revealPath(`${laterRoot}/latest.gb`);
        release();
        await rejected;
        expect(platformMock.shellExecute.mock.calls.some(([, args]) => args[0] === 'commit')).toBe(
          false
        );
        expect(useCanvasStore.getState()).toBe(priorCanvas);
        expect(useWorkspaceStore.getState().folders.map((folder) => folder.path)).toEqual(
          stage === 'selection-only'
            ? ['/existing/workspace']
            : ['/existing/workspace', '/later/project']
        );
        expect(useWorkspaceStore.getState().selectedPath).toBe(`${laterRoot}/latest.gb`);
        expect([...useWorkspaceStore.getState().expandedPaths]).toEqual(
          expect.arrayContaining(['/existing/workspace/keep', `${laterRoot}/keep`])
        );
        expect(useWorkspaceStore.getState().folders).not.toContainEqual(
          expect.objectContaining({ path: temporary?.path })
        );
      } finally {
        release();
      }
    }
  );

  it('retains a newer loader mount of the same root after deferred Markdown adoption', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    platformMock.adoptMarkdown.mockImplementationOnce(async ({ workspaceRoot, path }) => {
      await held;
      return {
        workspaceRoot,
        sourcePath: path,
        path: path.replace(/\.md$/, ''),
        pageId: 'guide',
        title: 'Proof',
      };
    });
    const priorCanvas = useCanvasStore.getState();
    const pending = applyScenarioDev(primerFileAuthorityWorkspace());
    const rejected = expect(pending).rejects.toThrow('DevPanel Markdown baseline was superseded');
    try {
      await vi.waitFor(() => expect(platformMock.adoptMarkdown).toHaveBeenCalledOnce());
      const mounted = useWorkspaceStore
        .getState()
        .folders.find((folder) =>
          folder.path.includes('/managed-workspaces/Primer development/repo')
        );
      if (!mounted) throw new Error('The temporary source mount is unavailable.');
      await projectFixtureWorkspace({
        kind: 'local-folder',
        path: mounted.path,
        name: 'User reopened',
      });
      useWorkspaceStore.getState().revealPath(`${mounted.path}/later.gb`);
      const replacement = useWorkspaceStore
        .getState()
        .folders.find((folder) => folder.path === mounted.path);
      expect(replacement?.mountRequest).not.toBe(mounted.mountRequest);
      release();
      await rejected;
      expect(useWorkspaceStore.getState().folders).toContainEqual(replacement);
      expect(useWorkspaceStore.getState().selectedPath).toBe(`${mounted.path}/later.gb`);
      expect(useCanvasStore.getState()).toBe(priorCanvas);
      expect(platformMock.shellExecute.mock.calls.some(([, args]) => args[0] === 'commit')).toBe(
        false
      );
    } finally {
      release();
    }
  });

  it('does not adopt or commit after the loader reports a superseded source mount', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    const folders = [{ path: '/later/project', name: 'Later', addedAt: 1, mountRequest: 50000 }];
    useWorkspaceStore.setState({
      folders,
      selectedPath: '/later/project/current.gb',
      expandedPaths: new Set(['/later/project', '/later/project/keep']),
    });
    openWorkspaceFromSourceMock.mockImplementationOnce(async (source) => ({
      superseded: true,
      instance: {
        id: `local:${source.path}`,
        displayName: source.name,
        rootFolders: [{ path: source.path, name: source.name }],
        source,
        writable: true,
        createdAt: 1,
      },
    }));
    const priorCanvas = useCanvasStore.getState();
    await expect(applyScenarioDev(primerFileAuthorityWorkspace())).rejects.toThrow(
      'DevPanel Markdown baseline was superseded'
    );
    expect(platformMock.adoptMarkdown).not.toHaveBeenCalled();
    expect(platformMock.shellExecute.mock.calls.some(([, args]) => args[0] === 'commit')).toBe(
      false
    );
    expect(useWorkspaceStore.getState().folders).toEqual(folders);
    expect(useWorkspaceStore.getState().selectedPath).toBe('/later/project/current.gb');
    expect([...useWorkspaceStore.getState().expandedPaths]).toEqual([
      '/later/project',
      '/later/project/keep',
    ]);
    expect(useCanvasStore.getState()).toBe(priorCanvas);
  });

  it('accepts a clean baseline when native sequence import has already committed it', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    platformMock.shellExecute.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    await applyScenarioDev(primerFileAuthorityWorkspace());
    expect(platformMock.shellExecute).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain'],
      expect.any(String)
    );
    expect(platformMock.shellExecute.mock.calls.some(([, args]) => args[0] === 'commit')).toBe(
      false
    );
    expect(useCanvasStore.getState().panels.main.tabs[0].type).toBe('sequence');
  });

  it('rejects a Git-backed scenario before hydrating stores when the baseline commit fails', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    useWorkspaceStore.setState({
      folders: [{ path: '/existing/workspace', name: 'existing-workspace', addedAt: 1 }],
      selectedPath: '/existing/workspace/existing.gb',
    });
    platformMock.shellExecute.mockImplementation(async (_program: string, args: string[]) =>
      args[0] === 'commit'
        ? { stdout: '', stderr: 'baseline commit failed', code: 1 }
        : { stdout: args[0] === 'status' ? 'A  PROOF.md\n' : '', stderr: '', code: 0 }
    );

    await expect(applyScenarioDev(primerFileAuthorityWorkspace())).rejects.toThrow(
      'Could not commit DevPanel project fixtures: git commit: baseline commit failed'
    );

    expect(useWorkspaceStore.getState().folders).toEqual([
      { path: '/existing/workspace', name: 'existing-workspace', addedAt: 1 },
    ]);
    expect(useWorkspaceStore.getState().selectedPath).toBe('/existing/workspace/existing.gb');
  });

  it('rejects binary scenario files in Electron until the bridge supports binary writes', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();

    await expect(
      applyScenarioDev({
        files: {
          '/mock/test/workspace/read.ab1': new Uint8Array([0, 1, 2, 3]),
        },
      })
    ).rejects.toThrow(/only supports text files.*read\.ab1/);

    expect(platformMock.writeTextFile).not.toHaveBeenCalled();
  });

  it('should handle freshSession (no canvas, no sequences, no workspace)', async () => {
    const scenario = freshSession();
    await applyScenarioDev(scenario);

    const state = _getDevOverrideState();
    expect(state.data).toEqual(scenario.sidecar);

    const canvasState = useCanvasStore.getState();
    expect(canvasState.panels['main'].tabs).toHaveLength(0);
  });

  it('should handle downloadingSession', async () => {
    const scenario = downloadingSession();
    await applyScenarioDev(scenario);

    const state = _getDevOverrideState();
    const caps = state.data?.capabilities ?? [];
    expect(caps.some((c) => c.status === 'downloading')).toBe(true);
  });

  it('should handle errorSession', async () => {
    const scenario = errorSession();
    await applyScenarioDev(scenario);

    const state = _getDevOverrideState();
    const caps = state.data?.capabilities ?? [];
    expect(caps.some((c) => c.status === 'error')).toBe(true);
  });
});

describe('resetToLiveState', () => {
  it('blocks resetToLiveState in the primary Electron profile', () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    setElectronRuntimeProfile({
      kind: 'primary',
      isE2e: false,
      scenarioMutationAllowed: false,
      scenarioMutationReason: 'primary dev profile',
    });
    useChatStore.setState({
      currentConversationId: 'live-conversation',
      messages: [
        {
          id: 'live-message',
          role: 'assistant',
          content: 'Do not clear me',
          createdAt: 1,
        },
      ],
    });

    expect(() => resetToLiveState()).toThrow(
      /Dev scenario mutation is blocked in this Electron profile/
    );
    expect(useChatStore.getState().currentConversationId).toBe('live-conversation');
    expect(useChatStore.getState().messages[0]?.content).toBe('Do not clear me');
  });

  it('forgets a persisted replay target even when primary Electron blocks store mutation', () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    setElectronRuntimeProfile({
      kind: 'primary',
      isE2e: false,
      scenarioMutationAllowed: false,
      scenarioMutationReason: 'primary dev profile',
    });
    window.localStorage.setItem(
      LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        presetId: 'agent-trace-cli',
        appliedAt: 1,
      })
    );
    useChatStore.setState({
      currentConversationId: 'live-conversation',
      messages: [
        {
          id: 'live-message',
          role: 'assistant',
          content: 'Do not clear me',
          createdAt: 1,
        },
      ],
    });

    expect(() => resetToLiveState()).toThrow(
      /Dev scenario mutation is blocked in this Electron profile/
    );

    expect(window.localStorage.getItem(LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY)).toBeNull();
    expect(getLastAppliedDevScenarioPresetId()).toBeNull();
    expect(useChatStore.getState().currentConversationId).toBe('live-conversation');
    expect(useChatStore.getState().messages[0]?.content).toBe('Do not clear me');
  });

  it('should clear dev override and reset stores', async () => {
    await applyScenarioDev(typicalSession());

    expect(_getDevOverrideState().isOverridden).toBe(true);
    expect(useCanvasStore.getState().panels['main']?.tabs.length).toBeGreaterThan(0);
    const documentId = Object.keys(useSequenceStore.getState().sequences)[0];
    useSequenceStore.getState().dispatchEdit(documentId, { type: 'INSERT', text: 'A' });

    resetToLiveState();

    expect(_getDevOverrideState().isOverridden).toBe(false);

    const canvasState = useCanvasStore.getState();
    expect(canvasState.panels['main'].tabs).toHaveLength(0);

    const wsState = useWorkspaceStore.getState();
    expect(wsState.folders).toHaveLength(0);

    const seqState = useSequenceStore.getState();
    expect(Object.keys(seqState.sequences)).toHaveLength(0);
    expect(seqState.drafts).toEqual({});
    expect(seqState.savedSequences).toEqual({});
    expect(seqState.sequenceVersions).toEqual({});
    expect(seqState.savedVersions).toEqual({});
    expect(seqState.dirtyPaths).toEqual({});
    expect(useVerificationStore.getState().verificationState).toEqual({});
  });
});

describe('registered DevPanel scenario replay', () => {
  it('rebuilds inline references after passive workspace roots settle', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    let frame = 0;
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        frame += 1;
        if (frame === 1) {
          const workspace = useWorkspaceStore.getState();
          useWorkspaceStore.setState({
            folders: [
              ...workspace.folders,
              {
                name: 'Passive Workspace',
                path: '/workspace/passive-root',
                addedAt: frame,
              },
            ],
          });
        }
        callback(frame);
        return frame;
      });

    try {
      await applyDevScenarioPreset('inline-entity-chips');

      const block = useChatStore.getState().streamingBlocks[0];
      expect(block?.type).toBe('text');
      if (block?.type !== 'text') throw new Error('Expected the inline reference text block.');
      const reference = block.document?.parts.find(
        (part) => part.state.status === 'resolved' && part.state.reference
      );
      expect(reference?.state).toMatchObject({
        status: 'resolved',
        reference: {
          workspace_scope: workspaceScopeFromState(useWorkspaceStore.getState()),
        },
      });
      expect(rebindAgentBridgeMock).toHaveBeenCalledTimes(1);
    } finally {
      animationFrame.mockRestore();
    }
  });

  it('fails loudly instead of rebinding MCP to a workspace scope that never settles', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    allowElectronScenarioMutation();
    let frame = 0;
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        frame += 1;
        useWorkspaceStore.setState({
          folders: [
            {
              name: `workspace-${frame % 2}`,
              path: `/workspace-${frame % 2}`,
              addedAt: frame,
            },
          ],
          activeWorkspaceFile: null,
        });
        callback(frame);
        return frame;
      });

    await expect(rebindScenarioWorkspaceAfterRendererSettles()).rejects.toThrow(
      'DevPanel workspace scope did not settle before MCP bridge rebinding.'
    );
    expect(animationFrame).toHaveBeenCalledTimes(12);
    animationFrame.mockRestore();
  });

  it('refuses the dev-only bridge reinstall without a scenario mutation lease', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    setElectronRuntimeProfile({ scenarioMutationAllowed: false });

    await expect(rebindScenarioWorkspaceAfterRendererSettles()).rejects.toThrow(
      'Dev scenario mutation is blocked in this Electron profile.'
    );
    expect(rebindAgentBridgeMock).not.toHaveBeenCalled();
  });

  it('fails loudly instead of applying lane state when a prepared reference cannot open', async () => {
    await applyDevScenarioPreset('agent-trace-cli');
    expect(getActiveDevScenarioPresetId()).toBe('agent-trace-cli');
    expect(getLastAppliedDevScenarioPresetId()).toBe('agent-trace-cli');
    openAssemblyMock.mockResolvedValueOnce(null);

    await expect(applyDevScenarioPreset('assembly-grch38-ucsc-tracks')).rejects.toThrow(
      'Dev preset assembly-grch38-ucsc-tracks could not open prepared reference assembly'
    );
    expect(getActiveDevScenarioPresetId()).toBeNull();
    expect(getLastAppliedDevScenarioPresetId()).toBeNull();
  });

  it('opens a reference-backed preset with the admitted local publication entry', async () => {
    const preparedEntry = {
      id: 'grch38',
      name: 'GRCh38 prepared fixture',
      organism: 'Homo sapiens',
      assembly: 'GRCh38.p14',
      description: 'Prepared fixture with the publication-owned source filenames.',
      assetCacheKey: 'grch38',
      members: [
        {
          chrom: 'chr1',
          lengthBp: 248_956_422,
          manifest: {
            fastaPath: 'prepared/chr1/chr1.fa',
            faiPath: 'prepared/chr1/chr1.fa.fai',
            gffPath: 'prepared/chr1/chr1.gff3.gz',
            tbiPath: 'prepared/chr1/chr1.gff3.gz.tbi',
          },
        },
      ],
    };
    platformMock.listLocalReferences.mockResolvedValueOnce([preparedEntry]);
    openAssemblyMock.mockImplementationOnce(async () => {
      useCanvasStore.setState({
        focusedPanelId: 'main',
        panels: {
          main: {
            id: 'main',
            activeTabId: 'test-assembly-tab',
            tabs: [
              {
                id: 'test-assembly-tab',
                type: 'sequence',
                entityId: 'assembly:grch38',
                label: 'GRCh38',
              },
            ],
          },
        },
      });
      return 'test-assembly-tab';
    });

    await applyDevScenarioPreset('assembly-grch38-local-hg002-80x');

    expect(openAssemblyMock).toHaveBeenCalledWith(preparedEntry);
  });

  it('opens the exact local custom MG1655 import for the indexed reference preset', async () => {
    const preparedEntry = {
      id: 'local-mg1655-import',
      name: 'GCF_000005845.2_ASM584v2_genomic',
      organism: 'Escherichia coli K-12 MG1655',
      assembly: 'GCF_000005845.2',
      description: 'Prepared local NCBI package import.',
      assetCacheKey: 'local-mg1655-import',
      members: [{ chrom: 'NC_000913.3', lengthBp: 4_641_652 }],
    };
    platformMock.listLocalReferences.mockResolvedValueOnce([preparedEntry]);
    platformMock.retryLocalReference.mockResolvedValueOnce({
      status: 'ready',
      entry: preparedEntry,
    });

    await applyDevScenarioPreset('indexed-mg1655-reference');

    expect(platformMock.listHostedReferences).not.toHaveBeenCalled();
    expect(platformMock.installHostedReference).not.toHaveBeenCalled();
    expect(platformMock.retryLocalReference).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^dev-scenario-indexed-mg1655-reference-/),
      assemblyId: preparedEntry.id,
      themeMode: 'light',
    });
    expect(openAssemblyMock).toHaveBeenCalledWith(preparedEntry);
    expect(getActiveDevScenarioPresetId()).toBe('indexed-mg1655-reference');
  });

  it('installs the exact hosted MG1655 source when the local custom import is absent', async () => {
    const preparedEntry = {
      id: 'ecoliK12Mg1655',
      name: 'E. coli K-12 MG1655',
      organism: 'Escherichia coli K-12 MG1655',
      assembly: 'GCF_000005845.2',
      description: 'Prepared hosted reference.',
      assetCacheKey: 'hosted-mg1655',
      members: [{ chrom: 'NC_000913.3', lengthBp: 4_641_652 }],
    };
    platformMock.listHostedReferences.mockResolvedValueOnce([
      { id: 'ecoliK12Mg1655', assembly: 'GCF_000005845.2' } as any,
    ]);
    platformMock.installHostedReference.mockResolvedValueOnce({
      status: 'view-ready',
      entry: preparedEntry,
    });

    await applyDevScenarioPreset('mg1655-indexed');

    expect(platformMock.installHostedReference).toHaveBeenCalledWith({
      catalogId: 'ecoliK12Mg1655',
      themeMode: 'light',
      intent: 'open-view',
    });
    expect(openAssemblyMock).toHaveBeenCalledWith(preparedEntry);
  });

  it('rejects a wrong-build entry before the indexed MG1655 viewer opens', async () => {
    platformMock.listLocalReferences.mockResolvedValueOnce([
      {
        id: 'local-wrong-build',
        name: 'Wrong MG1655 build',
        organism: 'Escherichia coli',
        assembly: 'GCF_000005845.2',
        description: 'Wrong coordinate space.',
        assetCacheKey: 'wrong-build',
        members: [{ chrom: 'NC_000913.3', lengthBp: 1_000 }],
      },
    ]);

    await expect(applyDevScenarioPreset('indexed-mg1655-reference')).rejects.toThrow(
      'expected GCF_000005845.2 (4641652 bp), got GCF_000005845.2 (1000 bp)'
    );
    expect(openAssemblyMock).not.toHaveBeenCalled();
  });

  it('builds the Figure 4N showcase without installing the full hosted reference', async () => {
    openAssemblyMock.mockImplementationOnce(async () =>
      useCanvasStore.getState().openTab('main', {
        type: 'sequence',
        entityId: 'assembly:danRer11',
        sequenceDocument: {
          kind: 'indexed-sequence',
          documentId: 'assembly:danRer11',
        },
        label: 'GRCz11 (zebrafish)',
        indexedGenome: {
          sourcePath: 'prepared/chr1.fa',
          sourceExt: '.fa',
          chrom: 'chr1',
          assembly: {
            assemblyId: 'danRer11',
            displayName: 'GRCz11 (zebrafish)',
            chromosomes: [
              {
                chrom: 'chr1',
                displayName: 'chr1',
                length: 1_000,
                manifest: { chrom: 'chr1', fastaPath: 'chr1.fa', faiPath: 'chr1.fa.fai' },
              },
            ],
          },
        },
      })
    );

    composeIndexedTrackViewMock.mockImplementationOnce(async (input: any) => {
      const state = useCanvasStore.getState();
      const source = Object.values(state.panels)
        .flatMap((panel) => panel.tabs)
        .find((tab) => tab.indexedGenome);
      if (!source?.indexedGenome) throw new Error('Expected the metadata reference shell.');
      const tabId = state.openTab('main', {
        ...source,
        entityId: 'track-view-draft-test',
        sequenceDocument: {
          kind: 'indexed-sequence',
          documentId: 'track-view-draft-test',
        },
        label: input.name,
        indexedGenome: {
          ...source.indexedGenome,
          scope: {
            kind: 'locus',
            chrom: input.viewport.chrom,
            start: input.viewport.start0,
            end: input.viewport.end0,
          },
          dataTracks: [],
          bamTracks: [],
        },
      });
      return {
        ok: true as const,
        tabId,
        assemblyId: 'danRer11',
        name: input.name,
        unsaved: true as const,
        tracks: [],
      };
    });

    await applyDevScenarioPreset('pownall-2023-figure-4n-klf17');

    expect(platformMock.installHostedReference).not.toHaveBeenCalled();
    expect(openAssemblyMock).not.toHaveBeenCalled();
    expect(composeIndexedTrackViewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Pownall 2023 — Figure 4N recreation',
        preserveCurrentTracks: false,
        viewport: { chrom: 'chr2', start0: 33_322_000, end0: 33_332_000 },
      }),
      expect.objectContaining({ admit: expect.any(Function) })
    );
    const admissionOverride = composeIndexedTrackViewMock.mock.calls[0]?.[1]?.admit;
    const showcaseAdmissionRequest = {
      contract: TRACK_ADMISSION_REQUEST_V1,
      assemblyId: 'danRer11',
      source: {
        kind: 'http' as const,
        url: 'https://track.giraldezlab.org/miao_et_al_2022_molecular_cell_ChIP-seq/danRer11/AGS001841.bw',
      },
      label: 'Pan-Pol II — WT 4 hpf',
      ingress: { kind: 'automation' as const },
    };
    expect(admissionOverride).toBeTypeOf('function');
    if (!admissionOverride) throw new Error('Expected the preset admission override.');
    await admissionOverride({
      request: showcaseAdmissionRequest,
      assemblyId: 'danRer11',
      assemblyReferences: [{ name: 'chr2', length: 59_640_629 }],
    });
    expect(admitIndexedBigWigRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          source: {
            kind: 'local-file',
            path: '/profile/Track assets/verified/AGS001841.bw',
          },
        }),
      })
    );
    platformMock.stat.mockResolvedValueOnce({
      canonicalPath: '/repo/test-fixtures/indexed/danRer11/pownall-figure-4n/AGS001841.bw',
      size: 2_630,
      isFile: true,
      isDirectory: false,
      mtime: 0,
      ctime: 0,
      mtimeNs: '0',
      ctimeNs: '0',
    });
    await expect(
      admissionOverride({
        request: showcaseAdmissionRequest,
        assemblyId: 'danRer11',
        assemblyReferences: [{ name: 'chr2', length: 59_640_629 }],
      })
    ).rejects.toThrow('requires the complete 237968484-byte BigWig');
    expect(admitIndexedBigWigRequestMock).toHaveBeenCalledTimes(1);
    expect(getActiveDevScenarioPresetId()).toBe('pownall-2023-figure-4n-klf17');
    expect(getLastAppliedDevScenarioPresetId()).toBeNull();
    const expectedAnnotationTrackIds = [
      'mRNA',
      'ncRNA',
      'miRNA',
      'snoRNA',
      'snRNA',
      'tRNA',
      'rRNA',
      'pseudogene',
      'origin_of_replication',
      'antisense_RNA',
      'C_gene_segment',
      'cDNA_match',
      'D_loop',
      'genomic DNA',
      'lnc_RNA',
      'match',
      'primary_transcript',
      'RNase_P_RNA',
      'transcript',
      'V_gene_segment',
    ];
    expect(saveTrackViewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: null,
        document: expect.objectContaining({
          id: 'track-view-pownall-2023-figure-4n',
          kind: 'track-view',
          annotation: expect.objectContaining({
            policy: { isoformMode: 'canonical', laneLimit: 2 },
            orderedTrackIds: expectedAnnotationTrackIds,
            visibilityByTrackId: Object.fromEntries(
              expectedAnnotationTrackIds.map((trackId) => [trackId, false])
            ),
          }),
          dataTracks: [],
        }),
      })
    );
    const savedTab = Object.values(useCanvasStore.getState().panels)
      .flatMap((panel) => panel.tabs)
      .find((tab) => tab.entityId === 'track-view-pownall-2023-figure-4n');
    expect(savedTab).toMatchObject({
      label: 'Pownall 2023 — Figure 4N recreation',
      isDirty: false,
      trackView: {
        document: { id: 'track-view-pownall-2023-figure-4n' },
      },
      viewState: {
        indexedViewportCommand: null,
      },
    });
    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('GRCz11') }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('four complete quantitative signal tracks'),
      }),
    ]);
  });

  it('applies a registered preset, persists its id, and replays the same preset after stores reset', async () => {
    await applyDevScenarioPreset('agent-trace-cli');

    expect(getLastAppliedDevScenarioPresetId()).toBe('agent-trace-cli');
    expect(_getDevOverrideState().isOverridden).toBe(true);
    expect(useChatStore.getState().messages[0]?.content).toContain('Agent Trace CLI Test Kit');
    expect(useWorkspaceStore.getState().folders[0]?.path).toBe('/workspace/agent-trace-cli');

    _resetToolboxState();
    useCanvasStore.getState().reset();
    useWorkspaceStore.setState({
      folders: [],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
    useChatStore.setState({
      messages: [],
      conversations: [],
      streamingBlocks: [],
      currentConversationId: null,
      isLoading: false,
      isStreaming: false,
      error: null,
    });

    const replay = await replayLastAppliedDevScenario();

    expect(replay).toEqual({
      status: 'applied',
      presetId: 'agent-trace-cli',
      label: 'agentTraceCliSession',
    });
    expect(_getDevOverrideState().isOverridden).toBe(true);
    expect(useChatStore.getState().messages[0]?.content).toContain('Agent Trace CLI Test Kit');
    expect(useWorkspaceStore.getState().folders[0]?.path).toBe('/workspace/agent-trace-cli');
  });

  it('a noAutoReplay preset (assembly-demo) is applied but never re-applied on reload', async () => {
    await applyDevScenarioPreset('assembly-demo');

    expect(getLastAppliedDevScenarioPresetId()).toBeNull();
    const replay = await replayLastAppliedDevScenario();
    expect(replay).toEqual({ status: 'empty' });
  });

  it('skips + clears a STALE noAutoReplay marker on replay instead of re-applying it ', async () => {
    window.localStorage.setItem(
      LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY,
      JSON.stringify({ version: 1, presetId: 'assembly-demo', appliedAt: 1 })
    );

    const replay = await replayLastAppliedDevScenario();
    expect(replay).toEqual({ status: 'skipped-no-auto-replay', presetId: 'assembly-demo' });
    expect(getLastAppliedDevScenarioPresetId()).toBeNull();
    expect(window.localStorage.getItem(LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY)).toBeNull();
  });

  it('a normal preset still records its marker and replays', async () => {
    await applyDevScenarioPreset('agent-trace-cli');
    expect(getLastAppliedDevScenarioPresetId()).toBe('agent-trace-cli');

    const replay = await replayLastAppliedDevScenario();
    expect(replay).toMatchObject({ status: 'applied', presetId: 'agent-trace-cli' });
  });

  it('canonicalizes a persisted preset alias before applying replay', async () => {
    window.localStorage.setItem(
      LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        presetId: 'agent-trace-cli-session',
        appliedAt: 1,
      })
    );

    expect(getLastAppliedDevScenarioPresetId()).toBe('agent-trace-cli');

    const replay = await replayLastAppliedDevScenario();

    expect(replay).toMatchObject({ status: 'applied', presetId: 'agent-trace-cli' });
    expect(useChatStore.getState().messages[0]?.content).toContain('Agent Trace CLI Test Kit');
  });

  it('clears unknown persisted preset ids instead of replaying stale state', async () => {
    window.localStorage.setItem(
      LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        presetId: 'deleted-dev-preset',
        appliedAt: 1,
      })
    );

    await expect(replayLastAppliedDevScenario()).resolves.toEqual({
      status: 'missing',
      presetId: 'deleted-dev-preset',
    });
    expect(getLastAppliedDevScenarioPresetId()).toBeNull();
    expect(window.localStorage.getItem(LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY)).toBeNull();
  });

  it('clears the persisted replay target when resetting to live state', async () => {
    await applyDevScenarioPreset('typical');
    expect(getLastAppliedDevScenarioPresetId()).toBe('typical');

    resetToLiveState();

    expect(getLastAppliedDevScenarioPresetId()).toBeNull();
    expect(window.localStorage.getItem(LAST_APPLIED_DEV_SCENARIO_STORAGE_KEY)).toBeNull();
  });

  it('applies the LIMS primer CSV dev scenario as registered oligo entities without inventing primer use; replay re-applies idempotently', async () => {
    await applyDevScenarioPreset(LIMS_PRIMER_CSV_IMPORT_SCENARIO_ID);

    expect(getLastAppliedDevScenarioPresetId()).toBe(LIMS_PRIMER_CSV_IMPORT_SCENARIO_ID);
    expect(platformMock.applyImportBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: LIMS_PRIMER_CSV_IMPORT_BATCH_ID,
        sourceName: 'primers-alt-headers.csv',
        sourceKind: 'csv',
        actor: 'dev-scenario',
      }),
      undefined
    );
    expect(platformMock.limsEntities.map((entity) => entity.name)).toEqual([
      'OL001',
      'OL002',
      'OL003',
      'OL004',
      'OL005',
      'OL006',
      'OL007',
      'OL008',
    ]);
    expect(platformMock.limsEntities[0].fields.sequence).toMatchObject({
      mode: 'inline',
      bases: 'ATGCGATCGATCGATCG',
      length: 17,
    });
    expect(platformMock.limsEntities[0].fields.use).toBeUndefined();
    expect(LIMS_PRIMER_CSV_FIXTURE_TEXT).toContain('OL008,GCGGCCGCGGCCGCGGCC');

    await applyDevScenarioPreset('primer-csv-import');

    expect(platformMock.limsEntities).toHaveLength(8);
    expect(platformMock.applyImportBatch).toHaveBeenCalledTimes(2);
  });

  it('allows the LIMS-only primer CSV scenario in a primary Electron profile without resetting stores', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    setElectronRuntimeProfile({
      kind: 'primary',
      isE2e: false,
      scenarioMutationAllowed: false,
      scenarioMutationReason: 'primary dev profile',
    });
    useChatStore.setState({
      currentConversationId: 'live-conversation',
      messages: [
        {
          id: 'live-message',
          role: 'assistant',
          content: 'Do not clear me',
          createdAt: 1,
        },
      ],
    });

    await applyDevScenarioPreset(LIMS_PRIMER_CSV_IMPORT_SCENARIO_ID);

    expect(platformMock.limsEntities).toHaveLength(8);
    expect(useChatStore.getState().currentConversationId).toBe('live-conversation');
    expect(useChatStore.getState().messages[0]?.content).toBe('Do not clear me');
  });

  it('applies the headerless primer TSV LIMS scenario through the importer path', async () => {
    await applyDevScenarioPreset(LIMS_HEADERLESS_PRIMER_TSV_SCENARIO_ID);

    expect(platformMock.applyImportBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        batchId: LIMS_HEADERLESS_PRIMER_TSV_BATCH_ID,
        sourceName: 'primers.tsv',
        sourceKind: 'tsv',
      }),
      undefined
    );
    expect(platformMock.limsEntities.map((entity) => entity.name)).toEqual([
      'M13uni_F',
      'M13uni_R',
    ]);
    expect(platformMock.limsEntities[0].fields.sequence).toMatchObject({
      mode: 'inline',
      bases: 'GTAAAACGACGGCCAGTACGTTGTAAAACG',
    });
    expect(LIMS_HEADERLESS_PRIMER_TSV_FALLBACK_TEXT).toContain('M13uni_R');
  });
});
