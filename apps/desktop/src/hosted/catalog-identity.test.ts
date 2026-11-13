import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let db: ReturnType<typeof import('./memory-db').createHostedMemoryDb> | null = null;
  let bridge: Partial<import('../platform/types').PlatformBridge> = {};
  return {
    platform: () => {
      if (!db) throw new Error('hosted memory db was not created');
      return { db, ...bridge };
    },
    useBridge: (value: import('../platform/types').PlatformBridge) => {
      bridge = value;
    },
    db: () => {
      if (!db) throw new Error('hosted memory db was not created');
      return db;
    },
    reset: async () => {
      const { createHostedMemoryDb } = await import('./memory-db');
      db = createHostedMemoryDb();
      bridge = {};
    },
  };
});

vi.mock('../platform', () => ({
  platform: mocks.platform,
}));

import {
  getCurrentSequenceFileForDocumentId,
  registerWorkspaceFile,
} from '../db/workspace-catalog';
import { db, workspaces } from '../db';
import {
  listProjectEditFolders,
  mergeProjectEditFolders,
  projectPathIsReadOnly,
} from '../features/workspace-loader/public/project-edit-folders';

describe('hosted catalog sequence identity', () => {
  it('creates a notebook through the shared product command and reopens the same owned page', async () => {
    const { hostedBrowserBridge } = await import('../platform/hosted');
    const { hostedWorkspaceSessionController: controller } = await import('./controller');
    const { createWorkspaceNotebook } =
      await import('../features/page/public/create-notebook-command');
    const { sha256Hex } = await import('./api');
    const workspaceId = '33333333-3333-4333-8333-333333333333';
    const root = `/hosted/${workspaceId}`;
    let snapshot: import('@waypoint/domain-services').WorkspaceSessionSnapshot = {
      workspaceId,
      revisionId: 'initial',
      revisionNumber: 0,
      files: [],
    };
    const bytes = new Map<string, Uint8Array>();
    const originalState = controller.getState();
    const getState = vi.spyOn(controller, 'getState').mockImplementation(() => ({
      ...originalState,
      principal: { id: 'notebook-account', label: 'Notebook account' },
      activeWorkspaceId: workspaceId,
      snapshot,
      workspaces: [
        {
          workspaceId,
          displayName: 'Notebook project',
          latestRevisionId: 'initial',
          latestRevisionNumber: 0,
        },
      ],
    }));
    const commit = vi.spyOn(controller, 'commit').mockImplementation(async (writes) => {
      const files = new Map(snapshot.files.map((file) => [file.path, file]));
      for (const write of writes) {
        const contentSha256 = await sha256Hex(write.bytes);
        bytes.set(write.path, write.bytes.slice());
        files.set(write.path, {
          path: write.path,
          resourceId: write.resourceId ?? null,
          contentSha256,
          contentRevision: `sha256:${contentSha256}`,
          sizeBytes: write.bytes.length,
          contentType: write.contentType,
        });
      }
      snapshot = {
        ...snapshot,
        revisionId: 'saved',
        revisionNumber: snapshot.revisionNumber + 1,
        files: [...files.values()],
      };
      return snapshot;
    });
    const open = vi.spyOn(controller, 'openFile').mockImplementation(async (path) => {
      const file = snapshot.files.find((file) => file.path === path);
      const content = bytes.get(path);
      if (!file || !content) throw new Error(`Missing canonical notebook file: ${path}`);
      return { file, bytes: content.slice() };
    });
    mocks.useBridge(hostedBrowserBridge);
    try {
      const result = await createWorkspaceNotebook({
        title: 'Lab notes',
        workspaceRoot: root,
        context: { workspaceRoot: root, parentPath: root, targetPath: root, targetKind: 'folder' },
        source: 'file-explorer-new-menu',
      });
      const artifact = result.artifact;
      if (!artifact) throw new Error('The shared command did not publish a notebook artifact.');
      expect(artifact.path).toBe(`${root}/Lab notes`);
      const rows = await hostedBrowserBridge.db.select<Array<{ id: string; title: string }>>(
        'SELECT id,title FROM pages WHERE id = ?',
        [result.pageId]
      );
      expect(rows).toEqual([{ id: result.pageId, title: 'Lab notes' }]);
      expect(commit).toHaveBeenCalledOnce();
      const { withWorkspaceArtifactOpen } = await import('../services/workspace-artifact-open');
      await withWorkspaceArtifactOpen({
        path: artifact.path,
        workspaceRoot: root,
        consume: async (resolved) => {
          expect(resolved.entity.id).toBe(result.pageId);
          expect(resolved.artifact).toMatchObject({ kind: 'notebook', title: 'Lab notes' });
        },
      });
    } finally {
      open.mockRestore();
      commit.mockRestore();
      getState.mockRestore();
    }
  });
  beforeEach(async () => {
    await mocks.reset();
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
  });

  afterEach(() => {
    delete document.documentElement.dataset.dnaforgeRuntime;
  });

  it('resolves a manifest-declared loose FASTA file without SQLite JOINs', async () => {
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const path = `/hosted/${workspaceId}/inputs/query.fasta`;
    const entity = await registerWorkspaceFile({
      path,
      name: 'query.fasta',
      entityType: 'file',
      fileKind: 'fasta',
      workspaceRoot: `/hosted/${workspaceId}`,
      sizeBytes: 20,
      modifiedAt: Date.now(),
    });
    await expect(getCurrentSequenceFileForDocumentId(entity.id)).resolves.toMatchObject({
      entity_id: entity.id,
      path,
    });
  });

  it('resolves a registered GenBank file without SQLite JOINs', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const path = `/hosted/${workspaceId}/sequences/annotated-hosted-journey.gbk`;
    const entity = await registerWorkspaceFile({
      path,
      name: 'annotated-hosted-journey',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: `/hosted/${workspaceId}`,
      sizeBytes: 120,
      modifiedAt: Date.now(),
    });
    await expect(getCurrentSequenceFileForDocumentId(entity.id)).resolves.toMatchObject({
      entity_id: entity.id,
      path,
      status: 'current',
    });
  });

  it('preserves project ownership when the ordinary Drizzle workspace insert precedes a sequence open', async () => {
    const root = '/hosted/11111111-1111-4111-8111-111111111111';
    const insertProject = (lastOpenedAt: number) =>
      db
        .insert(workspaces)
        .values({
          name: 'Shared project',
          path: root,
          createdAt: new Date(100),
          lastOpenedAt: new Date(lastOpenedAt),
        })
        .onConflictDoUpdate({
          target: workspaces.path,
          set: { lastOpenedAt: new Date(lastOpenedAt) },
        });
    await insertProject(200);
    await insertProject(300);
    const rows = await mocks
      .db()
      .select<
        Array<{ id: number; path: string; last_opened_at: number }>
      >('SELECT id, path, last_opened_at FROM workspaces');
    expect(rows).toEqual([{ id: expect.any(Number), path: root, last_opened_at: 300 }]);
    expect(rows[0].id).toBeGreaterThan(0);
    const folders = mergeProjectEditFolders(await listProjectEditFolders(), [{ path: root }]);
    expect(folders).toMatchObject([{ path: root, lifecycle: 'active', pinned: false }]);
    expect(projectPathIsReadOnly(root + '/sequences/pUC19.gb', folders)).toBe(false);
    const entity = await registerWorkspaceFile({
      path: root + '/sequences/pUC19.gb',
      name: 'pUC19',
      entityType: 'sequence',
      fileKind: 'genbank',
      workspaceRoot: root,
      sizeBytes: 8550,
    });
    expect(entity.workspace_id).toBe(rows[0].id);
    await expect(getCurrentSequenceFileForDocumentId(entity.id)).resolves.toMatchObject({
      path: root + '/sequences/pUC19.gb',
      workspace_id: rows[0].id,
      status: 'current',
    });
  });

  it('keeps one project authority when two catalog registrations discover the same root concurrently', async () => {
    const root = '/hosted/11111111-1111-4111-8111-111111111111';
    const entities = await Promise.all(
      ['one.gb', 'two.gb'].map((name) =>
        registerWorkspaceFile({
          path: root + '/sequences/' + name,
          name,
          entityType: 'sequence',
          fileKind: 'genbank',
          workspaceRoot: root,
          sizeBytes: 100,
        })
      )
    );
    const rows = await mocks
      .db()
      .select<Array<{ id: number; path: string }>>('SELECT id, path FROM workspaces');
    expect(rows).toEqual([{ id: expect.any(Number), path: root }]);
    expect(entities.map((entity) => entity.workspace_id)).toEqual([rows[0].id, rows[0].id]);
    const folders = mergeProjectEditFolders(await listProjectEditFolders(), [{ path: root }]);
    expect(projectPathIsReadOnly(root + '/sequences/one.gb', folders)).toBe(false);
  });
});
