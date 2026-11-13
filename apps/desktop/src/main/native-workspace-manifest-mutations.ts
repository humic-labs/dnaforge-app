import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type Database from 'better-sqlite3';

import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  parseNativeWorkspaceManifest,
  serializeNativeWorkspaceManifest,
  type NativeWorkspaceManifestV2,
} from '../shared/native-workspace-manifest';
import { isSafeWorkspaceRelativePath, pathIsAtOrUnder } from '../shared/path-boundary';

const RECOVERY_RELATIVE_PATH =
  '.dnaforge/migration/native-workspace-manifest-move.v1.json' as const;

type NativeWorkspaceManifestMoveRecovery = Readonly<{
  schema: 'dnaforge.native-workspace-manifest-move.v1';
  state: 'prepared' | 'manifest_written';
  entityId: string;
  portableId: string;
  oldRelativePath: string;
  newRelativePath: string;
  beforeManifestSha256: `sha256:${string}`;
  afterManifestSha256: `sha256:${string}`;
  createdAt: string;
}>;

export type PreparedNativeWorkspaceManifestMove = Readonly<{
  workspaceRoot: string;
  manifestPath: string;
  recoveryPath: string;
  beforeBytes: Buffer;
  afterBytes: Buffer;
  recovery: NativeWorkspaceManifestMoveRecovery;
}>;

export async function prepareNativeWorkspaceDirectFileMove(input: {
  db: Database.Database;
  workspaceRoot: string;
  oldPath: string;
  newPath: string;
}): Promise<PreparedNativeWorkspaceManifestMove | null> {
  const row = input.db
    .prepare(
      `SELECT entity.id, entity.metadata
       FROM catalog_entity_files AS file
       JOIN catalog_entities AS entity ON entity.id = file.entity_id
       JOIN workspaces AS workspace ON workspace.id = file.workspace_id
       WHERE file.path = ?
         AND file.status IN ('current', 'missing')
         AND workspace.path = ?`
    )
    .all(input.oldPath, input.workspaceRoot) as Array<{ id: string; metadata: string | null }>;
  if (row.length > 1) {
    throw new Error(
      'NATIVE_MANIFEST_MOVE_AMBIGUOUS: the source path has multiple current entities.'
    );
  }
  const binding = row[0];
  if (!binding) return null;
  const portableId = portableIdFromMetadata(binding.metadata);
  if (!portableId) return null;

  const manifestPath = join(input.workspaceRoot, NATIVE_WORKSPACE_MANIFEST_PATH);
  let beforeBytes: Buffer;
  try {
    beforeBytes = await readFile(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const manifest = parseNativeWorkspaceManifest(beforeBytes.toString('utf8'));
  if (manifest.schema !== NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA) return null;

  const oldRelativePath = workspaceRelativePath(input.workspaceRoot, input.oldPath);
  const newRelativePath = workspaceRelativePath(input.workspaceRoot, input.newPath);
  const updated = relocateNativeWorkspaceDirectFilePlacement({
    manifest,
    portableId,
    oldRelativePath,
    newRelativePath,
  });
  if (!updated) return null;
  const afterBytes = Buffer.from(serializeNativeWorkspaceManifest(updated), 'utf8');
  const recoveryPath = join(input.workspaceRoot, RECOVERY_RELATIVE_PATH);
  return {
    workspaceRoot: input.workspaceRoot,
    manifestPath,
    recoveryPath,
    beforeBytes,
    afterBytes,
    recovery: {
      schema: 'dnaforge.native-workspace-manifest-move.v1',
      state: 'prepared',
      entityId: binding.id,
      portableId,
      oldRelativePath,
      newRelativePath,
      beforeManifestSha256: sha256(beforeBytes),
      afterManifestSha256: sha256(afterBytes),
      createdAt: new Date().toISOString(),
    },
  };
}

export function relocateNativeWorkspaceDirectFilePlacement(input: {
  manifest: NativeWorkspaceManifestV2;
  portableId: string;
  oldRelativePath: string;
  newRelativePath: string;
}): NativeWorkspaceManifestV2 | null {
  const index = input.manifest.entities.findIndex((entity) => entity.id === input.portableId);
  if (index < 0) {
    throw new Error(
      `NATIVE_MANIFEST_MOVE_ENTITY_MISSING: portable entity ${input.portableId} is absent.`
    );
  }
  const entity = input.manifest.entities[index];
  if (!entity) throw new Error('NATIVE_MANIFEST_MOVE_ENTITY_MISSING');
  if (entity.placement.kind !== 'file') return null;
  if (entity.placement.relativePath !== input.oldRelativePath) {
    throw new Error(
      `NATIVE_MANIFEST_MOVE_PATH_CHANGED: ${input.portableId} no longer owns ${input.oldRelativePath}.`
    );
  }

  const fields = entity.lims ? structuredClone(entity.lims.fields) : null;
  const sequence = record(fields?.sequence);
  if (
    sequence?.mode === 'file' &&
    sequence.pathBase === 'workspace' &&
    sequence.relPath === input.oldRelativePath
  ) {
    sequence.relPath = input.newRelativePath;
  }
  const nextEntity = {
    ...entity,
    placement: { ...entity.placement, relativePath: input.newRelativePath },
    ...(entity.lims && fields ? { lims: { ...entity.lims, fields } } : {}),
  };
  const entities = [...input.manifest.entities];
  entities[index] = nextEntity;
  return { ...input.manifest, entities };
}

export async function beginNativeWorkspaceManifestMove(
  move: PreparedNativeWorkspaceManifestMove
): Promise<void> {
  await atomicWrite(
    move.recoveryPath,
    Buffer.from(`${JSON.stringify(move.recovery, null, 2)}\n`, 'utf8')
  );
}

export async function writeMovedNativeWorkspaceManifest(
  move: PreparedNativeWorkspaceManifestMove
): Promise<void> {
  await atomicWrite(move.manifestPath, move.afterBytes);
  await atomicWrite(
    move.recoveryPath,
    Buffer.from(
      `${JSON.stringify({ ...move.recovery, state: 'manifest_written' }, null, 2)}\n`,
      'utf8'
    )
  );
}

export async function restoreNativeWorkspaceManifestMove(
  move: PreparedNativeWorkspaceManifestMove
): Promise<void> {
  await atomicWrite(move.manifestPath, move.beforeBytes);
}

export async function completeNativeWorkspaceManifestMove(
  move: PreparedNativeWorkspaceManifestMove
): Promise<void> {
  await rm(move.recoveryPath, { force: true });
}

function workspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(absolutePath);
  if (!pathIsAtOrUnder(target, root)) {
    throw new Error('NATIVE_MANIFEST_MOVE_OUTSIDE_WORKSPACE');
  }
  const value = relative(root, target).replace(/\\/g, '/');
  if (!isSafeWorkspaceRelativePath(value)) {
    throw new Error('NATIVE_MANIFEST_MOVE_UNSAFE_PATH');
  }
  return value;
}

function portableIdFromMetadata(value: string | null): string | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const portableId = record(parsed)?.portableId;
  return typeof portableId === 'string' && portableId.trim() ? portableId : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
