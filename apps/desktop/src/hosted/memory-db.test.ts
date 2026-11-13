// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { createHostedMemoryDb } from './memory-db';
import { userMessage } from '@waypoint/user-messages';

describe('hosted memory db', () => {
  it('updates an owned notebook catalog name from its published file while preserving identity', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const root = `/hosted/${workspaceId}`;
    const source = {
      snapshot: {
        workspaceId,
        revisionId: null,
        revisionNumber: 0,
        files: [
          {
            path: 'Renamed review notes/.forge/notebook.json',
            resourceId: 'notebook-meta',
            contentRevision: 'sha256:fixture',
            contentSha256: 'a'.repeat(64),
            sizeBytes: 10,
            contentType: 'application/json',
          },
        ],
      },
    };
    const db = createHostedMemoryDb(undefined, { getCatalogSource: () => source });
    const entity = await db.registerCatalogEntity({
      id: `${workspaceId}::notebook-a`,
      type: 'notebook',
      name: 'Readable review notes',
      locator: `entity://page/${workspaceId}::notebook-a`,
      storageType: 'database',
      workspaceRoot: root,
    });
    await db.bindCatalogEntityFile({
      entityId: entity.id,
      path: `${root}/Renamed review notes`,
      workspaceRoot: root,
      fileKind: 'waypoint-notebook',
    });
    const renamed = await db.updateCatalogEntityPresentation({
      entityId: entity.id,
      name: 'Renamed review notes',
    });
    expect(renamed).toMatchObject({
      id: entity.id,
      locator: entity.locator,
      workspace_id: entity.workspace_id,
      name: 'Renamed review notes',
    });
    await expect(
      db.updateCatalogEntityPresentation({
        entityId: entity.id,
        name: 'Invented title',
      })
    ).rejects.toThrow(/source/);
    await expect(
      db.updateCatalogEntityPresentation({
        entityId: entity.id,
        metadataPatch: { portableId: 'another-identity' },
      })
    ).rejects.toThrow(/identity/);
    await db.ensureWorkspaceOwner(root, 'reference');
    await expect(
      db.updateCatalogEntityPresentation({
        entityId: entity.id,
        metadataPatch: { description: 'Forbidden edit' },
      })
    ).rejects.toThrow(/read-only/);
    source.snapshot.workspaceId = '22222222-2222-4222-8222-222222222222';
    await expect(
      db.updateCatalogEntityPresentation({
        entityId: entity.id,
        name: 'Renamed review notes',
      })
    ).rejects.toThrow(/active hydrated/);
    expect(await db.select('SELECT name FROM catalog_entities WHERE id = ?', [entity.id])).toEqual([
      { name: 'Renamed review notes' },
    ]);
  });

  it('refreshes an existing UUID project label from the authoritative display name without changing its identity', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const root = `/hosted/${workspaceId}`;
    const source = {
      snapshot: { workspaceId, revisionId: null, revisionNumber: 0, files: [] },
      displayName: 'review fixture',
    };
    const db = createHostedMemoryDb(undefined, { getCatalogSource: () => source });
    await db.execute(
      'INSERT INTO workspaces (id, name, path, repo_uuid, access_mode) VALUES (?, ?, ?, ?, ?)',
      [7, workspaceId, root, workspaceId, 'writable']
    );

    expect(await db.ensureWorkspaceOwner(root)).toBe(7);
    expect(await db.select('SELECT id, name, path, repo_uuid FROM workspaces')).toEqual([
      { id: 7, name: 'review fixture', path: root, repo_uuid: workspaceId },
    ]);

    source.displayName = 'Updated project title';
    expect(await db.ensureWorkspaceOwner(root)).toBe(7);
    expect(await db.select('SELECT name FROM workspaces')).toEqual([
      { name: 'Updated project title' },
    ]);
  });

  it('projects the exact hydrated root folder and records owned links and retry-safe events', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const root = `/hosted/${workspaceId}`;
    let source = {
      snapshot: { workspaceId, revisionId: null, revisionNumber: 0, files: [] },
    };
    const db = createHostedMemoryDb(undefined, { getCatalogSource: () => source });
    const folder = await db.registerWorkspaceFile({
      path: root,
      workspaceRoot: root,
      entityType: 'folder',
      fileKind: 'folder',
    });
    const notebook = await db.registerCatalogEntity({
      id: `${workspaceId}::notebook-a`,
      type: 'notebook',
      name: 'Notes',
      locator: `entity://page/${workspaceId}::notebook-a`,
      storageType: 'database',
      workspaceRoot: root,
    });
    const link = {
      sourceEntityId: notebook.id,
      targetEntityId: folder.id,
      relation: 'created_in',
      confidence: 'confirmed' as const,
      evidence: { source: 'file-explorer-new-menu' },
    };
    expect((await db.linkCatalogEntities(link)).id).toBe((await db.linkCatalogEntities(link)).id);
    const event = {
      id: 'creation-a',
      entityId: notebook.id,
      eventType: 'artifact_created',
      payload: { filePath: `${root}/Notes` },
      createdAt: 1,
    };
    expect(await db.recordCatalogEvent(event)).toEqual(await db.recordCatalogEvent(event));
    await expect(
      db.recordCatalogEvent({ ...event, payload: { filePath: 'different' } })
    ).rejects.toThrow(/different event/);
    await expect(
      db.recordCatalogEvent({
        ...event,
        id: 'protected',
        eventType: 'native.fasta-kind-declaration.v1',
      })
    ).rejects.toThrow(/HISTORY_PROTECTED/);
    await expect(
      db.registerWorkspaceFile({
        path: root,
        workspaceRoot: root,
        entityType: 'sequence',
        fileKind: 'fasta',
      })
    ).rejects.toThrow(/inside/);
    await expect(db.recordCatalogEvent({ ...event, entityId: 'missing' })).rejects.toThrow(
      /does not exist/
    );
    source = {
      snapshot: { ...source.snapshot, workspaceId: '22222222-2222-4222-8222-222222222222' },
    };
    await expect(db.recordCatalogEvent({ ...event, id: 'stale-owner' })).rejects.toThrow(
      /active hydrated/
    );
    await expect(db.linkCatalogEntities(link)).rejects.toThrow(/active hydrated/);
    expect(
      await db.select('SELECT * FROM catalog_entity_events WHERE id = ?', ['stale-owner'])
    ).toEqual([]);
  });

  it('discovers one canonical owner from the hydrated session and preserves its identity on concurrent opens', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const root = `/hosted/${workspaceId}`;
    const source = {
      snapshot: { workspaceId, revisionId: null, revisionNumber: 0, files: [] },
      displayName: 'Accepted project title',
    };
    const db = createHostedMemoryDb(undefined, { getCatalogSource: () => source });
    const owners = await Promise.all([
      db.ensureWorkspaceOwner(root, undefined, { name: 'Caller label', recordOpen: true }),
      db.ensureWorkspaceOwner(root),
    ]);
    expect(owners).toEqual([1, 1]);
    await expect(
      db.select('SELECT id,name,path,repo_uuid,access_mode,last_opened_at FROM workspaces')
    ).resolves.toEqual([
      {
        id: 1,
        name: 'Accepted project title',
        path: root,
        repo_uuid: workspaceId,
        access_mode: 'writable',
        last_opened_at: expect.any(Number),
      },
    ]);
    await expect(db.ensureWorkspaceOwner('/Users/ada/project')).rejects.toThrow(/canonical hosted/);
    await expect(
      db.ensureWorkspaceOwner('/hosted/22222222-2222-4222-8222-222222222222')
    ).rejects.toThrow(/active hydrated/);
    await expect(db.ensureWorkspaceOwner(root + '/nested')).rejects.toThrow(/canonical hosted/);
  });

  it('keeps a reference hosted projection read-only when discovery requests writable access', async () => {
    const root = '/hosted/11111111-1111-4111-8111-111111111111';
    const db = createHostedMemoryDb();
    const id = await db.ensureWorkspaceOwner(root, 'reference');
    await expect(db.ensureWorkspaceOwner(root, 'writable')).rejects.toThrow(
      /cannot acquire write authority/
    );
    expect(await db.ensureWorkspaceOwner(root)).toBe(id);
    await expect(db.select('SELECT access_mode FROM workspaces')).resolves.toEqual([
      { access_mode: 'reference' },
    ]);
  });

  it('projects source-declared files and rejects paths or identities from another hydrated project', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const root = `/hosted/${workspaceId}`;
    const source = {
      snapshot: {
        workspaceId,
        revisionId: null,
        revisionNumber: 0,
        files: [
          {
            path: 'input.fa',
            resourceId: 'resource-a',
            contentRevision: 'sha256:fixture',
            contentSha256: 'a'.repeat(64),
            sizeBytes: 10,
            contentType: 'text/fasta',
          },
        ],
      },
    };
    const db = createHostedMemoryDb(undefined, { getCatalogSource: () => source });
    const input = {
      path: `${root}/input.fa`,
      workspaceRoot: root,
      fileKind: 'fasta',
      entityType: 'sequence' as const,
    };
    const file = await db.registerWorkspaceFile(input);
    expect((await db.registerWorkspaceFile(input)).id).toBe(file.id);
    await expect(
      db.registerWorkspaceFile({ ...input, path: `${root}/missing.fa` })
    ).rejects.toThrow(/absent from its hydrated/);
    await expect(
      db.registerWorkspaceFile({ ...input, path: `${root}/../outside.fa` })
    ).rejects.toThrow(/inside|unsafe/);
    await expect(
      db.bindCatalogEntityFile({
        entityId: file.id,
        path: '/hosted/22222222-2222-4222-8222-222222222222/input.fa',
        workspaceRoot: root,
        fileKind: 'fasta',
      })
    ).rejects.toThrow(/inside/);
    await expect(db.select('SELECT id,workspace_id FROM catalog_entities')).resolves.toEqual([
      { id: file.id, workspace_id: file.workspace_id },
    ]);
  });

  it.each(['IGNORE', 'REPLACE'] as const)(
    'keeps separate project roots with the same name under INSERT OR %s',
    async (mode) => {
      const db = createHostedMemoryDb();
      const sql = `INSERT OR ${mode} INTO workspaces (name, path) VALUES (?, ?)`;
      await db.execute(sql, ['Project', '/hosted/one']);
      await db.execute(sql, ['Project', '/hosted/two']);
      await expect(db.select('SELECT name, path FROM workspaces')).resolves.toEqual([
        { name: 'Project', path: '/hosted/one' },
        { name: 'Project', path: '/hosted/two' },
      ]);
    }
  );

  it('refuses a conflicting project path in an upsert tail before changing its name', async () => {
    const db = createHostedMemoryDb();
    await db.execute('INSERT INTO workspaces (name, path) VALUES (?, ?)', ['One', '/hosted/one']);
    await db.execute('INSERT INTO workspaces (name, path) VALUES (?, ?)', ['Two', '/hosted/two']);
    await expect(
      db.execute(
        'INSERT INTO workspaces (name, path) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET name = ?, path = ?',
        ['Unused', '/hosted/one', 'Partial rename', '/hosted/two']
      )
    ).rejects.toThrow('UNIQUE constraint failed: workspaces.path');
    await expect(db.select('SELECT name, path FROM workspaces')).resolves.toEqual([
      { name: 'One', path: '/hosted/one' },
      { name: 'Two', path: '/hosted/two' },
    ]);
  });

  it('enforces the native unique project path before publishing a duplicate owner', async () => {
    const db = createHostedMemoryDb();
    const sql = 'INSERT INTO workspaces (name, path, access_mode) VALUES (?, ?, ?)';
    await db.execute(sql, ['Original project', '/hosted/project', 'writable']);
    await expect(
      db.execute(sql, ['Duplicate project', '/hosted/project', 'reference'])
    ).rejects.toThrow('UNIQUE constraint failed: workspaces.path');
    await expect(db.select('SELECT name, path, access_mode FROM workspaces')).resolves.toEqual([
      { name: 'Original project', path: '/hosted/project', access_mode: 'writable' },
    ]);
    await expect(
      db.execute('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (NULL, ?, ?)', [
        'Ignored duplicate',
        '/hosted/project',
      ])
    ).resolves.toMatchObject({ changes: 0 });
    await expect(db.select('SELECT path FROM workspaces')).resolves.toEqual([
      { path: '/hosted/project' },
    ]);
  });

  it('validates project path updates before publishing any changed name or path', async () => {
    const db = createHostedMemoryDb();
    await db.execute('INSERT INTO workspaces (name, path) VALUES (?, ?)', ['One', '/hosted/one']);
    await db.execute('INSERT INTO workspaces (name, path) VALUES (?, ?)', ['Two', '/hosted/two']);
    await expect(
      db.execute('UPDATE workspaces SET name = ?, path = ? WHERE path = ?', [
        'Partial rename',
        '/hosted/two',
        '/hosted/one',
      ])
    ).rejects.toThrow('UNIQUE constraint failed: workspaces.path');
    await expect(db.select('SELECT name, path FROM workspaces')).resolves.toEqual([
      { name: 'One', path: '/hosted/one' },
      { name: 'Two', path: '/hosted/two' },
    ]);
    await db.execute('UPDATE workspaces SET path = ? WHERE path = ?', [
      '/hosted/renamed',
      '/hosted/one',
    ]);
    await expect(db.select('SELECT path FROM workspaces')).resolves.toEqual([
      { path: '/hosted/renamed' },
      { path: '/hosted/two' },
    ]);
  });

  it('retains the same path constraint with case-insensitive SQL column names', async () => {
    const db = createHostedMemoryDb();
    await db.execute('INSERT INTO workspaces (NAME, PATH) VALUES (?, ?)', ['One', '/hosted/one']);
    await db.execute('INSERT INTO workspaces (NAME, PATH) VALUES (?, ?)', ['Two', '/hosted/two']);
    await expect(
      db.execute('UPDATE workspaces SET PATH = ? WHERE PATH = ?', ['/hosted/two', '/hosted/one'])
    ).rejects.toThrow('UNIQUE constraint failed: workspaces.path');
    await expect(db.select('SELECT path FROM workspaces')).resolves.toEqual([
      { path: '/hosted/one' },
      { path: '/hosted/two' },
    ]);
  });

  it('binds INSERT parameters only to placeholders and keeps SQL literals in their own columns', async () => {
    const db = createHostedMemoryDb();
    await db.execute(
      "INSERT INTO workspaces (id, name, path, created_at, archived_at, access_mode) VALUES (NULL, ?, ?, ?, NULL, 'writable')",
      ['Shared project', '/hosted/project', 100]
    );
    await expect(db.select('SELECT * FROM workspaces')).resolves.toEqual([
      {
        id: 1,
        name: 'Shared project',
        path: '/hosted/project',
        created_at: 100,
        archived_at: null,
        access_mode: 'writable',
      },
    ]);
  });

  it('starts bound upsert assignments after consumed VALUES parameters, preserving multiple assignments', async () => {
    const db = createHostedMemoryDb();
    const sql =
      "INSERT INTO workspaces (id, name, path, created_at, access_mode) VALUES (NULL, ?, ?, ?, 'writable') ON CONFLICT(path) DO UPDATE SET name = ?, created_at = ?, access_mode = excluded.access_mode";
    await db.execute(sql, ['Original project', '/hosted/project', 100, 'Unused', 0]);
    await db.execute(sql, ['Unpublished name', '/hosted/project', 200, 'Renamed project', 300]);
    await expect(
      db.select('SELECT name, path, created_at, access_mode FROM workspaces')
    ).resolves.toEqual([
      {
        name: 'Renamed project',
        path: '/hosted/project',
        created_at: 300,
        access_mode: 'writable',
      },
    ]);
  });

  it('retains escaped and comma-containing SQL string literals and rejects unsupported expressions before writing', async () => {
    const db = createHostedMemoryDb();
    await db.execute(
      "INSERT INTO workspaces (name, path, created_at) VALUES ('Lab, O''Brien', ?, 100)",
      ['/hosted/project']
    );
    await expect(db.select('SELECT name, path, created_at FROM workspaces')).resolves.toEqual([
      { name: "Lab, O'Brien", path: '/hosted/project', created_at: 100 },
    ]);
    await expect(
      db.execute('INSERT INTO workspaces (name, path) VALUES (unsupported, ?)', ['/hosted/other'])
    ).rejects.toThrow();
    await expect(db.select('SELECT path FROM workspaces')).resolves.toEqual([
      { path: '/hosted/project' },
    ]);
  });

  it.each(['IGNORE', 'REPLACE'] as const)(
    'preserves INSERT OR %s with literal values',
    async (mode) => {
      const db = createHostedMemoryDb();
      const sql = `INSERT OR ${mode} INTO settings (key, value, updated_at) VALUES ('theme', ?, NULL)`;
      await db.execute(sql, ['light']);
      const updated = await db.execute(sql, ['dark']);
      expect(updated.changes).toBe(mode === 'IGNORE' ? 0 : 1);
      await expect(db.select('SELECT key, value, updated_at FROM settings')).resolves.toEqual([
        { key: 'theme', value: mode === 'IGNORE' ? 'light' : 'dark', updated_at: null },
      ]);
    }
  );

  it('refuses unsupported upsert expressions without applying an earlier valid assignment', async () => {
    const db = createHostedMemoryDb();
    await db.execute('INSERT INTO workspaces (name, path) VALUES (?, ?)', [
      'Original',
      '/hosted/project',
    ]);
    await expect(
      db.execute(
        'INSERT INTO workspaces (name, path) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET name = ?, path = unsupported',
        ['Unused', '/hosted/project', 'Partial rename']
      )
    ).rejects.toThrow();
    await expect(db.select('SELECT name, path FROM workspaces')).resolves.toEqual([
      { name: 'Original', path: '/hosted/project' },
    ]);
  });

  it('validates an unused upsert branch before inserting or allocating an automatic ID', async () => {
    const db = createHostedMemoryDb();
    await expect(
      db.execute(
        'INSERT INTO workspaces (name, path) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET name = unsupported',
        ['Rejected project', '/hosted/rejected']
      )
    ).rejects.toThrow();
    await expect(db.select('SELECT * FROM workspaces')).resolves.toEqual([]);
    await db.execute('INSERT INTO workspaces (id, name, path) VALUES (NULL, ?, ?)', [
      'Accepted project',
      '/hosted/accepted',
    ]);
    await expect(db.select('SELECT id, path FROM workspaces')).resolves.toEqual([
      { id: 1, path: '/hosted/accepted' },
    ]);
  });

  it('applies the shared automatic-title guard with the unlocked conversation default', async () => {
    const db = createHostedMemoryDb();
    await db.execute('INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)', [
      'chat-1',
      'New conversation',
      100,
    ]);
    const sql =
      'UPDATE conversations SET title = ? WHERE id = ? AND title = ? AND title_locked = 0';
    await expect(
      db.execute(sql, ['Plasmid biology overview', 'chat-1', 'New conversation'])
    ).resolves.toMatchObject({ changes: 1 });
    await expect(
      db.select('SELECT title, title_locked, updated_at FROM conversations WHERE id = ?', [
        'chat-1',
      ])
    ).resolves.toEqual([{ title: 'Plasmid biology overview', title_locked: 0, updated_at: 100 }]);
    await expect(
      db.execute(sql, ['Late title', 'chat-1', 'New conversation'])
    ).resolves.toMatchObject({ changes: 0 });
  });

  it.each(['Manual title', 'New conversation'])(
    'keeps a manual title locked even when named %s',
    async (title) => {
      const db = createHostedMemoryDb();
      await db.execute('INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)', [
        'chat-1',
        'New conversation',
        100,
      ]);
      await db.execute(
        'UPDATE conversations SET title = ?, title_locked = 1, updated_at = ? WHERE id = ?',
        [title, 200, 'chat-1']
      );
      await expect(
        db.select('SELECT title, title_locked, updated_at FROM conversations WHERE id = ?', [
          'chat-1',
        ])
      ).resolves.toEqual([{ title, title_locked: 1, updated_at: 200 }]);
      await expect(
        db.execute(
          'UPDATE conversations SET title = ? WHERE id = ? AND title = ? AND title_locked = 0',
          ['Late generated title', 'chat-1', 'New conversation']
        )
      ).resolves.toMatchObject({ changes: 0 });
      await expect(
        db.select('SELECT title FROM conversations WHERE id = ?', ['chat-1'])
      ).resolves.toEqual([{ title }]);
    }
  );

  it('stores and reads notebook pages', async () => {
    const db = createHostedMemoryDb();
    await db.execute(
      'INSERT INTO pages (id, title, content, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['page-1', 'Notes', '{}', null, 1, 1]
    );
    await expect(db.select('SELECT title FROM pages WHERE id = ?', ['page-1'])).resolves.toEqual([
      { title: 'Notes' },
    ]);
  });

  it('registers catalog entities with ON CONFLICT DO NOTHING', async () => {
    const db = createHostedMemoryDb();
    const sql = `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(locator) DO NOTHING`;
    await db.execute(sql, [
      'entity-1',
      'notebook',
      'Notes',
      'entity://page/entity-1',
      'database',
      'active',
      1,
      '{}',
      1,
      1,
    ]);
    await db.execute(sql, [
      'entity-2',
      'notebook',
      'Other',
      'entity://page/entity-1',
      'database',
      'active',
      1,
      '{}',
      2,
      2,
    ]);
    await expect(
      db.select('SELECT id, name FROM catalog_entities WHERE locator = ?', [
        'entity://page/entity-1',
      ])
    ).resolves.toEqual([{ id: 'entity-1', name: 'Notes' }]);
  });

  it('assigns workspace ids on insert and reads them back', async () => {
    const db = createHostedMemoryDb();
    const inserted = await db.execute(
      `INSERT INTO workspaces
       (name, path, created_at, last_opened_at, access_mode)
       VALUES (?, ?, ?, ?, ?)`,
      ['Shared project', '/hosted/ws-1', 1, 1, 'read-write']
    );
    expect(inserted.lastInsertRowid).toBe(1);
    await expect(
      db.select('SELECT id, access_mode FROM workspaces WHERE path = ?', ['/hosted/ws-1'])
    ).resolves.toEqual([{ id: 1, access_mode: 'read-write' }]);
    await expect(
      db.select(
        `SELECT id FROM workspaces
      WHERE path = ?
        AND archived_at IS NULL
        AND trashed_at IS NULL
      LIMIT 1`,
        ['/hosted/ws-1']
      )
    ).resolves.toEqual([{ id: 1 }]);
  });

  it('lists pages with ORDER BY and IN filters', async () => {
    const db = createHostedMemoryDb();
    await db.execute(
      'INSERT INTO pages (id, title, content, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['page-1', 'Older', '{}', null, 1, 1]
    );
    await db.execute(
      'INSERT INTO pages (id, title, content, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['page-2', 'Newer', '{}', null, 2, 2]
    );
    await expect(db.select('SELECT id FROM pages ORDER BY updated_at DESC')).resolves.toEqual([
      { id: 'page-2' },
      { id: 'page-1' },
    ]);
    await expect(
      db.select('SELECT id FROM pages WHERE id IN (?, ?)', ['page-2', 'missing'])
    ).resolves.toEqual([{ id: 'page-2' }]);
  });

  it('updates on conflict for sequence identity rows', async () => {
    const db = createHostedMemoryDb();
    const sql = `INSERT INTO sequence_identity
       (document_id, path, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(document_id) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at`;
    await db.execute(sql, ['doc-1', '/a.gbk', 1]);
    await db.execute(sql, ['doc-1', '/b.gbk', 2]);
    await expect(
      db.select('SELECT path, updated_at FROM sequence_identity WHERE document_id = ?', ['doc-1'])
    ).resolves.toEqual([{ path: '/b.gbk', updated_at: 2 }]);
  });

  it('reads drizzle-quoted settings rows', async () => {
    const db = createHostedMemoryDb();
    await db.execute('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [
      'current_workspace_path',
      '/hosted/ws',
      1,
    ]);
    await expect(
      db.select('select "key", "value" from "settings" where "key" = ?', ['current_workspace_path'])
    ).resolves.toEqual([{ key: 'current_workspace_path', value: '/hosted/ws' }]);
  });

  it('projects primer artifacts and serves the library search and page queries', async () => {
    const db = createHostedMemoryDb();
    const projection = (id: string, catalogNumber: string, name: string, createdAt: number) => ({
      id,
      catalogNumber,
      name,
      sequence: 'ACGTACGTACGTACGTAC',
      length: 18,
      tm: 55.1,
      gcPercent: 50,
      origin: 'manual',
      originDetails: { authority: 'primer_artifact', artifactPath: `/hosted/w/primers/${name}` },
      vendor: null,
      modifications: null,
      application: 'pcr',
      notes: null,
      workspaceId: 1,
      createdAt,
      updatedAt: createdAt,
      bindings: [
        {
          id: `${id}-b`,
          sequenceId: 7,
          bindingStart: 3,
          bindingEnd: 21,
          strand: 1 as const,
          source: 'auto',
        },
      ],
    });
    await expect(db.allocatePrimerCatalogNumber(1)).resolves.toBe('P001');
    await db.replacePrimerProjection(projection('p1', 'P001', 'fwd-one', 10));
    await expect(db.allocatePrimerCatalogNumber(1)).resolves.toBe('P002');
    await db.replacePrimerProjection(projection('p2', 'P002', 'rev-two', 20));
    await db.replacePrimerProjection({
      ...projection('p1', 'P001', 'fwd-renamed', 10),
      bindings: [],
    });
    await expect(
      db.select(
        'SELECT * FROM primers WHERE (name LIKE ? OR sequence LIKE ?) AND application = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        ['%RENAMED%', '%zzz%', 'pcr', 10, 0]
      )
    ).resolves.toMatchObject([
      { id: 'p1', name: 'fwd-renamed', catalog_number: 'P001', status: 'designed' },
    ]);
    await expect(
      db.select('SELECT id FROM primers ORDER BY created_at DESC LIMIT ? OFFSET ?', [1, 1])
    ).resolves.toEqual([{ id: 'p1' }]);
    await expect(
      db.select('SELECT id FROM primer_bindings WHERE primer_id = ?', ['p1'])
    ).resolves.toEqual([]);
    await expect(
      db.select('SELECT id FROM primer_bindings WHERE primer_id = ?', ['p2'])
    ).resolves.toEqual([{ id: 'p2-b' }]);
    await expect(db.allocatePrimerCatalogNumber(1)).resolves.toBe('P003');
  });

  it('persists hosted chat turns and commits terminal messages atomically', async () => {
    const db = createHostedMemoryDb();
    const conversationId = 'conversation-1';
    const turnId = 'turn-1';
    await db.execute(
      'INSERT INTO conversations (id, title, workspace_path, pinned, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [conversationId, 'New conversation', null, 0, 'DNAForge AI', 'auto', 1, 1]
    );

    await db.createChatTurnWithUserMessage({
      turn: {
        id: turnId,
        conversation_id: conversationId,
        route_kind: 'hosted',
        host_id: 'dnaforge-hosted-auto',
        provider: null,
        model: null,
        transport: null,
        authority_profile_id: null,
        permission_mode: null,
        route_snapshot_json: '{"kind":"hosted","tier":"auto"}',
        status: 'running',
        terminal_reason: null,
        error: null,
        started_at: 2,
        completed_at: null,
      },
      message: {
        id: 'message-1',
        conversation_id: conversationId,
        turn_id: turnId,
        role: 'user',
        content: 'Explain this plasmid.',
        tool_name: null,
        tool_call_id: null,
        created_at: 2,
      },
    });

    await expect(
      db.select('SELECT status FROM chat_turns WHERE id = ?', [turnId])
    ).resolves.toEqual([{ status: 'running' }]);

    await expect(
      db.commitChatTurnTerminalState({
        turn_id: turnId,
        conversation_id: conversationId,
        status: 'completed',
        terminal_reason: 'Completed',
        error: null,
        completed_at: 3,
        messages: [
          {
            message: {
              id: 'message-2',
              conversation_id: conversationId,
              turn_id: turnId,
              role: 'assistant',
              content: 'It is a circular DNA molecule.',
              tool_name: null,
              tool_call_id: null,
              created_at: 3,
            },
            reference_ids: [],
          },
        ],
      })
    ).resolves.toEqual({ committed: true });

    await expect(
      db.select('SELECT status, terminal_reason FROM chat_turns WHERE id = ?', [turnId])
    ).resolves.toEqual([{ status: 'completed', terminal_reason: 'Completed' }]);
    await expect(
      db.select('SELECT role, content FROM messages WHERE turn_id = ? ORDER BY created_at ASC', [
        turnId,
      ])
    ).resolves.toEqual([
      { role: 'user', content: 'Explain this plasmid.' },
      { role: 'assistant', content: 'It is a circular DNA molecule.' },
    ]);
    await expect(
      db.commitChatTurnTerminalState({
        turn_id: turnId,
        conversation_id: conversationId,
        status: 'completed',
        terminal_reason: 'Completed again',
        error: null,
        completed_at: 4,
        messages: [],
      })
    ).resolves.toEqual({ committed: false });
  });
});

it('retains browser transcript references through typed owners and refuses qualified raw reference writes', async () => {
  const db = createHostedMemoryDb();
  const row = {
    id: 'reference',
    entity_type: 'external',
    display_label: 'External',
    locator: 'https://example.org/record',
    deep_link_params: null,
    data: null,
    source: 'user',
    status: 'created',
    workspace_scope: null,
    workspace_root_path: null,
    created_at: 1,
    updated_at: 1,
  };
  expect(await db.createEntityReference(row)).toEqual(row);
  for (const sql of [
    'UPDATE main.entity_references SET display_label = ? WHERE id = ?',
    'DELETE FROM "entity_references" WHERE id = ?',
  ])
    await expect(db.execute(sql, ['forged', row.id])).rejects.toMatchObject({
      name: 'HostedCapabilityError',
      diagnosticCapability: 'db.reference-authority.native-command',
      message: userMessage('hosted.unavailable'),
    });
  expect(
    await db.select('SELECT display_label FROM entity_references WHERE id = ?', [row.id])
  ).toEqual([{ display_label: 'External' }]);
});
