import { lstat } from 'node:fs/promises';

import type Database from 'better-sqlite3';

import {
  isActiveWorkspaceDnaCatalogEntity,
  type CatalogEntityType,
  type CatalogRecordPresentationKind,
} from '../../shared/catalog-entity';
import type { SourceObject } from '../../shared/benchling-migration';
import type { Sha256Digest } from '../../shared/benchling-import-decision';
import { pathIsAtOrUnder } from '../../shared/path-boundary';
import {
  nativeRegistryRecordInput,
  nativeRegistrySourceRevisionKey,
} from './native-registry-record';
import {
  nativeCatalogRecordScience,
  nativeCatalogRecordStateSha256,
  readNativeCatalogRecordState,
} from '../native-catalog-record-state';
import {
  isExactProviderStableId,
  providerObjectClassForStableId,
} from '../../shared/provider-object-reference';
import {
  listProviderBindingInventoryForWorkspace,
  upsertProviderBinding,
  type WorkspaceProviderBindingInventoryRow,
} from '../catalog-provider-bindings';
import {
  dnaBasesScientificFingerprint,
  dnaScientificFingerprint,
  findUnboundExactNativeMatch,
  type NativeExactMatchCandidate,
  type NativeExactMatchResult,
} from './native-exact-match';

export type DestinationInventoryLocation =
  | Readonly<{
      kind: 'file';
      entityId: string;
      displayName: string;
      relativePath: string;
      fileKind: string;
      scientificSha256: Sha256Digest | null;
    }>
  | Readonly<{
      kind: 'catalog-record';
      entityId: string;
      displayName: string;
      catalogType: string;
      parentRelativePath: string;
      presentationKind: CatalogRecordPresentationKind;
      scientificSha256: Sha256Digest;
    }>;

export type DestinationProviderMatch =
  | Readonly<{
      sourceObjectId: string;
      stableId: string;
      state: 'unbound';
    }>
  | Readonly<{
      sourceObjectId: string;
      stableId: string;
      state: 'stale';
      bindingEntityIds: readonly string[];
    }>
  | Readonly<{
      sourceObjectId: string;
      stableId: string;
      state: 'ambiguous';
      candidateEntityIds: readonly string[];
    }>
  | Readonly<{
      sourceObjectId: string;
      stableId: string;
      state: 'matched';
      destination: DestinationInventoryLocation;
      scientificComparison: 'equal' | 'changed' | 'unknown';
    }>;

export type DestinationNativeExactMatch = Readonly<{
  sourceObjectId: string;
  result: NativeExactMatchResult;
}>;

export type DestinationInventory = Readonly<{
  workspaceDbId: number;
  providerMatches: readonly DestinationProviderMatch[];
  nativeExactMatches: readonly DestinationNativeExactMatch[];
}>;

