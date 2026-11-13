import {
  buildNotebookPackageMetadata,
  notebookPackagePaths,
  serializeNotebookPackageMetadata,
} from '../db/notebook-package';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeCatalogDatabase } from './native-catalog-repository';
import { createPrimerBindingOwnershipStore } from '../shared/primer-artifacts/primer-binding-ownership';
import {
  linkCatalogEntitiesInDb,
  recordCatalogEventInDb,
  updateCatalogEntityPresentationInDb,
  archiveSupersededNotebookCatalogInDb,
} from './catalog-association-commands';
import {
  writeCatalogWorkspacePlacementInDb,
  removeCatalogWorkspacePlacementInDb,
} from './catalog-placement-commands';
import { restoreCatalogProviderBindingInDb } from './catalog-provider-command';
import {
  type NativeWorkspaceManifest,
  type NativeWorkspaceManifestAnyEntity,
} from '../shared/native-workspace-manifest';

vi.mock('electron', () => ({ app: { getPath: vi.fn(), getVersion: () => 'test' } }));
let db: Database.Database;
let root: string;
let manifest: NativeWorkspaceManifest;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-association-authority-')));
  mkdirSync(join(root, '.forge'));
  mkdirSync(join(root, 'Records'));
  db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)').run('Owner', root);
  db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(8,?,?,1)').run(
    'Copy',
    join(root, 'copy')
  );
  manifest = { schema: 'dnaforge.native-workspace-manifest.v2', entities: [], links: [] };
  for (const id of ['a', 'b']) addEntity(id, 7);
  addEntity('global', null);
  addEntity('other', 8);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addEntity(id: string, owner: number | null, type = 'record') {
  db.prepare(
    `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
    VALUES(?,?,?,?,'database',?,1,1)`
  ).run(id, type, id, `entity://record/${id}`, owner);
}
function source(id: string, extra: Partial<NativeWorkspaceManifestAnyEntity> = {}) {
  const entity = {
    id,
    type: 'record',
    name: id,
    placement: {
      kind: 'catalog-record',
      parentRelativePath: 'Records',
      displayName: id,
      catalogType: 'record',
      presentationKind: 'record',
    },
    ...extra,
  } as NativeWorkspaceManifestAnyEntity;
  manifest.entities.push(entity as never);
  saveManifest();
  return entity;
}
function saveManifest() {
  writeFileSync(join(root, '.forge', 'catalog.json'), JSON.stringify(manifest));
}
const provider = (entityId = 'a') => ({
  provider: 'benchling',
  stableObjectId: 'ent_EXACT001',
  objectClass: 'registry_entity',
  entityId,
  bindingKind: 'observed' as const,
  evidence: { source: '.forge/catalog.json' },
});
function providerSource(id: string) {
  return source(id, {
    sourceIdentities: [
      {
        provider: 'benchling',
        stableObjectId: 'ent_EXACT001',
        objectClass: 'registry_entity',
        bindingKind: 'observed',
      },
    ],
  });
}
function placement(entityId = 'a') {
  return {
    entityId,
    workspaceId: 7,
    parentRelativePath: 'Records',
    displayName: entityId,
    presentationKind: 'record' as const,
  };
}

