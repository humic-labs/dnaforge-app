import { seedOriginalProjectFixture } from './__tests__/original-project-fixture';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: () => 'test', getPath: () => '/tmp' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const openSync = vi.fn(actual.openSync),
    fsyncSync = vi.fn(actual.fsyncSync);
  return { ...actual, default: { ...actual, openSync, fsyncSync }, openSync, fsyncSync };
});
vi.mock('./auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://web.test',
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));
import type Database from 'better-sqlite3';
import { openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  materializeNativeWorkspaceInsideTx,
  type NativeWorkspaceMaterializationPlan,
} from './native-workspace-materializer';
import { writeNativeWorkspaceManifest } from './native-workspace-manifest';
import { parseNativeWorkspaceManifest } from '../shared/native-workspace-manifest';
import { readNativeCatalogRecordState } from './native-catalog-record-state';
import * as publication from './native-catalog-publication';
import {
  assertNativeCatalogRecordPublicationsSettled,
  recoverNativeCatalogRecordsWithDatabaseFence,
  recoverNativeCatalogRecordPublications,
  updateNativeCatalogRecord,
  actOnNativeCatalogRecord,
} from './native-catalog-record-mutations';
import { readLimsAuditExportRowsFromWorkspace } from './lims-git-export';
import * as limsExport from './lims-git-export';
import { ipcMain } from 'electron';
import * as databaseModule from './ipc/database';
import { registerLimsIpcHandlers, registerLimsEntityInDb } from './lims';
import * as migrationAdmission from './workspace-migration-admission';
import { replaceNativeCatalogRecordInsideTx, insertAuditEvent } from './lims-engine-core';
import { limsEntityFromRow } from '../shared/lims';
import { getEntityRowById } from './lims-engine-core';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import { reconcileNativeCatalogRecordsFromFile } from './native-catalog-record-reconcile';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertRendererDatabaseStatementAllowed,
} from './workspace-sync-database-fence';