export async function buildDestinationInventory(input: {
  db: Database.Database;
  workspaceDbId: number;
  workspacePath: string;
  sourceObjects: readonly SourceObject[];
  assertMutationLeaseHeld: () => void;
}): Promise<DestinationInventory> {
  input.assertMutationLeaseHeld();
  if (!Number.isSafeInteger(input.workspaceDbId) || input.workspaceDbId <= 0) {
    throw new Error('Destination inventory requires a positive workspace row ID.');
  }
  const bindings = listProviderBindingInventoryForWorkspace(
    input.db,
    input.workspaceDbId,
    'benchling'
  );
  const bindingRowsByIdentity = groupBindingRows(bindings);
  const providerMatches: DestinationProviderMatch[] = [];

  for (const sourceObject of [...input.sourceObjects].sort(compareSourceObjects)) {
    const objectClass = providerObjectClassForStableId(sourceObject.stableId);
    if (!objectClass || !isExactProviderStableId(sourceObject.stableId)) {
      providerMatches.push({
        sourceObjectId: sourceObject.id,
        stableId: sourceObject.stableId,
        state: 'unbound',
      });
      continue;
    }
    const rows = bindingRowsByIdentity.get(identityKey(sourceObject.stableId, objectClass)) ?? [];
    const destinations = await resolveActiveDestinations(
      rows,
      input.workspaceDbId,
      input.workspacePath,
      input.db
    );
    if (destinations.length === 0) {
      providerMatches.push(
        rows.length === 0
          ? {
              sourceObjectId: sourceObject.id,
              stableId: sourceObject.stableId,
              state: 'unbound',
            }
          : {
              sourceObjectId: sourceObject.id,
              stableId: sourceObject.stableId,
              state: 'stale',
              bindingEntityIds: uniqueSorted(rows.map((row) => row.entity_id)),
            }
      );
      continue;
    }
    if (destinations.length > 1) {
      providerMatches.push({
        sourceObjectId: sourceObject.id,
        stableId: sourceObject.stableId,
        state: 'ambiguous',
        candidateEntityIds: destinations.map((destination) => destination.entityId).sort(),
      });
      continue;
    }
    const destination = destinations[0];
    if (!destination) throw new Error('Destination inventory lost its only candidate.');
    const incomingFingerprint = dnaScientificFingerprint(sourceObject);
    let scientificComparison: 'equal' | 'changed' | 'unknown' =
      !incomingFingerprint || !destination.scientificSha256
        ? 'unknown'
        : incomingFingerprint === destination.scientificSha256
          ? 'equal'
          : 'changed';
    if (
      sourceObject.sourceType === 'registry_record' &&
      destination.kind === 'catalog-record' &&
      destination.catalogType === 'record'
    ) {
      const current = readNativeCatalogRecordState(input.db, destination.entityId);
      if (!current) throw new Error('Native registry destination disappeared during inventory.');
      const targets = new Map<string, string>();
      for (const relationship of sourceObject.relationships) {
        const targetId = relationship.targetSourceId;
        if (!targetId) continue;
        const targetClass = providerObjectClassForStableId(targetId);
        if (!targetClass) continue;
        const matches = await resolveActiveDestinations(
          bindingRowsByIdentity.get(identityKey(targetId, targetClass)) ?? [],
          input.workspaceDbId,
          input.workspacePath,
          input.db
        );
        if (matches.length === 1 && matches[0]) targets.set(targetId, matches[0].entityId);
      }
      const incoming = nativeRegistryRecordInput({
        source: sourceObject,
        scopeId: 'comparison',
        createdAt: 0,
        resolveTarget: (_relationshipId, targetId) => targets.get(targetId) ?? null,
      });
      if (!incoming.schemaSnapshot) throw new Error('Native registry input has no pinned schema.');
      scientificComparison =
        nativeRegistrySourceRevisionKey(current.metadata) ===
          nativeRegistrySourceRevisionKey(sourceObject.metadata) &&
        nativeCatalogRecordScience(current) ===
          nativeCatalogRecordScience({ ...incoming, schemaSnapshot: incoming.schemaSnapshot })
          ? 'equal'
          : 'changed';
    }
    providerMatches.push({
      sourceObjectId: sourceObject.id,
      stableId: sourceObject.stableId,
      state: 'matched',
      destination,
      scientificComparison,
    });
  }

  const nativeCandidates = listNativeExactMatchCandidates(input.db, input.workspaceDbId);
  const nativeExactMatches = providerMatches
    .filter((match) => match.state === 'unbound')
    .map((match) => {
      const sourceObject = input.sourceObjects.find(
        (candidate) => candidate.id === match.sourceObjectId
      );
      if (!sourceObject) throw new Error('Destination inventory source object disappeared.');
      return {
        sourceObjectId: sourceObject.id,
        result: findUnboundExactNativeMatch({ sourceObject, candidates: nativeCandidates }),
      };
    });

  return {
    workspaceDbId: input.workspaceDbId,
    providerMatches,
    nativeExactMatches,
  };
}

