import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { canonicalEntityArtifactValue } from '../shared/entity-artifact-projection';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { limsLinkFromRow, type LimsLink, type LimsLinkRow } from '../shared/lims';
import type { PrimerLegacyProjectionInput } from '../shared/primer-projection-ipc';
import {
  parsePrimerRegistryRelationships,
  type PrimerRegistryRelationship,
} from '../shared/primer-registry-relationships';
import { canonicalWorkspacePath } from './primer-artifact-files';
import {
  assertRelationshipTypeExists,
  insertAuditEvent,
  LINEAGE_RELATIONSHIP_TYPES,
  nextEventSeq,
  upsertLimsLinkProjectionInsideTx,
  wouldCreateRelationshipCycle,
} from './lims-engine-core';

export interface VerifiedPrimerRelationshipAuthority {
  primerId: string;
  workspaceRoot: string;
  relativePath: string;
  contentHash: string;
  relationships: PrimerRegistryRelationship[];
}

const canonical = (value: unknown) => JSON.stringify(canonicalEntityArtifactValue(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function readPrimerRelationshipAuthority(
  input: PrimerLegacyProjectionInput,
  workspaceRoot: string
): Promise<VerifiedPrimerRelationshipAuthority | undefined> {
  const reference = input.registryRelationships;
  if (!reference) return undefined;
  if (
    !isSafeWorkspaceRelativePath(reference.relativePath) ||
    !/^[a-f0-9]{64}$/.test(reference.contentHash)
  )
    throw new Error('Primer Registry relationship document reference is invalid.');
  const path = await canonicalWorkspacePath({
    workspaceRoot,
    path: resolve(workspaceRoot, reference.relativePath),
  });
  const content = await readFile(path.candidate, 'utf8');
  if (createHash('sha256').update(content).digest('hex') !== reference.contentHash)
    throw new Error('The primer relationship document changed; retry project reconciliation.');
  const artifact: unknown = JSON.parse(content);
  if (
    !isRecord(artifact) ||
    artifact.schema !== 'dnaforge.primer' ||
    artifact.schemaVersion !== 3 ||
    artifact.id !== input.id ||
    !isRecord(artifact.registry) ||
    artifact.registry.entityId !== input.id ||
    !isRecord(artifact.file) ||
    artifact.file.workspaceRelativePath !== reference.relativePath
  )
    throw new Error('The saved primer cannot authorize these Registry relationships.');
  return {
    primerId: input.id,
    workspaceRoot,
    relativePath: reference.relativePath,
    contentHash: reference.contentHash,
    relationships: parsePrimerRegistryRelationships(artifact.registryRelationships, input.id),
  };
}

function comparable(link: LimsLink | Record<string, unknown>) {
  const { eventSeq: _eventSeq, ...state } = link;
  return state;
}

export function restorePrimerRegistryRelationshipsInsideTx(
  db: Database.Database,
  input: Pick<PrimerLegacyProjectionInput, 'id' | 'workspaceId' | 'registryRelationships'>,
  authority?: VerifiedPrimerRelationshipAuthority
): void {
  if (!input.registryRelationships) return;
  if (
    !authority ||
    authority.primerId !== input.id ||
    authority.contentHash !== input.registryRelationships.contentHash ||
    authority.relativePath !== input.registryRelationships.relativePath
  )
    throw new Error('Primer Registry relationships require verified saved-document authority.');
  const workspace = db
    .prepare(
      'SELECT id FROM workspaces WHERE path = ? AND archived_at IS NULL AND trashed_at IS NULL AND access_mode = ?'
    )
    .get(authority.workspaceRoot, 'writable') as { id: number } | undefined;
  if (!workspace || workspace.id !== input.workspaceId)
    throw new Error('Primer Registry relationship recovery requires its writable owning project.');
  const owner = db
    .prepare('SELECT workspace_id, fields FROM lims_entity WHERE id = ?')
    .get(input.id) as { workspace_id: number | null; fields: string } | undefined;
  const ownerFields: unknown = owner ? JSON.parse(owner.fields) : null;
  if (
    owner?.workspace_id !== workspace.id ||
    !isRecord(ownerFields) ||
    !isRecord(ownerFields.artifact) ||
    ownerFields.artifact.schema !== 'dnaforge.primer' ||
    ownerFields.artifact.relativePath !== authority.relativePath
  )
    throw new Error('The saved primer does not own this Registry projection.');

  for (const snapshot of authority.relationships) {
    let workspaceId: number | null = null;
    if (snapshot.project.status === 'unresolved')
      throw new Error(
        `Registry relationship ${snapshot.id} has an unresolved owning project; its evidence was retained.`
      );
    if (snapshot.project.status === 'assigned') {
      const owners = db
        .prepare('SELECT id FROM workspaces WHERE repo_uuid = ?')
        .all(snapshot.project.repoUuid) as Array<{ id: number }>;
      if (owners.length !== 1)
        throw new Error(
          `Registry relationship ${snapshot.id} owning project is unavailable or ambiguous; its evidence was retained.`
        );
      workspaceId = owners[0].id;
    }
    const state: LimsLink = {
      id: snapshot.id,
      fromEntityId: snapshot.fromEntityId,
      toEntityId: snapshot.toEntityId,
      type: snapshot.type,
      payload: snapshot.payload,
      workspaceId,
      actor: snapshot.actor,
      eventSeq: null,
      tombstone: snapshot.archived,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      archivedAt: snapshot.archivedAt,
    };
    const existing = db
      .prepare(
        'SELECT * FROM lims_link WHERE id = ? OR (from_entity_id = ? AND to_entity_id = ? AND type = ?)'
      )
      .all(snapshot.id, snapshot.fromEntityId, snapshot.toEntityId, snapshot.type) as LimsLinkRow[];
    if (existing.length) {
      if (
        existing.length !== 1 ||
        canonical(comparable(limsLinkFromRow(existing[0]))) !== canonical(comparable(state))
      )
        throw new Error(
          `Registry relationship ${snapshot.id} conflicts with its current record; neither was overwritten.`
        );
      continue;
    }
    if (workspaceId !== null && workspaceId !== workspace.id)
      throw new Error(
        `Registry relationship ${snapshot.id} belongs to another project; restore it from that project's own authority.`
      );
    const endpoints = db
      .prepare('SELECT id, tombstone FROM lims_entity WHERE id IN (?, ?)')
      .all(snapshot.fromEntityId, snapshot.toEntityId) as Array<{ id: string; tombstone: number }>;
    if (endpoints.length !== 2)
      throw new Error(
        `Registry relationship ${snapshot.id} target is unavailable; restore its record and retry.`
      );
    const latest = db
      .prepare(
        "SELECT after FROM lims_audit WHERE subject_table = 'lims_link' AND subject_id = ? ORDER BY event_seq DESC LIMIT 1"
      )
      .get(snapshot.id) as { after: string | null } | undefined;
    if (latest?.after) {
      const previous: unknown = JSON.parse(latest.after);
      if (!isRecord(previous) || canonical(comparable(previous)) !== canonical(comparable(state)))
        throw new Error(
          `Registry relationship ${snapshot.id} conflicts with retained history; its evidence was retained.`
        );
    }
    assertRelationshipTypeExists(db, snapshot.type);
    if (
      !snapshot.archived &&
      LINEAGE_RELATIONSHIP_TYPES.has(snapshot.type) &&
      wouldCreateRelationshipCycle(db, snapshot.fromEntityId, snapshot.toEntityId, snapshot.type)
    )
      throw new Error(
        `Registry relationship ${snapshot.id} would create a cycle; its evidence was retained.`
      );
    const restored = { ...state, eventSeq: nextEventSeq(db) };
    insertAuditEvent(db, {
      eventSeq: restored.eventSeq,
      eventType: 'link_created',
      subjectTable: 'lims_link',
      subjectId: restored.id,
      workspaceId,
      actor: 'primer-record-recovery',
      after: restored,
      payload: {
        source: 'primer-artifact',
        relativePath: authority.relativePath,
        sourceEventSeq: snapshot.sourceEventSeq,
        sourceActor: snapshot.actor,
      },
    });
    upsertLimsLinkProjectionInsideTx(db, restored);
  }
}
