import { beforeEach, describe, expect, it } from 'vitest';

import { getCurrentSequenceFileForDocumentId } from '../db/workspace-catalog';
import { initPlatform } from '../platform';
import { clearMockData, MockDatabaseModule, seedMockData } from './platform-mocks';

describe('browser SQL fixture unsupported operations', () => {
  beforeEach(async () => {
    await initPlatform();
    clearMockData();
  });

  it.each(['owner', 'insert'] as const)(
    'returns SQLite-null project lifecycle fields after %s creation',
    async (route) => {
      const db = await MockDatabaseModule.load('sqlite:waypoint-mock.db');
      const path = '/mock/test/reference-owner';
      if (route === 'owner') await db.ensureWorkspaceOwner(path);
      else await db.execute('INSERT INTO workspaces (path) VALUES (?)', [path]);
      const rows = await db.select<Array<Record<string, unknown>>>(
        'SELECT id,path,repo_uuid,archived_at,trashed_at FROM workspaces WHERE path = ?',
        [path]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ path, repo_uuid: null, archived_at: null, trashed_at: null });
    }
  );

  it('refuses BEGIN/ROLLBACK instead of reporting a successful no-op', async () => {
    const db = await MockDatabaseModule.load('sqlite:waypoint-mock.db');
    await expect(db.execute('BEGIN TRANSACTION')).rejects.toThrow(/refusing transactional SQL/i);
    await expect(db.execute('ROLLBACK')).rejects.toThrow(/refusing transactional SQL/i);
  });

  it('refuses INSERT OR IGNORE instead of treating the first column as the key', async () => {
    const db = await MockDatabaseModule.load('sqlite:waypoint-mock.db');
    seedMockData('message_references', [{ message_id: 'm1', reference_id: 'r1', position: 0 }]);
    await expect(
      db.execute(
        'INSERT OR IGNORE INTO message_references (message_id, reference_id, position) VALUES (?, ?, ?)',
        ['m1', 'r2', 1]
      )
    ).rejects.toThrow(/INSERT OR IGNORE/i);
  });

  it('resolves the production current-sequence selector by logical document ID', async () => {
    seedMockData('catalog_entities', [
      {
        id: 'sequence-a',
        type: 'sequence',
        status: 'active',
      },
      {
        id: 'inactive-sequence',
        type: 'sequence',
        status: 'archived',
      },
      {
        id: 'unrelated-page',
        type: 'page',
        status: 'active',
      },
    ]);
    seedMockData('catalog_entity_files', [
      {
        id: 'file-a',
        entity_id: 'sequence-a',
        path: '/workspace/sequence-a.gb',
        file_kind: 'sequence',
        status: 'current',
        object_uuid: 'object-a',
        updated_at: 1,
      },
      {
        id: 'file-a-historical',
        entity_id: 'sequence-a',
        path: '/workspace/sequence-a-old.gb',
        file_kind: 'sequence',
        status: 'historical',
        object_uuid: 'historical-object-a',
        updated_at: 0,
      },
      {
        id: 'inactive-file',
        entity_id: 'inactive-sequence',
        path: '/workspace/inactive.gb',
        file_kind: 'sequence',
        status: 'current',
        object_uuid: 'inactive-object',
        updated_at: 1,
      },
      {
        id: 'unrelated-file',
        entity_id: 'unrelated-page',
        path: '/workspace/unrelated.md',
        file_kind: 'page',
        status: 'current',
        object_uuid: 'unrelated-object',
        updated_at: 1,
      },
    ]);

    await expect(getCurrentSequenceFileForDocumentId('sequence-a')).resolves.toMatchObject({
      entity_id: 'sequence-a',
      path: '/workspace/sequence-a.gb',
      status: 'current',
    });
    await expect(getCurrentSequenceFileForDocumentId('historical-object-a')).resolves.toMatchObject(
      {
        entity_id: 'sequence-a',
        path: '/workspace/sequence-a.gb',
        status: 'current',
      }
    );
    await expect(getCurrentSequenceFileForDocumentId('inactive-sequence')).resolves.toBeNull();
    await expect(getCurrentSequenceFileForDocumentId('unrelated-page')).resolves.toBeNull();
  });

  it('resolves a cataloged AB1 trace as an openable sequence document', async () => {
    seedMockData('catalog_entities', [{ id: 'trace-a', type: 'trace', status: 'active' }]);
    seedMockData('catalog_entity_files', [
      {
        id: 'file-trace-a',
        entity_id: 'trace-a',
        path: '/workspace/read.ab1',
        file_kind: 'trace',
        status: 'current',
        object_uuid: 'object-trace-a',
        updated_at: 1,
      },
    ]);

    await expect(getCurrentSequenceFileForDocumentId('trace-a')).resolves.toMatchObject({
      entity_id: 'trace-a',
      path: '/workspace/read.ab1',
    });
  });

  it('resolves a manifest-declared loose FASTA file as an openable sequence document', async () => {
    seedMockData('catalog_entities', [
      { id: 'declared-fasta', type: 'file', status: 'active' },
      { id: 'declared-table', type: 'file', status: 'active' },
    ]);
    seedMockData('catalog_entity_files', [
      {
        id: 'file-declared-fasta',
        entity_id: 'declared-fasta',
        path: '/workspace/query.fasta',
        file_kind: 'fasta',
        status: 'current',
        object_uuid: 'object-declared-fasta',
        updated_at: 1,
      },
      {
        id: 'file-declared-table',
        entity_id: 'declared-table',
        path: '/workspace/samples.csv',
        file_kind: 'file',
        status: 'current',
        object_uuid: 'object-declared-table',
        updated_at: 1,
      },
    ]);

    await expect(getCurrentSequenceFileForDocumentId('declared-fasta')).resolves.toMatchObject({
      entity_id: 'declared-fasta',
      path: '/workspace/query.fasta',
    });
    await expect(getCurrentSequenceFileForDocumentId('declared-table')).resolves.toBeNull();
  });
});
