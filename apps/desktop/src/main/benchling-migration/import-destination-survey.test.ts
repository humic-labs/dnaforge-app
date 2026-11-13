import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTestDb } from '../__tests__/test-db';
import { openFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import {
  importableProviderStableIdsInArchiveEntryPaths,
  eligibleImportDestinations,
  providerReferencesInArchiveEntryPaths,
  providerStableIdsInArchiveEntryPaths,
  rankWorkspacesByProviderOverlap,
  surveyImportDestinations,
} from './import-destination-survey';

describe('schema-less registry destination review', () => {
  it('surveys a CSV-only ZIP without inventing provider IDs or collapsing column headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-table-survey-'));
    const db = openFileTestDb(join(root, 'database.sqlite'));
    try {
      ensureSchema(db, join(root, 'database.sqlite'));
      const zip = buildSyntheticNativeExportZip([
        {
          path: 'Registry/Records.csv',
          bytes: 'Name,Amount,Amount,\nSame name,0,12.5,α\nSame name,1,2,β\n',
        },
      ]);
      const archivePath = join(root, 'records.zip');
      await writeFile(archivePath, zip.bytes);
      const survey = await surveyImportDestinations({
        archivePath,
        globalDb: db,
        managedRootDir: root,
      });
      expect(survey.archiveObjectCount).toBe(0);
      expect(survey.registryTables).toEqual([
        expect.objectContaining({
          entryPath: 'Registry/Records.csv',
          archiveSha256: zip.sha256.replace(/^sha256:/u, ''),
          entrySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          headersSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          headers: ['Name', 'Amount', 'Amount', ''],
          rowCount: 2,
          previewRows: [
            ['Same name', '0', '12.5', 'α'],
            ['Same name', '1', '2', 'β'],
          ],
        }),
      ]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 0 });
      expect(new Uint8Array(await readFile(archivePath))).toEqual(zip.bytes);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('provider stable IDs in archive entry paths', () => {
  it('stops a legacy export before destination selection when it has no Benchling identities', () => {
    expect(() =>
      importableProviderStableIdsInArchiveEntryPaths([
        'pGEM-ZQX-Sundew integrator.gb',
        'Duplicate display name.gb',
      ])
    ).toThrow(/does not include Benchling object IDs/iu);
  });

  it('reads the identity Benchling writes into the filename', () => {
    const found = providerStableIdsInArchiveEntryPaths([
      'Sundew localization/Controlled Corpus A (etr_DemoEtr001).html',
      'Sundew localization/pDEMO731 (seq_DemoSeq3).gb',
    ]);
    expect([...found].sort()).toEqual(['etr_DemoEtr001', 'seq_DemoSeq3']);
  });

  it('keeps the provider and object class in the archive identity', () => {
    expect(providerReferencesInArchiveEntryPaths(['a/Sequence (seq_DemoSeq004).gb'])).toEqual(
      new Map([
        [
          'benchling\u0000seq_DemoSeq004\u0000sequence',
          {
            provider: 'benchling',
            stableObjectId: 'seq_DemoSeq004',
            objectClass: 'sequence',
          },
        ],
      ])
    );
  });

  it('counts one identity once however many files carry it', () => {
    const found = providerStableIdsInArchiveEntryPaths([
      'a/Corpus Sequence (seq_DemoSeq004).gb',
      'a/Corpus Sequence (seq_DemoSeq004).txt',
      'b/Corpus Sequence (seq_DemoSeq004).gb',
    ]);
    expect(found.size).toBe(1);
  });

  it('refuses containers, which name folders rather than objects', () => {
    const found = providerStableIdsInArchiveEntryPaths([
      'x/Sundew localization (lib_DemoLib2).html',
      'x/Some folder (fld_ABCDEFGH).html',
      'x/Some source (src_ABCDEFGH).html',
    ]);
    expect([...found]).toEqual([]);
  });

  it('refuses tokens that only look like identities', () => {
    const found = providerStableIdsInArchiveEntryPaths([
      'x/Plasmid map (copy).gb',
      'x/Result (2024-04-17).html',
      'x/Digest (seq_1).gb',
      'x/notes (final).txt',
      'x/no parentheses at all.gb',
    ]);
    expect([...found]).toEqual([]);
  });
});

describe('ranking workspaces by provider overlap', () => {
  function db() {
    const database = createTestDb();
    database.exec(`
      CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        repo_uuid TEXT UNIQUE,
        archived_at INTEGER,
        trashed_at INTEGER
      );
      CREATE TABLE catalog_entities (
        id TEXT PRIMARY KEY,
        workspace_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE catalog_provider_bindings (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        stable_object_id TEXT NOT NULL,
        object_class TEXT NOT NULL,
        entity_id TEXT NOT NULL
      );
    `);
    return database;
  }

  function seed(
    database: ReturnType<typeof createTestDb>,
    workspace: { id: number; name: string; archived?: boolean; trashed?: boolean },
    stableIds: readonly string[]
  ) {
    database
      .prepare(
        'INSERT INTO workspaces (id, name, path, repo_uuid, archived_at, trashed_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        workspace.id,
        workspace.name,
        `/tmp/ws-${workspace.id}`,
        `uuid-${workspace.id}`,
        workspace.archived ? 1 : null,
        workspace.trashed ? 1 : null
      );
    for (const stableId of stableIds) {
      const entityId = `${workspace.id}::${stableId}`;
      database
        .prepare('INSERT INTO catalog_entities (id, workspace_id) VALUES (?, ?)')
        .run(entityId, workspace.id);
      database
        .prepare(
          'INSERT INTO catalog_provider_bindings (id, provider, stable_object_id, object_class, entity_id) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          `${entityId}::binding`,
          'benchling',
          stableId,
          stableId.startsWith('seq_') ? 'sequence' : 'notebook',
          entityId
        );
    }
  }

  it('puts the workspace that already holds the most of them first', () => {
    const database = db();
    seed(database, { id: 1, name: 'Sundew localization' }, [
      'seq_AAAAAA',
      'seq_BBBBBB',
      'etr_CCCCCC',
    ]);
    seed(database, { id: 2, name: 'DNAForge Samples' }, ['seq_AAAAAA']);
    const ranked = rankWorkspacesByProviderOverlap(
      database,
      providerReferencesInArchiveEntryPaths([
        'A (seq_AAAAAA).gb',
        'B (seq_BBBBBB).gb',
        'C (etr_CCCCCC).html',
        'New (seq_NNNNNN).gb',
      ])
    );
    expect(ranked.map((row) => [row.workspaceName, row.overlapCount])).toEqual([
      ['Sundew localization', 3],
      ['DNAForge Samples', 1],
    ]);
    database.close();
  });

  it('ignores archived and trashed workspaces, which cannot answer a reference', () => {
    const database = db();
    seed(database, { id: 1, name: 'Archived', archived: true }, ['seq_AAAAAA']);
    seed(database, { id: 2, name: 'Trashed', trashed: true }, ['seq_AAAAAA']);
    seed(database, { id: 3, name: 'Live' }, ['seq_AAAAAA']);
    const ranked = rankWorkspacesByProviderOverlap(
      database,
      providerReferencesInArchiveEntryPaths(['A (seq_AAAAAA).gb'])
    );
    expect(ranked.map((row) => row.workspaceName)).toEqual(['Live']);
    database.close();
  });

  it('ignores entities that are not active, which resolution would not answer from', () => {
    const database = db();
    seed(database, { id: 1, name: 'Has it, but archived' }, ['seq_AAAAAA']);
    database
      .prepare("UPDATE catalog_entities SET status = 'archived' WHERE workspace_id = 1")
      .run();
    seed(database, { id: 2, name: 'Really has it' }, ['seq_AAAAAA']);
    const ranked = rankWorkspacesByProviderOverlap(
      database,
      providerReferencesInArchiveEntryPaths(['A (seq_AAAAAA).gb'])
    );
    expect(ranked.map((row) => [row.workspaceName, row.overlapCount])).toEqual([
      ['Really has it', 1],
      ['Has it, but archived', 0],
    ]);
    database.close();
  });

  it('keeps a live destination visible when nothing overlaps', () => {
    const database = db();
    seed(database, { id: 1, name: 'Unrelated' }, ['seq_OTHER']);
    expect(
      rankWorkspacesByProviderOverlap(
        database,
        providerReferencesInArchiveEntryPaths(['A (seq_AAAAAA).gb'])
      )
    ).toEqual([
      {
        workspaceDbId: 1,
        workspaceName: 'Unrelated',
        workspacePath: '/tmp/ws-1',
        repoUuid: 'uuid-1',
        overlapCount: 0,
      },
    ]);
    database.close();
  });

  it('returns every live destination with zero overlap when the archive names no identities', () => {
    const database = db();
    seed(database, { id: 1, name: 'Live' }, ['seq_A']);
    expect(rankWorkspacesByProviderOverlap(database, new Map())).toEqual([
      {
        workspaceDbId: 1,
        workspaceName: 'Live',
        workspacePath: '/tmp/ws-1',
        repoUuid: 'uuid-1',
        overlapCount: 0,
      },
    ]);
    database.close();
  });

  it('counts an identity once even when a workspace holds it twice', () => {
    const database = db();
    seed(database, { id: 1, name: 'Duplicated' }, ['seq_AAAAAA']);
    database.prepare('INSERT INTO catalog_entities (id, workspace_id) VALUES (?, ?)').run('dup', 1);
    database
      .prepare(
        'INSERT INTO catalog_provider_bindings (id, provider, stable_object_id, object_class, entity_id) VALUES (?, ?, ?, ?, ?)'
      )
      .run('dup::binding', 'benchling', 'seq_AAAAAA', 'sequence', 'dup');
    const ranked = rankWorkspacesByProviderOverlap(
      database,
      providerReferencesInArchiveEntryPaths(['A (seq_AAAAAA).gb'])
    );
    expect(ranked).toEqual([
      {
        workspaceDbId: 1,
        workspaceName: 'Duplicated',
        workspacePath: '/tmp/ws-1',
        repoUuid: 'uuid-1',
        overlapCount: 1,
      },
    ]);
    database.close();
  });

  it('matches the complete provider identity tuple', () => {
    const database = db();
    seed(database, { id: 1, name: 'Exact' }, ['seq_AAAAAA']);
    seed(database, { id: 2, name: 'Collisions' }, []);
    for (const [id, provider, objectClass] of [
      ['other-provider', 'other', 'sequence'],
      ['wrong-class', 'benchling', 'notebook'],
    ] as const) {
      const entityId = `2::${id}`;
      database
        .prepare('INSERT INTO catalog_entities (id, workspace_id) VALUES (?, ?)')
        .run(entityId, 2);
      database
        .prepare(
          'INSERT INTO catalog_provider_bindings (id, provider, stable_object_id, object_class, entity_id) VALUES (?, ?, ?, ?, ?)'
        )
        .run(id, provider, 'seq_AAAAAA', objectClass, entityId);
    }

    const ranked = rankWorkspacesByProviderOverlap(
      database,
      providerReferencesInArchiveEntryPaths(['A (seq_AAAAAA).gb'])
    );
    expect(ranked.map(({ workspaceName, overlapCount }) => [workspaceName, overlapCount])).toEqual([
      ['Exact', 1],
      ['Collisions', 0],
    ]);
    database.close();
  });
});

describe('append destination eligibility', () => {
  it('offers ordinary writable workspaces, including null-repository and non-Git rows', async () => {
    const candidates = [
      {
        workspaceDbId: 1,
        workspaceName: 'Imported before',
        workspacePath: '/managed/uuid-1/repo',
        repoUuid: 'uuid-1',
        overlapCount: 3,
      },
      {
        workspaceDbId: 2,
        workspaceName: 'Managed without repository identity',
        workspacePath: '/managed/null-repo/repo',
        repoUuid: null,
        overlapCount: 0,
      },
      {
        workspaceDbId: 3,
        workspaceName: 'Local folder',
        workspacePath: '/Users/test/local-folder',
        repoUuid: null,
        overlapCount: 0,
      },
    ];

    const eligible = await eligibleImportDestinations(candidates, {
      inspectWorkspace: async () => 'eligible',
    });

    expect(eligible).toEqual(
      candidates.map(({ workspacePath: _workspacePath, ...candidate }) => candidate)
    );
  });

  it('excludes missing/read-only workspaces but retains busy destinations and their matches', async () => {
    const candidates = ['eligible', 'missing', 'read-only', 'busy'].map((state, index) => ({
      workspaceDbId: index + 1,
      workspaceName: state,
      workspacePath: `/workspaces/${state}`,
      repoUuid: null,
      overlapCount: 0,
    }));

    const eligible = await eligibleImportDestinations(candidates, {
      inspectWorkspace: async (path) =>
        path.endsWith('/eligible')
          ? 'eligible'
          : path.endsWith('/missing')
            ? 'missing'
            : path.endsWith('/read-only')
              ? 'read_only'
              : 'busy',
    });

    expect(eligible).toEqual([
      {
        workspaceDbId: 1,
        workspaceName: 'eligible',
        repoUuid: null,
        overlapCount: 0,
      },
      { workspaceDbId: 4, workspaceName: 'busy', repoUuid: null, overlapCount: 0, busy: true },
    ]);
  });
});
