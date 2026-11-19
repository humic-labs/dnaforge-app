import type Database from 'better-sqlite3';
import { createReadStream, lstatSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  unlink,
  rmdir,
  chmod,
  link,
  rename,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { isSafeWorkspaceRelativePath, pathIsAtOrUnder } from '../shared/path-boundary';
import {
  captureWorkspaceSyncBlob,
  hashWorkspaceSyncFileOnDisk,
  materializeWorkspaceSyncFile,
  receiveWorkspaceSyncBlob,
  verifyWorkspaceSyncBlob,
  workspaceSyncBlobPath,
} from './workspace-sync-blob-cache';
import { syncDirectory } from './fs-durability';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';

export const RETAINED_FILE_BLOB_DIRECTORY = 'retained-file-blobs';
type Owner = { workspaceId: number | null; entityId: string; historicalAt?:number };
type Source = Owner & { path: string; blobRoot?: string };
export type SavedFileSourceMember = { relativePath: string } & (
  | { bytes: Uint8Array }
  | { sourcePath: string; expectedSha256?: string }
  | { directory: true }
);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const name = z
  .string()
  .refine(
    (p) => p === '' || (!p.includes('\\') && !p.includes('\0') && isSafeWorkspaceRelativePath(p))
  );
const entry = z.discriminatedUnion('kind', [
  z
    .object({
      relativePath: name,
      kind: z.literal('file'),
      sha256: sha,
      sizeBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ relativePath: name, kind: z.literal('directory') }).strict(),
]);
type Member = z.infer<typeof entry>;
const manifestSchema = z
  .object({ version: z.literal(1), members: z.array(entry).min(1).max(200000) })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
export type SavedFileSourceReceipt = { id: string };
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type SourceRow = {
  id: string;
  workspace_id: number | null;
  entity_id: string;
  source_path: string;
  manifest_sha256: string;
  manifest_json: string;
  status: 'prepared' | 'committed' | 'rejected';
};
const configuredBlobRoots = new WeakMap<Database.Database, () => string>();
export function configureSavedFileBlobRoot(
  db: Database.Database,
  root: string | (() => string)
): void {
  configuredBlobRoots.set(db, typeof root === 'string' ? () => root : root);
}
function blobRoot(db: Database.Database, override?: string): string {
  const configured = override ?? configuredBlobRoots.get(db)?.();
  if (configured) return resolve(configured);
  if (!isAbsolute(db.name))
    throw new Error('An in-memory library requires an explicit retained file blob directory.');
  return join(dirname(db.name), RETAINED_FILE_BLOB_DIRECTORY);
}
function sorted(entries: Member[]): Member[] {
  return entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  );
}
function validateMembers(members: Member[]): Manifest {
  const manifest = manifestSchema.parse({ version: 1, members: sorted(members) });
  if (manifest.members[0].relativePath !== '')
    throw new Error('A retained source must describe its root.');
  const seen = new Map<string, Member['kind']>();
  for (const item of manifest.members) {
    const parent = item.relativePath.split('/').slice(0, -1).join('/');
    if (seen.has(item.relativePath) || (item.relativePath && seen.get(parent) !== 'directory'))
      throw new Error('Duplicate or invalid member in retained file source.');
    seen.set(item.relativePath, item.kind);
  }
  return manifest;
}

async function sourceTree(
  path: string
): Promise<Array<{ relativePath: string; directory: boolean }>> {
  const members: Array<{ relativePath: string; directory: boolean }> = [];
  async function visit(member: string): Promise<void> {
    if (members.length >= 200000)
      throw new Error('File source has too many members for one revision.');
    const target = join(path, member);
    if (member) assertWorkspaceProjectionPathSafe(path, target);
    const stat = await lstat(target);
    if (!stat.isFile() && !stat.isDirectory())
      throw new Error('Retained file sources require regular files and physical directories.');
    members.push({ relativePath: member, directory: stat.isDirectory() });
    if (stat.isDirectory())
      for (const child of (await readdir(target)).sort()) {
        const sub = member ? member + '/' + child : child;
        name.parse(sub);
        await visit(sub);
      }
  }
  await visit('');
  return members;
}

