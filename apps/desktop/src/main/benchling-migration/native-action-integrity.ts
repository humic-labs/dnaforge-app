import { isDeepStrictEqual } from 'node:util';
import { assertReviewedTableDecision, reviewedTableRowId } from './reviewed-table-source';
import type Database from 'better-sqlite3';

import type { BenchlingMigrationActionJournal } from '../../shared/benchling-migration-action-journal';
import {
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  type NativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';
import { scopedProjectionId, stripWorkspaceScope } from '../../shared/workspace-scoped-identity';
import { portableLimsFields } from '../native-workspace-manifest';
import { mapPortableRecordRelationships } from '../../shared/portable-record-relationships';

export function assertNativeActionCatalogIntegrity(input: {
  db: Database.Database;
  workspacePath: string;
  journal: BenchlingMigrationActionJournal;
  manifest: NativeWorkspaceManifest;
}): void {
  if (input.manifest.schema !== NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA)
    throw new Error('Native action requires a v2 manifest.');
  const workspace = input.db
    .prepare('SELECT id, repo_uuid FROM workspaces WHERE path = ?')
    .get(input.workspacePath) as { id: number; repo_uuid: string | null } | undefined;
  const binding = input.journal.workspace;
  if (
    !workspace ||
    workspace.repo_uuid !== binding.repoUuid ||
    (binding.workspaceDbId !== null && workspace.id !== binding.workspaceDbId)
  )
    throw new Error('Native action workspace registration disagrees with its journal.');
  const workspaceDbId = workspace.id;
  const manifestById = new Map(input.manifest.entities.map((entity) => [entity.id, entity]));
  for (const allocation of input.journal.allocations) {
    const entity = manifestById.get(allocation.destinationEntityId);
    const entityId = scopedProjectionId(
      input.journal.workspace.projectionScopeId,
      allocation.destinationEntityId
    );
    if (!entity) throw new Error('Native action destination is absent from the manifest.');
    const row = input.db
      .prepare(
        `SELECT type, name, status, metadata FROM catalog_entities WHERE id = ? AND workspace_id = ?`
      )
      .get(entityId, workspaceDbId) as
      | { type: string; name: string; status: string; metadata: string | null }
      | undefined;
    if (!row || row.status !== 'active' || row.type !== entity.type || row.name !== entity.name)
      throw new Error('Native action catalog identity disagrees with the manifest.');
    const metadata = parseRecord(row.metadata ?? '{}');
    if (
      !entity.migrationSource ||
      !isDeepStrictEqual(metadata.migrationSource, entity.migrationSource)
    )
      throw new Error('Native action migration-source record disagrees with the manifest.');
    const identity = allocation.providerIdentity;
    if (entity.migrationSource.kind === 'reviewed_table_row') {
      const ref = entity.migrationSource.reviewedTable;
      if (ref.actionId !== input.journal.actionId)
        throw new Error('Reviewed table source belongs to another action.');
      assertReviewedTableDecision(
        ref,
        input.journal.decisions.filter((decision) => decision.kind === 'registry_table_mapping')
      );
      if (
        !identity &&
        (reviewedTableRowId(ref.source.entryPath, ref.source.entrySha256, ref.rowOrdinal) !==
          allocation.sourceObjectId ||
          !isDeepStrictEqual(ref, allocation.reviewedTable))
      )
        throw new Error('Reviewed table row identity disagrees with its allocation.');
    } else if (!identity)
      throw new Error('Local table allocation is missing its source authority.');
    if (identity) {
      const binding = input.db
        .prepare(
          `SELECT entity_id, binding_kind FROM catalog_provider_bindings WHERE provider = ? AND stable_object_id = ? AND object_class = ? AND entity_id IN (SELECT id FROM catalog_entities WHERE workspace_id = ? AND status = 'active')`
        )
        .all(
          identity.provider,
          identity.stableObjectId,
          identity.objectClass,
          workspaceDbId
        ) as Array<{ entity_id: string; binding_kind: string }>;
      const portableIdentity = entity.sourceIdentities?.find(
        (entry) =>
          entry.provider === identity.provider &&
          entry.stableObjectId === identity.stableObjectId &&
          entry.objectClass === identity.objectClass
      );
      if (
        binding.length !== 1 ||
        binding[0].entity_id !== entityId ||
        !portableIdentity ||
        binding[0].binding_kind !== portableIdentity.bindingKind
      )
        throw new Error('Native action provider binding disagrees with the manifest.');
    } else {
      const inferred = input.db
        .prepare(
          "SELECT 1 FROM catalog_provider_bindings WHERE entity_id = ? AND provider = 'benchling'"
        )
        .get(entityId);
      if (inferred || entity.sourceIdentities?.some((source) => source.provider === 'benchling'))
        throw new Error('A local table row cannot have an inferred Benchling binding.');
    }
    const placement = entity.placement;
    let relativePath: string | null;
    switch (placement.kind) {
      case 'catalog-record': {
        relativePath = null;
        const location = input.db
          .prepare(
            `SELECT parent_relative_path, display_name, presentation_kind FROM catalog_workspace_placements WHERE entity_id = ? AND workspace_id = ? AND status = 'active'`
          )
          .get(entityId, workspaceDbId);
        if (
          !isDeepStrictEqual(location, {
            parent_relative_path: placement.parentRelativePath,
            display_name: placement.displayName,
            presentation_kind: placement.presentationKind,
          })
        )
          throw new Error('Native action catalog placement disagrees with the manifest.');
        break;
      }
      case 'file':
        relativePath = placement.relativePath;
        break;
      case 'package':
        relativePath =
          entity.type === 'notebook' ? placement.rootRelativePath : placement.primaryRelativePath;
        break;
      default: {
        const unhandled: never = placement;
        throw new Error(`Unknown native placement ${unhandled}`);
      }
    }
    if (relativePath) {
      const file = input.db
        .prepare(
          `SELECT relative_path FROM catalog_entity_files WHERE entity_id = ? AND workspace_id = ? AND status = 'current'`
        )
        .get(entityId, workspaceDbId);
      if (!isDeepStrictEqual(file, { relative_path: relativePath }))
        throw new Error('Native action file binding disagrees with the manifest.');
    }
    if (entity.lims) {
      const lims = input.db
        .prepare(
          `SELECT kind, name, fields, tombstone, schema_revision_id, registration_status FROM lims_entity WHERE id = ?`
        )
        .get(entityId) as
        | {
            kind: string;
            name: string;
            fields: string;
            tombstone: number;
            schema_revision_id: string;
            registration_status: string;
          }
        | undefined;
      if (
        !lims ||
        lims.tombstone !== 0 ||
        lims.kind !== entity.lims.kind ||
        lims.name !== entity.lims.name ||
        (entity.lims.schemaRevisionId !== undefined &&
          lims.schema_revision_id !== entity.lims.schemaRevisionId) ||
        (entity.lims.registrationStatus !== undefined &&
          lims.registration_status !== entity.lims.registrationStatus) ||
        !isDeepStrictEqual(
          mapPortableRecordRelationships(
            portableLimsFields(
              parseRecord(lims.fields),
              input.workspacePath,
              relativePath,
              entity.lims.schemaSnapshot
            ),
            entity.lims.schemaSnapshot,
            stripWorkspaceScope
          ),
          entity.lims.fields
        )
      )
        throw new Error('Native action LIMS projection disagrees with the manifest.');
    }
  }
}

function parseRecord(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native action catalog metadata is invalid.');
  return value as Record<string, unknown>;
}
