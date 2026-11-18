import * as taskPresentation from '../../work/public/work';
import { userMessage } from '@waypoint/user-messages';
import { StrictMode } from 'react';
import { subscribeSettingsEntry } from '../../auth/public/registry-settings';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsPanel } from './LimsPanel';
import { emitLimsRegistryChanged } from '../events';
import type {
  LimsApplyImportBatchInput,
  LimsAttachGenomeHypothesisInput,
  LimsAttachVerifiedGenomeInput,
  LimsQueryEntitiesInput,
  LimsQueryRegistrySummariesInput,
  LimsRegistryPreviewInput,
  LimsRegistryPreview,
  LimsRegistrationBadgeInput,
  LimsTelemetryInput,
  LimsEntityHistoryEntry,
  FileDnaSequenceRef,
  LimsRecordStrainParentGenomeInput,
  LimsRegisterEntityInput,
  LimsUpdateEntityInput,
  LimsUndoImportBatchInput,
} from '../../../shared/lims';
import { compareRegistrySummaries } from '../../../shared/lims-registry';
import type { PlatformBridge } from '../../../platform/index';
import {
  createLimsTestBridge,
  createNativeImportReviewBridgeForDb,
  discoverTestWorkspaceArtifacts,
} from '../../../main/__tests__/lims-bridge-for-db';
import * as nativeSequenceImport from '../../../main/lims-register-import';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useAuthStore } from '../../../stores/auth-store';
import type {
  OrganizationRegistryChangedEvent,
  OrganizationRegistryRecordDetails,
  OrganizationRegistryReadResult,
  OrganizationRegistryView,
} from '../../../shared/org-registry-sync';
import { deliverWorkspaceDisplay } from '../../../services/workspace-display-participants';
import { useLimsImportLaunchStore } from '../lims-import-launch-store';
import { useLimsOverlayStore } from '../lims-overlay-store';
import { subscribeRegistryOpen } from '../../../shared/registry-events';
import type { ResolvedSequenceDocument } from '../../sequence/public/sequence-document-repository';
import type { ImportDoorKind } from './LimsImportWizard';

vi.mock('../../../main/auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

const mocks = vi.hoisted(() => {
  return {
    bridge: null as PlatformBridge['lims'] | null,
    importReview: null as ReturnType<typeof createNativeImportReviewBridgeForDb> | null,
    reviewProfileDirectory: null as string | null,
    database: null as Database.Database | null,
    defaultProjectId: 0,

    queryRegistryOverride: null as
      | null
      | ((input?: LimsQueryRegistrySummariesInput) => Promise<unknown>),
    historyOverride: null as
      | null
      | ((input: { entityId: string }) => Promise<LimsEntityHistoryEntry[]>),
    focusedSequencePath: null as string | null,
    sequenceDocument: null as ResolvedSequenceDocument | null,
    dialogOpen: vi.fn(async () => null as string | string[] | null),
    readTextFile: vi.fn<(path: string) => Promise<string>>(async () => ''),
    readFile: vi.fn(async () => new Uint8Array()),
    readDir: vi.fn(
      async () => [] as Array<{ name: string; isDirectory: boolean; isFile: boolean }>
    ),
    listOrganizations: vi.fn(),
    listCachedOrganizationRegistries: vi.fn(),
    listSyncedProjects: vi.fn(),
    syncOrganizationRegistry: vi.fn(),
    getOrganizationRegistry: vi.fn<() => Promise<OrganizationRegistryReadResult>>(),
    onOrganizationRegistryChanged:
      vi.fn<(listener: (event: OrganizationRegistryChangedEvent) => void) => () => void>(),
    unsubscribeOrganizationRegistry: vi.fn(),
    mutateOrganizationRegistry: vi.fn(),
    prepareOrganizationRegistryClaim: vi.fn(),
    claimOrganizationRegistryEntity: vi.fn(),
    getOrganizationRegistryRecordDetails: vi.fn(),
    trackRendererEvent: vi.fn(),
    recordImportedPrimers: vi.fn(async () => ({
      added: 2,
      skipped: 0,
      failed: 0,
      failures: [],
      artifactRelativePaths: [],
      importSet: null,
      members: [],
      partition: { plan: null, members: [] },
    })),
    recordImportedProteins: vi.fn(async () => ({
      added: 1,
      skipped: 0,
      failed: 0,
      failures: [],
      reconciliationRequired: [],
      artifactRelativePaths: ['proteins/Imported-protein.entity.json'],
      artifactAbsolutePaths: ['/workspace/proteins/Imported-protein.entity.json'],
      gitCommitted: true,
      importSet: null,
      members: [],
      partition: { plan: null, members: [] },
    })),
    persistImportedPrimerImportSet: vi.fn(async () => ({
      importSet: { id: 'import-set-test', manifestRelativePath: '.waypoint/import-sets/test.json' },
      relativePaths: ['.waypoint/import-sets/test.json'],
    })),
    scenarioMutationAllowed: true,
    openLimsEntity: vi.fn(async () => ({
      status: 'opened',
      tabId: 'tab-puc19',
      target: null,
    })),

    mintedWorkspaceDirs: [] as string[],

    createEmptyWorkspace: vi.fn(async ({ name }: { name?: string }) => {
      const container = mkdtempSync(join(tmpdir(), 'managed-workspaces-'));
      const repoPath = join(container, 'repo');
      mkdirSync(repoPath, { recursive: true });
      mocks.mintedWorkspaceDirs.push(container);
      if (!mocks.database) throw new Error('test database is not initialized');
      mocks.database
        .prepare('INSERT INTO workspaces (name,path,created_at) VALUES (?,?,?)')
        .run(name ?? 'My Workspace', repoPath, Date.now());

      return {
        rootPath: repoPath,
        displayName: name ?? 'My Workspace',
        createdAt: Date.now(),
      };
    }),

    importFile: vi.fn(async (req: { targetRoot: string; sourcePath: string }) => ({
      destPath: join(req.targetRoot, 'source-copy'),
      relPath: 'source-copy',
      committed: true,
    })),
    importFileFromContent: vi.fn(async (req: { targetRoot: string; fileName: string }) => ({
      destPath: join(req.targetRoot, req.fileName),
      relPath: req.fileName,
      committed: true,
    })),
    registerImportedSequence: vi.fn(
      async (req: { sourcePath: string; targetRoot: string; kind?: string }) => {
        const managedRelPath = join(req.targetRoot, 'pUC19.gb');
        copyFileSync(req.sourcePath, managedRelPath);
        const applied = await mocks.bridge!.applyImportBatch({
          sourceName: 'pUC19.gb',
          sourceKind: 'genbank',
          records: [
            {
              id: 'sequence-file-1',
              action: 'register_entity',
              accepted: true,
              entity: {
                kind: req.kind ?? 'plasmid',
                name: 'pUC19',
                fields: {
                  sequence: {
                    mode: 'file',
                    relPath: managedRelPath,
                    topology: 'circular',
                    length: 2686,
                    contentHash: `sha256:${'0'.repeat(64)}`,
                    fileContentHash: `sha256:${'0'.repeat(64)}`,
                    normalizedSequenceHash: `sha256:${'0'.repeat(64)}`,
                    sourceFormat: 'gb',
                  },
                },
                registrationStatus: 'registered',
                actor: 'local-user',
              },
              source: { fileName: 'pUC19.gb', recordCount: 1 },
            },
          ],
        });
        return {
          destPath: managedRelPath,
          relPath: 'pUC19.gb',
          committed: true,
          copySkipped: false,
          registered: applied.insertedEntityIds.length > 0,
          batchId: applied.batchId,
          entityIds: applied.insertedEntityIds.map((e) => e.entityId),
        };
      }
    ),

    registerImportedSequenceFromContent: vi.fn(
      async (req: { content: string; fileName: string; targetRoot: string; kind?: string }) => {
        const managedRelPath = join(req.targetRoot, req.fileName);
        writeFileSync(managedRelPath, req.content);
        const applied = await mocks.bridge!.applyImportBatch({
          sourceName: req.fileName,
          sourceKind: 'genbank',
          records: [
            {
              id: 'sequence-file-1',
              action: 'register_entity',
              accepted: true,
              entity: {
                kind: req.kind ?? 'plasmid',
                name: 'pUC19',
                fields: {
                  sequence: {
                    mode: 'file',
                    relPath: managedRelPath,
                    topology: 'circular',
                    length: 2686,
                    contentHash: `sha256:${'0'.repeat(64)}`,
                    fileContentHash: `sha256:${'0'.repeat(64)}`,
                    normalizedSequenceHash: `sha256:${'0'.repeat(64)}`,
                    sourceFormat: 'gb',
                  },
                },
                registrationStatus: 'registered',
                actor: 'local-user',
              },
              source: { fileName: req.fileName, recordCount: 1 },
            },
          ],
        });
        return {
          destPath: managedRelPath,
          relPath: req.fileName,
          committed: true,
          copySkipped: false,
          registered: applied.insertedEntityIds.length > 0,
          batchId: applied.batchId,
          entityIds: applied.insertedEntityIds.map((e) => e.entityId),
        };
      }
    ),
  };
});

const ops = (): PlatformBridge['lims'] => {
  if (!mocks.bridge) throw new Error('mocks.bridge not initialized — set in beforeEach');
  return mocks.bridge;
};
vi.mock('../../sequence/public/sequence-document-repository', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../sequence/public/sequence-document-repository')>();
  return {
    ...actual,
    resolveSequenceDocumentById: (documentId: string, roots: readonly string[]) =>
      mocks.sequenceDocument?.documentId === documentId
        ? Promise.resolve(mocks.sequenceDocument)
        : actual.resolveSequenceDocumentById(documentId, roots),
  };
});
vi.mock('../operations', () => ({
  queryLimsEntities: (input?: LimsQueryEntitiesInput) => ops().queryEntities(input),
  countLimsEntitiesByKind: () => ops().countEntitiesByKind(),
  queryLimsRegistrySummaries: (input?: LimsQueryRegistrySummariesInput) =>
    (
      mocks.queryRegistryOverride ??
      ((i?: LimsQueryRegistrySummariesInput) => ops().queryRegistrySummaries(i))
    )(input),
  getLimsRegistryPreview: (input: LimsRegistryPreviewInput) => ops().getRegistryPreview(input),
  getLimsRegistrationBadgeCandidates: (input: LimsRegistrationBadgeInput) =>
    ops().getRegistrationBadgeCandidates(input),
  logLimsTelemetry: (input: LimsTelemetryInput) => ops().logTelemetry(input),
  registerLimsEntity: (input: LimsRegisterEntityInput) => ops().registerEntity(input),
  updateLimsEntity: (input: LimsUpdateEntityInput) => ops().updateEntity(input),
  archiveLimsEntity: (input: Parameters<PlatformBridge['lims']['archiveEntity']>[0]) =>
    ops().archiveEntity(input),
  restoreLimsEntity: (input: Parameters<PlatformBridge['lims']['restoreEntity']>[0]) =>
    ops().restoreEntity(input),
  applyLimsImportBatch: (input: LimsApplyImportBatchInput) => ops().applyImportBatch(input),
  undoLimsImportBatch: (input: LimsUndoImportBatchInput) => ops().undoImportBatch(input),
  getLimsIdSchemes: () => ops().getIdSchemes(),
  getLimsSchemas: () => ops().listSchemas(),
  setLimsIdScheme: (input: { kind: string; prefix?: string }) => ops().setIdScheme(input),
  seedLimsDemoDataset: () => ops().seedDemoDataset(),
  getLimsStrainGenomeSummary: (input: { strainEntityId: string }) =>
    ops().getStrainGenomeSummary(input),
  recordLimsStrainParentGenome: (input: LimsRecordStrainParentGenomeInput) =>
    ops().recordStrainParentGenome(input),
  attachLimsGenomeHypothesis: (input: LimsAttachGenomeHypothesisInput) =>
    ops().attachGenomeHypothesis(input),
  attachVerifiedLimsGenome: (input: LimsAttachVerifiedGenomeInput) =>
    ops().attachVerifiedGenome(input),
  getLimsEntityHistory: (input: { entityId: string }) =>
    (mocks.historyOverride ?? ((i: { entityId: string }) => ops().getEntityHistory(i)))(input),

  queryLimsPendingRefs: () => Promise.resolve([]),
  confirmLimsPendingRef: () => Promise.resolve(),
  rejectLimsPendingRefCandidate: () => Promise.resolve(),
  dismissLimsPendingRef: () => Promise.resolve(),
  restoreLimsPendingRef: () => Promise.resolve(),
}));

vi.mock('../open-entity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../open-entity')>();
  return {
    ...actual,
    openLimsEntity: mocks.openLimsEntity,
  };
});

vi.mock('../../canvas', () => ({
  useCanvasStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      focusedPanelId: 'main',
      panels: mocks.focusedSequencePath
        ? {
            main: {
              activeTabId: 'seq-tab',
              tabs: [{ id: 'seq-tab', type: 'sequence', entityId: mocks.focusedSequencePath }],
            },
          }
        : {},
    })
  ),
}));

vi.mock('../../../db', () => ({
  ensureSequenceIdentity: vi.fn(async () => 1),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    lims: mocks.bridge,
    get importReview() {
      return mocks.importReview!;
    },
    db: {
      execute: async (sql: string, params: unknown[] = []) => {
        if (!mocks.database) throw new Error('test database is not initialized');
        const result = mocks.database.prepare(sql).run(...params);
        return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
      },
      select: async <T,>(sql: string, params: unknown[] = []): Promise<T> => {
        if (!mocks.database) throw new Error('test database is not initialized');
        return mocks.database.prepare(sql).all(...params) as T;
      },
    },
    runtime: {
      getProfile: () => ({
        kind: mocks.scenarioMutationAllowed ? 'scenario-e2e' : 'primary',
        isElectron: true,
        isE2e: mocks.scenarioMutationAllowed,
        scenarioMutationAllowed: mocks.scenarioMutationAllowed,
        scenarioMutationReason: mocks.scenarioMutationAllowed ? 'test lease' : 'primary profile',
      }),
    },
    dialog: {
      open: mocks.dialogOpen,
    },
    fs: {
      stat: async (path: string) => ({ size: statSync(path).size }),
      readTextFile: mocks.readTextFile,
      readFile: mocks.readFile,
      readDir: mocks.readDir,
      exists: async (path: string) => existsSync(path),
      writeWorkspaceTextFileAtomic: async (input: { path: string; content: string }) => {
        mkdirSync(dirname(input.path), { recursive: true });
        writeFileSync(input.path, input.content);
        return { path: input.path, contentHash: 'sha256:test' };
      },
    },
    shell: {
      trashItem: async (path: string) => rmSync(path, { force: true }),
      execute: async () => ({ code: 1, stdout: '', stderr: 'not a git repository' }),
    },

    workspace: {
      discoverArtifacts: discoverTestWorkspaceArtifacts,
      getPathForFile: (file: File) => (file as File & { path?: string }).path ?? '',
      createEmptyWorkspace: mocks.createEmptyWorkspace,
      importFile: mocks.importFile,
      importFileFromContent: mocks.importFileFromContent,
      registerImportedSequence: mocks.registerImportedSequence,
      registerImportedSequenceFromContent: mocks.registerImportedSequenceFromContent,
    },
    cloudSync: {
      listOrganizations: mocks.listOrganizations,
      listCachedOrganizationRegistries: mocks.listCachedOrganizationRegistries,
      listSyncedProjects: mocks.listSyncedProjects,
      syncOrganizationRegistry: mocks.syncOrganizationRegistry,
      getOrganizationRegistry: mocks.getOrganizationRegistry,
      onOrganizationRegistryChanged: mocks.onOrganizationRegistryChanged,
      mutateOrganizationRegistry: mocks.mutateOrganizationRegistry,
      prepareOrganizationRegistryClaim: mocks.prepareOrganizationRegistryClaim,
      claimOrganizationRegistryEntity: mocks.claimOrganizationRegistryEntity,
      getOrganizationRegistryRecordDetails: mocks.getOrganizationRegistryRecordDetails,
    },
  }),
}));

vi.mock('../../../lib/analytics', () => ({
  trackRendererEvent: mocks.trackRendererEvent,
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
}));

vi.mock('../import-primer-bridge', () => ({
  recordImportedPrimers: mocks.recordImportedPrimers,
  persistImportedPrimerImportSet: mocks.persistImportedPrimerImportSet,
}));

vi.mock('../import-protein-bridge', () => ({
  recordImportedProteins: mocks.recordImportedProteins,
}));

vi.mock('../../../shared/registry-artifacts/import-primer-owner', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../shared/registry-artifacts/import-primer-owner')>();
  return {
    ...actual,
    createPrimerImportWriter: (...args: Parameters<typeof actual.createPrimerImportWriter>) => ({
      ...actual.createPrimerImportWriter(...args),
      recordImportedPrimers: mocks.recordImportedPrimers,
    }),
  };
});

vi.mock('../../../shared/registry-artifacts/import-protein-owner', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../shared/registry-artifacts/import-protein-owner')
    >();
  return {
    ...actual,
    createProteinImportWriter: (...args: Parameters<typeof actual.createProteinImportWriter>) => ({
      ...actual.createProteinImportWriter(...args),
      recordImportedProteins: mocks.recordImportedProteins,
    }),
  };
});

async function openFilterCategory(label: string) {
  if (!screen.queryByRole('dialog', { name: 'Registry filters' }))
    fireEvent.click(screen.getByRole('button', { name: 'Filters', exact: true }));
  const panel = screen.getByRole('dialog', { name: 'Registry filters' });
  fireEvent.click(await within(panel).findByRole('button', { name: label, exact: true }));
  return panel;
}

async function browseRegistry(value: string | null) {
  const panel = await openFilterCategory('Registry');
  const choices = within(panel).getAllByRole('radio') as HTMLInputElement[];
  const choice = choices.find((option) =>
    value === null ? option.value !== 'local' : option.value === value
  );
  if (!choice) throw new Error(`The fixture has no available Registry ${value}`);
  fireEvent.click(choice);
  fireEvent.click(within(panel).getByRole('button', { name: 'Done', exact: true }));
}

async function browseOrganizationRegistry() {
  await browseRegistry(null);
}

async function expectRegistry(value: string) {
  const panel = await openFilterCategory('Registry');
  expect(
    (within(panel).getAllByRole('radio') as HTMLInputElement[]).find(
      (option) => option.value === value
    )
  ).toBeChecked();
  fireEvent.click(within(panel).getByRole('button', { name: 'Done', exact: true }));
}

