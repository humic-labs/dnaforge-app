/** @vitest-environment node */
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { recoverLegacyPrimerLibraryInMain } from './legacy-primer-library-recovery';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
let db: ReturnType<typeof createTestDb>;
let directory: string;
const firstId = '00000000-0000-4000-9000-000000000000';
const secondId = '00000000-0000-4000-9000-000000000001';
const sequence = 'ACGTTGCAAGTCCTGATCGATAGCTAGC';
function seed(id = firstId) {
  db.prepare(
    'INSERT INTO primers (id,catalog_number,name,sequence,length,tm,gc_percent,origin,status,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    id,
    `OLD-${id}`,
    'Original primer',
    sequence,
    sequence.length,
    53,
    50,
    'import',
    'received',
    'Original notes',
    1_600_000_000_000,
    1_600_000_010_000
  );
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'primer-recovery-boundary-'));
  db = createTestDb();
  ensureSchema(db, ':memory:');
  seed();
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
const primerFiles = async (root: string) =>
  (await readdir(root, { recursive: true })).filter((path) => path.endsWith('.primer.json'));

it('preserves a source changed after the retained snapshot and never fabricates a successful recovery', async () => {
  const result = await recover((phase) => {
    if (phase === 'snapshot')
      db.prepare('UPDATE primers SET notes=? WHERE id=?').run('Changed by another writer', firstId);
  });
  expect(result).toMatchObject({ status: 'pending', recovered: 0, total: 1 });
  if (result.status === 'empty') throw new Error('No retained destination');
  expect(result.errors[0].message).toMatch(/changed after.*snapshot/);
  expect(await primerFiles(result.workspaceRoot)).toEqual([]);
  expect(db.prepare('SELECT notes,workspace_id FROM primers WHERE id=?').get(firstId)).toEqual({
    notes: 'Changed by another writer',
    workspace_id: null,
  });
  expect(db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE id=?').get(firstId)).toEqual({
    n: 0,
  });
});

it('refuses changed bytes after interrupted file publication and preserves both original source and conflicting file', async () => {
  let conflictingPath = '';
  const conflictingBytes = '{"external":"edit"}\n';
  const first = await recover(async (phase) => {
    if (phase !== 'published') return;
    const setting = db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get('primer_legacy_library_recovery_v1') as { value: string };
    const root = JSON.parse(setting.value).workspace.root as string;
    conflictingPath = join(root, (await primerFiles(root))[0]);
    await writeFile(conflictingPath, conflictingBytes);
    throw new Error('Simulated crash after publication');
  });
  expect(first.status).toBe('pending');
  const replay = await recover();
  expect(replay).toMatchObject({ status: 'pending', recovered: 0, total: 1 });
  if (replay.status === 'empty') throw new Error('No retained destination');
  expect(replay.errors[0].message).toMatch(/pending recovered primer file changed/);
  expect(await readFile(conflictingPath, 'utf8')).toBe(conflictingBytes);
  expect(db.prepare('SELECT workspace_id,sequence FROM primers WHERE id=?').get(firstId)).toEqual({
    workspace_id: null,
    sequence,
  });
  expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
});

