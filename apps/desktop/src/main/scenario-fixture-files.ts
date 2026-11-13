import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type Database from 'better-sqlite3';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  nativeWorkspaceEntityPlacement,
  parseNativeWorkspaceManifest,
  type NativeWorkspaceManifestEntityV2,
} from '../shared/native-workspace-manifest';
import type { ScenarioFixtureFile } from '../shared/internal-fixtures';
import { writeNativeWorkspaceManifestDocument } from './native-workspace-manifest';

async function writableProjectRoot(db: Database.Database, workspaceRoot: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  const rows = db
    .prepare(
      "SELECT path FROM workspaces WHERE access_mode = 'writable' AND archived_at IS NULL AND trashed_at IS NULL"
    )
    .all() as Array<{ path: string }>;
  for (const row of rows) {
    if ((await realpath(row.path).catch(() => null)) === root) return root;
  }
  throw new Error('Scenario files can only be registered in an active writable project.');
}

async function fixtureFilePath(root: string, file: ScenarioFixtureFile): Promise<string> {
  const relativePath = posix.normalize(file.relativePath);
  if (
    !file.relativePath ||
    posix.isAbsolute(file.relativePath) ||
    relativePath !== file.relativePath ||
    relativePath.split('/').some((segment) => segment === '..' || segment.startsWith('.'))
  )
    throw new Error(`Scenario file path must stay inside the project: ${file.relativePath}`);
  const path = join(root, ...relativePath.split('/'));
  if (!(await lstat(path)).isFile())
    throw new Error(`Scenario file is not a regular file: ${file.relativePath}`);
  return path;
}

export async function registerScenarioFixtureFiles(input: {
  db: Database.Database;
  workspaceRoot: string;
  files: readonly ScenarioFixtureFile[];
}): Promise<{ manifestPath: string }> {
  const root = await writableProjectRoot(input.db, input.workspaceRoot);
  for (const file of input.files) await fixtureFilePath(root, file);
  const existingText = await readFile(join(root, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  );
  const existing = existingText
    ? parseNativeWorkspaceManifest(existingText)
    : { entities: [], links: [] };
  const entities = existing.entities.map((entity): NativeWorkspaceManifestEntityV2 => {
    if ('placement' in entity) return entity;
    const { path: _path, fileKind: _fileKind, ...record } = entity;
    return { ...record, placement: nativeWorkspaceEntityPlacement(entity) };
  });
  const listed = new Set(
    entities.flatMap((entity) =>
      entity.placement.kind === 'file' ? [entity.placement.relativePath] : []
    )
  );
  for (const file of input.files) {
    if (listed.has(file.relativePath)) continue;
    listed.add(file.relativePath);
    entities.push({
      id: randomUUID(),
      type: 'file',
      name: file.name,
      placement: { kind: 'file', relativePath: file.relativePath, fileKind: file.fileKind },
    });
  }
  const manifestPath = await writeNativeWorkspaceManifestDocument({
    workspacePath: root,
    manifest: { ...existing, schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA, entities },
  });
  return { manifestPath };
}
