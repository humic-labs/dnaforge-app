import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import {
  entityDiscoveryTypesInDb,
  resolveEntitiesInDb,
  searchEntitiesInDb,
} from './entity-discovery';
import type { EntityDiscoveryRequest, EntityDiscoveryScope } from '../shared/entity-discovery';
import {
  entityDiscoveryPageSchema,
  entityDiscoveryRequestSchema,
  entityDiscoveryTypesSchema,
} from '../shared/entity-discovery-schema';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.exec(`
    INSERT INTO workspaces(id,name,path,repo_uuid,created_at)
    VALUES(1,'Alpha','/fixtures/alpha','repo-a',1),(2,'Beta','/fixtures/beta','repo-b',1);
  `);
});
afterEach(() => db.close());

function schema(id: string, name: string, label: string, builtin = false) {
  db.prepare(
    'INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,builtin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1)'
  ).run(id, 'entity', name, label, '[]', `${id}-v1`, Number(builtin));
  db.prepare(
    'INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES(?,?,1,?,1)'
  ).run(`${id}-v1`, id, '[]');
}

function catalog(id: string, type: string, workspace = 1, fileKind = type, path = `${id}.json`) {
  const root = workspace === 1 ? '/fixtures/alpha' : '/fixtures/beta';
  db.prepare(
    'INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)'
  ).run(id, type, id, `entity://fixture/${id}`, 'file', workspace);
  db.prepare(
    'INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,relative_path,file_kind,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1)'
  ).run(`file-${id}`, id, workspace, `${root}/${path}`, path, fileKind, 'current');
}

function registry(
  id: string,
  kind: string,
  schemaId: string,
  workspace: number | null = null,
  fields: Record<string, unknown> = {}
) {
  db.prepare(
    'INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,registration_status,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1)'
  ).run(id, kind, schemaId, `${schemaId}-v1`, id, JSON.stringify(fields), 'tracked', workspace);
}

function all(input: EntityDiscoveryRequest) {
  const items = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = searchEntitiesInDb(db, { limit: 1, ...input, cursor });
    entityDiscoveryPageSchema.parse(page);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      expect(cursors.size).toBeLessThan(30);
    }
  } while (cursor);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  return items;
}

function named(key: string, scope?: EntityDiscoveryScope) {
  return all({ query: '', filter: { namedTypeKey: key }, scope });
}

function expectCounts(scope?: EntityDiscoveryScope) {
  const result = entityDiscoveryTypesInDb(db, { scope });
  entityDiscoveryTypesSchema.parse(result);
  const typedIds = [];
  for (const facet of result.items) {
    expect(facet.count).toBeGreaterThan(0);
    expect(facet).not.toHaveProperty('source');
    const ids = all({ query: '', filter: facet.filter, scope }).map((item) => item.id);
    expect(ids).toHaveLength(facet.count);
    if (facet.kind === 'type') {
      expect(facet.filter).toEqual({ namedTypeKey: facet.key });
      typedIds.push(...ids);
    } else expect(facet.kind).toBe('shortcut');
  }
  expect(typedIds.sort()).toEqual(
    all({ query: '', scope })
      .map((item) => item.id)
      .sort()
  );
  return result.items;
}

it('accepts exact named-type keys at the transport boundary and rejects unknown properties', () => {
  const request = { query: '', filter: { namedTypeKey: 'schema:custom-a' } };
  expect(entityDiscoveryRequestSchema.parse(request)).toEqual(request);
  expect(() =>
    entityDiscoveryRequestSchema.parse({ query: '', filter: { namedTypeKey: 12 } })
  ).toThrow();
  expect(() =>
    entityDiscoveryRequestSchema.parse({
      query: '',
      filter: { namedTypeKey: 'type:file', typo: 1 },
    })
  ).toThrow();
});

