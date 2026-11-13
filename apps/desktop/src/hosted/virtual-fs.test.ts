// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  mergeWorkspaceSessionFiles,
  WorkspaceSessionController,
  type WorkspaceSessionAdapter,
  type WorkspaceSessionSnapshot,
} from '@waypoint/domain-services';
import { publishNotebookPackageV2 } from '../db/notebook-package-migration';
import {
  appendProjectMemoryEvent,
  createArtifactCreatedProjectMemoryEvent,
  readProjectMemory,
} from '../db/project-memory';
import { loadSequencePackageDocument } from '../db/sequence-package-io';
import { readSequencePackageHistoryIndex } from '../db/sequence-package-history-io';
import { platform } from '../platform';
import { stageAlignmentQueryPaths } from '../features/alignment-manager/utils/stage-alignment-query';
import { writeAlignmentHistory } from '../features/alignment-manager/utils/alignment-history-persist';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { createHostedWorkspaceRuntime, type HostedWorkspaceRuntimeDependencies } from './runtime';
import { hostedAbsolutePath } from './paths';
import { createHostedVirtualFs, HostedCapabilityError } from './virtual-fs';
import { FileDocumentDraft } from '../features/workspace/public/file-document-draft';
import { deleteWorkspaceFile } from '../features/workspace/public/file-lifecycle-commands';
import { hostedBrowserBridge } from '../platform/hosted';
import * as environment from '../utils/environment';
import * as documentGuards from '../features/workspace/workspace-document-guards';
import { captureSessionIntent } from '../features/workspace-session/session-intent';
import { createHostedMemoryDb } from './memory-db';
import { createMemoryNotebookPageCommands } from '../platform/memory-notebook-pages';
import { notebookPackagePaths } from '../db/notebook-package';
import { readNotebookProjectionSource } from '../db/notebook-projection-source';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { createDurableHostedRuntime } from './sync-runtime';
import { HostedSyncStore } from './sync-store';
import { HostedWorkspaceApiError, sha256Hex } from './api';
import { createHostedAcceptedInputResolver } from './managed-operation-input';
import { createHostedFileRelocator } from './file-relocation';
import { createHostedLims } from './lims';
import { renameNotebookArtifactFile } from '../db/workspace-artifacts';
import { rebindCatalogFilePath } from '../db/workspace-catalog';

vi.mock('../platform', () => ({ platform: vi.fn() }));
const intentFixture = vi.hoisted((): { controller?: WorkspaceSessionController } => ({}));
vi.mock('../features/workspace-session/public/electron-session', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../features/workspace-session/public/electron-session')>();
  return {
    ...actual,
    captureWorkspaceSessionIntent: () => {
      if (!intentFixture.controller) throw new Error('No real fixture session');
      return captureSessionIntent(intentFixture.controller);
    },
  };
});

async function actorBoundFixture() {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  let accountId = 'alice';
  const acceptedBytes = new TextEncoder().encode('Shared accepted notes');
  const digest = await sha256Hex(acceptedBytes);
  let snapshot: WorkspaceSessionSnapshot = {
    workspaceId,
    revisionId: 'revision-1',
    revisionNumber: 1,
    files: [
      {
        path: 'accepted.txt',
        resourceId: '22222222-2222-4222-8222-222222222222',
        contentSha256: digest,
        contentRevision: `sha256:${digest}`,
        sizeBytes: acceptedBytes.length,
        contentType: 'text/plain',
      },
    ],
  };
  const authority: WorkspaceSessionAdapter = {
    descriptor: createHostedWorkspaceRuntime(dependencies()).descriptor,
    listWorkspaces: vi.fn(async () => ({
      principal: { id: accountId, label: accountId },
      workspaces: [
        {
          workspaceId,
          displayName: 'Shared project',
          latestRevisionId: snapshot.revisionId,
          latestRevisionNumber: snapshot.revisionNumber,
        },
      ],
    })),
    createWorkspace: vi.fn(),
    loadWorkspace: vi.fn(async () => structuredClone(snapshot)),
    readFile: vi.fn(async () => acceptedBytes.slice()),
    commit: vi.fn(async (input) => {
      if (input.expectedAccountId !== accountId)
        throw new HostedWorkspaceApiError(409, 'account_changed', 'Wrong mutation owner');
      const writes = await Promise.all(
        input.writes.map(async (write) => {
          const contentSha256 = await sha256Hex(write.bytes);
          return {
            ...write,
            contentSha256,
            contentRevision: `sha256:${contentSha256}`,
            sizeBytes: write.bytes.length,
          };
        })
      );
      snapshot = {
        workspaceId,
        revisionId: `revision-${snapshot.revisionNumber + 1}`,
        revisionNumber: snapshot.revisionNumber + 1,
        files: mergeWorkspaceSessionFiles(snapshot.files, writes, {
          removePaths: input.removePaths,
        }),
      };
      return snapshot;
    }),
  };
  const store = new HostedSyncStore('actor-bound-virtual-fs', new IDBFactory());
  const durable = createDurableHostedRuntime(authority, {
    store,
    lock: async (_name, callback) => callback(),
    retryDelayMs: 60_000,
  });
  const controller = new WorkspaceSessionController(durable.runtime);
  await controller.initialize();
  return {
    workspaceId,
    fs: createHostedVirtualFs(controller),
    controller,
    authority,
    durable,
    store,
    setAccount: async (next: string) => {
      accountId = next;
      await controller.initialize();
    },
    close: async () => {
      durable.dispose();
      await store.close();
    },
  };
}

function dependencies(): HostedWorkspaceRuntimeDependencies {
  return {
    loadIndex: vi.fn(async () => ({
      account: { id: 'account-1', email: 'scientist@example.test', displayName: 'Scientist' },
      workspaces: [
        {
          workspaceId: '11111111-1111-4111-8111-111111111111',
          clientWorkspaceId: '22222222-2222-4222-8222-222222222222',
          displayName: 'Shared project',
          ownerDisplayName: 'Scientist',
          access: { role: 'owner' as const },
          latest: {
            versionId: '33333333-3333-4333-8333-333333333333',
            versionNumber: 1,
            contentSha256: 'a'.repeat(64),
          },
          storageBytesUsed: 10,
          versionCount: 1,
          updatedAt: '2026-09-18T10:00:00.000Z',
        },
      ],
    })),
    createWorkspace: vi.fn(async () => ({
      workspaceId: '11111111-1111-4111-8111-111111111111',
    })),
    loadManifest: vi.fn(async () => ({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      version: {
        id: '33333333-3333-4333-8333-333333333333',
        versionNumber: 1,
        contentSha256: 'a'.repeat(64),
        createdAt: '2026-09-18T10:00:00.000Z',
      },
      manifest: {
        schemaVersion: 1 as const,
        files: [
          {
            resourceId: 'resource-1',
            path: 'sequences/one.gbk',
            contentSha256: '1'.repeat(64),
            sizeBytes: 12,
            contentType: 'application/genbank',
          },
        ],
      },
      resourceIdentities: [{ path: 'sequences/one.gbk', resourceId: 'resource-1' }],
    })),
    loadHistory: vi.fn(async () => ({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      versions: [],
      nextBeforeVersionNumber: null,
    })),
    downloadFile: vi.fn(async () => new TextEncoder().encode('LOCUS one')),
    publishFiles: vi.fn(),
    restoreVersion: vi.fn(),
  };
}

function alignmentFixtureDatabase(
  fixture: Pick<Awaited<ReturnType<typeof actorBoundFixture>>, 'workspaceId' | 'fs'>
) {
  return createHostedMemoryDb(
    {
      tables: [
        [
          'workspaces',
          [
            {
              id: 1,
              name: 'Shared project',
              path: hostedAbsolutePath(fixture.workspaceId),
              repo_uuid: fixture.workspaceId,
              origin_path: null,
              access_mode: 'writable',
              archived_at: null,
              trashed_at: null,
            },
          ],
        ],
        ['workspace_sync_restore_locks', []],
        [
          'workspace_sync_bindings',
          [
            {
              workspace_id: 1,
              workspace_uuid: fixture.workspaceId,
              access_role: 'editor',
            },
          ],
        ],
      ],
      autoincrement: [['workspaces', 1]],
    },
    {
      getCatalogSource: () => {
        const snapshot = fixture.fs.getCatalogSourceSnapshot();
        return snapshot ? { snapshot } : null;
      },
    }
  );
}

