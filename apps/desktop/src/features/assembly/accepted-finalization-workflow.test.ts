import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptedAssemblyVersion } from './accepted-types';
import type { PreparedFinalizationCandidate } from './accepted-finalization-preview';

type SequenceDesign = PreparedFinalizationCandidate['design'];

const stores = vi.hoisted(() => {
  type Design = { version: number; acceptedAssemblyVersions?: Array<{ id: string }> } & Record<
    string,
    unknown
  >;
  let designs: Record<string, Design> = {};
  const sequences = new Map<string, unknown>();
  const designState = {
    get designs() {
      return designs;
    },
    commitAcceptedAssemblyVersion(designId: string, accepted: { id: string }, expected: number) {
      const current = designs[designId];
      if (!current || current.version !== expected) return false;
      designs = {
        ...designs,
        [designId]: {
          ...current,
          acceptedAssemblyVersions: [...(current.acceptedAssemblyVersions ?? []), accepted],
          version: current.version + 1,
        },
      };
      return true;
    },
    replaceAcceptedAssemblyVersion(designId: string, accepted: { id: string }) {
      const current = designs[designId];
      const versions = current?.acceptedAssemblyVersions ?? [];
      const index = versions.findIndex((version) => version.id === accepted.id);
      if (!current || index === -1) return false;
      const next = [...versions];
      next[index] = accepted;
      designs = { ...designs, [designId]: { ...current, acceptedAssemblyVersions: next } };
      return true;
    },
    bindDesignConstructId(designId: string, constructId: string) {
      const current = designs[designId];
      if (current && current.constructId !== constructId) {
        designs = { ...designs, [designId]: { ...current, constructId } };
      }
    },
  };
  const sequenceState = {
    setSequence(id: string, sequence: unknown) {
      sequences.set(id, sequence);
    },
    markClean() {},
    hasSequence(id: string) {
      return sequences.has(id);
    },
    clearAll() {
      sequences.clear();
    },
  };
  return {
    useDesignStore: {
      getState: () => designState,
      setState: (next: { designs: Record<string, Design> }) => {
        designs = next.designs;
      },
    },
    useSequenceStore: { getState: () => sequenceState },
  };
});

vi.mock('../design/store', () => ({
  useDesignStore: stores.useDesignStore,
  freezeDesignEditsForPublication: mocks.freezeEdits,
  unfreezeDesignEditsForPublication: mocks.unfreezeEdits,
  withAuthorizedDesignPublicationUpdate: (_id: string, action: () => unknown) => action(),
}));
vi.mock('../sequence/store', () => ({ useSequenceStore: stores.useSequenceStore }));

vi.mock('../../lib/workflow-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workflow-telemetry')>()),
  observeWorkflowAction: mocks.observeWorkflowAction,
}));

const mocks = vi.hoisted(() => ({
  observeWorkflowAction: vi.fn(() => true),
  runWorkspaceReconcileOperation: vi.fn(),
  resolveReconcileWorkspaceRoot: vi.fn(),
  writeAcceptedAssemblyFiles: vi.fn(),
  registerAcceptedAssemblyAsLimsEntity: vi.fn(),
  recordAcceptedAssemblyPrimers: vi.fn(),
  commitPrimerBatchHistory: vi.fn(),
  matureDesignArtifactToPlasmidPackage: vi.fn(),
  gitHead: vi.fn(),
  gitStatus: vi.fn(),
  isGitRepo: vi.fn(),
  rememberFinalizedPlasmid: vi.fn(),
  withRendererWorkspaceMutation: vi.fn(),
  publishScientificAssembly: vi.fn(),
  packagePresent: false,
  packageCopy: null as {
    packageRoot: string;
    path: string;
    design: SequenceDesign;
    published: boolean;
  } | null,
  readPackageCopy: vi.fn(),
  consumePackageCopy: vi.fn(),
  freezeEdits: vi.fn(),
  unfreezeEdits: vi.fn(),
  drainMirrors: vi.fn(),
  suspendMirrors: vi.fn(),
  resumeMirrors: vi.fn(),
  retireMirror: vi.fn(),
}));

