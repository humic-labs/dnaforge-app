import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { withRendererEntitySql } from './renderer-entity-sql';
import { linkCatalogEntitiesInDb } from './catalog-association-commands';
import { MolecularDocumentLibrary } from './molecular-document-library';
import { molecularDocumentAdapter } from '../db/entity-substrate/molecular-document-adapter';
import { molecularDocumentFixture } from '../test/fixtures/molecular-documents';
import {
  MOLECULAR_DOCUMENT_FILE_KIND,
  serializeMolecularDocument,
} from '../shared/molecular-document';
import { registerMolecularDocumentIpcHandlers } from './ipc/molecular-documents';

const transport = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => any>,
  db: undefined as unknown as Database.Database,
}));
vi.mock('electron', () => ({ app: { getPath: vi.fn(), getVersion: () => 'test' } }));
vi.mock('../shared/ipc-contract', () => ({
  defineGroup: (_name: string, methods: unknown) => methods,
  invoke: () => ({}),
  handleGroup: (_contract: unknown, handlers: typeof transport.handlers) => {
    transport.handlers = handlers;
  },
}));
vi.mock('./ipc/database', () => ({ getDb: () => transport.db }));
vi.mock('../platform', () => ({
  platform: () => ({
    db: {
      select: async (sql: string, args: unknown[] = []) => transport.db.prepare(sql).all(...args),
      execute: async (sql: string, args: unknown[] = []) =>
        withRendererEntitySql(transport.db, sql, () => transport.db.prepare(sql).run(...args)),
      linkCatalogEntities: async (input: any) => linkCatalogEntitiesInDb(transport.db, input),
    },
    molecularDocuments: {
      reconcileSourceLinks: (input: unknown, mutationToken?: string) =>
        transport.handlers.reconcileSourceLinks({ sender: { id: 5222 } }, input, mutationToken),
    },
  }),
}));

let fixture: ReturnType<typeof createFileTestDb>;
let document: Awaited<ReturnType<typeof molecularDocumentFixture>>;
let path: string;
let root: string;
let entityId: string;
let original: string;
const context = () => ({ workspaceRoot: root, workspaceId: 7, workspaceScope: 'project-one' });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const links = () => transport.db.prepare('SELECT * FROM catalog_entity_links ORDER BY id').all();
const reconcile = () =>
  molecularDocumentAdapter.reconcileRelationships!(document, entityId, path, context());
const request = () => ({
  path,
  workspaceRoot: root,
  entityId,
  documentHash: digest(serializeMolecularDocument(document)),
});
const command = (input: unknown) =>
  transport.handlers.reconcileSourceLinks({ sender: { id: 5222 } }, input);

beforeEach(async () => {
  fixture = createFileTestDb('molecular-projection');
  transport.db = fixture.db;
  ensureSchema(transport.db, fixture.dbPath);
  root = join(fixture.tmpDir, 'project');
  mkdirSync(root);
  const other = join(fixture.tmpDir, 'other');
  mkdirSync(other);
  transport.db
    .prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(?,?,?,?,1)')
    .run(7, 'Owner', root, 'project-one');
  transport.db
    .prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(?,?,?,?,1)')
    .run(8, 'Other', other, 'project-two');
  document = await molecularDocumentFixture();
  document.history[0].snapshot.source.artifactEntityId = 'source';
  document.history[0].snapshot.source.artifactRevisionId = 'sha256:source-revision';
  document.history[1].snapshot.source.artifactEntityId = 'project-two::foreign';
  original = serializeMolecularDocument(document);
  path = join(root, 'Pocket.dnaforge-molecular.json');
  writeFileSync(path, original);
  entityId = `project-one::${document.id}`;
  for (const [id, owner, type] of [
    [entityId, 7, 'molecular-document'],
    ['project-one::source', 7, 'structure'],
    ['obsolete', 7, 'structure'],
    ['project-two::foreign', 8, 'structure'],
  ] as const) {
    transport.db
      .prepare(
        "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES(?,?,?,?,'file',?,1,1)"
      )
      .run(id, type, id, `entity://${type}/${id}`, owner);
  }
  transport.db
    .prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES('binding',?,7,?,?,'current',1,1)"
    )
    .run(entityId, path, MOLECULAR_DOCUMENT_FILE_KIND);
  transport.db
    .prepare(
      "INSERT INTO catalog_entity_links(id,source_entity_id,target_entity_id,relation,confidence,evidence,created_at,updated_at) VALUES('obsolete-source',?,'obsolete','uses-source','suggested',NULL,1,1)"
    )
    .run(entityId);
  linkCatalogEntitiesInDb(transport.db, {
    sourceEntityId: entityId,
    targetEntityId: 'obsolete',
    relation: 'references',
  });
  linkCatalogEntitiesInDb(transport.db, {
    sourceEntityId: 'obsolete',
    targetEntityId: entityId,
    relation: 'uses-source',
  });
  registerMolecularDocumentIpcHandlers();
});

