import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureSchema } from '../../main/schema';
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { createPrimerRecoveryReportOwner } from './primer-recovery-report';
import { readPrimerById } from './primer-repository';
import type { PrimerRecoveryDependencies } from './primer-recovery-port';
import type { SqliteIpcValue } from '../sqlite-ipc';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

const unused = async (): Promise<never> => {
  throw new Error('This read must not mutate or materialize a primer.');
};
let fixture: ReturnType<typeof createLimsTestBridge>;
let root: string;

beforeEach(() => {
  fixture = createLimsTestBridge({ withOriginalProject: false });
  root = mkdtempSync(join(tmpdir(), 'primer-library-state-'));
  for (const id of [4, 9]) {
    mkdirSync(join(root, String(id)));
    fixture.db
      .prepare('INSERT INTO workspaces (id,name,path,repo_uuid,created_at) VALUES (?,?,?,?,?)')
      .run(
        id,
        'My Project',
        join(root, String(id)),
        `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
        1
      );
  }
});
afterEach(() => {
  fixture.db.close();
  rmSync(root, { recursive: true, force: true });
});

function reportOwner() {
  const database = {
    select: async <T>(sql: string, params: SqliteIpcValue[] = []): Promise<T> =>
      fixture.db.prepare(sql).all(...params) as T,
  };
  const getOriginalDefaultProject = vi.fn(async () => ({
    status: 'unresolved' as const,
    reason: 'identity-not-recorded' as const,
    message: 'The original My Project has not been identified.',
  }));
  const dependencies: PrimerRecoveryDependencies = {
    io: () => ({
      db: database,
      workspace: { getOriginalDefaultProject },
      fs: {
        exists: async (path) => existsSync(path),
        readTextFile: async (path) => readFileSync(path, 'utf8'),
        validateWorkspacePath: async ({ workspaceRoot, path }) =>
          isAbsolute(path) && !relative(workspaceRoot, path).startsWith('..'),
        writeWorkspaceTextFileAtomic: unused,
      },
    }),
    setSetting: async (key, value) => {
      fixture.db
        .prepare(
          'INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at'
        )
        .run(key, value, Date.now());
    },
    withRendererWorkspaceMutation: unused,
    getLimsRegistryPreview: unused,
    buildFileDnaSequenceRef: unused,
    generateCatalogNumber: unused,
    findTrashedPrimerDocument: async () => null,
    readPrimerRegistryRelationships: unused,
  };
  return { ...createPrimerRecoveryReportOwner(dependencies), database, getOriginalDefaultProject };
}

it('keeps 375 existing unassigned legacy primers available across repeated inventory reads without choosing a project', async () => {
  const bases = 'ACGTTGCAAGTCCTGATCGATAGCTAGC';
  const insert = fixture.db.prepare(
    'INSERT INTO primers (id,name,sequence,length,origin,notes,stock_location,workspace_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  fixture.db.transaction(() => {
    for (let index = 0; index < 375; index++)
      insert.run(
        `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
        index === 0 ? 'POP5_R' : `Existing primer ${index}`,
        bases,
        bases.length,
        'import',
        'Retained notes',
        'Original freezer',
        null,
        1,
        1
      );
  })();
  const before = fixture.db.prepare('SELECT * FROM primers ORDER BY id').all();
  const owner = reportOwner();
  for (let pass = 0; pass < 3; pass++) {
    const report = await owner.refreshPrimerRecoveryInventory();
    expect(report.entries).toHaveLength(375);
    expect(report.entries.every((entry) => entry.status === 'legacy-library')).toBe(true);
    expect(
      report.entries.every(
        (entry) =>
          entry.workspaceId === null && entry.projectUuid === null && entry.message === undefined
      )
    ).toBe(true);
    expect(
      await readPrimerById(owner.database, '00000000-0000-4000-9000-000000000000')
    ).toMatchObject({
      name: 'POP5_R',
      sequence: bases,
      workspaceId: null,
      stockLocation: 'Original freezer',
      notes: 'Retained notes',
    });
  }
  expect(owner.getOriginalDefaultProject).not.toHaveBeenCalled();
  expect(fixture.db.prepare('SELECT * FROM primers ORDER BY id').all()).toEqual(before);
  expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get()).toEqual({ n: 0 });
  expect(
    fixture.db
      .prepare('SELECT key FROM settings WHERE key IN (?,?)')
      .all('original_default_project_identity_v1', 'default_workspace_path')
  ).toEqual([]);
});

