import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  legacyPrimerRecoveryArtifactStem,
  type LegacyPrimerLibraryRecoveryResult,
} from '../shared/legacy-primer-library-recovery';
import { readPrimerById } from '../shared/primer-artifacts/primer-repository';
import type { DbPrimerRow } from '../shared/primer-artifacts/types';
import { canonicalEntityArtifactValue } from '../shared/entity-artifact-projection';
import {
  defaultPrimerArtifactPath,
  parsePrimerArtifact,
  serializePrimerArtifact,
} from '../shared/primers/primer-artifact';
import type { ImportSetPersistenceDependencies } from '../shared/registry-artifacts/import-set-core';
import { createNativePrimerArtifactWriter } from './native-import-writers';
import {
  canonicalWorkspacePath,
  writeWorkspaceTextFileAtomicInMain,
  writeWorkspaceBinaryFileAtomicInMain,
} from './primer-artifact-files';
import { createEmptyManagedWorkspace } from './workspace-git/import';
import { commitPathsIfDirty, isGitRepo } from './workspace-git';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertWorkspaceSyncDatabaseFence,
  waitForRendererWorkspaceMutations,
  withWorkspaceSyncDatabaseFence,
} from './workspace-sync-database-fence';
import {
  assertWorkspaceMutationLease,
  withKnownWorkspacePathsMutationAcrossWorkspaces,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { syncDirectory } from './fs-durability';

const JOURNAL_KEY = 'primer_legacy_library_recovery_v1';
const active = new WeakMap<Database.Database, Promise<LegacyPrimerLibraryRecoveryResult>>();
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type BindingRow = { primer_id: string; [key: string]: unknown };
interface SourceSnapshot {
  schema: 'dnaforge.legacy-primer-library-source/v1';
  operationId: string;
  rows: DbPrimerRow[];
  bindings: BindingRow[];
}
interface Journal {
  schema: 'dnaforge.legacy-primer-library-recovery/v1';
  operationId: string;
  sourceHash: string;
  workspace?: { root: string; uuid: string };
  files: Record<string, string>;
}
interface RecoveryOptions {
  db: Database.Database;
  profileDirectory: string;
  managedRootDir: string;
  assertCurrent?: () => void;
  onCheckpoint?: (
    phase: 'snapshot' | 'destination' | 'published',
    primerId?: string
  ) => void | Promise<void>;
}
function fingerprint(row: DbPrimerRow, bindings: BindingRow[]): string {
  return hash(JSON.stringify(canonicalEntityArtifactValue({ row, bindings })));
}
function loadJournal(db: Database.Database): Journal | null {
  const saved = db.prepare('SELECT value FROM settings WHERE key=?').get(JOURNAL_KEY) as
    | { value: string }
    | undefined;
  if (!saved) return null;
  const journal = JSON.parse(saved.value) as Journal;
  if (
    journal.schema !== 'dnaforge.legacy-primer-library-recovery/v1' ||
    typeof journal.operationId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(journal.operationId) ||
    !/^[a-f0-9]{64}$/.test(journal.sourceHash) ||
    !journal.files ||
    typeof journal.files !== 'object' ||
    Array.isArray(journal.files) ||
    Object.values(journal.files).some(
      (value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)
    ) ||
    (journal.workspace &&
      (typeof journal.workspace.root !== 'string' || typeof journal.workspace.uuid !== 'string'))
  )
    throw new Error(
      'The retained primer recovery journal is invalid; existing records were preserved.'
    );
  return journal;
}
function saveJournal(db: Database.Database, journal: Journal): void {
  db.prepare(
    'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at'
  ).run(JOURNAL_KEY, JSON.stringify(journal), Date.now());
}
async function fileExists(path: string): Promise<boolean> {
  try {
    const file = await open(path, 'r');
    await file.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function sourceBindings(snapshot: SourceSnapshot, id: string): BindingRow[] {
  return snapshot.bindings.filter((binding) => binding.primer_id === id);
}
function currentSource(db: Database.Database, id: string) {
  const row = db.prepare('SELECT * FROM primers WHERE id=?').get(id) as DbPrimerRow | undefined;
  if (!row) throw new Error('The original primer record is no longer present.');
  const bindings = db
    .prepare('SELECT * FROM primer_bindings WHERE primer_id=? ORDER BY id')
    .all(id) as BindingRow[];
  return { row, bindings, fingerprint: fingerprint(row, bindings) };
}
function assertLegacySource(db: Database.Database, row: DbPrimerRow, expected: string): void {
  const current = currentSource(db, row.id);
  if (current.row.workspace_id !== null || current.fingerprint !== expected)
    throw new Error(
      'The primer changed after its retained recovery snapshot; its current record was preserved.'
    );
  if (current.bindings.length)
    throw new Error(
      'This library primer has sequence bindings that require their original project; they were preserved.'
    );
  if (
    db.prepare('SELECT 1 FROM lims_entity WHERE id=?').get(row.id) ||
    db.prepare('SELECT 1 FROM catalog_entities WHERE id=?').get(row.id) ||
    db.prepare('SELECT 1 FROM catalog_entity_files WHERE entity_id=?').get(row.id)
  )
    throw new Error(
      'This primer already has a canonical identity or document history; its original owner was preserved.'
    );
  if (row.origin_details) {
    const details: unknown = JSON.parse(row.origin_details);
    if (
      details !== null &&
      (typeof details !== 'object' ||
        Array.isArray(details) ||
        'limsEntityId' in details ||
        ('authority' in details && details.authority === 'primer_artifact'))
    )
      throw new Error(
        'The primer has invalid or existing document ownership metadata; its original record was preserved.'
      );
  }
}

export function recoverLegacyPrimerLibraryInMain(
  options: RecoveryOptions
): Promise<LegacyPrimerLibraryRecoveryResult> {
  const pending = active.get(options.db);
  if (pending) return pending;
  const operation = recover(options);
  active.set(options.db, operation);
  void operation
    .finally(() => {
      if (active.get(options.db) === operation) active.delete(options.db);
    })
    .catch(() => {});
  return operation;
}

async function recover(options: RecoveryOptions): Promise<LegacyPrimerLibraryRecoveryResult> {
  const { db } = options;
  const assertCurrent = () => options.assertCurrent?.();
  let journal: Journal;
  let snapshot: SourceSnapshot;
  let preparationJournal: Journal | null = null;
  let sourceCount = 0;
  await waitForRendererWorkspaceMutations(db);
  const releasePreparation = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    const checkPreparation = () => {
      assertWorkspaceSyncDatabaseFence(db, releasePreparation);
      assertCurrent();
    };
    checkPreparation();
    await mkdir(options.profileDirectory, { recursive: true, mode: 0o700 });
    const profile = await realpath(options.profileDirectory);
    const backupRoot = join(profile, 'primer-library-recovery');
    const writeSnapshot = async (source: SourceSnapshot) => {
      const content = JSON.stringify(source, null, 2) + '\n';
      const sourceHash = hash(content);
      const directory = join(backupRoot, source.operationId);
      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      await syncDirectory(profile);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await syncDirectory(backupRoot);
      const path = join(directory, `${sourceHash}.json`);
      if (await fileExists(path)) {
        if (hash(await readFile(path)) !== sourceHash)
          throw new Error('An existing primer source snapshot differs from its retained hash.');
      } else
        await writeWorkspaceTextFileAtomicInMain(
          {
            workspaceRoot: profile,
            path,
            content,
            mode: 'create',
            artifactNoun: 'primer recovery source',
          },
          { durable: true, beforePublish: checkPreparation }
        );
      return sourceHash;
    };
    const currentRows = db
      .prepare(
        'SELECT p.* FROM primers p WHERE p.workspace_id IS NULL AND NOT EXISTS(SELECT 1 FROM lims_entity e WHERE e.id=p.id) ORDER BY p.id'
      )
      .all() as DbPrimerRow[];
    const currentBindings = () =>
      db
        .prepare(
          'SELECT b.* FROM primer_bindings b JOIN primers p ON p.id=b.primer_id WHERE p.workspace_id IS NULL AND NOT EXISTS(SELECT 1 FROM lims_entity e WHERE e.id=p.id) ORDER BY b.id'
        )
        .all() as BindingRow[];
    const existing = loadJournal(db);
    if (existing) {
      journal = existing;
      preparationJournal = journal;
      const directory = join(backupRoot, journal.operationId);
      const addressed = join(directory, `${journal.sourceHash}.json`);
      const bytes = await readFile(
        (await fileExists(addressed)) ? addressed : join(directory, 'source.json'),
        'utf8'
      );
      if (hash(bytes) !== journal.sourceHash)
        throw new Error('The retained primer recovery source backup changed.');
      snapshot = JSON.parse(bytes) as SourceSnapshot;
      if (
        snapshot.schema !== 'dnaforge.legacy-primer-library-source/v1' ||
        snapshot.operationId !== journal.operationId ||
        !Array.isArray(snapshot.rows) ||
        !Array.isArray(snapshot.bindings)
      )
        throw new Error('The retained primer recovery source snapshot is invalid.');
      sourceCount = snapshot.rows.length;
      const retainedIds = new Set(snapshot.rows.map((row) => row.id));
      const additions = currentRows.filter((row) => !retainedIds.has(row.id));
      if (additions.length) {
        const addedIds = new Set(additions.map((row) => row.id));
        snapshot = {
          ...snapshot,
          rows: [...snapshot.rows, ...additions],
          bindings: [
            ...snapshot.bindings,
            ...currentBindings().filter((binding) => addedIds.has(binding.primer_id)),
          ],
        };
        journal.sourceHash = await writeSnapshot(snapshot);
        sourceCount = snapshot.rows.length;
        checkPreparation();
        saveJournal(db, journal);
        await options.onCheckpoint?.('snapshot');
      }
    } else {
      if (!currentRows.length) return { status: 'empty' };
      snapshot = {
        schema: 'dnaforge.legacy-primer-library-source/v1',
        operationId: randomUUID(),
        rows: currentRows,
        bindings: currentBindings(),
      };
      journal = {
        schema: 'dnaforge.legacy-primer-library-recovery/v1',
        operationId: snapshot.operationId,
        sourceHash: await writeSnapshot(snapshot),
        files: {},
      };
      preparationJournal = journal;
      sourceCount = snapshot.rows.length;
      checkPreparation();
      saveJournal(db, journal);
      await options.onCheckpoint?.('snapshot');
    }
    if (!journal.workspace) {
      const created = await createEmptyManagedWorkspace('Recovered primers', {
        db,
        managedRootDir: options.managedRootDir,
        recordCreatedInsideTx: (identity) => {
          checkPreparation();
          journal.workspace = { root: identity.repoPath, uuid: identity.workspaceUuid };
          saveJournal(db, journal);
        },
      });
      const retained = loadJournal(db)?.workspace;
      if (retained?.uuid !== created.workspaceUuid || retained.root !== created.repoPath)
        throw new Error('The recovered project identity was not retained.');
      journal.workspace = retained;
      await options.onCheckpoint?.('destination');
    }
  } catch (error) {
    if (preparationJournal?.workspace)
      return {
        status: 'pending',
        operationId: preparationJournal.operationId,
        workspaceRoot: preparationJournal.workspace.root,
        workspaceUuid: preparationJournal.workspace.uuid,
        recovered: 0,
        total: sourceCount,
        errors: [{ primerId: '', message: error instanceof Error ? error.message : String(error) }],
      };
    throw error;
  } finally {
    releasePreparation();
  }
  const destination = journal.workspace;
  if (!destination) throw new Error('The recovered primer destination is unavailable.');
  const errors: Array<{ primerId: string; message: string }> = [];
  let recovered = 0;
  const publish = async (row?: DbPrimerRow) => {
    await waitForRendererWorkspaceMutations(db);
    await withKnownWorkspacePathsMutationAcrossWorkspaces(
      db,
      [destination.root],
      async (leases) => {
        assertCurrent();
        const lease = leases.get(workspaceMutationRootIdentity(destination.root));
        if (!lease) throw new Error('The recovered project mutation lease is unavailable.');
        await withWorkspaceSyncDatabaseFence(db, async (release) => {
          assertKnownWorkspaceContentWritable(db, destination.root);
          if (!isDeepStrictEqual(loadJournal(db), journal))
            throw new Error('The retained primer recovery journal changed between publications.');
          const check = () => {
            assertCurrent();
            assertWorkspaceMutationLease(lease, destination.root);
            assertWorkspaceSyncDatabaseFence(db, release);
            assertWorkspaceWriteAllowed(db, [destination.root]);
            const project = db
              .prepare('SELECT repo_uuid FROM workspaces WHERE path=?')
              .get(destination.root) as { repo_uuid: string } | undefined;
            if (project?.repo_uuid !== destination.uuid)
              throw new Error('The recovered primer project identity changed.');
          };
          check();
          const intentProfile = await realpath(options.profileDirectory);
          const intentDirectory = join(
            intentProfile,
            'primer-library-recovery',
            journal.operationId,
            'intents'
          );
          const persistence: ImportSetPersistenceDependencies = {
            fs: {
              exists: fileExists,
              readFile: async (path) => new Uint8Array(await readFile(path)),
              readTextFile: (path) => readFile(path, 'utf8'),
              sha256File: async (path) => hash(await readFile(path)),
              writeWorkspaceTextFileAtomic: async (request) => {
                const artifact = request.path.endsWith('.primer.json')
                  ? parsePrimerArtifact(request.content)
                  : null;
                const row = artifact
                  ? snapshot.rows.find((entry) => entry.id === artifact.id)
                  : undefined;
                const beforePublish = () => {
                  check();
                  if (row)
                    assertLegacySource(db, row, fingerprint(row, sourceBindings(snapshot, row.id)));
                };
                if (artifact) {
                  beforePublish();
                  const intendedHash = hash(request.content);
                  if (
                    Object.hasOwn(journal.files, artifact.id) &&
                    journal.files[artifact.id] !== intendedHash
                  )
                    throw new Error(
                      'The primer publication intent differs from its retained bytes.'
                    );
                  await mkdir(intentDirectory, { recursive: true, mode: 0o700 });
                  await syncDirectory(join(intentDirectory, '..'));
                  const intentPath = join(intentDirectory, `${intendedHash}.primer.json`);
                  if (await fileExists(intentPath)) {
                    if (hash(await readFile(intentPath)) !== intendedHash)
                      throw new Error('The retained primer publication intent bytes changed.');
                  } else
                    await writeWorkspaceTextFileAtomicInMain(
                      {
                        workspaceRoot: intentProfile,
                        path: intentPath,
                        content: request.content,
                        mode: 'create',
                        artifactNoun: 'primer publication intent',
                      },
                      { durable: true, beforePublish }
                    );
                  beforePublish();
                  Object.defineProperty(journal.files, artifact.id, {
                    value: intendedHash,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                  });
                  saveJournal(db, journal);
                }
                const written = await writeWorkspaceTextFileAtomicInMain(request, {
                  durable: true,
                  beforePublish,
                });
                if (artifact) await options.onCheckpoint?.('published', artifact.id);
                return written;
              },
              writeWorkspaceBinaryFileAtomic: (request) =>
                writeWorkspaceBinaryFileAtomicInMain(request, {
                  durable: true,
                  beforePublish: check,
                }),
            },
            isGitRepo: async (path) => isGitRepo(path),
            commitPaths: async (path, message, paths) => {
              check();
              await commitPathsIfDirty(path, message, { paths });
              check();
            },
          };
          if (!row) {
            const sourceRelativePath = `.forge/recovery/legacy-primer-library-source-${journal.sourceHash}.json`;
            const sourcePath = join(destination.root, sourceRelativePath);
            const sourceDirectory = join(
              options.profileDirectory,
              'primer-library-recovery',
              journal.operationId
            );
            const addressed = join(sourceDirectory, `${journal.sourceHash}.json`);
            const sourceBytes = await readFile(
              (await fileExists(addressed)) ? addressed : join(sourceDirectory, 'source.json'),
              'utf8'
            );
            if (hash(sourceBytes) !== journal.sourceHash)
              throw new Error(
                'The retained primer source changed before portable backup publication.'
              );
            if (await fileExists(sourcePath)) {
              if (hash(await readFile(sourcePath)) !== journal.sourceHash)
                throw new Error(
                  'The project recovery source backup differs from the retained original.'
                );
            } else {
              const canonical = await canonicalWorkspacePath({
                workspaceRoot: destination.root,
                path: sourcePath,
                allowMissing: true,
                artifactNoun: 'primer recovery source',
              });
              await mkdir(canonical.parent, { recursive: true, mode: 0o700 });
              await syncDirectory(destination.root);
              await syncDirectory(join(destination.root, '.forge'));
              await persistence.fs.writeWorkspaceTextFileAtomic({
                workspaceRoot: destination.root,
                path: sourcePath,
                content: sourceBytes,
                mode: 'create',
                artifactNoun: 'primer recovery source',
              });
            }
            await persistence.commitPaths(
              destination.root,
              'Retain original primer library recovery source',
              [sourceRelativePath]
            );
            return;
          }
          const native = createNativePrimerArtifactWriter({
            db,
            workspaceRoot: destination.root,
            operationId: journal.operationId,
            persistence,
            assertCurrent: check,
            publicationAuthority: { mutationLease: lease, databaseFence: release },
          });
          try {
            check();
            const expected = fingerprint(row, sourceBindings(snapshot, row.id));
            const existing = db
              .prepare('SELECT workspace_id,fields FROM lims_entity WHERE id=?')
              .get(row.id) as { workspace_id: number | null; fields: string } | undefined;
            if (existing) {
              const project = db
                .prepare('SELECT id FROM workspaces WHERE path=? AND repo_uuid=?')
                .get(destination.root, destination.uuid) as { id: number } | undefined;
              const fields = JSON.parse(existing.fields) as {
                artifact?: { relativePath?: string; contentHash?: string };
              };
              if (
                !project ||
                existing.workspace_id !== project.id ||
                typeof fields.artifact?.relativePath !== 'string'
              )
                throw new Error(
                  'A recovered primer identity belongs to another record or project.'
                );
              const loaded = await native.owner.readPrimerArtifactAtPath(
                join(destination.root, fields.artifact.relativePath),
                destination.root
              );
              const artifact = loaded.artifact;
              if (
                artifact.id !== row.id ||
                artifact.recovery?.source !== 'legacy' ||
                artifact.recovery.sourceFingerprint !== expected ||
                hash(serializePrimerArtifact(artifact)) !==
                  fields.artifact.contentHash?.replace(/^sha256:/, '')
              )
                throw new Error(
                  'The saved recovered primer differs from its retained identity or current Registry revision.'
                );
              const projected = await native.owner.projectPrimerArtifact(
                artifact,
                destination.root
              );
              const currentPrimer = await readPrimerById(native.database, row.id);
              const bindings = db
                .prepare(
                  "SELECT path,workspace_id,content_hash FROM catalog_entity_files WHERE entity_id=? AND status='current'"
                )
                .all(row.id) as Array<{
                path: string;
                workspace_id: number | null;
                content_hash: string | null;
              }>;
              if (
                !isDeepStrictEqual(currentPrimer, projected.primer) ||
                currentPrimer?.workspaceId !== project.id ||
                bindings.length !== 1 ||
                bindings[0].workspace_id !== project.id ||
                workspaceMutationRootIdentity(bindings[0].path) !==
                  workspaceMutationRootIdentity(
                    join(destination.root, artifact.file.workspaceRelativePath)
                  ) ||
                bindings[0].content_hash !== `sha256:${hash(serializePrimerArtifact(artifact))}`
              )
                throw new Error(
                  'The recovered primer file binding or compatibility projection is incomplete.'
                );
              recovered++;
              return;
            }
            assertLegacySource(db, row, expected);
            const publishedHash = Object.hasOwn(journal.files, row.id)
              ? journal.files[row.id]
              : undefined;
            const stem = await legacyPrimerRecoveryArtifactStem(row.name, row.id);
            const path = defaultPrimerArtifactPath(destination.root, stem);
            if (await fileExists(path)) {
              if (!publishedHash)
                throw new Error(
                  'The pending primer file has no retained publication intent; its bytes were preserved.'
                );
              if (hash(await readFile(path)) !== publishedHash)
                throw new Error(
                  'The pending recovered primer file changed; its bytes were preserved.'
                );
            } else if (publishedHash) {
              const content = await readFile(
                join(intentDirectory, `${publishedHash}.primer.json`),
                'utf8'
              );
              const retained = parsePrimerArtifact(content);
              if (
                hash(content) !== publishedHash ||
                retained.id !== row.id ||
                retained.recovery?.sourceFingerprint !== expected ||
                retained.file.workspaceRelativePath !== `primers/${stem}.primer.json`
              )
                throw new Error(
                  'The retained primer publication intent does not match its original record.'
                );
              await persistence.fs.writeWorkspaceTextFileAtomic({
                workspaceRoot: destination.root,
                path,
                content,
                mode: 'create',
                artifactNoun: 'recovered primer',
              });
            }
            const result = await native.recoverSelectedLegacyPrimers([
              { id: row.id, sourceFingerprint: expected },
            ]);
            if (result.errors.length)
              throw new Error(result.errors.map((error) => error.message).join('; '));
            if (result.recovered !== 1)
              throw new Error(
                'The selected primer did not acquire its verified file-backed representation.'
              );
            recovered++;
          } catch (error) {
            errors.push({
              primerId: row.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }
    );
  };
  try {
    await publish();
    for (const row of snapshot.rows) await publish(row);
  } catch (error) {
    errors.push({ primerId: '', message: error instanceof Error ? error.message : String(error) });
  }
  return {
    status: recovered === snapshot.rows.length && errors.length === 0 ? 'complete' : 'pending',
    operationId: journal.operationId,
    workspaceRoot: destination.root,
    workspaceUuid: destination.uuid,
    recovered,
    total: snapshot.rows.length,
    errors,
  };
}
