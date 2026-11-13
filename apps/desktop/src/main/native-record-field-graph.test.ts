import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { registerNativeWorkspaceInsideTx } from './native-workspace-materializer';
import { reconcileNativeCatalogRecordsInsideTx } from './native-catalog-record-reconcile';
import { readNativeCatalogRecordState } from './native-catalog-record-state';
import {
  updateNativeCatalogRecord,
  actOnNativeCatalogRecord,
} from './native-catalog-record-mutations';
import * as publication from './native-catalog-publication';
import {
  getLinkRowById,
  insertAuditEvent,
  linkLimsEntitiesInsideTx,
  updateLimsEntityInsideTx,
} from './lims-engine-core';
import { limsLinkFromRow, validateLimsEntityFields } from '../shared/lims';
import {
  parseNativeWorkspaceManifest,
  type NativeWorkspaceManifestV2,
} from '../shared/native-workspace-manifest';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import { planRecordFieldGraphChange } from './native-record-field-graph';
import { queryNativeRecordRelationshipTargets } from './native-record-relationship-targets';
import {
  acquireWorkspaceSyncDatabaseFence,
  withRendererDatabaseStatement,
  type RendererDatabaseLifecycleSender,
} from './workspace-sync-database-fence';

const id = (raw: string) => scopedProjectionId('field-graph', raw);
const linkId = (target: string) =>
  `link-${createHash('sha256').update(`a:associated_with:${target}`).digest('hex').slice(0, 24)}`;
function fixture(): NativeWorkspaceManifestV2 {
  const schema = {
    schemaId: 'reagent-schema',
    schemaRevisionId: 'reagent-v1',
    version: 1,
    name: 'reagent',
    displayName: 'Reagent',
    baseKind: 'record',
    fields: [
      { key: 'parent', label: 'Parent', type: 'record_relationship' },
      { key: 'alternate', label: 'Alternate', type: 'record_relationship' },
    ],
  };
  return {
    schema: 'dnaforge.native-workspace-manifest.v2',
    entities: ['a', 'b', 'c'].map((raw) => ({
      id: raw,
      type: 'record',
      name: `Reagent ${raw}`,
      placement: {
        kind: 'catalog-record',
        parentRelativePath: '',
        displayName: `Reagent ${raw}`,
        catalogType: 'record',
        presentationKind: 'record',
      },
      lims: {
        kind: 'reagent',
        name: `Reagent ${raw}`,
        schemaRevisionId: schema.schemaRevisionId,
        schemaSnapshot: schema,
        fields:
          raw === 'a'
            ? Object.fromEntries(
                ['parent', 'alternate'].map((key) => [
                  key,
                  {
                    sourceTargetId: 'bfi_TARGET01',
                    destinationEntityId: 'b',
                    relationType: key,
                    label: 'Reagent b',
                    resolution: 'exact',
                  },
                ])
              )
            : {},
        createdAt: 42,
      },
    })),
    links: ['parent', 'alternate'].map((relation) => ({
      sourceId: 'a',
      targetId: 'b',
      relation,
      evidence: {
        kind: 'migration_relationship',
        relationshipId: `registry:bfi_SOURCE01:${relation}`,
        classification: 'exact',
        targetProviderStableId: 'bfi_TARGET01',
      },
    })),
    limsLinks: [
      {
        id: linkId('b'),
        fromEntityId: 'a',
        toEntityId: 'b',
        type: 'associated_with',
        payload: {
          sourceRelation: 'alternate',
          sourceClassification: 'exact',
          sourceRelationshipId: 'registry:bfi_SOURCE01:alternate',
        },
      },
    ],
  };
}

