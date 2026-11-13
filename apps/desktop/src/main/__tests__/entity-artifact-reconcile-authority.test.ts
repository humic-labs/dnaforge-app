/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));

const host = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../ipc/database', () => ({ getDb: () => host.db }));
vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      select: async (sql: string, parameters: unknown[] = []) =>
        host.db!.prepare(sql).all(...parameters),
      execute: async (sql: string, parameters: unknown[] = []) =>
        host.db!.prepare(sql).run(...parameters),
      settleEntityProjectionSource: (
        input: Parameters<typeof settleEntityProjectionSourceInMain>[1]
      ) => settleEntityProjectionSourceInMain(host.db!, input),
    },
    lims: {
      queryEntities: async (input: Parameters<typeof queryLimsEntitiesInDb>[1]) =>
        queryLimsEntitiesInDb(host.db!, input),
      getRegistryPreview: async (input: { entityId: string }) =>
        getLimsRegistryPreviewInDb(host.db!, input),
      updateEntity: (input: Record<string, unknown>, token?: string) =>
        invoke('lims:updateEntity', input, token),
    },
  }),
}));

import { ipcMain } from 'electron';
import {
  entityArtifactSchemaSnapshot,
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  parseEntityArtifact,
  serializeEntityArtifact,
  type EntityArtifactV2,
} from '../../shared/entity-artifact';
import { reconcileEntityFile } from '../../db/entity-substrate/adapter';
import { limsEntityArtifactAdapter } from '../../db/entity-substrate/lims-entity-adapter';
import { workspaceScopeKey } from '../../shared/workspace-scoped-identity';
import { MANAGED_WORKSPACE_MARKER } from '../../shared/workspace-git-types';
import { workspaceMutationCapabilities } from '../ipc/workspace-mutation-capability';
import {
  listLimsEntitySchemasInDb,
  queryLimsEntitiesInDb,
  registerLimsEntityInDb,
  registerLimsIpcHandlers,
} from '../lims';
import { ensureSchema } from '../schema';
import { getLimsRegistryPreviewInDb } from '../lims-registry-projection';
import * as limsGitExport from '../lims-git-export';
import { updateLimsEntityInsideTx } from '../lims-engine-core';
import { verifyLimsAuditHashChainInDb } from '../lims-projection-rebuild';
import * as publication from '../native-catalog-publication';
import { initManagedRepo } from '../workspace-git';
import {
  acquireWorkspaceSyncMutationLease,
  tryAcquireWorkspaceMutationShared,
  workspaceMutationRootIdentity,
  workspaceMutationWaiterCountForTest,
} from '../workspace-sync-mutation-lease';
import { createTestDb } from './test-db';
import { settleEntityProjectionSourceInMain } from '../entity-projection-receipts';

const sender = Object.assign(new EventEmitter(), { id: 8427, isDestroyed: () => false });
let root: string;
let path: string;
let doc: EntityArtifactV2;
const entity = () => queryLimsEntitiesInDb(host.db!, { id: doc.id, includeArchived: true })[0];
const snapshot = () =>
  JSON.stringify({
    entities: host.db!.prepare('SELECT * FROM lims_entity ORDER BY id').all(),
    history: host.db!.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'registry-reconcile-authority-'));
  path = join(root, 'owned.entity.json');
  host.db = createTestDb();
  ensureSchema(host.db, ':memory:');
  host.db
    .prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)')
    .run('Owned project', root);
  const schemaSnapshot = entityArtifactSchemaSnapshot(
    listLimsEntitySchemasInDb(host.db).find((schema) => schema.entityKind === 'strain')!
  );
  doc = {
    schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
    id: 'owned-record',
    kind: 'strain',
    name: 'Original name',
    schemaRevisionId: schemaSnapshot.schemaRevisionId,
    schemaSnapshot,
    archived: false,
    fields: {
      genotypeCanonical: 'recA1',
      artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath: 'owned.entity.json' },
    },
    registrationStatus: 'registered',
    domainStatus: null,
    relationships: [],
    source: { type: 'manual', values: {} },
  };
  await writeFile(path, serializeEntityArtifact(doc));
  registerLimsEntityInDb(host.db, {
    id: doc.id,
    kind: doc.kind,
    name: doc.name,
    fields: doc.fields,
    schemaRevisionId: doc.schemaRevisionId,
    schemaSnapshot,
    workspaceId: 7,
  });
  vi.mocked(ipcMain.handle).mockClear();
  registerLimsIpcHandlers();
});
afterEach(async () => {
  vi.restoreAllMocks();
  workspaceMutationCapabilities.releaseOwner(sender.id);
  host.db?.close();
  await rm(root, { recursive: true, force: true });
});