describe('portable catalog record edits', () => {
  let root: string;
  let workspacePath: string;
  let db: Database.Database;
  let entityId: string;
  const runDatabase = <T>(operation: () => T): T => operation();
  const catalog = () => join(workspacePath, '.forge/catalog.json');
  const entity = (id = entityId, includeArchived = false) => {
    const state = readNativeCatalogRecordState(db, id, { includeArchived });
    if (!state || state.eventSeq === null)
      throw new Error('Expected a current versioned fixture record.');
    return { ...state, eventSeq: state.eventSeq };
  };
  const edit = (operationId = 'edit-one', expectedEventSeq = entity().eventSeq) => ({
    db,
    runDatabase,
    operationId,
    expectedEventSeq,
    input: { id: entityId, name: 'Updated reagent', fields: { amount: 0, verified: false } },
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'catalog-record-edit-'));
    workspacePath = join(root, 'workspace');
    await mkdir(workspacePath);
    db = openFileTestDb(join(root, 'database.sqlite'));
    ensureSchema(db, join(root, 'database.sqlite'));
    seedOriginalProjectFixture(db);
    const schema = {
      schemaId: 'reagent-schema',
      schemaRevisionId: 'reagent-v1',
      name: 'reagent',
      displayName: 'Reagent',
      baseKind: 'record',
      version: 1,
      fields: [
        { key: 'amount', label: 'Amount', type: 'number', required: true },
        { key: 'verified', label: 'Verified', type: 'boolean' },
        { key: 'calculation', label: 'Calculation', type: 'formula_result' },
      ],
    };
    const plan: NativeWorkspaceMaterializationPlan = {
      schema: 'dnaforge.native-workspace-materialization.v1',
      entities: ['a', 'b'].map((rawId) => ({
        rawId,
        type: 'record',
        name: `Reagent ${rawId}`,
        locator: { kind: 'entity', namespace: 'lims' },
        storageType: 'database',
        placement: {
          kind: 'catalog-record',
          parentRelativePath: '',
          displayName: `Reagent ${rawId}`,
          catalogType: 'record',
          presentationKind: 'record',
        },
      })),
      links: [],
      events: [],
      limsEntities: ['a', 'b'].map((entityRawId) => ({
        entityRawId,
        input: {
          kind: 'reagent',
          name: `Reagent ${entityRawId}`,
          schemaRevisionId: 'reagent-v1',
          schemaSnapshot: schema,
          fields: {
            amount: 12.5,
            verified: true,
            calculation: {
              formula: '=UNKNOWN(amount)',
              sourceValue: 25,
              compatibility: 'unsupported',
              stale: false,
            },
          },
        },
      })),
    };
    const result = db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace: {
          name: 'Reagents',
          path: workspacePath,
          repoUuid: 'reagents-workspace',
          createdAt: 1,
          lastOpenedAt: 1,
        },
        plan,
      })
    )();
    entityId = result.entityIdsByRawId.a;
    await writeNativeWorkspaceManifest({ workspacePath, plan, manifestVersion: 2 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const actual = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(fs.openSync).mockImplementation(actual.openSync);
    vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['reference', 'archived', 'trashed'] as const)(
    'refuses native record authoring for a %s project before changing its database or files',
    async (state) => {
      const request = edit();
      if (state === 'reference') db.prepare("UPDATE workspaces SET access_mode='reference'").run();
      else
        db.prepare(
          `UPDATE workspaces SET ${state === 'archived' ? 'archived_at' : 'trashed_at'}=3`
        ).run();
      const before = await readFile(catalog(), 'utf8');
      const beforeEntity = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entityId);
      await expect(updateNativeCatalogRecord(request)).rejects.toThrow(
        /WORKSPACE_READ_ONLY|WORKSPACE_INACTIVE/
      );
      expect(await readFile(catalog(), 'utf8')).toBe(before);
      expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entityId)).toEqual(
        beforeEntity
      );
    }
  );

  it('publishes a name and typed field edit, preserves siblings, and retries without another audit edit', async () => {
    const before = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    const request = edit();
    const updated = await updateNativeCatalogRecord(request);
    expect(updated).toMatchObject({
      name: 'Updated reagent',
      fields: { amount: 0, verified: false },
    });
    const after = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    expect(after.entities[0]).toMatchObject({
      name: updated.name,
      placement: { displayName: updated.name },
      lims: { name: updated.name, fields: updated.fields },
    });
    expect(after.entities[1]).toEqual(before.entities[1]);
    expect(entity().catalogName).toBe(updated.name);
    const audit = db.prepare('SELECT count(*) AS n FROM lims_audit').get();
    expect(await updateNativeCatalogRecord(request)).toEqual(updated);
    expect(db.prepare('SELECT count(*) AS n FROM lims_audit').get()).toEqual(audit);
  });

  it('clears and refills a required value across reconstruction without stale status or a blocked editor', async () => {
    const cleared = await updateNativeCatalogRecord({
      ...edit('clear-required'),
      input: { id: entityId, fields: { amount: null } },
    });
    expect(cleared.registrationStatus).toBe('unresolved');
    const bytes = await readFile(catalog());
    reconcileNativeCatalogRecordsFromFile(db, {
      workspaceRoot: workspacePath,
      expectedManifestSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    const filled = await updateNativeCatalogRecord({
      ...edit('fill-required', entity().eventSeq),
      input: { id: entityId, fields: { amount: 9 } },
    });
    expect(filled.registrationStatus).toBe('registered');
    expect(filled.fields.amount).toBe(9);
  });

  it('returns the original record receipt after a later edit without changing later data', async () => {
    const request = edit('receipt-a');
    const original = await updateNativeCatalogRecord(request);
    await updateNativeCatalogRecord({
      ...edit('receipt-b'),
      input: { id: entityId, name: 'Later reagent', fields: { amount: 27 } },
    });
    const later = entity();
    const bytes = await readFile(catalog());
    const audit = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
    expect(await updateNativeCatalogRecord(request)).toEqual(original);
    expect(entity()).toEqual(later);
    expect(await readFile(catalog())).toEqual(bytes);
    expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audit);
  });

  it('accepts reordered keys in a new record retry and still rejects changed values', async () => {
    const request = edit('reordered-record');
    const original = await updateNativeCatalogRecord(request);
    const reordered = {
      ...request,
      input: { fields: { verified: false, amount: 0 }, name: request.input.name, id: entityId },
    };
    expect(await updateNativeCatalogRecord(reordered)).toEqual(original);
    await expect(
      updateNativeCatalogRecord({
        ...reordered,
        input: { ...reordered.input, fields: { verified: false, amount: 99 } },
      })
    ).rejects.toThrow(/different request/);
  });

  const legacyIntent = async (
    request: Pick<
      Parameters<typeof actOnNativeCatalogRecord>[0],
      'input' | 'operationId' | 'expectedEventSeq'
    >,
    changed: boolean,
    extra: Record<string, unknown> = {},
    action = 'update'
  ) => {
    const record = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).entities[0];
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          action,
          input: request.input,
          expectedEventSeq: request.expectedEventSeq,
        })
      )
      .digest('hex');
    db.transaction(() =>
      insertAuditEvent(db, {
        eventType: 'native_catalog_publication_required',
        operationId: request.operationId,
        idempotencyKey: `native-record-edit:${request.operationId}`,
        subjectTable: 'catalog_entities',
        subjectId: entityId,
        workspaceId: limsEntityFromRow(getEntityRowById(db, entityId)).workspaceId,
        payload: {
          schema: 'dnaforge.native-record-edit.v1',
          requestHash,
          stateSha256: 'unused-complete',
          beforeEntity: record,
          afterEntity: record,
          changed,
          ...extra,
        },
      })
    )();
  };

  it.each([false, true])(
    'returns a legacy changed=%s result from bounded history after a later edit',
    async (changed) => {
      const request = edit('legacy-receipt');
      if (!changed)
        request.input = {
          id: entityId,
          name: entity().name,
          fields: { amount: 12.5, verified: true },
        };
      if (changed)
        await updateNativeCatalogRecord({ ...request, operationId: 'original-legacy-edit' });
      const original = limsEntityFromRow(getEntityRowById(db, entityId));
      await legacyIntent(request, changed);
      await updateNativeCatalogRecord({
        ...edit('later-legacy-edit'),
        input: { id: entityId, name: 'Later' },
      });
      const later = entity();
      const bytes = await readFile(catalog());
      const audit = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
      expect(await updateNativeCatalogRecord(request)).toEqual(original);
      expect(entity()).toEqual(later);
      expect(await readFile(catalog())).toEqual(bytes);
      expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audit);
      await expect(
        updateNativeCatalogRecord({
          ...request,
          input: {
            fields: request.input.fields,
            name: request.input.name,
            id: entityId,
          },
        })
      ).rejects.toThrow(/different request/);
    }
  );

  it.each(['unknown-version', 'wrong-identity', 'bad-state-sequence', 'missing-result'] as const)(
    'rejects a %s receipt without returning current data or writing',
    async (fault) => {
      const request = edit(`receipt-${fault}`);
      if (fault === 'bad-state-sequence') {
        db.transaction(() =>
          insertAuditEvent(db, {
            eventType: 'entity_updated',
            subjectTable: 'lims_entity',
            subjectId: entityId,
            workspaceId: entity().workspaceId,
            after: { ...limsEntityFromRow(getEntityRowById(db, entityId)), eventSeq: -1 },
          })
        )();
      }
      await legacyIntent(
        request,
        false,
        fault === 'unknown-version'
          ? { requestHashVersion: 'future' }
          : fault === 'wrong-identity'
            ? { result: { ...limsEntityFromRow(getEntityRowById(db, entityId)), id: 'other' } }
            : fault === 'missing-result'
              ? {
                  requestHashVersion: 'canonical-json-v1',
                  requestHash: createHash('sha256')
                    .update(
                      canonicalNativeMutationRequest({
                        action: 'update',
                        input: request.input,
                        expectedEventSeq: request.expectedEventSeq,
                      })
                    )
                    .digest('hex'),
                }
              : {}
      );
      const bytes = await readFile(catalog());
      const audit = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
      await expect(updateNativeCatalogRecord(request)).rejects.toThrow(/receipt|version/);
      expect(await readFile(catalog())).toEqual(bytes);
      expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audit);
    }
  );

  it('returns an archived legacy receipt after restoration without archiving the live record again', async () => {
    const request = {
      db,
      runDatabase,
      action: 'archive' as const,
      input: { id: entityId },
      operationId: 'legacy-archive',
      expectedEventSeq: entity().eventSeq,
    };
    const original = await actOnNativeCatalogRecord({
      ...request,
      operationId: 'original-archive',
    });
    await legacyIntent(request, true, {}, 'archive');
    await actOnNativeCatalogRecord({
      ...request,
      action: 'restore',
      operationId: 'later-restore',
      expectedEventSeq: original.entity.eventSeq!,
    });
    const later = entity();
    const bytes = await readFile(catalog());
    expect(await actOnNativeCatalogRecord(request)).toEqual(original);
    expect(entity()).toEqual(later);
    expect(await readFile(catalog())).toEqual(bytes);
  });

  it('fails explicitly when a legacy record original state history is missing', async () => {
    const request = edit('lost-legacy-history');
    await legacyIntent(request, false);

    db.prepare("DELETE FROM lims_audit WHERE subject_table='lims_entity' AND subject_id=?").run(
      entityId
    );
    const later = entity();
    await expect(updateNativeCatalogRecord(request)).rejects.toThrow(/no original state snapshot/);
    expect(entity()).toEqual(later);
  });

  it('preserves an explicitly unresolved complete record through unrelated edits', async () => {
    await updateNativeCatalogRecord({
      ...edit('explicit-unresolved'),
      input: { id: entityId, registrationStatus: 'unresolved' },
    });
    const renamed = await updateNativeCatalogRecord({
      ...edit('rename-unresolved'),
      input: { id: entityId, name: 'Reviewed later' },
    });
    expect(renamed.registrationStatus).toBe('unresolved');
    const optional = await updateNativeCatalogRecord({
      ...edit('optional-unresolved'),
      input: { id: entityId, fields: { verified: false } },
    });
    expect(optional.registrationStatus).toBe('unresolved');
  });

  it.each(['tracked', 'drifted'] as const)(
    'preserves explicit %s status while fields are incomplete',
    async (registrationStatus) => {
      const changed = await updateNativeCatalogRecord({
        ...edit('track-incomplete'),
        input: { id: entityId, registrationStatus, fields: { amount: null } },
      });
      expect(changed.registrationStatus).toBe(registrationStatus);
      const renamed = await updateNativeCatalogRecord({
        ...edit('rename-tracked'),
        input: { id: entityId, name: 'Still tracked' },
      });
      expect(renamed.registrationStatus).toBe(registrationStatus);
    }
  );

  it('allows editing an imported missing-required value whose saved status was omitted', async () => {
    const manifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    delete manifest.entities[0].lims!.fields.amount;
    delete manifest.entities[0].lims!.registrationStatus;
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(catalog(), bytes);
    reconcileNativeCatalogRecordsFromFile(db, {
      workspaceRoot: workspacePath,
      expectedManifestSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    expect(entity().registrationStatus).toBe('unresolved');
    const updated = await updateNativeCatalogRecord({
      ...edit('fill-imported', entity().eventSeq),
      input: { id: entityId, fields: { amount: 9 } },
    });
    expect(updated.registrationStatus).toBe('registered');
  });

  it('exposes the pinned schema label and fields in the production Registry preview', async () => {
    const { getLimsRegistryPreviewInDb } = await import('./lims-registry-projection');
    const preview = getLimsRegistryPreviewInDb(db, { entityId });
    expect(preview.summary.schemaDisplayName).toBe('Reagent');
    expect(preview.summary.summary).toBe('Reagent record');
    expect(preview.nativeRecord?.schemaSnapshot).toMatchObject({
      displayName: 'Reagent',
      fields: [
        { key: 'amount', label: 'Amount', type: 'number' },
        { key: 'verified', label: 'Verified', type: 'boolean' },
        { key: 'calculation', label: 'Calculation', type: 'formula_result' },
      ],
    });
  });

  it('keeps an unrelated global registry edit available when one workspace needs import recovery', async () => {
    vi.spyOn(databaseModule, 'getDb').mockReturnValue(db);
    vi.spyOn(migrationAdmission, 'assertWorkspaceMigrationActionsSettled').mockImplementation(
      async (path) => {
        if (path === workspacePath) throw new Error('Workspace needs import recovery');
      }
    );
    const global = registerLimsEntityInDb(db, {
      kind: 'strain',
      name: 'Global strain',
      fields: {},
    });
    registerLimsIpcHandlers();
    const update = new Map(vi.mocked(ipcMain.handle).mock.calls).get('lims:updateEntity')!;
    const sender = Object.assign(new EventEmitter(), { id: 912, isDestroyed: () => false });
    await expect(
      Reflect.apply(update, undefined, [
        { sender },
        { id: global.id, name: 'Global strain edited' },
      ])
    ).resolves.toMatchObject({ name: 'Global strain edited' });
    await expect(
      Reflect.apply(update, undefined, [
        { sender },
        {
          id: entityId,
          name: 'Blocked edit',
          operationId: 'blocked',
          expectedEventSeq: entity().eventSeq,
        },
      ])
    ).rejects.toThrow(/recovery/);
  });

  const act = (action: 'archive' | 'restore' | 'revert', operationId = action) =>
    actOnNativeCatalogRecord({
      db,
      runDatabase,
      action,
      operationId,
      expectedEventSeq: entity(entityId, true).eventSeq,
      input: { id: entityId },
    });

  it('publishes archive, restore, and undo-restore without losing fields or identity', async () => {
    const original = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    const archived = await act('archive');
    expect(archived.entity.tombstone).toBe(true);
    expect(readNativeCatalogRecordState(db, entityId)).toBeNull();
    const archivedManifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    expect(archivedManifest.entities[0]).toMatchObject({
      lifecycle: { state: 'archived', archivedAt: archived.entity.archivedAt },
      lims: original.entities[0].lims,
    });
    expect(db.prepare('SELECT status FROM catalog_entities WHERE id = ?').get(entityId)).toEqual({
      status: 'archived',
    });
    expect(
      db
        .prepare('SELECT status FROM catalog_workspace_placements WHERE entity_id = ?')
        .get(entityId)
    ).toEqual({ status: 'hidden' });
    const { getLimsRegistryPreviewInDb } = await import('./lims-registry-projection');
    expect(
      getLimsRegistryPreviewInDb(db, { entityId }).nativeRecord?.schemaSnapshot.displayName
    ).toBe('Reagent');
    db.close();
    db = openFileTestDb(join(root, 'database.sqlite'));
    await recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath });
    const restored = await act('restore');
    expect(restored.entity.id).toBe(entityId);
    expect(restored.entity.tombstone).toBe(false);
    expect(
      parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).entities[0]
    ).toMatchObject({ lifecycle: { state: 'active' } });
    const reverted = await act('revert');
    expect(reverted.reverted).toBe(true);
    expect(reverted.entity.tombstone).toBe(true);
    expect(reverted.entity.fields).toEqual(archived.entity.fields);
    expect(parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).entities[1]).toEqual(
      original.entities[1]
    );
  });

  it('reverts a record edit in both the database and portable manifest, and retries once', async () => {
    await updateNativeCatalogRecord(edit());
    const request = {
      db,
      runDatabase,
      action: 'revert' as const,
      input: { id: entityId },
      operationId: 'revert-edit',
      expectedEventSeq: entity().eventSeq,
    };
    const result = await actOnNativeCatalogRecord(request);
    expect(result.reverted).toBe(true);
    expect(result.entity).toMatchObject({
      name: 'Reagent a',
      fields: { amount: 12.5, verified: true },
    });
    expect(
      parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).entities[0].lims?.fields
    ).toEqual(result.entity.fields);
    const audit = db.prepare('SELECT count(*) AS n FROM lims_audit').get();
    expect(await actOnNativeCatalogRecord(request)).toEqual(result);
    expect(db.prepare('SELECT count(*) AS n FROM lims_audit').get()).toEqual(audit);
  });

  it('restores the relationship and both graphs when reverting to an older schema', async () => {
    const current = entity();
    const other = (
      db.prepare("SELECT id FROM lims_entity WHERE name = 'Reagent b'").get() as { id: string }
    ).id;
    const withRelationship = {
      ...current.schemaSnapshot,
      schemaRevisionId: 'reagent-v2',
      version: 2,
      fields: [
        ...current.schemaSnapshot.fields,
        { key: 'parent', label: 'Parent', type: 'record_relationship' },
      ],
    };
    db.transaction(() => {
      replaceNativeCatalogRecordInsideTx(db, {
        id: entityId,
        kind: 'reagent',
        name: current.name,
        workspaceId: current.workspaceId,
        schemaRevisionId: withRelationship.schemaRevisionId,
        schemaSnapshot: withRelationship,
        fields: {
          ...current.fields,
          parent: {
            sourceTargetId: 'bfi_PARENT01',
            destinationEntityId: other,
            relationType: 'references',
            label: 'Reagent b',
            resolution: 'exact',
          },
        },
      });
      replaceNativeCatalogRecordInsideTx(db, {
        id: entityId,
        kind: 'reagent',
        name: current.name,
        workspaceId: current.workspaceId,
        schemaRevisionId: 'reagent-v3',
        schemaSnapshot: { ...current.schemaSnapshot, schemaRevisionId: 'reagent-v3', version: 3 },
        fields: current.fields,
      });
    })();
    const manifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    manifest.entities[0].lims!.schemaRevisionId = 'reagent-v3';
    manifest.entities[0].lims!.schemaSnapshot = entity().schemaSnapshot;
    await writeFile(catalog(), JSON.stringify(manifest));
    const result = await act('revert');
    expect(result.entity.fields.parent).toMatchObject({ destinationEntityId: other });
    expect(entity().schemaSnapshot.schemaRevisionId).toBe('reagent-v2');
    const restored = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    expect(restored.links).toContainEqual(
      expect.objectContaining({ sourceId: 'a', relation: 'references', targetId: 'b' })
    );
    expect(restored.limsLinks).toContainEqual(
      expect.objectContaining({ fromEntityId: 'a', type: 'references', toEntityId: 'b' })
    );
    expect(
      db
        .prepare(
          'SELECT source_entity_id,target_entity_id FROM catalog_entity_links WHERE relation=?'
        )
        .all('references')
    ).toEqual([{ source_entity_id: entityId, target_entity_id: other }]);
    expect(
      db
        .prepare('SELECT from_entity_id,to_entity_id FROM lims_link WHERE type=? AND tombstone=0')
        .all('references')
    ).toEqual([{ from_entity_id: entityId, to_entity_id: other }]);
  });

  it('rejects stale lifecycle actions and restores into occupied names atomically', async () => {
    const staleVersion = entity().eventSeq;
    await act('archive');
    const otherId = (
      db.prepare("SELECT id FROM lims_entity WHERE name = 'Reagent b'").get() as { id: string }
    ).id;
    await updateNativeCatalogRecord({
      db,
      runDatabase,
      operationId: 'rename-b',
      expectedEventSeq: entity(otherId).eventSeq,
      input: { id: otherId, name: 'Reagent a' },
    });
    const before = await readFile(catalog());
    await expect(act('restore')).rejects.toThrow(/UNIQUE|duplicated|occupied/i);
    await expect(
      actOnNativeCatalogRecord({
        db,
        runDatabase,
        action: 'restore',
        input: { id: entityId },
        operationId: 'stale',
        expectedEventSeq: staleVersion,
      })
    ).rejects.toThrow(/changed/);
    expect(await readFile(catalog())).toEqual(before);
    expect(readNativeCatalogRecordState(db, entityId)).toBeNull();
  });

  it('leaves a primer-owned pending publication for its exact Retry and still blocks workspace upload', async () => {
    const owner = db
      .prepare('SELECT workspace_id FROM catalog_entities WHERE id=?')
      .get(entityId) as { workspace_id: number };
    const operationId = 'pending-primer-save';
    db.transaction(() => {
      insertAuditEvent(db, {
        eventType: 'primer_artifact_publication_required',
        operationId,
        idempotencyKey: `primer-artifact-edit:${operationId}`,
        subjectTable: 'lims_entity',
        subjectId: 'retained-primer',
        workspaceId: owner.workspace_id,
        actor: 'local-user',
        payload: {
          schema: 'dnaforge.primer-artifact-publication.v1',
          retained: 'only the primer publisher may consume this',
        },
      });
      db.prepare(
        'INSERT INTO native_catalog_publication_outbox(operation_id,workspace_id) VALUES(?,?)'
      ).run(operationId, owner.workspace_id);
    })();
    const pending = db.prepare('SELECT * FROM native_catalog_publication_outbox').all();
    const bytes = await readFile(catalog());
    const audit = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
    await expect(
      recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath })
    ).resolves.toBeUndefined();
    expect(db.prepare('SELECT * FROM native_catalog_publication_outbox').all()).toEqual(pending);
    expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audit);
    expect(await readFile(catalog())).toEqual(bytes);
    expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).toThrow(
      /pending/
    );
  });

  it('recovers an archive committed before catalog publication without redoing its audit', async () => {
    const publish = vi
      .spyOn(publication, 'publishNativeCatalogBytes')
      .mockRejectedValueOnce(new Error('Interrupted archive'));
    await expect(act('archive')).rejects.toThrow('Interrupted archive');
    publish.mockRestore();
    db.close();
    db = openFileTestDb(join(root, 'database.sqlite'));
    await recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath });
    expect(
      parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).entities[0]
    ).toMatchObject({ lifecycle: { state: 'archived' } });
    expect(
      db.prepare("SELECT count(*) AS n FROM lims_audit WHERE event_type = 'entity_archived'").get()
    ).toEqual({ n: 1 });
    expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).not.toThrow();
  });

  it.each([
    { label: 'equal fields', fields: { amount: 12.5, verified: true }, stale: false },
    { label: 'name only', fields: undefined, stale: false },
    { label: 'changed input', fields: { amount: 50 }, stale: true },
  ])(
    'marks saved registry formulas potentially outdated only for data changes: $label',
    async ({ fields, stale }) => {
      await updateNativeCatalogRecord({
        ...edit(),
        input: { id: entityId, name: 'Reagent renamed', fields },
      });
      expect(entity().fields.calculation).toMatchObject({ sourceValue: 25, stale });
      expect(
        parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).entities[0].lims?.fields
          .calculation
      ).toMatchObject({ sourceValue: 25, stale });
    }
  );

  it('rejects an outdated editor and a reused operation with a different edit', async () => {
    const request = edit();
    await updateNativeCatalogRecord(request);
    const bytes = await readFile(catalog());
    await expect(updateNativeCatalogRecord({ ...request, operationId: 'other' })).rejects.toThrow(
      /changed|outdated/
    );
    await expect(
      updateNativeCatalogRecord({ ...request, input: { ...request.input, name: 'Different' } })
    ).rejects.toThrow(/reused/);
    expect(await readFile(catalog())).toEqual(bytes);
  });

  it('exports the completion audit before reporting a settled edit', async () => {
    await updateNativeCatalogRecord(edit());
    const exported = readLimsAuditExportRowsFromWorkspace(workspacePath);
    const latest = db
      .prepare('SELECT id,event_seq FROM lims_audit ORDER BY event_seq DESC LIMIT 1')
      .get();
    expect(exported.at(-1)).toMatchObject(latest!);
    expect(exported.at(-1)?.event_type).toBe('native_catalog_publication_complete');
    expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).not.toThrow();
  });

  it('finishes interrupted cleanup after restart without replaying the scientific edit', async () => {
    const prune = vi
      .spyOn(publication, 'pruneCompletedNativeCatalogPublication')
      .mockRejectedValueOnce(new Error('Cleanup interrupted'));
    await expect(updateNativeCatalogRecord(edit())).rejects.toThrow('Cleanup interrupted');
    const bytes = await readFile(catalog());
    const audit = db.prepare('SELECT count(*) AS n FROM lims_audit').get();
    expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).toThrow(
      /pending/
    );
    prune.mockRestore();
    db.close();
    db = openFileTestDb(join(root, 'database.sqlite'));
    const retryPrune = vi.spyOn(publication, 'pruneCompletedNativeCatalogPublication');
    await recoverNativeCatalogRecordPublications({ db, workspacePath, runDatabase });
    expect(retryPrune).toHaveBeenCalledOnce();
    expect(await readFile(catalog())).toEqual(bytes);
    expect(db.prepare('SELECT count(*) AS n FROM lims_audit').get()).toEqual(audit);
    expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).not.toThrow();
  });

  it('retries a failed export after completion without repeating the record edit', async () => {
    const exporter = vi
      .spyOn(limsExport, 'materializeLimsGitReadableExportInDb')
      .mockImplementationOnce(() => {
        throw new Error('Export interrupted');
      });
    await expect(updateNativeCatalogRecord(edit())).rejects.toThrow('Export interrupted');
    const audit = db.prepare('SELECT count(*) AS n FROM lims_audit').get();
    expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).toThrow(
      /pending/
    );
    exporter.mockRestore();
    db.close();
    db = openFileTestDb(join(root, 'database.sqlite'));
    await recoverNativeCatalogRecordPublications({ db, workspacePath, runDatabase });
    expect(db.prepare('SELECT count(*) AS n FROM lims_audit').get()).toEqual(audit);
    expect(readLimsAuditExportRowsFromWorkspace(workspacePath).at(-1)?.event_type).toBe(
      'native_catalog_publication_complete'
    );
    expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).not.toThrow();
  });

  it.each([
    '.jsonl',
    'oligos.csv',
    'manifest.json',
    'repair-only',
    ...(process.platform === 'win32'
      ? []
      : ['/log', '/sheets', '/.waypoint/lims', '/.waypoint', '/workspace']),
  ])(
    'does not acknowledge before the export %s flush, including an unchanged retry',
    async (suffix) => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      const open = actual.openSync,
        sync = actual.fsyncSync;
      const paths = new Map<number, string>();
      const flushed: string[] = [];
      vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        const fd = open(...args);
        paths.set(fd, String(args[0]));
        return fd;
      });
      let fail = true;
      vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
        const path = paths.get(fd) ?? '';
        flushed.push(path);
        if (fail && path.endsWith(suffix === 'repair-only' ? '.jsonl' : suffix))
          throw new Error('Export flush interrupted');
        sync(fd);
      });
      const actualPrune = publication.pruneCompletedNativeCatalogPublication;
      const prune = vi.spyOn(publication, 'pruneCompletedNativeCatalogPublication');
      await expect(updateNativeCatalogRecord(edit())).rejects.toThrow('Export flush interrupted');
      expect(prune).not.toHaveBeenCalled();
      expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).toThrow(
        /pending/
      );
      const audit = db.prepare('SELECT count(*) AS n FROM lims_audit').get();
      if (suffix === 'repair-only') {
        const logDir = join(workspacePath, '.waypoint/lims/log');
        for (const name of actual.readdirSync(logDir).filter((name) => name.endsWith('.jsonl')))
          actual.unlinkSync(join(logDir, name));
      }
      db.close();
      db = openFileTestDb(join(root, 'database.sqlite'));
      fail = false;
      flushed.length = 0;
      const exporter = vi.spyOn(limsExport, 'materializeLimsGitReadableExportInDb');
      prune.mockImplementationOnce(async (request) => {
        expect(flushed.some((path) => path.endsWith('manifest.json'))).toBe(true);
        expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).toThrow(
          /pending/
        );
        await actualPrune(request);
      });
      await recoverNativeCatalogRecordPublications({ db, workspacePath, runDatabase });
      if (suffix === 'repair-only') expect(exporter.mock.results[0]?.value.logFiles).toEqual([]);
      else expect(flushed.some((path) => path.endsWith(suffix))).toBe(true);
      expect(flushed.some((path) => path.endsWith('.jsonl'))).toBe(true);
      expect(flushed.some((path) => path.endsWith('oligos.csv'))).toBe(true);
      expect(flushed.some((path) => path.endsWith('manifest.json'))).toBe(true);
      expect(prune).toHaveBeenCalledOnce();
      expect(db.prepare('SELECT count(*) AS n FROM lims_audit').get()).toEqual(audit);
      expect(readLimsAuditExportRowsFromWorkspace(workspacePath).at(-1)?.event_type).toBe(
        'native_catalog_publication_complete'
      );
      expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).not.toThrow();
    }
  );

  it('retries already-pruned cleanup and preserves a later external catalog edit', async () => {
    const actualPrune = publication.pruneCompletedNativeCatalogPublication;
    vi.spyOn(publication, 'pruneCompletedNativeCatalogPublication').mockImplementationOnce(
      async (request) => {
        await actualPrune(request);
        throw new Error('Stopped before outbox deletion');
      }
    );
    await expect(updateNativeCatalogRecord(edit())).rejects.toThrow(
      'Stopped before outbox deletion'
    );
    const manifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    manifest.entities[1].name = 'External later name';
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(catalog(), bytes);
    const audit = db.prepare('SELECT count(*) AS n FROM lims_audit').get();
    db.close();
    db = openFileTestDb(join(root, 'database.sqlite'));
    await recoverNativeCatalogRecordPublications({ db, workspacePath, runDatabase });
    expect(await readFile(catalog())).toEqual(bytes);
    expect(db.prepare('SELECT count(*) AS n FROM lims_audit').get()).toEqual(audit);
    expect(() => assertNativeCatalogRecordPublicationsSettled(db, workspacePath)).not.toThrow();
  });

  it("does not recover through another owner's database fence", async () => {
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted edit')
    );
    await expect(updateNativeCatalogRecord(edit())).rejects.toThrow('Interrupted edit');
    const bytes = await readFile(catalog());
    const release = await acquireWorkspaceSyncDatabaseFence(db);
    const background = recoverNativeCatalogRecordsWithDatabaseFence(db, workspacePath);
    try {
      await expect(
        recoverNativeCatalogRecordPublications({
          db,
          workspacePath,
          runDatabase: (operation) => {
            assertRendererDatabaseStatementAllowed(db, 123);
            return operation();
          },
        })
      ).rejects.toThrow(/DATABASE|database/);
      expect(await readFile(catalog())).toEqual(bytes);
    } finally {
      release();
    }
    await background;
    expect(entity().name).toBe('Updated reagent');
    expect(await readFile(catalog())).not.toEqual(bytes);
  });

  it('rejects invalid typed values and workspace reassignment without committing', async () => {
    const before = entity();
    const bytes = await readFile(catalog());
    await expect(
      updateNativeCatalogRecord({
        ...edit(),
        input: { id: entityId, fields: { amount: 'twelve' } },
      })
    ).rejects.toThrow(/amount/);
    await expect(
      updateNativeCatalogRecord({ ...edit(), input: { id: entityId, workspaceId: null } })
    ).rejects.toThrow(/project/);
    expect(entity()).toEqual(before);
    expect(await readFile(catalog())).toEqual(bytes);
  });

  it('rejects a conflicting sibling name and preserves the edit history', async () => {
    const before = entity();
    await expect(
      updateNativeCatalogRecord({ ...edit(), input: { id: entityId, name: 'REAGENT B' } })
    ).rejects.toThrow(/UNIQUE|sibling/);
    expect(entity()).toEqual(before);
  });

  it('does not publish uncommitted edits from a surrounding renderer transaction', async () => {
    const request = edit();
    const bytes = await readFile(catalog());
    db.exec('BEGIN');
    try {
      await expect(updateNativeCatalogRecord(request)).rejects.toThrow(/open database transaction/);
      expect(await readFile(catalog())).toEqual(bytes);
    } finally {
      db.exec('ROLLBACK');
    }
    expect(entity().name).toBe('Reagent a');
  });

  it('requires a pending edit to settle before a sync snapshot can include its catalog', async () => {
    const { buildWorkspaceSyncSnapshot } = await import('./workspace-sync-snapshotter');
    const { initManagedRepo } = await import('./workspace-git');
    await initManagedRepo(workspacePath);
    const publish = vi
      .spyOn(publication, 'publishNativeCatalogBytes')
      .mockRejectedValueOnce(new Error('Interrupted edit'));
    await expect(updateNativeCatalogRecord(edit())).rejects.toThrow('Interrupted edit');
    publish.mockRestore();
    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'reagents-workspace',
        appVersion: 'test',
        prepareProjection: false,
      })
    ).rejects.toThrow(/pending record save/);
    await recoverNativeCatalogRecordPublications({ db, workspacePath, runDatabase });
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'reagents-workspace',
      appVersion: 'test',
      prepareProjection: false,
    });
    const file = snapshot.bundle.files.find((file) => file.relativePath === '.forge/catalog.json');
    expect(file).toBeDefined();
    expect(parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).entities[0].name).toBe(
      'Updated reagent'
    );
    const { decodeBundleFileContent } = await import('@waypoint/share-bundle');
    if (!file) throw new Error('Expected catalog in snapshot');
    expect(Buffer.from(decodeBundleFileContent(file))).toEqual(await readFile(catalog()));
  });

  it('recovers an interrupted edit before committing and uploading its exact Git snapshot in one attempt', async () => {
    const { initManagedRepo, commitAllIfDirty, resolveHeadCommit } =
      await import('./workspace-git');
    const { WorkspaceSyncUploadWorker } = await import('./workspace-sync-upload-worker');
    const { decodeBundleFileContent } = await import('@waypoint/share-bundle');
    await initManagedRepo(workspacePath);
    await commitAllIfDirty(workspacePath, 'Initial imported records');
    const initialHead = await resolveHeadCommit(workspacePath);
    db.prepare(
      `INSERT INTO workspace_sync_device (id,device_id,created_at,updated_at) VALUES (1,'test-device',1,1)`
    ).run();
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
      workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,last_acked_local_head_sha,created_at,updated_at
    ) VALUES (?,'reagents-workspace','test-account','11111111-1111-4111-8111-111111111111',1,?,1,1)`
    ).run(entity().workspaceId, initialHead);
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted edit')
    );
    await expect(updateNativeCatalogRecord(edit())).rejects.toThrow('Interrupted edit');
    let uploadedBytes: Buffer | undefined;
    const createVersion = vi.fn(
      async (request: import('./workspace-sync-upload-worker').WorkspaceSyncUploadRequest) => {
        if (!request.bundle) throw new Error('Missing uploaded bundle');
        const file = request.bundle.files.find(
          (file) => file.relativePath === '.forge/catalog.json'
        );
        if (!file) throw new Error('Missing uploaded catalog');
        uploadedBytes = Buffer.from(decodeBundleFileContent(file));
        return {
          status: 'ready' as const,
          workspaceId: request.remoteWorkspaceId,
          version: {
            id: '22222222-2222-4222-8222-222222222222',
            versionNumber: 1,
            contentSha256: request.bundle.provenance.contentSha256,
            sizeBytes:
              request.bundle.schemaVersion === 3
                ? request.bundle.files.reduce((total, file) => total + file.sizeBytes, 0)
                : Buffer.byteLength(JSON.stringify(request.bundle)),
            fileCount: request.bundle.files.length,
          },
        };
      }
    );
    const readStoragePolicy = vi.fn(async () => ({
      schemaVersion: 1 as const,
      policyKey: 'catalog-record-test',
      revision: 7,
      maxFileBytes: 1024 ** 2,
      maxProjectBytes: 10 * 1024 ** 2,
      maxFiles: 64,
      storageQuotaBytes: 100 * 1024 ** 2,
    }));
    const worker = new WorkspaceSyncUploadWorker(db, {
      deviceId: 'test-device',
      appVersion: 'test',
      getActiveAccountId: () => 'test-account',
      getCurrentLocalHeadSha: ({ repoPath }) => resolveHeadCommit(repoPath),
      commitWorkingTreeIfDirty: (repoPath) => commitAllIfDirty(repoPath, 'Save native record'),
      client: { createVersion, readStoragePolicy },
    });
    const result = await worker.flushWorkspace('reagents-workspace');
    expect(result.status, JSON.stringify(result)).toBe('uploaded');
    expect(readStoragePolicy.mock.calls).toEqual([
      ['11111111-1111-4111-8111-111111111111', 'test-account'],
      ['11111111-1111-4111-8111-111111111111', 'test-account'],
    ]);
    expect(createVersion).toHaveBeenCalledOnce();
    expect(uploadedBytes).toEqual(await readFile(catalog()));
    expect(parseNativeWorkspaceManifest(uploadedBytes!.toString('utf8')).entities[0].name).toBe(
      'Updated reagent'
    );
    expect(await resolveHeadCommit(workspacePath)).not.toBe(initialHead);
    if (result.status !== 'uploaded') throw new Error('Expected upload');
    expect(result.job.localHeadSha).toBe(await resolveHeadCommit(workspacePath));
    expect(result.job.attemptCount).toBe(1);
  });

  it('refuses to overwrite a portable edit not reflected in the database', async () => {
    const manifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    manifest.entities[0].name = 'External edit';
    if (
      manifest.schema !== 'dnaforge.native-workspace-manifest.v2' ||
      manifest.entities[0].placement.kind !== 'catalog-record' ||
      !manifest.entities[0].lims
    )
      throw new Error('Expected native record');
    manifest.entities[0].placement = {
      ...manifest.entities[0].placement,
      displayName: 'External edit',
    };
    manifest.entities[0].lims.name = 'External edit';
    await writeFile(catalog(), JSON.stringify(manifest));
    const before = entity();
    await expect(updateNativeCatalogRecord(edit())).rejects.toThrow(/changed|disagree/);
    expect(entity()).toEqual(before);
    expect(parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).entities[0].name).toBe(
      'External edit'
    );
  });

  it.each(['unchanged', 'later-portable-edit', 'later-database-edit'] as const)(
    'recovers a committed edit after restart: %s',
    async (mode) => {
      const request = edit();
      const publish = vi
        .spyOn(publication, 'publishNativeCatalogBytes')
        .mockRejectedValueOnce(new Error('Stopped after database commit'));
      await expect(updateNativeCatalogRecord(request)).rejects.toThrow(
        'Stopped after database commit'
      );
      publish.mockRestore();
      expect(entity().name).toBe('Updated reagent');
      expect(parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).entities[0].name).toBe(
        'Reagent a'
      );
      db.close();
      db = openFileTestDb(join(root, 'database.sqlite'));
      if (mode === 'later-portable-edit') {
        const manifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
        manifest.entities[0].name = 'Keep external edit';
        if (
          manifest.schema !== 'dnaforge.native-workspace-manifest.v2' ||
          manifest.entities[0].placement.kind !== 'catalog-record' ||
          !manifest.entities[0].lims
        )
          throw new Error('Expected native record');
        manifest.entities[0].placement = {
          ...manifest.entities[0].placement,
          displayName: 'Keep external edit',
        };
        manifest.entities[0].lims.name = 'Keep external edit';
        await writeFile(catalog(), JSON.stringify(manifest));
      }
      if (mode === 'later-database-edit')
        db.prepare('UPDATE lims_entity SET name = ? WHERE id = ?').run(
          'Keep database edit',
          entityId
        );
      const beforeRecovery = await readFile(catalog());
      const recovering = recoverNativeCatalogRecordPublications({ db, workspacePath, runDatabase });
      if (mode === 'unchanged') {
        await recovering;
        const final = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
        expect(final.entities[0]).toMatchObject({
          name: 'Updated reagent',
          lims: { fields: { amount: 0, verified: false } },
        });
        const audit = db.prepare('SELECT count(*) AS n FROM lims_audit').get();
        await recoverNativeCatalogRecordPublications({ db, workspacePath, runDatabase });
        expect(db.prepare('SELECT count(*) AS n FROM lims_audit').get()).toEqual(audit);
      } else {
        await expect(recovering).rejects.toThrow(/changed/);
        expect(await readFile(catalog())).toEqual(beforeRecovery);
        if (mode === 'later-database-edit') expect(entity().name).toBe('Keep database edit');
      }
    }
  );
});
