const PRESERVED_RAW_SOURCE_PREFIX = 'dnaforge-preserved://sha256/';
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const MAX_FILE_NAME_LENGTH = 512;
const MAX_MEDIA_TYPE_LENGTH = 256;

export type PreservedMigrationRawSource = {
  sha256: string;
  fileName: string;
  mediaType: string | null;
  relativePath: string;
  uri: string;
};

export type ExternalProviderSourceRequest = Readonly<{
  workspaceId: number;
  entityId: string;
  sourceRecordId: string;
}> &
  ({ readonly kind?: never } | { readonly kind: 'reviewed_table_row' });

type ExternalProviderSourceBase = Readonly<{
  originalPath: string | null;
  sourceDisplayName: string | null;
  message: string;
}>;

export type ExternalProviderSourceResult =
  | (ExternalProviderSourceBase &
      Readonly<{
        status: 'ready';
        originalPath: string;
        sourceDisplayName: string;
        entryPath: string;
        displayFilename: string;
        mediaType: string;
        text: string;
        sizeBytes: number;
        truncated: boolean;
      }>)
  | (ExternalProviderSourceBase &
      Readonly<{
        status: 'unsupported';
        originalPath: string;
        sourceDisplayName: string;
        entryPath: string;
        displayFilename: string;
        mediaType: string | null;
        sizeBytes: number;
      }>)
  | (ExternalProviderSourceBase &
      Readonly<{
        status: 'source_unavailable' | 'source_changed' | 'source_integrity_error';
      }>);

export function parseExternalProviderSourceRequest(value: unknown): ExternalProviderSourceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('External source request is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !==
    (record.kind === 'reviewed_table_row'
      ? 'entityId,kind,sourceRecordId,workspaceId'
      : 'entityId,sourceRecordId,workspaceId')
  ) {
    throw new Error('External source request fields are invalid.');
  }
  if (!Number.isSafeInteger(record.workspaceId) || Number(record.workspaceId) <= 0) {
    throw new Error('External source workspace ID is invalid.');
  }
  const entityId = boundedText(record.entityId, 'entity ID');
  const sourceRecordId = boundedText(record.sourceRecordId, 'source record ID');
  const base = { workspaceId: Number(record.workspaceId), entityId, sourceRecordId };
  return record.kind === 'reviewed_table_row' ? { ...base, kind: 'reviewed_table_row' } : base;
}

export function buildPreservedMigrationRawSourceUri(input: {
  sha256: string;
  fileName: string;
  mediaType?: string | null;
}): string {
  const sha256 = normalizeSha256(input.sha256);
  const fileName = normalizeFileName(input.fileName);
  const mediaType = normalizeMediaType(input.mediaType ?? null);
  const query = new URLSearchParams({ name: fileName });
  if (mediaType) query.set('type', mediaType);
  return `${PRESERVED_RAW_SOURCE_PREFIX}${sha256}?${query.toString()}`;
}

export function parsePreservedMigrationRawSourceUri(
  value: string
): PreservedMigrationRawSource | null {
  if (typeof value !== 'string' || !value.startsWith(PRESERVED_RAW_SOURCE_PREFIX)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'dnaforge-preserved:' ||
    url.hostname !== 'sha256' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }
  const sha256 = url.pathname.replace(/^\//, '').toLowerCase();
  if (!SHA256.test(sha256)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'name' && key !== 'type')) return null;
  if (url.searchParams.getAll('name').length !== 1 || url.searchParams.getAll('type').length > 1) {
    return null;
  }
  try {
    const fileName = normalizeFileName(url.searchParams.get('name') ?? '');
    const mediaType = normalizeMediaType(url.searchParams.get('type'));
    return {
      sha256,
      fileName,
      mediaType,
      relativePath: `.dnaforge/migration/archive/blobs/sha256/${sha256.slice(0, 2)}/${sha256}`,
      uri: value,
    };
  } catch {
    return null;
  }
}

export function findPreservedMigrationRawSource(text: string): PreservedMigrationRawSource | null {
  if (typeof text !== 'string') return null;
  const candidates = text.match(/dnaforge-preserved:\/\/sha256\/[a-f0-9]{64}(?:\?[^\s<>()"']*)?/gi);
  if (!candidates) return null;
  for (const candidate of candidates) {
    const parsed = parsePreservedMigrationRawSourceUri(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function normalizeSha256(value: string): string {
  const sha256 = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
  if (!SHA256.test(sha256)) throw new Error('Preserved raw source SHA-256 is invalid.');
  return sha256;
}

function normalizeFileName(value: string): string {
  const normalized = String(value ?? '')
    .trim()
    .normalize('NFC');
  const fileName = normalized.split(/[\\/]/).pop() ?? '';
  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.length > MAX_FILE_NAME_LENGTH ||
    /[\0\r\n]/.test(fileName)
  ) {
    throw new Error('Preserved raw source filename is invalid.');
  }
  return fileName;
}

function normalizeMediaType(value: string | null): string | null {
  if (value === null || value === '') return null;
  const mediaType = String(value).trim().toLowerCase();
  if (mediaType.length > MAX_MEDIA_TYPE_LENGTH || !SAFE_MEDIA_TYPE.test(mediaType)) {
    throw new Error('Preserved raw source media type is invalid.');
  }
  return mediaType;
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\0\r\n]/u.test(value)) {
    throw new Error(`External source ${label} is invalid.`);
  }
  return value;
}
