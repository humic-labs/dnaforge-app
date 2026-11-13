import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path/posix';

import type Database from 'better-sqlite3';

import type { ExternalZipEntryEvidence, ExternalZipSource } from '../../shared/benchling-migration';
import type {
  ExternalProviderSourceRequest,
  ExternalProviderSourceResult,
} from '../../shared/benchling-migration-raw-source';
import { isExactProviderStableId } from '../../shared/provider-object-reference';
import {
  ExternalZipSourceError,
  externalZipDecoderSource,
  verifyExternalZipSource,
} from './external-zip-source';
import {
  inspectNativeExportArchive,
  NativeExportArchiveError,
  readNativeExportArchiveEntryPreview,
  type ValidatedNativeExportArchive,
} from './native-export-archive';
import { migrationDatabasePath, openWorkspaceMigrationStore } from './store';
import {
  readLocalRegistryTableRows,
  parseRegistryDelimitedTable,
  REGISTRY_TABLE_MAX_ENTRY_BYTES,
} from './registry-table-input';
import { readCatalogProviderSource } from '../catalog-provider-source';
import { readCatalogReviewedTableSource } from '../catalog-reviewed-table-source';
import { assertReviewedTableDecision, reviewedTableRowId } from './reviewed-table-source';
import type {
  RegistryTableMappingDecision,
  ReviewedRegistryTableRowRef,
} from '../../shared/benchling-registry-table-review';

export const EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES = 1024 * 1024;

export type ExternalSourceHistoryRecord = Readonly<{
  workspaceId: number;
  historyRunId: string;
  source: ExternalZipSource;
  entries: readonly ExternalZipEntryEvidence[];
  reviewedTableDecisions?: readonly RegistryTableMappingDecision[];
}>;

export type ExternalSourceViewerDeps = Readonly<{
  loadHistorySource: (input: {
    workspacePath: string;
    workspaceId: number;
    historyRunId: string;
    sourceId: string;
    reviewedTableActionId?: string;
  }) => Promise<ExternalSourceHistoryRecord | null>;
}>;

type AuthorizedEntitySource = Readonly<{
  workspacePath: string;
  historyRunId: string;
  sourceId: string;
  sourceObjectId: string;
  reviewedTable?: ReviewedRegistryTableRowRef;
}>;

