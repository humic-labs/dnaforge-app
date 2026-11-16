import { canonicalJson } from './canonical-json';
import { sha256Hex } from './sha256-sync';
import { TABLE_NOTEBOOK_BLOCK } from './table-notebook-contract';
import { isAbsolutePathLike } from './path-boundary';
import {
  tableDocumentKey,
  tableDocumentReferenceSchema,
  type TableDocumentReference,
} from './table-document-reference';
import type { TableData } from './table-document-types';

export const TABLE_PACKAGE_SCHEMA = 'dnaforge.table.v1' as const;
export const TABLE_SNAPSHOT_SCHEMA = 'dnaforge.table-snapshot.v1' as const;
export const TABLE_PACKAGE_MAX_BYTES = 20 * 1024 * 1024;

export interface TableSnapshot {
  schema: typeof TABLE_SNAPSHOT_SCHEMA;
  documentId: string;
  title: string;
  data: TableData;
  [key: string]: unknown;
}

export interface TableLegacyAlias {
  kind: 'notebook-inline';
  projectId: string;
  notebookId: string;
  blockId: string;
  legacyReference: TableDocumentReference;
  [key: string]: unknown;
}

export interface TablePackageHead {
  schema: typeof TABLE_PACKAGE_SCHEMA;
  id: string;
  snapshotSha256: string;
  snapshot: TableSnapshot;
  aliases: TableLegacyAlias[];
  status: 'active' | 'pending-promotion';
  promotionId?: string;
  [key: string]: unknown;
}

export type TablePackageErrorCode =
  | 'TABLE_PACKAGE_INVALID'
  | 'TABLE_PACKAGE_UNSUPPORTED_SCHEMA'
  | 'TABLE_PACKAGE_TOO_LARGE'
  | 'TABLE_PACKAGE_IDENTITY_MISMATCH'
  | 'TABLE_PACKAGE_SNAPSHOT_MISMATCH'
  | 'TABLE_PACKAGE_NONCANONICAL_SNAPSHOT';

export class TablePackageError extends Error {
  constructor(
    readonly code: TablePackageErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'TablePackageError';
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function invalid(message: string): never {
  throw new TablePackageError('TABLE_PACKAGE_INVALID', message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value) || ancestors.size >= 64) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  const keys = Object.keys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => !('value' in descriptors[key]))) return false;
  if (Array.isArray(value)) {
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index)))
      return false;
  } else if (Object.getOwnPropertyNames(value).length !== keys.length) return false;
  ancestors.add(value);
  const valid = keys.every((key) => jsonValue(descriptors[key].value, ancestors));
  ancestors.delete(value);
  return valid;
}

function bounded(text: string): string {
  if (typeof text !== 'string') invalid('The saved table must contain JSON text.');
  if (encoder.encode(text).byteLength > TABLE_PACKAGE_MAX_BYTES)
    throw new TablePackageError('TABLE_PACKAGE_TOO_LARGE', 'The saved table exceeds 20 MiB.');
  return text;
}

function parse(text: string): unknown {
  bounded(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid('The saved table is not valid JSON.');
  }
  if (!jsonValue(value)) invalid('The table contains data that cannot be saved without loss.');
  return value;
}

function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) invalid(`${label} must be a durable UUID.`);
}

function identifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 1000 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid(`${label} is invalid.`);
}

function tableData(value: unknown): asserts value is TableData {
  if (!record(value)) invalid('The table data must be an object.');
  const rows = value.rows;
  const columns = value.cols;
  if (
    typeof rows !== 'number' ||
    typeof columns !== 'number' ||
    !Number.isSafeInteger(rows) ||
    !Number.isSafeInteger(columns) ||
    rows < 1 ||
    columns < 1 ||
    rows > 10000 ||
    columns > 1000 ||
    rows * columns > 1000000
  )
    invalid('The table requires supported explicit row and column dimensions.');
  if (!Array.isArray(value.cells)) invalid('The saved table requires a rectangular cell array.');
  if (
    value.cells.length > 0 &&
    (value.cells.length !== rows ||
      value.cells.some((row) => !Array.isArray(row) || row.length !== columns))
  )
    invalid('The saved cell array does not match the table dimensions.');
  const result = TABLE_NOTEBOOK_BLOCK.parseData(value);
  if (!result.ok) invalid(result.reason);
}

