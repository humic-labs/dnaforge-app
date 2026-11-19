import * as scientificReader from './scientific-document-reader';
import { mkdtemp, realpath, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildPrimerArtifact, serializePrimerArtifact } from '../shared/primers/primer-artifact';
import {
  resolveNotebookEntityTargets,
  searchNotebookEntityTargets,
} from './resolve-notebook-entity-targets';
import { createTestDb } from './__tests__/test-db';
import {
  entityDiscoveryTypesInDb,
  resolveEntitiesInDb,
  searchEntitiesInDb,
} from './entity-discovery';
import { getLimsRegistryPreviewInDb } from './lims-registry-projection';
import { ensureSchema } from './schema';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

it('resolves the same type and icon in Registry, catalog, facet and role queries when projections disagree', () => {
  const db = createTestDb();
  try {
    ensureSchema(db, ':memory:');
    db.exec(`
      INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(1,'Project','/project','project',1);
      INSERT INTO lims_schema(id,kind,name,display_name,fields,builtin,created_at,updated_at) VALUES
        ('dna-oligo','entity','oligo','DNA Oligo','[]',1,1,1),
        ('custom','entity','sample_batch','Sample batch','[]',0,1,1);
      INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES
        ('oligo-v1','dna-oligo',1,'[]',1),('custom-v1','custom',1,'[]',1);
      INSERT INTO lims_entity(id,name,kind,schema_id,schema_revision_id,fields,registration_status,created_at,updated_at) VALUES
        ('conflict','Conflicting projection','oligo','dna-oligo','oligo-v1','{"use":"primer"}','tracked',1,1),
        ('custom-id','Frozen schema','sample_batch','dna-oligo','custom-v1','{}','tracked',1,1),
        ('actual-primer','Oligo used as primer','oligo','dna-oligo','oligo-v1','{"use":"primer"}','tracked',1,1);
      INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES
        ('conflict','protein','Conflicting projection','entity://protein/conflict','file',1,1,1),
        ('csv','file','Table','entity://file/csv','file',1,1,1),
        ('txt','file','Misleading suffix','entity://file/txt','file',1,1,1);
      INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at) VALUES
        ('binding1','conflict',1,'/project/protein.json','file',1,1),
        ('binding2','csv',1,'/project/data','csv',1,1),
        ('binding3','txt',1,'/project/data.csv','file',1,1);
    `);
    const rows = searchEntitiesInDb(db, { query: '' }).items;
    expect(
      rows.map(({ id, namedTypeKey, iconKind }) => [id, namedTypeKey, iconKind]).sort()
    ).toEqual([
      ['actual-primer', 'type:oligo', 'primer'],
      ['conflict', 'type:protein', 'protein'],
      ['csv', 'type:table', 'table'],
      ['custom-id', 'schema:custom', 'record'],
      ['txt', 'type:file', 'text'],
    ]);
    expect(resolveEntitiesInDb(db, { ids: rows.map((row) => row.id) }).items).toEqual(
      rows.map((entity) => ({
        id: entity.id,
        status: 'available',
        entity,
      }))
    );
    const facets = entityDiscoveryTypesInDb(db).items;
    for (const row of rows) {
      expect(facets).toContainEqual(
        expect.objectContaining({ key: row.namedTypeKey, iconKind: row.iconKind, count: 1 })
      );
    }
    expect(
      searchEntitiesInDb(db, { query: '', filter: { role: 'primer' } }).items.map((row) => row.id)
    ).toEqual(['actual-primer']);
    expect(facets.find((facet) => facet.key === 'role:primer')?.count).toBe(1);
    expect(
      searchEntitiesInDb(db, { query: '', filter: { category: 'tables' } })
        .items.map((row) => row.id)
        .sort()
    ).toEqual(['csv', 'txt']);
  } finally {
    db.close();
  }
});

