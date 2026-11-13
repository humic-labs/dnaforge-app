import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  registerNativeWorkspaceInsideTx,
  materializeNativeWorkspaceInsideTx,
} from './native-workspace-materializer';
import {
  reconcileNativeCatalogRecordsInsideTx,
  reconcileNativeCatalogRecordsFromFile,
} from './native-catalog-record-reconcile';
import { readNativeCatalogRecordState } from './native-catalog-record-state';
import {
  parseNativeWorkspaceManifest,
  type NativeWorkspaceManifestV2,
} from '../shared/native-workspace-manifest';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import { linkLimsEntitiesInsideTx } from './lims-engine-core';
import {
  assertLimsProjectionReplayParityInDb,
  verifyLimsAuditHashChainInDb,
} from './lims-projection-rebuild';

const root = '/tmp/native-record-reconstruction';
const id = (raw: string) => scopedProjectionId('record-copy', raw);
function fixture(): NativeWorkspaceManifestV2 {
  const schema = {
    schemaId: 'reagent-schema',
    schemaRevisionId: 'reagent-v1',
    name: 'reagent',
    displayName: 'Reagent',
    baseKind: 'record',
    version: 1,
    fields: [
      { key: 'amount', label: 'Amount', type: 'number' },
      { key: 'verified', label: 'Verified', type: 'boolean' },
      { key: 'parent', label: 'Parent', type: 'record_relationship' },
    ],
  };
  return {
    schema: 'dnaforge.native-workspace-manifest.v2',
    entities: ['a', 'b'].map((raw) => ({
      id: raw,
      type: 'record',
      name: `Reagent ${raw}`,
      placement: {
        kind: 'catalog-record',
        parentRelativePath: 'Reagents',
        displayName: `Reagent ${raw}`,
        catalogType: 'record',
        presentationKind: 'record',
      },
      lims: {
        kind: 'reagent',
        name: `Reagent ${raw}`,
        schemaRevisionId: schema.schemaRevisionId,
        schemaSnapshot: schema,
        fields: {
          amount: 0,
          verified: false,
          ...(raw === 'a'
            ? {
                parent: {
                  sourceTargetId: 'bfi_PARENT01',
                  destinationEntityId: 'b',
                  relationType: 'references',
                  label: 'Reagent b',
                  resolution: 'exact',
                },
              }
            : {}),
        },
        domainStatus: 'available',
        createdAt: 42,
      },
    })),
    links: [
      { sourceId: 'a', targetId: 'b', relation: 'references', evidence: { fieldKey: 'parent' } },
    ],
    limsLinks: [
      {
        id: 'parent-link',
        fromEntityId: 'a',
        toEntityId: 'b',
        type: 'references',
        payload: { fieldKey: 'parent' },
      },
    ],
  };
}