describe('hosted virtual filesystem', () => {
  it('records notebook project events through the shared owner and browser storage', async () => {
    const f = await actorBoundFixture();
    const previous = platform();
    vi.mocked(platform).mockReturnValue({
      ...hostedBrowserBridge,
      fs: {
        ...hostedBrowserBridge.fs,
        ...f.fs,
        appendProjectMemoryEvent: hostedBrowserBridge.fs.appendProjectMemoryEvent,
      },
    });
    const workspaceRoot = hostedAbsolutePath(f.workspaceId);
    try {
      const lease = await f.fs.beginWorkspaceMutation();
      const event = createArtifactCreatedProjectMemoryEvent({
        workspaceRoot,
        entityId: 'review-notebook',
        entityKind: 'notebook',
        displayName: 'Lab notes',
        filePath: `${workspaceRoot}/Lab notes.wpnb.json`,
        fileKind: 'notebook',
        sizeBytes: 128,
        artifactSchema: 'waypoint.notebook.v1',
        operationId: 'create-review-notebook',
      });
      await appendProjectMemoryEvent({ workspaceRoot, event });
      await f.fs.endWorkspaceMutation(lease);
      await f.durable.flushAll();
      expect(await readProjectMemory(workspaceRoot)).toMatchObject({
        events: [expect.objectContaining({ eventId: event.eventId })],
        entities: [expect.objectContaining({ id: 'review-notebook', displayName: 'Lab notes' })],
        files: [
          expect.objectContaining({ entityId: 'review-notebook', path: 'Lab notes.wpnb.json' }),
        ],
      });
      expect(f.authority.commit).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(platform).mockReturnValue(previous);
      await f.close();
    }
  });

  it('saves background analysis to its original project while another project loads', async () => {
    const f = await actorBoundFixture();
    const otherId = '44444444-4444-4444-8444-444444444444';
    const index = await f.authority.listWorkspaces();
    vi.mocked(f.authority.listWorkspaces).mockResolvedValue({
      ...index,
      workspaces: [
        ...index.workspaces,
        { ...index.workspaces[0], workspaceId: otherId, displayName: 'Other project' },
      ],
    });
    await f.controller.initialize(f.workspaceId);
    const firstSnapshot = f.controller.getState().snapshot!;
    let releaseOther!: (snapshot: WorkspaceSessionSnapshot) => void;
    const otherLoaded = new Promise<WorkspaceSessionSnapshot>((resolve) => {
      releaseOther = resolve;
    });
    vi.mocked(f.authority.loadWorkspace).mockImplementation(async (workspace) =>
      workspace.workspaceId === otherId ? otherLoaded : structuredClone(firstSnapshot)
    );
    const saving = f.fs.writeTextFile(
      hostedAbsolutePath(f.workspaceId, 'analysis.alignment.json'),
      '{"sessions":[]}'
    );
    await Promise.resolve();
    const selecting = f.controller.selectWorkspace(otherId);
    try {
      await expect(saving).resolves.toBeUndefined();
      await f.durable.flushAll();
      expect(f.authority.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedAccountId: 'alice',
          snapshot: expect.objectContaining({ workspaceId: f.workspaceId }),
          writes: [expect.objectContaining({ path: 'analysis.alignment.json' })],
        })
      );
      expect(f.controller.getState()).toMatchObject({
        activeWorkspaceId: otherId,
        snapshot: null,
        phase: 'loading-workspace',
      });
    } finally {
      releaseOther({ ...firstSnapshot, workspaceId: otherId });
      await selecting;
      await f.close();
    }
  });

  it('projects an owned staged notebook through the same source before its atomic publication', async () => {
    const f = await actorBoundFixture();
    const root = hostedAbsolutePath(f.workspaceId);
    const packageRoot = `${root}/Lab notes`;
    const portableId = crypto.randomUUID();
    const pageId = scopedProjectionId(f.workspaceId, portableId);
    const db = createHostedMemoryDb(undefined, {
      getCatalogSource: () => {
        const snapshot = f.fs.getCatalogSourceSnapshot();
        return snapshot ? { snapshot } : null;
      },
    });
    try {
      const lease = await f.fs.beginWorkspaceMutation();
      await publishNotebookPackageV2(f.fs, {
        packageRoot,
        workspaceRoot: root,
        id: portableId,
        title: 'Lab notes',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Owned draft' }] }],
        },
        sourceShape: 'new-package',
        updatedAt: '2026-10-28T00:00:00.000Z',
      });
      expect(
        f.controller.getState().snapshot!.files.some((file) => file.path.startsWith('Lab notes/'))
      ).toBe(false);
      expect(
        f.fs.getCatalogSourceSnapshot()!.files.some((file) => file.path.startsWith('Lab notes/'))
      ).toBe(true);
      await db.registerCatalogEntity({
        id: pageId,
        type: 'notebook',
        name: 'Lab notes',
        locator: `entity://page/${pageId}`,
        storageType: 'database',
        workspaceRoot: root,
      });
      await db.bindCatalogEntityFile({
        entityId: pageId,
        path: packageRoot,
        fileKind: 'waypoint-notebook',
        workspaceRoot: root,
      });
      const sourcePath = notebookPackagePaths(packageRoot).metaPath;
      const source = await readNotebookProjectionSource(f.fs, sourcePath);
      const projection = await createMemoryNotebookPageCommands(db, f.fs).replaceNotebookProjection(
        {
          pageId,
          sourcePath,
          workspaceRoot: root,
          sourceFingerprint: notebookProjectionFingerprint(
            source.document.title,
            source.document.content
          ),
          expectedProjectionFingerprint: null,
        }
      );
      expect(projection.id).toBe(pageId);
      expect(projection.content).toContain('Owned draft');
      expect(source.document.id).toBe(portableId);
      await f.fs.endWorkspaceMutation(lease);
      await f.durable.flush(f.workspaceId);
      expect(f.authority.commit).toHaveBeenCalledOnce();
      expect((await readNotebookProjectionSource(f.fs, sourcePath)).document.id).toBe(portableId);
    } finally {
      await f.close();
    }
  });

  it('renames an owned notebook through storage, catalog and its canonical document', async () => {
    const f = await actorBoundFixture();
    const root = hostedAbsolutePath(f.workspaceId);
    const packageRoot = `${root}/Readable review notes`;
    const renamedRoot = `${root}/Renamed review notes`;
    const portableId = crypto.randomUUID();
    const pageId = scopedProjectionId(f.workspaceId, portableId);
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep these notes' }] }],
    };
    const db = createHostedMemoryDb(undefined, {
      getCatalogSource: () => {
        const snapshot = f.fs.getCatalogSourceSnapshot();
        return snapshot ? { snapshot } : null;
      },
    });
    const notebook = createMemoryNotebookPageCommands(db, f.fs);
    const previousPlatform = vi.mocked(platform).getMockImplementation();
    vi.mocked(platform).mockReturnValue({
      ...hostedBrowserBridge,
      fs: { ...hostedBrowserBridge.fs, ...f.fs },
      db: { ...hostedBrowserBridge.db, ...db, ...notebook },
      lims: createHostedLims(),
      workspace: {
        ...hostedBrowserBridge.workspace,
        relocateEntityFile: createHostedFileRelocator({
          rename: f.fs.rename,
          rebindCatalogFiles: rebindCatalogFilePath,
        }),
      },
    });
    try {
      await publishNotebookPackageV2(f.fs, {
        packageRoot,
        workspaceRoot: root,
        id: portableId,
        title: 'Readable review notes',
        content,
        sourceShape: 'new-package',
        updatedAt: '2026-11-03T00:00:00.000Z',
      });
      await db.registerCatalogEntity({
        id: pageId,
        type: 'notebook',
        name: 'Readable review notes',
        locator: `entity://page/${pageId}`,
        storageType: 'database',
        workspaceRoot: root,
      });
      await db.bindCatalogEntityFile({
        entityId: pageId,
        path: packageRoot,
        fileKind: 'waypoint-notebook',
        workspaceRoot: root,
      });
      await notebook.replaceNotebookProjection({
        pageId,
        sourcePath: notebookPackagePaths(packageRoot).metaPath,
        workspaceRoot: root,
        sourceFingerprint: notebookProjectionFingerprint('Readable review notes', content),
        expectedProjectionFingerprint: null,
      });
      const originalBinding = await db.select<Array<{ id: string }>>(
        'SELECT id FROM catalog_entity_files WHERE entity_id = ?',
        [pageId]
      );
      await expect(
        renameNotebookArtifactFile({
          pageId,
          title: 'Renamed review notes',
          content,
        })
      ).resolves.toMatchObject({ path: renamedRoot });
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.exists(packageRoot)).toBe(false);
      const reopened = await readNotebookProjectionSource(
        f.fs,
        notebookPackagePaths(renamedRoot).metaPath
      );
      expect(reopened.document).toMatchObject({
        id: portableId,
        title: 'Renamed review notes',
        content,
      });
      expect(
        await db.select('SELECT * FROM catalog_entity_files WHERE entity_id = ?', [pageId])
      ).toEqual([
        expect.objectContaining({
          id: originalBinding[0].id,
          path: renamedRoot,
          status: 'current',
        }),
      ]);
      expect(await db.select('SELECT * FROM catalog_entities WHERE id = ?', [pageId])).toEqual([
        expect.objectContaining({ name: 'Renamed review notes' }),
      ]);
      expect((await readProjectMemory(root)).events).toEqual(
        expect.arrayContaining([expect.objectContaining({ eventType: 'artifact_renamed' })])
      );
    } finally {
      if (previousPlatform) vi.mocked(platform).mockImplementation(previousPlatform);
      else vi.mocked(platform).mockReset();
      await f.close();
    }
  });

  it('hashes accepted bytes in the native sha256 content-hash form', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      const expected = `sha256:${await sha256Hex(new TextEncoder().encode('Shared accepted notes'))}`;
      await expect(f.fs.sha256File(path)).resolves.toBe(expected);
      await expect(
        f.fs.sha256File(hostedAbsolutePath(f.workspaceId, 'missing.pdf'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.close();
    }
  });

  it('does not acknowledge a file relocation when its catalog update fails', async () => {
    const rename = vi.fn(async () => undefined);
    const failure = new Error('Catalog owner refused relocation');
    const relocate = createHostedFileRelocator({
      rename,
      rebindCatalogFiles: async () => {
        throw failure;
      },
    });
    await expect(
      relocate({
        oldPath: '/hosted/project/old',
        newPath: '/hosted/project/new',
        workspaceRoot: '/hosted/project',
      })
    ).rejects.toBe(failure);
    expect(rename).toHaveBeenCalledOnce();
  });

  it('publishes metadata and immutable history atomically, preserving identity and exact retries', async () => {
    const f = await actorBoundFixture();
    try {
      const root = hostedAbsolutePath(f.workspaceId, 'sequences/Reference');
      const markerPath = `${root}/.forge/plasmid.json`;
      const product =
        'LOCUS       Reference                  4 bp    DNA     linear\nORIGIN\n        1 acgt\n//\n';
      const document = buildSequencePackageDocument({
        id: crypto.randomUUID(),
        name: 'Reference',
        product: { file: 'Reference.gb' },
      });
      const marker = serializeSequencePackageDocument(document);
      const lease = await f.fs.beginWorkspaceMutation();
      await f.fs.writeTextFile(markerPath, marker);
      await f.fs.writeTextFile(`${root}/Reference.gb`, product);
      await f.fs.endWorkspaceMutation(lease);
      await f.durable.flush(f.workspaceId);
      const request = {
        document: { kind: 'managed-sequence' as const, packageId: document.id, packageRoot: root },
        expectedMarkerSha256: `sha256:${await sha256Hex(new TextEncoder().encode(marker))}`,
        operationId: crypto.randomUUID(),
        proposed: { name: 'Renamed', entity: document.entity },
      };
      const beforeFiles = f.controller.getState().snapshot!.files;
      const result = await f.fs.publishSequenceMetadataRevision(request);
      await f.durable.flush(f.workspaceId);
      const renamed = parseSequencePackageDocument(result.updatedMarkerContent);
      expect(renamed).toMatchObject({
        id: document.id,
        name: 'Renamed',
        product: document.product,
      });
      expect(renamed.versionHistory.revisions.map((r) => r.kind)).toEqual([
        'adopted',
        'metadata-update',
      ]);
      expect(result.productChanged).toBe(false);
      const writes = vi.mocked(f.authority.commit).mock.calls.at(-1)![0].writes;
      expect(writes.map((w) => w.path).sort()).toEqual(
        [
          'sequences/Reference/.forge/plasmid.json',
          ...result.snapshotPaths.map((p) => p.slice(hostedAbsolutePath(f.workspaceId).length + 1)),
        ].sort()
      );
      for (const file of beforeFiles) {
        expect(
          f.controller.getState().snapshot!.files.find((next) => next.path === file.path)
            ?.resourceId
        ).toBe(file.resourceId);
      }
      const reloaded = createHostedVirtualFs(f.controller);
      expect(await reloaded.readTextFile(`${root}/Reference.gb`)).toBe(product);
      const index = await readSequencePackageHistoryIndex({
        packageRoot: root,
        workspaceRoot: root,
        fs: reloaded,
      });
      expect(index.currentProductStatus).toBe('verified');
      const commits = vi.mocked(f.authority.commit).mock.calls.length;
      expect(await reloaded.publishSequenceMetadataRevision(request)).toMatchObject({
        alreadyPublished: true,
        revisionId: result.revisionId,
      });
      await expect(
        reloaded.publishSequenceMetadataRevision({
          ...request,
          proposed: { ...request.proposed, name: 'Different' },
        })
      ).rejects.toThrow(/different edit/);
      await expect(
        reloaded.publishSequenceMetadataRevision({ ...request, operationId: crypto.randomUUID() })
      ).rejects.toThrow(/changed after/);
      expect(vi.mocked(f.authority.commit).mock.calls.length).toBe(commits);

      const currentRequest = {
        ...request,
        operationId: crypto.randomUUID(),
        expectedMarkerSha256: `sha256:${await sha256Hex(new TextEncoder().encode(result.updatedMarkerContent))}`,
        proposed: { ...request.proposed, name: 'Another name' },
      };
      await expect(
        reloaded.publishSequenceMetadataRevision({
          ...currentRequest,
          document: { ...request.document, packageId: crypto.randomUUID() },
        })
      ).rejects.toThrow(/identity changed/);
      const read = f.controller.openFile.bind(f.controller);
      vi.spyOn(f.controller, 'openFile').mockImplementationOnce(async (path) => {
        await f.setAccount('bob');
        return read(path);
      });
      await expect(reloaded.publishSequenceMetadataRevision(currentRequest)).rejects.toThrow(
        /signed-in account changed/
      );
      expect(vi.mocked(f.authority.commit).mock.calls.length).toBe(commits);
      vi.mocked(f.controller.openFile).mockRestore();
      await f.setAccount('alice');
      const snapshotPath = result.snapshotPaths[0];
      await f.fs.writeTextFile(snapshotPath, 'corrupted frozen snapshot');
      await f.durable.flush(f.workspaceId);
      const afterCorruption = vi.mocked(f.authority.commit).mock.calls.length;
      await expect(f.fs.publishSequenceMetadataRevision(currentRequest)).rejects.toThrow(
        /snapshot integrity/
      );
      expect(vi.mocked(f.authority.commit).mock.calls.length).toBe(afterCorruption);
    } finally {
      await f.close();
    }
  });

  it('captures accepted scientific inputs without waiting for an unrelated durable save', async () => {
    const f = await actorBoundFixture();
    const path = hostedAbsolutePath(f.workspaceId, 'reference.fasta');
    let release: (() => void) | undefined;
    try {
      await f.fs.writeTextFile(path, '>Reference\nACGTACGT\n');
      await f.durable.flush(f.workspaceId);
      await f.controller.refreshActiveWorkspace();
      const accepted = (await f.store.load('alice', f.workspaceId))!.accepted;
      const originalCommit = f.authority.commit;
      f.authority.commit = vi.fn(async (input) => {
        await new Promise<void>((resolve) => (release = resolve));
        return originalCommit(input);
      });
      await f.fs.writeTextFile(
        hostedAbsolutePath(f.workspaceId, 'history.json'),
        '{"pending":true}'
      );
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const prepare = createHostedAcceptedInputResolver(f.workspaceId, {
        getState: f.controller.getState,
        flush: f.durable.flush,
        subscribe: f.durable.subscribe,
        load: (accountId, workspaceId) => f.store.load(accountId, workspaceId),
      });
      const captured = await prepare([{ key: 'reference', path }]);
      expect(captured.version_id).toBe(accepted.revisionId);
      expect(captured.files).toEqual([
        expect.objectContaining({
          path: 'reference.fasta',
          content_sha256: await sha256Hex(new TextEncoder().encode('>Reference\nACGTACGT\n')),
        }),
      ]);
      const pending = await f.store.load('alice', f.workspaceId);
      expect(pending!.operations).toHaveLength(1);
      expect(pending!.operations[0].writes[0].path).toBe('history.json');
      expect(pending!.accepted).toEqual(accepted);
    } finally {
      release?.();
      await f.durable.flush(f.workspaceId);
      await f.close();
    }
  });

  it('never exposes or republishes Alice staged bytes under Bob after reinitialization', async () => {
    const f = await actorBoundFixture();
    const path = hostedAbsolutePath(f.workspaceId, 'private-draft.txt');
    try {
      const lease = await f.fs.beginWorkspaceMutation();
      await f.fs.writeTextFile(path, 'Alice unpublished private draft');
      expect(
        f.fs.getCatalogSourceSnapshot()!.files.some((file) => file.path === 'private-draft.txt')
      ).toBe(true);
      await f.setAccount('bob');
      expect(
        f.fs.getCatalogSourceSnapshot()!.files.some((file) => file.path === 'private-draft.txt')
      ).toBe(false);
      await expect(f.fs.readTextFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(f.fs.endWorkspaceMutation(lease)).rejects.toThrow(/account changed/i);
      await f.durable.flush(f.workspaceId);
      expect(f.authority.commit).not.toHaveBeenCalled();
      expect((await f.store.load('bob', f.workspaceId))?.operations).toHaveLength(0);

      await f.setAccount('alice');
      await expect(f.fs.readTextFile(path)).resolves.toBe('Alice unpublished private draft');
      await f.fs.endWorkspaceMutation(lease);
      await f.durable.flush(f.workspaceId);
      expect(f.authority.commit).toHaveBeenCalledOnce();
      expect(f.authority.commit).toHaveBeenCalledWith(
        expect.objectContaining({ expectedAccountId: 'alice' })
      );
    } finally {
      await f.close();
    }
  });

  it('binds staged deletions to Alice without hiding or deleting Bob accepted files', async () => {
    const f = await actorBoundFixture();
    const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
    try {
      const lease = await f.fs.beginWorkspaceMutation();
      await f.fs.removeFile(path);
      await f.setAccount('bob');
      await expect(f.fs.exists(path)).resolves.toBe(true);
      await expect(f.fs.readTextFile(path)).resolves.toBe('Shared accepted notes');
      await expect(f.fs.endWorkspaceMutation(lease)).rejects.toThrow(/account changed/i);
      expect(f.authority.commit).not.toHaveBeenCalled();
      await f.setAccount('alice');
      await f.fs.endWorkspaceMutation(lease);
      await f.durable.flush(f.workspaceId);
      expect(f.authority.commit).toHaveBeenCalledWith(
        expect.objectContaining({ expectedAccountId: 'alice', removePaths: ['accepted.txt'] })
      );
    } finally {
      await f.close();
    }
  });

  it('does not overwrite Bob accepted changes when Alice returns to an older staged batch', async () => {
    const f = await actorBoundFixture();
    const path = hostedAbsolutePath(f.workspaceId, 'private-draft.txt');
    try {
      const aliceLease = await f.fs.beginWorkspaceMutation();
      await f.fs.writeTextFile(path, 'Alice old unpublished draft');
      await f.setAccount('bob');
      const bobLease = await f.fs.beginWorkspaceMutation();
      await f.fs.writeTextFile(path, 'Bob newer accepted version');
      await f.fs.endWorkspaceMutation(bobLease);
      await f.durable.flush(f.workspaceId);
      await f.setAccount('alice');
      await expect(f.fs.endWorkspaceMutation(aliceLease)).rejects.toThrow(/project changed/i);
      await expect(f.fs.readTextFile(path)).resolves.toBe('Alice old unpublished draft');
      expect(f.authority.commit).toHaveBeenCalledOnce();
      expect(f.authority.commit).toHaveBeenCalledWith(
        expect.objectContaining({ expectedAccountId: 'bob' })
      );
    } finally {
      await f.close();
    }
  });

  it.each(['rename', 'move'] as const)(
    'rejects a %s whose accepted-byte read completes after an account switch',
    async (method) => {
      const f = await actorBoundFixture();
      const source = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      const destination = hostedAbsolutePath(f.workspaceId, 'renamed.txt');
      let release!: () => void;
      try {
        const read = f.authority.readFile;
        f.authority.readFile = vi.fn(async (input) => {
          const bytes = await read(input);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return bytes;
        });
        const renaming =
          method === 'rename'
            ? f.fs.rename(source, destination)
            : f.fs.move(source, hostedAbsolutePath(f.workspaceId, 'contents'));
        const outcome = renaming.then(
          () => null,
          (error: unknown) => error
        );
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        await f.setAccount('bob');
        release();
        expect(await outcome).toEqual(
          expect.objectContaining({ message: expect.stringMatching(/account changed/i) })
        );
        expect(f.authority.commit).not.toHaveBeenCalled();
        await expect(f.fs.exists(destination)).resolves.toBe(false);
        await expect(f.fs.exists(source)).resolves.toBe(true);
      } finally {
        release?.();
        await f.close();
      }
    }
  );

  it('attaches a query in one complete revision, retaining bytes, identity and membership after reload', async () => {
    const f = await actorBoundFixture();
    try {
      vi.mocked(platform).mockReturnValue({
        fs: f.fs,
        db: alignmentFixtureDatabase(f),
      } as ReturnType<typeof platform>);
      const root = hostedAbsolutePath(f.workspaceId, 'sequences/Reference');
      const source = hostedAbsolutePath(f.workspaceId, 'files/query.fasta');
      const query = '>Query\nACGTACGT\n';
      const lease = await f.fs.beginWorkspaceMutation();
      await f.fs.writeTextFile(
        `${root}/.forge/plasmid.json`,
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: crypto.randomUUID(),
            name: 'Reference',
            product: { file: 'Reference.gb' },
          })
        )
      );
      await f.fs.writeTextFile(`${root}/Reference.gb`, 'LOCUS Reference');
      await f.fs.writeTextFile(source, query);
      await f.fs.endWorkspaceMutation(lease);
      await f.durable.flush(f.workspaceId);
      await f.controller.initialize();
      const resourceId = f.controller
        .getState()
        .snapshot!.files.find((file) => file.path === 'files/query.fasta')!.resourceId;
      vi.mocked(f.authority.commit).mockClear();
      const [destPath] = await stageAlignmentQueryPaths(`${root}/Reference.gb`, [source]);
      expect(destPath).toBe(`${root}/contents/query.fasta`);
      await f.durable.flush(f.workspaceId);
      expect(f.authority.commit).toHaveBeenCalledTimes(1);
      await f.controller.initialize();
      const reloaded = createHostedVirtualFs(f.controller);
      await expect(reloaded.exists(source)).resolves.toBe(false);
      await expect(reloaded.readTextFile(destPath)).resolves.toBe(query);
      expect(
        f.controller
          .getState()
          .snapshot!.files.find((file) => file.path.endsWith('/contents/query.fasta'))!.resourceId
      ).toBe(resourceId);
      const document = await loadSequencePackageDocument(root, reloaded);
      expect(document.members).toEqual([
        expect.objectContaining({ role: 'sequencing-read', path: 'contents/query.fasta' }),
      ]);
    } finally {
      vi.mocked(platform).mockReset();
      await f.close();
    }
  });

  it('publishes alignment history and its package membership in one complete revision', async () => {
    const f = await actorBoundFixture();
    try {
      vi.mocked(platform).mockReturnValue({
        fs: f.fs,
        db: alignmentFixtureDatabase(f),
      } as ReturnType<typeof platform>);
      const root = hostedAbsolutePath(f.workspaceId, 'sequences/Reference');
      const lease = await f.fs.beginWorkspaceMutation();
      await f.fs.writeTextFile(
        `${root}/.forge/plasmid.json`,
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: crypto.randomUUID(),
            name: 'Reference',
            product: { file: 'Reference.gb' },
          })
        )
      );
      await f.fs.writeTextFile(`${root}/Reference.gb`, 'LOCUS Reference');
      await f.fs.endWorkspaceMutation(lease);
      await f.durable.flush(f.workspaceId);
      vi.mocked(f.authority.commit).mockClear();

      const history = JSON.stringify({ schemaVersion: 1, sessions: [] });
      const path = await writeAlignmentHistory(`${root}/Reference.gb`, history);
      await f.durable.flush(f.workspaceId);
      expect(f.authority.commit).toHaveBeenCalledTimes(1);
      await f.controller.initialize();
      const reloaded = createHostedVirtualFs(f.controller);
      await expect(reloaded.readTextFile(path)).resolves.toBe(history);
      const document = await loadSequencePackageDocument(root, reloaded);
      expect(document.members).toEqual([
        expect.objectContaining({ role: 'alignment', path: path.slice(root.length + 1) }),
      ]);
    } finally {
      vi.mocked(platform).mockReset();
      await f.close();
    }
  });

  it('reads accepted files while its active project snapshot is still hydrating', async () => {
    const f = await actorBoundFixture();
    const accepted = f.controller.getState().snapshot!;
    let release!: (snapshot: WorkspaceSessionSnapshot) => void;
    vi.mocked(f.authority.loadWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const loading = f.controller.initialize(f.workspaceId);
    try {
      await vi.waitFor(() =>
        expect(f.controller.getState()).toMatchObject({
          phase: 'loading-workspace',
          activeWorkspaceId: f.workspaceId,
          snapshot: null,
        })
      );
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await expect(f.fs.exists(path)).resolves.toBe(true);
      await expect(f.fs.readTextFile(path)).resolves.toBe('Shared accepted notes');
      expect(f.controller.getState()).toMatchObject({
        phase: 'loading-workspace',
        snapshot: null,
        activeFilePath: null,
      });
      expect(f.authority.commit).not.toHaveBeenCalled();
    } finally {
      release(accepted);
      await loading;
      await f.close();
    }
  });

  it('keeps canonical alignment history unchanged while the active project reloads', async () => {
    const f = await actorBoundFixture();
    const previousPlatform = vi.mocked(platform).getMockImplementation();
    let loading: Promise<void> | undefined;
    let release: (() => void) | undefined;
    try {
      vi.mocked(platform).mockReturnValue({
        ...hostedBrowserBridge,
        fs: { ...hostedBrowserBridge.fs, ...f.fs },
        db: { ...hostedBrowserBridge.db, ...alignmentFixtureDatabase(f) },
      });
      const root = hostedAbsolutePath(f.workspaceId, 'sequences/Reference');
      const lease = await f.fs.beginWorkspaceMutation();
      await f.fs.writeTextFile(
        `${root}/.forge/plasmid.json`,
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: crypto.randomUUID(),
            name: 'Reference',
            product: { file: 'Reference.gb' },
          })
        )
      );
      await f.fs.writeTextFile(`${root}/Reference.gb`, 'LOCUS Reference');
      await f.fs.endWorkspaceMutation(lease);
      await f.durable.flush(f.workspaceId);
      const original = JSON.stringify({ schemaVersion: 1, sessions: [], savedAt: 'before' });
      const canonicalPath = await writeAlignmentHistory(`${root}/Reference.gb`, original);
      await f.durable.flush(f.workspaceId);
      const accepted = (await f.controller.refreshActiveWorkspace())!;
      vi.mocked(f.authority.commit).mockClear();
      vi.mocked(f.authority.loadWorkspace).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(accepted);
          })
      );
      loading = f.controller.initialize(f.workspaceId);
      await vi.waitFor(() => expect(f.controller.getState().snapshot).toBeNull());
      await expect(
        writeAlignmentHistory(
          `${root}/Reference.gb`,
          JSON.stringify({
            schemaVersion: 1,
            sessions: [],
            savedAt: 'after',
          })
        )
      ).resolves.toBe(canonicalPath);
      expect(f.authority.commit).not.toHaveBeenCalled();
      release!();
      await loading;
      await f.durable.flush(f.workspaceId);
      expect(
        vi
          .mocked(f.authority.commit)
          .mock.calls.map(([input]) => input.writes.map((write) => write.path))
      ).toEqual([]);
      expect(f.controller.getState().snapshot!.revisionId).toBe(accepted.revisionId);
      expect(await f.fs.exists(`${root}/Reference.gb.waypoint.json`)).toBe(false);
      await expect(f.fs.readTextFile(canonicalPath)).resolves.toBe(original);
      expect(f.authority.commit).not.toHaveBeenCalled();
    } finally {
      release?.();
      await loading;
      if (previousPlatform) vi.mocked(platform).mockImplementation(previousPlatform);
      else vi.mocked(platform).mockReset();
      await f.close();
    }
  });

  it('reloads the owned package history through the hosted filesystem', async () => {
    const f = await actorBoundFixture();
    try {
      const root = hostedAbsolutePath(f.workspaceId, 'sequences/Reference');
      const document = buildSequencePackageDocument({
        id: crypto.randomUUID(),
        name: 'Reference',
        product: { file: 'Reference.gb' },
      });
      const lease = await f.fs.beginWorkspaceMutation();
      await f.fs.writeTextFile(
        `${root}/.forge/plasmid.json`,
        serializeSequencePackageDocument(document)
      );
      await f.fs.writeTextFile(`${root}/Reference.gb`, 'LOCUS Reference');
      await f.fs.endWorkspaceMutation(lease);
      await f.durable.flush(f.workspaceId);
      await f.controller.initialize();
      const reloaded = createHostedVirtualFs(f.controller);
      await expect(
        readSequencePackageHistoryIndex({
          packageRoot: root,
          workspaceRoot: root,
          expectedPackageId: document.id,
          fs: reloaded,
        })
      ).resolves.toMatchObject({ document: { id: document.id }, currentProductStatus: 'legacy' });
    } finally {
      await f.close();
    }
  });

  it('confines hosted history paths to canonical files in their owning package', async () => {
    const f = await actorBoundFixture();
    try {
      const root = hostedAbsolutePath(f.workspaceId, 'sequences/Reference');
      const path = `${root}/contents/result.json`;
      await f.fs.writeTextFile(path, '{}');
      await expect(f.fs.validateWorkspacePath({ workspaceRoot: root, path })).resolves.toBe(true);
      await expect(
        f.fs.validateWorkspacePath({ workspaceRoot: root, path: `${root}/contents/new.json` })
      ).resolves.toBe(false);
      await expect(
        f.fs.validateWorkspacePath({
          workspaceRoot: root,
          path: `${root}/contents/new.json`,
          allowMissing: true,
        })
      ).resolves.toBe(true);
      for (const invalid of [
        `${root}/../Other/contents/result.json`,
        `${root}/contents/../../Other/result.json`,
        `${root}/contents//result.json`,
        `${root}/contents/./result.json`,
        `${root}/contents\\result.json`,
        `${root}-other/contents/result.json`,
        hostedAbsolutePath(
          '22222222-2222-4222-8222-222222222222',
          'sequences/Reference/contents/result.json'
        ),
        '/tmp/result.json',
      ]) {
        await expect(
          f.fs.validateWorkspacePath({ workspaceRoot: root, path: invalid, allowMissing: true })
        ).resolves.toBe(false);
      }
      await expect(
        f.fs.validateWorkspacePath({ workspaceRoot: `${root}/..`, path, allowMissing: true })
      ).resolves.toBe(false);
      await expect(
        f.fs.validateWorkspacePath({ workspaceRoot: '/hosted', path, allowMissing: true })
      ).resolves.toBe(false);
    } finally {
      await f.close();
    }
  });

  it('does not clobber an occupied move destination or move across workspace owners', async () => {
    const f = await actorBoundFixture();
    try {
      const source = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      const directory = hostedAbsolutePath(f.workspaceId, 'contents');
      const lease = await f.fs.beginWorkspaceMutation();
      await f.fs.writeTextFile(`${directory}/accepted.txt`, 'Keep the existing destination');
      await expect(f.fs.move(source, directory)).rejects.toThrow(/MOVE_EXISTS/);
      await expect(f.fs.readTextFile(`${directory}/accepted.txt`)).resolves.toBe(
        'Keep the existing destination'
      );
      await expect(
        f.fs.move(source, hostedAbsolutePath('44444444-4444-4444-8444-444444444444', 'contents'))
      ).rejects.toThrow();
      await expect(f.fs.exists(source)).resolves.toBe(true);
      await f.fs.endWorkspaceMutation(lease);
    } finally {
      await f.close();
    }
  });

  it('settles only its own batch when another mutation writes during publication', async () => {
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(dependencies()));
    await controller.initialize();
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const path = hostedAbsolutePath(workspaceId, 'notes.txt');
    let acknowledge!: () => void;
    const commit = vi
      .spyOn(controller, 'commit')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        return controller.getState().snapshot!;
      })
      .mockImplementation(async () => controller.getState().snapshot!);
    await fs.beginWorkspaceMutation();
    await fs.writeTextFile(path, 'first');
    const first = fs.endWorkspaceMutation();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    await fs.beginWorkspaceMutation();
    await fs.writeTextFile(path, 'second');
    acknowledge();
    await first;
    await expect(fs.readTextFile(path)).resolves.toBe('second');
    await fs.endWorkspaceMutation();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(commit.mock.calls[1][0][0].bytes)).toBe('second');
  });

  it('serializes overlapping flushes without publishing one batch twice', async () => {
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(dependencies()));
    await controller.initialize();
    const fs = createHostedVirtualFs(controller);
    const path = hostedAbsolutePath('11111111-1111-4111-8111-111111111111', 'notes.txt');
    let acknowledge!: () => void;
    const commit = vi
      .spyOn(controller, 'commit')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        return controller.getState().snapshot!;
      })
      .mockImplementation(async () => controller.getState().snapshot!);
    await fs.beginWorkspaceMutation();
    await fs.writeTextFile(path, 'first');
    const first = fs.endWorkspaceMutation();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    await fs.beginWorkspaceMutation();
    await fs.writeTextFile(path, 'second');
    const second = fs.endWorkspaceMutation();
    acknowledge();
    await Promise.all([first, second]);
    expect(commit.mock.calls.map(([writes]) => new TextDecoder().decode(writes[0].bytes))).toEqual([
      'first',
      'second',
    ]);
  });

  it.each([0, -1, NaN, Infinity, HARD_CAP_BYTES + 1])(
    'rejects an invalid bounded limit %s before loading a workspace',
    async (maxBytes) => {
      const deps = dependencies();
      const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
      const fs = createHostedVirtualFs(controller);
      await expect(fs.readFileBounded('/hosted/invalid', maxBytes)).rejects.toThrow('maxBytes');
      expect(deps.loadIndex).not.toHaveBeenCalled();
      expect(deps.downloadFile).not.toHaveBeenCalled();
    }
  );

  it('reads exact binary bytes through the bounded viewer port', async () => {
    const deps = dependencies();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff, 1, 2, 3, 4, 5]);
    deps.downloadFile = vi.fn(async () => bytes);
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const path = hostedAbsolutePath('11111111-1111-4111-8111-111111111111', 'sequences/one.gbk');
    await expect(fs.readFileBounded(path, bytes.byteLength)).resolves.toEqual(bytes);
    expect(deps.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('rejects an over-limit manifest before downloading its bytes', async () => {
    const deps = dependencies();
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const path = hostedAbsolutePath('11111111-1111-4111-8111-111111111111', 'sequences/one.gbk');
    await expect(fs.readFileBounded(path, 11)).rejects.toMatchObject({
      name: 'BoundedFileReadLimitError',
      sizeBytes: 12,
      maxBytes: 11,
      path,
    });
    expect(deps.downloadFile).not.toHaveBeenCalled();
  });

  it('checks returned bytes and pending writes against the same bounded limit', async () => {
    const deps = dependencies();
    deps.downloadFile = vi.fn(async () => new Uint8Array(13));
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const path = hostedAbsolutePath('11111111-1111-4111-8111-111111111111', 'sequences/one.gbk');
    await expect(fs.readFileBounded(path, 12)).rejects.toMatchObject({
      name: 'BoundedFileReadLimitError',
      sizeBytes: 13,
    });
    await fs.beginWorkspaceMutation();
    const pending = new Uint8Array([0xff, 0, 1]);
    await fs.writeWorkspaceBinaryFileAtomic({ path, content: pending });
    await expect(fs.readFileBounded(path, 3)).resolves.toEqual(pending);
    await expect(fs.readFileBounded(path, 2)).rejects.toMatchObject({
      name: 'BoundedFileReadLimitError',
      sizeBytes: 3,
    });
    expect(deps.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('lists hosted project files as a workspace tree', async () => {
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(dependencies()));
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const listed = await fs.listChildren({
      workspaceRoot: hostedAbsolutePath(workspaceId),
      parentRelativePath: '',
    });
    expect(listed.entries).toEqual([
      expect.objectContaining({
        name: 'sequences',
        isDirectory: true,
        isFile: false,
      }),
    ]);
    const nested = await fs.listChildren({
      workspaceRoot: hostedAbsolutePath(workspaceId),
      parentRelativePath: 'sequences',
    });
    expect(nested.entries).toEqual([
      expect.objectContaining({
        name: 'one.gbk',
        isDirectory: false,
        isFile: true,
        path: hostedAbsolutePath(workspaceId, 'sequences/one.gbk'),
      }),
    ]);
    await expect(
      fs.readTextFile(hostedAbsolutePath(workspaceId, 'sequences/one.gbk'))
    ).resolves.toBe('LOCUS one');
  });

  it('reports a missing hosted file with the filesystem ENOENT contract', async () => {
    const deps = dependencies();
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const path = hostedAbsolutePath(
      '11111111-1111-4111-8111-111111111111',
      'sequences/missing.gbk'
    );
    await expect(fs.readTextFile(path)).rejects.toMatchObject({ code: 'ENOENT', path });
    await expect(fs.readFileBounded(path, 12)).rejects.toMatchObject({ code: 'ENOENT', path });
    expect(deps.downloadFile).not.toHaveBeenCalled();
    expect(controller.getState().error).toBeNull();
  });

  it('does not disguise a real hosted download failure as a missing file', async () => {
    const deps = dependencies();
    const failure = new Error('Blob integrity verification failed.');
    deps.downloadFile = vi.fn(async () => {
      throw failure;
    });
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const path = hostedAbsolutePath('11111111-1111-4111-8111-111111111111', 'sequences/one.gbk');
    await expect(fs.readTextFile(path)).rejects.toBe(failure);
    expect(controller.getState().error).toBe(failure);
  });

  it('batches writes until the workspace mutation ends', async () => {
    const deps = dependencies();
    const publish = deps.publishFiles as ReturnType<typeof vi.fn>;
    publish.mockImplementation(async ({ files }) => ({
      id: '44444444-4444-4444-8444-444444444444',
      versionNumber: 2,
      contentSha256: 'b'.repeat(64),
      files,
    }));
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    await fs.beginWorkspaceMutation();
    await fs.writeTextFile(hostedAbsolutePath(workspaceId, 'notes/one.md'), 'a');
    await fs.writeTextFile(hostedAbsolutePath(workspaceId, 'notes/two.md'), 'b');
    expect(publish).not.toHaveBeenCalled();
    await fs.endWorkspaceMutation();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].files.map((file: { path: string }) => file.path)).toEqual([
      'notes/one.md',
      'notes/two.md',
    ]);
  });

  it('renames buffered notebook package files before commit', async () => {
    const deps = dependencies();
    const publish = deps.publishFiles as ReturnType<typeof vi.fn>;
    publish.mockImplementation(async ({ files }) => ({
      id: '44444444-4444-4444-8444-444444444444',
      versionNumber: 2,
      contentSha256: 'b'.repeat(64),
      files,
    }));
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const stage = hostedAbsolutePath(workspaceId, 'Notes/.forge/notebook.md.dnaforge-stage');
    const canonical = hostedAbsolutePath(workspaceId, 'Notes/Notes.md');
    await fs.beginWorkspaceMutation();
    await fs.writeTextFile(stage, '# Notes');
    await expect(fs.exists(stage)).resolves.toBe(true);
    await fs.rename(stage, canonical);
    await expect(fs.readTextFile(canonical)).resolves.toBe('# Notes');
    await expect(fs.exists(stage)).resolves.toBe(false);
    expect(publish).not.toHaveBeenCalled();
    await fs.endWorkspaceMutation();
    expect(publish.mock.calls[0][0].files.map((file: { path: string }) => file.path)).toEqual([
      'Notes/Notes.md',
    ]);
  });

  it('omits the old path when renaming a committed snapshot file', async () => {
    const deps = dependencies();
    const publish = deps.publishFiles as ReturnType<typeof vi.fn>;
    publish.mockImplementation(async ({ files, removePaths }) => ({
      id: '44444444-4444-4444-8444-444444444444',
      versionNumber: 2,
      contentSha256: 'b'.repeat(64),
      files,
      removePaths,
    }));
    const originalManifest = await deps.loadManifest(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333'
    );
    deps.loadManifest = vi.fn(async (_workspaceId, versionId) => {
      if (versionId === '44444444-4444-4444-8444-444444444444') {
        return {
          ...originalManifest,
          version: {
            ...originalManifest.version,
            id: '44444444-4444-4444-8444-444444444444',
            versionNumber: 2,
            contentSha256: 'b'.repeat(64),
          },
          manifest: {
            schemaVersion: 1 as const,
            files: [
              {
                resourceId: 'resource-1',
                path: 'sequences/renamed.gbk',
                contentSha256: '1'.repeat(64),
                sizeBytes: 12,
                contentType: 'application/genbank',
              },
            ],
          },
          resourceIdentities: [{ path: 'sequences/renamed.gbk', resourceId: 'resource-1' }],
        };
      }
      return originalManifest;
    });
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const oldPath = hostedAbsolutePath(workspaceId, 'sequences/one.gbk');
    const newPath = hostedAbsolutePath(workspaceId, 'sequences/renamed.gbk');
    await fs.beginWorkspaceMutation();
    await fs.rename(oldPath, newPath);
    await expect(fs.exists(oldPath)).resolves.toBe(false);
    await expect(fs.exists(newPath)).resolves.toBe(true);
    await fs.endWorkspaceMutation();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].files.map((file: { path: string }) => file.path)).toEqual([
      'sequences/renamed.gbk',
    ]);
    expect(publish.mock.calls[0][0].removePaths).toEqual(['sequences/one.gbk']);
    expect(controller.getState().snapshot?.files.map((file) => file.path)).toEqual([
      'sequences/renamed.gbk',
    ]);
    await expect(fs.readTextFile(oldPath)).rejects.toMatchObject({
      code: 'ENOENT',
      path: oldPath,
    });
  });

  it('omits a deleted snapshot file from the next published manifest', async () => {
    const deps = dependencies();
    const publish = deps.publishFiles as ReturnType<typeof vi.fn>;
    publish.mockImplementation(async ({ files, removePaths }) => ({
      id: '44444444-4444-4444-8444-444444444444',
      versionNumber: 2,
      contentSha256: 'b'.repeat(64),
      files,
      removePaths,
    }));
    const originalManifest = await deps.loadManifest(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333'
    );
    deps.loadManifest = vi.fn(async (_workspaceId, versionId) => {
      if (versionId === '44444444-4444-4444-8444-444444444444') {
        return {
          ...originalManifest,
          version: {
            ...originalManifest.version,
            id: '44444444-4444-4444-8444-444444444444',
            versionNumber: 2,
            contentSha256: 'b'.repeat(64),
          },
          manifest: { schemaVersion: 1 as const, files: [] },
          resourceIdentities: [],
        };
      }
      return originalManifest;
    });
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const path = hostedAbsolutePath(workspaceId, 'sequences/one.gbk');
    await fs.removeFile(path);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].files).toEqual([]);
    expect(publish.mock.calls[0][0].removePaths).toEqual(['sequences/one.gbk']);
    expect(controller.getState().snapshot?.files).toEqual([]);
  });

  it('duplicates a snapshot file as a new hosted placement', async () => {
    const deps = dependencies();
    const publish = deps.publishFiles as ReturnType<typeof vi.fn>;
    publish.mockImplementation(async ({ files }) => ({
      id: '44444444-4444-4444-8444-444444444444',
      versionNumber: 2,
      contentSha256: 'b'.repeat(64),
      files,
    }));
    const originalManifest = await deps.loadManifest(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333'
    );
    deps.loadManifest = vi.fn(async (_workspaceId, versionId) => {
      if (versionId === '44444444-4444-4444-8444-444444444444') {
        return {
          ...originalManifest,
          version: {
            ...originalManifest.version,
            id: '44444444-4444-4444-8444-444444444444',
            versionNumber: 2,
            contentSha256: 'b'.repeat(64),
          },
          manifest: {
            schemaVersion: 1 as const,
            files: [
              originalManifest.manifest.files[0],
              {
                resourceId: 'resource-2',
                path: 'sequences/one copy.gbk',
                contentSha256: '1'.repeat(64),
                sizeBytes: 12,
                contentType: 'application/genbank',
              },
            ],
          },
          resourceIdentities: [
            { path: 'sequences/one.gbk', resourceId: 'resource-1' },
            { path: 'sequences/one copy.gbk', resourceId: 'resource-2' },
          ],
        };
      }
      return originalManifest;
    });
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const source = hostedAbsolutePath(workspaceId, 'sequences/one.gbk');
    const dest = hostedAbsolutePath(workspaceId, 'sequences/one copy.gbk');
    await fs.beginWorkspaceMutation();
    const bytes = await fs.readFile(source);
    await fs.writeWorkspaceBinaryFileAtomic({ path: dest, content: bytes });
    await fs.endWorkspaceMutation();
    expect(publish.mock.calls[0][0].files.map((file: { path: string }) => file.path)).toEqual([
      'sequences/one copy.gbk',
    ]);
    expect(
      controller
        .getState()
        .snapshot?.files.map((file) => file.path)
        .sort()
    ).toEqual(['sequences/one copy.gbk', 'sequences/one.gbk']);
  });

  it('publishes a notebook package through hosted filesystem writes', async () => {
    const deps = dependencies();
    const publish = deps.publishFiles as ReturnType<typeof vi.fn>;
    publish.mockImplementation(async ({ files }) => ({
      id: '55555555-5555-4555-8555-555555555555',
      versionNumber: 2,
      contentSha256: 'c'.repeat(64),
      files,
    }));
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const workspaceRoot = hostedAbsolutePath(workspaceId);
    const packageRoot = hostedAbsolutePath(workspaceId, 'Notes');
    await fs.beginWorkspaceMutation();
    const published = await publishNotebookPackageV2(fs, {
      packageRoot,
      workspaceRoot,
      id: 'page-1',
      title: 'Notes',
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'hello hosted notebook' }] },
        ],
      },
      sourceShape: 'new-package',
    });
    expect(published.parsed.content).toEqual(
      expect.objectContaining({
        type: 'doc',
      })
    );
    await expect(fs.readTextFile(`${packageRoot}/Notes.md`)).resolves.toContain(
      'hello hosted notebook'
    );
    await fs.endWorkspaceMutation();
    expect(publish).toHaveBeenCalled();
    expect(
      publish.mock.calls[0][0].files.some((file: { path: string }) =>
        file.path.endsWith('Notes.md')
      )
    ).toBe(true);
  });

  it('saves an unbound sequence document as a hosted revision', async () => {
    const deps = dependencies();
    const publish = deps.publishFiles as ReturnType<typeof vi.fn>;
    publish.mockImplementation(async ({ files }) => ({
      id: '66666666-6666-4666-8666-666666666666',
      versionNumber: 2,
      contentSha256: 'd'.repeat(64),
      files,
    }));
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const path = hostedAbsolutePath(workspaceId, 'sequences/edited.gbk');
    await expect(fs.saveSequenceDocument()).resolves.toEqual({ status: 'unbound' });
    await fs.beginWorkspaceMutation();
    await fs.writeTextFile(path, 'LOCUS edited 12 bp');
    await fs.endWorkspaceMutation();
    expect(publish.mock.calls[0][0].files).toEqual([
      expect.objectContaining({
        path: 'sequences/edited.gbk',
        contentType: 'application/genbank',
      }),
    ]);
  });

  it('emits file-changed when a watched snapshot file is replaced', async () => {
    const { subscribeHostedFileChanged } = await import('./events');
    const deps = dependencies();
    const originalManifest = await deps.loadManifest(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333'
    );
    const publish = deps.publishFiles as ReturnType<typeof vi.fn>;
    publish.mockImplementation(async ({ files }) => ({
      id: '44444444-4444-4444-8444-444444444444',
      versionNumber: 2,
      contentSha256: 'b'.repeat(64),
      files,
    }));
    deps.loadManifest = vi.fn(async (_workspaceId, versionId) => {
      if (versionId === '44444444-4444-4444-8444-444444444444') {
        return {
          ...originalManifest,
          version: {
            ...originalManifest.version,
            id: '44444444-4444-4444-8444-444444444444',
            versionNumber: 2,
            contentSha256: 'b'.repeat(64),
          },
          manifest: {
            ...originalManifest.manifest,
            files: originalManifest.manifest.files.map((file) => ({
              ...file,
              contentSha256: '2'.repeat(64),
              sizeBytes: 20,
            })),
          },
        };
      }
      return originalManifest;
    });
    const changed: string[] = [];
    const unsubscribe = subscribeHostedFileChanged((path) => changed.push(path));
    const controller = new WorkspaceSessionController(createHostedWorkspaceRuntime(deps));
    const fs = createHostedVirtualFs(controller);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const path = hostedAbsolutePath(workspaceId, 'sequences/one.gbk');
    await fs.listChildren({
      workspaceRoot: hostedAbsolutePath(workspaceId),
      parentRelativePath: 'sequences',
    });
    await fs.watchFile(path);
    await fs.beginWorkspaceMutation();
    await fs.writeTextFile(path, 'LOCUS replaced');
    await fs.endWorkspaceMutation();
    unsubscribe();
    expect(changed).toContain(path);
  });

  it('reads another project without switching or blanking the active project', async () => {
    const active = '11111111-1111-4111-8111-111111111111';
    const other = '33333333-3333-4333-8333-333333333333';
    const otherBytes = new TextEncoder().encode('LOCUS other');
    const snapshots: Record<string, WorkspaceSessionSnapshot> = {
      [active]: {
        workspaceId: active,
        revisionId: 'active-1',
        revisionNumber: 1,
        files: [
          {
            path: 'sequences/active.gb',
            resourceId: null,
            contentSha256: null,
            contentRevision: 'sha256:active',
            sizeBytes: 11,
            contentType: 'application/genbank',
          },
        ],
      },
      [other]: {
        workspaceId: other,
        revisionId: 'other-1',
        revisionNumber: 1,
        files: [
          {
            path: 'sequences/other.gb',
            resourceId: null,
            contentSha256: null,
            contentRevision: 'sha256:other',
            sizeBytes: otherBytes.length,
            contentType: 'application/genbank',
          },
        ],
      },
    };
    const adapter: WorkspaceSessionAdapter = {
      descriptor: createHostedWorkspaceRuntime(dependencies()).descriptor,
      listWorkspaces: vi.fn(async () => ({
        principal: { id: 'alice', label: 'alice' },
        workspaces: [active, other].map((workspaceId) => ({
          workspaceId,
          displayName: workspaceId === active ? 'Active' : 'Other',
          latestRevisionId: snapshots[workspaceId].revisionId,
          latestRevisionNumber: 1,
        })),
      })),
      createWorkspace: vi.fn(),
      loadWorkspace: vi.fn(async (workspace) => structuredClone(snapshots[workspace.workspaceId])),
      readFile: vi.fn(async () => otherBytes.slice()),
      commit: vi.fn(),
    };
    const controller = new WorkspaceSessionController(adapter);
    await controller.initialize(active);
    const phases: string[] = [];
    const unsubscribe = controller.subscribe(() => phases.push(controller.getState().phase));
    const fs = createHostedVirtualFs(controller);

    const listed = await fs.listChildren({
      workspaceRoot: hostedAbsolutePath(other),
      parentRelativePath: 'sequences',
    });
    const otherPath = hostedAbsolutePath(other, 'sequences/other.gb');
    expect(listed.entries).toEqual([expect.objectContaining({ path: otherPath, isFile: true })]);
    await expect(fs.exists(otherPath)).resolves.toBe(true);
    await expect(fs.stat(otherPath)).resolves.toMatchObject({ isFile: true });
    await expect(fs.readTextFile(otherPath)).resolves.toBe('LOCUS other');
    await expect(fs.readTextFile(hostedAbsolutePath(other, 'missing.gb'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    unsubscribe();
    expect(phases).toEqual([]);
    expect(controller.getState().activeWorkspaceId).toBe(active);
    expect(controller.getState().snapshot?.workspaceId).toBe(active);
  });

  it('retries an inactive project read when an index refresh overlaps it', async () => {
    const active = '11111111-1111-4111-8111-111111111111';
    const other = '33333333-3333-4333-8333-333333333333';
    const snapshot = (workspaceId: string, path: string): WorkspaceSessionSnapshot => ({
      workspaceId,
      revisionId: `${workspaceId}-1`,
      revisionNumber: 1,
      files: [
        {
          path,
          resourceId: null,
          contentSha256: null,
          contentRevision: `sha256:${path}`,
          sizeBytes: 1,
          contentType: 'application/genbank',
        },
      ],
    });
    let otherLoads = 0;
    const adapter: WorkspaceSessionAdapter = {
      descriptor: createHostedWorkspaceRuntime(dependencies()).descriptor,
      listWorkspaces: vi.fn(async () => ({
        principal: { id: 'alice', label: 'alice' },
        workspaces: [active, other].map((workspaceId) => ({
          workspaceId,
          displayName: workspaceId,
          latestRevisionId: `${workspaceId}-1`,
          latestRevisionNumber: 1,
        })),
      })),
      createWorkspace: vi.fn(),
      loadWorkspace: vi.fn(async (workspace) => {
        if (workspace.workspaceId === active) return snapshot(active, 'a.gb');
        otherLoads += 1;
        if (otherLoads === 1) {
          throw new HostedWorkspaceApiError(
            401,
            'account_changed',
            'The sign-in session changed while this request was running.'
          );
        }
        return snapshot(other, 'sequences/other.gb');
      }),
      readFile: vi.fn(),
      commit: vi.fn(),
    };
    const controller = new WorkspaceSessionController(adapter);
    await controller.initialize(active);
    const fs = createHostedVirtualFs(controller);

    const [first, second] = await Promise.all([
      fs.listChildren({ workspaceRoot: hostedAbsolutePath(other), parentRelativePath: '' }),
      fs.exists(hostedAbsolutePath(other, 'sequences/other.gb')),
    ]);

    expect(first.entries).toEqual([expect.objectContaining({ name: 'sequences' })]);
    expect(second).toBe(true);
    expect(otherLoads).toBe(2);
    expect(controller.getState().activeWorkspaceId).toBe(active);
  });
});

describe('hosted atomic text document contract', () => {
  it('saves a BOM-bearing draft loaded with the actual TextViewer preserving decoder', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.writeTextFile(path, '\uFEFFOriginal BOM notes');
      await f.durable.flush(f.workspaceId);
      const bytes = await f.fs.readFile(path);
      const original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      expect(original.startsWith('\uFEFF')).toBe(true);
      const draft = new FileDocumentDraft(path);
      draft.load(original);
      draft.change(`${original} edited`);
      await expect(draft.save((input) => f.fs.writeTextFileAtomic(input))).resolves.toMatchObject({
        saved: true,
        dirty: false,
      });
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.readFile(path)).toEqual(
        new TextEncoder().encode('\uFEFFOriginal BOM notes edited')
      );
    } finally {
      await f.close();
    }
  });

  it('saves the real file document draft durably and preserves the other file identity', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      const controlPath = hostedAbsolutePath(f.workspaceId, 'control.txt');
      await f.fs.writeTextFile(controlPath, 'Unchanged control bytes');
      await f.durable.flush(f.workspaceId);
      const controlBefore = f.controller
        .getState()
        .snapshot?.files.find((file) => file.path === 'control.txt');
      const draft = new FileDocumentDraft(path);
      draft.load(await f.fs.readTextFile(path));
      draft.change('Edited hosted notes.\n');
      await expect(draft.save((input) => f.fs.writeTextFileAtomic(input))).resolves.toMatchObject({
        saved: true,
        dirty: false,
      });
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.readTextFile(path)).toBe('Edited hosted notes.\n');
      expect(f.authority.commit).toHaveBeenCalledTimes(2);
      expect(
        f.controller.getState().snapshot?.files.find((file) => file.path === 'control.txt')
      ).toEqual(controlBefore);
      expect(await f.fs.readTextFile(controlPath)).toBe('Unchanged control bytes');
      expect(vi.mocked(f.authority.commit).mock.calls[1][0]).toMatchObject({
        expectedAccountId: 'alice',
        snapshot: { revisionId: 'revision-2' },
        writes: [{ path: 'accepted.txt', contentType: 'text/plain' }],
      });
    } finally {
      await f.close();
    }
  });

  it('refuses a stale content hash without staging or publishing changed bytes', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      await expect(
        f.fs.writeTextFileAtomic({
          path,
          content: 'Must not publish',
          expectedContentHash: `sha256:${'0'.repeat(64)}`,
        })
      ).rejects.toThrow('FILE_CHANGED');
      expect(f.authority.commit).not.toHaveBeenCalled();
      expect(await f.fs.readTextFile(path)).toBe('Shared accepted notes');
      expect((await f.store.load('alice', f.workspaceId))?.operations).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('refuses an active batch instead of acknowledging only a staged text edit', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      const token = await f.fs.beginWorkspaceMutation(hostedAbsolutePath(f.workspaceId));
      await expect(f.fs.writeTextFileAtomic({ path, content: 'Not yet saved' })).rejects.toThrow(
        /pending project mutation/
      );
      await f.fs.endWorkspaceMutation(token);
      expect(f.authority.commit).not.toHaveBeenCalled();
      expect(await f.fs.readTextFile(path)).toBe('Shared accepted notes');
    } finally {
      await f.close();
    }
  });

  it('allows only one concurrent write against the same original content identity', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      const expectedContentHash = `sha256:${await sha256Hex(new TextEncoder().encode(await f.fs.readTextFile(path)))}`;
      const results = await Promise.allSettled([
        f.fs.writeTextFileAtomic({ path, content: 'First edit', expectedContentHash }),
        f.fs.writeTextFileAtomic({ path, content: 'Second edit', expectedContentHash }),
      ]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringContaining('FILE_CHANGED') }),
      });
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.readTextFile(path)).toBe('First edit');
      expect(f.authority.commit).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it('rejects an account switch while the current bytes are being read', async () => {
    const f = await actorBoundFixture();
    let release = () => {};
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      let started = () => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = f.controller.openFile.bind(f.controller);
      vi.spyOn(f.controller, 'openFile').mockImplementation(async (relative) => {
        const result = await open(relative);
        started();
        await held;
        return result;
      });
      const pending = f.fs.writeTextFileAtomic({ path, content: 'Alice draft' });
      const refusal = expect(pending).rejects.toThrow(/account|signed-in/);
      await entered;
      await f.setAccount('bob');
      release();
      await refusal;
      expect(f.authority.commit).not.toHaveBeenCalled();
    } finally {
      release();
      await f.close();
    }
  });

  it('retains an offline atomic edit in the existing durable queue without claiming server acceptance', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      vi.mocked(f.authority.commit).mockRejectedValue(new TypeError('offline'));
      await f.fs.writeTextFileAtomic({ path, content: 'Durable offline draft' });
      await f.durable.flush(f.workspaceId);
      const record = await f.store.load('alice', f.workspaceId);
      expect(record?.accepted.revisionId).toBe('revision-1');
      expect(record?.operations).toHaveLength(1);
      expect(new TextDecoder().decode(record?.operations[0].writes[0].bytes)).toBe(
        'Durable offline draft'
      );
      expect(f.controller.getState().snapshot?.localRevisionId).toBeTruthy();
    } finally {
      await f.close();
    }
  });

  it('keeps the actual dirty file draft after a content precondition refusal', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      const draft = new FileDocumentDraft(path);
      draft.load('Old editor baseline');
      draft.change('Retained user input');
      await expect(draft.save((input) => f.fs.writeTextFileAtomic(input))).rejects.toThrow(
        'FILE_CHANGED'
      );
      expect(draft.dirty).toBe(true);
      expect(draft.content).toBe('Retained user input');
      expect(draft.persistedContent).toBe('Old editor baseline');
      expect(f.authority.commit).not.toHaveBeenCalled();
      expect((await f.store.load('alice', f.workspaceId))?.operations).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('compares the exact raw file bytes rather than decoded text', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.writeTextFile(path, '\uFEFFRaw original');
      await f.durable.flush(f.workspaceId);
      const raw = await f.fs.readFile(path);
      const decoded = await f.fs.readTextFile(path);
      const wrong = `sha256:${await sha256Hex(new TextEncoder().encode(decoded))}`;
      const expectedContentHash = `sha256:${await sha256Hex(raw)}`;
      expect(wrong).not.toBe(expectedContentHash);
      await expect(
        f.fs.writeTextFileAtomic({ path, content: 'Wrong comparison', expectedContentHash: wrong })
      ).rejects.toThrow('FILE_CHANGED');
      await f.fs.writeTextFileAtomic({
        path,
        content: '\uFEFFRaw replacement',
        expectedContentHash,
      });
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.readFile(path)).toEqual(new TextEncoder().encode('\uFEFFRaw replacement'));
      expect(f.authority.commit).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });

  it('refuses a changed snapshot when an ordinary write wins during the hash read', async () => {
    const f = await actorBoundFixture();
    let release = () => {};
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      let started = () => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = f.controller.openFile.bind(f.controller);
      vi.spyOn(f.controller, 'openFile').mockImplementationOnce(async (relative) => {
        const result = await open(relative);
        started();
        await held;
        return result;
      });
      const pending = f.fs.writeTextFileAtomic({ path, content: 'Stale atomic edit' });
      const refusal = expect(pending).rejects.toThrow(/changed/);
      await entered;
      await f.fs.writeTextFile(path, 'Ordinary write wins');
      release();
      await refusal;
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.readTextFile(path)).toBe('Ordinary write wins');
      expect(f.authority.commit).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await f.close();
    }
  });

  it('never acknowledges an original-account save to the switched account', async () => {
    const f = await actorBoundFixture();
    let release = () => {};
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      let started = () => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const commit = f.controller.commit.bind(f.controller);
      vi.spyOn(f.controller, 'commit').mockImplementationOnce(async (...args) => {
        const result = await commit(...args);
        started();
        await held;
        return result;
      });
      const pending = f.fs.writeTextFileAtomic({ path, content: 'Alice durable edit' });
      const refusal = expect(pending).rejects.toThrow(/account|signed-in/);
      await entered;
      await f.setAccount('bob');
      release();
      await refusal;
      expect((await f.store.load('bob', f.workspaceId))?.operations ?? []).toEqual([]);
    } finally {
      release();
      await f.close();
    }
  });

  it('leaves a failed earlier pending mutation intact instead of flushing it to save another draft', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      const token = await f.fs.beginWorkspaceMutation(hostedAbsolutePath(f.workspaceId));
      await f.fs.writeTextFile(path, 'Earlier staged draft');
      vi.spyOn(f.controller, 'commit').mockRejectedValueOnce(
        new Error('Earlier durable journal refused')
      );
      await expect(f.fs.endWorkspaceMutation(token)).rejects.toThrow(
        'Earlier durable journal refused'
      );
      await expect(
        f.fs.writeTextFileAtomic({ path, content: 'Must not replace staged draft' })
      ).rejects.toThrow(/pending project mutation/);
      expect(f.authority.commit).not.toHaveBeenCalled();
      await f.fs.endWorkspaceMutation(token);
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.readTextFile(path)).toBe('Earlier staged draft');
      expect(f.authority.commit).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
});

