import { execDesignContract } from '../../test-utils/design-output-test-helper';
import { reopenAcceptedAssemblyOutputSchema } from '../ai/tools/design-output-schemas';
import { createReopenAcceptedAssemblyTool } from '../ai/tools/accepted-assembly-lifecycle';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useDesignStore } from '../design/store';
import { useDesignRecoveryStore } from '../design/public/design-recovery';
import type { SequenceDesign } from '../design/public/types';
import type { ResolvedAcceptedAssemblyRecord } from './accepted-record-reader';

const PACKAGE_ROOT = '/workspace/assemblies/pConstruct';
const COPY_PATH = `${PACKAGE_ROOT}/contents/assembly-working-copy.wpdesign.json`;

const mocks = vi.hoisted(() => ({
  copy: null as {
    packageRoot: string;
    path: string;
    design: SequenceDesign;
    published: boolean;
  } | null,
  legacyNames: [] as string[],
  legacyDesignNames: {} as Record<string, string>,
  trashItem: vi.fn(),
  events: [] as Array<{ entity_id: string; event_type: string; payload: string | null }>,
  createCopy: vi.fn(),
  readCopy: vi.fn(),
  beginWorkspaceMutation: vi.fn(async () => 'reopen-token'),
  endWorkspaceMutation: vi.fn(),
  recordCatalogEvent: vi.fn(),
}));

vi.mock('../../db/sequence-package-working-copy-storage', () => ({
  readPackageAssemblyWorkingCopy: mocks.readCopy.mockImplementation(async () => mocks.copy),
  createPackageAssemblyWorkingCopy: mocks.createCopy.mockImplementation(
    async (input: { packageRoot: string; design: SequenceDesign }) => {
      if (mocks.copy) throw new Error('A package working copy already exists.');
      mocks.copy = {
        packageRoot: input.packageRoot,
        path: COPY_PATH,
        design: input.design,
        published: false,
      };
      return { copy: mocks.copy, created: true };
    }
  ),
}));

vi.mock('../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/workspace-catalog')>()),
  getCurrentCatalogFileForEntity: vi.fn(async () => null),
  getCatalogEntityByLocator: vi.fn(async () => null),
  findConstructIdForAcceptedAssemblyVersion: vi.fn(async () => null),
  getCatalogEventsForEntity: vi.fn(async (entityId: string) =>
    mocks.events.filter((event) => event.entity_id === entityId)
  ),
  recordCatalogEvent: mocks.recordCatalogEvent.mockImplementation(
    async (input: { entityId: string; eventType: string; payload?: Record<string, unknown> }) => {
      mocks.events.push({
        entity_id: input.entityId,
        event_type: input.eventType,
        payload: input.payload ? JSON.stringify(input.payload) : null,
      });
    }
  ),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      readDir: vi.fn(async () =>
        mocks.legacyNames.map((name) => ({ name, isFile: true, isDirectory: false }))
      ),
      readTextFile: vi.fn(async (path: string) =>
        JSON.stringify({
          schema: 'waypoint.design.v1',
          kind: 'assembly-design',
          id: `legacy-${path.split('/').pop()}`,
          name: 'Legacy draft',
          design: {
            id: `legacy-${path.split('/').pop()}`,
            name: mocks.legacyDesignNames[path.split('/').pop() ?? ''] ?? 'Legacy draft',
            constructId: 'construct-1',
            parentAcceptedAssemblyVersionId: 'accepted-1',
          },
        })
      ),
      beginWorkspaceMutation: mocks.beginWorkspaceMutation,
      endWorkspaceMutation: mocks.endWorkspaceMutation,
    },
    shell: {
      trashItem: mocks.trashItem.mockImplementation(async (path: string) => {
        mocks.legacyNames = mocks.legacyNames.filter((name) => !path.endsWith(`/${name}`));
      }),
    },
  }),
}));

import { reopenAcceptedAssemblyWorkflow } from './accepted-reopen-workflow';

