import type Database from 'better-sqlite3';

import type { ImportDecision } from '../../shared/benchling-import-decision';
import type { ProjectionReceipt, SourceObject } from '../../shared/benchling-migration';
import {
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  parseNativeWorkspaceManifest,
  type NativeWorkspaceManifestEntityV2,
  type NativeWorkspaceMigrationSourceRef,
} from '../../shared/native-workspace-manifest';
import {
  providerObjectClassForStableId,
  isSafeProviderCanonicalUrl,
} from '../../shared/provider-object-reference';
import { portableLimsFields } from '../native-workspace-manifest';
import { listProviderBindingsForEntity } from '../catalog-provider-bindings';
import { readNativeCatalogRecordState } from '../native-catalog-record-state';
import { mapPortableRecordRelationships } from '../../shared/portable-record-relationships';
import { stripWorkspaceScope } from '../../shared/workspace-scoped-identity';

export type ReviewedNativeLink = Readonly<{
  decision: Extract<ImportDecision, { kind: 'unbound_exact_match' }>;
  sourceObject: SourceObject;
  entity: NativeWorkspaceManifestEntityV2;
}>;

export function readReviewedNativeLink(input: {
  db: Database.Database;
  workspaceDbId: number;
  workspacePath: string;
  decision: ReviewedNativeLink['decision'];
  sourceObject: SourceObject;
  receipt: ProjectionReceipt;
  migrationSource: NativeWorkspaceMigrationSourceRef;
}): ReviewedNativeLink {
  const entity = readRetainedNativeEntity({
    ...input,
    entityId: input.decision.candidateEntityId,
    reviewedSourceObject: input.sourceObject,
  });
  return { decision: input.decision, sourceObject: input.sourceObject, entity };
}

export function readRetainedNativeEntity(input: {
  db: Database.Database;
  workspaceDbId: number;
  workspacePath: string;
  entityId: string;
  receipt: ProjectionReceipt;
  migrationSource: NativeWorkspaceMigrationSourceRef;
  reviewedSourceObject?: SourceObject;
}): NativeWorkspaceManifestEntityV2 {
  const row = input.db
    .prepare(
      `SELECT e.name, e.type, l.kind, l.name AS lims_name, l.fields,
            l.registration_status, l.domain_status, l.created_at, f.file_kind
       FROM catalog_entities e JOIN lims_entity l ON l.id = e.id
       LEFT JOIN catalog_entity_files f ON f.entity_id = e.id AND f.workspace_id = e.workspace_id AND f.status = 'current'
      WHERE e.id = ? AND e.workspace_id = ? AND e.status = 'active'
        AND l.tombstone = 0`
    )
    .get(input.entityId, input.workspaceDbId) as
    | {
        name: string;
        type: string;
        kind: string;
        lims_name: string;
        fields: string;
        registration_status: string;
        domain_status: string | null;
        created_at: number;
        file_kind: string | null;
      }
    | undefined;
  if (!row || !input.receipt.destination)
    throw new Error('Reviewed native item is no longer available.');
  const fields: unknown = JSON.parse(row.fields);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Reviewed native item has invalid scientific fields.');
  }
  const destination = input.receipt.destination;
  const identities = listProviderBindingsForEntity(input.db, input.entityId).map((binding) => ({
    provider: binding.provider,
    stableObjectId: binding.stable_object_id,
    objectClass: binding.object_class,
    bindingKind: binding.binding_kind,
    ...(binding.canonical_url ? { canonicalUrl: binding.canonical_url } : {}),
  }));
  if (input.reviewedSourceObject) {
    const source = input.reviewedSourceObject;
    const existingIndex = identities.findIndex(
      (identity) => identity.provider === 'benchling' && identity.stableObjectId === source.stableId
    );
    const reviewedIdentity = {
      provider: 'benchling',
      stableObjectId: source.stableId,
      objectClass: providerObjectClassForStableId(source.stableId),
      bindingKind: 'reviewed' as const,
      ...(isSafeProviderCanonicalUrl(source.sourceUrl) ? { canonicalUrl: source.sourceUrl } : {}),
    };
    if (!reviewedIdentity.objectClass)
      throw new Error('Reviewed source has no provider object class.');
    if (existingIndex < 0)
      identities.push({ ...reviewedIdentity, objectClass: reviewedIdentity.objectClass });
    else
      identities[existingIndex] = {
        ...reviewedIdentity,
        objectClass: reviewedIdentity.objectClass,
      };
  }
  const relativePath =
    destination.kind === 'file'
      ? destination.relativePath
      : destination.kind === 'package'
        ? destination.primaryRelativePath
        : null;
  const recordState = readNativeCatalogRecordState(input.db, input.entityId);
  const manifest = parseNativeWorkspaceManifest(
    JSON.stringify({
      schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
      entities: [
        {
          id: input.receipt.destinationObjectId,
          type: row.type,
          name: row.name,
          placement:
            destination.kind === 'catalog-record'
              ? destination
              : { ...destination, fileKind: row.file_kind },
          lims: {
            kind: row.kind,
            name: row.lims_name,
            fields: mapPortableRecordRelationships(
              portableLimsFields(
                fields as Record<string, unknown>,
                input.workspacePath,
                relativePath,
                recordState?.schemaSnapshot
              ),
              recordState?.schemaSnapshot,
              stripWorkspaceScope
            ),
            ...(recordState
              ? {
                  schemaRevisionId: recordState.schemaSnapshot.schemaRevisionId,
                  schemaSnapshot: recordState.schemaSnapshot,
                }
              : {}),
            registrationStatus: row.registration_status,
            domainStatus: row.domain_status,
            createdAt: row.created_at,
          },
          sourceIdentities: identities,
          migrationSource: input.migrationSource,
        },
      ],
      links: [],
    })
  );
  if (manifest.schema !== NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA || !manifest.entities[0]) {
    throw new Error('Reviewed native item has no portable representation.');
  }
  return manifest.entities[0];
}
