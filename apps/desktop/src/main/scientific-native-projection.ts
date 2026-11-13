import type Database from 'better-sqlite3';
import {
  resolveSequenceGeneticCode,
  type Annotation,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import type { ScientificWorkspaceProjectionResult } from '@waypoint/domain-services';
import {
  defineBlob,
  listWorkspaceResources,
  inspectResourceRevision,
  type ResourceId,
  type WorkspacePath,
  type CanonicalValue,
} from '@waypoint/workspace-revisions';
import { defineScientificDocument } from '@waypoint/scientific-objects';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseEntityArtifact } from '../shared/entity-artifact';
import {
  limsEntityFromRow,
  limsLinkFromRow,
  type LimsEntityRow,
  type LimsLinkRow,
} from '../shared/lims';
import {
  insertAuditEvent,
  linkLimsEntitiesOrExistingInsideTx,
  nextEventSeq,
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
  updateLimsEntityInsideTx,
  upsertLimsLinkProjectionInsideTx,
} from './lims-engine-core';
import { archiveLimsEntityInsideTx, restoreLimsEntityInsideTx } from './lims-entity-lifecycle';
import { tombstoneLimsLinkInsideTx } from './lims-import';
import { ScientificObjectStore } from './scientific-object-store';
import { nativeRecord } from './scientific-native-json';
import { parseNativeStrainRelationships } from './scientific-native-references';
import { assertLimsSafetyNotQuarantined } from './lims-safety-quarantine';
import { readAcceptedSequencePackage } from './scientific-sequence-package';
import {
  projectAcceptedPrimerInsideTx,
  projectAcceptedPrimerRegistryRelationshipsInsideTx,
} from './scientific-primer-projection';
import { projectAcceptedSequenceIdentityInsideTx } from './scientific-sequence-identity';
import { projectAcceptedSequenceCatalogInsideTx } from './scientific-sequence-catalog';
import {
  parseSequencePackageDocument,
  sequencePackageRootForMetaPath,
} from '../db/sequence-package';
import { projectSequencePackageRegistryFields } from '../db/sequence-package-registry-fields';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';

const actor = 'scientific-objects';
function geneticCodeAnnotations(
  values: readonly CanonicalValue[]
): Pick<Annotation, 'type' | 'qualifiers'>[] {
  return values.flatMap((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const annotation = nativeRecord(value);
    if (typeof annotation.type !== 'string') return [];
    const qualifiers: Record<string, string[]> = {};
    if (annotation.qualifiers !== undefined && annotation.qualifiers !== null)
      for (const [key, values] of Object.entries(nativeRecord(annotation.qualifiers))) {
        if (
          !Array.isArray(values) ||
          !values.every((item): item is string => typeof item === 'string')
        )
          throw new TypeError('Scientific annotation qualifiers must be string lists.');
        qualifiers[key] = values;
      }
    return [{ type: annotation.type, qualifiers }];
  });
}
const tuple = (link: { type: string; fromEntityId: string; toEntityId: string }) =>
  JSON.stringify([link.type, link.fromEntityId, link.toEntityId]);