export async function viewExternalProviderSource(
  db: Database.Database,
  rawRequest: ExternalProviderSourceRequest,
  deps: ExternalSourceViewerDeps = { loadHistorySource: loadExternalSourceHistoryRecord }
): Promise<ExternalProviderSourceResult> {
  const request = parseRequest(rawRequest);
  const authorized = authorizeEntitySource(db, request);
  if (!authorized) return integrityFailure(null, null);

  let history: ExternalSourceHistoryRecord | null;
  try {
    history = await deps.loadHistorySource({
      workspacePath: authorized.workspacePath,
      workspaceId: request.workspaceId,
      historyRunId: authorized.historyRunId,
      sourceId: authorized.sourceId,
      ...(authorized.reviewedTable
        ? { reviewedTableActionId: authorized.reviewedTable.actionId }
        : {}),
    });
  } catch {
    return integrityFailure(null, null);
  }
  if (
    !history ||
    history.workspaceId !== request.workspaceId ||
    history.historyRunId !== authorized.historyRunId ||
    history.source.sourceId !== authorized.sourceId
  ) {
    return integrityFailure(null, null);
  }

  const originalPath = history.source.originalPath;
  const sourceDisplayName = history.source.displayName;
  const candidates = history.entries.filter(
    (entry) =>
      entry.sourceId === history.source.sourceId &&
      entry.sourceObjectId === authorized.sourceObjectId &&
      entry.role === 'source-record'
  );
  if (candidates.length > 1) return integrityFailure(originalPath, sourceDisplayName);
  const [entry] = candidates;

  try {
    await verifyExternalZipSource(history.source);
    const archive = await inspectNativeExportArchive(externalZipDecoderSource(history.source));
    if (authorized.reviewedTable)
      return await previewReviewedTableRow(
        archive,
        history,
        authorized.reviewedTable,
        authorized.sourceObjectId
      );
    if (!entry) return await previewRegistryRow(archive, history, authorized.sourceObjectId);
    const preview = await readNativeExportArchiveEntryPreview(
      archive,
      entry.entryPath,
      EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES
    );
    if (
      preview.evidence.path !== entry.entryPath ||
      preview.evidence.actualSize !== entry.sizeBytes ||
      preview.evidence.sha256 !== entry.entrySha256
    ) {
      return integrityFailure(originalPath, sourceDisplayName);
    }
    const displayFilename = basename(entry.entryPath);
    if (!isTextPreviewMediaType(entry.mediaType)) {
      return {
        status: 'unsupported',
        originalPath,
        sourceDisplayName,
        entryPath: entry.entryPath,
        displayFilename,
        mediaType: entry.mediaType,
        sizeBytes: entry.sizeBytes,
        message: 'DNAForge does not preview this original source format.',
      };
    }
    let text: string;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      text = preview.truncated
        ? decoder.decode(preview.bytes, { stream: true })
        : decoder.decode(preview.bytes);
    } catch {
      return integrityFailure(originalPath, sourceDisplayName);
    }
    return {
      status: 'ready',
      originalPath,
      sourceDisplayName,
      entryPath: entry.entryPath,
      displayFilename,
      mediaType: entry.mediaType ?? 'text/plain',
      text,
      sizeBytes: entry.sizeBytes,
      truncated: preview.truncated,
      message: preview.truncated
        ? 'Preview truncated. The original ZIP and complete entry remain unchanged.'
        : 'Verified against the original ZIP and recorded entry evidence.',
    };
  } catch (error) {
    if (error instanceof ExternalZipSourceError) {
      return {
        status: error.code,
        originalPath,
        sourceDisplayName,
        message: error.message,
      };
    }
    if (error instanceof NativeExportArchiveError) {
      return integrityFailure(originalPath, sourceDisplayName);
    }
    return integrityFailure(originalPath, sourceDisplayName);
  }
}

async function previewReviewedTableRow(
  archive: ValidatedNativeExportArchive,
  history: ExternalSourceHistoryRecord,
  ref: ReviewedRegistryTableRowRef,
  sourceObjectId: string
): Promise<ExternalProviderSourceResult> {
  const { originalPath, displayName: sourceDisplayName } = history.source;
  assertReviewedTableDecision(ref, history.reviewedTableDecisions ?? []);
  const decision = history.reviewedTableDecisions?.find(
    (decision) =>
      decision.source.archiveSha256 === ref.source.archiveSha256 &&
      decision.source.entryPath === ref.source.entryPath
  );
  const entries = history.entries.filter(
    (entry) =>
      entry.sourceId === history.source.sourceId && entry.entryPath === ref.source.entryPath
  );
  if (
    archive.sha256.replace(/^sha256:/u, '') !== ref.source.archiveSha256 ||
    !decision ||
    decision.outcome.kind !== 'records' ||
    entries.length !== 1 ||
    entries[0].entrySha256.replace(/^sha256:/u, '') !== ref.source.entrySha256 ||
    entries[0].sizeBytes !== ref.source.entrySizeBytes
  )
    return integrityFailure(originalPath, sourceDisplayName);
  const preview = await readNativeExportArchiveEntryPreview(
    archive,
    ref.source.entryPath,
    REGISTRY_TABLE_MAX_ENTRY_BYTES
  );
  if (
    preview.truncated ||
    preview.evidence.actualSize !== ref.source.entrySizeBytes ||
    preview.evidence.sha256.replace(/^sha256:/u, '') !== ref.source.entrySha256
  )
    return integrityFailure(originalPath, sourceDisplayName);
  const table = parseRegistryDelimitedTable(
    new TextDecoder('utf-8', { fatal: true }).decode(preview.bytes),
    /\.tsv$/iu.test(ref.source.entryPath) ? '\t' : ','
  );
  if (
    table.rows.length !== decision.outcome.rowCount ||
    createHash('sha256').update(JSON.stringify(table.headers)).digest('hex') !==
      decision.outcome.headersSha256
  )
    return integrityFailure(originalPath, sourceDisplayName);
  const row = table.rows[ref.rowOrdinal - 1];
  const providerIndex = decision.outcome.columns.findIndex(
    (column) => column.kind === 'provider_id'
  );
  const expectedId =
    providerIndex < 0
      ? reviewedTableRowId(ref.source.entryPath, ref.source.entrySha256, ref.rowOrdinal)
      : row?.[providerIndex]?.trim();
  if (!row || sourceObjectId !== expectedId)
    return integrityFailure(originalPath, sourceDisplayName);
  const bytes = Buffer.from(
    `${JSON.stringify({ row: ref.rowOrdinal, columns: table.headers.map((header, index) => ({ column: index + 1, header, value: row[index] })) }, null, 2)}\n`,
    'utf8'
  );
  const truncated = bytes.length > EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES;
  return {
    status: 'ready',
    originalPath,
    sourceDisplayName,
    entryPath: ref.source.entryPath,
    displayFilename: basename(ref.source.entryPath),
    mediaType: 'application/json',
    text: new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES),
      { stream: truncated }
    ),
    sizeBytes: bytes.length,
    truncated,
    message: `Exported row ${ref.rowOrdinal}, verified against the original ZIP and saved table choices.${truncated ? ' Preview truncated; the complete row remains in the original ZIP.' : ''}`,
  };
}

