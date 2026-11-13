import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { syncDirectory } from './fs-durability';
import { defineBlob } from '@waypoint/workspace-revisions';
import { importCanonicalRecords } from '@waypoint/workspace-revisions/codec';
import { scientificHistoryWorkspaceIdentity } from './scientific-history-identity';

export interface ScientificRecoveryFile {
  path: string;
  kind: 'directory' | 'file';
  mode: number;
  sha256?: string;
  byteLength?: number;
  sourceIdentity?: string;
}

export interface ScientificRecoveryCheckpoint {
  format: 'dnaforge.scientific-recovery';
  version: 1;
  id: string;
  kind: 'pre-enrollment' | 'pre-recovery';
  createdAt: number;
  workspaceId: number;
  workspaceUuid: string | null;
  sourceRoot: string;
  schemaVersion: number;
  acceptedHead: string | null;
  database: { sha256: string; byteLength: number };
  files: ScientificRecoveryFile[];
}

export interface ScientificRecoveryDependencies {
  openDatabase?: (path: string) => Database.Database;
  afterStep?: (step: string, path: string) => void | Promise<void>;
  flushFile?: (path: string) => Promise<void>;
}

const FORMAT = 'dnaforge.scientific-recovery';
const ID = /^[0-9a-f-]{36}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

export function scientificRecoveryDirectory(db: Database.Database): string {
  if (!isAbsolute(db.name)) throw new Error('Scientific recovery requires a persistent database.');
  return join(realpathSync(dirname(db.name)), 'scientific-recovery');
}