async function invoke(channel: string, extra: Record<string, unknown>, token?: string) {
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get(channel);
  if (!handler) throw new Error(`Missing actual IPC handler ${channel}`);
  return handler(
    { sender } as unknown as Electron.IpcMainInvokeEvent,
    {
      id: doc.id,
      expectedEventSeq: entity().eventSeq,
      operationId: crypto.randomUUID(),
      ...extra,
    },
    token
  );
}

describe('generic artifact reconciliation proves file state rather than trusting an actor label', () => {
  it.each([
    ['fallback', 'canonical-scope'],
    ['fallback', 'workspace-key'],
    ['managed-repository', 'canonical-scope'],
    ['managed-repository', 'workspace-key'],
  ] as const)(
    'settles both %s publication bases so the next file-only edit reconciles through %s',
    async (ownerKind, contextKind) => {
      let repoUuid: string | null = null;
      if (ownerKind === 'managed-repository') {
        repoUuid = crypto.randomUUID();
        await writeFile(
          join(root, MANAGED_WORKSPACE_MARKER),
          JSON.stringify({ schema: 1, workspaceUuid: repoUuid, originPath: null, importedAt: 1 })
        );
        await initManagedRepo(root);
        host.db!.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=7').run(repoUuid);
      }
      const workspaceScope = workspaceScopeKey(repoUuid, 7)!;
      const contexts = {
        'canonical-scope': { workspaceRoot: root, workspaceId: 7, workspaceScope },
        'workspace-key': { workspaceRoot: root, workspaceId: 7 },
      };
      const initialBytes = await readFile(path, 'utf8');
      for (const context of Object.values(contexts)) {
        expect(
          (await reconcileEntityFile(limsEntityArtifactAdapter, initialBytes, path, 1, context))
            .outcome
        ).toBe('in-sync');
      }
      await invoke('lims:updateEntity', { name: 'Saved Registry edit' });
      const publishedDocument = parseEntityArtifact(await readFile(path, 'utf8'));
      const publishedFingerprint =
        limsEntityArtifactAdapter.projectionFingerprint(publishedDocument);
      const basesAfterPublication = host
        .db!.prepare(
          'SELECT workspace_key, synchronized_fingerprint FROM entity_projection_sources WHERE entity_id=? ORDER BY workspace_key'
        )
        .all(doc.id) as Array<{ workspace_key: string; synchronized_fingerprint: string }>;
      const source = serializeEntityArtifact({
        ...publishedDocument,
        name: 'Next file-only edit',
      });
      await writeFile(path, source);

      const result = await reconcileEntityFile(
        limsEntityArtifactAdapter,
        source,
        path,
        1,
        contexts[contextKind]
      );

      expect(result).toMatchObject({ outcome: 'updated-from-file' });
      expect(entity().name).toBe('Next file-only edit');
      expect(await readFile(path, 'utf8')).toBe(source);
      expect(basesAfterPublication).toEqual([
        {
          workspace_key: `scope:${workspaceScope}`,
          synchronized_fingerprint: publishedFingerprint,
        },
        { workspace_key: 'workspace:7', synchronized_fingerprint: publishedFingerprint },
      ]);
    }
  );

  it.each([
    ['update', false],
    ['archive', false],
    ['restore', false],
    ['update', true],
    ['archive', true],
    ['restore', true],
  ] as const)(
    'rejects a claimed %s reconciliation without corresponding file bytes (token=%s)',
    async (action, borrowed) => {
      if (action === 'restore') await invoke('lims:archiveEntity', {});
      const before = snapshot();
      const bytes = await readFile(path, 'utf8');
      let token: string | undefined;
      if (borrowed) {
        const release = tryAcquireWorkspaceMutationShared(root);
        if (!release) throw new Error('Fixture project lease is unexpectedly busy');
        token = workspaceMutationCapabilities.issue(
          sender.id,
          workspaceMutationRootIdentity(root),
          release
        );
      }
      await expect(
        invoke(
          `lims:${action}Entity`,
          {
            actor: 'workspace-reconcile',
            ...(action === 'update' ? { name: 'Claimed file edit' } : {}),
          },
          token
        )
      ).rejects.toThrow();
      expect(snapshot() === before).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
  );

  it('accepts a file-first edit through the real IPC boundary without republishing the source', async () => {
    const source = serializeEntityArtifact({ ...doc, name: 'Reviewed source edit' });
    await writeFile(path, source);
    await invoke('lims:updateEntity', {
      actor: 'workspace-reconcile',
      name: 'Reviewed source edit',
    });
    expect(entity().name).toBe('Reviewed source edit');
    expect(await readFile(path, 'utf8')).toBe(source);
  });

  it('accepts a file-first archive marker without republishing the source', async () => {
    const source = serializeEntityArtifact({ ...doc, archived: true });
    await writeFile(path, source);
    await invoke('lims:archiveEntity', { actor: 'workspace-reconcile' });
    expect(entity().tombstone).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(source);
  });

  it('finishes export bookkeeping after completed publication while preserving a later source edit', async () => {
    vi.spyOn(limsGitExport, 'materializeLimsGitReadableExportInDb').mockImplementationOnce(() => {
      throw new Error('Interrupted completed-publication export');
    });
    await expect(invoke('lims:archiveEntity', {})).rejects.toThrow(
      'Interrupted completed-publication export'
    );
    expect(
      host
        .db!.prepare(
          "SELECT COUNT(*) FROM lims_audit WHERE event_type='entity_artifact_publication_complete'"
        )
        .pluck()
        .get()
    ).toBe(1);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(1);
    const source = serializeEntityArtifact({ ...doc, archived: true, name: 'Later source edit' });
    await writeFile(path, source);

    await invoke('lims:updateEntity', { actor: 'workspace-reconcile', name: 'Later source edit' });
    expect(entity().name).toBe('Later source edit');
    expect(await readFile(path, 'utf8')).toBe(source);
    expect(
      host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
    ).toBe(0);
  });

  it('replays completed export recovery at the relocated root of the same workspace without rewriting later source bytes', async () => {
    const operationId = crypto.randomUUID();
    const expectedEventSeq = entity().eventSeq;
    const request = { operationId, expectedEventSeq };
    vi.spyOn(limsGitExport, 'materializeLimsGitReadableExportInDb').mockImplementationOnce(() => {
      throw new Error('Interrupted completed-publication export before relocation');
    });
    await expect(invoke('lims:archiveEntity', request)).rejects.toThrow(
      'Interrupted completed-publication export before relocation'
    );
    expect(
      host
        .db!.prepare(
          "SELECT COUNT(*) FROM lims_audit WHERE operation_id=? AND event_type='entity_artifact_publication_complete'"
        )
        .pluck()
        .get(operationId)
    ).toBe(1);
    const originalRoot = root;
    const relocation = await mkdtemp(join(tmpdir(), 'registry-completed-save-relocation-'));
    try {
      const relocatedRoot = join(relocation, 'same-project');
      await rename(root, relocatedRoot);
      root = relocatedRoot;
      path = join(root, 'owned.entity.json');
      host.db!.prepare('UPDATE workspaces SET path=? WHERE id=7').run(root);
      const laterSource = serializeEntityArtifact({
        ...doc,
        archived: true,
        name: 'Later source edit after profile relocation',
      });
      await writeFile(path, laterSource);

      host.db!.transaction(() => {
        updateLimsEntityInsideTx(host.db!, {
          id: doc.id,
          name: 'Later source edit after profile relocation',
          actor: 'workspace-reconcile',
        });
      })();
      for (const context of [
        { workspaceRoot: root, workspaceId: 7, workspaceScope: workspaceScopeKey(null, 7)! },
        { workspaceRoot: root, workspaceId: 7 },
      ]) {
        expect(
          (await reconcileEntityFile(limsEntityArtifactAdapter, laterSource, path, 1, context))
            .outcome
        ).toBe('in-sync');
      }
      const before = snapshot();
      const basesBefore = JSON.stringify(
        host
          .db!.prepare(
            'SELECT * FROM entity_projection_sources WHERE entity_id=? ORDER BY workspace_key'
          )
          .all(doc.id)
      );
      const publisher = vi.spyOn(publication, 'publishNativeCatalogBytes');

      await invoke('lims:archiveEntity', request);

      expect(publisher).not.toHaveBeenCalled();
      expect(await readFile(path, 'utf8')).toBe(laterSource);
      expect(snapshot() === before).toBe(true);
      expect(
        JSON.stringify(
          host
            .db!.prepare(
              'SELECT * FROM entity_projection_sources WHERE entity_id=? ORDER BY workspace_key'
            )
            .all(doc.id)
        )
      ).toBe(basesBefore);
      expect(
        host.db!.prepare('SELECT COUNT(*) FROM native_catalog_publication_outbox').pluck().get()
      ).toBe(0);
      const requiredPayload = host
        .db!.prepare(
          "SELECT payload FROM lims_audit WHERE operation_id=? AND event_type='entity_artifact_publication_required'"
        )
        .pluck()
        .get(operationId) as string;
      expect(JSON.parse(requiredPayload).workspacePath).toBe(originalRoot);
      expect(verifyLimsAuditHashChainInDb(host.db!).ok).toBe(true);
    } finally {
      await rm(relocation, { recursive: true, force: true });
    }
  });

  it('rejects an old operation after ownership changes without publishing into the old leased project', async () => {
    const operationId = crypto.randomUUID();
    const expectedEventSeq = entity().eventSeq;
    const request = { operationId, expectedEventSeq, name: 'Saved in original project' };
    await invoke('lims:updateEntity', request);

    const movedRoot = await mkdtemp(join(tmpdir(), 'registry-replay-current-owner-'));
    let releaseOriginal: (() => void) | undefined;
    let retry: Promise<{ error?: unknown; result?: unknown }> | undefined;
    try {
      await writeFile(join(movedRoot, 'owned.entity.json'), await readFile(path));
      host
        .db!.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(8,?,?,1)')
        .run('Current owning project', movedRoot);
      host.db!.transaction(() => {
        updateLimsEntityInsideTx(host.db!, {
          id: doc.id,
          workspaceId: 8,
          actor: 'workspace-reconcile',
        });
      })();
      expect(entity().workspaceId).toBe(8);

      const pendingId = 'unrelated-original-project-record';
      const pendingPath = join(root, 'pending.entity.json');
      const pendingDoc: EntityArtifactV2 = {
        ...doc,
        id: pendingId,
        name: 'Unrelated original project record',
        fields: {
          ...doc.fields,
          artifact: {
            schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
            relativePath: 'pending.entity.json',
          },
        },
      };
      const pendingBytes = serializeEntityArtifact(pendingDoc);
      await writeFile(pendingPath, pendingBytes);
      const pendingEntity = registerLimsEntityInDb(host.db!, {
        id: pendingId,
        kind: pendingDoc.kind,
        name: pendingDoc.name,
        fields: pendingDoc.fields,
        schemaRevisionId: pendingDoc.schemaRevisionId,
        schemaSnapshot: pendingDoc.schemaSnapshot,
        workspaceId: 7,
      });
      const publisher = vi
        .spyOn(publication, 'publishNativeCatalogBytes')
        .mockRejectedValueOnce(new Error('Interrupted unrelated original-owner save'));
      await expect(
        invoke('lims:archiveEntity', { id: pendingId, expectedEventSeq: pendingEntity.eventSeq })
      ).rejects.toThrow('Interrupted unrelated original-owner save');
      publisher.mockClear();
      const before = snapshot();
      const beforeOutbox = JSON.stringify(
        host
          .db!.prepare('SELECT * FROM native_catalog_publication_outbox ORDER BY operation_id')
          .all()
      );
      expect(await readFile(pendingPath, 'utf8')).toBe(pendingBytes);

      releaseOriginal = await acquireWorkspaceSyncMutationLease(root);
      const releaseCurrent = tryAcquireWorkspaceMutationShared(movedRoot);
      if (!releaseCurrent) throw new Error('Current owning project lease is unexpectedly busy');
      const token = workspaceMutationCapabilities.issue(
        sender.id,
        workspaceMutationRootIdentity(movedRoot),
        releaseCurrent
      );
      let settled = false;
      retry = invoke('lims:updateEntity', request, token).then(
        (result) => {
          settled = true;
          return { result };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        }
      );
      await vi.waitFor(() => {
        expect(settled || workspaceMutationWaiterCountForTest(root) > 0).toBe(true);
      });

      expect(publisher).not.toHaveBeenCalled();
      expect(snapshot() === before).toBe(true);
      expect(
        JSON.stringify(
          host
            .db!.prepare('SELECT * FROM native_catalog_publication_outbox ORDER BY operation_id')
            .all()
        )
      ).toBe(beforeOutbox);
      expect(await readFile(pendingPath, 'utf8')).toBe(pendingBytes);
      releaseOriginal();
      releaseOriginal = undefined;
      expect((await retry).error).toBeInstanceOf(Error);
      expect(String((await retry).error)).toMatch(/owner|owning|project|workspace/i);
    } finally {
      releaseOriginal?.();
      await retry;
      workspaceMutationCapabilities.releaseOwner(sender.id);
      await rm(movedRoot, { recursive: true, force: true });
    }
  });
});