describe('portable record reconstruction', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.transaction(() =>
      registerNativeWorkspaceInsideTx(db, {
        path: root,
        name: 'Reagents',
        repoUuid: 'record-copy',
        createdAt: 1,
        lastOpenedAt: 1,
      })
    )();
  });
  afterEach(() => db.close());
  const project = (manifest = fixture()) =>
    db.transaction(() =>
      reconcileNativeCatalogRecordsInsideTx(
        db,
        root,
        parseNativeWorkspaceManifest(JSON.stringify(manifest))
      )
    )();
  const state = (raw: string) =>
    readNativeCatalogRecordState(db, id(raw), { includeArchived: true });
  const auditCount = () => db.prepare('SELECT count(*) AS n FROM lims_audit').get();

  it('reconstructs pinned typed fields and both relationship graphs, then is a no-op', () => {
    expect(project()).toBe(2);
    expect(state('a')).toMatchObject({
      name: 'Reagent a',
      catalogName: 'Reagent a',
      fields: { amount: 0, verified: false, parent: { destinationEntityId: id('b') } },
      schemaSnapshot: { schemaRevisionId: 'reagent-v1' },
      domainStatus: 'available',
      graph: { catalog: [{ target_entity_id: id('b') }], lims: [{ to_entity_id: id('b') }] },
    });
    const before = state('a');
    const count = auditCount();
    expect(project()).toBe(2);
    expect(state('a')).toEqual(before);
    expect(auditCount()).toEqual(count);
  });

  it('reconstructs archived records directly, including same-name siblings and preserved links', () => {
    const manifest = fixture();
    manifest.entities[0].lifecycle = { state: 'archived', archivedAt: 1234 };
    manifest.entities[1].name = 'Reagent a';
    manifest.entities[1].lims!.name = 'Reagent a';
    if (manifest.entities[1].placement.kind !== 'catalog-record') throw new Error('fixture');
    manifest.entities[1].placement = {
      ...manifest.entities[1].placement,
      displayName: 'Reagent a',
    };
    project(manifest);
    expect(state('a')).toMatchObject({
      catalogStatus: 'archived',
      archivedAt: 1234,
      placements: [{ status: 'hidden' }],
      graph: { lims: [{ tombstone: 0 }] },
    });
    expect(state('b')).toMatchObject({ catalogStatus: 'active', archivedAt: null });
    const events = db
      .prepare(
        "SELECT event_type, after FROM lims_audit WHERE subject_id = ? AND subject_table = 'lims_entity'"
      )
      .all(id('a')) as Array<{ event_type: string; after: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].after)).toMatchObject({ tombstone: true, archivedAt: 1234 });
    const count = auditCount();
    project(manifest);
    expect(auditCount()).toEqual(count);
  });

  it('projects changed schema, fields, names, lifecycle and removed graph without changing local registry identity', () => {
    project();
    const before = db
      .prepare('SELECT registry_id, created_at FROM lims_entity WHERE id = ?')
      .get(id('a'));
    const manifest = fixture();
    const a = manifest.entities[0];
    a.name = 'Renamed reagent';
    a.lims!.name = a.name;
    if (a.placement.kind !== 'catalog-record') throw new Error('fixture');
    a.placement = { ...a.placement, displayName: a.name };
    a.lims!.fields = { amount: 9, verified: true, comment: 'portable edit' };
    a.lims!.schemaRevisionId = 'reagent-v2';
    a.lims!.schemaSnapshot = {
      ...a.lims!.schemaSnapshot!,
      schemaRevisionId: 'reagent-v2',
      version: 2,
      fields: [
        { key: 'amount', label: 'Amount', type: 'number' },
        { key: 'verified', label: 'Verified', type: 'boolean' },
        { key: 'comment', label: 'Comment', type: 'text' },
      ],
    };
    a.lims!.domainStatus = 'consumed';
    a.lifecycle = { state: 'archived', archivedAt: 789 };
    manifest.links = [];
    manifest.limsLinks = [];
    project(manifest);
    expect(state('a')).toMatchObject({
      name: a.name,
      catalogName: a.name,
      catalogStatus: 'archived',
      archivedAt: 789,
      fields: a.lims!.fields,
      schemaSnapshot: { schemaRevisionId: 'reagent-v2' },
      domainStatus: 'consumed',
      graph: { catalog: [], lims: [{ tombstone: 1 }] },
    });
    expect(
      db.prepare('SELECT registry_id, created_at FROM lims_entity WHERE id = ?').get(id('a'))
    ).toEqual(before);
    expect(state('b')?.fields).toEqual({ amount: 0, verified: false });
    a.lifecycle = { state: 'active' };
    project(manifest);
    expect(state('a')).toMatchObject({ catalogStatus: 'active', archivedAt: null });
  });

  it('rolls back every record when a later record collides with an immutable schema revision', () => {
    project();
    const before = state('a');
    const count = auditCount();
    const manifest = fixture();
    manifest.entities[0].lims!.fields.amount = 42;
    manifest.entities[1].lims!.schemaSnapshot = {
      ...manifest.entities[1].lims!.schemaSnapshot!,
      fields: [{ key: 'amount', label: 'Changed definition', type: 'number' }],
    };
    expect(() => project(manifest)).toThrow(/collision/i);
    expect(state('a')).toEqual(before);
    expect(auditCount()).toEqual(count);
  });

  it('rejects an identity already owned by a different catalog type without modifying it', () => {
    project();
    db.prepare("UPDATE catalog_entities SET type = 'sample' WHERE id = ?").run(id('a'));
    const count = auditCount();
    expect(() => project()).toThrow(/identity|type/i);
    expect(auditCount()).toEqual(count);
    expect(db.prepare('SELECT type FROM catalog_entities WHERE id = ?').get(id('a'))).toEqual({
      type: 'sample',
    });
  });

  it('accepts an atomic display-name swap and updates saved relationship evidence', () => {
    project();
    const manifest = fixture();
    for (const [index, name] of ['Reagent b', 'Reagent a'].entries()) {
      const record = manifest.entities[index];
      record.name = name;
      record.lims!.name = name;
      if (record.placement.kind !== 'catalog-record') throw new Error('fixture');
      record.placement = { ...record.placement, displayName: name };
    }
    manifest.links[0].evidence = { fieldKey: 'parent', note: 'revised' };
    manifest.limsLinks![0].payload = { fieldKey: 'parent', note: 'revised' };
    project(manifest);
    expect(state('a')?.name).toBe('Reagent b');
    expect(state('b')?.name).toBe('Reagent a');
    expect(state('a')?.graph.lims).toMatchObject([
      { payload: JSON.stringify(manifest.limsLinks![0].payload) },
    ]);
    expect(state('a')?.graph.catalog).toMatchObject([
      { evidence: JSON.stringify(manifest.links[0].evidence) },
    ]);
  });

  it('requires the caller transaction and rejects an unknown workspace', () => {
    expect(() => reconcileNativeCatalogRecordsInsideTx(db, root, fixture())).toThrow(
      /transaction/i
    );
    expect(() =>
      db.transaction(() => reconcileNativeCatalogRecordsInsideTx(db, '/other', fixture()))()
    ).toThrow(/project/i);
  });

  it('repairs a missing projection from its local audit without allocating another registry ID', () => {
    const manifest = fixture();
    manifest.links = [];
    manifest.limsLinks = [];
    delete manifest.entities[0].lims!.fields.parent;
    project(manifest);
    const before = db
      .prepare('SELECT registry_id, created_at FROM lims_entity WHERE id = ?')
      .get(id('a'));
    const count = auditCount();
    db.prepare('DELETE FROM lims_entity WHERE id = ?').run(id('a'));
    project(manifest);
    expect(
      db.prepare('SELECT registry_id, created_at FROM lims_entity WHERE id = ?').get(id('a'))
    ).toEqual(before);
    expect(auditCount()).toEqual(count);
  });

  it('reads the authoritative file and refuses a stale renderer snapshot before projection', () => {
    const folder = mkdtempSync(join(tmpdir(), 'record-reconcile-'));
    try {
      mkdirSync(join(folder, '.forge'));
      const path = join(folder, '.forge/catalog.json');
      const bytes = JSON.stringify(fixture());
      writeFileSync(path, bytes);
      db.prepare('UPDATE workspaces SET path=? WHERE path=?').run(folder, root);
      const expectedManifestSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      expect(() =>
        reconcileNativeCatalogRecordsFromFile(db, {
          workspaceRoot: folder,
          expectedManifestSha256: 'sha256:' + '0'.repeat(64),
        })
      ).toThrow(/changed/i);
      expect(state('a')).toBeNull();
      expect(
        reconcileNativeCatalogRecordsFromFile(db, { workspaceRoot: folder, expectedManifestSha256 })
      ).toBe(2);
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      expect(state('a')?.fields.amount).toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('preserves an unowned local relationship absent from an unchanged manifest', () => {
    project();
    db.transaction(() =>
      linkLimsEntitiesInsideTx(db, {
        id: 'local-link',
        fromEntityId: id('b'),
        toEntityId: id('a'),
        type: 'references',
        actor: 'local-user',
      })
    )();
    db.prepare(
      "INSERT INTO catalog_entity_links (id,source_entity_id,relation,target_entity_id,confidence,evidence,created_at,updated_at) VALUES ('local-catalog',?,'references',?,'confirmed',NULL,1,1)"
    ).run(id('b'), id('a'));
    project();
    expect(db.prepare("SELECT tombstone FROM lims_link WHERE id='local-link'").get()).toEqual({
      tombstone: 0,
    });
    expect(
      db.prepare("SELECT id FROM catalog_entity_links WHERE id='local-catalog'").get()
    ).toEqual({ id: 'local-catalog' });
  });

  it('removes owned incoming edges when the source is not a custom record', () => {
    project();
    db.prepare("UPDATE catalog_entities SET type='sample' WHERE id=?").run(id('a'));
    const manifest = fixture();
    manifest.entities[0].type = 'sample';
    if (manifest.entities[0].placement.kind !== 'catalog-record') throw new Error('fixture');
    manifest.entities[0].placement = {
      ...manifest.entities[0].placement,
      catalogType: 'sample',
      presentationKind: 'strain',
    };
    manifest.links = [];
    manifest.limsLinks = [];
    delete manifest.entities[0].lims!.fields.parent;
    project(manifest);
    expect(db.prepare('SELECT id FROM catalog_entity_links').all()).toEqual([]);
    expect(db.prepare('SELECT tombstone FROM lims_link').all()).toEqual([{ tombstone: 1 }]);
  });

  it.each(['catalog', 'lims'])(
    'rejects replacement of an import-owned %s relationship edited locally',
    (graph) => {
      const manifest = fixture();
      const c = structuredClone(manifest.entities[1]);
      c.id = 'c';
      c.name = 'Reagent c';
      if (c.placement.kind !== 'catalog-record') throw new Error('fixture');
      c.placement = { ...c.placement, displayName: c.name };
      c.lims!.name = c.name;
      manifest.entities.push(c);
      project(manifest);
      if (graph === 'catalog') {
        db.prepare('UPDATE catalog_entity_links SET evidence=? WHERE source_entity_id=?').run(
          JSON.stringify({ fieldKey: 'parent', userNote: 'Keep this relationship' }),
          id('a')
        );
      } else {
        db.prepare('UPDATE lims_link SET payload=? WHERE from_entity_id=?').run(
          JSON.stringify({ fieldKey: 'parent', userNote: 'Keep this relationship' }),
          id('a')
        );
      }
      const before = state('a');
      const count = auditCount();
      manifest.entities[0].lims!.fields.parent = {
        sourceTargetId: 'bfi_PARENT02',
        destinationEntityId: 'c',
        relationType: 'references',
        label: 'Reagent c',
        resolution: 'exact',
      };
      manifest.links = [
        { sourceId: 'a', targetId: 'c', relation: 'references', evidence: { fieldKey: 'parent' } },
      ];
      manifest.limsLinks = [
        {
          id: 'new-parent',
          fromEntityId: 'a',
          toEntityId: 'c',
          type: 'references',
          payload: { fieldKey: 'parent' },
        },
      ];
      expect(() => project(manifest)).toThrow(/relationship.*changed|relationship.*conflict/i);
      expect(state('a')).toEqual(before);
      expect(auditCount()).toEqual(count);
    }
  );

  it('checks lineage cycles against the final graph after replacing an edge', () => {
    const manifest = fixture();
    manifest.links[0].relation = 'derives_from';
    manifest.limsLinks![0].type = 'derives_from';
    delete manifest.entities[0].lims!.fields.parent;
    project(manifest);
    manifest.links = [{ sourceId: 'b', targetId: 'a', relation: 'derives_from' }];
    manifest.limsLinks = [
      { id: 'reversed-link', fromEntityId: 'b', toEntityId: 'a', type: 'derives_from' },
    ];
    expect(() => project(manifest)).not.toThrow();
    expect(
      db.prepare('SELECT from_entity_id,to_entity_id FROM lims_link WHERE tombstone=0').all()
    ).toEqual([{ from_entity_id: id('b'), to_entity_id: id('a') }]);
  });

  it('does not assign a local registry ID during a field reconciliation', () => {
    project();
    db.prepare('UPDATE lims_entity SET registry_id=NULL WHERE id=?').run(id('a'));
    const counter = db.prepare("SELECT next_seq FROM lims_id_scheme WHERE kind='reagent'").get();
    const manifest = fixture();
    manifest.entities[0].lims!.fields.amount = 8;
    project(manifest);
    expect(db.prepare('SELECT registry_id FROM lims_entity WHERE id=?').get(id('a'))).toEqual({
      registry_id: null,
    });
    expect(db.prepare("SELECT next_seq FROM lims_id_scheme WHERE kind='reagent'").get()).toEqual(
      counter
    );
  });

  it('rejects a claimed portable link ID owned by another tuple even on the no-op path', () => {
    const manifest = fixture();
    manifest.limsLinks!.push({
      id: 'second-link',
      fromEntityId: 'b',
      toEntityId: 'a',
      type: 'references',
    });
    project(manifest);
    manifest.limsLinks = [{ ...manifest.limsLinks![0], id: 'second-link' }];
    expect(() => project(manifest)).toThrow(/identity/i);
  });

  it('reconstructs two ordinary-folder copies with independent identities and exact relationship scopes', () => {
    const manifest = fixture();
    const copies = ['/tmp/record-copy-one', '/tmp/record-copy-two'];
    const projectedIds: string[] = [];
    for (const path of copies) {
      const workspaceId = db.transaction(() =>
        registerNativeWorkspaceInsideTx(db, {
          path,
          name: 'Copy',
          repoUuid: null,
          createdAt: 1,
          lastOpenedAt: 1,
        })
      )();
      db.transaction(() => reconcileNativeCatalogRecordsInsideTx(db, path, manifest))();
      const scope = `ws${workspaceId}`;
      const a = scopedProjectionId(scope, 'a'),
        b = scopedProjectionId(scope, 'b');
      projectedIds.push(a);
      expect(readNativeCatalogRecordState(db, a)).toMatchObject({
        workspaceId,
        fields: { parent: { destinationEntityId: b } },
        graph: { catalog: [{ target_entity_id: b }], lims: [{ to_entity_id: b }] },
      });
    }
    expect(projectedIds[0]).not.toBe(projectedIds[1]);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();
  });

  it('does not mutate a quarantined registry during workspace reconstruction', () => {
    project();
    const before = state('a');
    db.prepare(
      "INSERT INTO lims_safety_quarantine (id,status,reason,evidence_kind,evidence_workspace_id,evidence_json,detected_at,resolved_at) VALUES (1,'quarantined','test-preserved-registry','audit_integrity',1,'{}',1,NULL)"
    ).run();
    const count = auditCount();
    expect(() => project()).toThrow(/blocked|integrity|quarantin/i);
    expect(auditCount()).toEqual(count);
    expect(state('a')).toEqual(before);
  });

  it('recognizes import-owned catalog relationships on the first post-import reconstruction', () => {
    const manifest = fixture();
    db.transaction(() =>
      materializeNativeWorkspaceInsideTx(db, {
        workspace: {
          path: root,
          name: 'Reagents',
          repoUuid: 'record-copy',
          createdAt: 1,
          lastOpenedAt: 1,
        },
        plan: {
          schema: 'dnaforge.native-workspace-materialization.v1',
          entities: manifest.entities.map((record) => ({
            rawId: record.id,
            type: record.type,
            name: record.name,
            locator: { kind: 'entity', namespace: 'lims' },
            storageType: 'database',
            placement: record.placement,
          })),
          links: manifest.links.map((link) => ({
            sourceRawId: link.sourceId,
            targetRawId: link.targetId,
            relation: link.relation,
            evidence: link.evidence,
          })),
          events: [],
          limsEntities: manifest.entities.map((record) => ({
            entityRawId: record.id,
            input: record.lims!,
          })),
          limsLinks: manifest.limsLinks!.map((link) => ({
            id: link.id,
            fromEntityRawId: link.fromEntityId,
            toEntityRawId: link.toEntityId,
            type: link.type,
            payload: link.payload,
          })),
        },
      })
    )();
    manifest.links = [];
    manifest.limsLinks = [];
    delete manifest.entities[0].lims!.fields.parent;
    project(manifest);
    expect(db.prepare('SELECT id FROM catalog_entity_links').all()).toEqual([]);
    expect(db.prepare('SELECT tombstone FROM lims_link').all()).toEqual([{ tombstone: 1 }]);
  });
});