async function previewRegistryRow(
  archive: ValidatedNativeExportArchive,
  history: ExternalSourceHistoryRecord,
  sourceObjectId: string
): Promise<ExternalProviderSourceResult> {
  const { originalPath, displayName: sourceDisplayName } = history.source;
  const matches = (await readLocalRegistryTableRows(archive)).filter(
    ({ sourceObject }) =>
      sourceObject.id === sourceObjectId && sourceObject.stableId === sourceObjectId
  );
  if (matches.length !== 1) return integrityFailure(originalPath, sourceDisplayName);
  const [{ sourceObject }] = matches;
  const native = parseRecord(sourceObject.metadata.nativeExport);
  const row = parseRecord(parseRecord(native?.registryData)?.sourceRow);
  const original = parseRecord(parseRecord(sourceObject.content)?.originalRow);
  if (
    !row ||
    !original ||
    typeof row.row !== 'number' ||
    !Number.isSafeInteger(row.row) ||
    row.row < 1
  )
    return integrityFailure(originalPath, sourceDisplayName);
  const memberMatches = (path: unknown, sha256: unknown) => {
    const recorded = history.entries.filter(
      (entry) => entry.sourceId === history.source.sourceId && entry.entryPath === path
    );
    const actual = archive.entries.filter((entry) => entry.path === path && !entry.isDirectory);
    return (
      recorded.length === 1 &&
      actual.length === 1 &&
      recorded[0].entrySha256 === sha256 &&
      recorded[0].sizeBytes === actual[0].uncompressedSize
    );
  };
  if (
    native?.archiveSha256 !== archive.sha256 ||
    typeof row.entryPath !== 'string' ||
    !memberMatches(row.entryPath, row.entrySha256) ||
    !memberMatches(row.schemaPath, row.schemaSha256)
  )
    return integrityFailure(originalPath, sourceDisplayName);
  const bytes = Buffer.from(`${JSON.stringify(original, null, 2)}\n`, 'utf8');
  const truncated = bytes.length > EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    bytes.subarray(0, EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES),
    { stream: truncated }
  );
  return {
    status: 'ready',
    originalPath,
    sourceDisplayName,
    entryPath: row.entryPath,
    displayFilename: basename(row.entryPath),
    mediaType: 'application/json',
    text,
    sizeBytes: bytes.length,
    truncated,
    message: `Exported row ${row.row} from ${row.entryPath}, displayed as JSON. Verified against the original ZIP and table/schema evidence.${truncated ? ' Preview truncated; the complete row remains in the original ZIP.' : ''}`,
  };
}

