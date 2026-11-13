// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle/protocol';
import { createHostedWorkspaceRuntime, type HostedWorkspaceRuntimeDependencies } from './runtime';

function dependencies(): HostedWorkspaceRuntimeDependencies {
  return {
    loadIndex: vi.fn(async () => ({
      account: { id: 'account-1', email: 'scientist@example.test', displayName: 'Scientist' },
      workspaces: [
        {
          workspaceId: 'workspace-1',
          clientWorkspaceId: 'client-workspace-1',
          displayName: 'Shared project',
          ownerDisplayName: 'Scientist',
          access: { role: 'owner' },
          latest: { versionId: 'version-2', versionNumber: 2, contentSha256: 'a'.repeat(64) },
          storageBytesUsed: 30,
          versionCount: 2,
          updatedAt: '2026-09-18T10:00:00.000Z',
        },
      ],
    })),
    createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1' })),
    loadManifest: vi.fn(async (_workspaceId, versionId) => {
      const revisionNumber = versionId === 'version-4' ? 4 : versionId === 'version-3' ? 3 : 2;
      const files = [
        {
          resourceId: 'resource-1',
          path: 'sequences/one.gbk',
          contentSha256: (versionId === 'version-3' ? '3' : '1').repeat(64),
          sizeBytes: versionId === 'version-3' ? 4 : 10,
          contentType: 'application/genbank',
        },
        ...(versionId === 'version-4'
          ? []
          : [
              {
                resourceId: 'resource-2',
                path: 'sequences/two.gbk',
                contentSha256: '2'.repeat(64),
                sizeBytes: 20,
                contentType: 'application/genbank',
              },
            ]),
      ];
      return {
        workspaceId: 'workspace-1',
        version: {
          id: versionId,
          versionNumber: revisionNumber,
          contentSha256: 'a'.repeat(64),
          createdAt: '2026-09-18T10:00:00.000Z',
        },
        manifest: { schemaVersion: 1 as const, files },
        resourceIdentities: files.map((file) => ({
          path: file.path,
          resourceId: file.resourceId,
        })),
      };
    }),
    loadHistory: vi.fn(async () => ({
      workspaceId: 'workspace-1',
      versions: [
        {
          id: 'version-2',
          versionNumber: 2,
          representation: 'manifest_v1',
          manifestSchemaVersion: 1,
          contentSha256: 'a'.repeat(64),
          sizeBytes: 30,
          fileCount: 2,
          createdAt: '2026-09-18T10:00:00.000Z',
          finalizedAt: '2026-09-18T10:00:00.000Z',
          createdBy: {
            accountId: 'account-1',
            email: 'scientist@example.test',
            displayName: 'Scientist',
          },
        },
      ],
      nextBeforeVersionNumber: null,
    })),
    downloadFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    publishFiles: vi.fn(async (input) => ({
      id: 'version-3',
      versionNumber: 3,
      contentSha256: 'b'.repeat(64),
      files: [
        ...input.baseFiles.filter((file) => file.path !== input.files[0]?.path),
        {
          path: input.files[0]?.path ?? 'missing',
          contentSha256: '3'.repeat(64),
          sizeBytes: input.files[0]?.bytes.byteLength ?? 0,
          contentType: input.files[0]?.contentType ?? 'application/octet-stream',
        },
      ],
    })),
    restoreVersion: vi.fn(async () => ({
      id: 'version-4',
      versionNumber: 4,
      contentSha256: 'c'.repeat(64),
      files: [
        {
          path: 'sequences/one.gbk',
          contentSha256: '1'.repeat(64),
          sizeBytes: 10,
          contentType: 'application/genbank',
        },
      ],
    })),
  };
}

