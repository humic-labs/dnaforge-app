const MAX_SOURCE_DETAIL_LENGTH = 4096;
export const MAX_BENCHLING_NOTEBOOK_PROVENANCE_BYTES = 64 * 1024;

export interface BenchlingNotebookSourceDetails {
  provider: 'benchling';
  project?: string;
  author?: string;
  status?: string;
  entryCreatedAt?: string;
  entryModifiedAt?: string;
  exportGeneratedAt?: string;
  sourceObjectId?: string;
  stableSourceId?: string;
  sourceUrl?: string;
  capturedAt?: string;
  immutableSource: boolean;
}

export interface ParsedBenchlingNotebookProvenanceSidecar {
  details: BenchlingNotebookSourceDetails;
  destinationObjectId?: string;
  hasEntryMetadataSnapshot: boolean;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > MAX_SOURCE_DETAIL_LENGTH) return undefined;
  return text;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = boundedText(value);
    if (text) return text;
  }
  return undefined;
}

export function extractBenchlingNotebookSourceDetails(
  document: unknown
): BenchlingNotebookSourceDetails | null {
  const root = objectValue(document);
  if (!root) return null;

  const provenance = objectValue(root.provenance);
  const compatibility = objectValue(root.sourceMetadata);
  const entryMetadata = objectValue(provenance?.benchlingEntryMetadata);
  const provider = firstText(provenance?.provider, compatibility?.provider)?.toLowerCase();

  if (provider !== 'benchling') return null;

  return {
    provider: 'benchling',
    project: firstText(entryMetadata?.project, compatibility?.project),
    author: firstText(entryMetadata?.author, compatibility?.author),
    status: firstText(entryMetadata?.status, compatibility?.status),
    entryCreatedAt: firstText(
      entryMetadata?.entryCreatedOn,
      entryMetadata?.entryCreatedAt,
      entryMetadata?.createdAt,
      compatibility?.entryCreatedAt,
      provenance?.sourceCreatedAt
    ),
    entryModifiedAt: firstText(
      entryMetadata?.entryLastModified,
      entryMetadata?.entryModifiedAt,
      entryMetadata?.modifiedAt,
      compatibility?.entryModifiedAt,
      provenance?.sourceModifiedAt
    ),
    exportGeneratedAt: firstText(
      entryMetadata?.exportGeneratedOn,
      entryMetadata?.exportGeneratedAt,
      entryMetadata?.generatedAt,
      compatibility?.exportGeneratedAt
    ),
    sourceObjectId: firstText(provenance?.sourceObjectId, compatibility?.sourceObjectId),
    stableSourceId: firstText(provenance?.stableSourceId, compatibility?.stableSourceId),
    sourceUrl: firstText(provenance?.sourceUrl, compatibility?.sourceUrl),
    capturedAt: firstText(provenance?.capturedAt, compatibility?.capturedAt),
    immutableSource: provenance?.immutableSource === true,
  };
}

export function extractBenchlingNotebookProvenanceSidecarDetails(
  value: unknown
): ParsedBenchlingNotebookProvenanceSidecar | null {
  const root = objectValue(value);
  if (
    !root ||
    root.version !== 1 ||
    root.immutable !== true ||
    root.converterId !== 'benchling-notebook-html-v1'
  ) {
    return null;
  }
  const sourceType = firstText(root.sourceType)
    ?.toLowerCase()
    .replace(/[\s-]+/gu, '_');
  if (sourceType !== 'notebook' && sourceType !== 'notebook_entry') return null;
  const stableSourceId = boundedText(root.stableSourceId);
  const hasDestinationObjectIdProperty = Object.prototype.hasOwnProperty.call(
    root,
    'destinationObjectId'
  );
  const destinationObjectId = boundedText(root.destinationObjectId);
  if (hasDestinationObjectIdProperty && destinationObjectId === undefined) return null;
  const hasEntryMetadataProperty = Object.prototype.hasOwnProperty.call(
    root,
    'benchlingEntryMetadata'
  );
  const entryMetadata = objectValue(root.benchlingEntryMetadata);
  if (
    hasEntryMetadataProperty &&
    root.benchlingEntryMetadata !== null &&
    entryMetadata?.schema !== 'dnaforge.benchling.entry-export-metadata.v1'
  ) {
    return null;
  }
  if (
    entryMetadata &&
    [
      'project',
      'author',
      'status',
      'entryCreatedOn',
      'entryCreatedAt',
      'entryLastModified',
      'entryModifiedAt',
      'exportGeneratedOn',
      'exportGeneratedAt',
    ].some(
      (key) =>
        Object.prototype.hasOwnProperty.call(entryMetadata, key) &&
        boundedText(entryMetadata[key]) === undefined
    )
  ) {
    return null;
  }
  const hasEntryMetadataSnapshot =
    hasEntryMetadataProperty &&
    (root.benchlingEntryMetadata === null ||
      entryMetadata?.schema === 'dnaforge.benchling.entry-export-metadata.v1');

  return {
    destinationObjectId,
    hasEntryMetadataSnapshot,
    details: {
      provider: 'benchling',
      project: firstText(entryMetadata?.project),
      author: firstText(entryMetadata?.author),
      status: firstText(entryMetadata?.status),
      entryCreatedAt: firstText(
        entryMetadata?.entryCreatedOn,
        entryMetadata?.entryCreatedAt,
        root.sourceCreatedAt
      ),
      entryModifiedAt: firstText(
        entryMetadata?.entryLastModified,
        entryMetadata?.entryModifiedAt,
        root.sourceModifiedAt
      ),
      exportGeneratedAt: firstText(
        entryMetadata?.exportGeneratedOn,
        entryMetadata?.exportGeneratedAt
      ),
      sourceObjectId: boundedText(root.sourceId),
      stableSourceId,
      sourceUrl: boundedText(root.sourceUrl),
      capturedAt: boundedText(root.capturedAt),
      immutableSource: true,
    },
  };
}

export function parseBenchlingNotebookProvenanceSidecar(
  text: string,
  bytesRead: number
): ParsedBenchlingNotebookProvenanceSidecar | null {
  const encodedBytes = new TextEncoder().encode(text).byteLength;
  if (
    !Number.isSafeInteger(bytesRead) ||
    bytesRead < 0 ||
    bytesRead > MAX_BENCHLING_NOTEBOOK_PROVENANCE_BYTES ||
    encodedBytes > MAX_BENCHLING_NOTEBOOK_PROVENANCE_BYTES
  ) {
    return null;
  }
  try {
    return extractBenchlingNotebookProvenanceSidecarDetails(JSON.parse(text));
  } catch {
    return null;
  }
}

export function safeBenchlingSourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      (hostname !== 'benchling.com' && !hostname.endsWith('.benchling.com'))
    ) {
      return null;
    }
    url.search = '';
    url.hash = '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}