async function captureDisk(path: string, root: string, expected?: string) {
  if (pathIsAtOrUnder(resolve(path), root) || pathIsAtOrUnder(root, resolve(path)))
    throw new Error('The retained source store cannot contain itself.');
  const stat = await lstat(path);
  const identity = await captureWorkspaceSyncBlob(path, {
    cacheRoot: root,
    maxBytes: stat.size,
    expectedIdentity: stat,
    expectedSha256: expected?.replace(/^sha256:/, ''),
  });
  if (expected && identity.sha256 !== expected.replace(/^sha256:/, ''))
    throw new Error('The saved file changed since it was verified. Reload it before saving.');
  return identity;
}

function append(
  db: Database.Database,
  input: Source,
  manifest: Manifest,
  status: 'prepared' | 'committed'
): SavedFileSourceReceipt {
  if (!input.entityId.trim() || !isAbsolute(input.path))
    throw new Error('A saved file source requires its stable identity and absolute path.');
  const json = JSON.stringify(manifest),
    hash = digest(json);
  const result = db.transaction(() => {
    if (status === 'committed') {
      const latest = db
        .prepare(
          "SELECT id,manifest_sha256,manifest_json FROM retained_file_source_revisions WHERE workspace_id IS ? AND entity_id=? AND status='committed' ORDER BY created_at DESC,rowid DESC LIMIT 1"
        )
        .get(input.workspaceId, input.entityId) as SourceRow | undefined;
      if (latest?.manifest_sha256 === hash && latest.manifest_json === json)
        return { id: latest.id };
    }
    const latestTime = db.prepare("SELECT MAX(created_at) FROM retained_file_source_revisions WHERE workspace_id IS ? AND entity_id=? AND status IN ('prepared','committed')").pluck().get(input.workspaceId,input.entityId) as number|null;
    const createdAt=input.historicalAt===undefined ? Math.max(Date.now(),(latestTime??0)+1) :
      Math.min(input.historicalAt,latestTime===null ? Date.now() : latestTime-1);
    const id = randomUUID();
    db.prepare(
      'INSERT INTO retained_file_source_revisions(id,workspace_id,entity_id,source_path,manifest_sha256,manifest_json,status,created_at) VALUES(?,?,?,?,?,?,?,?)'
    ).run(
      id,
      input.workspaceId,
      input.entityId,
      resolve(input.path),
      hash,
      json,
      status,
      createdAt
    );
    return { id };
  })();
  return result;
}

type SourceWithMembers = Source & { members: readonly SavedFileSourceMember[] };

export async function prepareSavedFileSource(
  db: Database.Database,
  input: SourceWithMembers
): Promise<SavedFileSourceReceipt> {
  return append(db, input, await captureMembers(db, input), 'prepared');
}
export async function captureSavedFileMembers(
  db: Database.Database,
  input: SourceWithMembers,
  assertCurrent?: () => void
): Promise<SavedFileSourceReceipt> {
  const commit = await stageSavedFileMembers(db, input);
  assertCurrent?.();
  return commit();
}

export async function stageSavedFileMembers(db: Database.Database, input: SourceWithMembers) {
  const manifest = await captureMembers(db, input);
  return () => append(db, input, manifest, 'committed');
}
async function captureMembers(db: Database.Database, input: SourceWithMembers): Promise<Manifest> {
  const root = blobRoot(db, input.blobRoot),
    members: Member[] = [];
  const directories = new Set<string>();
  for (const candidate of input.members) {
    name.parse(candidate.relativePath);
    if (candidate.relativePath) {
      directories.add('');
      const segments = candidate.relativePath.split('/');
      for (let n = 1; n < segments.length; n++) directories.add(segments.slice(0, n).join('/'));
    }
    if ('directory' in candidate) {
      directories.add(candidate.relativePath);
      continue;
    }
    if ('bytes' in candidate) {
      const bytes = Buffer.from(candidate.bytes);
      const identity = { sha256: digest(bytes), sizeBytes: bytes.length };
      await receiveWorkspaceSyncBlob([bytes], identity, { cacheRoot: root });
      members.push({ relativePath: candidate.relativePath, kind: 'file', ...identity });
    } else {
      const identity = await captureDisk(candidate.sourcePath, root, candidate.expectedSha256);
      members.push({ relativePath: candidate.relativePath, kind: 'file', ...identity });
    }
  }
  for (const path of directories) members.push({ relativePath: path, kind: 'directory' });
  return validateMembers(members);
}