vi.mock('./scientific-finalization', () => ({
  publishScientificAssembly: mocks.publishScientificAssembly,
}));

vi.mock('../../services/workspace-operations', () => ({
  runWorkspaceReconcileOperation: mocks.runWorkspaceReconcileOperation,
  resolveReconcileWorkspaceRoot: mocks.resolveReconcileWorkspaceRoot,
}));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: mocks.withRendererWorkspaceMutation,
}));
vi.mock('../../platform', () => ({
  platform: () => ({ fs: { exists: vi.fn(async () => mocks.packagePresent) } }),
}));
vi.mock('../../db/sequence-package-working-copy-storage', () => ({
  readPackageAssemblyWorkingCopy: mocks.readPackageCopy.mockImplementation(
    async () => mocks.packageCopy
  ),
  consumePackageAssemblyWorkingCopy: mocks.consumePackageCopy.mockImplementation(
    async () => mocks.packageCopy?.path ?? null
  ),
}));
vi.mock('../design/design-artifact-mirror', () => ({
  suspendDesignArtifactMirrors: mocks.suspendMirrors,
  drainDesignArtifactMirrors: mocks.drainMirrors.mockImplementation(async () => undefined),
  resumeDesignArtifactMirrors: mocks.resumeMirrors,
  resumeDesignArtifactMirror: vi.fn(),
  retireDesignArtifactMirror: mocks.retireMirror.mockImplementation(async () => undefined),
}));
vi.mock('./accepted-writer', () => ({
  writeAcceptedAssemblyFiles: mocks.writeAcceptedAssemblyFiles,
  projectionInputToAnnotatedSequence: () => ({
    name: 'pUC-x',
    sequence: 'ATGC',
    length: 4,
    circular: true,
    annotations: [],
  }),
}));
vi.mock('./accepted-service', () => ({
  markAcceptedAssemblyVersionLifecycle: (
    version: AcceptedAssemblyVersion,
    lifecycleState: AcceptedAssemblyVersion['lifecycleState']
  ) => ({ ...version, lifecycleState }),
}));
vi.mock('./plasmid-identity', () => ({ rememberFinalizedPlasmid: mocks.rememberFinalizedPlasmid }));
vi.mock('../design/design-artifact-maturation', () => ({
  assertDesignArtifactMaturationTarget: vi.fn(async () => undefined),
  matureDesignArtifactToPlasmidPackage: mocks.matureDesignArtifactToPlasmidPackage,
}));
vi.mock('../lims/assembly-bridge', () => ({
  hasRecordableAssemblyPrimers: () => false,
  recordAcceptedAssemblyPrimers: mocks.recordAcceptedAssemblyPrimers,
  registerAcceptedAssemblyAsLimsEntity: mocks.registerAcceptedAssemblyAsLimsEntity,
}));
vi.mock('../primers/primer-artifact-service', () => ({
  commitPrimerBatchHistory: mocks.commitPrimerBatchHistory,
}));
vi.mock('../workspace/git', () => ({
  gitHead: mocks.gitHead,
  gitStatus: mocks.gitStatus,
  isGitRepo: mocks.isGitRepo,
}));
vi.mock('../../db/sequence-package', () => ({
  parseSequencePackageDocument: () => ({}),
  sequencePackagePaths: (root: string) => ({ metaPath: `${root}/.forge/plasmid.json` }),
}));
vi.mock('../../db/workspace-catalog', () => ({
  getCatalogEntity: vi.fn(async () => null),
  linkCatalogEntities: vi.fn(),
  recordCatalogEvent: vi.fn(),
  updateCatalogEntityMetadata: vi.fn(),
}));

import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  AcceptedAssemblyProjectionError,
  finalizeAcceptedAssemblyWorkflow,
} from './accepted-finalization-workflow';