it('preserves catalog molecule metadata and registry oligo kind through native search and resolution', () => {
  catalog('sequence-a', 'sequence', 1, 'sequence', 'sequence-a.gb');
  db.prepare('UPDATE catalog_entities SET metadata=? WHERE id=?').run(
    JSON.stringify({ classificationDecision: { molecule: 'rna' } }),
    'sequence-a'
  );
  schema('builtin-rna', 'rna_oligo', 'RNA Oligo', true);
  catalog('oligo-a', 'primer', 1, 'primer-artifact', 'oligo-a.primer.json');
  registry('oligo-a', 'rna_oligo', 'builtin-rna', 1);
  schema('custom-rna', 'rna_sequence', 'Customer RNA');
  registry('custom-rna-a', 'sequence', 'custom-rna', 1);
  expect(
    entityDiscoveryTypesSchema
      .parse(entityDiscoveryTypesInDb(db))
      .items.find((item) => item.key === 'schema:custom-rna')
  ).toMatchObject({ iconContext: { kind: 'rna_sequence' } });
  const expected = [
    {
      id: 'oligo-a',
      namedTypeKey: 'type:rna_oligo',
      iconKind: 'primer',
      iconContext: { kind: 'rna_oligo', path: 'oligo-a.primer.json' },
    },
    {
      id: 'sequence-a',
      namedTypeKey: 'type:sequence',
      iconKind: 'sequence',
      iconContext: { molecule: 'rna', path: 'sequence-a.gb' },
    },
  ];
  const found = all({ query: '' }).filter((item) =>
    expected.some((entity) => entity.id === item.id)
  );
  const resolved = resolveEntitiesInDb(db, { ids: expected.map((item) => item.id) }).items.flatMap(
    (item) => (item.status === 'available' ? [item.entity] : [])
  );
  for (const items of [found, resolved]) {
    expect(items).toHaveLength(expected.length);
    for (const entity of expected)
      expect(items.find((item) => item.id === entity.id)).toMatchObject(entity);
  }
});

it('counts each notebook identity once across catalog, Registry and built-in schema representations', () => {
  schema('builtin-notebook', 'notebook', 'Notebook', true);
  catalog('shared-notebook', 'notebook', 1, 'waypoint-notebook');
  registry('shared-notebook', 'notebook', 'builtin-notebook', 1);
  registry('registry-notebook', 'notebook', 'builtin-notebook', 2);
  catalog('catalog-notebook', 'notebook', 2, 'waypoint-notebook');
  const facets = expectCounts();
  expect(facets).toEqual([
    expect.objectContaining({ key: 'type:notebook', kind: 'type', count: 3 }),
  ]);
  expect(
    named('type:notebook')
      .map((item) => item.id)
      .sort()
  ).toEqual(['catalog-notebook', 'registry-notebook', 'shared-notebook']);
  expect(named('schema:builtin-notebook')).toEqual([]);
});

it('preserves custom schema identity and display names even when names and entity kinds match', () => {
  schema('custom-a', 'specimen-a', 'Specimens');
  schema('custom-b', 'specimen-b', 'Specimens');
  schema('empty-custom', 'empty-specimen', 'Empty specimens');
  registry('custom-a-entity', 'sequence', 'custom-a', 1);
  catalog('custom-a-entity', 'sequence');
  registry('custom-b-entity', 'sequence', 'custom-b', 2);
  expect(expectCounts()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: 'schema:custom-a',
        label: 'Specimens',
        kind: 'type',
        count: 1,
      }),
      expect.objectContaining({
        key: 'schema:custom-b',
        label: 'Specimens',
        kind: 'type',
        count: 1,
      }),
    ])
  );
  expect(entityDiscoveryTypesInDb(db).items).toHaveLength(2);
  expect(named('schema:custom-a').map((item) => item.id)).toEqual(['custom-a-entity']);
  expect(named('schema:custom-b').map((item) => item.id)).toEqual(['custom-b-entity']);
  expect(named('type:sequence')).toEqual([]);
  expect(named('schema:custom')).toEqual([]);
});

it('keeps Molecular documents and Protein distinct while presenting a raw structure as File without retargeting it', () => {
  catalog('molecular-document', 'molecular-document', 1, 'dnaforge-molecular-document');
  catalog('raw-structure', 'structure', 1, 'structure', 'structures/public-example.cif');
  catalog('protein', 'protein');
  const facets = expectCounts();
  expect(facets).toHaveLength(3);
  expect(facets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: 'type:molecular-document', label: 'Molecular documents' }),
      expect.objectContaining({ key: 'type:file' }),
      expect.objectContaining({ key: 'type:protein' }),
    ])
  );
  expect(named('type:molecular-document').map((item) => item.id)).toEqual(['molecular-document']);
  expect(named('type:protein').map((item) => item.id)).toEqual(['protein']);
  const [raw] = named('type:file');
  expect(raw).toMatchObject({
    id: 'raw-structure',
    type: 'structure',
    source: 'project',
    path: 'structures/public-example.cif',
    projectId: 'repo-a',
    kindLabel: 'File',
  });
  expect(resolveEntitiesInDb(db, { ids: ['raw-structure'] }).items).toEqual([
    { id: 'raw-structure', status: 'available', entity: raw },
  ]);
});