export async function captureSavedFileSource(
  db: Database.Database,
  input: Source & { expectedSha256?: string }
): Promise<SavedFileSourceReceipt> {
  const stage = await stageExistingFileSource(db, input.path, input.expectedSha256, input.blobRoot);
  return stage(input);
}

export async function stageExistingFileSource(
  db: Database.Database,
  path: string,
  expectedSha256?: string,
  directory?: string
): Promise<(owner: Owner) => SavedFileSourceReceipt> {
  const root = blobRoot(db, directory),
    members: Member[] = [];
  const tree = await sourceTree(path);
  if (expectedSha256 && tree[0].directory)
    throw new Error(
      'A directory requires an expected package manifest instead of a file checksum.'
    );
  for (const member of tree) {
    if (member.directory) members.push({ relativePath: member.relativePath, kind: 'directory' });
    else
      members.push({
        relativePath: member.relativePath,
        kind: 'file',
        ...(await captureDisk(join(path, member.relativePath), root, expectedSha256)),
      });
  }
  const manifest = validateMembers(members);
  if (tree[0].directory && !(await matchesWorkingSource(path, manifest)))
    throw new Error('Package members changed while retaining the saved source.');
  return (owner) => append(db, { ...owner, path }, manifest, 'committed');
}

function recordedManifest(row: SourceRow): Manifest {
  if (digest(row.manifest_json) !== row.manifest_sha256)
    throw new Error('Retained source manifest failed verification.');
  return validateMembers(manifestSchema.parse(JSON.parse(row.manifest_json)).members);
}
export function commitSavedFileSource(
  db: Database.Database,
  receipt: SavedFileSourceReceipt
): void {
  const changed = db
    .prepare(
      "UPDATE retained_file_source_revisions SET status='committed' WHERE id=? AND status='prepared'"
    )
    .run(receipt.id);
  if (
    !changed.changes &&
    !db
      .prepare("SELECT 1 FROM retained_file_source_revisions WHERE id=? AND status='committed'")
      .get(receipt.id)
  )
    throw new Error('The saved file publication has no current receipt.');
}
export function rejectSavedFileSource(
  db: Database.Database,
  receipt: SavedFileSourceReceipt
): void {
  db.prepare(
    "UPDATE retained_file_source_revisions SET status='rejected' WHERE id=? AND status='prepared'"
  ).run(receipt.id);
}
async function matchesWorkingSource(path: string, manifest: Manifest): Promise<boolean> {
  let tree: Awaited<ReturnType<typeof sourceTree>>;
  try {
    tree = await sourceTree(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  if (tree.length !== manifest.members.length) return false;
  const current = new Map(tree.map((m) => [m.relativePath, m]));
  for (const member of manifest.members) {
    const actual = current.get(member.relativePath);
    if (!actual || actual.directory !== (member.kind === 'directory')) return false;
    if (member.kind === 'file') {
      const identity = await hashWorkspaceSyncFileOnDisk(join(path, member.relativePath));
      if (identity.sha256 !== member.sha256 || identity.sizeBytes !== member.sizeBytes)
        return false;
    }
  }
  return true;
}
export function recordSavedFilePublicationWitness(
  db: Database.Database,
  receipt: SavedFileSourceReceipt,
  stagedPath: string
): void {
  const stage = lstatSync(stagedPath, { bigint: true });
  if (!stage.isFile() && !stage.isDirectory())
    throw new Error('The publication witness must be a physical file or directory.');
  const witness = db.prepare(
    "INSERT INTO retained_file_publication_witnesses(revision_id,device,inode,birth_ns) SELECT id,?,?,? FROM retained_file_source_revisions WHERE id=? AND status='prepared'"
  ).run(String(stage.dev), String(stage.ino), String(stage.birthtimeNs), receipt.id);
  if (witness.changes !== 1) throw new Error('The saved source is no longer awaiting publication.');
}
export async function recoverPendingSavedFileSources(
  db: Database.Database,
  input: {
    workspaceId: number | null;
    blobRoot?: string;
    path?: string;
    entityId?: string;
    assertCurrent?: () => void;
  }
): Promise<void> {
  const root = blobRoot(db, input.blobRoot);
  const rows = db
    .prepare(
      "SELECT * FROM retained_file_source_revisions WHERE workspace_id IS ? AND status='prepared' AND (? IS NULL OR source_path=?) AND (? IS NULL OR entity_id=?) ORDER BY rowid"
    )
    .all(
      input.workspaceId,
      input.path ?? null,
      input.path ?? null,
      input.entityId ?? null,
      input.entityId ?? null
    ) as SourceRow[];
  for (const row of rows) {
    const witness = db
      .prepare(
        'SELECT device,inode,birth_ns FROM retained_file_publication_witnesses WHERE revision_id=?'
      )
      .get(row.id) as { device: string; inode: string; birth_ns: string } | undefined;
    if (!witness) continue;
    const installed = await lstat(row.source_path, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    );
    if (
      !installed ||
      String(installed.dev) !== witness.device ||
      String(installed.ino) !== witness.inode ||
      String(installed.birthtimeNs) !== witness.birth_ns
    )
      continue;
    const manifest = recordedManifest(row);
    if (!(await matchesWorkingSource(row.source_path, manifest))) continue;
    for (const member of manifest.members)
      if (member.kind === 'file') await verifyWorkspaceSyncBlob(member, { cacheRoot: root });
    input.assertCurrent?.();
    commitSavedFileSource(db, { id: row.id });
  }
}

export async function restoreSavedFileSource(
  db: Database.Database,
  input: Owner & {
    revisionId?: string;
    destination: string;
    blobRoot?: string;
    assertCurrent?: () => void;
  }
): Promise<SavedFileSourceReceipt> {
  const source = db
    .prepare(
      "SELECT * FROM retained_file_source_revisions WHERE workspace_id IS ? AND entity_id=? AND status='committed' AND (? IS NULL OR id=?) ORDER BY created_at DESC,rowid DESC LIMIT 1"
    )
    .get(input.workspaceId, input.entityId, input.revisionId ?? null, input.revisionId ?? null) as
    | SourceRow
    | undefined;
  if (!source) throw new Error('No committed source revision is available for this entity.');
  const root = blobRoot(db, input.blobRoot),
    manifest = recordedManifest(source);
  if (!isAbsolute(input.destination) || !basename(input.destination))
    throw new Error('A restore requires an absolute, unoccupied destination.');
  const parent = await realpath(dirname(input.destination)),
    path = join(parent, basename(input.destination));
  if (pathIsAtOrUnder(path, root) || pathIsAtOrUnder(root, path))
    throw new Error('Cannot restore into the retained source store.');
  for (const m of manifest.members)
    if (m.kind === 'file') await verifyWorkspaceSyncBlob(m, { cacheRoot: root });
  const directories: string[] = [];
  const createdFiles: Array<{ path: string; dev: number; ino: number; sha256: string }> = [];
  try {
    for (const member of manifest.members) {
      input.assertCurrent?.();
      const dest = join(path, member.relativePath);
      assertWorkspaceProjectionPathSafe(parent, dest);
      if (member.kind === 'directory') {
        await mkdir(dest, { mode: 0o700 });
        directories.push(dest);
      } else {
        await materializeWorkspaceSyncFile({ ...member, encoding: 'blob', content: '' }, dest, {
          cacheRoot: root,
        });
        const identity = await lstat(dest);
        createdFiles.push({
          path: dest,
          dev: identity.dev,
          ino: identity.ino,
          sha256: member.sha256,
        });
      }
    }
    for (const dir of directories.reverse()) await syncDirectory(dir);
    input.assertCurrent?.();
    await syncDirectory(parent);
  } catch (error) {
    for (const item of createdFiles.reverse()) {
      const current = await lstat(item.path).catch(() => null);
      if (
        current?.dev === item.dev &&
        current?.ino === item.ino &&
        (await hashWorkspaceSyncFileOnDisk(item.path)).sha256 === item.sha256
      )
        await unlink(item.path);
    }
    for (const dir of directories.sort((a, b) => b.length - a.length))
      await rmdir(dir).catch(() => {});
    throw error;
  }
  return { id: source.id };
}

export async function prepareAppendedSavedFileSource(
  db: Database.Database,
  input: Source & { prior: SavedFileSourceReceipt; suffix: Uint8Array }
): Promise<{ receipt: SavedFileSourceReceipt; sha256: string }> {
  const row = db
    .prepare(
      "SELECT * FROM retained_file_source_revisions WHERE id=? AND entity_id=? AND workspace_id IS ? AND status='committed'"
    )
    .get(input.prior.id, input.entityId, input.workspaceId) as SourceRow | undefined;
  if (!row) throw new Error('Appending needs an accepted prior file revision.');
  const member = recordedManifest(row).members[0];
  if (member.kind !== 'file') throw new Error('Appending needs a single saved file.');
  const root = blobRoot(db, input.blobRoot);
  const source = await workspaceSyncBlobPath(member.sha256, root);
  const suffix = Buffer.from(input.suffix);
  const combined = createHash('sha256'),
    prior = createHash('sha256');
  for await (const chunk of createReadStream(source)) {
    combined.update(chunk);
    prior.update(chunk);
  }
  if (prior.digest('hex') !== member.sha256) throw new Error('The retained append source changed.');
  const identity = {
    sha256: combined.update(suffix).digest('hex'),
    sizeBytes: member.sizeBytes + suffix.length,
  };
  async function* chunks() {
    yield* createReadStream(source);
    yield suffix;
  }
  await receiveWorkspaceSyncBlob(chunks(), identity, { cacheRoot: root });
  return {
    receipt: append(
      db,
      input,
      validateMembers([{ kind: 'file', relativePath: '', ...identity }]),
      'prepared'
    ),
    sha256: identity.sha256,
  };
}

export function listSavedFileVersions(
  db: Database.Database,
  input: Owner & { offset: number; limit: number }
) {
  const rows = db
    .prepare(
      "SELECT *,created_at AS createdAt FROM retained_file_source_revisions WHERE workspace_id IS ? AND entity_id=? AND status='committed' ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?"
    )
    .all(input.workspaceId, input.entityId, input.limit + 1, input.offset) as Array<
    SourceRow & { createdAt: number }
  >;
  return {
    versions: rows.slice(0, input.limit).map((row) => {
      const manifest = recordedManifest(row);
      return {
        id: row.id,
        createdAt: row.createdAt,
        sha256: row.manifest_sha256,
        members: manifest.members.length,
        sizeBytes: manifest.members.reduce((n, m) => n + (m.kind === 'file' ? m.sizeBytes : 0), 0),
      };
    }),
    nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
  };
}

export function stageRetainedSourceBinding(
  db: Database.Database,
  verified: Owner,
  sourcePath: string
) {
  const row = db
    .prepare(
      "SELECT * FROM retained_file_source_revisions WHERE workspace_id IS ? AND entity_id=? AND status='committed' ORDER BY created_at DESC,rowid DESC LIMIT 1"
    )
    .get(verified.workspaceId, verified.entityId) as SourceRow | undefined;
  if (!row) throw new Error('The package owner did not publish a committed source manifest.');
  const manifest = recordedManifest(row);
  return (owner: Owner) => append(db, { ...owner, path: sourcePath }, manifest, 'committed');
}

export async function publishRetainedFileReplacement(
  db: Database.Database,
  input: {
    receipt: SavedFileSourceReceipt;
    prior?: SavedFileSourceReceipt;
    path: string;
    blobRoot?: string;
    assertCurrent: () => void;
  }
): Promise<void> {
  const load = (id: string) => {
    const row = db.prepare('SELECT * FROM retained_file_source_revisions WHERE id=?').get(id) as
      | SourceRow
      | undefined;
    if (!row) throw new Error('The file source revision is unavailable.');
    const member = recordedManifest(row).members[0];
    if (member.kind !== 'file')
      throw new Error('A raw file write cannot replace a package directory.');
    return member;
  };
  const member = load(input.receipt.id),
    before = input.prior && load(input.prior.id);
  const tmp = join(dirname(input.path), '.dnaforge-file-' + randomUUID() + '.pending');
  const root = blobRoot(db, input.blobRoot);
  await materializeWorkspaceSyncFile({ ...member, encoding: 'blob', content: '' }, tmp, {
    cacheRoot: root,
  });
  try {
    if (before) {
      const current = await lstat(input.path);
      if (
        !current.isFile() ||
        !(current.mode & 0o222) ||
        (await hashWorkspaceSyncFileOnDisk(input.path)).sha256 !== before.sha256
      )
        throw new Error('Linked file changed before the replacement was admitted.');
      await chmod(tmp, current.mode & 0o777);
    }
    input.assertCurrent();
    recordSavedFilePublicationWitness(db, input.receipt, tmp);
    if (before) await rename(tmp, input.path);
    else await link(tmp, input.path);
    await syncDirectory(dirname(input.path));
  } finally {
    await unlink(tmp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
