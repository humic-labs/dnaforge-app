import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { packagedCoordinateFormat } from '../shared/default-molecular-view';
import {
  MOLECULAR_DOCUMENT_FILE_KIND,
  type ImportedCoordinateLocation,
  type MolecularDocumentLocation,
} from '../shared/molecular-document';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { readMolecularDocumentFile } from './molecular-document-library';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { findMigratedCoordinate } from './workspace-git/molecular-migration-journal';
import { withWorkspaceMutation } from './workspace-sync-mutation-lease';

const requestSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    path: z.string().min(1),
    expectedSourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();

export async function resolveImportedCoordinate(
  db: Database.Database,
  input: ImportedCoordinateLocation
): Promise<MolecularDocumentLocation | null> {
  const request = requestSchema.parse(input);
  const { workspaceRoot, path } = request;
  if (!packagedCoordinateFormat(path)) return null;
  const owner = db
    .prepare('SELECT id, repo_uuid FROM workspaces WHERE path=?')
    .get(workspaceRoot) as { id: number; repo_uuid: string | null } | undefined;
  if (!owner) return null;
  return withWorkspaceMutation(workspaceRoot, async () => {
    const { candidate } = await canonicalWorkspacePath({
      workspaceRoot,
      path,
      allowMissing: true,
      artifactNoun: 'coordinate',
    });
    const loose = await lstat(candidate).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    const migrated = await findMigratedCoordinate(
      candidate,
      Boolean(loose),
      request.expectedSourceSha256
    );
    if (!migrated) return null;
    const entityId = scopedProjectionId(
      workspaceScopeKey(owner.repo_uuid, owner.id),
      migrated.documentId
    );
    const bindings = db
      .prepare(
        `SELECT f.path FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id
       WHERE e.id=? AND e.workspace_id=? AND e.type='molecular-document' AND e.status='active'
         AND e.storage_type='file' AND f.workspace_id=? AND f.file_kind=? AND f.status='current'`
      )
      .all(entityId, owner.id, owner.id, MOLECULAR_DOCUMENT_FILE_KIND) as { path: string }[];
    if (bindings.length > 1) return null;
    const location = {
      workspaceRoot,
      path: bindings[0]?.path ?? join(dirname(path), migrated.productName),
    };
    try {
      const { document } = await readMolecularDocumentFile(location);
      return document.id === migrated.documentId &&
        document.history.some(
          (entry) =>
            entry.referenceId === migrated.referenceId &&
            entry.snapshot.coordinates.sha256 === migrated.coordinateSha256
        )
        ? location
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  });
}