it('keeps primer use as a shortcut and excludes probe and guide oligos while retaining standalone primers', () => {
  schema('builtin-oligo', 'oligo', 'DNA oligo', true);
  for (const use of ['primer', 'probe', 'guide']) {
    catalog(`oligo-${use}`, 'primer');
    registry(`oligo-${use}`, 'oligo', 'builtin-oligo', 1, { use });
  }
  db.prepare(
    'INSERT INTO primers(id,name,sequence,length,created_at,updated_at) VALUES(?,?,?,?,1,1)'
  ).run('legacy-primer', 'Legacy primer', 'ATGC', 4);
  expect(
    all({ query: '', filter: { role: 'primer' } })
      .map((item) => item.id)
      .sort()
  ).toEqual(['legacy-primer', 'oligo-primer']);
  const facets = expectCounts();
  expect(facets.find((facet) => facet.key === 'role:primer')).toMatchObject({
    kind: 'shortcut',
    filter: { role: 'primer' },
    count: 2,
  });
  expect(
    named('type:oligo')
      .map((item) => item.id)
      .sort()
  ).toEqual(['oligo-guide', 'oligo-primer', 'oligo-probe']);
  expect(named('type:primer').map((item) => item.id)).toEqual(['legacy-primer']);
});

it('exposes only populated types and keeps facet counts equal to paginated scoped and archived searches', () => {
  expect(entityDiscoveryTypesInDb(db).items).toEqual([]);
  catalog('alpha-note', 'notebook');
  catalog('beta-note', 'notebook', 2);
  catalog('alpha-archived', 'notebook');
  catalog('beta-file', 'file', 2);
  db.prepare("UPDATE catalog_entities SET status='archived' WHERE id=?").run('alpha-archived');
  expect(expectCounts({ projectId: 'repo-a' })).toEqual([
    expect.objectContaining({ key: 'type:notebook', count: 1 }),
  ]);
  expect(expectCounts({ projectId: 'repo-a', includeArchived: true })).toEqual([
    expect.objectContaining({ key: 'type:notebook', count: 2 }),
  ]);
  expect(expectCounts({ projectRoot: '/fixtures/beta/' })).toHaveLength(2);
  expect(named('type:notebook', { projectId: 'repo-a' }).map((item) => item.id)).toEqual([
    'alpha-note',
  ]);
  expectCounts();
});

it('binds continuation to the exact named type, scope and archive choice and requires refresh after inventory changes', () => {
  for (const id of ['a', 'b', 'c']) catalog(id, 'notebook');
  const request = { query: '', filter: { namedTypeKey: 'type:notebook' }, limit: 1 };
  const first = searchEntitiesInDb(db, request);
  expect(first.nextCursor).toBeTruthy();
  expect(searchEntitiesInDb(db, { ...request, cursor: first.nextCursor! }).items[0].id).toBe('b');
  for (const changed of [
    { filter: { namedTypeKey: 'type:file' } },
    { scope: { projectId: 'repo-b' } },
    { scope: { includeArchived: true } },
  ]) {
    expect(() =>
      searchEntitiesInDb(db, { ...request, ...changed, cursor: first.nextCursor! })
    ).toThrow('ENTITY_DISCOVERY_CURSOR_INVALID');
  }
  db.prepare('UPDATE catalog_entities SET name=? WHERE id=?').run('renamed', 'c');
  expect(() => searchEntitiesInDb(db, { ...request, cursor: first.nextCursor! })).toThrow(
    'ENTITY_DISCOVERY_REFRESH_REQUIRED'
  );
});

it('retains category, entity-type and schema filters without writing to the database', () => {
  schema('builtin-notebook', 'notebook', 'Notebook', true);
  catalog('shared-notebook', 'notebook');
  registry('shared-notebook', 'notebook', 'builtin-notebook', 1);
  registry('registry-notebook', 'notebook', 'builtin-notebook', 2);
  catalog('file', 'file');
  const before = db.prepare('SELECT total_changes() AS n').get();
  db.pragma('query_only = ON');
  expect(
    all({ query: '', filter: { category: 'notebooks' } })
      .map((item) => item.id)
      .sort()
  ).toEqual(['registry-notebook', 'shared-notebook']);
  expect(all({ query: '', filter: { entityTypes: ['notebook'] } }).map((item) => item.id)).toEqual([
    'shared-notebook',
  ]);
  expect(all({ query: '', filter: { schemaId: 'builtin-notebook' } })).toHaveLength(2);
  entityDiscoveryTypesInDb(db);
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});