export async function loadExternalSourceHistoryRecord(
  input: {
    workspacePath: string;
    workspaceId: number;
    historyRunId: string;
    sourceId: string;
    reviewedTableActionId?: string;
  },
  openStore = openWorkspaceMigrationStore
): Promise<ExternalSourceHistoryRecord | null> {
  const databasePath = migrationDatabasePath(input.workspacePath);
  let databaseStat;
  try {
    databaseStat = await lstat(databasePath);
  } catch {
    return null;
  }
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) return null;
  const store = openStore(input.workspacePath);
  try {
    const run = store.getRun();
    if (
      !run ||
      run.id !== input.historyRunId ||
      run.workspacePath !== input.workspacePath ||
      (run.workspaceDbId !== undefined && run.workspaceDbId !== input.workspaceId)
    ) {
      return null;
    }
    if (run.externalZipSource?.sourceId === input.sourceId && run.externalZipEntries) {
      return {
        workspaceId: input.workspaceId,
        historyRunId: run.id,
        source: run.externalZipSource,
        entries: run.externalZipEntries,
        ...(input.reviewedTableActionId
          ? {
              reviewedTableDecisions: store
                .listImportDecisions(run.id, input.reviewedTableActionId)
                .filter((decision) => decision.kind === 'registry_table_mapping'),
            }
          : {}),
      };
    }
    const matches = store
      .listLinkedItemRecoveryArtifacts(run.id)
      .filter(
        (artifact) =>
          artifact.schema === 'dnaforge.benchling.linked-item-recovery-source.v2' &&
          artifact.externalZipSource.sourceId === input.sourceId
      );
    if (matches.length !== 1) return null;
    const [artifact] = matches;
    if (!artifact || artifact.schema !== 'dnaforge.benchling.linked-item-recovery-source.v2') {
      return null;
    }
    return {
      workspaceId: input.workspaceId,
      historyRunId: run.id,
      source: artifact.externalZipSource,
      entries: artifact.externalZipEntries,
      ...(input.reviewedTableActionId
        ? {
            reviewedTableDecisions: store
              .listImportDecisions(run.id, input.reviewedTableActionId)
              .filter((decision) => decision.kind === 'registry_table_mapping'),
          }
        : {}),
    };
  } finally {
    store.close();
  }
}

function parseRequest(value: ExternalProviderSourceRequest): ExternalProviderSourceRequest {
  if (!Number.isSafeInteger(value.workspaceId) || value.workspaceId <= 0) {
    throw new Error('External source workspace ID is invalid.');
  }
  if (!isOpaqueId(value.entityId)) throw new Error('External source entity ID is invalid.');
  if (
    !(value.kind === 'reviewed_table_row'
      ? /^(?:local-row-[a-f0-9]{64}|bfi_[A-Za-z0-9]+)$/u.test(value.sourceRecordId)
      : isExactProviderStableId(value.sourceRecordId))
  ) {
    throw new Error('External source record ID is invalid.');
  }
  return value;
}

function authorizeEntitySource(
  db: Database.Database,
  request: ExternalProviderSourceRequest
): AuthorizedEntitySource | null {
  const source =
    request.kind === 'reviewed_table_row'
      ? readCatalogReviewedTableSource(db, request.entityId)
      : readCatalogProviderSource(db, request.entityId);
  return source?.request.workspaceId === request.workspaceId &&
    source.request.sourceRecordId === request.sourceRecordId
    ? source
    : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return parseRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isOpaqueId(value: string): boolean {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)
  );
}

function isTextPreviewMediaType(mediaType: string | null): boolean {
  return (
    mediaType?.startsWith('text/') === true ||
    mediaType === 'chemical/x-genbank' ||
    mediaType === 'application/json'
  );
}

function integrityFailure(
  originalPath: string | null,
  sourceDisplayName: string | null
): ExternalProviderSourceResult {
  return {
    status: 'source_integrity_error',
    originalPath,
    sourceDisplayName,
    message: 'The original source record no longer matches its migration evidence.',
  };
}
