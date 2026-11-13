import { describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';

vi.mock('../../shared/developer-import-sources', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../shared/developer-import-sources')>();
  return {
    ...original,
    isDeveloperImportSourcePath: (path: string) =>
      original.isDeveloperImportSourcePath(path, ['/developer/wp-assets']),
  };
});
import {
  HOSTED_RESOURCE_BINDINGS_PATH,
  serializeHostedResourceBindings,
} from '../../shared/hosted-resource-bindings';
import { NATIVE_WORKSPACE_MANIFEST_PATH } from '../../shared/native-workspace-manifest';
import {
  createElectronWorkspaceRuntime,
  type ElectronWorkspaceRuntimeDependencies,
} from './electron-runtime';

const FIRST_HASH = '75c8fd04ad916aec3e3d5cb76a452b116b3d4d0912a0a485e9fb8e3d240e210c';
const UPDATED_HASH = '3'.repeat(64);
const FIRST_OID = 'e7d1ed77ea12a50bc541bd9b9dc12b6174eeef5b';
const SECOND_OID = 'bcac7f7017e34b875f67546ef516866c70870dab';

function dependencies(): ElectronWorkspaceRuntimeDependencies {
  return {
    listRoots: () => [{ path: '/workspace', name: 'Local project' }],
    createRoot: vi.fn(async (name) => ({ path: '/created', name })),
    indexHead: vi.fn(async () => ({
      headCommit: 'git-head',
      files: [
        {
          relPath: '.forge/catalog.json',
          oid: 'c'.repeat(40),
          sizeBytes: 400,
          modifiedAt: 1,
        },
        { relPath: 'sequences/first.gbk', oid: FIRST_OID, sizeBytes: 3, modifiedAt: 1 },
        { relPath: 'sequences/second.gbk', oid: SECOND_OID, sizeBytes: 3, modifiedAt: 1 },
      ],
    })),
    readFileBounded: vi.fn(async (path) =>
      path.endsWith('first.gbk') ? new Uint8Array([1, 1, 1]) : new Uint8Array([2, 2, 2])
    ),
    readTextFile: vi.fn(async (path) => {
      if (path.endsWith(`/${NATIVE_WORKSPACE_MANIFEST_PATH}`)) return nativeCatalogJson();
      throw new Error(`unexpected text read: ${path}`);
    }),
    fileExists: vi.fn(async (path) => path.endsWith(`/${NATIVE_WORKSPACE_MANIFEST_PATH}`)),
    beginMutation: vi.fn(async () => 'mutation-one'),
    endMutation: vi.fn(async () => undefined),
    writeTextFileAtomic: vi.fn(async (input) => {
      return { path: input.path, contentHash: UPDATED_HASH };
    }),
  };
}