describe('native catalog associations', () => {
  it('keeps global and project-owned endpoints and native link retries stable', () => {
    const first = linkCatalogEntitiesInDb(db, {
      sourceEntityId: 'a',
      targetEntityId: 'global',
      relation: 'references',
    });
    expect(
      linkCatalogEntitiesInDb(db, {
        sourceEntityId: 'a',
        targetEntityId: 'global',
        relation: 'references',
        confidence: 'confirmed',
      }).id
    ).toBe(first.id);
    expect(
      linkCatalogEntitiesInDb(db, {
        sourceEntityId: 'global',
        targetEntityId: 'a',
        relation: 'references',
      }).source_entity_id
    ).toBe('global');
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_links').get()).toEqual({
      count: 2,
    });
  });
  it('rejects missing endpoints and invalid confidence atomically', () => {
    expect(() =>
      linkCatalogEntitiesInDb(db, {
        sourceEntityId: 'missing',
        targetEntityId: 'b',
        relation: 'references',
      })
    ).toThrow(/identity|exist/i);
    expect(() =>
      linkCatalogEntitiesInDb(db, {
        sourceEntityId: 'a',
        targetEntityId: 'b',
        relation: 'references',
        confidence: 'forged' as never,
      })
    ).toThrow(/confidence/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_links').get()).toEqual({
      count: 0,
    });
  });
  it('reconstructs reference-project links only from matching authoritative manifest values', () => {
    source('a');
    source('b');
    manifest.links.push({
      sourceId: 'a',
      targetId: 'b',
      relation: 'references',
      confidence: 'confirmed',
      evidence: { source: 'native' },
    });
    saveManifest();
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    expect(
      linkCatalogEntitiesInDb(db, {
        sourceEntityId: 'a',
        targetEntityId: 'b',
        relation: 'references',
        confidence: 'confirmed',
        evidence: { source: 'native' },
      }).confidence
    ).toBe('confirmed');
    expect(() =>
      linkCatalogEntitiesInDb(db, {
        sourceEntityId: 'a',
        targetEntityId: 'b',
        relation: 'references',
        confidence: 'rejected',
        evidence: { source: 'native' },
      })
    ).toThrow(/READ_ONLY|reference/i);
  });
  it('keeps event IDs attached to the exact event and treats identical retries as idempotent', () => {
    const event = {
      id: 'event-a',
      entityId: 'a',
      eventType: 'edited',
      payload: { version: 2 },
      createdAt: 12,
    };
    expect(recordCatalogEventInDb(db, event)).toEqual(recordCatalogEventInDb(db, event));
    expect(() => recordCatalogEventInDb(db, { ...event, entityId: 'b' })).toThrow(
      /identity|different/i
    );
    expect(() => recordCatalogEventInDb(db, { ...event, payload: { version: 3 } })).toThrow(
      /identity|different/i
    );
  });
  it('retains exact primer attachment ownership retries and refuses a conflicting native ID', async () => {
    const ownership = createPrimerBindingOwnershipStore(() =>
      createNativeCatalogDatabase(db, { assertCurrent: () => {} })
    );
    const intent = {
      documentId: 'a',
      draftLineageId: 'draft-one',
      pendingId: 'pending-one',
      primerId: 'primer-one',
      sequenceId: 1,
      bindingId: 'binding-one',
    };
    await ownership.record(intent);
    const before = db.prepare('SELECT * FROM catalog_entity_events').all();
    await ownership.record(intent);
    expect(db.prepare('SELECT * FROM catalog_entity_events').all()).toEqual(before);
    expect(await ownership.load('a', 'draft-one')).toEqual([intent]);
    await expect(ownership.record({ ...intent, bindingId: 'another-binding' })).rejects.toThrow(
      /identity|different/i
    );
    expect(db.prepare('SELECT * FROM catalog_entity_events').all()).toEqual(before);
  });
  it('refuses recording primer attachment ownership in a reference project', async () => {
    const ownership = createPrimerBindingOwnershipStore(() =>
      createNativeCatalogDatabase(db, { assertCurrent: () => {} })
    );
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    await expect(
      ownership.record({
        documentId: 'a',
        draftLineageId: 'draft-one',
        pendingId: 'pending-one',
        primerId: 'primer-one',
        sequenceId: 1,
        bindingId: 'binding-one',
      })
    ).rejects.toThrow(/READ_ONLY|reference/i);
    expect(db.prepare('SELECT * FROM catalog_entity_events').all()).toEqual([]);
  });
  it('reconstructs a manifest event in a reference project without granting arbitrary event writes', () => {
    source('a');
    manifest.events = [
      { id: 'event-a', entityId: 'a', eventType: 'imported', actor: 'importer', createdAt: 12 },
    ];
    saveManifest();
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    expect(
      recordCatalogEventInDb(db, {
        id: 'ws7::event-a',
        entityId: 'a',
        eventType: 'imported',
        actor: 'importer',
        createdAt: 12,
      }).event_type
    ).toBe('imported');
    expect(() => recordCatalogEventInDb(db, { entityId: 'a', eventType: 'invented' })).toThrow(
      /READ_ONLY|reference/i
    );
  });
  it('rejects identity-bearing metadata changes without source authority', () => {
    expect(() =>
      updateCatalogEntityPresentationInDb(db, {
        entityId: 'a',
        metadataPatch: { portableId: 'other' },
      })
    ).toThrow(/source|identity/i);
    expect(
      updateCatalogEntityPresentationInDb(db, {
        entityId: 'a',
        metadataPatch: { description: 'A local record' },
      })?.metadata
    ).toContain('A local record');
  });
  it('requires source names for file projections and preserves the owning identity', () => {
    const path = join(root, 'record.json');
    writeFileSync(path, JSON.stringify({ id: 'a', name: 'Saved native name' }));
    db.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES('a-file','a',7,?,'waypoint-selection',1,1)`
    ).run(path);
    expect(() =>
      updateCatalogEntityPresentationInDb(db, { entityId: 'a', name: 'Invented projection' })
    ).toThrow(/source|name/i);
    expect(
      updateCatalogEntityPresentationInDb(db, { entityId: 'a', name: 'Saved native name' })?.name
    ).toBe('Saved native name');
    expect(db.prepare("SELECT id,workspace_id FROM catalog_entities WHERE id='a'").get()).toEqual({
      id: 'a',
      workspace_id: 7,
    });
  });
});

describe('native manifest provider binding admission', () => {
  it('requires the exact provider identity recorded for this entity', () => {
    providerSource('a');
    restoreCatalogProviderBindingInDb(db, provider());
    restoreCatalogProviderBindingInDb(db, provider());
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_provider_bindings').get()).toEqual({
      count: 1,
    });
    expect(() =>
      restoreCatalogProviderBindingInDb(db, { ...provider(), stableObjectId: 'ent_FORGED01' })
    ).toThrow(/source|identity/i);
    expect(() =>
      restoreCatalogProviderBindingInDb(db, { ...provider(), bindingKind: 'reviewed' })
    ).toThrow(/source|identity/i);
  });
  it('rejects two identities claiming one provider object within one exact project', () => {
    providerSource('a');
    providerSource('b');
    restoreCatalogProviderBindingInDb(db, provider());
    expect(() => restoreCatalogProviderBindingInDb(db, provider('b'))).toThrow(/conflict|another/i);
    expect(db.prepare('SELECT entity_id FROM catalog_provider_bindings').all()).toEqual([
      { entity_id: 'a' },
    ]);
  });
  it('preserves the same provider object in a distinct project and leaves ambiguity to the resolver', () => {
    providerSource('a');
    restoreCatalogProviderBindingInDb(db, provider());
    const copied = join(root, 'copy');
    mkdirSync(join(copied, '.forge'), { recursive: true });
    const copyManifest = {
      schema: manifest.schema,
      entities: [
        {
          ...manifest.entities[0],
          id: 'other',
          name: 'other',
          placement: {
            kind: 'catalog-record',
            parentRelativePath: '',
            displayName: 'other',
            catalogType: 'record',
            presentationKind: 'record',
          },
        },
      ],
      links: [],
    };
    writeFileSync(join(copied, '.forge', 'catalog.json'), JSON.stringify(copyManifest));
    restoreCatalogProviderBindingInDb(db, provider('other'));
    expect(
      db.prepare('SELECT entity_id FROM catalog_provider_bindings ORDER BY entity_id').all()
    ).toEqual([{ entity_id: 'a' }, { entity_id: 'other' }]);
  });
});

describe('native catalog placement admission', () => {
  it('restores only the exact source placement and rejects cross-project ownership', () => {
    source('a');
    const first = writeCatalogWorkspacePlacementInDb(db, placement());
    expect(writeCatalogWorkspacePlacementInDb(db, placement()).created_at).toBe(first.created_at);
    expect(() =>
      writeCatalogWorkspacePlacementInDb(db, { ...placement(), workspaceId: 8 })
    ).toThrow(/workspace|owner/i);
    expect(() =>
      writeCatalogWorkspacePlacementInDb(db, { ...placement(), parentRelativePath: '../escape' })
    ).toThrow(/unsafe|path/i);
    expect(() =>
      writeCatalogWorkspacePlacementInDb(db, { ...placement(), displayName: 'Forged' })
    ).toThrow(/source|placement/i);
  });
  it('keeps authoritative visible placements until their native source removes them', () => {
    source('a');
    writeCatalogWorkspacePlacementInDb(db, placement());
    expect(() => removeCatalogWorkspacePlacementInDb(db, 'a', 'delete')).toThrow(
      /source|placement/i
    );
    expect(() => removeCatalogWorkspacePlacementInDb(db, 'a', 'hide')).toThrow(/source|placement/i);
    manifest.entities = [];
    saveManifest();
    expect(removeCatalogWorkspacePlacementInDb(db, 'a', 'delete')).toBe(true);
  });
  it('rejects active sibling collisions without deleting the existing placement', () => {
    source('a');
    writeCatalogWorkspacePlacementInDb(db, placement());
    db.prepare(
      `INSERT INTO catalog_workspace_placements(entity_id,workspace_id,parent_relative_path,display_name,normalized_sibling_name,presentation_kind,status,created_at,updated_at) VALUES('b',7,'Records','a','a','record','hidden',1,1)`
    ).run();
    expect(() =>
      writeCatalogWorkspacePlacementInDb(db, { ...placement('b'), displayName: 'a' })
    ).toThrow();
    expect(
      db.prepare("SELECT status FROM catalog_workspace_placements WHERE entity_id='a'").get()
    ).toEqual({ status: 'active' });
  });
});

describe('legacy notebook catalog retirement', () => {
  it('requires a same-project scoped successor with a current native binding', () => {
    addEntity('legacy-notebook', 7, 'notebook');
    addEntity('ws7::legacy-notebook', 7, 'notebook');
    db.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES('notebook-file','ws7::legacy-notebook',7,?,'waypoint-notebook',1,1)`
    ).run(join(root, 'Notebook'));
    expect(() =>
      archiveSupersededNotebookCatalogInDb(db, {
        sourceEntityId: 'legacy-notebook',
        successorEntityId: 'other',
        workspaceId: 7,
      })
    ).toThrow(/successor|identity/i);
    const paths = notebookPackagePaths(join(root, 'Notebook'));
    mkdirSync(paths.metaDir, { recursive: true });
    writeFileSync(
      paths.metaPath,
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'forged-notebook',
          title: 'Notebook',
          markdownFileName: 'Notebook.md',
        })
      )
    );
    writeFileSync(paths.markdownPath, '# Retained notebook\n');
    expect(() =>
      archiveSupersededNotebookCatalogInDb(db, {
        sourceEntityId: 'legacy-notebook',
        successorEntityId: 'ws7::legacy-notebook',
        workspaceId: 7,
      })
    ).toThrow(/source identity/i);
    expect(
      db.prepare("SELECT status FROM catalog_entities WHERE id='legacy-notebook'").get()
    ).toEqual({ status: 'active' });
    writeFileSync(
      paths.metaPath,
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'legacy-notebook',
          title: 'Notebook',
          markdownFileName: 'Notebook.md',
        })
      )
    );
    archiveSupersededNotebookCatalogInDb(db, {
      sourceEntityId: 'legacy-notebook',
      successorEntityId: 'ws7::legacy-notebook',
      workspaceId: 7,
    });
    expect(
      db.prepare("SELECT status FROM catalog_entities WHERE id='legacy-notebook'").get()
    ).toEqual({ status: 'archived' });
  });
});