export function linkReviewedExactNativeMatch(input: {
  db: Database.Database;
  workspaceDbId: number;
  runId: string;
  sourceObject: SourceObject;
  candidateEntityId: string;
  expectedCandidateScientificSha256: Sha256Digest;
  now?: number;
}): void {
  const objectClass = providerObjectClassForStableId(input.sourceObject.stableId);
  if (!objectClass || !isExactProviderStableId(input.sourceObject.stableId)) {
    throw new Error('Exact-native linking requires an exact Benchling identity.');
  }
  input.db.transaction(() => {
    const candidate = input.db
      .prepare(
        `SELECT e.id, e.name, e.type, e.status, e.workspace_id,
                COUNT(b.id) AS provider_binding_count
           FROM catalog_entities e
           LEFT JOIN catalog_provider_bindings b ON b.entity_id = e.id
          WHERE e.id = ?
          GROUP BY e.id, e.name, e.type, e.status, e.workspace_id`
      )
      .get(input.candidateEntityId) as
      | {
          id: string;
          name: string;
          type: CatalogEntityType;
          status: string;
          workspace_id: number | null;
          provider_binding_count: number;
        }
      | undefined;
    if (
      !candidate ||
      !isActiveWorkspaceDnaCatalogEntity(candidate, input.workspaceDbId) ||
      candidate.provider_binding_count > 1
    ) {
      throw new Error('The exact native candidate is no longer active and unbound.');
    }
    const currentFingerprint = scientificFingerprintForCatalogEntity(
      input.db,
      input.candidateEntityId
    );
    if (currentFingerprint !== input.expectedCandidateScientificSha256) {
      throw new Error('The exact native candidate changed after it was reviewed.');
    }
    const conflictingIdentityCount = (
      input.db
        .prepare(
          `SELECT COUNT(DISTINCT b.entity_id) AS count
             FROM catalog_provider_bindings b
             JOIN catalog_entities e ON e.id = b.entity_id
            WHERE b.provider = 'benchling'
              AND b.stable_object_id = ?
              AND b.object_class = ?
              AND e.workspace_id = ?`
        )
        .get(input.sourceObject.stableId, objectClass, input.workspaceDbId) as { count: number }
    ).count;
    if (candidate.provider_binding_count === 1) {
      const reviewed = input.db
        .prepare(
          `SELECT id FROM catalog_provider_bindings
          WHERE entity_id = ? AND provider = 'benchling' AND stable_object_id = ?
            AND object_class = ? AND binding_kind = 'reviewed'
            AND json_extract(evidence_json, '$.source') = 'benchling_migration_exact_native_review'
            AND json_extract(evidence_json, '$.runId') = ?
            AND json_extract(evidence_json, '$.corroboration.sourceObjectId') = ?
            AND json_extract(evidence_json, '$.corroboration.scientificSha256') = ?`
        )
        .get(
          input.candidateEntityId,
          input.sourceObject.stableId,
          objectClass,
          input.runId,
          input.sourceObject.id,
          input.expectedCandidateScientificSha256
        );
      if (reviewed && conflictingIdentityCount === 1) return;
      throw new Error('The exact native candidate is no longer active and unbound.');
    }
    if (conflictingIdentityCount !== 0) {
      throw new Error('The Benchling identity became bound after the exact match was reviewed.');
    }
    upsertProviderBinding(
      input.db,
      {
        reference: {
          provider: 'benchling',
          stableObjectId: input.sourceObject.stableId,
          objectClass,
          canonicalUrl: input.sourceObject.sourceUrl || null,
          providerAccountHint: null,
        },
        entityId: input.candidateEntityId,
        bindingKind: 'reviewed',
        evidence: {
          source: 'benchling_migration_exact_native_review',
          runId: input.runId,
          corroboration: {
            sourceObjectId: input.sourceObject.id,
            benchlingDisplayName: input.sourceObject.name,
            scientificSha256: input.expectedCandidateScientificSha256,
          },
        },
      },
      input.now
    );
  })();
}