export async function flushScientificRecoveryFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Recovery member is not a regular file.');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function hashScientificRecoveryFile(path: string) {
  if ((await realpath(path)) !== resolve(path))
    throw new Error('Recovery member is a filesystem alias.');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`Recovery requires a regular file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const opened = await handle.stat();
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
    await handle.close();
    throw new Error(`Recovery source changed before reading: ${path}`);
  }
  const stream = handle.createReadStream();
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    byteLength += chunk.length;
  }
  const after = await lstat(path);
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    byteLength !== before.size
  )
    throw new Error(`Recovery source changed while reading: ${path}`);
  return { sha256: hash.digest('hex'), byteLength };
}

function below(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function safePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !isAbsolute(path) &&
    !/^[a-z]:/iu.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export async function inventoryScientificRecoveryTree(
  root: string
): Promise<ScientificRecoveryFile[]> {
  if ((await realpath(root)) !== resolve(root))
    throw new Error('Recovery source cannot be a filesystem alias.');
  const files: ScientificRecoveryFile[] = [];
  const paths = new Set<string>();
  const walk = async (directory: string, prefix: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const key = path.normalize('NFC').toLocaleLowerCase('en-US');
      if (!safePath(path) || paths.has(key)) throw new Error(`Recovery path is ambiguous: ${path}`);
      paths.add(key);
      const absolute = join(root, path);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error(`Recovery cannot capture a link or special file: ${path}`);
      const mode = stat.mode & 0o777;
      const sourceIdentity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      if (stat.isDirectory()) {
        files.push({ path, kind: 'directory', mode, sourceIdentity });
        await walk(absolute, path);
      } else {
        files.push({
          path,
          kind: 'file',
          mode,
          sourceIdentity,
          ...(await hashScientificRecoveryFile(absolute)),
        });
      }
    }
  };
  await walk(root, '');
  return files;
}

export async function assertSelfContainedScientificGit(root: string): Promise<void> {
  const git = join(root, '.git');
  const stat = await lstat(git).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Recovery requires a self-contained Git directory, not a linked worktree.');
  for (const member of [
    'commondir',
    'objects/info/alternates',
    'objects/info/http-alternates',
    'worktrees',
    'modules',
  ]) {
    if (
      await lstat(join(git, member)).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return false;
          throw e;
        }
      )
    )
      throw new Error(`Recovery cannot depend on external Git storage: ${member}`);
  }
  const config = await readFile(join(git, 'config'), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return '';
    throw e;
  });
  if (/^\s*(worktree|hooksPath)\s*=/imu.test(config) || /^\s*\[include(?:If)?\b/imu.test(config))
    throw new Error('Recovery cannot depend on external Git configuration or hooks.');
  if (/^\s*\[extensions\]/imu.test(config))
    throw new Error(
      'Recovery currently supports ordinary SHA-1 Git repositories without extensions.'
    );
}

export async function copyScientificRecoveryTree(
  source: string,
  target: string,
  files: readonly ScientificRecoveryFile[],
  deps: ScientificRecoveryDependencies = {}
): Promise<void> {
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const file of files) {
    const destination = join(target, file.path);
    if (file.kind === 'directory') await mkdir(destination, { mode: 0o700 });
    else {
      const original = join(source, file.path);
      await copyFile(original, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(destination, 0o600 | (file.mode & 0o100));
      const [from, to] = await Promise.all([lstat(original), lstat(destination)]);
      if (!from.isFile() || !to.isFile() || (from.ino === to.ino && from.dev === to.dev))
        throw new Error('Recovery copy is not independent.');
      const actual = await hashScientificRecoveryFile(destination);
      if (actual.sha256 !== file.sha256 || actual.byteLength !== file.byteLength)
        throw new Error(`Recovery copy differs from its source: ${file.path}`);
      await (deps.flushFile ?? flushScientificRecoveryFile)(destination);
    }
    await deps.afterStep?.('copied-member', file.path);
  }
  for (const file of [...files].reverse())
    if (file.kind === 'directory') await syncDirectory(join(target, file.path));
  await syncDirectory(target);
}

export function openScientificRecoveryDatabase(
  path: string,
  deps: ScientificRecoveryDependencies = {},
  writable = false
) {
  return (
    deps.openDatabase?.(path) ?? new Database(path, { fileMustExist: true, readonly: !writable })
  );
}

function scientificHead(db: Database.Database, workspaceId: number): string | null {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scientific_revision_refs'")
      .get()
  )
    return null;
  return (
    (
      db
        .prepare('SELECT head FROM scientific_revision_refs WHERE workspace_id=?')
        .get(workspaceId) as { head: string | null } | undefined
    )?.head ?? null
  );
}

function verifyScientificHistory(db: Database.Database): void {
  const tables = [
    'scientific_revision_refs',
    'scientific_revision_records',
    'scientific_revision_blobs',
    'scientific_materialization_jobs',
  ];
  const present = tables.filter((name) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  );
  if (present.length === 0) return;
  if (present.length !== tables.length)
    throw new Error('Recovery scientific schema is incomplete.');
  const owners = db
    .prepare(`SELECT workspace_id FROM ${tables.join(' UNION SELECT workspace_id FROM ')}`)
    .all() as { workspace_id: number }[];
  for (const { workspace_id: workspaceId } of owners) {
    const identity = scientificHistoryWorkspaceIdentity(db, workspaceId);
    const records = db
      .prepare(
        'SELECT record_kind AS kind, record_id AS id, canonical_json AS canonicalJson FROM scientific_revision_records WHERE workspace_id=? ORDER BY record_id'
      )
      .all(workspaceId) as { kind: string; id: string; canonicalJson: string }[];
    const refs = db
      .prepare(
        'SELECT ref_name AS name, head FROM scientific_revision_refs WHERE workspace_id=? ORDER BY ref_name'
      )
      .all(workspaceId) as { name: string; head: string | null }[];
    const graph = importCanonicalRecords({
      formatVersion: 1,
      workspaceId: identity,
      records,
      refs,
    });
    if (!graph.ok)
      throw new Error(`Recovery scientific accepted history is invalid: ${graph.error.kind}`);
    const blobs = db
      .prepare(
        'SELECT blob_hash, byte_length, bytes FROM scientific_revision_blobs WHERE workspace_id=?'
      )
      .all(workspaceId) as { blob_hash: string; byte_length: number; bytes: Buffer }[];
    const available = new Map<string, number>(
      blobs.map((blob): [string, number] => {
        if (
          blob.bytes.length !== blob.byte_length ||
          defineBlob(blob.bytes).hash !== blob.blob_hash
        )
          throw new Error('Recovery scientific blob integrity failure.');
        return [blob.blob_hash, blob.byte_length];
      })
    );
    for (const record of records) {
      if (record.kind !== 'resource-state') continue;
      const state = JSON.parse(record.canonicalJson) as {
        layout: string;
        blob: { hash: string; byteLength: number };
        members: { blob: { hash: string; byteLength: number } }[];
      };
      for (const blob of state.layout === 'file'
        ? [state.blob]
        : state.members.map((member) => member.blob))
        if (available.get(blob.hash) !== blob.byteLength)
          throw new Error('Recovery scientific history is missing a complete blob.');
    }
  }
}

export async function captureScientificRecoveryCheckpoint(input: {
  db: Database.Database;
  workspaceId: number;
  kind: ScientificRecoveryCheckpoint['kind'];
  deps?: ScientificRecoveryDependencies;
}): Promise<ScientificRecoveryCheckpoint> {
  const { db, workspaceId, kind, deps = {} } = input;
  if (db.inTransaction) throw new Error('Recovery cannot capture an open database transaction.');
  const owner = db.prepare('SELECT path, repo_uuid FROM workspaces WHERE id=?').get(workspaceId) as
    | { path: string; repo_uuid: string | null }
    | undefined;
  if (!owner || !isAbsolute(owner.path))
    throw new Error('Recovery workspace has no absolute native root.');
  const root = await realpath(owner.path);
  if (root !== resolve(owner.path)) throw new Error('Recovery workspace root is an alias.');
  const directory = scientificRecoveryDirectory(db);
  const owners = db.prepare('SELECT path FROM workspaces WHERE path IS NOT NULL').all() as {
    path: string;
  }[];
  if (owners.some((row) => below(resolve(row.path), directory)) || below(directory, root))
    throw new Error('Recovery storage must be outside every project source.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== resolve(directory))
    throw new Error('Recovery storage is a filesystem alias.');
  await syncDirectory(dirname(directory));
  await assertSelfContainedScientificGit(root);
  const before = await inventoryScientificRecoveryTree(root);
  for (const file of before) {
    if (file.path.endsWith('/.git')) {
      if (file.kind !== 'directory')
        throw new Error('Recovery cannot retain a nested Git pointer to another repository.');
      await assertSelfContainedScientificGit(join(root, file.path.slice(0, -5)));
    }
    if (/(?:^|\/)\.git\/.*\.lock$/u.test(file.path))
      throw new Error(
        'A Git operation is pending. Wait for it to finish before enabling scientific storage.'
      );
  }
  const head = scientificHead(db, workspaceId);
  if (kind === 'pre-enrollment' && head !== null)
    throw new Error('An enrolled project cannot create a pre-enrollment recovery point.');
  const id = randomUUID();
  const staging = join(directory, `${id}.pending`);
  await mkdir(staging, { mode: 0o700 });
  await deps.afterStep?.('staging-created', staging);
  const dataVersion = db.pragma('data_version', { simple: true });
  const changes = db.prepare('SELECT total_changes() AS count').get() as { count: number };
  const databasePath = join(staging, 'database.db');
  await db.backup(databasePath);
  await (deps.flushFile ?? flushScientificRecoveryFile)(databasePath);
  await deps.afterStep?.('database-copied', databasePath);
  const captured = openScientificRecoveryDatabase(databasePath, deps, true);
  let schemaVersion: number;
  try {
    captured.pragma('journal_mode = DELETE');
    schemaVersion = captured.pragma('user_version', { simple: true }) as number;
    if (
      captured.pragma('quick_check', { simple: true }) !== 'ok' ||
      (captured.pragma('foreign_key_check') as unknown[]).length !== 0
    )
      throw new Error('Recovery database integrity check failed.');
    const copiedOwner = captured
      .prepare('SELECT path, repo_uuid FROM workspaces WHERE id=?')
      .get(workspaceId) as typeof owner;
    if (
      !copiedOwner ||
      copiedOwner.path !== owner.path ||
      copiedOwner.repo_uuid !== owner.repo_uuid ||
      scientificHead(captured, workspaceId) !== head
    )
      throw new Error('Recovery database ownership changed during capture.');
  } finally {
    captured.close();
  }
  await (deps.flushFile ?? flushScientificRecoveryFile)(databasePath);
  await copyScientificRecoveryTree(root, join(staging, 'project'), before, deps);
  await deps.afterStep?.('tree-copied', staging);
  const after = await inventoryScientificRecoveryTree(root);
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    scientificHead(db, workspaceId) !== head ||
    db.pragma('data_version', { simple: true }) !== dataVersion ||
    (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count !==
      changes.count
  )
    throw new Error(
      'Recovery source changed during capture. No checkpoint was published. Wait for project and background database activity to settle, then retry.'
    );
  const manifest: ScientificRecoveryCheckpoint = {
    format: FORMAT,
    version: 1,
    id,
    kind,
    createdAt: Date.now(),
    workspaceId,
    workspaceUuid: owner.repo_uuid,
    sourceRoot: root,
    schemaVersion,
    acceptedHead: head,
    database: await hashScientificRecoveryFile(databasePath),
    files: before,
  };
  await writeScientificRecoveryJson(join(staging, 'manifest.json'), manifest, deps);
  await syncDirectory(staging);
  await verifyScientificRecoveryCheckpoint(staging, { db, workspaceId, deps, allowStaging: true });
  await deps.afterStep?.('before-checkpoint-publication', staging);
  await verifyScientificRecoveryCheckpoint(staging, { db, workspaceId, deps, allowStaging: true });
  if (
    JSON.stringify(before) !== JSON.stringify(await inventoryScientificRecoveryTree(root)) ||
    db.pragma('data_version', { simple: true }) !== dataVersion ||
    (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count !==
      changes.count
  )
    throw new Error('Recovery source changed before publication. No checkpoint was published.');
  await rename(staging, join(directory, id));
  await deps.afterStep?.('checkpoint-renamed', join(directory, id));
  await syncDirectory(directory);
  return manifest;
}

export async function writeScientificRecoveryJson(
  path: string,
  value: unknown,
  deps: ScientificRecoveryDependencies = {}
) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
  } finally {
    await handle.close();
  }
  await (deps.flushFile ?? flushScientificRecoveryFile)(path);
}

export async function verifyScientificRecoveryCheckpoint(
  directory: string,
  input: {
    db: Database.Database;
    workspaceId: number;
    deps?: ScientificRecoveryDependencies;
    allowStaging?: boolean;
  }
): Promise<ScientificRecoveryCheckpoint> {
  const { db, workspaceId, deps = {} } = input;
  if ((await realpath(directory)) !== resolve(directory))
    throw new Error('Checkpoint directory is an alias.');
  const name = relative(scientificRecoveryDirectory(db), directory);
  if (!ID.test(name) && !(input.allowStaging && ID.test(name.replace(/\.pending$/u, ''))))
    throw new Error('Checkpoint is outside its native recovery owner.');
  const manifestPath = join(directory, 'manifest.json');
  const members = (await readdir(directory)).sort();
  if (JSON.stringify(members) !== JSON.stringify(['database.db', 'manifest.json', 'project']))
    throw new Error('Recovery checkpoint has unexpected or incomplete members.');
  const stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES)
    throw new Error('Recovery manifest is invalid.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ScientificRecoveryCheckpoint;
  const owner = db.prepare('SELECT path, repo_uuid FROM workspaces WHERE id=?').get(workspaceId) as
    | { path: string; repo_uuid: string | null }
    | undefined;
  if (
    !manifest ||
    manifest.format !== FORMAT ||
    manifest.version !== 1 ||
    !ID.test(manifest.id) ||
    name !== `${manifest.id}${input.allowStaging && name.endsWith('.pending') ? '.pending' : ''}` ||
    !['pre-enrollment', 'pre-recovery'].includes(manifest.kind) ||
    !owner ||
    manifest.workspaceId !== workspaceId ||
    manifest.workspaceUuid !== owner.repo_uuid ||
    manifest.sourceRoot !== resolve(owner.path) ||
    !Number.isSafeInteger(manifest.schemaVersion) ||
    !Number.isSafeInteger(manifest.createdAt) ||
    !manifest.database ||
    !HASH.test(manifest.database.sha256) ||
    !Number.isSafeInteger(manifest.database.byteLength) ||
    !Array.isArray(manifest.files) ||
    manifest.files.some(
      (file) =>
        !safePath(file.path) ||
        !['file', 'directory'].includes(file.kind) ||
        !Number.isSafeInteger(file.mode) ||
        (file.kind === 'file' &&
          (!HASH.test(file.sha256 ?? '') || !Number.isSafeInteger(file.byteLength)))
    )
  )
    throw new Error('Recovery manifest version, scope or file contract is invalid.');
  const actual = await hashScientificRecoveryFile(join(directory, 'database.db'));
  if (
    actual.sha256 !== manifest.database.sha256 ||
    actual.byteLength !== manifest.database.byteLength
  )
    throw new Error('Recovery database differs from its complete checkpoint.');
  const tree = await inventoryScientificRecoveryTree(join(directory, 'project'));

  const content = (files: ScientificRecoveryFile[]) =>
    files.map(({ mode: _mode, sourceIdentity: _identity, ...file }) => file);
  if (JSON.stringify(content(tree)) !== JSON.stringify(content(manifest.files)))
    throw new Error('Recovery files differ from their complete checkpoint.');
  for (const suffix of ['-wal', '-shm', '-journal'])
    if (
      await lstat(join(directory, `database.db${suffix}`)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      )
    )
      throw new Error('A complete recovery database cannot have mutable sidecars.');
  const snapshot = openScientificRecoveryDatabase(join(directory, 'database.db'), deps);
  try {
    const archivedOwner = snapshot
      .prepare('SELECT path, repo_uuid FROM workspaces WHERE id=?')
      .get(workspaceId) as typeof owner;
    if (
      snapshot.pragma('quick_check', { simple: true }) !== 'ok' ||
      (snapshot.pragma('foreign_key_check') as unknown[]).length !== 0 ||
      snapshot.pragma('user_version', { simple: true }) !== manifest.schemaVersion ||
      !archivedOwner ||
      archivedOwner.path !== owner.path ||
      archivedOwner.repo_uuid !== owner.repo_uuid ||
      scientificHead(snapshot, workspaceId) !== manifest.acceptedHead
    )
      throw new Error('Recovery database schema, integrity or scientific owner is invalid.');
    verifyScientificHistory(snapshot);
  } finally {
    snapshot.close();
  }
  return manifest;
}
