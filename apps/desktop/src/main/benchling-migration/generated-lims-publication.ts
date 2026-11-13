import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

import { assertWorkspaceProjectionPathSafe } from '../workspace-projection-boundary';
import { materializeLimsGitReadableExportInDb } from '../lims-git-export';
import { syncDirectory } from '../fs-durability';
import { benchlingMigrationActionJournalRelativePath } from './action-journal';

type GeneratedFile = Readonly<{ relativePath: string; sha256: string; priorSha256: string | null }>;
type Publication = Readonly<{
  schema: 'dnaforge.migration-lims-publication.v1';
  actionId: string;
  files: readonly GeneratedFile[];
}>;
const ALLOWED_FILE =
  /^\.waypoint\/lims\/(?:manifest\.json|sheets\/oligos\.csv|log\/\d{4}-\d{2}\.jsonl)$/u;

export async function publishActionLimsExport(input: {
  db: Database.Database;
  workspacePath: string;
  workspaceDbId: number;
  actionId: string;
}): Promise<void> {
  if (input.db.inTransaction)
    throw new Error('Generated LIMS publication requires committed catalog state.');
  const journalPath = publicationPath(input.workspacePath, input.actionId);
  let publication = await readPublication(input.workspacePath, input.actionId);
  const stageRoot = `${journalPath}.staged`;
  if (!publication) {
    assertWorkspaceProjectionPathSafe(input.workspacePath, stageRoot);
    await rm(stageRoot, { recursive: true, force: true });
    await mkdir(stageRoot, { recursive: true });
    materializeLimsGitReadableExportInDb(input.db, {
      workspaceId: input.workspaceDbId,
      outputRoot: stageRoot,
    });
    const files: GeneratedFile[] = [];
    for (const relativePath of await listGeneratedFiles(stageRoot)) {
      const bytes = await readFile(join(stageRoot, relativePath));
      const priorSha256 = await fileDigest(input.workspacePath, relativePath);
      if (priorSha256) {
        const backup = join(stageRoot, 'preimages', relativePath);
        await mkdir(dirname(backup), { recursive: true });
        await copyFile(join(input.workspacePath, relativePath), backup);
        if (digest(await readFile(backup)) !== priorSha256)
          throw new Error('Generated LIMS preimage changed during reservation.');
      }
      files.push({ relativePath, sha256: digest(bytes), priorSha256 });
    }
    publication = {
      schema: 'dnaforge.migration-lims-publication.v1',
      actionId: input.actionId,
      files,
    };
    await durableWrite(journalPath, Buffer.from(JSON.stringify(publication)));
  }
  for (const file of publication.files) {
    const stagedBytes = await readFile(join(stageRoot, file.relativePath));
    if (digest(stagedBytes) !== file.sha256)
      throw new Error('Generated LIMS staging bytes changed.');
    const current = await fileDigest(input.workspacePath, file.relativePath);
    if (current === file.sha256) continue;
    if (current !== file.priorSha256)
      throw new Error('Generated LIMS destination changed after reservation.');
    const destination = join(input.workspacePath, file.relativePath);
    assertWorkspaceProjectionPathSafe(input.workspacePath, destination);
    await durableWrite(destination, stagedBytes);
  }
}

export async function verifiedActionLimsPaths(
  workspacePath: string,
  actionId: string
): Promise<string[]> {
  const publication = await readPublication(workspacePath, actionId);
  if (!publication) return [];
  for (const file of publication.files) {
    if ((await fileDigest(workspacePath, file.relativePath)) !== file.sha256)
      throw new Error('Generated LIMS projection changed before publication.');
  }
  return publication.files.map((file) => file.relativePath);
}

export async function discardActionLimsStaging(
  workspacePath: string,
  actionId: string
): Promise<void> {
  const stageRoot = `${publicationPath(workspacePath, actionId)}.staged`;
  assertWorkspaceProjectionPathSafe(workspacePath, stageRoot);
  await rm(stageRoot, { recursive: true, force: true });
}

async function readPublication(
  workspacePath: string,
  actionId: string
): Promise<Publication | null> {
  const path = publicationPath(workspacePath, actionId);
  assertWorkspaceProjectionPathSafe(workspacePath, path);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'actionId,files,schema' ||
    value.schema !== 'dnaforge.migration-lims-publication.v1' ||
    value.actionId !== actionId ||
    !Array.isArray(value.files)
  )
    throw new Error('Generated LIMS publication record is invalid.');
  const files = value.files.map((file): GeneratedFile => {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(',') !== 'priorSha256,relativePath,sha256' ||
      typeof file.relativePath !== 'string' ||
      !ALLOWED_FILE.test(file.relativePath) ||
      !isDigest(file.sha256) ||
      (file.priorSha256 !== null && !isDigest(file.priorSha256))
    )
      throw new Error('Generated LIMS publication path or hash is invalid.');
    return { relativePath: file.relativePath, sha256: file.sha256, priorSha256: file.priorSha256 };
  });
  if (new Set(files.map((file) => file.relativePath)).size !== files.length)
    throw new Error('Generated LIMS publication repeats a path.');
  if (
    !['.waypoint/lims/manifest.json', '.waypoint/lims/sheets/oligos.csv'].every((path) =>
      files.some((file) => file.relativePath === path)
    )
  )
    throw new Error('Generated LIMS publication is missing required files.');
  return { schema: value.schema, actionId, files };
}

async function listGeneratedFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (relativePath: string): Promise<void> => {
    for (const entry of await readdir(join(root, relativePath), { withFileTypes: true })) {
      const child = `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && ALLOWED_FILE.test(child)) result.push(child);
      else throw new Error('LIMS exporter produced an unexpected artifact.');
    }
  };
  await visit('.waypoint/lims');
  return result.sort();
}

function publicationPath(workspacePath: string, actionId: string): string {
  return join(workspacePath, `${benchlingMigrationActionJournalRelativePath(actionId)}.lims`);
}
async function fileDigest(root: string, relativePath: string): Promise<string | null> {
  const path = join(root, relativePath);
  assertWorkspaceProjectionPathSafe(root, path);
  try {
    if (!(await lstat(path)).isFile())
      throw new Error('Generated LIMS destination is not a regular file.');
    return digest(await readFile(path));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
async function durableWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.pending`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
