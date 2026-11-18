import { scientificWorkTables } from './scientific-object-schema';
import type Database from 'better-sqlite3';
import { verifyLimsAuditHashChainInDb } from './lims-projection-rebuild';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDirtyState } from './dirty-state-cache';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import {
  acquireWorkspaceSyncMutationLease,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { assertScientificWorkspaceLocalOnly } from './scientific-cloud-admission';
import { syncDirectory } from './fs-durability';
import {
  captureScientificRecoveryCheckpoint,
  copyScientificRecoveryTree,
  flushScientificRecoveryFile,
  hashScientificRecoveryFile,
  inventoryScientificRecoveryTree,
  openScientificRecoveryDatabase,
  scientificRecoveryDirectory,
  verifyScientificRecoveryCheckpoint,
  writeScientificRecoveryJson,
  type ScientificRecoveryCheckpoint,
  type ScientificRecoveryDependencies,
  type ScientificRecoveryFile,
} from './scientific-recovery-checkpoint';

const SCIENTIFIC_TABLES = [
  ...scientificWorkTables,
  'scientific_workspace_identities',
  'scientific_materialization_jobs',
  'scientific_revision_refs',
  'scientific_revision_records',
  'scientific_revision_blobs',
] as const;
const UUID = /^[0-9a-f-]{36}$/u;
const LEGACY_RECOVERY_SCHEMAS = new Set([42, 43, 47, 48]);

interface LegacyRecoveryReceipt {
  format: 'dnaforge.legacy-recovery-copy';
  version: 1 | 2;
  directory: string;
  projectPath: string;
  profilePath: string;
  sourceCheckpointId: string;
  preservedCurrentCheckpointId: string;
  workspaceId: number;
  workspaceUuid: string | null;
  legacySchemaVersion: 41;
  database: { sha256: string; byteLength: number };
  instructions: { sha256: string; byteLength: number };
  files: ScientificRecoveryFile[];
}

export async function verifyScientificLegacyRecoveryCopy(
  directory: string,
  deps: ScientificRecoveryDependencies = {},
  expected?: LegacyRecoveryReceipt
): Promise<LegacyRecoveryReceipt> {
  const receipt = JSON.parse(
    await readFile(join(directory, 'recovery.json'), 'utf8')
  ) as LegacyRecoveryReceipt;
  const final = directory.replace(/\.pending$/u, '');
  const projectMember = receipt.version === 2 ? join('profile', 'project') : 'project';
  if (
    receipt.format !== 'dnaforge.legacy-recovery-copy' ||
    (receipt.version !== 1 && receipt.version !== 2) ||
    receipt.directory !== final ||
    receipt.projectPath !== join(final, projectMember) ||
    receipt.profilePath !== join(final, 'profile') ||
    receipt.legacySchemaVersion !== 41 ||
    !UUID.test(receipt.sourceCheckpointId) ||
    !UUID.test(receipt.preservedCurrentCheckpointId) ||
    !Number.isSafeInteger(receipt.workspaceId) ||
    !Array.isArray(receipt.files) ||
    (expected && JSON.stringify(receipt) !== JSON.stringify(expected))
  )
    throw new Error('Legacy recovery receipt is invalid or changed before publication.');
  const members = (await readdir(directory)).sort();
  if (
    JSON.stringify(members) !==
      JSON.stringify(
        receipt.version === 2
          ? ['RECOVERY.md', 'profile', 'recovery.json']
          : ['RECOVERY.md', 'profile', 'project', 'recovery.json']
      ) ||
    JSON.stringify((await readdir(join(directory, 'profile'))).sort()) !==
      JSON.stringify(receipt.version === 2 ? ['dnaforge.db', 'project'] : ['dnaforge.db'])
  )
    throw new Error('Legacy recovery copy has unexpected or incomplete members.');
  const content = (files: ScientificRecoveryFile[]) =>
    files.map(({ mode: _mode, sourceIdentity: _identity, ...file }) => file);
  if (
    JSON.stringify(
      content(await inventoryScientificRecoveryTree(join(directory, projectMember)))
    ) !== JSON.stringify(content(receipt.files))
  )
    throw new Error('Legacy recovery files changed before publication.');
  for (const [path, digest] of [
    [join(directory, 'profile', 'dnaforge.db'), receipt.database],
    [join(directory, 'RECOVERY.md'), receipt.instructions],
  ] as const) {
    const actual = await hashScientificRecoveryFile(path);
    if (!digest || actual.sha256 !== digest.sha256 || actual.byteLength !== digest.byteLength)
      throw new Error('Legacy recovery database or instructions changed before publication.');
  }
  const db = openScientificRecoveryDatabase(join(directory, 'profile', 'dnaforge.db'), deps);
  try {
    const owner = db
      .prepare('SELECT path, repo_uuid FROM workspaces WHERE id=?')
      .get(receipt.workspaceId) as { path: string; repo_uuid: string | null } | undefined;
    if (
      db.pragma('user_version', { simple: true }) !== 41 ||
      db.pragma('quick_check', { simple: true }) !== 'ok' ||
      (db.pragma('foreign_key_check') as unknown[]).length !== 0 ||
      owner?.path !== receipt.projectPath ||
      owner.repo_uuid !== receipt.workspaceUuid ||
      SCIENTIFIC_TABLES.some((table) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      )
    )
      throw new Error('Legacy recovery database schema, integrity or owner is invalid.');
  } finally {
    db.close();
  }
  return receipt;
}

function assertSavedState(): void {
  if (getDirtyState().hasDirtyWork)
    throw new Error('Save unsaved changes before creating a scientific recovery copy.');
}

export async function listScientificRecoveryCheckpoints(
  db: Database.Database,
  workspaceId: number,
  deps: ScientificRecoveryDependencies = {}
): Promise<ScientificRecoveryCheckpoint[]> {
  const directory = scientificRecoveryDirectory(db);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  );
  if (entries === null) return [];
  const checkpoints: ScientificRecoveryCheckpoint[] = [];
  await syncDirectory(directory);
  for (const entry of entries) {
    if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;

    const path = join(directory, entry.name);
    const header = JSON.parse(
      await readFile(join(path, 'manifest.json'), 'utf8').catch(() => 'null')
    ) as { workspaceId?: unknown } | null;
    if (header?.workspaceId !== workspaceId) continue;
    checkpoints.push(await verifyScientificRecoveryCheckpoint(path, { db, workspaceId, deps }));
  }
  return checkpoints.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function ensureScientificEnrollmentCheckpoint(
  db: Database.Database,
  workspaceId: number,
  deps: ScientificRecoveryDependencies = {}
): Promise<void> {
  assertScientificWorkspaceLocalOnly(db, workspaceId);
  if (db.inTransaction)
    throw new Error('Enrollment recovery cannot borrow a database transaction.');
  const head = db
    .prepare('SELECT head FROM scientific_revision_refs WHERE workspace_id=?')
    .get(workspaceId) as { head: string | null } | undefined;
  if (head?.head != null) return;

  const existing = (await listScientificRecoveryCheckpoints(db, workspaceId, deps)).find(
    (checkpoint) => checkpoint.kind === 'pre-enrollment' && checkpoint.acceptedHead === null
  );
  const baseline =
    existing ??
    (await captureScientificRecoveryCheckpoint({ db, workspaceId, kind: 'pre-enrollment', deps }));
  const snapshot = openScientificRecoveryDatabase(
    join(scientificRecoveryDirectory(db), baseline.id, 'database.db'),
    deps
  );
  try {
    assertScientificLegacyDatabaseCanRelocate({
      db: snapshot,
      workspaceId,
      sourceRoot: baseline.sourceRoot,
    });
  } finally {
    snapshot.close();
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function assertScientificLegacyRegistryHistoryCanRelocate(db: Database.Database): void {
  if (!verifyLimsAuditHashChainInDb(db).ok)
    throw new Error('Legacy recovery requires valid Registry audit history.');
  const roots = db.prepare('SELECT id, path FROM workspaces WHERE path IS NOT NULL').all() as {
    id: number;
    path: string;
  }[];
  const events = db
    .prepare(
      "SELECT event_type, subject_id, workspace_id, before, after FROM lims_audit WHERE subject_table='lims_entity'"
    )
    .all() as {
    event_type: string;
    subject_id: string;
    workspace_id: number | null;
    before: string | null;
    after: string | null;
  }[];
  for (const event of events) {
    for (const side of ['before', 'after'] as const) {
      const text = event[side];
      if (!text) continue;
      const entity = JSON.parse(text) as {
        id?: unknown;
        kind?: unknown;
        workspaceId?: unknown;
        fields?: Record<string, unknown>;
      } | null;
      const fields = entity?.fields;
      if (!fields) continue;
      const sequence = fields.sequence as { mode?: unknown; relPath?: unknown } | undefined;
      const managed = fields._managedSequenceDocument as
        | {
            kind?: unknown;
            packageId?: unknown;
            packageRoot?: unknown;
          }
        | undefined;
      const initialRegistration =
        side === 'after' &&
        event.event_type === 'entity_registered' &&
        event.before === null &&
        typeof entity?.id === 'string' &&
        entity.id === event.subject_id &&
        entity.workspaceId === event.workspace_id;
      const isBoundRegistrationPath = (registeredPath: unknown, fileKind?: string): boolean => {
        if (
          !initialRegistration ||
          typeof registeredPath !== 'string' ||
          !isAbsolute(registeredPath) ||
          registeredPath.split(/[\\/]/u).includes('..')
        )
          return false;
        const binding = db
          .prepare(
            "SELECT workspace_id, path, file_kind FROM catalog_entity_files WHERE entity_id=? AND status='current'"
          )
          .get(event.subject_id) as
          | { workspace_id: number | null; path: string; file_kind: string }
          | undefined;
        const root = roots.find((candidate) => candidate.id === binding?.workspace_id);
        if (
          binding &&
          root &&
          binding.workspace_id === entity?.workspaceId &&
          (fileKind === undefined || binding.file_kind === fileKind) &&
          isAbsolute(binding.path)
        ) {
          const owner = workspaceMutationRootIdentity(root.path),
            path = workspaceMutationRootIdentity(binding.path);
          return (
            path === workspaceMutationRootIdentity(registeredPath) &&
            (path === owner || path.startsWith(`${owner}/`))
          );
        }
        return false;
      };
      const boundRegistration =
        managed?.kind === 'managed-sequence' &&
        managed.packageId === entity?.id &&
        isBoundRegistrationPath(managed.packageRoot);
      const boundNotebookRegistration =
        entity?.kind === 'notebook' &&
        isBoundRegistrationPath(fields.packagePath, 'waypoint-notebook');

      for (const [path, safelyBound] of [
        [fields.packagePath, boundNotebookRegistration],
        [managed?.packageRoot, boundRegistration],
        [sequence?.mode === 'file' ? sequence.relPath : undefined, false],
      ] as const) {
        if (
          !safelyBound &&
          typeof path === 'string' &&
          (isAbsolute(path) ||
            /^[A-Za-z]:[\\/]/u.test(path) ||
            /^file:/iu.test(path) ||
            path.split(/[\\/]/u).includes('..'))
        )
          throw new Error(
            'Legacy recovery cannot safely relocate this Registry history locator. The original project and recovery archives are preserved.'
          );
      }
    }
  }
}

export function assertScientificLegacyDatabaseCanRelocate(input: {
  db: Database.Database;
  workspaceId: number;
  sourceRoot: string;
}): void {
  const { db, workspaceId, sourceRoot } = input;
  const version = db.pragma('user_version', { simple: true });
  if (!LEGACY_RECOVERY_SCHEMAS.has(Number(version)))
    throw new Error(
      'Legacy recovery supports only the qualified scientific schema 42 or 43 to 41 conversion, or the qualified schema 47 or 48 to 41 conversion.'
    );
  const identities = Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scientific_workspace_identities'"
      )
      .get()
  );
  if (
    identities !== (version !== 42) ||
    (version !== 42 &&
      !(db.pragma('table_info(scientific_materialization_jobs)') as { name: string }[]).some(
        (column) => column.name === 'delivery_kind'
      ))
  )
    throw new Error('Legacy recovery scientific identity schema is incomplete or inconsistent.');
  if (version === 47 || version === 48) {
    const queueColumns = new Set(
      (db.pragma('table_info(workspace_sync_queue)') as { name: string }[]).map(
        (column) => column.name
      )
    );
    if (
      !queueColumns.has('accepted_operation_id') ||
      !queueColumns.has('accepted_operation_started_at') ||
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='administration_actions'")
        .get() ||
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='administration_preferences'"
        )
        .get()
    )
      throw new Error(`Legacy recovery schema ${version} is incomplete or inconsistent.`);
  }
  const owner = db.prepare('SELECT path FROM workspaces WHERE id=?').get(workspaceId) as
    | { path: string }
    | undefined;
  if (owner?.path !== sourceRoot)
    throw new Error('Legacy recovery database has a different project owner.');
  assertScientificLegacyRegistryHistoryCanRelocate(db);
  const accepted = db
    .prepare('SELECT head FROM scientific_revision_refs WHERE workspace_id=?')
    .get(workspaceId) as { head: string | null } | undefined;
  if (
    accepted?.head != null ||
    db
      .prepare('SELECT 1 FROM scientific_materialization_jobs WHERE workspace_id=?')
      .get(workspaceId)
  )
    throw new Error('Legacy recovery requires the verified pre-enrollment database.');
}