describe('Electron workspace runtime', () => {
  it('offers actual project roots without promoting developer import sources into sessions', async () => {
    const previous = useWorkspaceStore.getState().folders;
    try {
      useWorkspaceStore.setState({
        folders: [
          { path: '/developer/wp-assets', name: 'Source', addedAt: 1 },
          { path: '/projects/one', name: 'One', addedAt: 1 },
          { path: '/projects/pinned', name: 'Pinned project', pinned: true, addedAt: 1 },
        ],
      });
      const workspaces = (await createElectronWorkspaceRuntime().listWorkspaces()).workspaces;
      expect(workspaces.map((workspace) => workspace.workspaceId)).toEqual([
        '/projects/one',
        '/projects/pinned',
      ]);
    } finally {
      useWorkspaceStore.setState({ folders: previous });
    }
  });

  it('loads a real local working copy while preserving catalog resource IDs', async () => {
    const deps = dependencies();
    const runtime = createElectronWorkspaceRuntime(deps);
    const workspace = (await runtime.listWorkspaces()).workspaces[0];
    const snapshot = await runtime.loadWorkspace(workspace);

    expect(runtime.descriptor).toMatchObject({
      kind: 'electron',
      authority: 'local-working-copy',
      identityFidelity: 'path-placement-only',
    });
    expect(snapshot.files).toEqual([
      expect.objectContaining({
        path: 'sequences/first.gbk',
        resourceId: 'resource-first',
        contentRevision: `git-blob:${FIRST_OID}`,
        contentSha256: null,
      }),
      expect.objectContaining({
        path: 'sequences/second.gbk',
        resourceId: 'resource-second',
        contentRevision: `git-blob:${SECOND_OID}`,
        contentSha256: null,
      }),
    ]);
    expect(snapshot.revisionId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('opens through a size-bounded read and verifies the Git blob revision', async () => {
    const deps = dependencies();
    const runtime = createElectronWorkspaceRuntime(deps);
    const workspace = (await runtime.listWorkspaces()).workspaces[0];
    const snapshot = await runtime.loadWorkspace(workspace);

    await expect(runtime.readFile({ snapshot, file: snapshot.files[0] })).resolves.toEqual(
      new Uint8Array([1, 1, 1])
    );
    expect(deps.readFileBounded).toHaveBeenCalledWith('/workspace/sequences/first.gbk', 3);
  });

  it('opens delivered accepted bytes over an external working edit while retaining snapshot identity and hash checks', async () => {
    const deps = {
      ...dependencies(),
      readAcceptedFile: vi.fn(async () => ({
        bytes: new Uint8Array([1, 1, 1]),
        resourceId: 'resource-first',
      })),
    };
    vi.mocked(deps.readFileBounded).mockResolvedValue(new Uint8Array([9, 9, 9]));
    const runtime = createElectronWorkspaceRuntime(deps);
    const snapshot = await runtime.loadWorkspace((await runtime.listWorkspaces()).workspaces[0]);
    await expect(runtime.readFile({ snapshot, file: snapshot.files[0] })).resolves.toEqual(
      new Uint8Array([1, 1, 1])
    );
    expect(deps.readFileBounded).not.toHaveBeenCalled();
    deps.readAcceptedFile.mockResolvedValueOnce({
      bytes: new Uint8Array([2, 2, 2]),
      resourceId: 'resource-first',
    });
    await expect(runtime.readFile({ snapshot, file: snapshot.files[0] })).rejects.toThrow(
      'changed before'
    );
    deps.readAcceptedFile.mockResolvedValueOnce({
      bytes: new Uint8Array([1, 1, 1]),
      resourceId: 'another-resource',
    });
    await expect(runtime.readFile({ snapshot, file: snapshot.files[0] })).rejects.toThrow(
      'identity changed'
    );
    expect(deps.readFileBounded).not.toHaveBeenCalled();
  });

  it('retains accepted read failure rather than falling back to valid working bytes', async () => {
    const deps = {
      ...dependencies(),
      readAcceptedFile: vi.fn(async () => {
        throw Error('accepted data unavailable');
      }),
    };
    const runtime = createElectronWorkspaceRuntime(deps);
    const snapshot = await runtime.loadWorkspace((await runtime.listWorkspaces()).workspaces[0]);
    await expect(runtime.readFile({ snapshot, file: snapshot.files[0] })).rejects.toThrow(
      'accepted data unavailable'
    );
    expect(deps.readFileBounded).not.toHaveBeenCalled();
  });

  it('commits with an accepted-HEAD stale check and an atomic file precondition', async () => {
    const deps = dependencies();
    const runtime = createElectronWorkspaceRuntime(deps);
    const workspace = (await runtime.listWorkspaces()).workspaces[0];
    const snapshot = await runtime.loadWorkspace(workspace);

    const accepted = await runtime.commit({
      snapshot,
      writes: [
        {
          resourceId: 'resource-first',
          path: 'sequences/first.gbk',
          bytes: new TextEncoder().encode('next'),
          contentType: 'application/genbank',
        },
      ],
    });

    expect(deps.writeTextFileAtomic).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      path: '/workspace/sequences/first.gbk',
      content: 'next',
      mode: 'replace',
      expectedContentHash: FIRST_HASH,
      mutationToken: 'mutation-one',
      artifactNoun: 'workspace file',
    });
    expect(deps.endMutation).toHaveBeenCalledWith('mutation-one');
    expect(accepted.files).toEqual([
      expect.objectContaining({
        path: 'sequences/first.gbk',
        contentRevision: `git-blob:${FIRST_OID}`,
        contentSha256: null,
      }),
      expect.objectContaining({
        path: 'sequences/second.gbk',
        contentRevision: `git-blob:${SECOND_OID}`,
        contentSha256: null,
      }),
    ]);
  });

  it('refuses to overwrite when any local file changed after the snapshot', async () => {
    const deps = dependencies();
    const runtime = createElectronWorkspaceRuntime(deps);
    const workspace = (await runtime.listWorkspaces()).workspaces[0];
    const snapshot = await runtime.loadWorkspace(workspace);
    vi.mocked(deps.indexHead).mockResolvedValueOnce({ headCommit: 'changed-head', files: [] });

    await expect(
      runtime.commit({
        snapshot,
        writes: [
          {
            path: 'sequences/first.gbk',
            bytes: new TextEncoder().encode('next'),
            contentType: 'application/genbank',
          },
        ],
      })
    ).rejects.toThrow(/LOCAL_WORKSPACE_CONFLICT/u);
    expect(deps.beginMutation).not.toHaveBeenCalled();
  });

  it('loads hosted resource identities from the tracked bindings file', async () => {
    const deps = dependencies();
    vi.mocked(deps.fileExists).mockImplementation(async (path) =>
      path.endsWith(`/${HOSTED_RESOURCE_BINDINGS_PATH}`)
    );
    vi.mocked(deps.readTextFile).mockImplementation(async (path) => {
      if (!path.endsWith(`/${HOSTED_RESOURCE_BINDINGS_PATH}`)) {
        throw new Error(`unexpected text read: ${path}`);
      }
      return serializeHostedResourceBindings({
        schema: 1,
        remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
        remoteVersionId: '54a53fed-2b63-44c8-a26e-b0fb7e1788d2',
        resources: [
          {
            resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
            path: 'sequences/first.gbk',
            contentSha256: 'a'.repeat(64),
          },
          {
            resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
            path: 'sequences/second.gbk',
            contentSha256: 'b'.repeat(64),
          },
        ],
      });
    });
    const runtime = createElectronWorkspaceRuntime(deps);
    const workspace = (await runtime.listWorkspaces()).workspaces[0];
    const snapshot = await runtime.loadWorkspace(workspace);

    expect(deps.indexHead).toHaveBeenCalledWith('/workspace', [
      'sequences/first.gbk',
      'sequences/second.gbk',
    ]);
    expect(snapshot.files).toEqual([
      expect.objectContaining({
        path: 'sequences/first.gbk',
        resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      }),
      expect.objectContaining({
        path: 'sequences/second.gbk',
        resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
      }),
    ]);
  });

  it('refuses a workspace whose native catalog and hosted bindings disagree', async () => {
    const deps = dependencies();
    vi.mocked(deps.fileExists).mockResolvedValue(true);
    vi.mocked(deps.readTextFile).mockImplementation(async (path) => {
      if (path.endsWith(`/${NATIVE_WORKSPACE_MANIFEST_PATH}`)) return nativeCatalogJson();
      if (path.endsWith(`/${HOSTED_RESOURCE_BINDINGS_PATH}`)) {
        return serializeHostedResourceBindings({
          schema: 1,
          remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
          remoteVersionId: '54a53fed-2b63-44c8-a26e-b0fb7e1788d2',
          resources: [
            {
              resourceId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
              path: 'sequences/first.gbk',
              contentSha256: 'a'.repeat(64),
            },
          ],
        });
      }
      throw new Error(`unexpected text read: ${path}`);
    });
    const runtime = createElectronWorkspaceRuntime(deps);
    const workspace = (await runtime.listWorkspaces()).workspaces[0];

    await expect(runtime.loadWorkspace(workspace)).rejects.toThrow(
      /Workspace resource identity conflicts at sequences\/first.gbk/u
    );
  });
});

function nativeCatalogJson(): string {
  return JSON.stringify({
    schema: 'dnaforge.native-workspace-manifest.v2',
    entities: [
      {
        id: 'resource-first',
        type: 'sequence',
        name: 'First',
        placement: {
          kind: 'file',
          relativePath: 'sequences/first.gbk',
          fileKind: 'sequence',
        },
      },
      {
        id: 'resource-second',
        type: 'sequence',
        name: 'Second',
        placement: {
          kind: 'file',
          relativePath: 'sequences/second.gbk',
          fileKind: 'sequence',
        },
      },
    ],
    links: [],
  });
}