export function reconcileScientificNativeProjectionsInsideTx(
  db: Database.Database,
  workspaceId: number
): ScientificWorkspaceProjectionResult {
  if (!db.inTransaction) throw new Error('Scientific projection requires an owning transaction.');
  const store = new ScientificObjectStore(db, workspaceId);
  const { graph, head, reader } = store.read();
  const snapshots = reader.listCurrent();
  const strains = snapshots.flatMap((snapshot) => {
    const representation = snapshot.representation;
    return representation?.format === 'strain-entity-v1' ? [{ ...snapshot, representation }] : [];
  });
  const sequences = snapshots.filter((snapshot) => snapshot.document.kind === 'sequence');
  const primers = snapshots.filter((snapshot) => snapshot.representation?.format === 'primer-v2');
  if (head === null) return { head, projectedPaths: [], relationships: 0 };
  assertLimsSafetyNotQuarantined(db);
  seedLimsBuiltinsInDb(db);
  const slots = head === null ? null : listWorkspaceResources(graph, head);
  if (slots && !slots.ok) throw new Error('Accepted scientific projection paths are unavailable.');
  const paths = new Map<ResourceId, WorkspacePath>();
  if (slots?.ok)
    for (const slot of slots.value)
      if (!slot.tombstone && slot.path !== null) paths.set(slot.resourceId, slot.path);
  const removedStrains = new Set<string>();
  if (slots?.ok)
    for (const slot of slots.value) {
      if (!slot.tombstone) continue;
      const tombstone = inspectResourceRevision(graph, slot.revisionId);
      if (!tombstone.ok || tombstone.value.parentIds.length !== 1) continue;
      const original = reader.revision({
        resourceId: slot.resourceId,
        revisionId: tombstone.value.parentIds[0],
      });
      if (!original || !['primer', 'sequence', 'strain'].includes(original.document.kind)) continue;
      if (original.representation?.format === 'strain-entity-v1')
        removedStrains.add(slot.resourceId);
      const row = db
        .prepare('SELECT workspace_id,tombstone FROM lims_entity WHERE id=?')
        .get(slot.resourceId) as { workspace_id: number | null; tombstone: number } | undefined;
      if (row && row.workspace_id !== workspaceId)
        throw new Error('Removed scientific identity belongs to another Registry owner.');
      if (row && !row.tombstone) archiveLimsEntityInsideTx(db, { id: slot.resourceId, actor });
      db.prepare(
        "UPDATE catalog_entities SET status='archived',updated_at=? WHERE id=? AND workspace_id=?"
      ).run(Date.now(), slot.resourceId, workspaceId);
      db.prepare(
        "UPDATE catalog_entity_files SET status='missing',missing_since=COALESCE(missing_since,?) WHERE entity_id=? AND workspace_id=? AND status='current'"
      ).run(Date.now(), slot.resourceId, workspaceId);
      if (original.document.kind === 'primer') {
        db.prepare("UPDATE primers SET status='archived' WHERE id=? AND workspace_id=?").run(
          slot.resourceId,
          workspaceId
        );
        db.prepare('DELETE FROM primer_bindings WHERE primer_id=?').run(slot.resourceId);
      }
    }
  const sequenceIds = new Set(sequences.map((snapshot) => snapshot.resourceId));
  const sequencePaths: string[] = [];
  for (const resourceId of sequenceIds) {
    const snapshot = reader.current(resourceId);
    const path = paths.get(resourceId);
    if (!snapshot || snapshot.document.kind !== 'sequence' || !path)
      throw new Error('Accepted strain sequence has no current projection.');
    const row = db.prepare('SELECT * FROM lims_entity WHERE id = ?').get(resourceId) as
      | LimsEntityRow
      | undefined;
    const before = row ? limsEntityFromRow(row) : null;
    const document = snapshot.document;
    const text = snapshot.representation?.text ?? defineScientificDocument(document).text;
    const acceptedPackage =
      head && snapshot.representation?.format === 'genbank-v1'
        ? readAcceptedSequencePackage({
            store,
            graph,
            head,
            sequenceId: resourceId,
            productPath: path,
            productText: text,
          })
        : null;
    const metadata = acceptedPackage ? parseSequencePackageDocument(acceptedPackage.text) : null;
    const packageRoot = acceptedPackage
      ? sequencePackageRootForMetaPath(join(store.workspaceRoot(), acceptedPackage.path))
      : null;
    if (metadata && !packageRoot) throw new Error('Accepted sequence package root is unavailable.');
    const managed = before
      ? readManagedSequenceDocumentRef(before.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD])
      : null;
    if (
      before &&
      (before.workspaceId !== workspaceId ||
        (metadata
          ? before.kind !== metadata.entity.schema.name || managed?.packageId !== resourceId
          : !Object.hasOwn(before.fields, 'sequence')))
    )
      throw new Error('Accepted sequence identity conflicts with another Registry owner or kind.');
    const blob = defineBlob(new TextEncoder().encode(text));
    const contentSummary = {
      length: document.bases.length,
      topology: document.topology,
      geneticCode: resolveSequenceGeneticCode({
        annotations: geneticCodeAnnotations(document.annotations),
        chosenGeneticCode: document.fields.chosenGeneticCode as GeneticCodeSpec | undefined,
        unreadableGeneticCode:
          typeof document.fields.unreadableGeneticCode === 'string'
            ? document.fields.unreadableGeneticCode
            : undefined,
      }).code,
    };
    const fields =
      metadata && packageRoot
        ? projectSequencePackageRegistryFields(
            metadata,
            {
              kind: 'managed-sequence',
              packageId: resourceId,
              packageRoot,
            },
            contentSummary
          )
        : {
            ...before?.fields,
            sequence: {
              mode: 'file',
              documentId: resourceId,
              acceptedRevisionId: snapshot.revisionId,
              workspaceId,
              relPath: join(store.workspaceRoot(), path),
              ...contentSummary,
              contentHash: blob.hash,
              fileContentHash: blob.hash,
              normalizedSequenceHash: defineBlob(
                new TextEncoder().encode(document.bases.toUpperCase())
              ).hash,
              sourceFormat: snapshot.representation?.format === 'genbank-v1' ? 'gb' : 'unknown',
              sizeBytes: blob.byteLength,
            },
          };
    const name = metadata?.name ?? document.name;
    if (snapshot.representation?.format === 'genbank-v1') {
      projectAcceptedSequenceCatalogInsideTx(db, {
        workspaceId,
        root: store.workspaceRoot(),
        resourceId,
        name,
        path,
        text,
        packageRoot,
      });
      sequencePaths.push(path, ...(acceptedPackage ? [acceptedPackage.path, dirname(path)] : []));
    }
    projectAcceptedSequenceIdentityInsideTx(db, {
      workspaceId,
      documentId: resourceId,
      path: join(store.workspaceRoot(), path),
      name,
      length: document.bases.length,
      circular: document.topology === 'circular',
    });
    const nativeStatus = metadata
      ? {
          registrationStatus: metadata.entity.registrationStatus,
          domainStatus: metadata.entity.domainStatus,
        }
      : {};
    if (!before)
      registerLimsEntityInsideTx(db, {
        id: resourceId,
        kind:
          metadata?.entity.schema.name ??
          (document.molecule === 'DNA' ? 'dna_sequence' : 'rna_sequence'),
        name,
        fields,
        ...nativeStatus,
        ...(metadata
          ? {
              schemaRevisionId: metadata.entity.schema.schemaRevisionId,
              schemaSnapshot: metadata.entity.schema,
            }
          : {}),
        workspaceId,
        actor,
      });
    else {
      if (
        before.name !== name ||
        !isDeepStrictEqual(before.fields, fields) ||
        (metadata &&
          (before.registrationStatus !== nativeStatus.registrationStatus ||
            before.domainStatus !== nativeStatus.domainStatus))
      )
        updateLimsEntityInsideTx(db, {
          id: resourceId,
          name,
          fields,
          ...nativeStatus,
          replaceFields: true,
          actor,
          workspaceId,
        });
      if (before.tombstone) restoreLimsEntityInsideTx(db, { id: resourceId, actor });
    }
  }
  const owners = new Set<string>([
    ...removedStrains,
    ...strains.map((snapshot) => snapshot.resourceId),
  ]);
  for (const snapshot of primers) {
    const path = paths.get(snapshot.resourceId);
    if (!path) throw new Error('Accepted primer has no current file locator.');
    projectAcceptedPrimerInsideTx({
      db,
      workspaceId,
      root: store.workspaceRoot(),
      path,
      snapshot,
      reader,
    });
  }
  for (const snapshot of strains) {
    const document = parseEntityArtifact(snapshot.representation.text);
    const row = db.prepare('SELECT * FROM lims_entity WHERE id = ?').get(document.id) as
      | LimsEntityRow
      | undefined;
    const data = {
      id: document.id,
      name: document.name,
      fields: document.fields,
      registrationStatus: document.registrationStatus,
      domainStatus: document.domainStatus,
      ...(document.schemaSnapshot
        ? {
            schemaRevisionId: document.schemaSnapshot.schemaRevisionId,
            schemaSnapshot: document.schemaSnapshot,
          }
        : {}),
      workspaceId,
      actor,
    };
    if (!row) registerLimsEntityInsideTx(db, { ...data, kind: 'strain' });
    else {
      const before = limsEntityFromRow(row);
      if (before.kind !== 'strain' || before.workspaceId !== workspaceId)
        throw new Error('Accepted strain identity conflicts with another Registry owner.');
      if (
        before.name !== data.name ||
        !isDeepStrictEqual(before.fields, data.fields) ||
        before.registrationStatus !== data.registrationStatus ||
        before.domainStatus !== data.domainStatus
      )
        updateLimsEntityInsideTx(db, { ...data, replaceFields: true });
      if (before.tombstone) restoreLimsEntityInsideTx(db, { id: document.id, actor });
    }
  }
  for (const snapshot of primers) {
    const path = paths.get(snapshot.resourceId);
    if (!path) throw new Error('Accepted primer has no current file locator.');
    projectAcceptedPrimerRegistryRelationshipsInsideTx({
      db,
      workspaceId,
      root: store.workspaceRoot(),
      path,
      snapshot,
    });
  }
  const desired = new Map<
    string,
    {
      fromEntityId: string;
      toEntityId: string;
      type: string;
      payload: Record<string, unknown>;
    }
  >();
  for (const snapshot of strains)
    for (const claim of parseNativeStrainRelationships(snapshot.representation.text)) {
      const relationship = reader.current(claim.resourceId)?.document;
      if (
        !relationship ||
        (relationship.kind !== 'strain-descent' && relationship.kind !== 'strain-sequence')
      )
        throw new Error('Accepted native strain relationship is unavailable.');
      const target =
        relationship.kind === 'strain-descent' ? relationship.parent : relationship.sequence;

      if (!reader.current(target.resourceId)) continue;
      const type = claim.fields.nativeRelationshipType;
      if (typeof type !== 'string')
        throw new Error('Accepted native relationship role is invalid.');
      const link = {
        type,
        fromEntityId: type === 'carried_by' ? target.resourceId : relationship.strainId,
        toEntityId: type === 'carried_by' ? relationship.strainId : target.resourceId,
        payload: {
          ...nativeRecord(claim.fields.payload),
          assertion: 'planned',
          targetRevisionId: target.revisionId,
        },
      };
      for (const endpoint of [link.fromEntityId, link.toEntityId]) {
        const row = db
          .prepare('SELECT workspace_id, tombstone FROM lims_entity WHERE id = ?')
          .get(endpoint) as { workspace_id: number | null; tombstone: number } | undefined;
        if (!row || row.tombstone || row.workspace_id !== workspaceId)
          throw new Error(
            'Accepted strain relationship requires its active owning Registry endpoints.'
          );
      }
      const existing = db
        .prepare(
          'SELECT workspace_id FROM lims_link WHERE from_entity_id = ? AND to_entity_id = ? AND type = ?'
        )
        .get(link.fromEntityId, link.toEntityId, link.type) as
        | { workspace_id: number | null }
        | undefined;
      if (existing && existing.workspace_id !== workspaceId)
        throw new Error('Accepted strain relationship conflicts with another Registry owner.');
      desired.set(tuple(link), link);
    }

  const existing = db
    .prepare('SELECT * FROM lims_link WHERE workspace_id = ? AND tombstone = 0')
    .all(workspaceId) as LimsLinkRow[];
  for (const row of existing) {
    const link = limsLinkFromRow(row);
    const owned =
      ((link.type === 'derives_from' || link.type === 'has_genome') &&
        owners.has(link.fromEntityId)) ||
      (link.type === 'carried_by' && owners.has(link.toEntityId));
    if (owned && !desired.has(tuple(link)))
      tombstoneLimsLinkInsideTx(db, row, {
        actor,
        batchId: `scientific-projection:${head}`,
        reason: 'accepted_strain_relationship_removed',
      });
  }
  for (const link of desired.values()) {
    const before = linkLimsEntitiesOrExistingInsideTx(db, { ...link, workspaceId, actor });
    if (isDeepStrictEqual(before.payload, link.payload)) continue;
    const eventSeq = nextEventSeq(db);
    const after = { ...before, payload: link.payload, actor, eventSeq, updatedAt: Date.now() };
    insertAuditEvent(db, {
      eventSeq,
      eventType: 'link_updated',
      subjectTable: 'lims_link',
      subjectId: after.id,
      actor,
      workspaceId,
      before,
      after,
    });
    upsertLimsLinkProjectionInsideTx(db, after);
  }
  return {
    head,
    acceptedResourceIds: slots?.ok ? slots.value.map((slot) => slot.resourceId) : [],
    projectedPaths: [
      ...sequencePaths,
      ...[...paths]
        .filter(
          ([resourceId]) =>
            owners.has(resourceId) || primers.some((primer) => primer.resourceId === resourceId)
        )
        .map(([, path]) => path),
    ],
    relationships: desired.size,
  };
}