export function prepareScientificLegacyDatabase(input: {
  db: Database.Database;
  workspaceId: number;
  sourceRoot: string;
  projectPath: string;
  recoveryDirectory: string;
}): void {
  const { db, workspaceId, projectPath, recoveryDirectory } = input;
  assertScientificLegacyDatabaseCanRelocate(input);
  const workspaces = db.prepare('SELECT id, path FROM workspaces WHERE path IS NOT NULL').all() as {
    id: number;
    path: string;
  }[];
  const roots = workspaces
    .map((workspace) => ({
      from: workspaceMutationRootIdentity(workspace.path),
      to:
        workspace.id === workspaceId
          ? projectPath
          : join(recoveryDirectory, 'unavailable-projects', String(workspace.id)),
    }))
    .sort((a, b) => b.from.length - a.from.length);
  const rebase = (text: string): string => {
    if (text.startsWith('file://')) {
      const literal = text.slice('file://'.length);
      const rewritten = rebase(literal);
      if (rewritten !== literal) return `file://${rewritten}`;
      try {
        const decoded = fileURLToPath(text);
        const relocated = rebase(decoded);
        if (relocated !== decoded) return pathToFileURL(relocated).href;
      } catch {
        return text;
      }
      return text;
    }
    const candidate = isAbsolute(text) ? workspaceMutationRootIdentity(text) : text;
    for (const root of roots) {
      if (
        candidate === root.from ||
        candidate.startsWith(`${root.from}/`) ||
        candidate.startsWith(`${root.from}\\`)
      )
        return root.to + candidate.slice(root.from.length);
    }
    return text;
  };
  const rewriteJson = (value: unknown): unknown => {
    if (typeof value === 'string') return rebase(value);
    if (Array.isArray(value)) return value.map(rewriteJson);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, rewriteJson(item)])
      );
    return value;
  };
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // global navigation state can operate on the original profile's behalf.
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map(({ name }) => name);
      const clear = new Set(
        tables.filter(
          (name) =>
            name.startsWith('workspace_sync_') ||
            name.startsWith('agent_') ||
            name.startsWith('chat_') ||
            name.startsWith('org_registry_') ||
            name.startsWith('administration_') ||
            name.endsWith('_outbox') ||
            ['settings', 'conversations', 'compute_jobs'].includes(name)
        )
      );
      for (let changed = true; changed; ) {
        changed = false;
        for (const table of tables) {
          if (
            clear.has(table) ||
            SCIENTIFIC_TABLES.includes(table as (typeof SCIENTIFIC_TABLES)[number])
          )
            continue;
          const references = db.pragma(`foreign_key_list(${quoteIdentifier(table)})`) as {
            table: string;
          }[];
          if (references.some((reference) => clear.has(reference.table))) {
            clear.add(table);
            changed = true;
          }
        }
      }
      db.exec(`DROP TRIGGER IF EXISTS scientific_work_dispatch_bound;
        DROP TRIGGER IF EXISTS scientific_work_project_suspended;`);
      for (const table of clear) db.exec(`DELETE FROM ${quoteIdentifier(table)}`);
      for (const table of SCIENTIFIC_TABLES)
        db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
      for (const table of tables) {
        if (
          clear.has(table) ||
          table === 'lims_audit' ||
          table === 'molecular_catalog_observations' ||
          SCIENTIFIC_TABLES.includes(table as (typeof SCIENTIFIC_TABLES)[number])
        )
          continue;
        const columns = db.pragma(`table_info(${quoteIdentifier(table)})`) as {
          name: string;
          type: string;
        }[];
        for (const column of columns.filter((entry) => /TEXT|CHAR|CLOB/iu.test(entry.type))) {
          const name = quoteIdentifier(column.name),
            target = quoteIdentifier(table);
          const values = db
            .prepare(`SELECT DISTINCT ${name} AS value FROM ${target} WHERE typeof(${name})='text'`)
            .all() as { value: string }[];
          for (const { value } of values) {
            let next = rebase(value);
            if (
              next === value &&
              (value.trimStart().startsWith('[') || value.trimStart().startsWith('{'))
            ) {
              try {
                const parsed: unknown = JSON.parse(value);
                const rewritten = JSON.stringify(rewriteJson(parsed));
                if (rewritten !== JSON.stringify(parsed)) next = rewritten;
              } catch {
                next = value;
              }
            }
            if (next !== value)
              db.prepare(`UPDATE ${target} SET ${name}=? WHERE ${name}=?`).run(next, value);
          }
        }
      }
      db.prepare(
        'UPDATE workspaces SET archived_at=? WHERE id != ? AND archived_at IS NULL AND trashed_at IS NULL'
      ).run(Date.now(), workspaceId);
      db.prepare('UPDATE workspaces SET archived_at=NULL, trashed_at=NULL WHERE id=?').run(
        workspaceId
      );
      db.pragma('user_version = 41');
      if ((db.pragma('foreign_key_check') as unknown[]).length !== 0)
        throw new Error('Legacy recovery would leave inconsistent database references.');
      if (!verifyLimsAuditHashChainInDb(db).ok)
        throw new Error('Legacy recovery would change Registry audit history.');
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  if (db.pragma('quick_check', { simple: true }) !== 'ok')
    throw new Error('Legacy recovery database integrity check failed.');
  db.pragma('journal_mode = DELETE');
}