describe('hosted workspace runtime', () => {
  const acceptedFiles = [
    {
      resourceId: '11111111-1111-4111-8111-111111111111',
      path: 'notes/one.txt',
      contentSha256: createHash('sha256').update('one').digest('hex'),
      sizeBytes: 3,
      contentType: 'text/plain',
    },
    {
      resourceId: '22222222-2222-4222-8222-222222222222',
      path: 'notes/two.txt',
      contentSha256: createHash('sha256').update('two').digest('hex'),
      sizeBytes: 3,
      contentType: 'text/plain',
    },
  ];
  const acceptedPublication = () => ({
    id: '33333333-3333-4333-8333-333333333333',
    versionNumber: 1,
    contentSha256: createHash('sha256')
      .update(workspaceSyncManifestHashInput({ schemaVersion: 1, files: acceptedFiles }))
      .digest('hex'),
    files: acceptedFiles.map((file) => ({ ...file })),
  });
  const publicationInput = () => ({
    expectedAccountId: 'account-1',
    snapshot: { workspaceId: 'workspace-1', revisionId: null, revisionNumber: 0, files: [] },
    writes: acceptedFiles.map((file, index) => ({
      path: file.path,
      resourceId: file.resourceId,
      contentType: file.contentType,
      bytes: new TextEncoder().encode(index === 0 ? 'one' : 'two'),
    })),
  });

  it('acknowledges an exact server publication without a second manifest request', async () => {
    const deps = dependencies();
    deps.publishFiles = vi.fn(async () => acceptedPublication());
    deps.loadManifest = vi.fn(async () => {
      throw new Error('A duplicate read must not stall already accepted scientific inputs.');
    });
    const runtime = createHostedWorkspaceRuntime(deps);

    const accepted = await runtime.commit(publicationInput());

    expect(accepted).toEqual({
      workspaceId: 'workspace-1',
      revisionId: acceptedPublication().id,
      revisionNumber: 1,
      files: acceptedFiles.map((file) => ({
        ...file,
        contentRevision: `sha256:${file.contentSha256}`,
      })),
    });
    expect(deps.publishFiles).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAccountId: 'account-1', baseVersionId: null })
    );
    expect(deps.loadManifest).not.toHaveBeenCalled();
  });

  it.each([
    'missing resource identity',
    'malformed resource identity',
    'duplicate resource identity',
    'different manifest digest',
    'invalid revision number',
  ] as const)('reads back authoritative publication metadata for %s', async (failure) => {
    const publication = acceptedPublication();
    if (failure === 'missing resource identity') publication.files[0].resourceId = '';
    if (failure === 'malformed resource identity') publication.files[0].resourceId = 'unknown';
    if (failure === 'duplicate resource identity')
      publication.files[1].resourceId = publication.files[0].resourceId;
    if (failure === 'different manifest digest') publication.contentSha256 = 'f'.repeat(64);
    if (failure === 'invalid revision number') publication.versionNumber = 0;
    const deps = dependencies();
    deps.publishFiles = vi.fn(async () => publication);
    const runtime = createHostedWorkspaceRuntime(deps);

    await runtime.commit(publicationInput());

    expect(deps.loadManifest).toHaveBeenCalledWith('workspace-1', publication.id, 'account-1');
  });

  it('reuses validated recovery preparation only for the same account, base and immutable operation', async () => {
    const deps = dependencies();
    const retained = [
      {
        path: 'sequences/one.gbk',
        contentSha256: '3'.repeat(64),
        sizeBytes: 4,
        contentType: 'application/genbank',
      },
    ];
    deps.retainCandidate = vi.fn(async (input) => {
      input.onPrepared?.(retained);
      return {
        id: 'candidate',
        accountId: input.expectedAccountId!,
        baseVersionId: input.baseVersionId,
        contentSha256: 'a'.repeat(64),
        requestSha256: 'b'.repeat(64),
        reason: 'dirty' as const,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        coverage: 'captured-bytes' as const,
      };
    });
    const runtime = createHostedWorkspaceRuntime(deps);
    const index = await runtime.listWorkspaces();
    const snapshot = await runtime.loadWorkspace(index.workspaces[0]);
    const input = {
      snapshot,
      writes: [
        {
          path: 'sequences/one.gbk',
          bytes: new Uint8Array([1, 2, 3, 4]),
          contentType: 'application/genbank',
        },
      ],
      operationId: 'owned-save',
      expectedAccountId: 'account-1',
    };
    await runtime.retainRecoveryCandidate!(input);
    await runtime.commit({ ...input, expectedAccountId: 'other-account' });
    expect(vi.mocked(deps.publishFiles).mock.calls[0]).toHaveLength(1);
    await runtime.commit(input);
    expect(vi.mocked(deps.publishFiles).mock.calls[1][1]).toEqual(retained);
    await runtime.commit(input);
    expect(vi.mocked(deps.publishFiles).mock.calls[2]).toHaveLength(1);
  });

  it('never derives a missing mutation account from a later background index', async () => {
    const deps = dependencies();
    const runtime = createHostedWorkspaceRuntime(deps);
    const index = await runtime.listWorkspaces();
    const snapshot = await runtime.loadWorkspace(index.workspaces[0]);
    await expect(runtime.createWorkspace!('Project')).rejects.toMatchObject({
      code: 'account_changed',
    });
    await expect(runtime.commit({ snapshot, writes: [] })).rejects.toMatchObject({
      code: 'account_changed',
    });
    await expect(
      runtime.restoreRevision!({
        snapshot,
        workspace: index.workspaces[0],
        revisionId: 'version-1',
      })
    ).rejects.toMatchObject({ code: 'account_changed' });
    expect(deps.createWorkspace).not.toHaveBeenCalled();
    expect(deps.publishFiles).not.toHaveBeenCalled();
    expect(deps.restoreVersion).not.toHaveBeenCalled();
  });

  it('forwards the initiating create principal and fences the resulting index read', async () => {
    const deps = dependencies();
    const runtime = createHostedWorkspaceRuntime(deps);
    await runtime.listWorkspaces();
    await runtime.createWorkspace!('Project', 'account-1');
    expect(deps.createWorkspace).toHaveBeenCalledWith('Project', 'account-1');
    expect(deps.loadIndex).toHaveBeenLastCalledWith('account-1');
  });
  it('preserves the operation account fence after a different account is listed', async () => {
    const deps = dependencies();
    deps.retainCandidate = vi.fn(async () => ({
      id: 'candidate',
      accountId: 'original-owner',
      baseVersionId: null,
      reason: 'dirty' as const,
      createdAt: '2026-01-01',
      expiresAt: '2100-01-01',
      coverage: 'captured-bytes' as const,
    }));
    const runtime = createHostedWorkspaceRuntime(deps);
    const index = await runtime.listWorkspaces();
    const snapshot = await runtime.loadWorkspace(index.workspaces[0]);
    const input = {
      snapshot,
      writes: [],
      operationId: 'persisted-intent',
      expectedAccountId: 'original-owner',
    };
    await runtime.commit(input);
    await runtime.retainRecoveryCandidate!(input);
    await runtime.restoreRevision!({
      snapshot,
      workspace: index.workspaces[0],
      revisionId: 'version-1',
      expectedAccountId: 'original-owner',
    });
    for (const operation of [deps.publishFiles, deps.retainCandidate, deps.restoreVersion]) {
      expect(operation).toHaveBeenCalledWith(
        expect.objectContaining({ expectedAccountId: 'original-owner' })
      );
    }
    expect(deps.loadManifest).toHaveBeenCalledWith(
      snapshot.workspaceId,
      'version-3',
      'original-owner'
    );
    expect(deps.loadManifest).toHaveBeenCalledWith(
      snapshot.workspaceId,
      'version-4',
      'original-owner'
    );
  });
  it('reports durable hosted resource identity explicitly', () => {
    const runtime = createHostedWorkspaceRuntime(dependencies());

    expect(runtime.descriptor).toMatchObject({
      kind: 'hosted-browser',
      authority: 'dnaforge-manifest-revisions',
      identityFidelity: 'stable-resource-id',
      capabilities: { createWorkspace: true, multiFile: true, write: true },
    });
  });

  it('maps the hosted index and complete accepted manifest into the shared contract', async () => {
    const deps = dependencies();
    const runtime = createHostedWorkspaceRuntime(deps);

    const index = await runtime.listWorkspaces();
    expect(index.principal).toEqual({
      id: 'account-1',
      label: 'Scientist',
      secondaryLabel: 'scientist@example.test',
    });
    const snapshot = await runtime.loadWorkspace(index.workspaces[0]);
    expect(snapshot).toMatchObject({
      workspaceId: 'workspace-1',
      revisionId: 'version-2',
      revisionNumber: 2,
    });
    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.files.map((file) => file.resourceId)).toEqual(['resource-1', 'resource-2']);
  });

  it('commits against the accepted base while retaining every unchanged file', async () => {
    const deps = dependencies();
    const runtime = createHostedWorkspaceRuntime(deps);
    const workspace = (await runtime.listWorkspaces()).workspaces[0];
    const snapshot = await runtime.loadWorkspace(workspace);

    const accepted = await runtime.commit({
      expectedAccountId: 'account-1',
      snapshot,
      writes: [
        {
          path: 'sequences/one.gbk',
          bytes: new Uint8Array([4, 5, 6, 7]),
          contentType: 'application/genbank',
        },
      ],
    });

    expect(deps.publishFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        baseVersionId: 'version-2',
        baseFiles: expect.arrayContaining([
          expect.objectContaining({ path: 'sequences/one.gbk', resourceId: 'resource-1' }),
          expect.objectContaining({ path: 'sequences/two.gbk', resourceId: 'resource-2' }),
        ]),
      })
    );
    expect(accepted.revisionId).toBe('version-3');
    expect(accepted.files.map((file) => file.path).sort()).toEqual([
      'sequences/one.gbk',
      'sequences/two.gbk',
    ]);
  });

  it('passes removed placements through to the hosted publisher', async () => {
    const deps = dependencies();
    const runtime = createHostedWorkspaceRuntime(deps);
    const workspace = (await runtime.listWorkspaces()).workspaces[0];
    const snapshot = await runtime.loadWorkspace(workspace);

    await runtime.commit({
      expectedAccountId: 'account-1',
      snapshot,
      writes: [
        {
          path: 'sequences/renamed.gbk',
          bytes: new Uint8Array([4, 5, 6]),
          contentType: 'application/genbank',
          resourceId: 'resource-1',
        },
      ],
      removePaths: ['sequences/one.gbk'],
    });

    expect(deps.publishFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        removePaths: ['sequences/one.gbk'],
        files: [
          expect.objectContaining({
            path: 'sequences/renamed.gbk',
            resourceId: 'resource-1',
          }),
        ],
      })
    );
  });

  it('lists immutable manifest history and restores through accepted-base compare-and-swap', async () => {
    const deps = dependencies();
    const runtime = createHostedWorkspaceRuntime(deps);
    const workspace = (await runtime.listWorkspaces()).workspaces[0];
    const snapshot = await runtime.loadWorkspace(workspace);

    await expect(runtime.listHistory?.(workspace)).resolves.toEqual([
      expect.objectContaining({
        revisionId: 'version-2',
        revisionNumber: 2,
        createdByLabel: 'Scientist',
      }),
    ]);
    const accepted = await runtime.restoreRevision?.({
      expectedAccountId: 'account-1',
      workspace,
      snapshot,
      revisionId: 'version-1',
    });

    expect(deps.restoreVersion).toHaveBeenCalledWith({
      expectedAccountId: 'account-1',
      workspaceId: 'workspace-1',
      baseVersionId: 'version-2',
      revisionId: 'version-1',
    });
    expect(accepted).toMatchObject({ revisionId: 'version-4', revisionNumber: 4 });
  });
});
