import { describe, expect, it, vi } from 'vitest';
import type { QuickLookPackageReceipt } from '../../shared/file-association-ipc';
import { promoteQuickLookToDestination } from './quick-look-destination-promotion';

const receipt: QuickLookPackageReceipt = {
  sourcePath: '/source/example.gb',
  sourceFileName: 'example.gb',
  familyId: 'genbank',
  contentHash: 'source-hash',
  packageRoot: '/cache/example/package',
  productPath: '/cache/example/package/example.gb',
  records: [
    {
      recordId: 'record-example',
      ordinal: 0,
      displayName: 'example',
      sequenceLength: 4,
      circular: false,
      productPath: '/cache/example/package/example.gb',
    },
  ],
};

function dependencies() {
  const releaseMutationBlock = vi.fn();
  return {
    prepareWorkspace: vi.fn(async () => ({
      workspaceUuid: 'workspace-uuid',
      repoPath: '/managed/workspace-uuid/repo',
      displayName: 'example',
      workspaceContainerPath: '/managed/workspace-uuid',
      ownerToken: 'owner-token',
      containerDevice: '1',
      containerInode: '2',
      journalPath: '/journal/workspace-uuid.json',
      releaseMutationBlock,
    })),
    activateWorkspace: vi.fn(async () => undefined),
    discardWorkspace: vi.fn(async () => undefined),
    promoteToRoot: vi.fn(async () => ({
      destPath: '/managed/workspace-uuid/repo/example/example.gb',
      relPath: 'example/example.gb',
      committed: true,
      records: [
        {
          recordId: 'record-example',
          destPath: '/managed/workspace-uuid/repo/example/example.gb',
          relPath: 'example/example.gb',
        },
      ],
    })),
  };
}

describe('promoteQuickLookToDestination', () => {
  it('creates and reports a new workspace only after its package promotion succeeds', async () => {
    const deps = dependencies();

    await expect(
      promoteQuickLookToDestination(
        { receipt, destination: { kind: 'new-workspace', name: 'example' } },
        deps
      )
    ).resolves.toMatchObject({
      workspaceRoot: '/managed/workspace-uuid/repo',
      createdNewWorkspace: true,
      createdWorkspaceName: 'example',
    });
    expect(deps.promoteToRoot).toHaveBeenCalledWith(receipt, '/managed/workspace-uuid/repo');
    expect(deps.activateWorkspace).toHaveBeenCalledOnce();
    expect(deps.discardWorkspace).not.toHaveBeenCalled();
    expect(deps.prepareWorkspace.mock.results[0]?.value).toBeDefined();
  });

  it('discards a newly created workspace when promotion fails before publication', async () => {
    const deps = dependencies();
    deps.promoteToRoot.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      promoteQuickLookToDestination(
        { receipt, destination: { kind: 'new-workspace', name: 'example' } },
        deps
      )
    ).rejects.toThrow('disk full');
    expect(deps.discardWorkspace).toHaveBeenCalledWith({
      workspaceUuid: 'workspace-uuid',
      repoPath: '/managed/workspace-uuid/repo',
      displayName: 'example',
      workspaceContainerPath: '/managed/workspace-uuid',
      ownerToken: 'owner-token',
      containerDevice: '1',
      containerInode: '2',
      journalPath: '/journal/workspace-uuid.json',
      releaseMutationBlock: expect.any(Function),
    });
  });

  it('discards the unpublished workspace when activation fails', async () => {
    const deps = dependencies();
    deps.activateWorkspace.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      promoteQuickLookToDestination(
        { receipt, destination: { kind: 'new-workspace', name: 'example' } },
        deps
      )
    ).rejects.toThrow('database unavailable');
    expect(deps.discardWorkspace).toHaveBeenCalledOnce();
  });

  it('reports both the promotion and rollback failures instead of hiding an orphan', async () => {
    const deps = dependencies();
    deps.promoteToRoot.mockRejectedValueOnce(new Error('disk full'));
    deps.discardWorkspace.mockRejectedValueOnce(new Error('cleanup denied'));

    const failure = await promoteQuickLookToDestination(
      { receipt, destination: { kind: 'new-workspace', name: 'example' } },
      deps
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: 'Quick Look promotion failed and its unpublished project could not be cleaned up.',
      errors: [
        expect.objectContaining({ message: 'disk full' }),
        expect.objectContaining({ message: 'cleanup denied' }),
      ],
    });
  });

  it('never creates or discards a workspace for an existing destination', async () => {
    const deps = dependencies();

    await expect(
      promoteQuickLookToDestination(
        { receipt, destination: { kind: 'existing-workspace', rootPath: '/workspace' } },
        deps
      )
    ).resolves.toMatchObject({
      workspaceRoot: '/workspace',
      createdNewWorkspace: false,
      createdWorkspaceName: null,
    });
    expect(deps.prepareWorkspace).not.toHaveBeenCalled();
    expect(deps.activateWorkspace).not.toHaveBeenCalled();
    expect(deps.discardWorkspace).not.toHaveBeenCalled();
  });
});