it('omits an unopenable Registry detail with the wrong revision kind and preserves independent catalog and document owners', () => {
  const db = createTestDb();
  try {
    ensureSchema(db, ':memory:');
    db.exec(`
      INSERT INTO workspaces(id,name,path,created_at) VALUES(1,'Project','/project',1);
      INSERT INTO lims_schema(id,kind,name,display_name,fields,builtin,created_at,updated_at)
        VALUES('rel','relationship_type','link','Relation','[]',0,1,1);
      INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('rev','rel',1,'[]',1);
      INSERT INTO lims_entity(id,name,kind,schema_id,schema_revision_id,fields,registration_status,created_at,updated_at) VALUES
        ('detail','Unopenable','record','rel','rev','{}','tracked',1,1),
        ('bound','Independent file','record','rel','rev','{}','tracked',1,1),
        ('note','Independent notebook','notebook','rel','rev','{"packageRoot":"test","packagePath":"Notebook","notebookId":"note"}','tracked',1,1);
      INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
        VALUES('bound','protein','Independent file','entity://protein/bound','file',1,1,1);
      INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at)
        VALUES('f','bound',1,'/project/protein.json','file',1,1);
    `);
    expect(() => getLimsRegistryPreviewInDb(db, { entityId: 'detail' })).toThrow(
      'Schema revision rev not found'
    );
    expect(resolveEntitiesInDb(db, { ids: ['detail', 'bound', 'note'] }).items).toEqual([
      { id: 'detail', status: 'unavailable' },
      {
        id: 'bound',
        status: 'available',
        entity: expect.objectContaining({
          namedTypeKey: 'type:protein',
          source: 'project',
          path: 'protein.json',
        }),
      },
      {
        id: 'note',
        status: 'available',
        entity: expect.objectContaining({
          namedTypeKey: 'type:notebook',
          source: 'registry',
          schemaId: null,
        }),
      },
    ]);
  } finally {
    db.close();
  }
});