const useDesignStore = stores.useDesignStore;
const useSequenceStore = stores.useSequenceStore;

const ROOT = '/Users/test/lab-workspace';
const PACKAGE_ROOT = `${ROOT}/assemblies/pUC-x`;

function design(): SequenceDesign {
  return {
    id: 'design-1',
    constructId: 'construct-1',
    name: 'pUC-x design',
    topology: 'circular',
    regions: [],
    spacers: [],
    version: 3,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    acceptedAssemblyVersions: [],
    activeAcceptedAssemblyVersionId: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  } as unknown as SequenceDesign;
}

function candidate(
  overrides: Partial<PreparedFinalizationCandidate> = {}
): PreparedFinalizationCandidate {
  const acceptedVersion = {
    id: 'accepted-1',
    schemaVersion: 1,
    lifecycleState: 'accepted',
    acceptedAt: '2026-09-08T00:00:00.000Z',
    acceptedBy: 'local-user',
    canonicalDraftChecksum: 'draft-checksum',
    projectionInput: {
      constructId: 'construct-1',
      designId: 'design-1',
      parentAcceptedAssemblyVersionId: null,
      sourceProvenance: [],
    },
    validationSnapshot: {},
    artifacts: { productSequenceChecksum: 'product-seq' },
  } as unknown as AcceptedAssemblyVersion;
  return {
    design: design(),
    constructId: 'construct-1',
    targetProductPath: `${PACKAGE_ROOT}/pUC-x.gb`,
    overwrite: false,
    replaceProduct: false,
    workspaceFolderMap: {},
    signature: 'signature',
    warnings: [],
    prepared: {
      acceptedVersion,
      productSequence: {
        name: 'pUC-x',
        sequence: 'ATGC',
        length: 4,
        circular: true,
        annotations: [],
      },
      files: {
        packageRoot: PACKAGE_ROOT,
        productGenBankPath: `${PACKAGE_ROOT}/pUC-x.gb`,
        metaPath: `${PACKAGE_ROOT}/.forge/plasmid.json`,
        metaDir: `${PACKAGE_ROOT}/.forge`,
        primersDir: `${PACKAGE_ROOT}/primers`,
        primerCsvPath: `${PACKAGE_ROOT}/primers/pUC-x.csv`,
        primerFastaPath: `${PACKAGE_ROOT}/primers/pUC-x.fasta`,
        basename: 'pUC-x',
        overwrite: false,
        productGenBankContent: 'LOCUS',
        sidecarJsonContent: '{}',
        primerCsvContent: '',
        primerFastaContent: '',
        productSequenceChecksum: 'product-seq',
        productGenBankChecksum: 'product-gb',
        primerCsvChecksum: 'csv',
        primerFastaChecksum: 'fasta',
        sidecarChecksum: 'sidecar',
        canonicalDraftChecksum: 'draft-checksum',
      },
    },
    ...overrides,
  } as unknown as PreparedFinalizationCandidate;
}

function completedReconciliation() {
  return {
    operationId: 'assembly-finalization:construct-1',
    workspaceRoot: ROOT,
    durable: { result: { registered: 1 }, entityResult: { reconciled: 1 } },
    display: { state: 'completed', participants: 0 },
  };
}

function retryCandidate(overrides: Partial<PreparedFinalizationCandidate> = {}) {
  const current = useDesignStore.getState().designs['design-1'];
  const next = candidate({ overwrite: true, ...overrides });
  (next.design as unknown as { version: number }).version = current.version;
  return next;
}

function resolveRootLikeTheOwner(explicitRoot: string | null | undefined, path: string | null) {
  const store = useWorkspaceStore.getState();
  const root =
    explicitRoot ??
    store.folders.find((folder) => path?.startsWith(`${folder.path}/`))?.path ??
    null;
  if (!root) {
    store.bumpFileTreeRefresh();
    return null;
  }
  return root;
}