const origins = [
  ['absent', null],
  ['ordinary import', JSON.stringify({ provider: 'historical import' })],
  ['file authority', JSON.stringify({ authority: 'primer_artifact' })],
  ['missing canonical identity', JSON.stringify({ limsEntityId: 'missing-registry-id' })],
  ['malformed array', '[]'],
  ['invalid JSON', '{'],
] as const;
const states = origins.flatMap(([origin, details]) =>
  (['none', 'current', 'missing'] as const).flatMap((file) =>
    [false, true].map((failure) => ({ origin, details, file, failure }))
  )
);

it.each(states)(
  'preserves the library boundary for $origin, file=$file, previous failure=$failure',
  async ({ origin, details, file, failure }) => {
    const id = '00000000-0000-4000-9000-000000000000';
    fixture.db
      .prepare(
        'INSERT INTO primers (id,name,sequence,length,origin_details,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(id, 'Existing primer', 'ACGT', 4, details, 1, 1);
    if (file !== 'none') {
      fixture.db
        .prepare(
          'INSERT INTO catalog_entities (id,type,name,locator,storage_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run(id, 'primer', 'Existing primer', `primer:${id}`, 'file', 1, 1);
      fixture.db
        .prepare(
          'INSERT INTO catalog_entity_files (id,entity_id,path,file_kind,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run('primer-file', id, join(root, 'missing.primer.json'), 'primer', file, 1, 1);
    }
    if (failure)
      fixture.db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
        'primer_recovery_project_v1:4',
        JSON.stringify({
          records: [{ id, status: 'unresolved', message: 'A recorded recovery attempt failed.' }],
        }),
        1
      );
    const before = fixture.db.prepare('SELECT * FROM primers').all();
    const owner = reportOwner();
    const available =
      (origin === 'absent' || origin === 'ordinary import') && file === 'none' && !failure;
    for (let pass = 0; pass < 2; pass++) {
      const report = await owner.refreshPrimerRecoveryInventory();
      expect(report.entries).toEqual([
        expect.objectContaining({
          id,
          status: available ? 'legacy-library' : 'needs-review',
          workspaceId: null,
        }),
      ]);
      if (origin === 'invalid JSON')
        await expect(readPrimerById(owner.database, id)).rejects.toThrow(SyntaxError);
      else
        expect(await readPrimerById(owner.database, id)).toMatchObject({
          id,
          sequence: 'ACGT',
          workspaceId: null,
        });
    }
    expect(owner.getOriginalDefaultProject).toHaveBeenCalledTimes(available ? 0 : 2);
    expect(fixture.db.prepare('SELECT * FROM primers').all()).toEqual(before);
  }
);

it('retiring the historical default-project preference does not revoke existing legacy library availability', async () => {
  const path = join(root, '4');
  fixture.db.prepare("UPDATE workspaces SET name='My Workspace' WHERE id=4").run();
  fixture.db
    .prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)')
    .run('default_workspace_path', path, 1);
  fixture.db
    .prepare(
      'INSERT INTO primers (id,name,sequence,length,created_at,updated_at) VALUES (?,?,?,?,?,?)'
    )
    .run('legacy-before-marker-retirement', 'Existing before upgrade', 'ACGT', 4, 1, 1);
  const before = fixture.db.prepare('SELECT * FROM primers').all();
  fixture.db.pragma('user_version = 36');
  ensureSchema(fixture.db, ':memory:');
  expect(
    fixture.db.prepare("SELECT value FROM settings WHERE key='default_workspace_path'").get()
  ).toBeUndefined();
  expect(fixture.db.prepare('SELECT name FROM workspaces WHERE id=4').get()).toEqual({
    name: 'My Project',
  });
  expect(fixture.db.prepare('SELECT * FROM primers').all()).toEqual(before);
  const owner = reportOwner();
  expect((await owner.refreshPrimerRecoveryInventory()).entries).toEqual([
    expect.objectContaining({
      id: 'legacy-before-marker-retirement',
      status: 'legacy-library',
      workspaceId: null,
    }),
  ]);
  expect(owner.getOriginalDefaultProject).not.toHaveBeenCalled();
});