afterEach(() => {
  if (transport.db.open) transport.db.close();
  fixture.cleanup();
});

describe('molecular document native source projection', () => {
  it('opens a saved document, removes obsolete source links, and reopens exact persisted pins', async () => {
    const opened = await new MolecularDocumentLibrary().read({ path, workspaceRoot: root });
    expect(opened.document).toEqual(document);
    const unrelated = links().filter(
      (row: any) => row.relation === 'references' || row.source_entity_id !== entityId
    );
    await reconcile();
    const first = links();
    expect(
      first.filter((row: any) => row.relation === 'references' || row.source_entity_id !== entityId)
    ).toEqual(unrelated);
    const sources = first.filter(
      (row: any) => row.relation === 'uses-source' && row.source_entity_id === entityId
    ) as any[];
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      target_entity_id: 'project-one::source',
      confidence: 'confirmed',
    });
    expect(JSON.parse(sources[0].evidence)).toEqual({
      documentId: document.id,
      pins: [
        {
          referenceId: document.history[0].referenceId,
          coordinateSha256: document.history[0].snapshot.coordinates.sha256,
          artifactRevisionId: 'sha256:source-revision',
        },
      ],
    });
    await reconcile();
    expect(links()).toEqual(first);
    transport.db.close();
    transport.db = openFileTestDb(fixture.dbPath);
    expect(links()).toEqual(first);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(
      (await new MolecularDocumentLibrary().read({ path, workspaceRoot: root })).revision
    ).toBe(opened.revision);
    expect(() =>
      withRendererEntitySql(transport.db, 'DELETE FROM catalog_entity_links', () =>
        transport.db.exec('DELETE FROM catalog_entity_links')
      )
    ).toThrow('ENTITY_IDENTITY_REQUIRES_NATIVE_COMMAND');
    if (process.env.MOLECULAR_PROJECTION_EVIDENCE) {
      mkdirSync(process.env.MOLECULAR_PROJECTION_EVIDENCE, { recursive: true });
      writeFileSync(
        join(process.env.MOLECULAR_PROJECTION_EVIDENCE, 'source.dnaforge-molecular.json'),
        original
      );
      writeFileSync(
        join(process.env.MOLECULAR_PROJECTION_EVIDENCE, 'projection.json'),
        JSON.stringify(
          {
            sourceSha256: digest(original),
            obsoleteLinksRemoved: true,
            unrelatedLinksRetained: true,
            retryStable: true,
            reopenedLinks: links(),
          },
          null,
          2
        )
      );
    }
  });

  it('rejects cross-project identity, path, binding and changed source without mutation', async () => {
    const before = links();
    await expect(command({ ...request(), entityId: 'project-two::foreign' })).rejects.toThrow();
    await expect(
      command({ ...request(), workspaceRoot: join(fixture.tmpDir, 'other') })
    ).rejects.toThrow();
    await expect(command({ ...request(), documentHash: 'a'.repeat(64) })).rejects.toThrow();
    transport.db
      .prepare('UPDATE catalog_entity_files SET workspace_id=8 WHERE id=?')
      .run('binding');
    await expect(command(request())).rejects.toThrow();
    expect(links()).toEqual(before);
  });

  it.each(['reference', 'archived', 'trashed'])(
    'refuses source changes in a %s project',
    async (state) => {
      if (state === 'reference')
        transport.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
      else
        transport.db
          .prepare(
            `UPDATE workspaces SET ${state === 'archived' ? 'archived_at' : 'trashed_at'}=1 WHERE id=7`
          )
          .run();
      const before = links();
      await expect(reconcile()).rejects.toThrow();
      expect(links()).toEqual(before);
    }
  );

  it('rolls back obsolete-link removal when replacement insertion fails', async () => {
    const before = links();
    transport.db.exec(
      "CREATE TRIGGER reject_new_molecular_link BEFORE INSERT ON catalog_entity_links BEGIN SELECT RAISE(ABORT, 'forced insertion failure'); END"
    );
    await expect(reconcile()).rejects.toThrow('forced insertion failure');
    expect(links()).toEqual(before);
  });
});