const expectCommitBaseline = (baseline: Set<string>) =>
  expect(mocks.commitPrimerBatchHistory).toHaveBeenCalledWith(
    ROOT,
    expect.any(Array),
    baseline,
    expect.any(String),
    'finalization-token'
  );

describe('accepted assembly finalization workflow: workspace reconstruction ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishScientificAssembly.mockResolvedValue(null);
    mocks.packagePresent = false;
    mocks.packageCopy = null;
    mocks.withRendererWorkspaceMutation.mockImplementation(
      async (root: string | null, operation: (token?: string) => Promise<unknown>) =>
        operation(root ? 'finalization-token' : undefined)
    );
    mocks.resolveReconcileWorkspaceRoot.mockImplementation(resolveRootLikeTheOwner);
    mocks.writeAcceptedAssemblyFiles.mockResolvedValue({ migratedPaths: [] });
    mocks.registerAcceptedAssemblyAsLimsEntity.mockResolvedValue(undefined);
    mocks.matureDesignArtifactToPlasmidPackage.mockResolvedValue({ state: 'skipped' });
    mocks.isGitRepo.mockResolvedValue(true);
    mocks.gitStatus.mockResolvedValue(new Map());
    mocks.recordAcceptedAssemblyPrimers.mockResolvedValue({ recorded: [], failed: [] });
    mocks.commitPrimerBatchHistory.mockResolvedValue('committed');
    mocks.gitHead.mockResolvedValue('abc123');
    mocks.runWorkspaceReconcileOperation.mockResolvedValue(completedReconciliation());
    useWorkspaceStore.setState({
      folders: [{ path: ROOT, name: 'lab-workspace', addedAt: 1 }],
      fileTreeRefreshToken: 0,
    });
    useDesignStore.setState({
      designs: { 'design-1': design() as unknown as { version: number } & Record<string, unknown> },
    });
    useSequenceStore.getState().clearAll();
  });

  it('uses the accepted publication projection without a second Registry writer', async () => {
    const accepted = {
      workspace: 'workspace-1',
      resourceId: 'construct-1',
      revisionId: 'revision-1',
      versionId: 'version-1',
      operationId: 'assembly-finalization-1',
    };
    mocks.publishScientificAssembly.mockResolvedValue({
      accepted,
      ownedPaths: [`${ROOT}/.dnaforge/scientific-identities.json`],
      primerCount: 2,
    });
    const result = await finalizeAcceptedAssemblyWorkflow({
      candidate: candidate(),
      notify: false,
    });
    expect(result.acceptedRevision).toEqual(accepted);
    expect(result.historyState).toBe('committed');
    expect(mocks.registerAcceptedAssemblyAsLimsEntity).not.toHaveBeenCalled();
    expect(mocks.recordAcceptedAssemblyPrimers).not.toHaveBeenCalled();
    expect(mocks.writeAcceptedAssemblyFiles).not.toHaveBeenCalled();
    expect(mocks.runWorkspaceReconcileOperation).toHaveBeenCalledOnce();
  });

  it('prevents the loose-draft mirror from waiting on Finalize during retirement', async () => {
    let suspended = false;
    let leaseHeld = false;
    let mirrorQueuedBehindFinalize = false;
    mocks.suspendMirrors.mockImplementationOnce(() => {
      suspended = true;
    });
    mocks.withRendererWorkspaceMutation.mockImplementationOnce(async (_root, operation) => {
      leaseHeld = true;
      try {
        return await operation('finalization-token');
      } finally {
        leaseHeld = false;
      }
    });
    mocks.writeAcceptedAssemblyFiles.mockImplementationOnce(async () => {
      mirrorQueuedBehindFinalize = !suspended && leaseHeld;
      return { migratedPaths: [] };
    });
    mocks.matureDesignArtifactToPlasmidPackage.mockImplementationOnce(async () => {
      if (mirrorQueuedBehindFinalize) {
        throw new Error('Finalize waits for mirror; mirror waits for Finalize lease');
      }
      return { state: 'matured', draftPath: ROOT + '/draft.wpdesign.json' };
    });
    const result = await finalizeAcceptedAssemblyWorkflow({
      candidate: candidate(),
      notify: false,
    });
    expect(result.consumedDraftPath).toBe(ROOT + '/draft.wpdesign.json');
    expect(mocks.drainMirrors).toHaveBeenCalledWith(['design-1']);
    expect(mocks.drainMirrors.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.withRendererWorkspaceMutation.mock.invocationCallOrder[0]
    );
  });

  it('fences a loose draft during publication and releases it after a write failure', async () => {
    mocks.writeAcceptedAssemblyFiles.mockRejectedValueOnce(new Error('publication write failed'));
    await expect(
      finalizeAcceptedAssemblyWorkflow({ candidate: candidate(), notify: false })
    ).rejects.toThrow('publication write failed');
    expect(mocks.freezeEdits).toHaveBeenCalledWith('design-1');
    expect(mocks.freezeEdits.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.withRendererWorkspaceMutation.mock.invocationCallOrder[0]
    );
    expect(mocks.unfreezeEdits).toHaveBeenCalledWith('design-1');
    expect(mocks.resumeMirrors).toHaveBeenCalledWith(['design-1'], { scheduleLatest: true });
    expect(mocks.matureDesignArtifactToPlasmidPackage).not.toHaveBeenCalled();
    expect(mocks.observeWorkflowAction).not.toHaveBeenCalled();
  });

  it('preserves a loose-draft edit made while the prior automatic save drains', async () => {
    mocks.drainMirrors.mockImplementationOnce(async () => {
      const current = useDesignStore.getState().designs['design-1'];
      useDesignStore.setState({
        designs: {
          'design-1': { ...current, name: 'Latest user edit', version: current.version + 1 },
        },
      });
    });
    await expect(
      finalizeAcceptedAssemblyWorkflow({ candidate: candidate(), notify: false })
    ).rejects.toThrow('Design changed before finalization');
    expect(useDesignStore.getState().designs['design-1'].name).toBe('Latest user edit');
    expect(mocks.writeAcceptedAssemblyFiles).not.toHaveBeenCalled();
    expect(mocks.matureDesignArtifactToPlasmidPackage).not.toHaveBeenCalled();
    expect(mocks.unfreezeEdits).toHaveBeenCalledWith('design-1');
    expect(mocks.resumeMirrors).toHaveBeenCalledWith(['design-1'], { scheduleLatest: true });
  });

  it('drains and freezes a package-owned copy before publication, then consumes that member', async () => {
    const prepared = candidate();
    const copyPath = `${PACKAGE_ROOT}/contents/assembly-working-copy.wpdesign.json`;
    mocks.packagePresent = true;
    mocks.packageCopy = {
      packageRoot: PACKAGE_ROOT,
      path: copyPath,
      design: prepared.design,
      published: false,
    };

    const result = await finalizeAcceptedAssemblyWorkflow({ candidate: prepared, notify: false });

    expect(result.consumedDraftPath).toBe(copyPath);
    expect(mocks.drainMirrors).toHaveBeenCalledWith(['design-1']);
    expect(mocks.retireMirror).toHaveBeenCalledWith('design-1');
    expect(mocks.consumePackageCopy).toHaveBeenCalledWith({
      packageRoot: PACKAGE_ROOT,
      packageId: 'construct-1',
      designId: 'design-1',
      mutationToken: 'finalization-token',
    });
    expect(mocks.matureDesignArtifactToPlasmidPackage).not.toHaveBeenCalled();
    expect(mocks.drainMirrors.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.withRendererWorkspaceMutation.mock.invocationCallOrder[0]
    );
    expect(mocks.retireMirror.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consumePackageCopy.mock.invocationCallOrder[0]
    );
  });

  it('keeps the package copy when it changed after finalization preview', async () => {
    const prepared = candidate();
    mocks.packagePresent = true;
    mocks.packageCopy = {
      packageRoot: PACKAGE_ROOT,
      path: `${PACKAGE_ROOT}/contents/assembly-working-copy.wpdesign.json`,
      design: prepared.design,
      published: false,
    };
    mocks.drainMirrors.mockImplementationOnce(async () => {
      mocks.packageCopy = {
        ...mocks.packageCopy!,
        design: { ...mocks.packageCopy!.design, name: 'Newer edit' },
      };
    });

    await expect(finalizeAcceptedAssemblyWorkflow({ candidate: prepared })).rejects.toThrow(
      /changed after finalization preview/
    );
    expect(mocks.withRendererWorkspaceMutation).not.toHaveBeenCalled();
    expect(mocks.consumePackageCopy).not.toHaveBeenCalled();
  });

  it('does not publish an interrupted copy a second time', async () => {
    const prepared = candidate();
    mocks.packagePresent = true;
    mocks.packageCopy = {
      packageRoot: PACKAGE_ROOT,
      path: `${PACKAGE_ROOT}/contents/assembly-working-copy.wpdesign.json`,
      design: prepared.design,
      published: true,
    };

    await expect(finalizeAcceptedAssemblyWorkflow({ candidate: prepared })).rejects.toThrow(
      /publication/
    );
    expect(mocks.withRendererWorkspaceMutation).not.toHaveBeenCalled();
    expect(mocks.consumePackageCopy).not.toHaveBeenCalled();
  });

  it('drains an active draft save before acquiring the finalization write lease', async () => {
    let releaseDraft!: () => void;
    const draftWrite = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    mocks.drainMirrors.mockImplementation(async () => {
      await draftWrite;
    });
    const pending = finalizeAcceptedAssemblyWorkflow({ candidate: candidate(), notify: false });

    await Promise.resolve();
    await Promise.resolve();
    const acquiredBeforeDrain = mocks.withRendererWorkspaceMutation.mock.calls.length;
    releaseDraft();
    await pending;
    expect(acquiredBeforeDrain).toBe(0);
    expect(mocks.drainMirrors).toHaveBeenCalledWith(['design-1']);
    expect(mocks.withRendererWorkspaceMutation).toHaveBeenCalledOnce();
  });

  it('asks the workspace operation owner directly, under its own write token, before recording history', async () => {
    const result = await finalizeAcceptedAssemblyWorkflow({
      candidate: candidate(),
      notify: false,
    });

    expect(mocks.registerAcceptedAssemblyAsLimsEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        productGenBankContent: candidate().prepared.files.productGenBankContent,
      })
    );
    expect(mocks.runWorkspaceReconcileOperation).toHaveBeenCalledOnce();
    expect(mocks.runWorkspaceReconcileOperation).toHaveBeenCalledWith({
      workspaceRoot: ROOT,
      operationId: 'assembly-finalization:construct-1',
      mutationToken: 'finalization-token',
      strict: true,
      catalogSource: 'working-tree',
      healManagedHead: false,
      pendingSequenceDocument: {
        kind: 'managed-sequence',
        packageId: 'construct-1',
        packageRoot: PACKAGE_ROOT,
      },
      displayDelivery: 'optional',
      filesChanged: { revealPath: PACKAGE_ROOT, notifyGitStatus: true },
    });
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0];
    expect(order(mocks.runWorkspaceReconcileOperation)).toBeGreaterThan(
      order(mocks.registerAcceptedAssemblyAsLimsEntity)
    );
    expect(order(mocks.runWorkspaceReconcileOperation)).toBeLessThan(
      order(mocks.recordAcceptedAssemblyPrimers)
    );
    expect(order(mocks.runWorkspaceReconcileOperation)).toBeLessThan(
      order(mocks.commitPrimerBatchHistory)
    );
    expect(result.historyState).toBe('committed');
    expect(result.gitCommitSha).toBe('abc123');

    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(0);
  });

  it('stops before Git history when durable reconstruction fails, keeping the written package', async () => {
    mocks.runWorkspaceReconcileOperation.mockRejectedValueOnce(
      new Error('Workspace entity reconciliation failed for 1 item(s)')
    );
    const failure = await finalizeAcceptedAssemblyWorkflow({
      candidate: candidate(),
      notify: false,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AcceptedAssemblyProjectionError);
    expect((failure as Error).message).toContain('workspace records could not be rebuilt');
    expect((failure as Error).message).toContain('entity reconciliation failed');
    expect(mocks.writeAcceptedAssemblyFiles).toHaveBeenCalledOnce();
    expect(mocks.recordAcceptedAssemblyPrimers).not.toHaveBeenCalled();
    expect(mocks.commitPrimerBatchHistory).not.toHaveBeenCalled();
    expect(mocks.rememberFinalizedPlasmid).not.toHaveBeenCalled();
    expect(mocks.observeWorkflowAction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workflow: 'assembly',
        action: 'save',
        status: 'saved',
        outcomeKind: 'display_pending',
        artifactCorrelationId: 'construct-1',
        valueDelivered: false,
        usableResult: false,
      })
    );

    const stored = (useDesignStore.getState().designs['design-1'].acceptedAssemblyVersions ??
      []) as Array<{ lifecycleState: string }>;
    expect(stored.map((version) => version.lifecycleState)).toEqual(['written']);
    expect(useSequenceStore.getState().hasSequence('construct-1')).toBe(false);
  });

  it('completes durable history even when the optional Registry view could not reload', async () => {
    mocks.runWorkspaceReconcileOperation.mockResolvedValueOnce({
      ...completedReconciliation(),
      display: {
        state: 'failed',
        participants: 1,
        errors: [new Error('registry query failed')],
      },
    });
    const result = await finalizeAcceptedAssemblyWorkflow({
      candidate: candidate(),
      notify: false,
    });
    expect(result.historyState).toBe('committed');
    expect(mocks.commitPrimerBatchHistory).toHaveBeenCalledOnce();
    expect(useSequenceStore.getState().hasSequence('construct-1')).toBe(true);
  });

  it('keeps unrelated dirty Registry files out of a first finalization commit', async () => {
    mocks.gitStatus.mockResolvedValue(new Map([['.waypoint/lims/manifest.json', 'modified']]));
    await finalizeAcceptedAssemblyWorkflow({ candidate: candidate(), notify: false });
    expectCommitBaseline(new Set(['.waypoint/lims/manifest.json']));
    expect(mocks.gitStatus).toHaveBeenCalledOnce();
  });

  it("reuses the interrupted attempt's baseline on an exact retry in the same session", async () => {
    mocks.gitStatus.mockResolvedValueOnce(
      new Map([['.waypoint/lims/sheets/oligos.csv', 'modified']])
    );
    mocks.runWorkspaceReconcileOperation.mockRejectedValueOnce(new Error('projection failed'));
    await expect(
      finalizeAcceptedAssemblyWorkflow({ candidate: candidate(), notify: false })
    ).rejects.toBeInstanceOf(AcceptedAssemblyProjectionError);
    expect(mocks.commitPrimerBatchHistory).not.toHaveBeenCalled();

    mocks.gitStatus.mockClear();
    mocks.gitStatus.mockResolvedValue(
      new Map([
        ['assemblies/pUC-x/.forge/plasmid.json', 'untracked'],
        ['.waypoint/lims/manifest.json', 'untracked'],
        ['.waypoint/lims/sheets/plasmids.csv', 'untracked'],
        ['.waypoint/lims/sheets/oligos.csv', 'modified'],
      ])
    );
    await finalizeAcceptedAssemblyWorkflow({ candidate: retryCandidate(), notify: false });
    expectCommitBaseline(new Set(['.waypoint/lims/sheets/oligos.csv']));
    expect(mocks.gitStatus).not.toHaveBeenCalled();

    mocks.commitPrimerBatchHistory.mockClear();
    mocks.gitStatus.mockResolvedValue(new Map([['.waypoint/lims/manifest.json', 'modified']]));
    await finalizeAcceptedAssemblyWorkflow({ candidate: retryCandidate(), notify: false });
    expectCommitBaseline(new Set(['.waypoint/lims/manifest.json']));
  });

  it('commits the whole dirty export when retrying an uncommitted package without a remembered baseline', async () => {
    const elsewhere = candidate({ overwrite: true });
    elsewhere.prepared.files.packageRoot = `${ROOT}/assemblies/other-pkg`;
    elsewhere.prepared.files.metaPath = `${ROOT}/assemblies/other-pkg/.forge/plasmid.json`;
    mocks.gitStatus.mockResolvedValue(
      new Map([
        ['assemblies/other-pkg/.forge/plasmid.json', 'untracked'],
        ['.waypoint/lims/manifest.json', 'untracked'],
        ['.waypoint/lims/sheets/plasmids.csv', 'untracked'],
      ])
    );
    await finalizeAcceptedAssemblyWorkflow({ candidate: elsewhere, notify: false });
    expectCommitBaseline(new Set());
  });

  it('still excludes pre-existing Registry dirt when replacing a package that history already holds', async () => {
    const replace = candidate({ overwrite: true });
    replace.prepared.files.packageRoot = `${ROOT}/assemblies/tracked-pkg`;
    replace.prepared.files.metaPath = `${ROOT}/assemblies/tracked-pkg/.forge/plasmid.json`;
    mocks.gitStatus.mockResolvedValue(
      new Map([
        ['assemblies/tracked-pkg/.forge/plasmid.json', 'modified'],
        ['.waypoint/lims/manifest.json', 'modified'],
      ])
    );
    await finalizeAcceptedAssemblyWorkflow({ candidate: replace, notify: false });
    expectCommitBaseline(new Set(['.waypoint/lims/manifest.json']));
  });

  it('keeps pre-existing Registry dirt when the package record lies outside the workspace', async () => {
    const outside = candidate({ overwrite: true });
    outside.prepared.files.packageRoot = '/elsewhere/pkg';
    outside.prepared.files.metaPath = '/elsewhere/pkg/.forge/plasmid.json';
    mocks.gitStatus.mockResolvedValue(new Map([['.waypoint/lims/manifest.json', 'modified']]));
    await finalizeAcceptedAssemblyWorkflow({ candidate: outside, notify: false });
    expectCommitBaseline(new Set(['.waypoint/lims/manifest.json']));
  });

  it('records no Registry baseline for a workspace that is not a Git repository', async () => {
    mocks.isGitRepo.mockResolvedValue(false);
    await finalizeAcceptedAssemblyWorkflow({ candidate: candidate(), notify: false });
    expect(mocks.gitStatus).not.toHaveBeenCalled();
    expectCommitBaseline(new Set());
  });

  it('skips reconstruction and records no history when no mounted workspace owns the package', async () => {
    useWorkspaceStore.setState({ folders: [], fileTreeRefreshToken: 0 });
    const result = await finalizeAcceptedAssemblyWorkflow({
      candidate: candidate(),
      notify: false,
    });
    expect(mocks.runWorkspaceReconcileOperation).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(1);
    expect(result.historyState).toBe('not-git');
    expect(mocks.commitPrimerBatchHistory).not.toHaveBeenCalled();
  });

  it('skips reconstruction when the owner reports no native workspace (browser-only)', async () => {
    mocks.resolveReconcileWorkspaceRoot.mockReturnValue(null);
    const result = await finalizeAcceptedAssemblyWorkflow({
      candidate: candidate(),
      notify: false,
    });
    expect(mocks.runWorkspaceReconcileOperation).not.toHaveBeenCalled();
    expect(result.historyState).toBe('committed');
  });
});