function snapshot(value: unknown): asserts value is TableSnapshot {
  if (!record(value) || !jsonValue(value)) invalid('The table snapshot must be a JSON object.');
  if (value.schema !== TABLE_SNAPSHOT_SCHEMA)
    throw new TablePackageError(
      'TABLE_PACKAGE_UNSUPPORTED_SCHEMA',
      'The table snapshot format is unsupported.'
    );
  identity(value.documentId, 'The snapshot owner');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500)
    invalid('The table snapshot title is invalid.');
  tableData(value.data);
}

function alias(value: unknown): asserts value is TableLegacyAlias {
  if (!record(value) || value.kind !== 'notebook-inline') invalid('The table alias is invalid.');
  identity(value.projectId, 'The alias project');
  identifier(value.notebookId, 'The alias notebook');
  identifier(value.blockId, 'The alias block');
  const reference = value.legacyReference;
  if (!record(reference) || !record(reference.backing) || !record(reference.binding))
    invalid('The earlier table reference is invalid.');
  if (reference.backing.kind !== 'notebook-inline' || reference.binding.kind !== 'current')
    invalid('The earlier table reference must target the current inline table.');
  const parsed = tableDocumentReferenceSchema.safeParse({
    version: reference.version,
    documentId: reference.documentId,
    backing: {
      kind: reference.backing.kind,
      notebookDocumentId: reference.backing.notebookDocumentId,
      blockId: reference.backing.blockId,
    },
    binding: { kind: reference.binding.kind },
  });
  if (!parsed.success) invalid('The earlier table reference is invalid.');
  tableDocumentKey(parsed.data);
  if (
    parsed.data.backing.kind !== 'notebook-inline' ||
    parsed.data.backing.blockId !== value.blockId
  )
    invalid('The table alias does not match its earlier notebook and block identity.');
}

function head(value: unknown): asserts value is TablePackageHead {
  if (!record(value) || !jsonValue(value)) invalid('The table head must be a JSON object.');
  if (value.schema !== TABLE_PACKAGE_SCHEMA)
    throw new TablePackageError(
      'TABLE_PACKAGE_UNSUPPORTED_SCHEMA',
      'The table package format is unsupported.'
    );
  identity(value.id, 'The table owner');
  snapshot(value.snapshot);
  if (value.snapshot.documentId !== value.id)
    throw new TablePackageError(
      'TABLE_PACKAGE_IDENTITY_MISMATCH',
      'The head and snapshot have different owners.'
    );
  if (typeof value.snapshotSha256 !== 'string' || !digest.test(value.snapshotSha256))
    invalid('The saved table revision must be a SHA256 digest.');
  if (sha256Hex(serializeTableSnapshot(value.snapshot)) !== value.snapshotSha256)
    throw new TablePackageError(
      'TABLE_PACKAGE_SNAPSHOT_MISMATCH',
      'The head snapshot does not match its saved digest.'
    );
  if (!Array.isArray(value.aliases)) invalid('The table aliases must be an array.');
  const aliases = new Set<string>();
  for (const entry of value.aliases) {
    alias(entry);
    const key = canonicalJson([entry.projectId, entry.notebookId, entry.blockId]);
    if (aliases.has(key)) invalid('The table contains duplicate legacy aliases.');
    aliases.add(key);
  }
  if (value.status !== 'active' && value.status !== 'pending-promotion')
    invalid('The saved table activation state is invalid.');
  if (value.status === 'pending-promotion' || value.promotionId !== undefined)
    identity(value.promotionId, 'The table promotion');
}