describe('native record field graph edits', () => {
  let root: string;
  let workspacePath: string;
  let db: Database.Database;
  const runDatabase = <T>(operation: () => T) => operation();
  const state = () => {
    const value = readNativeCatalogRecordState(db, id('a'));
    if (!value || value.eventSeq === null) throw new Error('Expected versioned fixture record.');
    return { ...value, eventSeq: value.eventSeq };
  };
  const catalog = () => join(workspacePath, '.forge/catalog.json');
  const request = (targets: Record<string, string | null>, operationId = 'field-edit') => ({
    db,
    runDatabase,
    operationId,
    expectedEventSeq: state().eventSeq,
    input: { id: id('a'), relationshipTargets: targets },
  });
  const graph = () => ({
    catalog: db.prepare('SELECT * FROM catalog_entity_links ORDER BY id').all(),
    lims: db.prepare('SELECT * FROM lims_link ORDER BY id').all(),
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'record-field-graph-'));
    workspacePath = join(root, 'workspace');
    await mkdir(join(workspacePath, '.forge'), { recursive: true });
    db = openFileTestDb(join(root, 'database.sqlite'));
    ensureSchema(db, join(root, 'database.sqlite'));
    const manifest = fixture();
    db.transaction(() => {
      registerNativeWorkspaceInsideTx(db, {
        path: workspacePath,
        name: 'Reagents',
        repoUuid: 'field-graph',
        createdAt: 1,
        lastOpenedAt: 1,
      });
      reconcileNativeCatalogRecordsInsideTx(db, workspacePath, manifest);
    })();
    await writeFile(catalog(), JSON.stringify(manifest));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('changes one field without removing another field sharing the same LIMS tuple', async () => {
    const before = graph();
    const updated = await updateNativeCatalogRecord(request({ parent: id('c') }));
    expect(updated.fields.parent).toEqual({
      origin: 'native',
      destinationEntityId: id('c'),
      relationType: 'parent',
      label: 'Reagent c',
      resolution: 'exact',
    });
    expect(updated.fields.alternate).toMatchObject({
      destinationEntityId: id('b'),
      sourceTargetId: 'bfi_TARGET01',
    });
    expect(
      db
        .prepare(
          'SELECT to_entity_id FROM lims_link WHERE from_entity_id=? AND tombstone=0 ORDER BY to_entity_id'
        )
        .all(id('a'))
    ).toEqual([id('b'), id('c')].sort().map((to_entity_id) => ({ to_entity_id })));
    expect(graph().lims).toEqual(expect.arrayContaining(before.lims));
    const manifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    expect(manifest.links.map((link) => [link.relation, link.targetId]).sort()).toEqual([
      ['alternate', 'b'],
      ['parent', 'c'],
    ]);
    expect(manifest.limsLinks?.map((link) => link.toEntityId).sort()).toEqual(['b', 'c']);
    const after = graph();
    db.transaction(() => reconcileNativeCatalogRecordsInsideTx(db, workspacePath, manifest))();
    expect(graph()).toEqual(after);
    await actOnNativeCatalogRecord({
      db,
      runDatabase,
      action: 'revert',
      operationId: 'revert-field',
      expectedEventSeq: state().eventSeq,
      input: { id: id('a') },
    });
    expect(state().fields.parent).toMatchObject({
      destinationEntityId: id('b'),
      sourceTargetId: 'bfi_TARGET01',
    });
    expect(db.prepare('SELECT to_entity_id FROM lims_link WHERE tombstone=0').all()).toEqual([
      { to_entity_id: id('b') },
    ]);
  });

  it('lists exact portable targets with names and Registry IDs, excluding the edited record', async () => {
    const page = await queryNativeRecordRelationshipTargets(db, { entityId: id('a') }, runDatabase);
    expect(page.hasMore).toBe(false);
    expect(page.targets.map((target) => target.id)).toEqual([id('b'), id('c')]);
    expect(page.targets[0]).toMatchObject({ name: 'Reagent b', registryId: expect.any(String) });
    expect(
      await queryNativeRecordRelationshipTargets(
        db,
        {
          entityId: id('a'),
          search: page.targets[0].registryId ?? '',
        },
        runDatabase
      )
    ).toEqual({ targets: [page.targets[0]], hasMore: false });
  });

  it.each(['workspace sync', 'another renderer'])(
    'rechecks the database boundary after file I/O when %s takes ownership',
    async (owner) => {
      const sender: RendererDatabaseLifecycleSender = {
        id: 4001,
        once: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
      };
      const other: RendererDatabaseLifecycleSender = {
        id: 4002,
        once: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
      };
      const guarded = <T>(operation: () => T) =>
        withRendererDatabaseStatement(db, sender, operation);
      const statements = vi.spyOn(db, 'prepare');
      const search = queryNativeRecordRelationshipTargets(db, { entityId: id('a') }, guarded);
      expect(statements).toHaveBeenCalledTimes(1);
      const release =
        owner === 'workspace sync'
          ? await acquireWorkspaceSyncDatabaseFence(db)
          : (() => {
              withRendererDatabaseStatement(db, other, () => db.exec('BEGIN'));
              return () => withRendererDatabaseStatement(db, other, () => db.exec('ROLLBACK'));
            })();
      const rejection = expect(search).rejects.toThrow(
        owner === 'workspace sync'
          ? /WORKSPACE_SYNC_DATABASE_BUSY/
          : /DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER/
      );
      try {
        await rejection;
        expect(statements).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
    }
  );

  it('does not offer archived or nonportable Registry targets', async () => {
    const manifest = fixture();
    manifest.entities = manifest.entities.filter((entity) => entity.id !== 'c');
    await writeFile(catalog(), JSON.stringify(manifest));
    db.prepare('UPDATE lims_entity SET tombstone=1,archived_at=1 WHERE id=?').run(id('b'));
    expect(
      await queryNativeRecordRelationshipTargets(db, { entityId: id('a') }, runDatabase)
    ).toEqual({
      targets: [],
      hasMore: false,
    });
  });

  it('paginates the eligible target set without losing rows behind ineligible Registry records', async () => {
    const manifest = fixture();
    const template = manifest.entities[2];
    if (!template.lims || template.placement.kind !== 'catalog-record')
      throw new Error('Fixture target missing.');
    for (let index = 0; index < 60; index++) {
      const raw = `target-${String(index).padStart(2, '0')}`;
      manifest.entities.push({
        ...template,
        id: raw,
        name: raw,
        placement: { ...template.placement, displayName: raw },
        lims: { ...template.lims, name: raw },
      });
    }
    db.transaction(() => reconcileNativeCatalogRecordsInsideTx(db, workspacePath, manifest))();
    await writeFile(catalog(), JSON.stringify(manifest));
    const first = await queryNativeRecordRelationshipTargets(
      db,
      {
        entityId: id('a'),
        search: 'target-',
      },
      runDatabase
    );
    const second = await queryNativeRecordRelationshipTargets(
      db,
      {
        entityId: id('a'),
        search: 'target-',
        offset: first.targets.length,
      },
      runDatabase
    );
    expect(first.targets).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.targets).toHaveLength(10);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.targets, ...second.targets].map((target) => target.id)).size).toBe(60);
  });

  it('publishes the committed graph after interruption and returns the original retry receipt', async () => {
    const input = request({ parent: id('c') });
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted graph publication')
    );
    await expect(updateNativeCatalogRecord(input)).rejects.toThrow('Interrupted graph publication');
    const committed = graph();
    const updated = await updateNativeCatalogRecord(input);
    expect(updated.fields.parent).toMatchObject({ origin: 'native', destinationEntityId: id('c') });
    expect(graph()).toEqual(committed);
    await updateNativeCatalogRecord(request({ alternate: null }, 'clear-other'));
    const later = graph();
    expect(await updateNativeCatalogRecord(input)).toEqual(updated);
    expect(graph()).toEqual(later);
    expect(state().fields.alternate).toBeNull();
  });

  it('clears only the last field claim and retains explicit null across reconstruction', async () => {
    await updateNativeCatalogRecord(request({ parent: null }, 'clear-first'));
    expect(db.prepare('SELECT to_entity_id FROM lims_link WHERE tombstone=0').all()).toEqual([
      { to_entity_id: id('b') },
    ]);
    await updateNativeCatalogRecord(request({ alternate: null }, 'clear-final'));
    expect(db.prepare('SELECT id FROM lims_link WHERE tombstone=0').all()).toEqual([]);
    const manifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    expect(manifest.links).toEqual([]);
    db.transaction(() => reconcileNativeCatalogRecordsInsideTx(db, workspacePath, manifest))();
    expect(state().fields).toEqual({ parent: null, alternate: null });
  });

  it('clears a valid imported reference to a catalog-only object without requiring a LIMS edge', () => {
    const manifest = fixture();
    manifest.entities[1] = {
      id: 'b',
      type: 'folder',
      name: 'Reference collection',
      placement: { kind: 'file', relativePath: 'Reference collection', fileKind: 'folder' },
    };
    manifest.limsLinks = [];
    const before = manifest.entities[0];
    if (!before.lims) throw new Error('Fixture record missing.');
    const after = {
      ...before,
      lims: { ...before.lims, fields: { parent: null, alternate: null } },
    };
    expect(planRecordFieldGraphChange(manifest, before, after)).toMatchObject({
      catalog: [
        { before: manifest.links[0], after: null },
        { before: manifest.links[1], after: null },
      ],
      lims: [],
    });
  });

  it('clears a portable reference whose missing file legitimately deferred its live LIMS projection', async () => {
    const manifest = fixture();
    manifest.entities[1] = {
      id: 'b',
      type: 'sequence',
      name: 'Reagent b',
      placement: { kind: 'file', relativePath: 'missing.gb', fileKind: 'genbank' },
      lims: {
        kind: 'dna_sequence',
        name: 'Reagent b',
        createdAt: 42,
        fields: {
          sequence: {
            mode: 'file',
            representation: 'portable',
            pathBase: 'workspace',
            relPath: 'missing.gb',
            length: 4,
            contentHash: `sha256:${'a'.repeat(64)}`,
            sourceFormat: 'genbank',
          },
        },
      },
    };
    db.prepare('DELETE FROM lims_link WHERE to_entity_id=?').run(id('b'));
    db.prepare('DELETE FROM lims_entity WHERE id=?').run(id('b'));
    db.prepare("UPDATE catalog_entities SET type='sequence' WHERE id=?").run(id('b'));
    db.prepare(
      `INSERT INTO catalog_entity_files (id,workspace_id,entity_id,path,file_kind,status,created_at,updated_at) VALUES (?,?,?,?,?,'missing',1,1)`
    ).run(
      'missing-file',
      state().workspaceId,
      id('b'),
      join(workspacePath, 'missing.gb'),
      'genbank'
    );
    await writeFile(catalog(), JSON.stringify(manifest));
    await updateNativeCatalogRecord(request({ parent: null, alternate: null }));
    const after = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    expect(after.links).toEqual([]);
    expect(after.limsLinks ?? []).toEqual([]);
    expect(state().fields).toEqual({ parent: null, alternate: null });
  });

  it('preserves unrelated incoming and outgoing local relationships byte for byte', async () => {
    const local = db.transaction(() => [
      linkLimsEntitiesInsideTx(db, {
        fromEntityId: id('a'),
        toEntityId: id('c'),
        type: 'references',
        payload: { note: 'user-owned' },
      }),
      linkLimsEntitiesInsideTx(db, {
        fromEntityId: id('c'),
        toEntityId: id('a'),
        type: 'references',
      }),
    ])();
    await updateNativeCatalogRecord(request({ parent: id('c') }));
    for (const link of local) expect(limsLinkFromRow(getLinkRowById(db, link.id))).toEqual(link);
  });

  it('preserves another portable relation using the same normalized LIMS tuple', async () => {
    const manifest = fixture();
    manifest.links.push({
      sourceId: 'a',
      targetId: 'b',
      relation: 'extra_evidence',
      evidence: { note: 'independent source relation' },
    });
    db.transaction(() => reconcileNativeCatalogRecordsInsideTx(db, workspacePath, manifest))();
    await writeFile(catalog(), JSON.stringify(manifest));
    const original = graph().lims;
    await updateNativeCatalogRecord(request({ parent: null, alternate: null }));
    expect(graph().lims).toEqual(original);
    expect(parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).links).toEqual([
      manifest.links[2],
    ]);
  });

  it.each(['catalog', 'lims'] as const)(
    'rejects independently edited %s graph data and rolls back the field change',
    async (kind) => {
      if (kind === 'catalog')
        db.prepare("UPDATE catalog_entity_links SET evidence=? WHERE relation='parent'").run(
          JSON.stringify({ later: 'local edit' })
        );
      else
        db.prepare('UPDATE lims_link SET payload=? WHERE id=?').run(
          JSON.stringify({ later: 'local edit' }),
          id(linkId('b'))
        );
      const current = state(),
        bytes = await readFile(catalog()),
        before = graph();
      await expect(
        updateNativeCatalogRecord(request({ parent: null, alternate: null }))
      ).rejects.toThrow(/relationship changed|different owner/);
      expect(state()).toEqual(current);
      expect(graph()).toEqual(before);
      expect(await readFile(catalog())).toEqual(bytes);
    }
  );

  it('rejects a user-owned conflicting target tuple instead of adopting it', async () => {
    const local = db.transaction(() =>
      linkLimsEntitiesInsideTx(db, {
        fromEntityId: id('a'),
        toEntityId: id('c'),
        type: 'associated_with',
        payload: { note: 'keep' },
      })
    )();
    const before = state(),
      bytes = await readFile(catalog());
    await expect(updateNativeCatalogRecord(request({ parent: id('c') }))).rejects.toThrow(
      /unrelated Registry/
    );
    expect(state()).toEqual(before);
    expect(limsLinkFromRow(getLinkRowById(db, local.id))).toEqual(local);
    expect(await readFile(catalog())).toEqual(bytes);
  });

  it.each([
    ['self', { parent: id('a') }],
    ['missing', { parent: id('missing') }],
    ['foreign', { parent: 'other-workspace::b' }],
    ['undeclared field', { absent: id('b') }],
  ])('rejects %s targets without changing the record or graph', async (_name, targets) => {
    const before = state(),
      bytes = await readFile(catalog());
    await expect(updateNativeCatalogRecord(request(targets))).rejects.toThrow(/target|field/i);
    expect(state()).toEqual(before);
    expect(await readFile(catalog())).toEqual(bytes);
  });

  it('rejects a target archived after the picker opened', async () => {
    db.prepare('UPDATE lims_entity SET tombstone=1, archived_at=123 WHERE id=?').run(id('c'));
    const before = state();
    await expect(updateNativeCatalogRecord(request({ parent: id('c') }))).rejects.toThrow(
      /active portable/
    );
    expect(state()).toEqual(before);
  });

  it('validates native relationship provenance without accepting mixed source identities', () => {
    const definition = [{ key: 'parent', label: 'Parent', type: 'record_relationship' as const }];
    const value = {
      origin: 'native',
      destinationEntityId: id('b'),
      relationType: 'parent',
      label: 'B',
      resolution: 'exact',
    };
    expect(validateLimsEntityFields('reagent', { parent: value }, definition)).toEqual([]);
    expect(
      validateLimsEntityFields(
        'reagent',
        { parent: { ...value, sourceTargetId: 'bfi_TARGET01' } },
        definition
      )
    ).not.toEqual([]);
    expect(
      validateLimsEntityFields(
        'reagent',
        { parent: { ...value, resolution: 'source_broken', destinationEntityId: null } },
        definition
      )
    ).not.toEqual([]);
  });

  it('rejects a target command sent to the ordinary LIMS updater instead of silently dropping it', () => {
    const before = state();
    expect(() =>
      db.transaction(() =>
        updateLimsEntityInsideTx(db, { id: id('a'), relationshipTargets: { parent: id('c') } })
      )()
    ).toThrow(/native record/);
    expect(state()).toEqual(before);
  });

  it('does not trust a graph edit actor without its matching committed publication receipt', async () => {
    const before = limsLinkFromRow(getLinkRowById(db, id(linkId('b'))));
    db.transaction(() =>
      insertAuditEvent(db, {
        eventType: 'link_updated',
        subjectTable: 'lims_link',
        subjectId: before.id,
        actor: 'native-record-field-edit',
        before,
        after: before,
        operationId: 'unrelated-operation',
        payload: { schema: 'dnaforge.native-record-field-owner.v1', recordId: id('a') },
      })
    )();
    await expect(
      updateNativeCatalogRecord(request({ parent: null, alternate: null }))
    ).rejects.toThrow(/different owner/);
  });

  it('uses current fields as ownership instead of persisting stale field-name lists in graph rows', async () => {
    await updateNativeCatalogRecord(request({ parent: id('c') }, 'parent-c'));
    await updateNativeCatalogRecord(request({ alternate: id('c') }, 'alternate-c'));
    await updateNativeCatalogRecord(request({ parent: id('b') }, 'parent-b'));
    const retained = limsLinkFromRow(getLinkRowById(db, id(linkId('c'))));
    expect(retained.tombstone).toBe(false);
    expect(retained.payload).not.toHaveProperty('fieldKeys');
    expect(state().fields.alternate).toMatchObject({ destinationEntityId: id('c') });
  });

  it('keeps unrelated manifest changes when recovering a committed relationship edit', async () => {
    const input = request({ parent: id('c') });
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted graph publication')
    );
    await expect(updateNativeCatalogRecord(input)).rejects.toThrow('Interrupted');
    const manifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    const unrelated = {
      sourceId: 'b',
      targetId: 'c',
      relation: 'references',
      evidence: { later: 'portable change' },
    };
    manifest.links.push(unrelated);
    await writeFile(catalog(), JSON.stringify(manifest));
    await updateNativeCatalogRecord(input);
    expect(parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8')).links).toContainEqual(
      unrelated
    );
  });

  it('rejects changed portable graph evidence during recovery and keeps the pending receipt', async () => {
    const input = request({ parent: id('c') });
    vi.spyOn(publication, 'publishNativeCatalogBytes').mockRejectedValueOnce(
      new Error('Interrupted graph publication')
    );
    await expect(updateNativeCatalogRecord(input)).rejects.toThrow('Interrupted');
    const manifest = parseNativeWorkspaceManifest(await readFile(catalog(), 'utf8'));
    manifest.links[0].evidence = { later: 'changed touched relation' };
    const later = JSON.stringify(manifest);
    await writeFile(catalog(), later);
    await expect(updateNativeCatalogRecord(input)).rejects.toThrow(/Portable relationship changed/);
    expect(await readFile(catalog(), 'utf8')).toEqual(later);
    expect(db.prepare('SELECT operation_id FROM native_catalog_publication_outbox').all()).toEqual([
      { operation_id: input.operationId },
    ]);
  });
});
