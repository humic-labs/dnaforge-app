import type { JSONContent } from '@tiptap/core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { seedOriginalProjectFixture } from './__tests__/original-project-fixture';
import { ensureSchema } from './schema';
import {
  entityDiscoveryTypesInDb,
  resolveEntitiesInDb,
  searchEntitiesInDb,
} from './entity-discovery';
import { archiveLimsEntityInDb, registerLimsEntityInDb, restoreLimsEntityInDb } from './lims';
import { publishNotebookPackageV2InMain } from './__tests__/publish-notebook-fixture';
import { replaceNotebookProjectionFromFileInMain } from './notebook-projection-authority';
import { notebookPackagePaths } from '../db/notebook-package';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import { createSequenceEntityMetadataForSchema } from '../shared/sequence-entity-schema';
import { listLimsEntitySchemasInDb } from './lims-engine-core';
import { readEntitySchemaSnapshotInDb } from './entity-schema-snapshot';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

let fixture: ReturnType<typeof createFileTestDb>;
let owner: ReturnType<typeof seedOriginalProjectFixture>;

beforeEach(() => {
  fixture = createFileTestDb('entity-type-authority');
  ensureSchema(fixture.db, fixture.dbPath);
  owner = seedOriginalProjectFixture(fixture.db);
});
afterEach(() => fixture.cleanup());

function bind(id: string, type: string, name: string, path: string, fileKind: string) {
  fixture.db
    .prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,?,?,?,'file',?,1,1)"
    )
    .run(id, type, name, `entity://fixture/${id}`, owner.workspaceId);
  fixture.db
    .prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'current',1,1)"
    )
    .run(`file-${id}`, id, owner.workspaceId, path, fileKind);
}

it('keeps filename and inferred file format from overriding the admitted molecular identity', () => {
  const { db } = fixture;
  bind(
    'misleading',
    'file',
    'Misleading',
    join(owner.rootPath, 'a.dnaforge-molecular.json'),
    'dnaforge-molecular-document'
  );
  bind(
    'coordinate',
    'structure',
    'Coordinate',
    join(owner.rootPath, 'b.dnaforge-molecular.json'),
    'structure'
  );
  bind('admitted', 'molecular-document', 'Admitted', join(owner.rootPath, 'c.json'), 'file');
  const ids = (key: string) =>
    searchEntitiesInDb(db, { query: '', filter: { namedTypeKey: key } })
      .items.map((row) => row.id)
      .sort();
  expect(ids('type:molecular-document')).toEqual(['admitted']);
  expect(ids('type:file')).toEqual(['coordinate', 'misleading']);
  const byId = resolveEntitiesInDb(db, { ids: ['coordinate', 'admitted'] }).items;
  expect(byId[0]).toMatchObject({
    status: 'available',
    entity: {
      id: 'coordinate',
      type: 'structure',
      namedTypeKey: 'type:file',
      path: 'b.dnaforge-molecular.json',
    },
  });
  expect(byId[1]).toMatchObject({
    status: 'available',
    entity: { id: 'admitted', namedTypeKey: 'type:molecular-document', path: 'c.json' },
  });
});

it('round-trips a managed sequence schema with its frozen name while displaying its current type', () => {
  const { db } = fixture;
  const definition = listLimsEntitySchemasInDb(db).find((row) => row.entityKind === 'sequence');
  if (!definition) throw new Error('Missing managed sequence schema');
  const { schema } = createSequenceEntityMetadataForSchema(definition);
  expect(schema.displayName).toBe('DNA sequence');
  const entity = registerLimsEntityInDb(db, {
    kind: 'sequence',
    name: 'Portable item',
    fields: {},
    schemaRevisionId: schema.schemaRevisionId,
    schemaSnapshot: schema,
  });
  expect(readEntitySchemaSnapshotInDb(db, entity.id)).toEqual(schema);
  expect(resolveEntitiesInDb(db, { ids: [entity.id] }).items).toMatchObject([
    {
      status: 'available',
      entity: { id: entity.id, kindLabel: 'Sequence', namedTypeKey: 'type:sequence' },
    },
  ]);
});

it('reopens a saved notebook link to the same custom Registry identity across archive and restore', async () => {
  const { db } = fixture;
  const snapshot = {
    schemaId: 'custom-label',
    schemaRevisionId: 'custom-label-v1',
    name: 'custom_label',
    displayName: 'Specimen intake',
    description: '',
    baseKind: 'record',
    version: 1,
    fields: [{ key: 'value', label: 'Value', type: 'text' }],
  };
  const target = registerLimsEntityInDb(db, {
    kind: snapshot.name,
    name: 'Intake 1',
    fields: { value: 'A' },
    schemaRevisionId: snapshot.schemaRevisionId,
    schemaSnapshot: snapshot,
  });
  const idsForName = () =>
    searchEntitiesInDb(db, { query: target.name, filter: { namedTypeKey: 'schema:custom-label' } })
      .items;
  expect(idsForName()).toMatchObject([{ id: target.id, kindLabel: snapshot.displayName }]);
  const picked = idsForName()[0];
  const id = 'linked-notebook';
  const documentId = `${owner.repoUuid}::${id}`;
  const title = 'Linked notebook';
  const folder = join(owner.rootPath, title);
  await mkdir(folder);
  const content: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'mention',
            attrs: {
              id: picked.id,
              entityId: picked.id,
              label: picked.name,
              entityType: picked.type,
              occurrenceId: '10000000-0000-4000-8000-000000000001',
            },
          },
        ],
      },
    ],
  };
  await publishNotebookPackageV2InMain({
    packageRoot: folder,
    workspaceRoot: owner.rootPath,
    id,
    title,
    content,
    sourceShape: 'new-package',
  });
  bind(documentId, 'notebook', title, folder, 'waypoint-notebook');
  await replaceNotebookProjectionFromFileInMain(db, {
    pageId: documentId,
    workspaceRoot: owner.rootPath,
    sourcePath: notebookPackagePaths(folder).metaPath,
    sourceFingerprint: notebookProjectionFingerprint(title, content),
    expectedProjectionFingerprint: null,
  });
  db.close();
  const reopened = openFileTestDb(fixture.dbPath);
  try {
    const link = () =>
      reopened
        .prepare('SELECT target_entity_id FROM notebook_reference_occurrences WHERE document_id=?')
        .pluck()
        .get(documentId) as string;
    const resolve = () => resolveEntitiesInDb(reopened, { ids: [link()] }).items[0];
    expect(link()).toBe(target.id);
    expect(resolve()).toMatchObject({
      status: 'available',
      entity: { id: target.id, schemaId: snapshot.schemaId, namedTypeKey: 'schema:custom-label' },
    });
    archiveLimsEntityInDb(reopened, { id: target.id });
    expect(resolve()).toEqual({ id: target.id, status: 'unavailable' });
    restoreLimsEntityInDb(reopened, { id: target.id });
    expect(resolve()).toMatchObject({
      status: 'available',
      entity: { id: target.id, namedTypeKey: 'schema:custom-label' },
    });
    expect(entityDiscoveryTypesInDb(reopened).items).toContainEqual(
      expect.objectContaining({ key: 'schema:custom-label', label: snapshot.displayName, count: 1 })
    );
  } finally {
    reopened.close();
  }
});
