import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { searchEntitiesInDb, resolveEntitiesInDb } from './entity-discovery';
import { ensureSchema } from './schema';
import type { EntityDiscoveryRequest } from '../shared/entity-discovery';
import {
  entityDiscoveryPageSchema,
  entityDiscoveryResolutionSchema,
} from '../shared/entity-discovery-schema';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

let fixture: ReturnType<typeof createFileTestDb>;
let db: Database.Database;

beforeEach(() => {
  fixture = createFileTestDb('entity-discovery');
  db = fixture.db;
  ensureSchema(db, fixture.dbPath);
  db.exec(`
    INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(1,'Alpha','/fixtures/alpha','repo-a',1),(2,'Beta','/fixtures/beta','repo-b',1);
    INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema-a','entity','fixture-a','Fixture A','[]','schema-a-v1',1,1),('schema-b','entity','fixture-b','Fixture B','[]','schema-b-v1',1,1);
    INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-a-v1','schema-a',1,'[]',1),('schema-b-v1','schema-b',1,'[]',1);
  `);
});
afterEach(() => fixture.cleanup());

function catalog(id: string, name = id, workspace = 1, type = 'sequence') {
  const root = workspace === 1 ? '/fixtures/alpha' : '/fixtures/beta';
  db.prepare(
    'INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)'
  ).run(id, type, name, `entity://fixture/${id}`, 'file', workspace);
  db.prepare(
    'INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,relative_path,file_kind,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1)'
  ).run(
    `file-${id}`,
    id,
    workspace,
    `${root}/${id.replaceAll(':', '_')}`,
    id.replaceAll(':', '_'),
    type === 'sequence' ? 'waypoint-sequence' : type === 'notebook' ? 'waypoint-notebook' : 'file',
    'current'
  );
}
function registry(
  id: string,
  name = id,
  schema = 'schema-a',
  workspace: number | null = null,
  kind = 'strain'
) {
  db.prepare(
    'INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,registration_status,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1)'
  ).run(id, kind, schema, `${schema}-v1`, name, '{}', 'tracked', workspace);
}
function all(input: EntityDiscoveryRequest) {
  const results = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = searchEntitiesInDb(db, { ...input, cursor });
    entityDiscoveryPageSchema.parse(page);
    results.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      expect(cursors.size).toBeLessThan(100);
    }
  } while (cursor);
  return results;
}