describe('package-owned accepted assembly editing', () => {
  beforeEach(() => {
    mocks.copy = null;
    mocks.legacyNames = [];
    mocks.legacyDesignNames = {};
    mocks.events = [];
    vi.clearAllMocks();
    localStorage.clear();
    useDesignRecoveryStore.setState({ records: {} });
    useDesignStore.setState({ designs: {}, activeDesignId: null });
    useWorkspaceStore.setState({
      folders: [{ name: 'workspace', path: '/workspace', addedAt: 1 }],
    });
  });

  it('creates one member inside the package and resumes it for exact and different keys', async () => {
    const first = await execDesignContract(
      reopenAcceptedAssemblyOutputSchema,
      createReopenAcceptedAssemblyTool(input('first-key').resolveRecord),
      { acceptedAssemblyVersionId: 'accepted-1', idempotencyKey: 'first-key' }
    );
    const exact = await reopenAcceptedAssemblyWorkflow(input('first-key'));
    const differentKey = await reopenAcceptedAssemblyWorkflow(input('second-key'));

    expect(first).toMatchObject({
      status: 'completed',
      idempotentReplay: false,
      constructId: 'construct-1',
      parentAcceptedAssemblyVersionId: 'accepted-1',
      draftPath: COPY_PATH,
    });
    expect(exact).toMatchObject({ designId: first.designId, idempotentReplay: true });
    expect(differentKey).toMatchObject({ designId: first.designId, idempotentReplay: true });
    expect(mocks.createCopy).toHaveBeenCalledTimes(1);
    expect(mocks.createCopy).toHaveBeenCalledWith(
      expect.objectContaining({ packageRoot: PACKAGE_ROOT, packageId: 'construct-1' })
    );
    expect(mocks.events).toHaveLength(1);
    expect(mocks.beginWorkspaceMutation).toHaveBeenCalledWith('/workspace', undefined);
    expect(mocks.endWorkspaceMutation).toHaveBeenCalledWith('reopen-token');
  });

  it('keeps newer loaded edits when the member file lags behind', async () => {
    const first = await reopenAcceptedAssemblyWorkflow(input('first-key'));
    useDesignStore.getState().updateDesign(first.designId, { name: 'Edited in memory' });

    const repeated = await reopenAcceptedAssemblyWorkflow(input('second-key'));

    expect(repeated.designId).toBe(first.designId);
    expect(useDesignStore.getState().designs[first.designId].name).toBe('Edited in memory');
    expect(mocks.createCopy).toHaveBeenCalledTimes(1);
  });

  it('loads the durable member after the draft is unloaded', async () => {
    const first = await reopenAcceptedAssemblyWorkflow(input('first-key'));
    mocks.copy = {
      ...mocks.copy!,
      design: { ...mocks.copy!.design, name: 'Saved edit' },
    };
    useDesignStore.setState({ designs: {}, activeDesignId: null });
    useDesignRecoveryStore.setState({ records: {} });
    localStorage.clear();

    const repeated = await reopenAcceptedAssemblyWorkflow(input('second-key'));

    expect(repeated.designId).toBe(first.designId);
    expect(useDesignStore.getState().designs[first.designId].name).toBe('Saved edit');
    expect(mocks.createCopy).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a consumed copy from the accepted recipe', async () => {
    await reopenAcceptedAssemblyWorkflow(input('first-key'));
    mocks.copy = null;

    await expect(reopenAcceptedAssemblyWorkflow(input('second-key'))).rejects.toThrow(
      /consumed or removed/
    );
    expect(mocks.createCopy).toHaveBeenCalledTimes(1);
  });

  it('refuses to edit a copy left behind after its accepted product was written', async () => {
    await reopenAcceptedAssemblyWorkflow(input('first-key'));
    mocks.copy = { ...mocks.copy!, published: true };

    await expect(reopenAcceptedAssemblyWorkflow(input('second-key'))).rejects.toThrow(
      /publication is reconciled/
    );
    expect(mocks.createCopy).toHaveBeenCalledTimes(1);
  });

  it('consolidates identical legacy sibling drafts into the package copy', async () => {
    mocks.legacyNames = ['first-reopened-abc.wpdesign.json', 'second-reopened-def.wpdesign.json'];
    const oldId = 'legacy-first-reopened-abc.wpdesign.json';
    useDesignStore.setState({
      designs: {
        [oldId]: {
          id: oldId,
          name: 'Legacy draft',
          constructId: 'construct-1',
          parentAcceptedAssemblyVersionId: 'accepted-1',
          proposedPlans: [],
        } as SequenceDesign,
      },
    });

    const migrated = await reopenAcceptedAssemblyWorkflow(input('first-key'));
    expect(migrated.draftPath).toBe(COPY_PATH);
    expect(mocks.createCopy).toHaveBeenCalledOnce();
    expect(mocks.trashItem).toHaveBeenCalledTimes(2);
    expect(mocks.legacyNames).toEqual([]);
  });

  it('preserves distinct legacy edits instead of choosing one', async () => {
    mocks.legacyNames = ['first-reopened-abc.wpdesign.json', 'second-reopened-def.wpdesign.json'];
    mocks.legacyDesignNames['second-reopened-def.wpdesign.json'] = 'Edited legacy draft';

    await expect(reopenAcceptedAssemblyWorkflow(input('first-key'))).rejects.toThrow(
      /different legacy assembly drafts.*reconciled explicitly/
    );
    expect(mocks.createCopy).not.toHaveBeenCalled();
    expect(mocks.trashItem).not.toHaveBeenCalled();
  });

  it('rejects product drift and cancellation before creating a member', async () => {
    const drifted = record();
    drifted.integrity.productGenBank = 'drifted';
    await expect(
      reopenAcceptedAssemblyWorkflow({ ...input('drifted'), resolveRecord: async () => drifted })
    ).rejects.toThrow(/integrity is drifted/);
    const controller = new AbortController();
    controller.abort();
    await expect(
      reopenAcceptedAssemblyWorkflow({ ...input('canceled'), abortSignal: controller.signal })
    ).rejects.toThrow(/canceled before creating/);
    expect(mocks.createCopy).not.toHaveBeenCalled();
  });

  it('coalesces concurrent exact requests', async () => {
    const [first, second] = await Promise.all([
      reopenAcceptedAssemblyWorkflow(input('concurrent')),
      reopenAcceptedAssemblyWorkflow(input('concurrent')),
    ]);
    expect(first.designId).toBe(second.designId);
    expect([first.idempotentReplay, second.idempotentReplay].sort()).toEqual([false, true]);
    expect(mocks.createCopy).toHaveBeenCalledTimes(1);
  });
});

