import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { limsEntityFromRow, type LimsEntity } from '../shared/lims';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../shared/path-boundary';
import {
  BUILTIN_PRIMER_SCHEMA_ID,
  BUILTIN_RNA_OLIGO_SCHEMA_ID,
  createBuiltinPrimerSchemaSnapshot,
  parsePrimerArtifact,
  PRIMER_ARTIFACT_SCHEMA,
  serializePrimerArtifact,
} from '../shared/primers/primer-artifact';
import { primerArtifactRegistryProjection } from '../shared/primers/primer-artifact-projection';
import { getEntityRowById } from './lims-engine-core';
import { registrySchemaSnapshotForEntity } from './lims-registry-projection';
import { readNativeCatalogPublicationBase } from './native-catalog-publication';

interface Context {
  db: Database.Database;
  runDatabase: <T>(work: () => T) => T;
}

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export function readPrimerArtifactAuthority(db: Database.Database, current: LimsEntity) {
  const bindings = db
    .prepare(
      `SELECT f.id AS bindingId, f.path, f.relative_path AS relativePath,
      f.workspace_id AS workspaceId, f.file_kind AS fileKind,
      c.type AS catalogType, c.workspace_id AS catalogWorkspaceId, c.storage_type AS storageType,
      w.path AS workspacePath
    FROM catalog_entity_files f
    JOIN catalog_entities c ON c.id=f.entity_id
    JOIN workspaces w ON w.id=f.workspace_id
    WHERE f.entity_id=? AND f.status='current'`
    )
    .all(current.id) as Array<{
    bindingId: string;
    path: string;
    relativePath: string | null;
    workspaceId: number;
    fileKind: string;
    catalogType: string;
    catalogWorkspaceId: number | null;
    storageType: string;
    workspacePath: string;
  }>;
  const binding = bindings[0];
  const artifact = current.fields.artifact;
  if (
    bindings.length !== 1 ||
    !binding ||
    binding.catalogType !== 'primer' ||
    binding.fileKind !== 'primer-artifact' ||
    binding.storageType !== 'file' ||
    binding.workspaceId !== current.workspaceId ||
    binding.catalogWorkspaceId !== current.workspaceId ||
    !artifact ||
    typeof artifact !== 'object' ||
    Array.isArray(artifact) ||
    !('schema' in artifact) ||
    artifact.schema !== PRIMER_ARTIFACT_SCHEMA ||
    !('relativePath' in artifact) ||
    typeof artifact.relativePath !== 'string'
  ) {
    throw new Error(
      'Primer file and Registry ownership disagree; reconcile the project before continuing.'
    );
  }
  const relativePath = pathRelativeToBoundary(binding.path, binding.workspacePath);
  if (
    !relativePath ||
    !isSafeWorkspaceRelativePath(relativePath) ||
    relativePath !== artifact.relativePath ||
    relativePath !== binding.relativePath
  ) {
    throw new Error('Primer file locator does not match its owning project.');
  }
  return {
    bindingId: binding.bindingId,
    workspaceId: binding.workspaceId,
    workspacePath: binding.workspacePath,
    relativePath,
  };
}

function assertPrimerPublicationsSettled(db: Database.Database, workspaceId: number): void {
  if (
    db
      .prepare('SELECT 1 FROM native_catalog_publication_outbox WHERE workspace_id=? LIMIT 1')
      .get(workspaceId)
  ) {
    throw new Error(
      'The owning project has an unfinished publication; finish it before reviewing this primer.'
    );
  }
}

export async function readCheckedPrimerArtifactSnapshot(input: Context & { entityId: string }) {
  const initial = input.runDatabase(() => {
    const current = limsEntityFromRow(getEntityRowById(input.db, input.entityId));
    const owner = readPrimerArtifactAuthority(input.db, current);
    assertPrimerPublicationsSettled(input.db, owner.workspaceId);
    return {
      current,
      owner,
      schemaSnapshot: registrySchemaSnapshotForEntity(input.db, current),
    };
  });
  const { current, owner, schemaSnapshot } = initial;
  const beforeBytes = await readNativeCatalogPublicationBase({
    workspacePath: owner.workspacePath,
    relativePath: owner.relativePath,
    operationId: `primer-artifact-review:${current.id}`,
  });
  if (!beforeBytes) throw new Error('Authoritative primer file is missing.');
  const before = parsePrimerArtifact(beforeBytes.toString('utf8'));
  const bases = before.sequence.bases.replace(/\s/g, '');
  const sequenceHash = digest(bases);
  const artifactContentHash = digest(serializePrimerArtifact(before));
  const projected = primerArtifactRegistryProjection(
    before,
    {
      mode: 'inline',
      bases,
      topology: 'linear',
      length: bases.length,
      contentHash: `sha256:${sequenceHash}`,
    },
    artifactContentHash
  );
  const fileSchema =
    before.entity?.schema ?? createBuiltinPrimerSchemaSnapshot(before.oligo?.orderType);

  const isBuiltin =
    fileSchema.schemaId === BUILTIN_PRIMER_SCHEMA_ID ||
    fileSchema.schemaId === BUILTIN_RNA_OLIGO_SCHEMA_ID;
  const currentSchema = isBuiltin ? { ...schemaSnapshot, baseKind: 'primer' } : schemaSnapshot;
  if (
    before.id !== current.id ||
    before.registry.entityId !== current.id ||
    before.registry.kind !== current.kind ||
    before.name !== current.name ||
    before.file.workspaceRelativePath !== owner.relativePath ||
    before.sequence.contentHash !== sequenceHash ||
    current.schemaRevisionId !== fileSchema.schemaRevisionId ||
    !isDeepStrictEqual(
      { ...fileSchema, description: fileSchema.description ?? null },
      { ...currentSchema, description: currentSchema.description ?? null }
    ) ||
    !isDeepStrictEqual(projected.fields, current.fields) ||
    projected.registrationStatus !== current.registrationStatus ||
    projected.domainStatus !== current.domainStatus ||
    (before.entity?.state?.archived ?? false) !== current.tombstone
  ) {
    throw new Error(
      'Primer file and projection disagree; preserve both versions and reconcile before continuing.'
    );
  }
  input.runDatabase(() => {
    assertPrimerPublicationsSettled(input.db, owner.workspaceId);
    const latest = limsEntityFromRow(getEntityRowById(input.db, current.id));
    if (
      !isDeepStrictEqual(latest, current) ||
      !isDeepStrictEqual(readPrimerArtifactAuthority(input.db, latest), owner) ||
      !isDeepStrictEqual(registrySchemaSnapshotForEntity(input.db, latest), schemaSnapshot)
    ) {
      throw new Error('Primer changed while its saved file was read; review it again.');
    }
  });
  return {
    current,
    owner,
    beforeBytes,
    before,
    schemaSnapshot,
    sha256: digest(beforeBytes),
    artifactContentHash,
  };
}