async function filterProject(value: number | string) {
  const panel = await openFilterCategory('Project');
  const choice = (within(panel).getAllByRole('checkbox') as HTMLInputElement[]).find(
    (option) => option.value === String(value)
  );
  if (!choice) throw new Error(`The fixture has no project ${value}`);
  fireEvent.click(choice);
  fireEvent.click(within(panel).getByRole('button', { name: 'Done', exact: true }));
}

async function expectProjectFilter(value: number | string | null) {
  const panel = await openFilterCategory('Project');
  const checked = (within(panel).getAllByRole('checkbox') as HTMLInputElement[])
    .filter((option) => option.checked)
    .map((option) => option.value);
  expect(checked).toEqual(value === null ? [] : [String(value)]);
  fireEvent.click(within(panel).getByRole('button', { name: 'Done', exact: true }));
}

async function chooseReferenceProject(value: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Registry actions' }));
  const panel = screen.getByRole('dialog', { name: 'Registry actions' });
  await waitFor(() =>
    expect(
      (within(panel).getAllByRole('radio') as HTMLInputElement[]).some(
        (option) => option.value === value
      )
    ).toBe(true)
  );
  const choice = (within(panel).getAllByRole('radio') as HTMLInputElement[]).find(
    (option) => option.value === value
  )!;
  fireEvent.click(choice);
  fireEvent.click(screen.getByRole('button', { name: 'Registry actions' }));
}