export async function createScientificLegacyRecovery(input: {
  db: Database.Database;
  workspaceId: number;
  checkpointId?: string;
  beforeSnapshot?: () => void;
  deps?: ScientificRecoveryDependencies;
}): Promise<{
  directory: string;
  projectPath: string;
  profilePath: string;
  sourceCheckpointId: string;
  preservedCurrentCheckpointId: string;
}> {
  const { db, workspaceId, deps = {} } = input;
  if (db.inTransaction) throw new Error('Recovery cannot enter an open transaction.');
  assertSavedState();
  const workspace = db
    .prepare(
      'SELECT path, repo_uuid FROM workspaces WHERE id=? AND archived_at IS NULL AND trashed_at IS NULL'
    )
    .get(workspaceId) as { path: string; repo_uuid: string | null } | undefined;
  if (!workspace) throw new Error('Recovery project is not active.');
  const releaseWorkspace = await acquireWorkspaceSyncMutationLease(workspace.path);
  try {
    const releaseDatabase = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      assertSavedState();
      input.beforeSnapshot?.();
      const currentOwner = db
        .prepare('SELECT path, repo_uuid FROM workspaces WHERE id=?')
        .get(workspaceId) as typeof workspace;
      if (currentOwner?.path !== workspace.path || currentOwner.repo_uuid !== workspace.repo_uuid)
        throw new Error('Recovery workspace ownership changed while waiting.');
      const checkpoints = await listScientificRecoveryCheckpoints(db, workspaceId, deps);
      const baseline = checkpoints.find(
        (checkpoint) =>
          checkpoint.kind === 'pre-enrollment' &&
          checkpoint.acceptedHead === null &&
          (input.checkpointId === undefined || checkpoint.id === input.checkpointId)
      );
      if (!baseline)
        throw new Error('No verified pre-enrollment checkpoint exists for this project.');
      if (!LEGACY_RECOVERY_SCHEMAS.has(baseline.schemaVersion))
        throw new Error('This checkpoint requires a different recovery application.');
      const directory = scientificRecoveryDirectory(db);
      const source = join(directory, baseline.id);
      const preserved = await captureScientificRecoveryCheckpoint({
        db,
        workspaceId,
        kind: 'pre-recovery',
        deps,
      });
      assertSavedState();
      input.beforeSnapshot?.();
      const id = randomUUID(),
        final = join(directory, `legacy-${id}`),
        staging = `${final}.pending`;
      await mkdir(staging, { mode: 0o700 });
      await deps.afterStep?.('recovery-staging-created', staging);
      const profile = join(staging, 'profile');
      await mkdir(profile, { mode: 0o700 });

      const project = join(profile, 'project');
      await copyScientificRecoveryTree(join(source, 'project'), project, baseline.files, deps);
      const databasePath = join(profile, 'dnaforge.db');
      await copyFile(
        join(source, 'database.db'),
        databasePath,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
      );
      const legacyDb = openScientificRecoveryDatabase(databasePath, deps, true);
      try {
        prepareScientificLegacyDatabase({
          db: legacyDb,
          workspaceId,
          sourceRoot: baseline.sourceRoot,
          projectPath: join(final, 'profile', 'project'),
          recoveryDirectory: final,
        });
      } finally {
        legacyDb.close();
      }

      const git = join(project, '.git');
      if (baseline.files.some((file) => file.path === '.git' && file.kind === 'directory')) {
        await rm(join(git, 'hooks'), { recursive: true, force: true });
        await writeFile(
          join(git, 'config'),
          '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n',
          { flag: 'w', mode: 0o600 }
        );
        await (deps.flushFile ?? flushScientificRecoveryFile)(join(git, 'config'));
        await syncDirectory(git);
      }
      const result = {
        directory: final,
        projectPath: join(final, 'profile', 'project'),
        profilePath: join(final, 'profile'),
        sourceCheckpointId: baseline.id,
        preservedCurrentCheckpointId: preserved.id,
      };
      const readme = [
        '# Scientific storage recovery copy',
        '',
        'This is an independent copy of the project before scientific enrollment.',
        'The enrolled original remains active. Its newer scientific history, accepted bytes, unfinished writes, working edits and Git are preserved separately.',
        '',
        `Original project: ${baseline.sourceRoot}`,
        `Recovered project: ${result.projectPath}`,
        `Isolated profile: ${result.profilePath}`,
        `Original checkpoint: ${join(directory, baseline.id)}`,
        `Preserved newer work: ${join(directory, preserved.id)}`,
        '',
        'Use the qualified prior DNAForge build supporting database schema 41.',
        'Launch its executable with the argument --user-data-dir followed by the isolated profile path above. Open the recovered project path in that application.',
        'Do not point the older application at the original profile or restore only database.db into an active profile.',
        'A newer application may upgrade this isolated copy again; the original checkpoint and newer-work archive remain available.',
        '',
        'Cloud bindings and queued cloud work are removed from the isolated profile. Other original projects are unavailable in it.',
        'Registry audit history and molecular observation identities retain their original provenance paths and hashes. Current editable bindings use the recovered project. Historical Git-pin inspection may refer to the original repository; its exact bytes and pins remain in the original checkpoint.',
        'Newer scientific work is retained for recovery in the new application; it is not automatically converted into edits in the old application.',
        '',
      ].join('\n');
      await writeFile(join(staging, 'RECOVERY.md'), readme, { flag: 'wx', mode: 0o600 });
      await (deps.flushFile ?? flushScientificRecoveryFile)(join(staging, 'RECOVERY.md'));
      await (deps.flushFile ?? flushScientificRecoveryFile)(databasePath);
      await syncDirectory(profile);
      await verifyScientificRecoveryCheckpoint(source, { db, workspaceId, deps });
      await verifyScientificRecoveryCheckpoint(join(directory, preserved.id), {
        db,
        workspaceId,
        deps,
      });
      const receipt: LegacyRecoveryReceipt = {
        format: 'dnaforge.legacy-recovery-copy',
        version: 2,
        ...result,
        workspaceId,
        workspaceUuid: workspace.repo_uuid,
        legacySchemaVersion: 41,
        database: await hashScientificRecoveryFile(databasePath),
        instructions: await hashScientificRecoveryFile(join(staging, 'RECOVERY.md')),
        files: await inventoryScientificRecoveryTree(project),
      };
      await writeScientificRecoveryJson(join(staging, 'recovery.json'), receipt, deps);
      await syncDirectory(staging);
      assertSavedState();
      input.beforeSnapshot?.();
      await deps.afterStep?.('before-recovery-publication', staging);
      assertSavedState();
      input.beforeSnapshot?.();
      await verifyScientificLegacyRecoveryCopy(staging, deps, receipt);
      assertSavedState();
      input.beforeSnapshot?.();
      await rename(staging, final);
      await deps.afterStep?.('recovery-renamed', final);
      await syncDirectory(directory);
      return result;
    } finally {
      releaseDatabase();
    }
  } finally {
    releaseWorkspace();
  }
}