function groupBindingRows(
  rows: readonly WorkspaceProviderBindingInventoryRow[]
): ReadonlyMap<string, WorkspaceProviderBindingInventoryRow[]> {
  const groups = new Map<string, WorkspaceProviderBindingInventoryRow[]>();
  for (const row of rows) {
    const key = identityKey(row.stable_object_id, row.object_class);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function identityKey(stableId: string, objectClass: string): string {
  return JSON.stringify(['benchling', stableId, objectClass]);
}

async function resolveActiveDestinations(
  rows: readonly WorkspaceProviderBindingInventoryRow[],
  workspaceId: number,
  workspacePath: string,
  db: Database.Database
): Promise<DestinationInventoryLocation[]> {
  const byEntity = new Map<string, DestinationInventoryLocation>();
  for (const row of rows) {
    if (byEntity.has(row.entity_id) || row.entity_status !== 'active') continue;
    const scientificSha256 = scientificFingerprintForCatalogEntity(db, row.entity_id);
    if (row.file_path && row.file_relative_path && row.file_kind && row.file_status === 'current') {
      const stat = await lstat(row.file_path).catch(() => null);
      if (!stat?.isFile() || !pathIsAtOrUnder(row.file_path, workspacePath)) continue;
      byEntity.set(row.entity_id, {
        kind: 'file',
        entityId: row.entity_id,
        displayName: row.entity_name,
        relativePath: row.file_relative_path,
        fileKind: row.file_kind,
        scientificSha256,
      });
      continue;
    }
    if (
      row.entity_storage_type === 'database' &&
      scientificSha256 &&
      (row.entity_type === 'record'
        ? row.entity_workspace_id === workspaceId
        : isActiveWorkspaceDnaCatalogEntity(
            {
              type: row.entity_type,
              status: row.entity_status,
              workspace_id: row.entity_workspace_id,
            },
            workspaceId
          ))
    ) {
      const placement = activePlacementForEntity(db, row.entity_id, workspaceId);
      if (!placement) continue;
      byEntity.set(row.entity_id, {
        kind: 'catalog-record',
        entityId: row.entity_id,
        displayName: row.entity_name,
        catalogType: row.entity_type,
        parentRelativePath: placement.parent_relative_path,
        presentationKind: placement.presentation_kind,
        scientificSha256,
      });
    }
  }
  return [...byEntity.values()].sort((left, right) => left.entityId.localeCompare(right.entityId));
}

type NativeCandidateRow = Readonly<{
  id: string;
  name: string;
  type: CatalogEntityType;
  status: string;
  workspace_id: number | null;
  fields: string;
  kind: string;
  tombstone: number;
  archived_at: number | null;
  provider_binding_count: number;
  storage_type: string;
  file_relative_path: string | null;
  file_kind: string | null;
  parent_relative_path: string | null;
  placement_display_name: string | null;
  presentation_kind: CatalogRecordPresentationKind | null;
}>;

function listNativeExactMatchCandidates(
  db: Database.Database,
  workspaceId: number
): NativeExactMatchCandidate[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.type, e.status, e.workspace_id, e.storage_type,
              l.fields, l.kind, l.tombstone, l.archived_at,
              p.parent_relative_path, p.display_name AS placement_display_name,
              p.presentation_kind,
              f.relative_path AS file_relative_path, f.file_kind,
              COUNT(b.id) AS provider_binding_count
         FROM catalog_entities e
         JOIN lims_entity l ON l.id = e.id
         LEFT JOIN catalog_workspace_placements p
           ON p.entity_id = e.id
          AND p.workspace_id = e.workspace_id
          AND p.status = 'active'
         LEFT JOIN catalog_entity_files f
           ON f.entity_id = e.id
          AND f.workspace_id = e.workspace_id
          AND f.status = 'current'
         LEFT JOIN catalog_provider_bindings b ON b.entity_id = e.id
        WHERE e.workspace_id = ?
          AND e.type = 'sequence'
          AND e.status = 'active'
          AND l.kind = 'dna_sequence'
          AND l.tombstone = 0
          AND l.archived_at IS NULL
        GROUP BY e.id, e.name, e.type, e.status, e.workspace_id,
                 e.storage_type, l.fields, l.kind, l.tombstone, l.archived_at,
                 p.parent_relative_path, p.display_name, p.presentation_kind,
                 f.relative_path, f.file_kind
        ORDER BY e.id`
    )
    .all(workspaceId) as NativeCandidateRow[];
  return rows.flatMap((row) => {
    if (!isActiveWorkspaceDnaCatalogEntity(row, workspaceId)) return [];
    const scientificSha256 = scientificFingerprintFromFields(row.fields);
    const location: NativeExactMatchCandidate['location'] | null =
      row.storage_type === 'file' && row.file_relative_path && row.file_kind
        ? { kind: 'file', relativePath: row.file_relative_path, fileKind: row.file_kind }
        : row.parent_relative_path !== null && row.presentation_kind === 'sequence'
          ? {
              kind: 'catalog-record',
              parentRelativePath: row.parent_relative_path,
              presentationKind: 'sequence',
              catalogType: 'sequence',
            }
          : null;
    if (!location) return [];
    return scientificSha256
      ? [
          {
            entityId: row.id,
            displayName: row.placement_display_name || row.name,
            nativeKind: 'dna_sequence' as const,
            scientificSha256,
            providerBindingCount: row.provider_binding_count,
            location,
          },
        ]
      : [];
  });
}

function activePlacementForEntity(
  db: Database.Database,
  entityId: string,
  workspaceId: number
): { parent_relative_path: string; presentation_kind: CatalogRecordPresentationKind } | null {
  return (
    (db
      .prepare(
        `SELECT parent_relative_path, presentation_kind
           FROM catalog_workspace_placements
          WHERE entity_id = ?
            AND workspace_id = ?
            AND status = 'active'
          ORDER BY parent_relative_path, normalized_sibling_name
          LIMIT 1`
      )
      .get(entityId, workspaceId) as
      | { parent_relative_path: string; presentation_kind: CatalogRecordPresentationKind }
      | undefined) ?? null
  );
}

function scientificFingerprintForCatalogEntity(
  db: Database.Database,
  entityId: string
): Sha256Digest | null {
  const record = readNativeCatalogRecordState(db, entityId);
  if (record) return nativeCatalogRecordStateSha256(record);
  const row = db
    .prepare(
      `SELECT fields
         FROM lims_entity
        WHERE id = ?
          AND kind = 'dna_sequence'
          AND tombstone = 0
          AND archived_at IS NULL`
    )
    .get(entityId) as { fields: string } | undefined;
  return row ? scientificFingerprintFromFields(row.fields) : null;
}

function scientificFingerprintFromFields(fieldsJson: string): Sha256Digest | null {
  let fields: unknown;
  try {
    fields = JSON.parse(fieldsJson);
  } catch {
    return null;
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const sequence = (fields as Record<string, unknown>).sequence;
  if (!sequence || typeof sequence !== 'object' || Array.isArray(sequence)) return null;
  const record = sequence as Record<string, unknown>;
  if (record.mode === 'inline' && typeof record.bases === 'string') {
    return dnaBasesScientificFingerprint(record.bases);
  }
  if (
    record.mode === 'file' &&
    typeof record.normalizedSequenceHash === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(record.normalizedSequenceHash)
  ) {
    return record.normalizedSequenceHash as Sha256Digest;
  }
  return null;
}

function compareSourceObjects(left: SourceObject, right: SourceObject): number {
  return left.stableId.localeCompare(right.stableId) || left.id.localeCompare(right.id);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
