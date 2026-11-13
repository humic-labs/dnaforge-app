import type Database from 'better-sqlite3';
import type { LimsApplyImportBatchInput } from '../shared/lims';
import { isEntityRecordArtifactProjection } from '../shared/registry-file-types';
import {
  readManagedSequenceDocumentRef,
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
} from '../shared/managed-sequence-document';
import { isSequencePackageFileKind } from '../db/sequence-package';
import { derivePendingRefsInDb } from './lims-pending-refs';
import { resolveImportLinkEndpoint, shouldApplyImportRecord } from './lims-import';
import { assertRegistryEntityWriteAllowed } from './registry-write-admission';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';

export type RegistryMutationAdmission =
  | {
      kind: 'maintenance';
      purpose:
        | 'builtin-seeding'
        | 'verified-audit-repair'
        | 'display-id-allocation'
        | 'global-id-scheme'
        | 'disposable-scenario-reset';
    }
  | { kind: 'schema'; schemaId?: string; workspaceId?: number | null }
  | { kind: 'outgoing'; entityIds: readonly string[]; workspaceId?: number | null }
  | { kind: 'relationship-projection'; entityId: string }
  | { kind: 'pending'; key: string; confirmsRelationship: boolean }
  | { kind: 'import'; input: LimsApplyImportBatchInput }
  | { kind: 'undo-import'; batchId: string };

type Subject = { id: string; workspaceId: number | null; identity: string };

function entitySubject(db: Database.Database, id: string): Subject {
  const row = db.prepare('SELECT workspace_id,fields FROM lims_entity WHERE id=?').get(id) as
    | { workspace_id: number | null; fields: string }
    | undefined;
  if (!row) throw new Error(`LIMS entity not found: ${id}`);
  const owners = db
    .prepare(
      "SELECT workspace_id,path,file_kind FROM catalog_entity_files WHERE entity_id=? AND status='current'"
    )
    .all(id) as Array<{ workspace_id: number | null; path: string; file_kind: string }>;
  const catalog = db.prepare('SELECT workspace_id FROM catalog_entities WHERE id=?').get(id) as
    | { workspace_id: number | null }
    | undefined;
  const canonical = new Set(
    owners.flatMap((owner) => (owner.workspace_id === null ? [] : [owner.workspace_id]))
  );
  if (catalog?.workspace_id != null) canonical.add(catalog.workspace_id);
  if (canonical.size > 1 || (canonical.size === 1 && row.workspace_id !== [...canonical][0]))
    throw new Error(
      'REGISTRY_OWNER_REQUIRES_NATIVE_LIFECYCLE: Registry and canonical source ownership disagree.'
    );
  return {
    id,
    workspaceId: [...canonical][0] ?? row.workspace_id,
    identity: JSON.stringify([row.fields, owners, catalog?.workspace_id ?? null]),
  };
}

export function assertRegistryOutgoingAuthoringAllowed(
  db: Database.Database,
  id: string,
  workspaceId?: number | null
): void {
  assertRegistryEntityWriteAllowed(db, {
    id,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
  });
  const row = db.prepare('SELECT fields FROM lims_entity WHERE id=?').get(id) as
    | { fields: string }
    | undefined;
  if (!row) throw new Error(`LIMS entity not found: ${id}`);
  const fields = JSON.parse(row.fields) as Record<string, unknown>;
  const bindings = db
    .prepare("SELECT file_kind FROM catalog_entity_files WHERE entity_id=? AND status='current'")
    .all(id) as Array<{ file_kind: string }>;
  if (
    isEntityRecordArtifactProjection(fields) ||
    readManagedSequenceDocumentRef(fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]) ||
    bindings.some((binding) => isSequencePackageFileKind(binding.file_kind))
  )
    throw new Error(
      'Registry relationships are owned by the authoritative file; use its versioned native document operation.'
    );
}

function importedExternalSources(
  db: Database.Database,
  input: LimsApplyImportBatchInput
): string[] {
  const records = input.records.filter(shouldApplyImportRecord);
  const ids = new Set(records.flatMap((record) => (record.entity.id ? [record.entity.id] : [])));
  const names = new Set(records.map((record) => record.entity.name));
  return records.flatMap((record) =>
    (record.links ?? []).flatMap((link) => {
      if (!link.fromEntityId && !link.fromEntityLookup) return [];
      if (link.fromEntityId && ids.has(link.fromEntityId)) return [];
      if (!link.fromEntityId && link.fromEntityLookup && names.has(link.fromEntityLookup.name))
        return [];
      return [resolveImportLinkEndpoint(db, link, 'from', '')];
    })
  );
}