export function parseTablePackageHead(text: string): TablePackageHead {
  const value = parse(text);
  head(value);
  return value;
}

export function serializeTablePackageHead(value: TablePackageHead): string {
  head(value);
  return bounded(`${canonicalJson(value)}\n`);
}

export function parseTableSnapshot(text: string): TableSnapshot {
  const value = parse(text);
  snapshot(value);
  return value;
}

export function serializeTableSnapshot(value: TableSnapshot): string {
  snapshot(value);
  return bounded(`${canonicalJson(value)}\n`);
}

export async function tableSnapshotSha256(value: TableSnapshot): Promise<string> {
  return sha256Hex(serializeTableSnapshot(value));
}

export function tableSnapshotForHead(value: TablePackageHead): TableSnapshot {
  head(value);
  return value.snapshot;
}

export function tablePackageHeadWithData(
  value: TablePackageHead,
  data: TableData
): TablePackageHead {
  head(value);
  const nextSnapshot = { ...value.snapshot, data };
  const next = {
    ...value,
    snapshot: nextSnapshot,
    snapshotSha256: sha256Hex(serializeTableSnapshot(nextSnapshot)),
  };
  return parseTablePackageHead(serializeTablePackageHead(next));
}

export async function verifyTablePackageRead(input: {
  headText: string;
  snapshotText: string;
  expectedDocumentId?: string;
  expectedSnapshotSha256?: string;
}): Promise<{ head: TablePackageHead; snapshot: TableSnapshot }> {
  const value = parseTablePackageHead(input.headText);
  const saved = parseTableSnapshot(input.snapshotText);
  const bytes = serializeTableSnapshot(saved);
  if (bytes !== input.snapshotText)
    throw new TablePackageError(
      'TABLE_PACKAGE_NONCANONICAL_SNAPSHOT',
      'The immutable snapshot bytes are not canonical.'
    );
  if (
    value.id !== saved.documentId ||
    (input.expectedDocumentId !== undefined && input.expectedDocumentId !== value.id)
  )
    throw new TablePackageError(
      'TABLE_PACKAGE_IDENTITY_MISMATCH',
      'The saved table belongs to a different document.'
    );
  if (
    sha256Hex(bytes) !== value.snapshotSha256 ||
    bytes !== serializeTableSnapshot(value.snapshot) ||
    (input.expectedSnapshotSha256 !== undefined &&
      input.expectedSnapshotSha256 !== value.snapshotSha256)
  )
    throw new TablePackageError(
      'TABLE_PACKAGE_SNAPSHOT_MISMATCH',
      'The immutable snapshot does not match the requested saved revision.'
    );
  return { head: value, snapshot: saved };
}

export function tablePackagePaths(packageRoot: string): {
  headPath: string;
  revisionsDirectory: string;
} {
  if (
    typeof packageRoot !== 'string' ||
    !isAbsolutePathLike(packageRoot) ||
    /[\u0000-\u001f\u007f]/u.test(packageRoot) ||
    packageRoot.split(/[\\/]/u).some((part) => part === '.' || part === '..')
  )
    invalid('The table package must have an absolute directory path.');
  const separator = packageRoot.includes('\\') && !packageRoot.includes('/') ? '\\' : '/';
  const marker = `${packageRoot.replace(/[\\/]+$/u, '')}${separator}.forge`;
  return {
    headPath: `${marker}${separator}table.json`,
    revisionsDirectory: `${marker}${separator}table-revisions`,
  };
}

export function tablePackageRevisionPath(packageRoot: string, sha256: string): string {
  if (typeof sha256 !== 'string' || !digest.test(sha256))
    invalid('The snapshot path requires a SHA256 digest.');
  const { revisionsDirectory } = tablePackagePaths(packageRoot);
  const separator =
    revisionsDirectory.includes('\\') && !revisionsDirectory.includes('/') ? '\\' : '/';
  return `${revisionsDirectory}${separator}${sha256}.json`;
}
