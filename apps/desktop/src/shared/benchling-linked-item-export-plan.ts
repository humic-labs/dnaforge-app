export const BENCHLING_LINKED_ITEM_EXPORT_PLAN_VERSION = 1 as const;
export const BENCHLING_LINKED_ITEM_EXPORT_PLAN_MAX_FOLDERS = 64;

export type BenchlingLinkedItemExportFolder = Readonly<{
  sourceId: string;
  name: string;
  sourceUrl: string;
  targetCount: number;
}>;

export type BenchlingLinkedItemExportPlan = Readonly<{
  version: typeof BENCHLING_LINKED_ITEM_EXPORT_PLAN_VERSION;
  kind: 'linked_item_export';
  planId: string;
  runId: string;
  organizationBaseUrl: string;
  folders: readonly BenchlingLinkedItemExportFolder[];
}>;

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const MAX_LABEL_LENGTH = 240;

export function parseBenchlingLinkedItemExportPlan(value: unknown): BenchlingLinkedItemExportPlan {
  const record = requireRecord(value, 'Linked-item export plan must be an object.');
  requireExactKeys(record, [
    'folders',
    'kind',
    'organizationBaseUrl',
    'planId',
    'runId',
    'version',
  ]);
  if (record.version !== BENCHLING_LINKED_ITEM_EXPORT_PLAN_VERSION) {
    throw new Error('Linked-item export plan has an unsupported version.');
  }
  if (record.kind !== 'linked_item_export') {
    throw new Error('Linked-item export plan kind must be linked_item_export.');
  }
  const planId = requirePattern(record.planId, SHA256_RE, 'planId');
  const runId = requirePattern(record.runId, OPAQUE_ID_RE, 'runId');
  const organizationBaseUrl = parseBenchlingHttpsUrl(
    record.organizationBaseUrl,
    'organizationBaseUrl'
  );
  if (
    !Array.isArray(record.folders) ||
    record.folders.length === 0 ||
    record.folders.length > BENCHLING_LINKED_ITEM_EXPORT_PLAN_MAX_FOLDERS
  ) {
    throw new Error(
      `Linked-item export plan folders must contain 1 to ${BENCHLING_LINKED_ITEM_EXPORT_PLAN_MAX_FOLDERS} entries.`
    );
  }
  const seen = new Set<string>();
  const folders = record.folders.map((folder, index) => {
    const parsed = parseFolder(folder, index, organizationBaseUrl);
    if (seen.has(parsed.sourceId)) {
      throw new Error('Linked-item export plan folder IDs must be unique.');
    }
    seen.add(parsed.sourceId);
    return parsed;
  });
  return {
    version: BENCHLING_LINKED_ITEM_EXPORT_PLAN_VERSION,
    kind: 'linked_item_export',
    planId,
    runId,
    organizationBaseUrl,
    folders,
  };
}

function parseFolder(
  value: unknown,
  index: number,
  organizationBaseUrl: string
): BenchlingLinkedItemExportFolder {
  const record = requireRecord(value, `folders[${index}] must be an object.`);
  requireExactKeys(record, ['name', 'sourceId', 'sourceUrl', 'targetCount']);
  const sourceId = requirePattern(record.sourceId, OPAQUE_ID_RE, `folders[${index}].sourceId`);
  const name = requireBoundedString(record.name, `folders[${index}].name`, MAX_LABEL_LENGTH);
  const sourceUrl = parseBenchlingHttpsUrl(record.sourceUrl, `folders[${index}].sourceUrl`);
  const base = new URL(organizationBaseUrl);
  const source = new URL(sourceUrl);
  if (source.origin !== base.origin || !source.pathname.startsWith(base.pathname)) {
    throw new Error(`folders[${index}].sourceUrl must belong to organizationBaseUrl.`);
  }
  const targetCount = requireCount(record.targetCount, `folders[${index}].targetCount`);
  if (targetCount === 0) throw new Error(`folders[${index}].targetCount must be positive.`);
  return { sourceId, name, sourceUrl, targetCount };
}

function parseBenchlingHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error(`${label} must be a bounded URL string.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !(hostname === 'benchling.com' || hostname.endsWith('.benchling.com'))
  ) {
    throw new Error(`${label} must be an exact HTTPS Benchling URL.`);
  }
  return parsed.toString();
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`Unexpected export plan keys: ${actual.join(', ') || '<none>'}.`);
  }
}

function requirePattern(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format.`);
  }
  return value;
}

function requireBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters.`);
  }
  return normalized;
}

function requireCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error(`${label} must be a bounded non-negative integer.`);
  }
  return value;
}
