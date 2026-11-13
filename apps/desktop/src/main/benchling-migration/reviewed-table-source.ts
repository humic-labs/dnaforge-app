import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SourceObject } from '../../shared/benchling-migration';
import type { NativeWorkspaceMigrationSourceRef } from '../../shared/native-workspace-manifest';
import { isExactProviderStableId } from '../../shared/provider-object-reference';
import {
  parseRegistryTableMappingDecision,
  parseReviewedRegistryTableRowRef,
  type RegistryTableMappingDecision,
  type ReviewedRegistryTableRowRef,
} from '../../shared/benchling-registry-table-review';

export function reviewedTableRowId(
  entryPath: string,
  entrySha256: string,
  rowOrdinal: number
): string {
  return `local-row-${sha256(JSON.stringify([entryPath, entrySha256, rowOrdinal]))}`;
}

export function reviewedTableMappingHash(decision: RegistryTableMappingDecision): string {
  return sha256(JSON.stringify(parseRegistryTableMappingDecision(decision)));
}

export function migrationSourceForObject(
  source: SourceObject,
  historyRunId: string,
  sourceId: string
): NativeWorkspaceMigrationSourceRef | null {
  const base = { historyRunId, sourceId, sourceObjectId: source.stableId };
  const reviewedTable = reviewedTableSourceRef(source);
  if (reviewedTable) return { ...base, kind: 'reviewed_table_row', reviewedTable };
  return isExactProviderStableId(source.stableId) ? base : null;
}

export function reviewedTableSourceRef(source: SourceObject): ReviewedRegistryTableRowRef | null {
  const registry = source.metadata.benchlingRegistry;
  if (!isRecord(registry) || registry.inputAuthority !== 'reviewed_local_table') return null;
  const table = registry.reviewedTable;
  if (!isRecord(table)) throw new Error('Reviewed table source is missing its row evidence.');
  const decision = parseRegistryTableMappingDecision(table.decision);
  const ref = parseReviewedRegistryTableRowRef({
    actionId: table.actionId,
    source: decision.source,
    rowOrdinal: table.rowOrdinal,
    mappingSha256: reviewedTableMappingHash(decision),
  });
  if (decision.outcome.kind !== 'records' || ref.rowOrdinal > decision.outcome.rowCount)
    throw new Error('Reviewed table source row is outside the accepted mapping.');
  const native = source.metadata.nativeExport;
  if (
    !isRecord(native) ||
    native.entryPath !== ref.source.entryPath ||
    native.entrySha256 !== ref.source.entrySha256 ||
    native.entrySizeBytes !== ref.source.entrySizeBytes ||
    String(native.archiveSha256).replace(/^sha256:/u, '') !== ref.source.archiveSha256
  )
    throw new Error('Reviewed table source byte evidence disagrees.');
  const providerIndex = decision.outcome.columns.findIndex(
    (column) => column.kind === 'provider_id'
  );
  if (providerIndex < 0) {
    if (
      source.id !==
        reviewedTableRowId(ref.source.entryPath, ref.source.entrySha256, ref.rowOrdinal) ||
      source.stableId !== source.id
    )
      throw new Error('Reviewed table local row identity disagrees.');
  } else if (
    !Array.isArray(table.cells) ||
    typeof table.cells[providerIndex] !== 'string' ||
    table.cells[providerIndex].trim() !== source.stableId ||
    !isExactProviderStableId(source.stableId)
  )
    throw new Error('Reviewed table provider identity disagrees.');
  return ref;
}

export function assertReviewedTableDecision(
  ref: ReviewedRegistryTableRowRef,
  decisions: readonly RegistryTableMappingDecision[]
): void {
  const decision = decisions.find((item) => isDeepStrictEqual(item.source, ref.source));
  if (
    !decision ||
    decision.outcome.kind !== 'records' ||
    ref.rowOrdinal > decision.outcome.rowCount ||
    reviewedTableMappingHash(decision) !== ref.mappingSha256
  )
    throw new Error('Reviewed table row does not match its persisted decision.');
}

export function assertReviewedTableArchiveSelection(
  decisions: readonly RegistryTableMappingDecision[],
  archiveHashes: readonly string[]
): void {
  const selected = new Set(archiveHashes.map((hash) => hash.replace(/^sha256:/u, '')));
  if (decisions.some((decision) => !selected.has(decision.source.archiveSha256)))
    throw new Error('Reviewed table choice does not belong to a selected ZIP.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