async function withPrimerInventory(
  run: (
    db: ReturnType<typeof createTestDb>,
    root: string,
    file: string,
    content: string
  ) => Promise<void>
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notebook-primer-link-')));
  const db = createTestDb();
  try {
    ensureSchema(db, ':memory:');
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(1,'Project',?,'project',1)"
    ).run(root);
    const file = join(root, 'one.primer.json');
    const artifact = await buildPrimerArtifact({
      id: 'original',
      name: 'Primer one',
      catalogNumber: 'P0001',
      sequence: 'ACGT',
      workspaceRoot: root,
      artifactPath: file,
    });
    const content = serializePrimerArtifact(artifact);
    await writeFile(file, content);
    db.exec(`
      INSERT INTO lims_schema(id,kind,name,display_name,fields,builtin,created_at,updated_at) VALUES('oligos','entity','oligo','Oligo','[]',1,1,1);
      INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('revision','oligos',1,'[]',1);
      INSERT INTO lims_entity(id,name,kind,schema_id,schema_revision_id,fields,registration_status,workspace_id,created_at,updated_at) VALUES
        ('original','Primer one','oligo','oligos','revision','{"artifact":{"schema":"dnaforge.primer","relativePath":"one.primer.json"},"use":"primer"}','tracked',1,1,1),
        ('database-only','Stored oligo','oligo','oligos','revision','{"use":"primer"}','tracked',1,1,1);
      INSERT INTO primers(id,name,sequence,length,created_at,updated_at) VALUES('original','Primer one','ACGT',4,1,1);
      INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
        VALUES('original','primer','Primer one','entity://primer/original','file',1,1,1);
    `);
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,relative_path,file_kind,status,created_at,updated_at) VALUES('f','original',1,?,'one.primer.json','primer-artifact','current',1,1)"
    ).run(file);
    await run(db, root, file, content);
  } finally {
    vi.restoreAllMocks();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

it('keeps a first page authoritative while unrelated notebook saves continue during native primer verification', async () => {
  await withPrimerInventory(async (db) => {
    db.prepare(
      "INSERT INTO pages(id,title,content,created_at,updated_at) VALUES('unrelated','Notebook','{}',1,1)"
    ).run();
    const originalRead = scientificReader.readScientificDocumentInMain;
    const read = vi
      .spyOn(scientificReader, 'readScientificDocumentInMain')
      .mockImplementation(async (...args) => {
        const result = await originalRead(...args);
        db.prepare("UPDATE pages SET updated_at=updated_at+1 WHERE id='unrelated'").run();
        return result;
      });
    const first = await searchNotebookEntityTargets(db, { query: '', limit: 1 });
    expect(first.items.map((x) => x.id)).toEqual(['original']);
    expect(read).toHaveBeenCalled();
    expect(read.mock.calls.length).toBeLessThanOrEqual(3);
    expect(first.generation).toBe(searchEntitiesInDb(db, { query: '' }).generation);
    const next = await searchNotebookEntityTargets(db, {
      query: '',
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(next.items.map((x) => x.id)).toEqual(['database-only']);
    db.prepare("UPDATE pages SET updated_at=updated_at+1 WHERE id='unrelated'").run();
    await expect(
      searchNotebookEntityTargets(db, { query: '', limit: 1, cursor: first.nextCursor! })
    ).rejects.toThrow('ENTITY_DISCOVERY_REFRESH_REQUIRED');
  });
});

it('restores first-page order when a competing edit changes which entity ranks first and excludes a lost primer', async () => {
  await withPrimerInventory(async (db, _root, file) => {
    const originalRead = scientificReader.readScientificDocumentInMain;
    vi.spyOn(scientificReader, 'readScientificDocumentInMain').mockImplementationOnce(
      async (...args) => {
        const result = await originalRead(...args);
        await rm(file);
        db.prepare(
          "UPDATE lims_entity SET name='A newly ranked oligo' WHERE id='database-only'"
        ).run();
        return result;
      }
    );
    expect(
      (await searchNotebookEntityTargets(db, { query: '', limit: 1 })).items.map((x) => x.id)
    ).toEqual(['database-only']);
    expect((await searchNotebookEntityTargets(db, { query: 'Primer one' })).items).toEqual([]);
  });
});

it('excludes a primer removed during a competing write even when its catalog row and ranking are unchanged', async () => {
  await withPrimerInventory(async (db, _root, file) => {
    const read = scientificReader.readScientificDocumentInMain;
    vi.spyOn(scientificReader, 'readScientificDocumentInMain').mockImplementationOnce(
      async (...args) => {
        const result = await read(...args);
        await rm(file);
        db.prepare('UPDATE workspaces SET created_at=created_at+1 WHERE id=1').run();
        return result;
      }
    );
    const page = await searchNotebookEntityTargets(db, { query: '', limit: 1 });
    expect(page.items.map((x) => x.id)).toEqual(['database-only']);
  });
});

it('refuses a continuation invalidated during verification and bounds restarts for continuously changing ranked results', async () => {
  await withPrimerInventory(async (db) => {
    db.prepare("UPDATE lims_entity SET name='A stored oligo' WHERE id='database-only'").run();
    const first = await searchNotebookEntityTargets(db, { query: '', limit: 1 });
    const org = scientificReader.readScientificDocumentInMain;
    const read = vi
      .spyOn(scientificReader, 'readScientificDocumentInMain')
      .mockImplementation(async (...args) => {
        const result = await org(...args);
        db.prepare("UPDATE catalog_entities SET name=name || '!' WHERE id='original'").run();
        return result;
      });
    await expect(
      searchNotebookEntityTargets(db, { query: '', limit: 1, cursor: first.nextCursor! })
    ).rejects.toThrow('ENTITY_DISCOVERY_REFRESH_REQUIRED');
    read.mockClear();
    await expect(
      searchNotebookEntityTargets(db, { query: 'Primer one', limit: 1 })
    ).rejects.toThrow('ENTITY_DISCOVERY_REFRESH_REQUIRED');
    expect(read).toHaveBeenCalledTimes(3);
  });
});

it('checks the saved primer identity before insertion and never substitutes its Registry or legacy mirror after loss', async () => {
  await withPrimerInventory(async (db, _root, file, content) => {
    const statuses = async () =>
      (await resolveNotebookEntityTargets(db, { ids: ['original', 'database-only'] })).items.map(
        (x) => x.status
      );
    expect(await statuses()).toEqual(['available', 'available']);
    const searchPage = () => searchNotebookEntityTargets(db, { query: '', limit: 1 });
    await rename(file, file + '.moved');
    expect(await statuses()).toEqual(['unavailable', 'available']);
    const availablePage = await searchPage();
    expect(availablePage.items.map((entry) => entry.id)).toEqual(['database-only']);
    expect(availablePage.nextCursor).toBeNull();
    db.prepare("UPDATE catalog_entity_files SET status='missing' WHERE id='f'").run();
    expect(await statuses()).toEqual(['unavailable', 'available']);
    expect(
      searchEntitiesInDb(db, { query: '', filter: { role: 'primer' } }).items.map((x) => x.id)
    ).toEqual(['database-only']);
    expect(entityDiscoveryTypesInDb(db).items.find((x) => x.key === 'role:primer')?.count).toBe(1);
    await writeFile(file, content.replaceAll('"original"', '"different"'));
    db.prepare("UPDATE catalog_entity_files SET status='current' WHERE id='f'").run();
    expect(await statuses()).toEqual(['unavailable', 'available']);
    db.prepare("UPDATE catalog_entity_files SET file_kind='json' WHERE id='f'").run();
    expect(await statuses()).toEqual(['unavailable', 'available']);
    expect((await searchPage()).items.map((entry) => entry.id)).toEqual(['database-only']);
    await rename(file + '.moved', file);
    expect(await statuses()).toEqual(['available', 'available']);
  });
});