export function registryMutationSubjectsInDb(
  db: Database.Database,
  admission: RegistryMutationAdmission
): Subject[] {
  switch (admission.kind) {
    case 'maintenance':
      return [];
    case 'schema': {
      const existing = admission.schemaId
        ? (db.prepare('SELECT workspace_id FROM lims_schema WHERE id=?').get(admission.schemaId) as
            | { workspace_id: number | null }
            | undefined)
        : undefined;
      if (
        existing &&
        admission.workspaceId !== undefined &&
        admission.workspaceId !== existing.workspace_id
      )
        throw new Error(
          'REGISTRY_OWNER_REQUIRES_NATIVE_LIFECYCLE: A schema field edit cannot transfer its project.'
        );
      return [
        {
          id: `schema:${admission.schemaId ?? 'new'}`,
          workspaceId: existing?.workspace_id ?? admission.workspaceId ?? null,
          identity: String(existing?.workspace_id ?? admission.workspaceId ?? null),
        },
      ];
    }
    case 'outgoing':
      return [...new Set(admission.entityIds)].map((id) => entitySubject(db, id));
    case 'relationship-projection':
      return [entitySubject(db, admission.entityId)];
    case 'pending': {
      const ref = derivePendingRefsInDb(db).find((item) => item.key === admission.key);
      if (!ref) throw new Error(`Pending reference not found: ${admission.key}`);
      return [entitySubject(db, ref.referrerEntityId)];
    }
    case 'import':
      return [
        ...admission.input.records.filter(shouldApplyImportRecord).map((record) => ({
          id: record.entity.id ?? `new:${record.id}`,
          workspaceId: record.entity.workspaceId ?? null,
          identity: JSON.stringify(record.entity),
        })),
        ...importedExternalSources(db, admission.input).map((id) => entitySubject(db, id)),
      ];
    case 'undo-import': {
      const ids = db
        .prepare(
          `SELECT DISTINCT subject_id AS id FROM lims_audit WHERE batch_id=? AND subject_table='lims_entity' AND event_type='entity_registered'
        UNION SELECT DISTINCT l.from_entity_id AS id FROM lims_audit a JOIN lims_link l ON l.id=a.subject_id WHERE a.batch_id=? AND a.subject_table='lims_link' AND a.event_type='link_created'`
        )
        .all(admission.batchId.trim(), admission.batchId.trim()) as Array<{ id: string }>;
      return ids.map((row) => entitySubject(db, row.id));
    }
  }
}

export function registryMutationWorkspacePathsInDb(
  db: Database.Database,
  admission: RegistryMutationAdmission
): string[] {
  return [
    ...new Set(
      registryMutationSubjectsInDb(db, admission).flatMap((subject) => {
        if (subject.workspaceId === null) return [];
        const owner = db
          .prepare('SELECT path FROM workspaces WHERE id=?')
          .get(subject.workspaceId) as { path: string } | undefined;
        if (!owner) throw new Error('WORKSPACE_MUTATION_UNKNOWN_WORKSPACE');
        return [owner.path];
      })
    ),
  ];
}

export function assertRegistrySemanticMutationAllowed(
  db: Database.Database,
  admission: RegistryMutationAdmission
): string {
  const subjects = registryMutationSubjectsInDb(db, admission);
  if (admission.kind !== 'relationship-projection') {
    assertWorkspaceWriteAllowed(db, registryMutationWorkspacePathsInDb(db, admission));
    if (admission.kind === 'outgoing') {
      for (const id of admission.entityIds)
        assertRegistryOutgoingAuthoringAllowed(db, id, admission.workspaceId);
    } else if (admission.kind === 'pending' && admission.confirmsRelationship) {
      for (const subject of subjects) assertRegistryOutgoingAuthoringAllowed(db, subject.id);
    } else if (admission.kind === 'import') {
      for (const record of admission.input.records.filter(shouldApplyImportRecord))
        assertRegistryEntityWriteAllowed(db, record.entity);
      for (const id of importedExternalSources(db, admission.input))
        assertRegistryOutgoingAuthoringAllowed(db, id);
    } else if (admission.kind === 'undo-import') {
      const externalSources = db
        .prepare(
          `SELECT DISTINCT l.from_entity_id AS id FROM lims_audit a JOIN lims_link l ON l.id=a.subject_id WHERE a.batch_id=? AND a.subject_table='lims_link' AND a.event_type='link_created' AND l.tombstone=0 AND NOT EXISTS (SELECT 1 FROM lims_audit e WHERE e.batch_id=a.batch_id AND e.subject_table='lims_entity' AND e.event_type='entity_registered' AND e.subject_id=l.from_entity_id)`
        )
        .all(admission.batchId.trim()) as Array<{ id: string }>;
      for (const source of externalSources) assertRegistryOutgoingAuthoringAllowed(db, source.id);
      const rows = db
        .prepare(
          `SELECT DISTINCT e.id,e.fields,f.path FROM lims_audit a JOIN lims_entity e ON e.id=a.subject_id LEFT JOIN catalog_entity_files f ON f.entity_id=e.id AND f.status='current' WHERE a.batch_id=? AND a.subject_table='lims_entity' AND a.event_type='entity_registered' AND e.tombstone=0`
        )
        .all(admission.batchId.trim()) as Array<{
        id: string;
        fields: string;
        path: string | null;
      }>;
      for (const row of rows) {
        const fields = JSON.parse(row.fields) as Record<string, unknown>;
        if (
          !isEntityRecordArtifactProjection(fields) &&
          (row.path ||
            fields.artifact ||
            readManagedSequenceDocumentRef(fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]))
        )
          throw new Error(
            'Import Undo for this file-owned entity requires its owning native document operation.'
          );
      }
    }
  }
  return JSON.stringify(subjects.sort((left, right) => left.id.localeCompare(right.id)));
}
