import {
  primerArtifactRegistryFields,
  primerLegacyProjectionFromArtifact,
} from '../shared/primers/primer-artifact-projection';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { defineBlob, type WorkspacePath } from '@waypoint/workspace-revisions';
import type { ScientificReader, ScientificSnapshot } from '@waypoint/scientific-objects';
import {
  parsePrimerArtifact,
  BUILTIN_PRIMER_SCHEMA_ID,
  BUILTIN_RNA_OLIGO_SCHEMA_ID,
} from '../shared/primers/primer-artifact';
import { limsEntityFromRow, type LimsEntityRow } from '../shared/lims';
import { registerLimsEntityInsideTx, updateLimsEntityInsideTx } from './lims-engine-core';
import { archiveLimsEntityInsideTx, restoreLimsEntityInsideTx } from './lims-entity-lifecycle';
import { replacePrimerLegacyProjectionInDb } from './primer-projection';
import { restorePrimerRegistryRelationshipsInsideTx } from './primer-registry-relationships';
import { materializeFileBinding } from './native-workspace-materializer';
import { readAcceptedPrimerProjectionSourceInDb } from './scientific-primer-projection-source';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function projectAcceptedPrimerRegistryRelationshipsInsideTx(input: {
  db: Database.Database;
  workspaceId: number;
  root: string;
  path: WorkspacePath;
  snapshot: ScientificSnapshot;
}): void {
  const { db, workspaceId, root, path, snapshot } = input;
  if (!db.inTransaction || snapshot.representation?.format !== 'primer-v2')
    throw new Error(
      'Accepted primer relationships require their owning transaction and native bytes.'
    );
  const text = snapshot.representation.text;
  const artifact = parsePrimerArtifact(text);
  if (artifact.id !== snapshot.resourceId || artifact.file.workspaceRelativePath !== path)
    throw new Error('Accepted primer relationship identity does not match its artifact.');
  if (artifact.registryRelationships === undefined) return;
  const contentHash = sha256(text);
  restorePrimerRegistryRelationshipsInsideTx(
    db,
    {
      id: artifact.id,
      workspaceId,
      registryRelationships: { relativePath: path, contentHash },
    },
    {
      primerId: artifact.id,
      workspaceRoot: root,
      relativePath: path,
      contentHash,
      relationships: artifact.registryRelationships,
    }
  );
}

export function projectAcceptedPrimerInsideTx(input: {
  db: Database.Database;
  workspaceId: number;
  root: string;
  path: WorkspacePath;
  snapshot: ScientificSnapshot;
  reader: ScientificReader;
}): void {
  const { db, workspaceId, root, path, snapshot } = input;
  if (!db.inTransaction || snapshot.representation?.format !== 'primer-v2')
    throw new Error('Accepted primer projection requires its owning transaction and native bytes.');
  const text = snapshot.representation.text;
  const artifact = parsePrimerArtifact(text);
  if (artifact.id !== snapshot.resourceId || artifact.file.workspaceRelativePath !== path)
    throw new Error('Accepted primer identity or file locator does not match its artifact.');
  const fields = primerArtifactRegistryFields(artifact, {
    sequenceContentHash: `sha256:${sha256(artifact.sequence.bases.replace(/\s/g, ''))}`,
    artifactContentHash: sha256(text),
  });
  const row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(artifact.id) as
    | LimsEntityRow
    | undefined;
  const before = row ? limsEntityFromRow(row) : null;
  if (
    before &&
    (before.workspaceId !== workspaceId ||
      before.kind !== artifact.registry.kind ||
      (before.fields.artifact as Record<string, unknown> | undefined)?.schema !== artifact.schema)
  )
    throw new Error('Accepted primer identity belongs to another Registry owner or kind.');
  const savedState = artifact.entity?.state;
  const registrationStatus = savedState?.registrationStatus ?? 'registered';
  const domainStatus = savedState ? savedState.domainStatus : 'designed';
  const data = {
    id: artifact.id,
    name: artifact.name,
    fields,
    registrationStatus,
    domainStatus,
    workspaceId,
    actor: artifact.metadata.actor,
  };
  if (!before)
    registerLimsEntityInsideTx(db, {
      ...data,
      kind: artifact.registry.kind,
      schemaRevisionId: artifact.entity?.schema.schemaRevisionId,
      schemaSnapshot:
        artifact.entity?.schema.schemaId === BUILTIN_PRIMER_SCHEMA_ID ||
        artifact.entity?.schema.schemaId === BUILTIN_RNA_OLIGO_SCHEMA_ID
          ? undefined
          : artifact.entity?.schema,
      createdAt: Date.parse(artifact.metadata.createdAt),
      ...(savedState
        ? {
            initialState: {
              updatedAt: Date.parse(artifact.metadata.updatedAt),
              archived: savedState.archived,
              archivedAt: savedState.archivedAt,
            },
          }
        : {}),
    });
  else {
    if (before.tombstone && !savedState?.archived)
      restoreLimsEntityInsideTx(db, { id: artifact.id, actor: artifact.metadata.actor });
    if (
      before.name !== artifact.name ||
      before.registrationStatus !== registrationStatus ||
      before.domainStatus !== domainStatus ||
      !isDeepStrictEqual(before.fields, fields)
    )
      updateLimsEntityInsideTx(db, { ...data, replaceFields: true });
  }
  if (savedState?.archived && before && !before.tombstone)
    archiveLimsEntityInsideTx(db, { id: artifact.id, actor: artifact.metadata.actor });
  const now = Date.now();
  const existingCatalog = db
    .prepare('SELECT type,workspace_id FROM catalog_entities WHERE id=?')
    .get(artifact.id) as { type: string; workspace_id: number | null } | undefined;
  if (
    existingCatalog &&
    (existingCatalog.type !== 'primer' || existingCatalog.workspace_id !== workspaceId)
  )
    throw new Error('Accepted primer catalog identity belongs to another owner or kind.');
  const metadata = {
    schema: artifact.schema,
    schemaVersion: artifact.schemaVersion,
    artifactRevision: artifact.artifactRevision,
    relativePath: path,
    entitySchema: artifact.entity?.schema,
  };
  db.prepare(
    `INSERT INTO catalog_entities
    (id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at)
    VALUES (?,'primer',?,?,'file','active',?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,status='active',metadata=excluded.metadata,updated_at=excluded.updated_at`
  ).run(
    artifact.id,
    artifact.name,
    `waypoint://primer/${artifact.id}`,
    workspaceId,
    JSON.stringify(metadata),
    now,
    now
  );
  const blob = defineBlob(new TextEncoder().encode(text));
  materializeFileBinding(db, {
    workspaceId,
    entityId: artifact.id,
    absolutePath: join(root, path),
    relativePath: path,
    fileKind: 'primer-artifact',
    contentHash: blob.hash,
    sizeBytes: blob.byteLength,
    modifiedAt: Date.parse(artifact.metadata.updatedAt),
    now,
  });
  const source = readAcceptedPrimerProjectionSourceInDb(db, workspaceId, artifact.id);
  if (!source || !isDeepStrictEqual(source.artifact, artifact))
    throw new Error('The accepted primer changed before its compatibility projection.');
  replacePrimerLegacyProjectionInDb(
    db,
    primerLegacyProjectionFromArtifact(artifact, workspaceId, source.resolvedBindings)
  );
}
