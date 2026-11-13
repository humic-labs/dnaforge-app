import type Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveOriginalDefaultProject } from './original-default-project';
import { isEntityRecordArtifactProjection } from '../shared/registry-file-types';
import { PRIMER_ARTIFACT_SCHEMA } from '../shared/primer-artifact-schema';
import { prepareCachedStatement } from './sqlite-statement-cache';
import { resolveContainingPathBoundary } from '../shared/path-boundary';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function existingFileProject(db: Database.Database, path: string): number | undefined {
  let actualFile: string;
  try {
    actualFile = realpathSync(path);
  } catch {
    return undefined;
  }
  const roots = (
    prepareCachedStatement(db, 'SELECT id, path FROM workspaces').all() as Array<{
      id: number;
      path: string;
    }>
  ).flatMap((project) => {
    try {
      return [{ id: project.id, path: realpathSync(project.path) }];
    } catch {
      return [];
    }
  });
  const owner = resolveContainingPathBoundary(roots, actualFile);
  if (owner.status === 'ambiguous')
    throw new Error('The saved file has conflicting project ownership.');
  return owner.status === 'unique' ? owner.entry.id : undefined;
}

export function resolveSavedRegistryProject(
  db: Database.Database,
  input: { id?: string; workspaceId?: number | null; fields: Record<string, unknown> }
): number {
  const sequence =
    record(input.fields.sequence) && input.fields.sequence.mode === 'file'
      ? input.fields.sequence
      : null;
  let projectId = input.workspaceId;
  if (projectId == null) {
    const knownOwners = new Set<number>();
    if (input.id) {
      for (const file of prepareCachedStatement(
        db,
        "SELECT workspace_id FROM catalog_entity_files WHERE entity_id = ? AND status = 'current'"
      ).all(input.id) as Array<{ workspace_id: number | null }>) {
        if (file.workspace_id != null) knownOwners.add(file.workspace_id);
      }
    }
    if (sequence) {
      if (typeof sequence.workspaceId === 'number') knownOwners.add(sequence.workspaceId);
      if (typeof sequence.relPath === 'string' && isAbsolute(sequence.relPath)) {
        for (const file of prepareCachedStatement(
          db,
          'SELECT workspace_id FROM indexed_files WHERE path = ?'
        ).all(sequence.relPath) as Array<{ workspace_id: number | null }>) {
          if (file.workspace_id != null) knownOwners.add(file.workspace_id);
        }

        if (knownOwners.size === 0) {
          const owner = existingFileProject(db, sequence.relPath);
          if (owner !== undefined) knownOwners.add(owner);
        }
      }
    }
    if (knownOwners.size > 1) throw new Error('The entity has conflicting project ownership.');
    projectId = [...knownOwners][0];
    if (projectId == null) {
      if (
        isEntityRecordArtifactProjection(input.fields) ||
        (record(input.fields.artifact) && input.fields.artifact.schema === PRIMER_ARTIFACT_SCHEMA)
      )
        throw new Error('A saved entity document requires its owning project.');
      const original = resolveOriginalDefaultProject(db);
      if (original.status !== 'ready') throw new Error(original.message);
      projectId = original.project.workspaceId;
    }
  }
  if (!Number.isSafeInteger(projectId) || projectId < 1)
    throw new Error('A saved entity requires a valid project.');

  if (!prepareCachedStatement(db, 'SELECT id FROM workspaces WHERE id = ?').get(projectId))
    throw new Error('Saving an entity requires a registered project.');
  return projectId;
}