it('keeps an inactive destination pending and resumes that same project after writable access returns', async () => {
  const first = await recover((phase) => {
    if (phase === 'destination') db.prepare("UPDATE workspaces SET access_mode='reference'").run();
  });
  expect(first.status).toBe('pending');
  db.prepare("UPDATE workspaces SET access_mode='writable'").run();
  expect(await recover()).toMatchObject({ status: 'complete', recovered: 1, total: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
});

it('does not replace a missing canonical primer file from an old migration snapshot', async () => {
  const result = await recover();
  expect(result.status).toBe('complete');
  if (result.status === 'empty') throw new Error('No recovered destination');
  const path = join(result.workspaceRoot, (await primerFiles(result.workspaceRoot))[0]);
  await unlink(path);
  expect(await recover()).toMatchObject({ status: 'pending', recovered: 0, total: 1 });
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('extends the same recovery project for subsequently discovered unassigned primers without replacing its retained snapshot', async () => {
  const first = await recover();
  expect(first.status).toBe('complete');
  if (first.status === 'empty') throw new Error('No recovered destination');
  const backupDirectory = join(directory, 'primer-library-recovery', first.operationId);
  const backupsBefore = (await readdir(backupDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
    .map((entry) => entry.name);
  expect(backupsBefore).toHaveLength(1);
  const bytesBefore = await Promise.all(
    backupsBefore.map((name) => readFile(join(backupDirectory, name), 'utf8'))
  );
  seed(secondId);
  const next = await recover();
  expect(next).toMatchObject({
    status: 'complete',
    recovered: 2,
    total: 2,
    workspaceRoot: first.workspaceRoot,
    workspaceUuid: first.workspaceUuid,
  });
  expect(await primerFiles(first.workspaceRoot)).toHaveLength(2);
  for (const [index, name] of backupsBefore.entries())
    expect(await readFile(join(backupDirectory, name), 'utf8')).toBe(bytesBefore[index]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
});

it.each(['constructor', '__proto__'])(
  'retains an ordinary publication hash for the valid historical identity %s',
  async (id) => {
    seed(id);
    expect(await recover()).toMatchObject({ status: 'complete', recovered: 2, total: 2 });
    const setting = db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get('primer_legacy_library_recovery_v1') as { value: string };
    const journal = JSON.parse(setting.value);
    expect(Object.hasOwn(journal.files, id)).toBe(true);
    expect(journal.files[id]).toMatch(/^[a-f0-9]{64}$/);
    expect(await recover()).toMatchObject({ status: 'complete', recovered: 2, total: 2 });
  }
);

it('resumes after durable file history succeeds and native Registry projection refuses publication', async () => {
  db.exec(
    "CREATE TRIGGER refuse_recovery_projection BEFORE INSERT ON lims_entity BEGIN SELECT RAISE(FAIL, 'Simulated projection refusal'); END"
  );
  const first = await recover();
  expect(first).toMatchObject({ status: 'pending', recovered: 0, total: 1 });
  if (first.status === 'empty') throw new Error('No retained destination');
  expect(first.errors[0].message).toMatch(/Simulated projection refusal/);
  const path = join(first.workspaceRoot, (await primerFiles(first.workspaceRoot))[0]);
  const originalFile = await readFile(path, 'utf8');
  expect(
    execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: first.workspaceRoot,
      encoding: 'utf8',
    }).trim()
  ).toBe('Recover primer Original primer');
  expect(db.prepare('SELECT workspace_id FROM primers WHERE id=?').get(firstId)).toEqual({
    workspace_id: null,
  });
  db.exec('DROP TRIGGER refuse_recovery_projection');
  expect(await recover()).toMatchObject({
    status: 'complete',
    recovered: 1,
    total: 1,
    workspaceRoot: first.workspaceRoot,
  });
  expect(await readFile(path, 'utf8')).toBe(originalFile);
  expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE id=?').get(firstId)).toEqual({
    n: 1,
  });
});

it('finishes the same native projection after Registry and catalog publication succeeded but compatibility projection was interrupted', async () => {
  db.exec(
    "CREATE TRIGGER refuse_recovered_compatibility BEFORE UPDATE ON primers BEGIN SELECT RAISE(FAIL, 'Simulated compatibility projection interruption'); END"
  );
  const first = await recover();
  expect(first).toMatchObject({ status: 'pending', recovered: 0, total: 1 });
  if (first.status === 'empty') throw new Error('No retained destination');
  expect(first.errors[0].message).toMatch(/Simulated compatibility projection interruption/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE id=?').get(firstId)).toEqual({
    n: 1,
  });
  expect(
    db
      .prepare('SELECT COUNT(*) AS n FROM catalog_entity_files WHERE entity_id=? AND status=?')
      .get(firstId, 'current')
  ).toEqual({ n: 1 });
  expect(db.prepare('SELECT workspace_id FROM primers WHERE id=?').get(firstId)).toEqual({
    workspace_id: null,
  });
  const path = join(first.workspaceRoot, (await primerFiles(first.workspaceRoot))[0]);
  const bytes = await readFile(path, 'utf8');
  db.exec('DROP TRIGGER refuse_recovered_compatibility');
  expect(await recover()).toMatchObject({
    status: 'complete',
    recovered: 1,
    total: 1,
    workspaceRoot: first.workspaceRoot,
  });
  const project = db
    .prepare('SELECT id FROM workspaces WHERE repo_uuid=?')
    .get(first.workspaceUuid) as { id: number };
  expect(db.prepare('SELECT workspace_id,sequence FROM primers WHERE id=?').get(firstId)).toEqual({
    workspace_id: project.id,
    sequence,
  });
  expect(await readFile(path, 'utf8')).toBe(bytes);
  expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
});

it('names recovered primer files with their readable name and complete stable identity', async () => {
  const result = await recover();
  expect(result.status).toBe('complete');
  if (result.status === 'empty') throw new Error('No recovered destination');
  expect(await primerFiles(result.workspaceRoot)).toEqual([
    join('primers', `Original_primer-${firstId}.primer.json`),
  ]);
});

it('refuses an unprojected file without its retained publication intent even when its recovery fingerprint was copied', async () => {
  const first = await recover((phase) => {
    if (phase === 'published') throw new Error('Simulated interruption before projection');
  });
  expect(first).toMatchObject({ status: 'pending', recovered: 0, total: 1 });
  if (first.status === 'empty') throw new Error('No retained destination');
  const path = join(first.workspaceRoot, (await primerFiles(first.workspaceRoot))[0]);
  const edited = JSON.parse(await readFile(path, 'utf8'));
  edited.name = 'Externally replaced primer retaining recovery fingerprint';
  const editedBytes = JSON.stringify(edited, null, 2) + '\n';
  await writeFile(path, editedBytes);
  const setting = db
    .prepare('SELECT value FROM settings WHERE key=?')
    .get('primer_legacy_library_recovery_v1') as { value: string };
  const journal = JSON.parse(setting.value);
  delete journal.files[firstId];
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(
    JSON.stringify(journal),
    'primer_legacy_library_recovery_v1'
  );
  const replay = await recover();
  expect(replay).toMatchObject({ status: 'pending', recovered: 0, total: 1 });
  if (replay.status === 'empty') throw new Error('No retained destination');
  expect(replay.errors[0].message).toMatch(/publication intent/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE id=?').get(firstId)).toEqual({
    n: 0,
  });
  expect(db.prepare('SELECT workspace_id,name FROM primers WHERE id=?').get(firstId)).toEqual({
    workspace_id: null,
    name: 'Original primer',
  });
  expect(await readFile(path, 'utf8')).toBe(editedBytes);
});

it('restores the exact retained publication and catalog number when an unprojected file disappears', async () => {
  db.prepare('UPDATE primers SET catalog_number=NULL WHERE id=?').run(firstId);
  const first = await recover((phase) => {
    if (phase === 'published') throw new Error('Simulated interruption after publication');
  });
  expect(first).toMatchObject({ status: 'pending', recovered: 0, total: 1 });
  if (first.status === 'empty') throw new Error('No retained destination');
  const path = join(first.workspaceRoot, (await primerFiles(first.workspaceRoot))[0]);
  const bytes = await readFile(path, 'utf8');
  const catalogNumber = JSON.parse(bytes).catalogNumber as string;
  expect(catalogNumber).toMatch(/^P\d+$/);
  expect(
    db.prepare('SELECT workspace_id,catalog_number FROM primers WHERE id=?').get(firstId)
  ).toEqual({ workspace_id: null, catalog_number: null });
  await unlink(path);
  expect(await recover()).toMatchObject({
    status: 'complete',
    recovered: 1,
    total: 1,
    workspaceRoot: first.workspaceRoot,
  });
  expect(await readFile(path, 'utf8')).toBe(bytes);
  expect(db.prepare('SELECT catalog_number FROM primers WHERE id=?').get(firstId)).toEqual({
    catalog_number: catalogNumber,
  });
  expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM lims_entity WHERE id=?').get(firstId)).toEqual({
    n: 1,
  });
});