function input(idempotencyKey: string) {
  return {
    selector: { constructId: 'construct-1', acceptedAssemblyVersionId: 'accepted-1' },
    idempotencyKey,
    actor: 'agent:test',
    resolveRecord: async () => record(),
  };
}

function record(): ResolvedAcceptedAssemblyRecord {
  const accepted: ResolvedAcceptedAssemblyRecord['accepted'] = {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: 'accepted-1',
    lifecycleState: 'written',
    acceptedAt: '2026-08-05T18:00:00.000Z',
    designId: 'original-draft',
    constructId: 'construct-1',
    designName: 'pConstruct',
    construction: {
      method: 'gibson',
      topology: 'circular',
      canonicalDraftChecksum: 'sha256:draft',
      regionCount: 0,
      spacerCount: 0,
    },
    projectionInput: {
      schemaVersion: 1,
      designId: 'original-draft',
      constructId: 'construct-1',
      designName: 'pConstruct',
      topology: 'circular',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      productSequence: '',
      regions: [],
      spacers: [],
      homologyRegions: [],
      designPrimers: [],
      sourceProvenance: [],
      canonicalDraftChecksum: 'sha256:draft',
    },
    validationSnapshot: {
      schemaVersion: 1,
      designId: 'original-draft',
      designVersion: 4,
      assemblyMethod: 'gibson',
      projectionInputChecksum: 'sha256:draft',
      validatedAt: '2026-08-05T17:59:00.000Z',
      clean: true,
      issues: [],
    },
    artifacts: {
      productGenBankPath: `${PACKAGE_ROOT}/pConstruct.gb`,
      sidecarJsonPath: `${PACKAGE_ROOT}/.forge/plasmid.json`,
      productSequenceChecksum: 'sha256:product',
      canonicalDraftChecksum: 'sha256:draft',
    },
  };
  return {
    constructId: 'construct-1',
    packageId: 'construct-1',
    packageRoot: PACKAGE_ROOT,
    productPath: `${PACKAGE_ROOT}/pConstruct.gb`,
    metaPath: `${PACKAGE_ROOT}/.forge/plasmid.json`,
    acceptedAssemblyVersionId: 'accepted-1',
    acceptedRecords: [accepted],
    recordIsCurrent: true,
    integrity: {
      productGenBank: 'verified',
      expectedChecksum: 'sha256:genbank',
      actualChecksum: 'sha256:genbank',
    },
    catalogEvents: [],
    accepted,
  };
}
