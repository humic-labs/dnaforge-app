import type Database from 'better-sqlite3';
import { join, relative } from 'node:path';
import { defineBlob } from '@waypoint/workspace-revisions';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../shared/managed-sequence-document';
import { SEQUENCE_PACKAGE_FILE_KIND } from '../db/sequence-package';
import { materializeFileBinding } from './native-workspace-materializer';

export function projectAcceptedSequenceCatalogInsideTx(
  db: Database.Database,
  input: {
    workspaceId: number;
    root: string;
    resourceId: string;
    name: string;
    path: string;
    text: string;
    packageRoot: string | null;
  }
): void {
  if (!db.inTransaction) throw new Error('Accepted sequence catalog requires a transaction.');
  const existing = db
    .prepare('SELECT type,workspace_id,locator,metadata FROM catalog_entities WHERE id=?')
    .get(input.resourceId) as
    | { type: string; workspace_id: number | null; locator: string; metadata: string | null }
    | undefined;
  if (
    existing &&
    (existing.workspace_id !== input.workspaceId ||
      !['sequence', 'construct'].includes(existing.type))
  )
    throw new Error('Accepted sequence catalog identity belongs to another owner or kind.');
  const metadata = {
    ...JSON.parse(existing?.metadata ?? '{}'),
    ...(input.packageRoot
      ? {
          packageKind: 'sequence',
          [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
            kind: 'managed-sequence',
            packageId: input.resourceId,
            packageRoot: input.packageRoot,
          },
        }
      : {}),
  };
  const now = Date.now();
  db.prepare(
    `INSERT INTO catalog_entities
    (id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at)
    VALUES (?,?,?,?,'file','active',?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,status='active',metadata=excluded.metadata,updated_at=excluded.updated_at`
  ).run(
    input.resourceId,
    existing?.type ?? 'sequence',
    input.name,
    existing?.locator ?? `entity://sequence/${encodeURIComponent(input.resourceId)}`,
    input.workspaceId,
    JSON.stringify(metadata),
    now,
    now
  );
  const absolutePath = input.packageRoot ?? join(input.root, input.path);
  const relativePath = relative(input.root, absolutePath).split('\\').join('/');
  const atPath = db
    .prepare('SELECT entity_id FROM catalog_entity_files WHERE path=?')
    .get(absolutePath) as { entity_id: string } | undefined;
  if (!atPath) {
    const current = db
      .prepare(
        "SELECT id FROM catalog_entity_files WHERE entity_id=? AND workspace_id=? AND status='current'"
      )
      .all(input.resourceId, input.workspaceId) as { id: string }[];
    if (current.length > 1)
      throw new Error('Accepted sequence has more than one current file identity.');
    if (current[0])
      db.prepare('UPDATE catalog_entity_files SET path=?,relative_path=? WHERE id=?').run(
        absolutePath,
        relativePath,
        current[0].id
      );
  }
  const blob = defineBlob(new TextEncoder().encode(input.text));
  materializeFileBinding(db, {
    workspaceId: input.workspaceId,
    entityId: input.resourceId,
    absolutePath,
    relativePath,
    fileKind: input.packageRoot ? SEQUENCE_PACKAGE_FILE_KIND : 'genbank',
    contentHash: blob.hash,
    sizeBytes: blob.byteLength,
    modifiedAt: null,
    now,
  });
}