describe('hosted atomic versioned deletion contract', () => {
  it('removes the selected file durably while retaining the other file identity and bytes', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      const controlPath = hostedAbsolutePath(f.workspaceId, 'control.txt');
      await f.fs.writeTextFile(controlPath, 'Unchanged delete control');
      await f.durable.flush(f.workspaceId);
      const control = f.controller
        .getState()
        .snapshot?.files.find((file) => file.path === 'control.txt');
      await f.fs.removeFile(path, { atomic: true });
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.exists(path)).toBe(false);
      expect(await f.fs.readTextFile(controlPath)).toBe('Unchanged delete control');
      expect(
        f.controller.getState().snapshot?.files.find((file) => file.path === 'control.txt')
      ).toEqual(control);
      expect(vi.mocked(f.authority.commit).mock.calls[1][0]).toMatchObject({
        snapshot: { revisionId: 'revision-2' },
        removePaths: ['accepted.txt'],
        expectedAccountId: 'alice',
      });
    } finally {
      await f.close();
    }
  });

  it('refuses an active unrelated batch without acknowledging a staged deletion', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      const token = await f.fs.beginWorkspaceMutation(hostedAbsolutePath(f.workspaceId));
      await expect(f.fs.removeFile(path, { atomic: true })).rejects.toThrow(
        /pending project mutation/
      );
      await f.fs.endWorkspaceMutation(token);
      expect(f.authority.commit).not.toHaveBeenCalled();
      expect(await f.fs.exists(path)).toBe(true);
      expect((await f.store.load('alice', f.workspaceId))?.operations).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('preserves a failed earlier batch and its dirty bytes when deletion is refused', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      const token = await f.fs.beginWorkspaceMutation(hostedAbsolutePath(f.workspaceId));
      await f.fs.writeTextFile(path, 'Retained earlier draft');
      vi.spyOn(f.controller, 'commit').mockRejectedValueOnce(new Error('Durable batch refused'));
      await expect(f.fs.endWorkspaceMutation(token)).rejects.toThrow('Durable batch refused');
      await expect(f.fs.removeFile(path, { atomic: true })).rejects.toThrow(
        /pending project mutation/
      );
      expect(f.authority.commit).not.toHaveBeenCalled();
      await f.fs.endWorkspaceMutation(token);
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.readTextFile(path)).toBe('Retained earlier draft');
    } finally {
      await f.close();
    }
  });

  it('refuses deletion when an ordinary write wins before the queued publication', async () => {
    const f = await actorBoundFixture();
    let release = () => {};
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      await f.fs.readTextFile(path);
      let started = () => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const commit = f.controller.commit.bind(f.controller);
      vi.spyOn(f.controller, 'commit').mockImplementationOnce(async (...args) => {
        started();
        await held;
        return commit(...args);
      });
      const pending = f.fs.removeFile(path, { atomic: true });
      const refusal = expect(pending).rejects.toThrow(/changed/);
      await entered;
      await f.fs.writeTextFile(path, 'New ordinary edit');
      release();
      await refusal;
      await f.durable.flush(f.workspaceId);
      expect(await f.fs.readTextFile(path)).toBe('New ordinary edit');
      expect(f.authority.commit).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await f.close();
    }
  });

  it('rejects noncanonical paths without creating a deletion operation', async () => {
    const f = await actorBoundFixture();
    try {
      const root = hostedAbsolutePath(f.workspaceId);
      await f.fs.readTextFile(`${root}/accepted.txt`);
      await expect(f.fs.removeFile(`${root}/../accepted.txt`, { atomic: true })).rejects.toThrow();
      await expect(f.fs.removeFile(root, { atomic: true })).rejects.toThrow();
      expect(f.authority.commit).not.toHaveBeenCalled();
      expect((await f.store.load('alice', f.workspaceId))?.operations).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

describe('hosted human Delete initiating account', () => {
  it('refuses an A-to-B switch held after real path validation when both accounts can edit the same project', async () => {
    const f = await actorBoundFixture();
    let release = () => {};
    const hosted = vi.spyOn(environment, 'isHostedBrowserRuntime').mockReturnValue(true);
    const previousPlatform = vi.mocked(platform).getMockImplementation();
    try {
      const root = hostedAbsolutePath(f.workspaceId);
      const path = `${root}/accepted.txt`;
      await f.fs.readTextFile(path);
      let entered = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validate = f.fs.validateWorkspacePath.bind(f.fs);
      vi.spyOn(f.fs, 'validateWorkspacePath').mockImplementationOnce(async (input) => {
        const result = await validate(input);
        expect(result).toBe(true);
        entered();
        await held;
        return result;
      });
      const trashItem = vi.fn((target: string) => f.fs.removeFile(target, { atomic: true }));
      vi.mocked(platform).mockReturnValue({
        ...hostedBrowserBridge,
        fs: { ...hostedBrowserBridge.fs, ...f.fs },
        shell: { ...hostedBrowserBridge.shell, trashItem },
      });
      intentFixture.controller = f.controller;
      const pending = deleteWorkspaceFile(root, path);
      const refused = expect(pending).rejects.toThrow(/account|session/);
      await reached;
      await f.setAccount('bob');
      expect(f.controller.getState().principal?.id).toBe('bob');
      expect(
        f.controller
          .getState()
          .workspaces.some((workspace) => workspace.workspaceId === f.workspaceId)
      ).toBe(true);
      release();
      await refused;
      expect(trashItem).not.toHaveBeenCalled();
      expect(f.authority.commit).not.toHaveBeenCalled();
      expect(await f.fs.readTextFile(path)).toBe('Shared accepted notes');
      expect((await f.store.load('alice', f.workspaceId))?.operations ?? []).toEqual([]);
      expect((await f.store.load('bob', f.workspaceId))?.operations ?? []).toEqual([]);
    } finally {
      release();
      hosted.mockRestore();
      if (previousPlatform) vi.mocked(platform).mockImplementation(previousPlatform);
      else vi.mocked(platform).mockReset();
      intentFixture.controller = undefined;
      await f.close();
    }
  });
  it('refuses an A-to-B switch held after the real document clean guard when both accounts can edit the same project', async () => {
    const f = await actorBoundFixture();
    let release = () => {};
    const hosted = vi.spyOn(environment, 'isHostedBrowserRuntime').mockReturnValue(true);
    const previousPlatform = vi.mocked(platform).getMockImplementation();
    try {
      const root = hostedAbsolutePath(f.workspaceId);
      const path = `${root}/accepted.txt`;
      await f.fs.readTextFile(path);
      let entered = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const clean = documentGuards.assertWorkspaceDocumentsClean;
      vi.spyOn(documentGuards, 'assertWorkspaceDocumentsClean').mockImplementationOnce(
        async (target) => {
          await clean(target);
          entered();
          await held;
        }
      );
      const trashItem = vi.fn((target: string) => f.fs.removeFile(target, { atomic: true }));
      vi.mocked(platform).mockReturnValue({
        ...hostedBrowserBridge,
        fs: { ...hostedBrowserBridge.fs, ...f.fs },
        shell: { ...hostedBrowserBridge.shell, trashItem },
      });
      intentFixture.controller = f.controller;
      const pending = deleteWorkspaceFile(root, path);
      const refused = expect(pending).rejects.toThrow(/account|session/);
      await reached;
      await f.setAccount('bob');
      expect(f.controller.getState().principal?.id).toBe('bob');
      expect(
        f.controller
          .getState()
          .workspaces.some((workspace) => workspace.workspaceId === f.workspaceId)
      ).toBe(true);
      release();
      await refused;
      expect(trashItem).not.toHaveBeenCalled();
      expect(f.authority.commit).not.toHaveBeenCalled();
      expect(await f.fs.readTextFile(path)).toBe('Shared accepted notes');
      expect((await f.store.load('alice', f.workspaceId))?.operations ?? []).toEqual([]);
      expect((await f.store.load('bob', f.workspaceId))?.operations ?? []).toEqual([]);
    } finally {
      release();
      hosted.mockRestore();
      if (previousPlatform) vi.mocked(platform).mockImplementation(previousPlatform);
      else vi.mocked(platform).mockReset();
      intentFixture.controller = undefined;
      vi.mocked(documentGuards.assertWorkspaceDocumentsClean).mockRestore();
      await f.close();
    }
  });

  it('refuses an account switch after durable deletion instead of acknowledging it to the new account', async () => {
    const f = await actorBoundFixture();
    let release = () => {};
    const hosted = vi.spyOn(environment, 'isHostedBrowserRuntime').mockReturnValue(true);
    const previousPlatform = vi.mocked(platform).getMockImplementation();
    try {
      const root = hostedAbsolutePath(f.workspaceId);
      const path = `${root}/accepted.txt`;
      await f.fs.readTextFile(path);
      let entered = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const trashItem = vi.fn(async (target: string) => {
        await f.fs.removeFile(target, { atomic: true });
        await f.durable.flush(f.workspaceId);
        entered();
        await held;
      });
      vi.mocked(platform).mockReturnValue({
        ...hostedBrowserBridge,
        fs: { ...hostedBrowserBridge.fs, ...f.fs },
        shell: { ...hostedBrowserBridge.shell, trashItem },
      });
      intentFixture.controller = f.controller;
      const pending = deleteWorkspaceFile(root, path);
      const refused = expect(pending).rejects.toThrow(/account|session/);
      await reached;
      await f.setAccount('bob');
      release();
      await refused;
      expect(trashItem).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.authority.commit).mock.calls[0][0].expectedAccountId).toBe('alice');
      expect((await f.store.load('bob', f.workspaceId))?.operations ?? []).toEqual([]);
      expect(await f.fs.exists(path)).toBe(false);
    } finally {
      release();
      hosted.mockRestore();
      if (previousPlatform) vi.mocked(platform).mockImplementation(previousPlatform);
      else vi.mocked(platform).mockReset();
      intentFixture.controller = undefined;
      await f.close();
    }
  });

  it('uses the actual hosted command and preserves the explicit lack of native Trash recovery', async () => {
    const f = await actorBoundFixture();
    const hosted = vi.spyOn(environment, 'isHostedBrowserRuntime').mockReturnValue(true);
    const previousPlatform = vi.mocked(platform).getMockImplementation();
    try {
      const root = hostedAbsolutePath(f.workspaceId);
      const path = `${root}/accepted.txt`;
      await f.fs.readTextFile(path);
      const trashItem = vi.fn((target: string) => f.fs.removeFile(target, { atomic: true }));
      vi.mocked(platform).mockReturnValue({
        ...hostedBrowserBridge,
        fs: { ...hostedBrowserBridge.fs, ...f.fs },
        shell: { ...hostedBrowserBridge.shell, trashItem },
      });
      intentFixture.controller = f.controller;
      const result = await deleteWorkspaceFile(root, path);
      await f.durable.flush(f.workspaceId);
      expect(result).toMatchObject({ kind: 'version-delete' });
      expect(result).not.toHaveProperty('entry');
      expect(await f.fs.exists(path)).toBe(false);
      expect(vi.mocked(f.authority.commit).mock.calls[0][0].expectedAccountId).toBe('alice');
      await expect(
        hostedBrowserBridge.shell.fileTrash({ kind: 'list', workspaceRoot: root })
      ).rejects.toBeInstanceOf(HostedCapabilityError);
    } finally {
      hosted.mockRestore();
      if (previousPlatform) vi.mocked(platform).mockImplementation(previousPlatform);
      else vi.mocked(platform).mockReset();
      intentFixture.controller = undefined;
      await f.close();
    }
  });
});

describe('actual file draft intent across asynchronous hashing', () => {
  it('refuses a shared-project account switch during the real hash before invoking the hosted writer', async () => {
    const f = await actorBoundFixture();
    let release = () => {};
    let restoreHash = () => {};
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      const draft = new FileDocumentDraft(path);
      draft.load(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await f.fs.readFile(path))
      );
      draft.change('Alice pending input');
      const intent = captureSessionIntent(f.controller);
      let entered = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const hashSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
        const result = await digest(...args);
        entered();
        await held;
        return result;
      });
      restoreHash = () => hashSpy.mockRestore();
      const pending = draft.save(async (input) => {
        intent();
        await f.fs.writeTextFileAtomic(input);
        intent();
      });
      const refused = expect(pending).rejects.toThrow(/account|session/);
      await reached;
      await f.setAccount('bob');
      expect(
        f.controller
          .getState()
          .workspaces.some((workspace) => workspace.workspaceId === f.workspaceId)
      ).toBe(true);
      release();
      await refused;
      expect(f.authority.commit).not.toHaveBeenCalled();
      expect(draft.dirty).toBe(true);
      expect(draft.content).toBe('Alice pending input');
      expect(await f.fs.readTextFile(path)).toBe('Shared accepted notes');
      expect((await f.store.load('bob', f.workspaceId))?.operations ?? []).toEqual([]);
    } finally {
      release();
      restoreHash();
      await f.close();
    }
  });

  it('does not acknowledge or run recovery effects after an actual Alice write returns to Bob', async () => {
    const f = await actorBoundFixture();
    try {
      const path = hostedAbsolutePath(f.workspaceId, 'accepted.txt');
      const draft = new FileDocumentDraft(path);
      draft.load(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await f.fs.readFile(path))
      );
      draft.change('Alice actually saved');
      const intent = captureSessionIntent(f.controller);
      const afterPublish = vi.fn(async () => {});
      await expect(
        draft.save(
          async (input) => {
            intent();
            await f.fs.writeTextFileAtomic(input);
            await f.setAccount('bob');
            intent();
          },
          undefined,
          afterPublish
        )
      ).rejects.toThrow(/account|session/);
      expect(f.authority.commit).toHaveBeenCalledTimes(1);
      expect(afterPublish).not.toHaveBeenCalled();
      expect(draft.dirty).toBe(true);
      const published = vi.mocked(f.authority.commit).mock.calls[0]![0];
      expect(published.expectedAccountId).toBe('alice');
      expect(published.writes).toHaveLength(1);
      expect(published.writes[0]!.path).toBe('accepted.txt');
      expect(new TextDecoder().decode(published.writes[0]!.bytes)).toBe('Alice actually saved');
      expect((await f.store.load('bob', f.workspaceId))?.operations ?? []).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
