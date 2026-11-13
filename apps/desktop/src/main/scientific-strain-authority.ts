import type Database from 'better-sqlite3';
import { defineBlob } from '@waypoint/workspace-revisions';
import { join } from 'node:path';
import { parseLimsSchemaFields, type LimsRegistryPreview } from '../shared/lims';
import { ScientificObjectStore, hasAcceptedScientificWorkspace } from './scientific-object-store';

export function acceptedScientificResourceIds(
  db: Database.Database,
  workspaceId: number
): ReadonlySet<string> {
  if (!hasAcceptedScientificWorkspace(db, workspaceId)) return new Set();
  return new Set(
    new ScientificObjectStore(db, workspaceId).catalog().entries.map((slot) => slot.resourceId)
  );
}

export function ownsAcceptedScientificEntity(
  db: Database.Database,
  entityId: string,
  workspaceHint?: number | null
): boolean {
  const row = db.prepare('SELECT workspace_id FROM lims_entity WHERE id=?').get(entityId) as
    | { workspace_id: number | null }
    | undefined;
  const workspaceId = row?.workspace_id ?? workspaceHint;
  return workspaceId != null && acceptedScientificResourceIds(db, workspaceId).has(entityId);
}

export function readAcceptedScientificStrain(
  db: Database.Database,
  entityId: string,
  workspaceHint?: number | null
) {
  const row = db.prepare('SELECT workspace_id FROM lims_entity WHERE id = ?').get(entityId) as
    | { workspace_id: number | null }
    | undefined;
  const workspaceId = row?.workspace_id ?? workspaceHint;
  if (workspaceId == null) return null;
  if (!hasAcceptedScientificWorkspace(db, workspaceId)) return null;
  const store = new ScientificObjectStore(db, workspaceId);
  const catalog = store.catalog();
  const slot = catalog.entries.find((entry) => entry.resourceId === entityId);
  if (!catalog.head || !slot || slot.tombstone || !slot.path) return null;
  const snapshot = store.read().reader.current(slot.resourceId);
  if (!snapshot || snapshot.document.kind !== 'strain') return null;
  const workspace = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as
    | { path: string }
    | undefined;
  if (!workspace) throw new Error('The accepted strain has no owning workspace.');
  return {
    snapshot,
    head: catalog.head,
    workspaceId,
    workspaceRoot: workspace.path,
    artifactPath: join(workspace.path, slot.path),
  };
}

export function readScientificStrainRegistryRecord(
  db: Database.Database,
  entityId: string
): LimsRegistryPreview['nativeRecord'] | null {
  const state = readAcceptedScientificStrain(db, entityId);
  if (!state || state.snapshot.representation?.format !== 'strain-entity-v1') return null;
  const row = db
    .prepare(
      `
    SELECT s.id AS schemaId, r.id AS schemaRevisionId, r.version,
           s.name, s.display_name AS displayName, s.description, r.fields AS fieldsJson
      FROM lims_schema_revision r
      JOIN lims_schema s ON s.id = r.schema_id
      JOIN lims_entity l ON l.schema_revision_id = r.id
     WHERE l.id = ?
  `
    )
    .get(entityId) as
    | {
        schemaId: string;
        schemaRevisionId: string;
        version: number;
        name: string;
        displayName: string;
        description: string | null;
        fieldsJson: string;
      }
    | undefined;
  if (!row) throw new Error('The accepted strain schema is unavailable.');
  const definition = parseLimsSchemaFields(row.fieldsJson);
  const representation = state.snapshot.representation;
  return {
    schemaSnapshot: {
      schemaId: row.schemaId,
      schemaRevisionId: row.schemaRevisionId,
      version: row.version,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      baseKind: definition.baseKind ?? 'strain',
      fields: definition.fields.map((field) => ({ ...field })),
    },
    scientificAuthority: {
      workspaceRoot: state.workspaceRoot,
      workspaceId: state.workspaceId,
      artifactPath: state.artifactPath,
      revision: {
        kind: 'accepted-object',
        resourceId: state.snapshot.resourceId,
        resourceRevisionId: state.snapshot.revisionId,
        workspaceVersionId: state.head,
        contentSha256: defineBlob(new TextEncoder().encode(representation.text)).hash.slice(
          'sha256:'.length
        ),
        sequenceEditParentEventId: null,
      },
    },
  };
}
