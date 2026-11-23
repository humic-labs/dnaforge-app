/** @vitest-environment node */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { withWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { ensureSchema } from './schema';
import { recoverLegacyPrimerLibraryInMain } from './legacy-primer-library-recovery';
import { parsePrimerArtifact } from '../shared/primers/primer-artifact';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
let db: ReturnType<typeof createTestDb>;
let directory: string;
const sequence = 'ACGTTGCAAGTCCTGATCGATAGCTAGC';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'primer-portable-recovery-'));
  db = createTestDb();
  ensureSchema(db, ':memory:');
  const insert = db.prepare(
    'INSERT INTO primers (id,name,sequence,length,tm,gc_percent,origin,status,notes,vendor,stock_location,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (let index = 0; index < 3; index++)
    insert.run(
      `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
      index === 0 ? 'POP5_R' : `Legacy ${index}`,
      sequence,
      sequence.length,
      null,
      50,
      'import',
      'received',
      'Exact original notes',
      'Original supplier',
      'Freezer A',
      1_600_000_000_000,
      1_600_000_010_000
    );
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});
const recover = (
  onCheckpoint?: (
    phase: 'snapshot' | 'destination' | 'published',
    primerId?: string
  ) => void | Promise<void>
) =>
  recoverLegacyPrimerLibraryInMain({
    db,
    profileDirectory: directory,
    managedRootDir: join(directory, 'projects'),
    onCheckpoint,
  });

it('lets queued database work observe completed primers between publications', async () => {
  let countBetweenPublications: Promise<number> | undefined;
  const result = await recover((phase) => {
    if (phase === 'published' && !countBetweenPublications) {
      countBetweenPublications = withWorkspaceSyncDatabaseFence(db, async () => {
        return db
          .prepare<
            [],
            { n: number }
          >('SELECT COUNT(*) AS n FROM lims_entity WHERE id IN (SELECT id FROM primers)')
          .get()!.n;
      });
    }
  });

  expect(result).toMatchObject({ status: 'complete', recovered: 3 });
  expect(await countBetweenPublications).toBe(1);
});

it('gives existing unassigned primers one portable project without inventing original ownership', async () => {
  const result = await recover();
  expect(result).toMatchObject({ status: 'complete', total: 3, recovered: 3, errors: [] });
  if (result.status === 'empty') throw new Error('No recovered project');
  const paths = (await readdir(result.workspaceRoot, { recursive: true })).filter((path) =>
    path.endsWith('.primer.json')
  );
  expect(paths).toHaveLength(3);
  const records = await Promise.all(
    paths.map(async (path) =>
      parsePrimerArtifact(await readFile(join(result.workspaceRoot, path), 'utf8'))
    )
  );
  expect(records.map((record) => record.id).sort()).toEqual(
    db
      .prepare<[], { id: string }>('SELECT id FROM primers ORDER BY id')
      .all()
      .map((row) => row.id)
  );
  for (const record of records) {
    expect(record.sequence.bases).toBe(sequence);
    expect(record.inventory).toMatchObject({
      origin: 'import',
      vendor: 'Original supplier',
      stockLocation: 'Freezer A',
    });
    expect(record.metadata).toMatchObject({
      createdAt: '2020-09-13T12:26:40.000Z',
      updatedAt: '2020-09-13T12:26:50.000Z',
    });
    expect(record.recovery).toMatchObject({ source: 'legacy' });
  }
  expect(
    db.prepare("SELECT key FROM settings WHERE key='original_default_project_identity_v1'").all()
  ).toEqual([]);
  const replay = await recover();
  expect(replay).toMatchObject({
    status: 'complete',
    workspaceRoot: result.workspaceRoot,
    workspaceUuid: result.workspaceUuid,
    total: 3,
    recovered: 3,
  });
  expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
  expect(
    db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE id IN (SELECT id FROM primers)').get()
  ).toEqual({ n: 3 });
});

it.each(['snapshot', 'destination', 'published'] as const)(
  'resumes the same operation after interruption at %s',
  async (stop) => {
    let interrupted = false;
    await recover((phase) => {
      if (!interrupted && phase === stop) {
        interrupted = true;
        throw new Error('Simulated process interruption');
      }
    }).catch(() => {});
    expect(interrupted).toBe(true);
    const result = await recover();
    expect(result).toMatchObject({ status: 'complete', total: 3, recovered: 3, errors: [] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE id IN (SELECT id FROM primers)').get()
    ).toEqual({ n: 3 });
  }
);