describe('shared entity discovery against real SQLite', () => {
  it('enumerates the complete catalog and Registry beyond the old per-provider caps', () => {
    db.transaction(() => {
      for (let n = 0; n < 137; n++)
        catalog(`sequence-${String(n).padStart(3, '0')}`, `Sequence ${n}`);
      for (let n = 0; n < 113; n++)
        registry(`registry-${String(n).padStart(3, '0')}`, `Record ${n}`);
    })();
    const result = all({ query: '', limit: 17 });
    expect(result).toHaveLength(250);
    expect(new Set(result.map((entity) => entity.id)).size).toBe(250);
    expect(result.map((entity) => entity.id)).toEqual(
      all({ query: '', limit: 29 }).map((entity) => entity.id)
    );
    expect(all({ query: 'Sequence 136', limit: 1 }).map((entity) => entity.id)).toEqual([
      'sequence-136',
    ]);
    expect(all({ query: 'Record 112', limit: 1 }).map((entity) => entity.id)).toEqual([
      'registry-112',
    ]);
  });

  it('keeps different project identities with the same local suffix and deduplicates only exact IDs', () => {
    catalog('repo-a::same', 'Repeated notebook', 1, 'notebook');
    registry('repo-a::same', 'Repeated notebook', 'schema-a', 1, 'notebook');
    registry('repo-b::same', 'Repeated notebook', 'schema-a', 2, 'notebook');
    expect(
      all({ query: 'Repeated notebook', limit: 1 })
        .map((entity) => entity.id)
        .sort()
    ).toEqual(['repo-a::same', 'repo-b::same']);
  });

  it('treats Unicode names and SQL wildcard characters as literal search text', () => {
    catalog('unicode', 'Δοκιμή café 🧬');
    catalog('literal', 'Sample 100%_complete');
    catalog('other', 'Sample 100ABcomplete');
    expect(all({ query: 'ΔΟΚΙΜΉ CAFÉ 🧬' }).map((entity) => entity.id)).toEqual(['unicode']);
    expect(all({ query: '100%_' }).map((entity) => entity.id)).toEqual(['literal']);
    expect(all({ query: 'unmatched' })).toEqual([]);
  });

  it('applies schema identity and exact project scope, even when kinds and names are equal', () => {
    registry('a', 'Same strain', 'schema-a');
    registry('b', 'Same strain', 'schema-b');
    expect(
      all({ query: 'Same strain', filter: { schemaId: 'schema-a' } }).map((entity) => entity.id)
    ).toEqual(['a']);
    catalog('one', 'Same sequence', 1);
    catalog('two', 'Same sequence', 2);
    expect(
      all({ query: 'Same sequence', scope: { projectId: 'repo-b' } }).map((entity) => entity.id)
    ).toEqual(['two']);
  });

  it('does not broaden a filter or scope when continuing another request', () => {
    catalog('a');
    catalog('b');
    catalog('c');
    const first = searchEntitiesInDb(db, { query: '', limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    for (const changed of [
      { query: 'a' },
      { scope: { projectId: 'repo-b' } },
      { filter: { category: 'notebooks' as const } },
    ]) {
      expect(() =>
        searchEntitiesInDb(db, { query: '', limit: 1, ...changed, cursor: first.nextCursor! })
      ).toThrow();
    }
    expect(() => searchEntitiesInDb(db, { query: '', cursor: 'malformed' })).toThrow();
  });

  it.each(['rename', 'delete', 'external-write'] as const)(
    'requires an explicit refresh after %s changes, including unchanged timestamps',
    (mutation) => {
      catalog('a');
      catalog('b');
      catalog('c');
      const first = searchEntitiesInDb(db, { query: '', limit: 1 });
      if (mutation === 'rename')
        db.prepare('UPDATE catalog_entities SET name=? WHERE id=?').run('renamed', 'c');
      if (mutation === 'delete') db.prepare('DELETE FROM catalog_entities WHERE id=?').run('c');
      if (mutation === 'external-write') {
        const external = openFileTestDb(fixture.dbPath);
        try {
          external.prepare('UPDATE catalog_entities SET name=? WHERE id=?').run('external', 'c');
        } finally {
          external.close();
        }
      }
      expect(() =>
        searchEntitiesInDb(db, { query: '', limit: 1, cursor: first.nextCursor! })
      ).toThrow();
      expect(searchEntitiesInDb(db, { query: '', limit: 1 }).generation).not.toBe(first.generation);
    }
  );

  it('resolves exact identities and reports unavailable targets without choosing a same-named replacement', () => {
    catalog('a', 'Duplicate');
    catalog('b', 'Duplicate', 2);
    db.prepare('UPDATE catalog_entities SET status=? WHERE id=?').run('archived', 'a');
    const resolved = resolveEntitiesInDb(db, { ids: ['a', 'b', 'missing'] });
    entityDiscoveryResolutionSchema.parse(resolved);
    expect(resolved.items).toEqual([
      { id: 'a', status: 'unavailable' },
      {
        id: 'b',
        status: 'available',
        entity: expect.objectContaining({ id: 'b', name: 'Duplicate' }),
      },
      { id: 'missing', status: 'unavailable' },
    ]);
  });

  it('queries without writing, seeding or rebuilding a search projection', () => {
    catalog('a');
    registry('b');
    const before = db.prepare('SELECT total_changes() AS n').get();
    db.pragma('query_only = ON');
    expect(all({ query: '', limit: 1 })).toHaveLength(2);
    expect(resolveEntitiesInDb(db, { ids: ['a', 'b'] }).items).toHaveLength(2);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
});