describe('LIMS panel workflows', () => {
  let unsubscribeRegistryOpen: (() => void) | undefined;
  let restoreNativeRegistration: (() => void) | undefined;

  async function expandRegistry() {
    fireEvent.click(await screen.findByTestId('lims-registry-expand'));
    return screen.findByTestId('lims-registry-overlay');
  }

  function openWizardForKind(kind: ImportDoorKind, destinationPath: string | null = null) {
    act(() => useLimsImportLaunchStore.getState().open({ kind, destinationPath }));
  }

  async function importFileViaWizard(kind: ImportDoorKind, file: File) {
    openWizardForKind(kind);
    fireEvent.change(await screen.findByTestId('lims-import-drop-input'), {
      target: { files: [file] },
    });
  }

  async function applyImportUnit(destinationPath?: string) {
    fireEvent.click(await screen.findByTestId('lims-import-next'));
    if (destinationPath) {
      fireEvent.click(
        await screen.findByTestId(`lims-import-destination-folder-${destinationPath}`)
      );
    }
    fireEvent.click(await screen.findByTestId('lims-import-apply'));
  }

  function importEventNames(): string[] {
    return mocks.trackRendererEvent.mock.calls
      .map(([event]) => event as string)
      .filter((event) => event.startsWith('import_'));
  }

  beforeEach(async () => {
    useLimsOverlayStore.setState({ active: false, registryRequest: null });
    mocks.focusedSequencePath = null;
    mocks.sequenceDocument = null;
    mocks.queryRegistryOverride = null;
    mocks.historyOverride = null;
    vi.clearAllMocks();
    useAuthStore.setState({ state: { status: 'signed-out' } });
    mocks.getOrganizationRegistryRecordDetails.mockReset();
    mocks.getOrganizationRegistry.mockReset();
    mocks.onOrganizationRegistryChanged.mockReturnValue(mocks.unsubscribeOrganizationRegistry);
    mocks.dialogOpen.mockResolvedValue(null);
    mocks.readTextFile.mockImplementation(async (path: string) =>
      existsSync(path) ? readFileSync(path, 'utf8') : ''
    );
    mocks.readFile.mockResolvedValue(new Uint8Array());
    mocks.readDir.mockResolvedValue([]);
    mocks.listOrganizations.mockResolvedValue({ ok: true, organizations: [] });
    mocks.listCachedOrganizationRegistries.mockResolvedValue({
      ok: true,
      accountId: null,
      organizationIds: [],
    });
    mocks.listSyncedProjects.mockResolvedValue([]);
    mocks.syncOrganizationRegistry.mockResolvedValue({
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'Organization Registry is not configured.',
    });
    mocks.mutateOrganizationRegistry.mockResolvedValue({
      ok: false,
      code: 'NOT_CONFIGURED',
      message: 'Organization Registry is not configured.',
    });
    mocks.scenarioMutationAllowed = true;

    const testBridge = createLimsTestBridge();
    mocks.database = testBridge.db;
    mocks.defaultProjectId = testBridge.originalProject!.workspaceId;
    mocks.bridge = testBridge.lims;
    const profileDirectory = mkdtempSync(join(tmpdir(), 'lims-review-profile-'));
    mocks.reviewProfileDirectory = profileDirectory;
    mocks.importReview = createNativeImportReviewBridgeForDb(testBridge.db, profileDirectory);
    await mocks.bridge.ensureSeeded();
    unsubscribeRegistryOpen = subscribeRegistryOpen((request) => {
      if (request)
        useLimsOverlayStore
          .getState()
          .requestRegistryEntity(request.entityId, request.fallbackSearch);
    });
  });

  afterEach(async () => {
    restoreNativeRegistration?.();
    restoreNativeRegistration = undefined;
    await act(async () => {
      await mocks.importReview?.settle();
    });
    cleanup();
    unsubscribeRegistryOpen?.();
    unsubscribeRegistryOpen = undefined;
    const maybeMockedConfirm = window.confirm as typeof window.confirm & {
      mockRestore?: () => void;
    };
    maybeMockedConfirm.mockRestore?.();
    for (const dir of mocks.mintedWorkspaceDirs) rmSync(dir, { recursive: true, force: true });
    mocks.mintedWorkspaceDirs = [];
    useWorkspaceStore.setState({ folders: [], selectedPath: null });
    mocks.database?.close();
    mocks.database = null;
    mocks.importReview = null;
    if (mocks.reviewProfileDirectory)
      rmSync(mocks.reviewProfileDirectory, { recursive: true, force: true });
    mocks.reviewProfileDirectory = null;
  });

  it('uses the default Registry bounds when its sidebar has no layout at opening', async () => {
    render(<LimsPanel />);
    const panel = await screen.findByTestId('lims-panel');
    const measure = vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect());
    try {
      act(() => useLimsOverlayStore.getState().requestRegistryEntity(null, 'track-view'));
      expect(await screen.findByTestId('lims-registry-overlay')).toHaveStyle({
        top: '58px',
        left: '48px',
        bottom: '0px',
      });
    } finally {
      measure.mockRestore();
    }
  });

  it('joins a notebook reference disposition only after the intended Registry preview renders', async () => {
    const entity = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'PRIVATE_REFERENCE_TARGET',
      fields: {},
    });
    const preview = await mocks.bridge!.getRegistryPreview({ entityId: entity.id });
    let finish!: (value: LimsRegistryPreview) => void;
    const read = vi.spyOn(mocks.bridge!, 'getRegistryPreview').mockImplementationOnce(
      () =>
        new Promise<LimsRegistryPreview>((resolve) => {
          finish = resolve;
        })
    );
    const observed = vi.fn();
    render(<LimsPanel />);
    act(() =>
      useLimsOverlayStore.getState().requestRegistryEntity(entity.id, entity.name, observed)
    );
    await waitFor(() => expect(read).toHaveBeenCalledWith({ entityId: entity.id }));
    expect(observed).not.toHaveBeenCalled();
    await act(async () => finish(preview));
    expect(await screen.findByTestId('lims-registry-preview')).toHaveAttribute(
      'data-entity-id',
      entity.id
    );
    await waitFor(() =>
      expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'record', entityId: entity.id })
    );
  });

  it('keeps a missing notebook reference disposition distinct from Registry fallback search', async () => {
    const observed = vi.fn();
    render(<LimsPanel />);
    act(() =>
      useLimsOverlayStore
        .getState()
        .requestRegistryEntity('PRIVATE_ABSENT_ID', 'PRIVATE_MISSING', observed)
    );
    expect(
      await screen.findByText("Couldn't find PRIVATE_MISSING in the Registry.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId('lims-registry-preview')).toBeNull();
    expect(screen.getByTestId('lims-registry-search')).toHaveValue('PRIVATE_MISSING');
    expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'missing' });
  });

  it('retires a superseded notebook reference disposition before a late preview overwrites search', async () => {
    const entity = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'PRIVATE_OLD_TARGET',
      fields: {},
    });
    const preview = await mocks.bridge!.getRegistryPreview({ entityId: entity.id });
    let finish!: (value: LimsRegistryPreview) => void;
    const read = vi.spyOn(mocks.bridge!, 'getRegistryPreview').mockImplementationOnce(
      () =>
        new Promise<LimsRegistryPreview>((resolve) => {
          finish = resolve;
        })
    );
    const older = vi.fn();
    const newer = vi.fn();
    render(<LimsPanel />);
    act(() => useLimsOverlayStore.getState().requestRegistryEntity(entity.id, entity.name, older));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    act(() =>
      useLimsOverlayStore.getState().requestRegistryEntity(null, 'PRIVATE_NEW_SEARCH', newer)
    );
    await act(async () => finish(preview));
    expect(await screen.findByTestId('lims-registry-search')).toHaveValue('PRIVATE_NEW_SEARCH');
    expect(screen.queryByTestId('lims-registry-preview')).toBeNull();
    expect(older).toHaveBeenCalledExactlyOnceWith({ kind: 'superseded' });
    await waitFor(() => expect(newer).toHaveBeenCalledExactlyOnceWith({ kind: 'search' }));
  });

  it('cancels a notebook reference disposition when its pending Registry presentation unmounts', async () => {
    const entity = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'PRIVATE_UNMOUNTED',
      fields: {},
    });
    const preview = await mocks.bridge!.getRegistryPreview({ entityId: entity.id });
    let finish!: (value: LimsRegistryPreview) => void;
    const read = vi.spyOn(mocks.bridge!, 'getRegistryPreview').mockImplementationOnce(
      () =>
        new Promise<LimsRegistryPreview>((resolve) => {
          finish = resolve;
        })
    );
    const observed = vi.fn();
    const view = render(<LimsPanel />);
    act(() =>
      useLimsOverlayStore.getState().requestRegistryEntity(entity.id, entity.name, observed)
    );
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => finish(preview));
    expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'cancelled' });
  });

  it('refuses a notebook reference disposition whose preview belongs to another record', async () => {
    const requested = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'PRIVATE_REQUESTED',
      fields: {},
    });
    const other = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'PRIVATE_OTHER',
      fields: {},
    });
    const wrong = await mocks.bridge!.getRegistryPreview({ entityId: other.id });
    vi.spyOn(mocks.bridge!, 'getRegistryPreview').mockResolvedValueOnce(wrong);
    const observed = vi.fn();
    render(<LimsPanel />);
    act(() =>
      useLimsOverlayStore.getState().requestRegistryEntity(requested.id, requested.name, observed)
    );
    expect(
      await screen.findByText("Couldn't find PRIVATE_REQUESTED in the Registry.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId('lims-registry-preview')).toBeNull();
    expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'mismatch' });
  });

  it('keeps a notebook reference observer failure outside the real Registry presentation', async () => {
    const entity = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'PRIVATE_VISIBLE',
      fields: {},
    });
    const observed = vi.fn(() => {
      throw new Error('PRIVATE_OBSERVER_FAILURE');
    });
    render(<LimsPanel />);
    act(() =>
      useLimsOverlayStore.getState().requestRegistryEntity(entity.id, entity.name, observed)
    );
    expect(await screen.findByTestId('lims-registry-preview')).toHaveAttribute(
      'data-entity-id',
      entity.id
    );
    await waitFor(() =>
      expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'record', entityId: entity.id })
    );
  });

  it('cancels a notebook reference disposition when the Registry closes before its read completes', async () => {
    const entity = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'PRIVATE_CLOSED',
      fields: {},
    });
    const preview = await mocks.bridge!.getRegistryPreview({ entityId: entity.id });
    let finish!: (value: LimsRegistryPreview) => void;
    const read = vi.spyOn(mocks.bridge!, 'getRegistryPreview').mockImplementationOnce(
      () =>
        new Promise<LimsRegistryPreview>((resolve) => {
          finish = resolve;
        })
    );
    const observed = vi.fn();
    render(<LimsPanel />);
    act(() =>
      useLimsOverlayStore.getState().requestRegistryEntity(entity.id, entity.name, observed)
    );
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByTestId('lims-registry-collapse'));
    await act(async () => finish(preview));
    expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'cancelled' });
  });

  it('preserves a queued notebook reference disposition through StrictMode mount replay', async () => {
    const entity = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'PRIVATE_STRICT_TARGET',
      fields: {},
    });
    const preview = await mocks.bridge!.getRegistryPreview({ entityId: entity.id });
    let finish!: (value: LimsRegistryPreview) => void;
    const held = new Promise<LimsRegistryPreview>((resolve) => {
      finish = resolve;
    });
    const read = vi.spyOn(mocks.bridge!, 'getRegistryPreview').mockReturnValue(held);
    const observed = vi.fn();
    useLimsOverlayStore.getState().requestRegistryEntity(entity.id, entity.name, observed);
    render(
      <StrictMode>
        <LimsPanel />
      </StrictMode>
    );
    try {
      await waitFor(() => expect(read).toHaveBeenCalledOnce());
      expect(observed).not.toHaveBeenCalled();
      await act(async () => finish(preview));
      expect(await screen.findByTestId('lims-registry-preview')).toHaveAttribute(
        'data-entity-id',
        entity.id
      );
      await waitFor(() =>
        expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'record', entityId: entity.id })
      );
    } finally {
      await act(async () => finish(preview));
    }
  });

  it('selects a Registry record before explicitly editing its shared metadata', async () => {
    const entity = await mocks.bridge!.registerEntity({
      kind: 'oligo',
      name: 'Read-only Registry click',
      fields: { sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 } },
    });
    const before = (await mocks.bridge!.queryEntities({ id: entity.id }))[0];
    render(<LimsPanel />);
    await expandRegistry();
    const row = await screen.findByTestId(`lims-registry-row-${entity.id}`);

    fireEvent.click(within(row).getByText(entity.name));

    const details = await screen.findByTestId('lims-registry-preview');
    const editName = await within(details).findByRole('button', { name: 'Edit Name' });
    expect(editName).toHaveTextContent(entity.name);
    expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(details).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Edit / })).not.toBeInTheDocument();
    fireEvent.click(editName);
    const name = await within(details).findByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Canceled Registry name' } });
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(within(details).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Edit Name' })).toHaveTextContent(
      entity.name
    );
    expect((await mocks.bridge!.queryEntities({ id: entity.id }))[0]).toEqual(before);
  });

  it('hides LIMS sample scenario controls in primary runtime profiles', async () => {
    mocks.scenarioMutationAllowed = false;
    render(<LimsPanel />);

    expect(screen.getByTestId('lims-registry-add-button')).toHaveAccessibleName('New…');
    expect(screen.queryByTestId('lims-dev-scenario-picker')).not.toBeInTheDocument();

    await expandRegistry();
    expect(screen.getByTestId('lims-registry-add-button')).toHaveAccessibleName('New…');
    expect(screen.queryByTestId('lims-dev-scenario-picker')).not.toBeInTheDocument();
  });

  it('combines searchable project and schema filters in compact Registry and retains removable criteria when expanded', async () => {
    const projectId = Number(
      mocks
        .database!.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)')
        .run('Unopened filter project', '/projects/faceted-filter', 1).lastInsertRowid
    );
    const first = await mocks.bridge!.registerEntity({
      kind: 'oligo',
      name: 'Filtered primer',
      fields: { sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 } },
      workspaceId: projectId,
    });
    const second = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'Same project strain',
      fields: {},
      workspaceId: projectId,
    });
    const third = await mocks.bridge!.registerEntity({
      kind: 'oligo',
      name: 'Other project primer',
      fields: { sequence: { mode: 'inline', bases: 'TGCA', topology: 'linear', length: 4 } },
    });
    render(<LimsPanel />);
    await screen.findByTestId(`lims-registry-compact-row-${third.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Filters', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Project', exact: true }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), {
      target: { value: 'Unopened filter' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unopened filter project', exact: true }));
    await waitFor(() =>
      expect(screen.queryByTestId(`lims-registry-compact-row-${third.id}`)).toBeNull()
    );
    expect(screen.getByTestId(`lims-registry-compact-row-${second.id}`)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Schema', exact: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'DNA Oligo', exact: true }));
    await waitFor(() =>
      expect(screen.queryByTestId(`lims-registry-compact-row-${second.id}`)).toBeNull()
    );
    expect(screen.getByTestId(`lims-registry-compact-row-${first.id}`)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Project', exact: true }));
    const anotherProject = (screen.getAllByRole('checkbox') as HTMLInputElement[]).find(
      (option) => option.value === String(mocks.defaultProjectId)
    );
    expect(anotherProject).toBeDefined();
    fireEvent.click(anotherProject!);
    await screen.findByTestId(`lims-registry-compact-row-${third.id}`);
    expect(screen.queryByTestId(`lims-registry-compact-row-${second.id}`)).toBeNull();
    fireEvent.click(anotherProject!);
    await waitFor(() =>
      expect(screen.queryByTestId(`lims-registry-compact-row-${third.id}`)).toBeNull()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done', exact: true }));
    expect(
      screen.getByRole('button', { name: 'Remove Project: Unopened filter project' })
    ).toBeVisible();
    await expandRegistry();
    expect(screen.getByTestId(`lims-registry-row-${first.id}`)).toBeVisible();
    expect(screen.queryByTestId(`lims-registry-row-${second.id}`)).toBeNull();
    expect(screen.queryByTestId(`lims-registry-row-${third.id}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Schema: DNA Oligo' }));
    await screen.findByTestId(`lims-registry-row-${second.id}`);
    expect(screen.queryByTestId(`lims-registry-row-${third.id}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByTestId(`lims-registry-row-${third.id}`);
    expect(mocks.openLimsEntity).not.toHaveBeenCalled();
    expect(mocks.mutateOrganizationRegistry).not.toHaveBeenCalled();
  });

  it('keeps a containing-project filter across compact and expanded Registry independently of Files selection', async () => {
    const workspacePath = '/projects/project-filter';
    const workspaceId = Number(
      mocks
        .database!.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)')
        .run('Unopened project', workspacePath, 1).lastInsertRowid
    );
    const first = await mocks.bridge!.registerEntity({
      kind: 'oligo',
      name: 'Project filter same name',
      fields: { sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 } },
      workspaceId,
    });
    const second = await mocks.bridge!.registerEntity({
      kind: 'oligo',
      name: first.name,
      fields: { sequence: { mode: 'inline', bases: 'TGCA', topology: 'linear', length: 4 } },
    });
    render(<LimsPanel />);
    await screen.findByTestId(`lims-registry-compact-row-${first.id}`);
    expect(screen.getByTestId(`lims-registry-compact-row-${second.id}`)).toBeVisible();
    await filterProject(workspaceId);
    await waitFor(() => {
      expect(screen.queryByTestId(`lims-registry-compact-row-${second.id}`)).toBeNull();
    });
    act(() => useWorkspaceStore.setState({ selectedPath: '/projects/another-project' }));
    expect(screen.getByTestId(`lims-registry-compact-row-${first.id}`)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: `Show details for ${first.name}` }));
    expect(await screen.findByTestId('lims-registry-preview')).toHaveAttribute(
      'data-entity-id',
      first.id
    );
    await expectProjectFilter(workspaceId);
    expect(screen.queryByTestId(`lims-registry-row-${second.id}`)).toBeNull();
    expect(mocks.openLimsEntity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByTestId(`lims-registry-row-${second.id}`);
    expect(screen.getByTestId(`lims-registry-row-${first.id}`)).toBeVisible();
    await expectProjectFilter(null);
  });

  it('clears an incompatible project filter when explicitly navigating to a Registry entity', async () => {
    const workspaceId = Number(
      mocks
        .database!.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)')
        .run('Another project', '/projects/request-target', 1).lastInsertRowid
    );
    const visible = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'Initially visible',
      fields: {},
    });
    const requested = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'Explicit navigation target',
      fields: {},
      workspaceId,
    });
    render(<LimsPanel />);
    await screen.findByTestId(`lims-registry-compact-row-${visible.id}`);
    await filterProject(mocks.defaultProjectId);
    await waitFor(() =>
      expect(screen.queryByTestId(`lims-registry-compact-row-${requested.id}`)).toBeNull()
    );
    act(() => useLimsOverlayStore.getState().requestRegistryEntity(requested.id, requested.name));
    await waitFor(() => {
      expect(screen.getByTestId('lims-registry-preview')).toHaveAttribute(
        'data-entity-id',
        requested.id
      );
      expect(screen.queryByRole('button', { name: /^Remove Project:/ })).toBeNull();
    });
    expect(screen.getByTestId(`lims-registry-row-${requested.id}`)).toBeVisible();
  });

  it('retains an in-flight Details selection through an ordinary Registry refresh', async () => {
    const entity = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'Selected during refresh',
      fields: {},
    });
    render(<LimsPanel />);
    await screen.findByTestId(`lims-registry-compact-row-${entity.id}`);
    const parked = Promise.withResolvers<void>();
    const readPreview = mocks.bridge!.getRegistryPreview.bind(mocks.bridge);
    const preview = vi
      .spyOn(mocks.bridge!, 'getRegistryPreview')
      .mockImplementationOnce(async (input) => {
        await parked.promise;
        return readPreview(input);
      });
    fireEvent.click(screen.getByRole('button', { name: `Show details for ${entity.name}` }));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    let refreshed = false;
    mocks.queryRegistryOverride = async (input) => {
      const page = await mocks.bridge!.queryRegistrySummaries(input);
      refreshed = true;
      return page;
    };
    act(() => emitLimsRegistryChanged());
    await waitFor(() => expect(refreshed).toBe(true));
    await act(async () => parked.resolve());
    expect(await screen.findByTestId('lims-registry-preview')).toHaveAttribute(
      'data-entity-id',
      entity.id
    );
    preview.mockRestore();
  });

  it('keeps explicit Details beyond the first page when clearing a project filter reloads the list', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    try {
      const workspaceId = Number(
        mocks
          .database!.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)')
          .run('Older project', '/projects/older-target', 1).lastInsertRowid
      );
      const requested = await mocks.bridge!.registerEntity({
        kind: 'strain',
        name: 'Older explicit target',
        fields: {},
        workspaceId,
      });
      for (let index = 0; index < 100; index += 1) {
        await mocks.bridge!.registerEntity({
          kind: 'strain',
          name: `Newer record ${index}`,
          fields: {},
        });
      }
      render(<LimsPanel />);
      await screen.findByRole('button', { name: 'Filters', exact: true });
      await filterProject(mocks.defaultProjectId);
      await waitFor(() =>
        expect(screen.getAllByTestId(/^lims-registry-compact-row-/).length).toBeGreaterThan(0)
      );
      const parked = Promise.withResolvers<void>();
      let delivered = false;
      mocks.queryRegistryOverride = async (input) => {
        const page = await mocks.bridge!.queryRegistrySummaries(input);
        if (!input?.workspaceIds && !input?.ids) {
          expect(page.summaries.some((row) => row.id === requested.id)).toBe(false);
          await parked.promise;
          delivered = true;
        }
        return page;
      };
      act(() => useLimsOverlayStore.getState().requestRegistryEntity(requested.id, requested.name));
      expect(await screen.findByTestId('lims-registry-preview')).toHaveAttribute(
        'data-entity-id',
        requested.id
      );
      await act(async () => parked.resolve());
      await waitFor(() => expect(delivered).toBe(true));
      expect(screen.getByTestId('lims-registry-preview')).toHaveAttribute(
        'data-entity-id',
        requested.id
      );
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('keeps an explicitly selected organization project independent of Files navigation', async () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const remoteWorkspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const workspacePath = '/projects/fermentation';
    const insertedWorkspace = mocks
      .database!.prepare(
        `INSERT INTO workspaces (name, path, created_at, repo_uuid)
         VALUES (?, ?, ?, ?)`
      )
      .run('Fermentation project', workspacePath, 1, 'local-workspace-a');
    mocks
      .database!.prepare(
        `INSERT INTO workspace_sync_bindings (
           workspace_id, workspace_uuid, owner_account_id, owner_org_id,
           remote_workspace_id, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        insertedWorkspace.lastInsertRowid,
        'local-workspace-a',
        'account-1',
        orgId,
        remoteWorkspaceId,
        1,
        1
      );
    useWorkspaceStore.setState({
      folders: [{ path: workspacePath, name: 'Fermentation project', addedAt: 1 }],
      selectedPath: workspacePath,
    });
    mocks.listOrganizations.mockResolvedValue({
      ok: true,
      organizations: [
        {
          orgId,
          slug: 'acme',
          displayName: 'Acme Bio',
          role: 'member',
          canCreateManagedProjects: true,
          isAdministrator: false,
        },
      ],
    });
    mocks.syncOrganizationRegistry.mockResolvedValue({
      ok: true,
      sync: { status: 'ready', cursor: 12, pendingCount: 0, conflictCount: 0 },
      registry: {
        orgId,
        state: {
          cursor: 12,
          status: 'ready',
          clientId: 'desktop:test',
          lastPullAt: 1,
          lastPushAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [
          {
            id: 'entity-project',
            registryId: 'ACME-0001',
            name: 'MG1655',
            kind: 'strain',
            revision: 3,
            fields: {},
          },
          {
            id: 'entity-other',
            registryId: 'ACME-0002',
            name: 'pUC19',
            kind: 'plasmid',
            revision: 1,
            fields: {},
          },
        ],
        entityRevisions: [],
        relationships: [],
        placements: [
          {
            id: 'placement-project',
            entityId: 'entity-project',
            workspaceId: remoteWorkspaceId,
            path: 'samples/mg1655.json',
          },
          {
            id: 'placement-other',
            entityId: 'entity-other',
            workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            path: 'plasmids/puc19.gb',
          },
        ],
        pendingMutations: [],
        conflicts: [],
      },
    });

    render(<LimsPanel />);
    await expectRegistry('local');
    expect(mocks.syncOrganizationRegistry).not.toHaveBeenCalled();
    expect(mocks.mutateOrganizationRegistry).not.toHaveBeenCalled();

    await browseOrganizationRegistry();
    expect(await screen.findByText('ACME-0001')).toBeVisible();
    expect(screen.getByText('ACME-0002')).toBeVisible();
    expect(mocks.syncOrganizationRegistry).toHaveBeenCalledWith(orgId);

    await filterProject(remoteWorkspaceId);
    await waitFor(() => {
      expect(screen.getByTestId('organization-registry-scope-row-entity-project')).toBeVisible();
      expect(screen.queryByTestId('organization-registry-scope-row-entity-other')).toBeNull();
    });
    expect(
      screen.getByRole('button', { name: 'Remove Project: Fermentation project' })
    ).toBeVisible();
    const callsBeforeNavigation = mocks.syncOrganizationRegistry.mock.calls.length;
    act(() => useWorkspaceStore.setState({ selectedPath: '/projects/unrelated' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Remove Project: Fermentation project' })
      ).toBeVisible();
      expect(screen.getByTestId('organization-registry-scope-row-entity-project')).toBeVisible();
      expect(screen.queryByTestId('organization-registry-scope-row-entity-other')).toBeNull();
    });
    expect(mocks.syncOrganizationRegistry).toHaveBeenCalledTimes(callsBeforeNavigation);
    await expandRegistry();
    await expectProjectFilter(remoteWorkspaceId);
  });

  it('keeps Local and Organization Registry searches independent', async () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    await mocks.bridge!.registerEntity({
      id: 'local-alpha',
      kind: 'strain',
      name: 'Local Alpha',
      fields: {},
    });
    await mocks.bridge!.registerEntity({
      id: 'local-beta',
      kind: 'strain',
      name: 'Local Beta',
      fields: {},
    });
    const queryLocalRegistry = vi.fn((input?: LimsQueryRegistrySummariesInput) =>
      mocks.bridge!.queryRegistrySummaries(input)
    );
    mocks.queryRegistryOverride = queryLocalRegistry;
    mocks.listOrganizations.mockResolvedValue({
      ok: true,
      organizations: [
        {
          orgId,
          slug: 'acme',
          displayName: 'Acme Bio',
          role: 'member',
          canCreateManagedProjects: true,
          isAdministrator: false,
        },
      ],
    });
    mocks.syncOrganizationRegistry.mockResolvedValue({
      ok: true,
      sync: { status: 'ready', cursor: 2, pendingCount: 0, conflictCount: 0 },
      registry: {
        orgId,
        state: {
          cursor: 2,
          status: 'ready',
          clientId: 'desktop:test',
          lastPullAt: 1,
          lastPushAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [
          {
            id: 'org-alpha',
            registryId: 'ACME-0001',
            name: 'Organization Alpha',
            kind: 'strain',
            revision: 1,
            fields: {},
          },
          {
            id: 'org-beta',
            registryId: 'ACME-0002',
            name: 'Organization Beta',
            kind: 'strain',
            revision: 1,
            fields: {},
          },
        ],
        entityRevisions: [],
        relationships: [],
        placements: [],
        pendingMutations: [],
        conflicts: [],
      },
    });

    render(<LimsPanel />);
    await screen.findByText('Local Alpha');

    const search = screen.getByTestId('lims-registry-compact-search');
    fireEvent.change(search, { target: { value: 'Local Alpha' } });
    await waitFor(() => expect(screen.queryByText('Local Beta')).not.toBeInTheDocument());
    const localQueryCount = queryLocalRegistry.mock.calls.length;

    await browseOrganizationRegistry();
    expect(await screen.findByText('Organization Alpha')).toBeVisible();
    expect(search).toHaveValue('');

    fireEvent.change(search, { target: { value: 'Organization Beta' } });
    await waitFor(() => {
      expect(screen.getByText('Organization Beta')).toBeVisible();
      expect(screen.queryByText('Organization Alpha')).not.toBeInTheDocument();
    });
    expect(queryLocalRegistry).toHaveBeenCalledTimes(localQueryCount);

    await browseRegistry('local');
    expect(search).toHaveValue('Local Alpha');
    expect(await screen.findByText('Local Alpha')).toBeVisible();
    expect(screen.queryByText('Local Beta')).not.toBeInTheDocument();
  });

  function organizationDetailsFixture() {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const entityId = '22222222-2222-4222-8222-222222222222';
    const home = '33333333-3333-4333-8333-333333333333';
    useAuthStore.setState({
      state: {
        status: 'signed-in',
        session: {
          accountId: 'account-details',
          desktopSessionId: 'session-details',
          channel: 'dev',
          accessTokenExpiresAt: '2099-01-01T00:00:00Z',
        },
      },
    });
    const details: OrganizationRegistryRecordDetails = {
      scope: {
        accountId: 'account-details',
        orgId,
        accessGeneration: 'generation-details',
        cursor: 4,
      },
      entity: {
        id: entityId,
        orgId,
        homeWorkspaceId: home,
        schemaId: 'schema-details',
        schemaRevisionId: 'revision-pinned',
        registryId: 'ORG-1',
        name: 'Canonical strain',
        kind: 'strain',
        revision: 1,
        fields: { lot: 'Organization lot' },
      },
      schema: {
        id: 'schema-details',
        orgId,
        name: 'strain',
        displayName: 'Strain',
        baseKind: 'strain',
        currentRevisionId: 'revision-newer',
      },
      schemaRevision: {
        id: 'revision-pinned',
        orgId,
        schemaId: 'schema-details',
        version: 1,
        fields: [{ key: 'lot', label: 'Pinned lot', type: 'text' }],
      },
      relationships: [],
      placements: [],
      local: {
        status: 'available',
        workspaceId: 7,
        workspaceUuid: 'local-home',
        homeWorkspaceId: home,
        summary: {
          id: entityId,
          kind: 'strain',
          name: 'Saved local strain',
          archived: false,
          representation: {
            kind: 'record_file',
            label: 'Saved record',
            canOpen: true,
            openTarget: {
              kind: 'record_file',
              entityId,
              entityKind: 'strain',
              label: 'Saved local strain',
              workspaceId: 7,
              artifactRelativePath: 'strain.entity.json',
            },
          },
        },
      },
    };
    const registry = {
      orgId,
      state: {
        cursor: 4,
        accessGeneration: 'generation-details',
        status: 'ready',
        clientId: 'desktop:test',
        lastPullAt: 1,
        lastPushAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      idSchemes: [],
      schemas: [details.schema],
      schemaRevisions: [details.schemaRevision],
      entities: [details.entity],
      entityRevisions: [],
      relationships: [],
      placements: [],
      pendingMutations: [],
      conflicts: [],
    } satisfies OrganizationRegistryView;
    mocks.listOrganizations.mockResolvedValue({
      ok: true,
      organizations: [
        {
          orgId,
          slug: 'acme',
          displayName: 'Acme Bio',
          role: 'member',
          canCreateManagedProjects: true,
          isAdministrator: false,
        },
      ],
    });
    mocks.syncOrganizationRegistry.mockResolvedValue({
      ok: true,
      registry,
      sync: { status: 'ready' },
    });
    mocks.getOrganizationRegistryRecordDetails.mockResolvedValue({ ok: true, details });
    return { orgId, entityId, details, registry };
  }

  it('updates the visible organization record from its native change event without echoing a sync', async () => {
    const { orgId, entityId, registry } = organizationDetailsFixture();
    const updated = {
      ...registry,
      entities: registry.entities.map((entity) => ({
        ...entity,
        name: 'Published strain',
        revision: 2,
      })),
    };
    mocks.getOrganizationRegistry.mockResolvedValue({ ok: true, registry: updated });
    render(<LimsPanel />);
    await browseOrganizationRegistry();
    const row = await screen.findByTestId(`organization-registry-scope-row-${entityId}`);
    expect(row).toHaveTextContent('Canonical strain');
    const syncCalls = mocks.syncOrganizationRegistry.mock.calls.length;
    const organizationCalls = mocks.listOrganizations.mock.calls.length;
    await act(async () => {
      for (const [notify] of mocks.onOrganizationRegistryChanged.mock.calls)
        notify({ accountId: 'account-details', orgId });
    });
    await waitFor(() => expect(row).toHaveTextContent('Published strain'));
    expect(row).toHaveTextContent('revision 2');
    expect(mocks.getOrganizationRegistry).toHaveBeenCalledWith(orgId);
    expect(mocks.syncOrganizationRegistry).toHaveBeenCalledTimes(syncCalls);
    expect(mocks.listOrganizations).toHaveBeenCalledTimes(organizationCalls);
  });

  it('ignores foreign organization change events and retires cached reads on sign out', async () => {
    const { orgId, entityId, registry } = organizationDetailsFixture();
    let finish!: (result: OrganizationRegistryReadResult) => void;
    mocks.getOrganizationRegistry.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<LimsPanel />);
    await browseOrganizationRegistry();
    await screen.findByTestId(`organization-registry-scope-row-${entityId}`);
    expect(mocks.onOrganizationRegistryChanged).toHaveBeenCalled();
    await act(async () => {
      for (const [notify] of mocks.onOrganizationRegistryChanged.mock.calls) {
        notify({ accountId: 'another-account', orgId });
        notify({ accountId: 'account-details', orgId: 'another-organization' });
      }
    });
    expect(mocks.getOrganizationRegistry).not.toHaveBeenCalled();
    await act(async () => {
      for (const [notify] of mocks.onOrganizationRegistryChanged.mock.calls)
        notify({ accountId: 'account-details', orgId });
    });
    await waitFor(() => expect(mocks.getOrganizationRegistry).toHaveBeenCalledWith(orgId));
    act(() => useAuthStore.setState({ state: { status: 'signed-out' } }));
    await act(async () => finish({ ok: true, registry }));
    expect(screen.queryByTestId(`organization-registry-scope-row-${entityId}`)).toBeNull();
    expect(mocks.unsubscribeOrganizationRegistry).toHaveBeenCalled();
  });

  it('opens cached organization Details after an offline restart without granting membership capabilities', async () => {
    const { orgId, entityId, registry, details } = organizationDetailsFixture();
    const accountId = details.scope.accountId;
    mocks.listOrganizations.mockResolvedValue({
      ok: false,
      code: 'SYNC_ERROR',
      message: 'Network offline',
    });
    mocks.listCachedOrganizationRegistries.mockResolvedValue({
      ok: true,
      accountId,
      organizationIds: [orgId],
    });
    mocks.syncOrganizationRegistry.mockResolvedValue({
      ok: true,
      registry: { ...registry, state: { ...registry.state, status: 'error' } },
      sync: { status: 'error', errorMessage: 'Network offline' },
    });
    render(<LimsPanel />);
    await browseOrganizationRegistry();
    await expectRegistry(orgId);
    fireEvent.click(await screen.findByTestId(`organization-registry-scope-row-${entityId}`));
    const preview = await screen.findByTestId('lims-registry-organization-preview');
    expect(preview).toHaveAttribute('data-entity-id', entityId);
    expect(within(preview).getByText('Pinned lot')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Registry actions' }));
    expect(screen.getByTestId('lims-registry-organization-sync-state')).toHaveTextContent(
      'Offline; changes remain queued'
    );
    expect(mocks.getOrganizationRegistryRecordDetails).toHaveBeenCalledWith(orgId, {
      entityId,
      expectedAccessGeneration: registry.state.accessGeneration,
    });
    act(() => useAuthStore.setState({ state: { status: 'signed-out' } }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Registry actions' })).toBeNull()
    );
    expect(screen.queryByTestId('lims-registry-organization-preview')).toBeNull();
  });

  it('retains a Settings registration request until the requested organization has actually loaded', async () => {
    const { orgId, registry } = organizationDetailsFixture();
    const pending = Promise.withResolvers<void>();
    mocks.syncOrganizationRegistry.mockImplementation(async () => {
      await pending.promise;
      return { ok: true, registry, sync: { status: 'ready' } };
    });
    act(() =>
      useLimsOverlayStore
        .getState()
        .requestRegistryEntity(null, '', { organizationId: orgId, action: 'claim' })
    );
    render(
      <StrictMode>
        <LimsPanel />
      </StrictMode>
    );
    await waitFor(() => expect(mocks.syncOrganizationRegistry).toHaveBeenCalledWith(orgId));
    expect(useLimsOverlayStore.getState().registryRequest).not.toBeNull();
    expect(screen.queryByTestId('registry-claim-dialog')).not.toBeInTheDocument();
    await act(async () => pending.resolve());
    expect(await screen.findByTestId('registry-claim-dialog')).toBeVisible();
    expect(useLimsOverlayStore.getState().registryRequest).toBeNull();
    expect(mocks.mutateOrganizationRegistry).not.toHaveBeenCalled();
    expect(mocks.claimOrganizationRegistryEntity).not.toHaveBeenCalled();
  });

  it('selects organization Details with its pinned fields, then revalidates before separate Open', async () => {
    const { orgId, entityId } = organizationDetailsFixture();
    render(<LimsPanel />);
    await browseOrganizationRegistry();
    fireEvent.click(await screen.findByTestId(`organization-registry-scope-row-${entityId}`));
    const preview = await screen.findByTestId('lims-registry-organization-preview');
    expect(preview).toHaveAttribute('data-entity-id', entityId);
    expect(preview).toHaveAttribute('data-schema-revision-id', 'revision-pinned');
    expect(within(preview).getByText('Pinned lot')).toBeVisible();
    expect(within(preview).getByText('Organization lot')).toBeVisible();
    expect(within(preview).queryByRole('textbox')).toBeNull();
    expect(mocks.openLimsEntity).not.toHaveBeenCalled();
    expect(mocks.getOrganizationRegistryRecordDetails).toHaveBeenLastCalledWith(orgId, {
      entityId,
      expectedAccessGeneration: 'generation-details',
    });
    const reads = mocks.getOrganizationRegistryRecordDetails.mock.calls.length;
    fireEvent.click(within(preview).getByTestId('lims-registry-organization-preview-open'));
    await waitFor(() =>
      expect(mocks.openLimsEntity).toHaveBeenCalledWith({
        entityId,
        strategy: { kind: 'focused' },
        signal: expect.any(AbortSignal),
      })
    );
    expect(mocks.getOrganizationRegistryRecordDetails.mock.calls.length).toBe(reads + 1);
  });

  it('uses the separate organization row Open action without treating selection as Open', async () => {
    const { entityId } = organizationDetailsFixture();
    render(<LimsPanel />);
    await browseOrganizationRegistry();
    fireEvent.click(await screen.findByTestId(`organization-registry-open-${entityId}`));
    await waitFor(() =>
      expect(mocks.openLimsEntity).toHaveBeenCalledWith({
        entityId,
        strategy: { kind: 'focused' },
        signal: expect.any(AbortSignal),
      })
    );
    expect(screen.queryByTestId('lims-registry-organization-preview')).toBeNull();
  });

  it('cancels an organization document open when the Registry scope changes during its read', async () => {
    const { entityId } = organizationDetailsFixture();
    let finish!: () => void;
    mocks.openLimsEntity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: 'opened', tabId: 'late-tab', target: null });
        })
    );
    render(<LimsPanel />);
    await browseOrganizationRegistry();
    fireEvent.click(await screen.findByTestId(`organization-registry-open-${entityId}`));
    await waitFor(() => expect(mocks.openLimsEntity).toHaveBeenCalled());
    const request = mocks.openLimsEntity.mock.calls[0][0] as { signal: AbortSignal };
    expect(request.signal.aborted).toBe(false);
    await browseRegistry('local');
    expect(request.signal.aborted).toBe(true);
    await act(async () => finish());
    await expectRegistry('local');
    expect(screen.queryByTestId('lims-registry-organization-preview')).toBeNull();
  });

  it('withholds organization Open when revalidation removes local availability', async () => {
    const { entityId, details } = organizationDetailsFixture();
    render(<LimsPanel />);
    await browseOrganizationRegistry();
    const row = await screen.findByTestId(`organization-registry-scope-row-${entityId}`);
    fireEvent.keyDown(row, { key: 'Enter' });
    const preview = await screen.findByTestId('lims-registry-organization-preview');
    mocks.getOrganizationRegistryRecordDetails.mockResolvedValue({
      ok: true,
      details: {
        ...details,
        local: {
          status: 'unavailable',
          reason: 'not_on_device',
          message: 'No saved copy is available on this device.',
        },
      },
    });
    fireEvent.click(within(preview).getByTestId('lims-registry-organization-preview-open'));
    expect(
      await within(preview).findByText('No saved copy is available on this device.')
    ).toBeVisible();
    expect(mocks.openLimsEntity).not.toHaveBeenCalled();
    expect(within(preview).queryByTestId('lims-registry-organization-preview-open')).toBeNull();
  });

  it('ignores a delayed organization Details reply after returning to Local', async () => {
    const { entityId, details } = organizationDetailsFixture();
    let resolveDetails!: (value: unknown) => void;
    mocks.getOrganizationRegistryRecordDetails.mockReturnValue(
      new Promise((resolve) => {
        resolveDetails = resolve;
      })
    );
    render(<LimsPanel />);
    await browseOrganizationRegistry();
    fireEvent.click(await screen.findByTestId(`organization-registry-scope-row-${entityId}`));
    await waitFor(() => expect(mocks.getOrganizationRegistryRecordDetails).toHaveBeenCalled());
    await browseRegistry('local');
    await act(async () => resolveDetails({ ok: true, details }));
    expect(screen.queryByTestId('lims-registry-organization-preview')).toBeNull();
    expect(mocks.openLimsEntity).not.toHaveBeenCalled();
  });

  it('claims a selected local record only after the explicit organization payload preview', async () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const local = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'Local MG1655',
      fields: { species: 'E. coli', freezer: 'A/01' },
      registrationStatus: 'registered',
      actor: 'local-user',
    });
    const emptyRegistry = {
      orgId,
      state: {
        cursor: 4,
        status: 'ready' as const,
        clientId: 'desktop:test-device',
        lastPullAt: 1,
        lastPushAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      idSchemes: [],
      schemas: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          currentRevisionId: '33333333-3333-4333-8333-333333333333',
          name: 'strain',
          baseKind: 'strain',
          displayName: 'Strain',
          version: 1,
        },
      ],
      schemaRevisions: [],
      entities: [],
      entityRevisions: [],
      relationships: [],
      placements: [],
      pendingMutations: [],
      conflicts: [],
    };
    mocks.listOrganizations.mockResolvedValue({
      ok: true,
      organizations: [
        {
          orgId,
          slug: 'acme',
          displayName: 'Acme Bio',
          role: 'member',
          canCreateManagedProjects: true,
          isAdministrator: false,
        },
      ],
    });
    mocks.syncOrganizationRegistry.mockResolvedValue({
      ok: true,
      sync: { status: 'ready', cursor: 4, pendingCount: 0, conflictCount: 0 },
      registry: emptyRegistry,
    });
    const preparedClaim = {
      mutationId: '44444444-4444-4444-8444-444444444444',
      sourceEntityId: local.id,
      sourceRegistryId: local.registryId,
      sourceRevision: 'a'.repeat(64),
      homeWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      homeProjectUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      homeProjectName: 'My Project',
      payload: {
        id: local.id,
        homeWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        schemaId: emptyRegistry.schemas[0].id,
        schemaRevisionId: emptyRegistry.schemas[0].currentRevisionId,
        kind: local.kind,
        name: local.name,
        fields: local.fields,
        claimProvenance: { clientId: 'desktop:test-device', localEntityId: local.id },
      },
    };
    mocks.prepareOrganizationRegistryClaim.mockResolvedValue({ ok: true, claim: preparedClaim });
    mocks.claimOrganizationRegistryEntity.mockResolvedValue({
      ok: true,
      mutationId: preparedClaim.mutationId,
      registration: 'registered',
      sync: { status: 'ready', cursor: 5, pendingCount: 0, conflictCount: 0 },
      registry: {
        ...emptyRegistry,
        state: { ...emptyRegistry.state, cursor: 5 },
        entities: [
          {
            id: local.id,
            homeWorkspaceId: preparedClaim.homeWorkspaceId,
            registryId: 'ACME-0001',
            name: local.name,
            kind: local.kind,
            revision: 1,
            fields: local.fields,
          },
        ],
      },
    });

    render(<LimsPanel />);
    await screen.findByTestId(`lims-registry-compact-row-${local.id}`);
    await browseOrganizationRegistry();
    await screen.findByText(/no canonical records exist/i);
    fireEvent.click(screen.getByRole('button', { name: 'Registry actions' }));
    fireEvent.click(screen.getByRole('button', { name: /claim local records/i }));

    const source = await screen.findByTestId(`registry-claim-record-${local.id}`);
    fireEvent.click(within(source).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /review 1 record/i }));
    await screen.findByText('Fields to register');
    expect(screen.getByTestId(`registry-claim-preview-${local.id}`)).toHaveTextContent(local.name);
    expect(screen.getByTestId(`registry-claim-home-${local.id}`)).toHaveAttribute(
      'title',
      preparedClaim.homeProjectUuid
    );
    expect(mocks.mutateOrganizationRegistry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /confirm and register 1 record/i }));

    expect(mocks.prepareOrganizationRegistryClaim).toHaveBeenCalledWith(orgId, {
      entityId: local.id,
      schemaId: preparedClaim.payload.schemaId,
      schemaRevisionId: preparedClaim.payload.schemaRevisionId,
    });
    await waitFor(() => expect(mocks.claimOrganizationRegistryEntity).toHaveBeenCalledOnce());
    expect(mocks.claimOrganizationRegistryEntity).toHaveBeenCalledWith(orgId, {
      mutationId: preparedClaim.mutationId,
      entityId: local.id,
      schemaId: preparedClaim.payload.schemaId,
      schemaRevisionId: preparedClaim.payload.schemaRevisionId,
      sourceRevision: preparedClaim.sourceRevision,
    });
    expect(mocks.mutateOrganizationRegistry).not.toHaveBeenCalled();
  });

  it('places an organization record in the bound project through the durable mutation path', async () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const remoteWorkspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const workspacePath = '/projects/placement-target';
    const insertedWorkspace = mocks
      .database!.prepare(
        `INSERT INTO workspaces (name, path, created_at, repo_uuid) VALUES (?, ?, ?, ?)`
      )
      .run('Placement target', workspacePath, 1, 'local-placement-target');
    mocks
      .database!.prepare(
        `INSERT INTO workspace_sync_bindings (
           workspace_id, workspace_uuid, owner_account_id, owner_org_id,
           remote_workspace_id, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        insertedWorkspace.lastInsertRowid,
        'local-placement-target',
        'account-1',
        orgId,
        remoteWorkspaceId,
        1,
        1
      );
    useWorkspaceStore.setState({
      folders: [{ path: workspacePath, name: 'Placement target', addedAt: 1 }],
      selectedPath: workspacePath,
    });
    const registry = {
      orgId,
      state: {
        cursor: 2,
        status: 'ready' as const,
        clientId: 'desktop:test',
        lastPullAt: 1,
        lastPushAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      idSchemes: [],
      schemas: [],
      schemaRevisions: [],
      entities: [
        {
          id: 'entity-place',
          registryId: 'ACME-0009',
          name: 'Project reagent',
          kind: 'reagent',
          revision: 1,
          fields: {},
        },
      ],
      entityRevisions: [],
      relationships: [],
      placements: [],
      pendingMutations: [],
      conflicts: [],
    };
    mocks.listOrganizations.mockResolvedValue({
      ok: true,
      organizations: [
        {
          orgId,
          slug: 'acme',
          displayName: 'Acme Bio',
          role: 'member',
          canCreateManagedProjects: true,
          isAdministrator: false,
        },
      ],
    });
    mocks.syncOrganizationRegistry.mockResolvedValue({
      ok: true,
      sync: { status: 'ready', cursor: 2, pendingCount: 0, conflictCount: 0 },
      registry,
    });
    mocks.mutateOrganizationRegistry.mockResolvedValue({
      ok: true,
      mutationId: '44444444-4444-4444-8444-444444444444',
      sync: { status: 'ready', cursor: 3, pendingCount: 0, conflictCount: 0 },
      registry: {
        ...registry,
        placements: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            entityId: 'entity-place',
            workspaceId: remoteWorkspaceId,
            path: null,
            resourceId: null,
          },
        ],
      },
    });

    mocks.listSyncedProjects.mockResolvedValue([
      { remoteWorkspaceId, displayName: 'Placement target', ownerOrgId: orgId },
    ]);
    render(<LimsPanel />);
    await expandRegistry();
    await browseOrganizationRegistry();
    await chooseReferenceProject(remoteWorkspaceId);
    fireEvent.click(
      await screen.findByRole('button', { name: /add reference in placement target/i })
    );

    await waitFor(() => expect(mocks.mutateOrganizationRegistry).toHaveBeenCalledOnce());
    expect(mocks.mutateOrganizationRegistry).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        operation: 'placement.add',
        payload: expect.objectContaining({
          entityId: 'entity-place',
          workspaceId: remoteWorkspaceId,
        }),
      })
    );
    const request = mocks.mutateOrganizationRegistry.mock.calls[0]?.[1];
    expect(request?.payload).not.toHaveProperty('path');
    expect(request?.payload).not.toHaveProperty('resourceId');
  });

  it('the Sequences door serves a SEQUENCE file filter (.gb/.dna/.fasta), not the tabular filter', async () => {
    render(<LimsPanel />);

    openWizardForKind('sequence');
    const seqAccept = (await screen.findByTestId('lims-import-drop-input')).getAttribute('accept');
    expect(seqAccept).toContain('.gb');
    expect(seqAccept).toContain('.fasta');
    expect(seqAccept).toContain('.dna');
    expect(seqAccept).not.toContain('.csv');

    fireEvent.click(screen.getByTestId('lims-import-step-type'));
    fireEvent.click(await screen.findByTestId('lims-import-type-oligo'));
    const tableAccept = (await screen.findByTestId('lims-import-drop-input')).getAttribute(
      'accept'
    );
    expect(tableAccept).toContain('.csv');
    expect(tableAccept).toContain('.xlsx');
    expect(tableAccept).not.toContain('.gb');
  });

  it('requires a Registry-origin import to choose a destination instead of inheriting Files state', async () => {
    useWorkspaceStore.setState({
      folders: [
        { path: '/projects/alpha', name: 'Alpha', addedAt: 1 },
        { path: '/projects/beta', name: 'Beta', addedAt: 2 },
      ],
      selectedPath: '/projects/beta',
    });
    render(<LimsPanel />);

    openWizardForKind('oligo', null);
    fireEvent.click(await screen.findByTestId('lims-import-data-tab-paste'));
    fireEvent.change(await screen.findByTestId('lims-import-paste-input'), {
      target: { value: 'Name,Sequence\nRegistry oligo,ACGTACGTACGTACGTACGT' },
    });
    fireEvent.click(screen.getByTestId('lims-import-paste-preview'));
    await screen.findByTestId('lims-import-plan-overlay');
    fireEvent.click(screen.getByTestId('lims-import-next'));

    expect(await screen.findByTestId('lims-import-destination-unset')).toBeVisible();
    expect(screen.getByTestId('lims-import-apply')).toBeDisabled();
  });

  it('preserves the exact Files-context folder as the import destination', async () => {
    useWorkspaceStore.setState({
      folders: [
        { path: '/projects/alpha', name: 'Alpha', addedAt: 1 },
        { path: '/projects/beta', name: 'Beta', addedAt: 2 },
      ],
      selectedPath: '/projects/beta',
    });
    render(<LimsPanel />);

    openWizardForKind('oligo', '/projects/alpha');
    fireEvent.click(await screen.findByTestId('lims-import-data-tab-paste'));
    fireEvent.change(await screen.findByTestId('lims-import-paste-input'), {
      target: { value: 'Name,Sequence\nFiles oligo,ACGTACGTACGTACGTACGT' },
    });
    fireEvent.click(screen.getByTestId('lims-import-paste-preview'));
    await screen.findByTestId('lims-import-plan-overlay');
    fireEvent.click(screen.getByTestId('lims-import-next'));

    expect(await screen.findByTestId('lims-import-destination-current')).toHaveTextContent('Alpha');
    expect(screen.getByTestId('lims-import-apply')).toBeEnabled();
  });

  it('previews imported primer CSV records and rejects one on the Review step', async () => {
    await mocks.bridge!.registerEntity({
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
      },
      id: 'plasmid-puc19',
    });
    render(<LimsPanel />);

    const csv = [
      'Name,Sequence,Target,Direction',
      'Primer A,GTAAAACGACGGCCAGT,pUC19,Forward',
      'Primer B,CAGGAAACAGCTATGAC,pUC19,Reverse',
    ].join('\n');
    const file = new File([csv], 'primers.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });

    await importFileViaWizard('oligo', file);

    await screen.findByTestId('lims-import-plan-overlay');
    expect(screen.getByTestId('lims-import-plan-source')).toHaveTextContent('primers.csv');
    expect(screen.getByTestId('lims-import-status-line')).toHaveTextContent('2 oligos');
    expect(screen.getByTestId('lims-import-status-line')).toHaveTextContent('2 new');
    expect(screen.queryByTestId('lims-import-summary')).not.toBeInTheDocument();

    expect(screen.getByTestId('lims-import-table')).toBeInTheDocument();
    const rowA = await screen.findByTestId('lims-import-record-row-2');
    expect(rowA).toHaveTextContent('Primer A');
    expect(rowA).toHaveTextContent('GTAAAACGACGGCCAGT');
    expect(rowA).toHaveTextContent('pUC19');

    fireEvent.click(screen.getByTestId('lims-import-record-row-3-accepted'));
    fireEvent.click(await screen.findByTestId('lims-import-next'));
    await waitFor(() =>
      expect(screen.getByTestId('lims-import-apply')).toHaveTextContent('Add 1 DNA oligo')
    );
  });

  it('routes an RNA oligo import through the shared file-authoritative oligo writer', async () => {
    const container = mkdtempSync(join(tmpdir(), 'managed-workspaces-'));
    const workspaceRoot = join(container, 'repo');
    const destinationDir = join(workspaceRoot, 'orders', 'august');
    mkdirSync(destinationDir, { recursive: true });
    mocks.mintedWorkspaceDirs.push(container);
    mocks
      .database!.prepare('INSERT INTO workspaces (name,path,created_at) VALUES (?,?,?)')
      .run('Oligo workspace', workspaceRoot, Date.now());
    mocks.readDir.mockImplementation(async (path: string) => {
      if (path === workspaceRoot) {
        return [{ name: 'orders', isDirectory: true, isFile: false }];
      }
      if (path === join(workspaceRoot, 'orders')) {
        return [{ name: 'august', isDirectory: true, isFile: false }];
      }
      return [];
    });
    useWorkspaceStore.setState({
      folders: [{ path: workspaceRoot, name: 'Oligo workspace', addedAt: 1 }],
      selectedPath: destinationDir,
    });
    render(<LimsPanel />);
    const notation = '/5Phos/rArCrGrUrArCrGrUrArC';
    const csv = `Name,Sequence,Vendor,Purification\nRNA import,${notation},IDT,HPLC`;
    const file = new File([csv], 'rna-oligos.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });

    await importFileViaWizard('rna_oligo', file);
    await screen.findByTestId('lims-import-plan-overlay');
    expect(screen.getByTestId('lims-import-status-line')).toHaveTextContent('1 oligo');
    fireEvent.click(await screen.findByTestId('lims-import-next'));
    const ordersPath = join(workspaceRoot, 'orders');
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId('file-tree-item')
          .some((row) => row.getAttribute('data-entry-path') === ordersPath)
      ).toBe(true)
    );
    const ordersRow = screen
      .getAllByTestId('file-tree-item')
      .find((row) => row.getAttribute('data-entry-path') === ordersPath);
    if (!ordersRow) throw new Error('orders destination row did not render');
    fireEvent.click(ordersRow);
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId('file-tree-item')
          .some((row) => row.getAttribute('data-entry-path') === destinationDir)
      ).toBe(true)
    );
    const destinationRow = screen
      .getAllByTestId('file-tree-item')
      .find((row) => row.getAttribute('data-entry-path') === destinationDir);
    if (!destinationRow) throw new Error('nested destination row did not render');
    fireEvent.click(destinationRow);
    fireEvent.click(await screen.findByTestId('lims-import-apply'));

    await waitFor(() => expect(mocks.recordImportedPrimers).toHaveBeenCalledTimes(1));
    const [plan, destination] = mocks.recordImportedPrimers.mock.calls[0];
    expect(destination).toEqual({
      workspaceRoot,
      destinationDir,
      source: { text: csv },
    });
    expect(plan.records[0]).toMatchObject({
      accepted: true,
      entityDraft: {
        kind: 'rna_oligo',
        fields: { sequence: { mode: 'inline', bases: 'ACGUACGUAC' } },
      },
      source: { Sequence: notation },
    });
    await waitFor(() =>
      expect(screen.queryByTestId('lims-import-plan-overlay')).not.toBeInTheDocument()
    );
  });

  it('routes protein tables through the same file-authoritative writer as scratch proteins', async () => {
    const container = mkdtempSync(join(tmpdir(), 'managed-workspaces-'));
    const workspaceRoot = join(container, 'repo');
    const destinationDir = join(workspaceRoot, 'proteins');
    mkdirSync(destinationDir, { recursive: true });
    mocks.mintedWorkspaceDirs.push(container);
    mocks
      .database!.prepare('INSERT INTO workspaces (name,path,created_at) VALUES (?,?,?)')
      .run('Protein workspace', workspaceRoot, Date.now());
    useWorkspaceStore.setState({
      folders: [{ path: workspaceRoot, name: 'Protein workspace', addedAt: 1 }],
      selectedPath: destinationDir,
    });
    render(<LimsPanel />);
    const csv = 'Name,Sequence,Organism\nImported protein,ACDEFGHIK,Escherichia coli';
    const file = new File([csv], 'proteins.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });

    openWizardForKind('protein');
    fireEvent.change(await screen.findByTestId('lims-import-drop-input'), {
      target: { files: [file] },
    });
    await screen.findByTestId('lims-import-plan-overlay');
    await applyImportUnit(workspaceRoot);

    await waitFor(() => expect(mocks.recordImportedProteins).toHaveBeenCalledTimes(1));
    const [plan, destination] = mocks.recordImportedProteins.mock.calls[0];
    expect(destination).toEqual({
      workspaceRoot,
      destinationDir: workspaceRoot,
      source: { text: csv },
    });
    expect(plan.records[0]).toMatchObject({
      accepted: true,
      entityDraft: {
        kind: 'protein',
        name: 'Imported protein',
        fields: {
          sequence: { mode: 'inline', aminoAcids: 'ACDEFGHIK' },
          organism: 'Escherichia coli',
        },
      },
    });
    await waitFor(() =>
      expect(screen.queryByTestId('lims-import-plan-overlay')).not.toBeInTheDocument()
    );
  });

  it('reports a protein import as completed when only the Registry refresh fails', async () => {
    const defaultProteinWriter = mocks.recordImportedProteins.getMockImplementation();
    if (!defaultProteinWriter) throw new Error('default protein import mock is missing');
    mocks.recordImportedProteins.mockImplementationOnce(async (...args) => {
      const result = await defaultProteinWriter(...args);
      mocks.queryRegistryOverride = async () => {
        throw new Error('simulated registry refresh outage');
      };
      return result;
    });
    render(<LimsPanel />);
    const csv = 'Name,Sequence\nImported protein,ACDEFGHIK';
    const file = new File([csv], 'proteins.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });

    openWizardForKind('protein');
    fireEvent.change(await screen.findByTestId('lims-import-drop-input'), {
      target: { files: [file] },
    });
    await screen.findByTestId('lims-import-plan-overlay');
    await applyImportUnit();

    const errorText = await screen.findByText(userMessage('registry.refreshFailed'));
    expect(errorText.closest('div')?.className).toContain('text-error');
    expect(importEventNames(), JSON.stringify(mocks.trackRendererEvent.mock.calls)).toEqual([
      'import_started',
      'import_completed',
    ]);
    expect(screen.queryByText(/Protein import failed/i)).toBeNull();
  });

  it('emits completed and failed when a primer import lands partially', async () => {
    mocks.recordImportedPrimers.mockResolvedValueOnce({
      added: 1,
      skipped: 0,
      failed: 1,
      failures: [{ name: 'Primer B', message: 'simulated write failure' }],
      artifactRelativePaths: ['Primer-A.primer.json'],
      importSet: { id: 'import-set-test', manifestRelativePath: '.waypoint/import-sets/test.json' },
      members: [],
      partition: { plan: null, members: [] },
    });
    render(<LimsPanel />);

    const csv = ['Name,Sequence', 'Primer A,GTAAAACGACGGCCAGT', 'Primer B,CAGGAAACAGCTATGAC'].join(
      '\n'
    );
    const file = new File([csv], 'private-primer-order.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });

    await importFileViaWizard('oligo', file);
    await screen.findByTestId('lims-import-plan-overlay');
    await applyImportUnit();

    await waitFor(() =>
      expect(importEventNames()).toEqual(['import_started', 'import_completed', 'import_failed'])
    );
    expect(mocks.trackRendererEvent).toHaveBeenCalledWith(
      'import_completed',
      expect.objectContaining({ record_count_bucket: '1' })
    );
    expect(mocks.trackRendererEvent).toHaveBeenCalledWith(
      'import_failed',
      expect.objectContaining({ error_class: 'primer_items_failed' })
    );
    expect(JSON.stringify(mocks.trackRendererEvent.mock.calls)).not.toContain('private-primer');
  });

  it('emits one accepted funnel when the LIMS Import button applies a tabular plan', async () => {
    render(<LimsPanel />);

    const csv = ['Strain,Genotype', 'Telemetry strain,delta-lacZ'].join('\n');
    const file = new File([csv], 'private-patient-strains.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });

    await importFileViaWizard('strain', file);
    await screen.findByTestId('lims-import-plan-overlay');
    await applyImportUnit();

    await waitFor(() => expect(importEventNames()).toEqual(['import_started', 'import_completed']));
    const [strain] = await mocks.bridge!.queryEntities({
      kind: 'strain',
      nameLike: 'Telemetry strain',
    });
    const artifact = strain.fields.artifact as { relativePath: string };
    expect(artifact.relativePath).toMatch(/\.entity\.json$/);
    expect(existsSync(join(mocks.mintedWorkspaceDirs[0], 'repo', artifact.relativePath))).toBe(
      true
    );
    expect(mocks.trackRendererEvent).toHaveBeenCalledWith(
      'import_completed',
      expect.objectContaining({
        file_type_category: 'spreadsheet',
        record_count_bucket: '1',
      })
    );
    expect(JSON.stringify(mocks.trackRendererEvent.mock.calls)).not.toContain('private-patient');
  });

  it('preserves imported files and the active record when Undo rejects an edited batch', async () => {
    render(<LimsPanel />);
    const csv = 'Strain,Genotype\nUndo protected strain,delta-lacZ';
    const file = new File([csv], 'undo-protected-strains.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });
    await importFileViaWizard('strain', file);
    await screen.findByTestId('lims-import-plan-overlay');
    await applyImportUnit();
    await waitFor(() => expect(importEventNames()).toEqual(['import_started', 'import_completed']));
    const [strain] = await ops().queryEntities({
      kind: 'strain',
      nameLike: 'Undo protected strain',
    });
    const artifact = strain.fields.artifact as { relativePath: string };
    const path = join(mocks.mintedWorkspaceDirs[0], 'repo', artifact.relativePath);
    const bytes = readFileSync(path, 'utf8');
    await ops().updateEntity({ id: strain.id, name: 'Edited after import' });
    const undo = vi.spyOn(ops(), 'undoImportBatch');
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(await screen.findByTestId('lims-undo-last-import'));

    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    await screen.findByText(userMessage('registry.undoChanged'));
    expect((await ops().queryEntities({ id: strain.id }))[0].name).toBe('Edited after import');
    expect(screen.getByTestId('lims-undo-last-import')).toBeInTheDocument();
  });

  it('WARNS on a primer matching an existing sequence but keeps it importable on Review ', async () => {
    await mocks.bridge!.registerEntity({
      kind: 'oligo',
      name: 'Existing Primer',
      fields: {
        use: 'primer',
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
      },
      registrationStatus: 'registered',
      id: 'existing-primer',
    });
    render(<LimsPanel />);

    const csv = ['Name,Sequence', 'Incoming Primer,GTAAAACGACGGCCAGT'].join('\n');
    const file = new File([csv], 'duplicate-primer.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });

    await importFileViaWizard('oligo', file);

    await screen.findByTestId('lims-import-plan-overlay');

    expect(screen.getByTestId('lims-import-record-row-2-accepted')).toBeChecked();
    expect(screen.getByTestId('lims-import-record-row-2-reason')).toHaveTextContent(
      /already has this sequence/i
    );
    expect(screen.queryByTestId('lims-import-done')).not.toBeInTheDocument();
    expect(screen.getByTestId('lims-import-next')).toBeEnabled();
  });

  it('shows the file’s own columns; a file it cannot auto-map stays unimportable (mapping deferred)', async () => {
    render(<LimsPanel />);

    const csv = [
      'Primer Label,Bases,Comment',
      'Mapped Primer,GTAAAACGACGGCCAGT,manual mapping',
    ].join('\n');
    const file = new File([csv], 'weird-primer-export.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });

    await importFileViaWizard('oligo', file);

    await screen.findByTestId('lims-import-plan-overlay');

    const table = screen.getByTestId('lims-import-table');
    expect(table).toHaveTextContent('Primer Label');
    expect(table).toHaveTextContent('Bases');
    expect(table).toHaveTextContent('Comment');
    expect(table).toHaveTextContent('Mapped Primer');
    expect(table).toHaveTextContent('manual mapping');

    expect(screen.getByTestId('lims-import-next')).toBeDisabled();
  });

  it('maps each column to a field via a per-column dropdown, and can re-map', async () => {
    render(<LimsPanel />);

    const csv = ['Strain,Genotype,Owner', 'S1,ΔlacZ,Peter'].join('\n');
    const file = new File([csv], 'strains.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });
    await importFileViaWizard('strain', file);

    const ownerMap = await screen.findByTestId('lims-import-colmap-Owner');
    expect(screen.getByTestId('lims-import-colmap-Strain')).toHaveAttribute(
      'data-value',
      'entity.name'
    );
    expect(screen.getByTestId('lims-import-colmap-Genotype')).toHaveAttribute(
      'data-value',
      'fields.genotypeCanonical'
    );

    expect(ownerMap).toHaveAttribute('data-value', '');

    fireEvent.click(ownerMap);
    fireEvent.click(await screen.findByTestId('lims-import-colopt-Owner-fields.source'));
    await waitFor(() =>
      expect(screen.getByTestId('lims-import-colmap-Owner')).toHaveAttribute(
        'data-value',
        'fields.source'
      )
    );
  });

  it('flags a duplicate field mapping on BOTH columns and blocks Apply — no silent unmapping', async () => {
    render(<LimsPanel />);

    const csv = ['Strain,Genotype', 'S1,ΔlacZ'].join('\n');
    const file = new File([csv], 'strains.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });
    await importFileViaWizard('strain', file);

    const strainMap = await screen.findByTestId('lims-import-colmap-Strain');
    fireEvent.click(strainMap);
    fireEvent.click(
      await screen.findByTestId('lims-import-colopt-Strain-fields.genotypeCanonical')
    );

    await waitFor(() =>
      expect(screen.getByTestId('lims-import-colmap-Strain')).toHaveAttribute(
        'data-value',
        'fields.genotypeCanonical'
      )
    );
    expect(screen.getByTestId('lims-import-colmap-Genotype')).toHaveAttribute(
      'data-value',
      'fields.genotypeCanonical'
    );

    expect(screen.getAllByTestId('lims-import-colmap-duplicate')).toHaveLength(2);
    expect(screen.getByTestId('lims-import-duplicate-banner')).toBeInTheDocument();
    expect(screen.getByTestId('lims-import-next')).toBeDisabled();
  });

  it('previews the auto-assigned registry ID READ-ONLY (prefix is per-type config, not set here)', async () => {
    render(<LimsPanel />);

    const csv = ['Strain,Genotype', 'S1,ΔlacZ', 'S2,ΔaraB'].join('\n');
    const file = new File([csv], 'strains.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });
    await importFileViaWizard('strain', file);

    const statusLine = await screen.findByTestId('lims-import-status-line');
    await waitFor(() => expect(statusLine).toHaveTextContent('s000001'));
    expect(statusLine).toHaveTextContent('s000002');
    expect(screen.getAllByText('s000001').length).toBeGreaterThan(0);

    expect(screen.queryByTestId('lims-import-id-prefix')).not.toBeInTheDocument();
  });

  it('opens a primer CSV dev scenario directly into the import review flow', async () => {
    render(<LimsPanel />);
    await expandRegistry();

    fireEvent.change(screen.getByTestId('lims-dev-scenario-picker'), {
      target: { value: 'primer-csv' },
    });

    await screen.findByTestId('lims-import-plan-overlay');
    expect(screen.getByTestId('lims-import-plan-source')).toHaveTextContent(
      'primers-alt-headers.csv'
    );
    expect(screen.getByTestId('lims-import-status-line')).toHaveTextContent('8 oligos');
    expect(screen.getByTestId('lims-import-status-line')).toHaveTextContent('8 new');
    expect(screen.getByTestId('lims-import-table')).toBeInTheDocument();
    expect(screen.getByTestId('lims-import-record-row-2')).toHaveTextContent('OL001');
    expect(screen.getByTestId('lims-import-record-row-2')).toHaveTextContent('ATGCGATCGATCGATCG');
  });

  it('opens a messy primer CSV scenario with source-only provenance columns', async () => {
    render(<LimsPanel />);
    await expandRegistry();

    fireEvent.change(screen.getByTestId('lims-dev-scenario-picker'), {
      target: { value: 'messy-primer-csv' },
    });

    await screen.findByTestId('lims-import-plan-overlay');
    expect(screen.getByTestId('lims-import-plan-source')).toHaveTextContent(
      'messy-primer-order-sheet.csv'
    );
    expect(screen.getByTestId('lims-import-status-line')).toHaveTextContent('3 oligos');
    expect(screen.getByTestId('lims-import-status-line')).toHaveTextContent('3 new');
    expect(screen.getByTestId('lims-import-table')).toBeInTheDocument();
    const messyRow = screen.getByTestId('lims-import-record-row-2');
    expect(messyRow).toHaveTextContent('MP001');
    expect(messyRow).toHaveTextContent('GTAAAACGACGGCCAGT');

    expect(messyRow).toHaveTextContent('Peter');
    expect(messyRow).toHaveTextContent('IDT');
    expect(messyRow).toHaveTextContent('Box A');
  });

  it('imports a sequence file through the Sequences door as a managed DNA sequence', async () => {
    const registration = vi.spyOn(nativeSequenceImport, 'registerImportedSequenceFromContent');
    restoreNativeRegistration = () => registration.mockRestore();
    const chromosomeGenBank = [
      'LOCUS       SYNTH_CHR1               120 bp    DNA     linear   BCT 20-JUL-2026',
      'DEFINITION  Synthetic test chromosome 1, complete sequence.',
      'ACCESSION   SYNTH_CHR1',
      'VERSION     SYNTH_CHR1.1',
      'FEATURES             Location/Qualifiers',
      '     source          1..120',
      '                     /organism="synthetic construct"',
      '                     /mol_type="genomic DNA"',
      '                     /chromosome="1"',
      'ORIGIN',
      '        1 atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc',
      '       61 atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc atgcatgcat gcatgcatgc',
      '//',
      '',
    ].join('\n');
    const fixtureDir = mkdtempSync(join(tmpdir(), 'lims-chr-source-'));
    mocks.mintedWorkspaceDirs.push(fixtureDir);
    const fixturePath = join(fixtureDir, 'SYNTH_CHR1.gb');
    writeFileSync(fixturePath, chromosomeGenBank);

    render(<LimsPanel />);

    const file = new File([chromosomeGenBank], 'SYNTH_CHR1.gb', { type: 'text/plain' });
    Object.defineProperty(file, 'path', { value: fixturePath });
    Object.defineProperty(file, 'text', { value: async () => chromosomeGenBank });

    await importFileViaWizard('sequence', file);

    await screen.findByTestId('lims-import-plan-overlay');
    expect(screen.getByTestId('lims-import-status-line')).toHaveTextContent('sequence file');
    await screen.findByTestId('lims-import-record-sequence-file-1');

    await waitFor(() => expect(screen.getByTestId('lims-import-next')).toBeEnabled());
    await applyImportUnit();

    await waitFor(() => expect(registration).toHaveBeenCalled());
    const req = registration.mock.calls[0][0];
    expect(req.content).toBe(chromosomeGenBank);
    expect(req.fileName).toBe('SYNTH_CHR1.gb');
    expect(req.kind).toBe('sequence');
    expect(req.targetRoot).toContain('managed-workspaces');
    expect(mocks.trackRendererEvent).toHaveBeenCalledWith('workspace_created', {
      feature_area: 'workspace',
    });
    await waitFor(() => expect(importEventNames()).toEqual(['import_started', 'import_completed']));

    await waitFor(async () => {
      const sequences = await mocks.bridge!.queryEntities({ kind: 'sequence', limit: 50 });
      const fileBacked = sequences.find(
        (e) => (e.fields.sequence as { mode?: string } | undefined)?.mode === 'file'
      );
      const relPath = (fileBacked?.fields.sequence as { relPath?: string } | undefined)?.relPath;
      expect(relPath).toBeTruthy();
      expect(relPath).not.toBe(fixturePath);
      expect(relPath).toContain('managed-workspaces');
    });
  });

  it('surfaces an honest reconcile error when the copy lands but DB registration fails', async () => {
    const registration = vi.spyOn(nativeSequenceImport, 'registerImportedSequenceFromContent');
    restoreNativeRegistration = () => registration.mockRestore();
    registration.mockResolvedValueOnce({
      destPath: '/managed/copied-pUC19.gb',
      relPath: 'copied-pUC19.gb',
      committed: true,
      copySkipped: false,
      registered: false,
      batchId: null,
      entityIds: [],
      reason:
        'The file was imported, but registry registration failed: simulated DB preflight failure',
    });

    const fixturePath = resolve(
      __dirname,
      '../../../../../../test-fixtures/sequences/circular/pUC19.gb'
    );
    const fixtureContent = readFileSync(fixturePath, 'utf8');

    render(<LimsPanel />);

    const file = new File([fixtureContent], 'pUC19.gb', { type: 'text/plain' });
    Object.defineProperty(file, 'path', { value: fixturePath });
    Object.defineProperty(file, 'text', { value: async () => fixtureContent });

    await importFileViaWizard('sequence', file);

    await screen.findByTestId('lims-import-record-sequence-file-1');
    await waitFor(() => expect(screen.getByTestId('lims-import-next')).toBeEnabled());
    await applyImportUnit();

    await waitFor(() => expect(registration).toHaveBeenCalled());

    const errorText = await screen.findByText(
      /file was imported, but registry registration failed/i
    );

    expect(screen.queryByText(/Imported .+ into/i)).toBeNull();

    const bar = errorText.closest('div');
    expect(bar?.className).toContain('text-error');
    expect(bar?.className).not.toContain('text-success');
    expect(importEventNames()).toEqual(['import_started', 'import_completed', 'import_failed']);
  });

  it('records failure only when sequence registration rejects without a durable write result', async () => {
    const registration = vi.spyOn(nativeSequenceImport, 'registerImportedSequenceFromContent');
    restoreNativeRegistration = () => registration.mockRestore();
    registration.mockRejectedValueOnce(new Error('simulated source read failure before copy'));

    const fixturePath = resolve(
      __dirname,
      '../../../../../../test-fixtures/sequences/circular/pUC19.gb'
    );
    const fixtureContent = readFileSync(fixturePath, 'utf8');

    render(<LimsPanel />);

    const file = new File([fixtureContent], 'pUC19.gb', { type: 'text/plain' });
    Object.defineProperty(file, 'path', { value: fixturePath });
    Object.defineProperty(file, 'text', { value: async () => fixtureContent });
    await importFileViaWizard('sequence', file);

    await screen.findByTestId('lims-import-record-sequence-file-1');
    await waitFor(() => expect(screen.getByTestId('lims-import-next')).toBeEnabled());
    await applyImportUnit();

    const errorText = await screen.findByText(userMessage('registry.importFailed'));
    const bar = errorText.closest('div');
    expect(bar?.className).toContain('text-error');
    expect(screen.queryByText(/Imported .+ into/i)).toBeNull();
    expect(importEventNames()).toEqual(['import_started', 'import_failed']);
  });

  it('does not emit a second import outcome when the post-import registry refresh fails', async () => {
    const defaultRegister = nativeSequenceImport.registerImportedSequenceFromContent;
    const registration = vi.spyOn(nativeSequenceImport, 'registerImportedSequenceFromContent');
    restoreNativeRegistration = () => registration.mockRestore();
    registration.mockImplementationOnce(async (...args) => {
      const result = await defaultRegister(...args);
      mocks.queryRegistryOverride = async () => {
        throw new Error('simulated registry refresh outage');
      };
      return result;
    });

    const fixturePath = resolve(
      __dirname,
      '../../../../../../test-fixtures/sequences/circular/pUC19.gb'
    );
    const fixtureContent = readFileSync(fixturePath, 'utf8');

    const firstRoot = (await mocks.createEmptyWorkspace({ name: 'Current workspace' })).rootPath;
    const secondRoot = (await mocks.createEmptyWorkspace({ name: 'Previous destination' }))
      .rootPath;
    useWorkspaceStore.setState({
      folders: [
        { path: firstRoot, name: 'Current workspace', addedAt: 1 },
        { path: secondRoot, name: 'Previous destination', addedAt: 2 },
      ],
      selectedPath: join(firstRoot, 'active.gb'),
    });

    render(<LimsPanel />);

    const file = new File([fixtureContent], 'pUC19.gb', { type: 'text/plain' });
    Object.defineProperty(file, 'path', { value: fixturePath });
    Object.defineProperty(file, 'text', { value: async () => fixtureContent });
    await importFileViaWizard('sequence', file);

    await screen.findByTestId('lims-import-record-sequence-file-1');
    await waitFor(() => expect(screen.getByTestId('lims-import-next')).toBeEnabled());
    fireEvent.click(await screen.findByTestId('lims-import-next'));
    fireEvent.click(await screen.findByTestId(`lims-import-destination-folder-${secondRoot}`));
    expect(screen.getByTestId('lims-import-destination-current')).toHaveTextContent(
      'Previous destination'
    );
    fireEvent.click(await screen.findByTestId('lims-import-apply'));

    const errorText = await screen.findByText(userMessage('registry.refreshFailed'));
    const bar = errorText.closest('div');
    expect(bar?.className).toContain('text-error');
    expect(importEventNames()).toEqual(['import_started', 'import_completed']);

    openWizardForKind('oligo');
    const nextSource = 'Name,Sequence\nNext primer,ATGCGATCGATCGATCG';
    const nextFile = new File([nextSource], 'next-primer.csv', { type: 'text/csv' });
    Object.defineProperty(nextFile, 'text', { value: async () => nextSource });
    fireEvent.change(await screen.findByTestId('lims-import-drop-input'), {
      target: { files: [nextFile] },
    });
    await waitFor(() => expect(screen.getByTestId('lims-import-next')).toBeEnabled());
    fireEvent.click(screen.getByTestId('lims-import-next'));
    expect(await screen.findByTestId('lims-import-destination')).toHaveTextContent(
      'Choose a folder to continue.'
    );
    expect(screen.getByTestId('lims-import-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId(`lims-import-destination-folder-${firstRoot}`));
    expect(screen.getByTestId('lims-import-destination-current')).toHaveTextContent(
      'Current workspace'
    );
  });

  it('loads the Demo demo dataset and keeps strain evidence READ-ONLY in the record details', async () => {
    render(<LimsPanel />);

    loadDemo();

    await screen.findByText('Demo argF deletion strain');

    expect(await mocks.bridge!.queryEntities({ kind: 'genome' })).toHaveLength(3);

    const overlay = await expandRegistry();

    const strainRow = await screen.findByTestId('lims-registry-row-demo-dna509-strain-argf');
    expect(strainRow).not.toHaveTextContent('WGS verified with mismatch');

    fireEvent.click(strainRow);
    const preview = await screen.findByTestId('lims-registry-preview');
    await waitFor(() => expect(preview).toHaveTextContent('WGS verified with mismatch'));
    expect(preview).toHaveTextContent('Genome hypothesis disagrees with WGS');

    expect(screen.queryByTestId('lims-genome-gap-demo-dna509-strain-argf')).not.toBeInTheDocument();
    expect(
      within(overlay).queryByTestId('lims-attach-verified-demo-dna509-strain-argf')
    ).not.toBeInTheDocument();
  });

  it('selects compact sequence rows for the details sidebar without opening a tab', async () => {
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');

    fireEvent.click(
      await screen.findByTestId('lims-registry-compact-row-demo-dna509-plasmid-puc19')
    );

    expect(mocks.openLimsEntity).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('lims-registry-preview')).toHaveTextContent('pUC19')
    );
    expect(screen.getByTestId('lims-registry-overlay')).toBeInTheDocument();
  });

  it('provides an independent Open button directly on compact sequence rows', async () => {
    render(<LimsPanel />);
    loadDemo();
    const row = await screen.findByTestId('lims-registry-compact-row-demo-dna509-plasmid-puc19');

    fireEvent.click(within(row).getByRole('button', { name: 'Open pUC19' }));

    await waitFor(() =>
      expect(mocks.openLimsEntity).toHaveBeenCalledWith({
        entityId: 'demo-dna509-plasmid-puc19',
        strategy: { kind: 'focused' },
      })
    );
    expect(screen.getByTestId('lims-registry-compact')).toBeInTheDocument();
    expect(screen.queryByTestId('lims-registry-overlay')).not.toBeInTheDocument();
  });

  it('offers the same saved-primer Open action in both views and returns to the thin Registry', async () => {
    mocks.openLimsEntity.mockResolvedValueOnce({
      status: 'opened_primer',
      tabId: 'tab-primer-1',
      target: null,
    });
    const primer = await mocks.bridge!.registerEntity({
      kind: 'oligo',
      name: 'Saved registry primer',
      workspaceId: mocks.defaultProjectId,
      fields: {
        sequence: { mode: 'inline', bases: 'ACGTACGTACGT', length: 12, topology: 'linear' },
        artifact: { schema: 'dnaforge.primer', relativePath: 'primers/saved.primer.json' },
      },
    });
    render(<LimsPanel />);
    const compact = await screen.findByTestId(`lims-registry-compact-row-${primer.id}`);
    expect(within(compact).getByRole('button', { name: `Open ${primer.name}` })).toBeEnabled();
    fireEvent.click(compact);
    expect(mocks.openLimsEntity).not.toHaveBeenCalled();
    const details = await screen.findByTestId('lims-registry-preview');
    await waitFor(() => expect(details).toHaveTextContent(primer.name));

    const row = await screen.findByTestId(`lims-registry-row-${primer.id}`);
    fireEvent.click(within(row).getByRole('button', { name: `Open ${primer.name}` }));
    await waitFor(() =>
      expect(mocks.openLimsEntity).toHaveBeenCalledWith({
        entityId: primer.id,
        strategy: { kind: 'focused' },
      })
    );
    await screen.findByTestId('lims-registry-compact');
    expect(screen.queryByTestId('lims-registry-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('lims-panel')).toBeInTheDocument();
  });

  it('treats an explicit Open result of "opened_protein" identically to "opened"', async () => {
    mocks.openLimsEntity.mockResolvedValueOnce({
      status: 'opened_protein',
      tabId: 'tab-protein-1',
      target: null,
    });
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');

    fireEvent.click(
      await screen.findByTestId('lims-registry-compact-open-demo-dna509-plasmid-puc19')
    );

    await waitFor(() =>
      expect(mocks.openLimsEntity).toHaveBeenCalledWith({
        entityId: 'demo-dna509-plasmid-puc19',
        strategy: { kind: 'focused' },
      })
    );

    expect(screen.queryByText(/opened/i)).not.toBeInTheDocument();
  });

  it('treats an explicit Open result of "opened_notebook" identically to "opened"', async () => {
    mocks.openLimsEntity.mockResolvedValueOnce({
      status: 'opened_notebook',
      tabId: 'tab-notebook-1',
      target: null,
    });
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');

    fireEvent.click(
      await screen.findByTestId('lims-registry-compact-open-demo-dna509-plasmid-puc19')
    );

    await waitFor(() =>
      expect(mocks.openLimsEntity).toHaveBeenCalledWith({
        entityId: 'demo-dna509-plasmid-puc19',
        strategy: { kind: 'focused' },
      })
    );
    expect(screen.queryByText(/opened/i)).not.toBeInTheDocument();
  });

  it('uses a searchable registry table and preview instead of raw kind rows as the primary surface', async () => {
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    const plasmid = (await mocks.bridge!.queryEntities({ id: 'demo-dna509-plasmid-puc19' }))[0];
    const oligo = (await mocks.bridge!.queryEntities({ id: 'demo-dna509-oligo-m13-forward' }))[0];
    const sequence = plasmid.fields.sequence as FileDnaSequenceRef;
    expect(sequence.mode).toBe('file');
    mocks.sequenceDocument = {
      ref: { kind: 'catalog-sequence', entityId: sequence.documentId },
      documentId: sequence.documentId,
      sourcePath: sequence.relPath,
    };
    mocks.readTextFile.mockImplementation(async (path: string) => readFileSync(path, 'utf8'));
    await expandRegistry();

    const search = await screen.findByTestId('lims-registry-search');
    fireEvent.change(search, { target: { value: 'pUC19' } });

    const row = await screen.findByTestId(`lims-registry-row-${plasmid.id}`);
    expect(row).toHaveTextContent('pUC19');

    fireEvent.click(row);

    const preview = await screen.findByTestId('lims-registry-preview');
    await within(preview).findByTestId('lims-registry-record-fields');
    expect(preview).toHaveTextContent('pUC19');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row.className).toContain('bg-accent/15');
    expect(row.className).not.toContain('hover:bg-bg-muted');
    expect(preview).toHaveTextContent('SchemaPlasmid');
    expect(preview).toHaveTextContent('Size2,686');
    expect(
      within(preview).getByRole('status', { name: 'Topology', exact: true })
    ).toHaveTextContent(/^Circular$/);
    expect(within(preview).getByRole('button', { name: 'Open', exact: true })).toBeInTheDocument();
    expect(preview).not.toHaveTextContent('pUC19.gb');
    expect(preview.textContent ?? '').not.toMatch(/sha256:[0-9a-f]{64}/);
    expect(preview).toHaveTextContent('M13-Forward');

    fireEvent.click(screen.getByTestId(`lims-registry-link-preview-${oligo.id}`));
    await waitFor(() => expect(preview).toHaveAttribute('data-entity-id', oligo.id));
    await within(preview).findByTestId('lims-registry-record-fields');
    await waitFor(() =>
      expect(screen.getByTestId('lims-registry-preview')).toHaveTextContent('M13-Forward')
    );
    expect(screen.getByTestId('lims-registry-preview')).toHaveTextContent('SchemaDNA Oligo');
    expect(screen.getByTestId('lims-registry-preview')).toHaveTextContent('GTAAAACGACGGCCAGT');
    expect(screen.getByTestId('lims-registry-preview')).toHaveTextContent('pUC19');
    expect(screen.getByTestId('lims-registry-preview')).toHaveTextContent('associated with');
    expect(screen.getByTestId('lims-registry-preview')).not.toHaveTextContent('amplifies');
    expect(screen.getByTestId('lims-registry-preview')).not.toHaveTextContent('Inline sequence');
    expect(screen.getByTestId('lims-registry-preview')).not.toHaveTextContent('inline_sequence');
    expect(screen.getByTestId('lims-registry-preview')).not.toHaveTextContent('linear');
    expect(screen.getByTestId('lims-registry-preview').textContent ?? '').not.toMatch(
      /sha256:[0-9a-f]{64}/
    );

    fireEvent.change(search, { target: { value: 'M13-Forward' } });
    await screen.findByTestId(`lims-registry-row-${oligo.id}`);
    expect(screen.getByTestId(`lims-registry-row-${oligo.id}`)).not.toHaveTextContent(
      'GTAAAACGACGGCCAGT'
    );

    fireEvent.change(search, { target: { value: 'pUC19' } });
    const refreshedPuc19Row = await screen.findByTestId(`lims-registry-row-${plasmid.id}`);
    fireEvent.click(refreshedPuc19Row);
    await waitFor(() =>
      expect(screen.getByTestId('lims-registry-preview')).toHaveAttribute(
        'data-entity-id',
        plasmid.id
      )
    );
    const open = await within(screen.getByTestId('lims-registry-preview')).findByRole('button', {
      name: 'Open',
      exact: true,
    });
    fireEvent.click(open);

    await waitFor(() =>
      expect(mocks.openLimsEntity).toHaveBeenCalledWith({
        entityId: plasmid.id,
        strategy: { kind: 'focused' },
      })
    );
    await screen.findByTestId('lims-registry-compact');
    expect(screen.queryByTestId('lims-registry-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('lims-panel')).toBeInTheDocument();
  });

  it('refreshes the visible record after an external Registry edit', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    const plasmid = (await mocks.bridge!.queryEntities({ id: 'demo-dna509-plasmid-puc19' }))[0];
    const sequence = plasmid.fields.sequence as FileDnaSequenceRef;
    mocks.sequenceDocument = {
      ref: { kind: 'catalog-sequence', entityId: sequence.documentId },
      documentId: sequence.documentId,
      sourcePath: sequence.relPath,
    };
    mocks.readTextFile.mockImplementation(async (path: string) => readFileSync(path, 'utf8'));
    await expandRegistry();
    fireEvent.click(await screen.findByTestId('lims-registry-row-demo-dna509-plasmid-puc19'));
    const preview = await screen.findByTestId('lims-registry-preview');
    await within(preview).findByTestId('lims-registry-record-fields');
    expect(preview).toHaveTextContent(plasmid.name);
    await mocks.bridge!.updateEntity({
      id: 'demo-dna509-plasmid-puc19',
      name: 'Externally reviewed plasmid',
    });
    act(() => emitLimsRegistryChanged());
    await waitFor(() =>
      expect(screen.getByTestId('lims-registry-preview')).toHaveTextContent(
        'Externally reviewed plasmid'
      )
    );
  });

  it('an external Registry edit cannot supersede a pending human selection', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();
    fireEvent.click(await screen.findByTestId('lims-registry-row-demo-dna509-plasmid-puc19'));
    await screen.findByTestId('lims-registry-preview');
    const original = mocks.bridge!.getRegistryPreview.bind(mocks.bridge);
    const targetId = 'demo-dna509-oligo-m13-forward';
    const target = await original({ entityId: targetId });
    let resolveTarget: (value: typeof target) => void = () => {
      throw new Error('Selection was not started.');
    };
    const pending = new Promise<typeof target>((resolve) => {
      resolveTarget = resolve;
    });
    const previewCalls = vi
      .spyOn(mocks.bridge!, 'getRegistryPreview')
      .mockImplementation((input) => (input.entityId === targetId ? pending : original(input)));
    fireEvent.click(await screen.findByTestId(`lims-registry-row-${targetId}`));
    await act(async () => {
      emitLimsRegistryChanged();
      await Promise.resolve();
    });
    expect(
      previewCalls.mock.calls.some(([input]) => input.entityId === 'demo-dna509-plasmid-puc19')
    ).toBe(false);
    await act(async () => {
      resolveTarget(target);
    });
    await waitFor(() =>
      expect(screen.getByTestId('lims-registry-preview')).toHaveAttribute(
        'data-entity-id',
        targetId
      )
    );
  });

  it('passes a schema date filter and sort through the paginated Registry query', async () => {
    const schemas = await mocks.bridge!.listSchemas();
    const plasmid = schemas.find((candidate) => candidate.entityKind === 'plasmid')!;
    vi.spyOn(mocks.bridge!, 'listSchemas').mockResolvedValue(
      schemas.map((schema) =>
        schema === plasmid
          ? {
              ...schema,
              fields: [...schema.fields, { key: 'reviewBy', label: 'Review by', type: 'date' }],
            }
          : schema
      )
    );
    const queries = vi.fn(async (input: LimsQueryRegistrySummariesInput = {}) =>
      mocks.bridge!.queryRegistrySummaries(input)
    );
    mocks.queryRegistryOverride = queries;
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();
    fireEvent.click(await screen.findByTestId('lims-registry-filter-toggle-kind'));
    fireEvent.click(await screen.findByTestId('lims-registry-filter-option-kind-plasmid'));
    fireEvent.click(await screen.findByTestId('lims-registry-filter-toggle-field:reviewBy'));
    fireEvent.change(screen.getByLabelText('Filter condition for Review by'), {
      target: { value: 'before' },
    });
    fireEvent.change(screen.getByLabelText('Filter value for Review by'), {
      target: { value: '2027-04-30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply', exact: true }));
    fireEvent.click(await screen.findByTestId('lims-registry-sort-field:reviewBy'));
    await waitFor(() =>
      expect(queries).toHaveBeenCalledWith(
        expect.objectContaining({
          dateFilters: [
            {
              schemaId: plasmid.schemaId,
              fieldKey: 'reviewBy',
              mode: 'before',
              value: '2027-04-30',
            },
          ],
          dateSort: { schemaId: plasmid.schemaId, fieldKey: 'reviewBy', direction: 'asc' },
          offset: 0,
        })
      )
    );
  });

  it('links one task to the stable selected record identities after Registry sorting', async () => {
    const open = vi.spyOn(taskPresentation, 'createWorkTask').mockReturnValue(true);
    try {
      mocks.queryRegistryOverride = async (input = {}) => {
        const result = await mocks.bridge!.queryRegistrySummaries(input);
        return {
          ...result,
          summaries: result.summaries.map((row) => ({ ...row, workspaceId: 4 })),
        };
      };
      render(<LimsPanel />);
      loadDemo();
      await screen.findByText('Demo argF deletion strain');
      await expandRegistry();
      fireEvent.click(await screen.findByRole('button', { name: 'Select records' }));
      const select = screen.getAllByRole('checkbox', { name: /^Select / }).slice(0, 2);
      const ids = select.map((box) =>
        box
          .closest('[data-testid^="lims-registry-row-"]')!
          .getAttribute('data-testid')!
          .slice('lims-registry-row-'.length)
      );
      expect(ids).toHaveLength(2);
      for (const box of select) {
        fireEvent.click(box);
        await waitFor(() => expect(box).toBeChecked());
      }
      fireEvent.click(screen.getByTestId('lims-registry-sort-name'));
      fireEvent.click(screen.getByRole('button', { name: 'Create linked task' }));
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 4, subjectIds: ids })
      );
    } finally {
      open.mockRestore();
    }
  });

  it('uses the selected schema definition for table fields instead of a global Organism column', async () => {
    await mocks.bridge!.registerEntity({
      id: 'org-mg1655',
      kind: 'strain',
      name: 'MG1655',
      fields: { genotypeCanonical: 'wt', species: 'Escherichia coli', speciesTaxid: '511145' },
      registrationStatus: 'registered',
    });
    await mocks.bridge!.registerEntity({
      id: 'org-w3110',
      kind: 'strain',
      name: 'W3110',
      fields: { genotypeCanonical: 'wt', species: 'Escherichia coli', speciesTaxid: '316407' },
      registrationStatus: 'registered',
    });
    await mocks.bridge!.registerEntity({
      id: 'org-n16961',
      kind: 'strain',
      name: 'N16961',
      fields: { genotypeCanonical: 'wt', species: 'Vibrio cholerae', speciesTaxid: '666' },
      registrationStatus: 'registered',
    });
    render(<LimsPanel />);
    await screen.findByText('MG1655');
    await expandRegistry();

    const mixedRow = await screen.findByTestId('lims-registry-row-org-mg1655');
    expect(mixedRow).not.toHaveTextContent('Escherichia coli');
    expect(screen.queryByTestId('lims-registry-sort-organism')).toBeNull();

    fireEvent.click(await screen.findByTestId('lims-registry-filter-toggle-kind'));
    fireEvent.click(await screen.findByTestId('lims-registry-filter-option-kind-strain'));
    const strainRow = await screen.findByTestId('lims-registry-row-org-mg1655');
    expect(strainRow).toHaveTextContent('Escherichia coli');
    expect(screen.getByText('Species (scientific name)')).toBeInTheDocument();
    expect(screen.getByText('Canonical genotype')).toBeInTheDocument();
  });

  it('filters the registry by schema and exposes that schema’s fields in the table', async () => {
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    fireEvent.click(await screen.findByTestId('lims-registry-filter-toggle-kind'));
    fireEvent.click(await screen.findByTestId('lims-registry-filter-option-kind-plasmid'));

    fireEvent.click(screen.getByTestId('lims-registry-filter-toggle-status'));
    fireEvent.click(await screen.findByTestId('lims-registry-filter-option-status-registered'));
    fireEvent.click(screen.getByTestId('lims-registry-sort'));
    fireEvent.click(screen.getByTestId('lims-registry-sort-option-updated_desc'));

    const row = await screen.findByTestId('lims-registry-row-demo-dna509-plasmid-puc19');
    expect(row).toHaveTextContent('pUC19');
    expect(row).toHaveTextContent('registered');
    expect(row).toHaveTextContent('2,686');
    expect(row).toHaveTextContent('circular');
    expect(row).toHaveTextContent('AmpR');
    expect(row).not.toHaveTextContent('M13-Forward');
    await waitFor(() =>
      expect(screen.queryByTestId('lims-registry-row-demo-dna509-oligo-m13-forward')).toBeNull()
    );

    fireEvent.click(screen.getByTestId('lims-registry-open-demo-dna509-plasmid-puc19'));

    await waitFor(() =>
      expect(mocks.openLimsEntity).toHaveBeenCalledWith({
        entityId: 'demo-dna509-plasmid-puc19',
        strategy: { kind: 'focused' },
      })
    );
  });

  it('focuses registry search, supports row keyboard navigation, and Escape collapses (does NOT hide) the expanded registry', async () => {
    const onHide = vi.fn();
    render(<LimsPanel onHide={onHide} />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    fireEvent.click(screen.getByTestId('lims-registry-sort'));
    fireEvent.click(screen.getByTestId('lims-registry-sort-option-name_asc'));
    await screen.findByTestId('lims-registry-row-demo-dna509-strain-argf');

    const search = await screen.findByTestId('lims-registry-search');
    await waitFor(() => expect(search).toHaveFocus());

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const firstRow = await screen.findByTestId('lims-registry-row-demo-dna509-strain-argf');
    await waitFor(() => expect(firstRow).toHaveFocus());

    fireEvent.keyDown(firstRow, { key: 'ArrowDown' });
    const secondRow = await screen.findByTestId(
      'lims-registry-row-demo-dna509-genome-supplied-hypothesis'
    );
    await waitFor(() => expect(secondRow).toHaveFocus());

    fireEvent.keyDown(secondRow, { key: 'ArrowUp' });
    await waitFor(() => expect(firstRow).toHaveFocus());

    fireEvent.keyDown(firstRow, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('lims-registry-compact')).toBeInTheDocument());
    expect(onHide).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId('lims-panel'), { key: 'Escape' });
    await waitFor(() => expect(onHide).toHaveBeenCalledTimes(1));
  });

  it('sorts the registry by a clickable column header and renders registry IDs', async () => {
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    expect(screen.getByTestId('lims-registry-sort-registryId')).toBeInTheDocument();
    expect(screen.getByTestId('lims-registry-sort-kind')).toHaveTextContent('Schema');

    const registryIdCell = screen.getByTestId(
      'lims-registry-registry-id-demo-dna509-plasmid-puc19'
    );
    expect(registryIdCell.textContent?.trim()).toBeTruthy();
    expect(registryIdCell.textContent?.trim()).not.toBe('—');

    const typeHeader = screen.getByTestId('lims-registry-sort-kind');
    fireEvent.click(typeHeader);
    await waitFor(() => expect(typeHeader).toHaveAttribute('aria-sort', 'ascending'));
    fireEvent.click(typeHeader);
    await waitFor(() => expect(typeHeader).toHaveAttribute('aria-sort', 'descending'));

    expect(screen.getByTestId('lims-registry-col-resize-name')).toBeInTheDocument();
  });

  it('keeps registry header and rows rigorously column-aligned (same template + gap)', async () => {
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    const header = screen.getByTestId('lims-registry-table-header');
    const firstRow = screen.getByTestId('lims-registry-row-demo-dna509-strain-argf');

    expect(header.style.gridTemplateColumns).not.toBe('');
    expect(firstRow.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns);
    expect(header.style.columnGap).not.toBe('');
    expect(firstRow.style.columnGap).toBe(header.style.columnGap);
  });

  it('does not discard a modified import plan on Escape or Cancel without confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mocks.bridge!.registerEntity({
      kind: 'plasmid',
      name: 'pUC19',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
      },
      id: 'plasmid-puc19',
    });
    render(<LimsPanel />);

    const csv = [
      'Name,Sequence,Target,Direction',
      'Primer A,GTAAAACGACGGCCAGT,pUC19,Forward',
      'Primer B,CAGGAAACAGCTATGAC,pUC19,Reverse',
    ].join('\n');
    const file = new File([csv], 'primers.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => csv });

    await importFileViaWizard('oligo', file);

    await screen.findByTestId('lims-import-plan-overlay');

    fireEvent.click(screen.getByTestId('lims-import-record-row-3-accepted'));
    await waitFor(() =>
      expect(screen.getByTestId('lims-import-record-row-3-accepted')).not.toBeChecked()
    );

    fireEvent.keyDown(screen.getByTestId('lims-import-plan-overlay'), { key: 'Escape' });
    expect(confirm).toHaveBeenCalledWith('Discard changes to this import plan?');
    expect(screen.getByTestId('lims-import-plan-overlay')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lims-import-cancel'));
    expect(screen.getByTestId('lims-import-plan-overlay')).toBeInTheDocument();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('lims-import-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('lims-import-plan-overlay')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('lims-registry-overlay')).toBeInTheDocument();
  });

  it('streams additional registry rows on scroll instead of capping the first page', async () => {
    const observers: Array<{ cb: IntersectionObserverCallback; el: Element }> = [];
    const RealIntersectionObserver = global.IntersectionObserver;
    class MockIntersectionObserver {
      private readonly cb: IntersectionObserverCallback;
      root = null;
      rootMargin = '';
      thresholds: readonly number[] = [];
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element): void {
        observers.push({ cb: this.cb, el });
      }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    global.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    try {
      for (let i = 1; i <= 60; i += 1) {
        await mocks.bridge!.registerEntity({
          kind: 'oligo',
          name: `Primer ${String(i).padStart(3, '0')}`,
          fields: {
            sequence: {
              mode: 'inline',
              bases: 'GTAAAACGACGGCCAGT',
              topology: 'linear',
              length: 17,
            },
            use: 'primer',
          },
          id: `oligo-${String(i).padStart(3, '0')}`,
        });
      }

      render(<LimsPanel />);
      await expandRegistry();

      await screen.findByText('Showing 50 of 60 registry rows');
      fireEvent.click(screen.getByTestId('lims-registry-sort'));
      fireEvent.click(screen.getByTestId('lims-registry-sort-option-name_asc'));

      await screen.findByText('Showing 50 of 60 registry rows');
      expect(screen.getByTestId('lims-registry-row-oligo-001')).toBeInTheDocument();
      expect(screen.queryByTestId('lims-registry-row-oligo-060')).not.toBeInTheDocument();
      expect(observers.length).toBeGreaterThan(0);

      await act(async () => {
        for (const { cb, el } of observers) {
          cb(
            [{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry],
            {} as IntersectionObserver
          );
        }
      });

      await screen.findByText('Showing 60 of 60 registry rows');
      expect(screen.getByTestId('lims-registry-row-oligo-001')).toBeInTheDocument();
      expect(screen.getByTestId('lims-registry-row-oligo-060')).toBeInTheDocument();
    } finally {
      global.IntersectionObserver = RealIntersectionObserver;
    }
  });

  it('discards a stale loadMore page after the query changes (no cross-filter rows splice in)', async () => {
    const observers: Array<{ cb: IntersectionObserverCallback; el: Element }> = [];
    const RealIntersectionObserver = global.IntersectionObserver;
    class MockIntersectionObserver {
      private readonly cb: IntersectionObserverCallback;
      root = null;
      rootMargin = '';
      thresholds: readonly number[] = [];
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element): void {
        observers.push({ cb: this.cb, el });
      }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    global.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    let releaseStale: () => void = () => {};
    const staleHeld = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    try {
      for (let i = 1; i <= 60; i += 1) {
        await mocks.bridge!.registerEntity({
          kind: 'oligo',
          name: `Primer ${String(i).padStart(3, '0')}`,
          fields: {
            sequence: {
              mode: 'inline',
              bases: 'GTAAAACGACGGCCAGT',
              topology: 'linear',
              length: 17,
            },
            use: 'primer',
          },
          id: `oligo-${String(i).padStart(3, '0')}`,
        });
      }

      mocks.queryRegistryOverride = async (input: LimsQueryRegistrySummariesInput = {}) => {
        if (input.offset && input.offset > 0) await staleHeld;
        return mocks.bridge!.queryRegistrySummaries(input);
      };

      render(<LimsPanel />);
      await expandRegistry();
      await screen.findByText('Showing 50 of 60 registry rows');
      fireEvent.click(screen.getByTestId('lims-registry-sort'));
      fireEvent.click(screen.getByTestId('lims-registry-sort-option-name_asc'));
      await screen.findByText('Showing 50 of 60 registry rows');
      expect(screen.getByTestId('lims-registry-row-oligo-001')).toBeInTheDocument();

      await act(async () => {
        for (const { cb, el } of observers) {
          cb(
            [{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry],
            {} as IntersectionObserver
          );
        }
      });

      fireEvent.change(screen.getByTestId('lims-registry-search'), {
        target: { value: 'Primer 001' },
      });
      await waitFor(() =>
        expect(screen.getByText('Showing 1 of 1 registry rows')).toBeInTheDocument()
      );

      await act(async () => {
        releaseStale();
        await staleHeld;
      });
      await waitFor(() =>
        expect(screen.getByText('Showing 1 of 1 registry rows')).toBeInTheDocument()
      );
      expect(screen.getByTestId('lims-registry-row-oligo-001')).toBeInTheDocument();
      expect(screen.queryByTestId('lims-registry-row-oligo-051')).not.toBeInTheDocument();
      expect(screen.queryByTestId('lims-registry-row-oligo-060')).not.toBeInTheDocument();
    } finally {
      global.IntersectionObserver = RealIntersectionObserver;
    }
  });

  it('renders the version-history timeline with added/changed/removed diffs', async () => {
    mocks.historyOverride = async () => [
      {
        eventSeq: 3,
        eventType: 'entity_updated',
        label: 'Edited',
        actor: 'bob',
        at: 1700000000000,
        changes: [
          { field: 'name', label: 'Name', kind: 'changed', before: 'OldName', after: 'NewName' },
          { field: 'fields.tag', label: 'Tag', kind: 'added', after: 'addedval' },
          { field: 'fields.note', label: 'Note', kind: 'removed', before: 'goneval' },
        ],
      },
      {
        eventSeq: 1,
        eventType: 'entity_registered',
        label: 'Registered',
        actor: 'alice',
        at: 1699000000000,
        changes: [],
      },
    ];

    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();
    fireEvent.click(await screen.findByTestId('lims-registry-row-demo-dna509-strain-argf'));

    const history = await screen.findByTestId('lims-registry-history');
    await waitFor(() => expect(history).toHaveTextContent('Edited'));
    expect(history).toHaveTextContent('Registered');
    expect(history).toHaveTextContent('OldName');
    expect(history).toHaveTextContent('NewName');
    expect(history).toHaveTextContent('addedval');
    expect(history).toHaveTextContent('goneval');
    expect(history).not.toHaveTextContent('bob');
    expect(history).not.toHaveTextContent('alice');
  });

  it('shows schema field labels without projection keys or internal actor names', async () => {
    const entity = await mocks.bridge!.registerEntity({
      kind: 'strain',
      name: 'Public history labels',
      fields: { genotypeCanonical: 'wt', _managedSequenceProjectionVersion: 1 },
    });
    await mocks.bridge!.updateEntity({
      id: entity.id,
      fields: {
        genotypeCanonical: 'ΔargF',
        _managedSequenceContent: 'PRIVATE_STORAGE_DESCRIPTOR',
        _managedSequenceProjectionVersion: 2,
      },
      actor: 'workspace-reconcile',
    });
    await mocks.bridge!.updateEntity({
      id: entity.id,
      fields: { _managedSequenceProjectionVersion: 3 },
      actor: 'workspace-reconcile',
    });

    render(<LimsPanel />);
    await expandRegistry();
    fireEvent.click(await screen.findByTestId(`lims-registry-row-${entity.id}`));

    const history = await screen.findByTestId('lims-registry-history');
    await waitFor(() => expect(history).toHaveTextContent('ΔargF'));
    expect(history).toHaveTextContent('Canonical genotype');
    expect(history).not.toHaveTextContent('workspace-reconcile');
    expect(history).not.toHaveTextContent('_managedSequence');
    expect(history).not.toHaveTextContent('PRIVATE_STORAGE_DESCRIPTOR');
    expect(within(history).getAllByText('Edited')).toHaveLength(1);
  });

  it('shows the history error state when the fetch rejects', async () => {
    mocks.historyOverride = async () => {
      throw new Error('boom');
    };

    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();
    fireEvent.click(await screen.findByTestId('lims-registry-row-demo-dna509-strain-argf'));

    await screen.findByTestId('lims-registry-history-error');
    expect(screen.getByTestId('lims-registry-history-error')).toHaveTextContent(
      'Failed to load history'
    );
  });

  it('filters by the in-header Name search and clears all filters', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    expect(screen.queryByTestId('lims-registry-clear-filters')).toBeNull();

    fireEvent.click(screen.getByTestId('lims-registry-filter-toggle-name'));
    fireEvent.change(await screen.findByTestId('lims-registry-filter-input-name'), {
      target: { value: 'pUC' },
    });
    expect(
      await screen.findByTestId('lims-registry-row-demo-dna509-plasmid-puc19')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId('lims-registry-row-demo-dna509-oligo-m13-forward')).toBeNull()
    );

    fireEvent.click(screen.getByTestId('lims-registry-clear-filters'));
    await waitFor(() => expect(screen.queryByTestId('lims-registry-clear-filters')).toBeNull());
    expect(screen.queryByTestId('lims-registry-filter-toggle-sequence')).toBeNull();
    fireEvent.click(screen.getByTestId('lims-registry-filter-toggle-name'));
    expect(await screen.findByTestId('lims-registry-filter-input-name')).toHaveValue('');
  });

  it('multi-selects the Schema column with select-all and clear', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    fireEvent.click(screen.getByTestId('lims-registry-filter-toggle-kind'));
    fireEvent.click(await screen.findByTestId('lims-registry-filter-option-kind-oligo'));
    fireEvent.click(screen.getByTestId('lims-registry-filter-option-kind-plasmid'));
    expect(
      await screen.findByTestId('lims-registry-row-demo-dna509-plasmid-puc19')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('lims-registry-row-demo-dna509-oligo-m13-forward')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId('lims-registry-row-demo-dna509-strain-argf')).toBeNull()
    );

    fireEvent.click(screen.getByTestId('lims-registry-filter-selectall-kind'));
    expect(
      await screen.findByTestId('lims-registry-row-demo-dna509-strain-argf')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lims-registry-filter-clearcol-kind'));
    expect(
      await screen.findByTestId('lims-registry-row-demo-dna509-plasmid-puc19')
    ).toBeInTheDocument();

    expect(screen.queryByTestId('lims-registry-filter-toggle-updated')).toBeNull();
  });

  it('Escape peels ONE layer per press — column search, then collapse, then hide ', async () => {
    const onHide = vi.fn();
    render(<LimsPanel onHide={onHide} />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    fireEvent.click(screen.getByTestId('lims-registry-filter-toggle-name'));
    const input = await screen.findByTestId('lims-registry-filter-input-name');

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('lims-registry-filter-input-name')).toBeNull());
    expect(onHide).not.toHaveBeenCalled();
    expect(screen.getByTestId('lims-registry-overlay')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId('lims-registry-overlay'), { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('lims-registry-compact')).toBeInTheDocument());
    expect(onHide).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId('lims-panel'), { key: 'Escape' });
    await waitFor(() => expect(onHide).toHaveBeenCalledTimes(1));
  });

  it('keeps a non-empty search box visible after Escape and shows categorical value in the header', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    fireEvent.click(screen.getByTestId('lims-registry-filter-toggle-name'));
    const input = await screen.findByTestId('lims-registry-filter-input-name');
    fireEvent.change(input, { target: { value: 'pUC' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByTestId('lims-registry-filter-input-name')).toHaveValue('pUC');
    expect(screen.queryByTestId('lims-registry-filter-toggle-name')).toBeNull();

    fireEvent.click(screen.getByTestId('lims-registry-filter-toggle-kind'));
    fireEvent.click(await screen.findByTestId('lims-registry-filter-option-kind-plasmid'));
    expect(screen.getByTestId('lims-registry-sort-kind')).toHaveTextContent('Plasmid');
  });

  it('clears the in-header search when you click out of it (blur), not just on Escape', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    fireEvent.click(screen.getByTestId('lims-registry-filter-toggle-name'));
    const input = await screen.findByTestId('lims-registry-filter-input-name');
    fireEvent.change(input, { target: { value: 'pUC' } });
    expect(input).toHaveValue('pUC');

    fireEvent.blur(input);
    expect(screen.queryByTestId('lims-registry-filter-input-name')).toBeNull();
    expect(screen.getByTestId('lims-registry-filter-toggle-name')).toBeInTheDocument();
  });

  it('clears the in-header search on an outside mousedown (titlebar drag-region click-out)', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await expandRegistry();

    fireEvent.click(screen.getByTestId('lims-registry-filter-toggle-name'));
    const input = await screen.findByTestId('lims-registry-filter-input-name');
    fireEvent.change(input, { target: { value: 'pUC' } });
    expect(input).toHaveValue('pUC');

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('lims-registry-filter-input-name')).toBeNull();
  });

  it('defaults to the compact registry (Name + ID + search), not the full overlay', async () => {
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');

    expect(screen.getByTestId('lims-registry-compact')).toBeInTheDocument();
    expect(screen.getByTestId('lims-registry-compact-search')).toBeInTheDocument();
    expect(screen.queryByTestId('lims-registry-overlay')).not.toBeInTheDocument();

    const compactRow = screen.getByTestId('lims-registry-compact-row-demo-dna509-plasmid-puc19');
    expect(compactRow).toHaveTextContent('pUC19');
    const idCell = within(compactRow).getByTestId(
      'lims-registry-compact-id-demo-dna509-plasmid-puc19'
    );
    expect(idCell.textContent?.trim()).toBeTruthy();
    expect(idCell.textContent?.trim()).not.toBe('—');
  });

  it('participates in workspace display delivery by reloading the Registry', async () => {
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await mocks.bridge!.registerEntity({
      id: 'remote-replica-strain',
      kind: 'strain',
      name: 'Remote replica strain',
      fields: { genotype: 'delta-recA' },
      registrationStatus: 'registered',
    });
    expect(screen.queryByText('Remote replica strain')).toBeNull();

    let report: Awaited<ReturnType<typeof deliverWorkspaceDisplay>> | null = null;
    await act(async () => {
      report = await deliverWorkspaceDisplay({
        workspaceRoot: '/managed/workspace-a',
        operationId: 'replica-refresh:test',
        assertCurrent: () => undefined,
      });
    });
    expect(report).toEqual({ participants: 1, errors: [] });
    expect(await screen.findByText('Remote replica strain')).toBeInTheDocument();
  });
  it('does not treat a superseded Registry reload as a delivered view', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await mocks.bridge!.registerEntity({
      id: 'superseded-result',
      kind: 'strain',
      name: 'Superseded refresh result',
      fields: {},
      registrationStatus: 'registered',
    });

    const parked = Promise.withResolvers<unknown>();
    let calls = 0;
    mocks.queryRegistryOverride = async (input) => {
      calls += 1;
      if (calls === 1) return parked.promise;
      return mocks.bridge!.queryRegistrySummaries(input ?? {});
    };
    const context = { workspaceRoot: '/workspace', assertCurrent: () => undefined };
    let first: Promise<Awaited<ReturnType<typeof deliverWorkspaceDisplay>>> | null = null;
    act(() => {
      first = deliverWorkspaceDisplay({ ...context, operationId: 'replica-refresh:a' });
    });
    await waitFor(() => expect(calls).toBe(1));
    let second: Awaited<ReturnType<typeof deliverWorkspaceDisplay>> | null = null;
    await act(async () => {
      second = await deliverWorkspaceDisplay({ ...context, operationId: 'replica-refresh:b' });
    });
    expect(second).toEqual({ participants: 1, errors: [] });
    let firstReport: Awaited<ReturnType<typeof deliverWorkspaceDisplay>> | null = null;
    await act(async () => {
      parked.resolve(await mocks.bridge!.queryRegistrySummaries({ limit: 80, offset: 0 }));
      firstReport = await first!;
    });
    expect(firstReport).toEqual({ participants: 1, errors: [] });
    expect(calls).toBe(3);
    expect(await screen.findByText('Superseded refresh result')).toBeInTheDocument();
  });

  it('stops participating in display delivery once unmounted', async () => {
    const { unmount } = render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    unmount();
    await expect(
      deliverWorkspaceDisplay({
        workspaceRoot: '/workspace',
        operationId: 'replica-refresh:after-unmount',
        assertCurrent: () => undefined,
      })
    ).resolves.toEqual({ participants: 0, errors: [] });
  });

  it('does not publish a Registry query from a cancelled workspace refresh', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');
    await mocks.bridge!.registerEntity({
      id: 'cancelled-result',
      kind: 'strain',
      name: 'Cancelled refresh result',
      fields: {},
      registrationStatus: 'registered',
    });
    const page = await mocks.bridge!.queryRegistrySummaries({ limit: 80, offset: 0 });
    const deferred = Promise.withResolvers<typeof page>();
    mocks.queryRegistryOverride = () => deferred.promise;
    let current = true;
    let delivery: Promise<Awaited<ReturnType<typeof deliverWorkspaceDisplay>>> | null = null;
    act(() => {
      delivery = deliverWorkspaceDisplay({
        workspaceRoot: '/workspace',
        operationId: 'replica-refresh:cancelled',
        assertCurrent: () => {
          if (!current) throw new Error('Refresh cancelled');
        },
      });
    });
    current = false;
    let report: Awaited<ReturnType<typeof deliverWorkspaceDisplay>> | null = null;
    await act(async () => {
      deferred.resolve(page);
      report = await delivery!;
    });
    expect(report!.participants).toBe(1);
    expect(report!.errors).toHaveLength(1);
    expect((report!.errors[0] as Error).message).toBe('Refresh cancelled');
    expect(screen.queryByText('Cancelled refresh result')).not.toBeInTheDocument();
  });

  it('shows completion after restoring a record through the shared Registry editor', async () => {
    const entity = await mocks.bridge!.registerEntity({
      id: 'restore-completion-feedback',
      kind: 'strain',
      name: 'Restore completion feedback',
      fields: {},
      registrationStatus: 'registered',
    });
    await mocks.bridge!.archiveEntity({
      id: entity.id,
      expectedEventSeq: entity.eventSeq ?? undefined,
      operationId: crypto.randomUUID(),
    });
    render(<LimsPanel />);
    await expandRegistry();
    const filters = await openFilterCategory('More');
    fireEvent.click(within(filters).getByTestId('lims-registry-show-archived'));
    fireEvent.click(within(filters).getByRole('button', { name: 'Done', exact: true }));
    fireEvent.click(await screen.findByTestId(`lims-registry-row-${entity.id}`));
    fireEvent.click(await screen.findByTestId('lims-registry-preview-restore'));
    await waitFor(() =>
      expect(screen.getByTestId('lims-registry-action-note')).toHaveTextContent(
        'Restored Restore completion feedback.'
      )
    );
    expect(screen.getByTestId(`lims-registry-row-${entity.id}`)).not.toHaveAttribute(
      'data-archived',
      'true'
    );
  });

  it('keeps the current archived filter when an earlier Archive action finishes late', async () => {
    const entity = await mocks.bridge!.registerEntity({
      id: 'late-archive-filter',
      kind: 'strain',
      name: 'Late archive filter',
      fields: {},
      registrationStatus: 'registered',
    });
    const queries = vi.fn((input?: LimsQueryRegistrySummariesInput) =>
      mocks.bridge!.queryRegistrySummaries(input)
    );
    mocks.queryRegistryOverride = queries;
    const archived = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const archive = mocks.bridge!.archiveEntity.bind(mocks.bridge);
    vi.spyOn(mocks.bridge!, 'archiveEntity').mockImplementation(async (input) => {
      const result = await archive(input);
      archived.resolve();
      await finish.promise;
      return result;
    });
    render(<LimsPanel />);
    await expandRegistry();
    fireEvent.click(await screen.findByTestId(`lims-registry-row-${entity.id}`));
    fireEvent.click(await screen.findByTestId('lims-registry-preview-archive'));
    await act(async () => {
      await archived.promise;
    });

    const filters = await openFilterCategory('More');
    fireEvent.click(within(filters).getByTestId('lims-registry-show-archived'));
    fireEvent.click(within(filters).getByRole('button', { name: 'Done', exact: true }));
    await waitFor(() =>
      expect(screen.getByTestId(`lims-registry-row-${entity.id}`)).toHaveAttribute(
        'data-archived',
        'true'
      )
    );
    await act(async () => {
      finish.resolve();
    });
    expect(queries.mock.calls.at(-1)?.[0]?.includeArchived).toBe(true);
    const currentFilters = await openFilterCategory('More');
    expect(within(currentFilters).getByTestId('lims-registry-show-archived')).toBeChecked();
    fireEvent.click(within(currentFilters).getByRole('button', { name: 'Done', exact: true }));
    expect(screen.getByTestId(`lims-registry-row-${entity.id}`)).toHaveAttribute(
      'data-archived',
      'true'
    );
  });

  it('compact search filters the Name/ID list', async () => {
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');

    expect(
      screen.getByTestId('lims-registry-compact-row-demo-dna509-plasmid-puc19')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('lims-registry-compact-row-demo-dna509-strain-argf')
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('lims-registry-compact-search'), {
      target: { value: 'pUC19' },
    });
    expect(
      await screen.findByTestId('lims-registry-compact-row-demo-dna509-plasmid-puc19')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId('lims-registry-compact-row-demo-dna509-strain-argf')).toBeNull()
    );
  });

  it('expands to the full registry and collapses back', async () => {
    render(<LimsPanel />);

    loadDemo();
    await screen.findByText('Demo argF deletion strain');

    fireEvent.click(screen.getByTestId('lims-registry-expand'));
    await screen.findByTestId('lims-registry-overlay');
    expect(screen.queryByTestId('lims-registry-compact')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lims-registry-collapse'));
    await screen.findByTestId('lims-registry-compact');
  });

  it('opens schema definitions in Registry settings from the expanded registry', async () => {
    const open = vi.fn();
    const unsubscribe = subscribeSettingsEntry(open);
    try {
      render(<LimsPanel />);
      await expandRegistry();
      fireEvent.click(screen.getByRole('button', { name: 'Schemas' }));
      expect(open).toHaveBeenCalledWith('registry');
      expect(screen.queryByRole('dialog', { name: 'Registry schemas' })).not.toBeInTheDocument();
      expect(mocks.mutateOrganizationRegistry).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each(['Enter', ' '])(
    'row keyboard activation with %s selects Details without opening a document',
    async (key) => {
      render(<LimsPanel />);

      loadDemo();
      await screen.findByText('Demo argF deletion strain');

      fireEvent.click(screen.getByTestId('lims-registry-compact-row-demo-dna509-plasmid-puc19'));
      const details = await screen.findByTestId('lims-registry-preview');
      const row = await screen.findByTestId('lims-registry-row-demo-dna509-plasmid-puc19');
      fireEvent.keyDown(row, { key });
      fireEvent.doubleClick(row);
      await waitFor(() => expect(details).toHaveTextContent('pUC19'));
      expect(mocks.openLimsEntity).not.toHaveBeenCalled();
    }
  );

  it('infinite scroll: both the collapsed and expanded sentinels are observed and page on intersect', async () => {
    for (let i = 0; i < 60; i++) {
      await mocks.bridge!.registerEntity({
        kind: 'plasmid',
        name: `P${String(i).padStart(3, '0')}`,
        fields: {
          sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        },
        id: `plasmid-scroll-${i}`,
      });
    }

    const ios: Array<{ cb: IntersectionObserverCallback; el?: Element }> = [];
    class MockIO {
      cb: IntersectionObserverCallback;
      el?: Element;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        ios.push(this);
      }
      observe(el: Element) {
        this.el = el;
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [] as IntersectionObserverEntry[];
      }
    }
    const fireFor = async (el: Element) => {
      const io = ios.find((candidate) => candidate.el === el);
      if (!io) throw new Error('no IntersectionObserver attached to the sentinel');
      await act(async () => {
        io.cb(
          [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
          io as unknown as IntersectionObserver
        );
      });
    };
    vi.stubGlobal('IntersectionObserver', MockIO);

    try {
      render(<LimsPanel />);

      const collapsedSentinel = await screen.findByTestId('lims-registry-compact-sentinel');
      expect(screen.getAllByTestId(/^lims-registry-compact-row-/)).toHaveLength(50);
      expect(ios.some((io) => io.el === collapsedSentinel)).toBe(true);

      fireEvent.click(screen.getByTestId('lims-registry-expand'));
      const overlaySentinel = await screen.findByTestId('lims-registry-scroll-sentinel');

      expect(ios.some((io) => io.el === overlaySentinel)).toBe(true);
      expect(screen.getAllByTestId(/^lims-registry-row-/)).toHaveLength(50);

      await fireFor(overlaySentinel);
      await waitFor(() =>
        expect(screen.getAllByTestId(/^lims-registry-row-/).length).toBeGreaterThan(50)
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('collapse never co-renders the drawer with the exiting overlay (no double-surface flicker)', async () => {
    render(<LimsPanel />);
    loadDemo();
    await screen.findByText('Demo argF deletion strain');

    fireEvent.click(screen.getByTestId('lims-registry-expand'));
    await screen.findByTestId('lims-registry-overlay');
    expect(screen.queryByTestId('lims-registry-compact')).toBeNull();

    fireEvent.click(screen.getByTestId('lims-registry-collapse'));
    expect(screen.getByTestId('lims-registry-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('lims-registry-compact')).toBeNull();
  });
});

function loadDemo(): void {
  fireEvent.change(screen.getByTestId('lims-dev-scenario-picker'), { target: { value: 'demo' } });
}
