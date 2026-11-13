import { isAbsolutePathLike, isPathInsideBoundary } from './path-boundary';
import { isProtectedImportReplacementPath } from './benchling-import-decision';
import { parseUniqueJson } from './unique-json';

export const MIGRATION_DESTINATION_LINK_INDEX_SCHEMA =
  'dnaforge.migration.destination-link-index.v1' as const;
export const MIGRATION_DESTINATION_LINK_INDEX_VERSION = 1 as const;
export const MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH =
  '.dnaforge/migration/destination-link-index.v1.json' as const;

export const MAX_MIGRATION_DESTINATION_LINK_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 100_000;
const MAX_SOURCE_ALIASES_PER_ENTRY = 64;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TITLE_LENGTH = 512;
const MAX_RELATIVE_PATH_LENGTH = 2_048;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type MigrationDestinationTabType =
  | 'sequence'
  | 'protein'
  | 'file'
  | 'text'
  | 'image'
  | 'html'
  | 'scientific-document'
  | 'page'
  | 'table'
  | 'design';

export type MigrationDestinationWorkspacePathLocator = {
  kind: 'workspace_path';
  relativePath: string;
  tabType: MigrationDestinationTabType;
};

export type MigrationDestinationLimsEntityLocator = {
  kind: 'lims_entity';
  entityId: string;
};

export type MigrationDestinationLocator =
  | MigrationDestinationWorkspacePathLocator
  | MigrationDestinationLimsEntityLocator;

const MIGRATION_DESTINATION_TAB_TYPES = new Set<MigrationDestinationTabType>([
  'sequence',
  'protein',
  'file',
  'text',
  'image',
  'html',
  'scientific-document',
  'page',
  'table',
  'design',
]);

export type MigrationDestinationLinkIndexEntryInput = {
  destinationObjectId: string;
  sourceStableIds: readonly string[];
  locator: MigrationDestinationLocator;
  title: string;
};

export type MigrationDestinationLinkIndexEntry = {
  destinationObjectId: string;
  sourceStableIds: readonly string[];
  locator: MigrationDestinationLocator;
  title: string;
};

export type MigrationDestinationLinkIndexV1 = {
  schema: typeof MIGRATION_DESTINATION_LINK_INDEX_SCHEMA;
  version: typeof MIGRATION_DESTINATION_LINK_INDEX_VERSION;
  entries: readonly MigrationDestinationLinkIndexEntry[];
};

export type MigrationDestinationLinkIndexWriterPayload = {
  relativePath: typeof MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH;
  text: string;
  index: MigrationDestinationLinkIndexV1;
};

export type ResolvedMigrationDestination = Omit<MigrationDestinationLinkIndexEntry, 'locator'> & {
  matchedKey: string;
  locator:
    | (MigrationDestinationWorkspacePathLocator & { absolutePath: string })
    | MigrationDestinationLimsEntityLocator;
};

export class MigrationDestinationLinkIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationDestinationLinkIndexError';
  }
}

export function buildMigrationDestinationLinkIndex(
  rawEntries: readonly MigrationDestinationLinkIndexEntryInput[]
): MigrationDestinationLinkIndexV1 {
  if (!Array.isArray(rawEntries)) fail('Destination link index entries must be an array.');
  if (rawEntries.length > MAX_INDEX_ENTRIES) {
    fail(`Destination link index cannot exceed ${MAX_INDEX_ENTRIES} entries.`);
  }

  const entries = rawEntries.map((entry, index) => validateEntry(entry, index));
  entries.sort((left, right) => compareText(left.destinationObjectId, right.destinationObjectId));
  assertUniqueResolutionKeys(entries);

  return Object.freeze({
    schema: MIGRATION_DESTINATION_LINK_INDEX_SCHEMA,
    version: MIGRATION_DESTINATION_LINK_INDEX_VERSION,
    entries: Object.freeze(entries),
  });
}

export function serializeMigrationDestinationLinkIndex(
  index: MigrationDestinationLinkIndexV1
): string {
  const canonical = buildMigrationDestinationLinkIndex(index.entries);
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function buildMigrationDestinationLinkIndexWriterPayload(
  entries: readonly MigrationDestinationLinkIndexEntryInput[]
): MigrationDestinationLinkIndexWriterPayload {
  const index = buildMigrationDestinationLinkIndex(entries);
  return Object.freeze({
    relativePath: MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH,
    text: serializeMigrationDestinationLinkIndex(index),
    index,
  });
}

export function parseMigrationDestinationLinkIndex(text: string): MigrationDestinationLinkIndexV1 {
  if (typeof text !== 'string') fail('Destination link index must be JSON text.');
  if (new TextEncoder().encode(text).byteLength > MAX_MIGRATION_DESTINATION_LINK_INDEX_BYTES) {
    fail(
      `Destination link index cannot exceed ${MAX_MIGRATION_DESTINATION_LINK_INDEX_BYTES} bytes.`
    );
  }
  const parsed = parseUniqueJson(text, { fail });
  const root = requireRecord(parsed, 'Destination link index must be an object.');
  assertExactKeys(root, ['schema', 'version', 'entries'], 'Destination link index');
  if (root.schema !== MIGRATION_DESTINATION_LINK_INDEX_SCHEMA) {
    fail('Destination link index schema is unsupported.');
  }
  if (root.version !== MIGRATION_DESTINATION_LINK_INDEX_VERSION) {
    fail('Destination link index version is unsupported.');
  }
  if (!Array.isArray(root.entries)) fail('Destination link index entries must be an array.');
  return buildMigrationDestinationLinkIndex(
    root.entries as MigrationDestinationLinkIndexEntryInput[]
  );
}

export async function readMigrationDestinationLinkIndex(
  workspaceRoot: string,
  readTextFileSlice: (
    path: string,
    maxBytes: number
  ) => Promise<{ text: string; bytesRead: number }>
): Promise<MigrationDestinationLinkIndexV1> {
  const indexPath = migrationDestinationLinkIndexPath(workspaceRoot);
  const result = await readTextFileSlice(indexPath, MAX_MIGRATION_DESTINATION_LINK_INDEX_BYTES + 1);
  if (
    !Number.isSafeInteger(result.bytesRead) ||
    result.bytesRead < 0 ||
    result.bytesRead > MAX_MIGRATION_DESTINATION_LINK_INDEX_BYTES ||
    new TextEncoder().encode(result.text).byteLength > MAX_MIGRATION_DESTINATION_LINK_INDEX_BYTES
  ) {
    fail(
      `Destination link index cannot exceed ${MAX_MIGRATION_DESTINATION_LINK_INDEX_BYTES} bytes.`
    );
  }
  return parseMigrationDestinationLinkIndex(result.text);
}

export function migrationDestinationLinkIndexPath(workspaceRoot: string): string {
  const root = validateWorkspaceRoot(workspaceRoot);
  return joinWorkspacePath(root, MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH);
}

export function createMigrationDestinationResolver(
  index: MigrationDestinationLinkIndexV1,
  workspaceRoot: string
): (targetId: string) => ResolvedMigrationDestination | null {
  const canonical = buildMigrationDestinationLinkIndex(index.entries);
  const root = validateWorkspaceRoot(workspaceRoot);
  const byKey = new Map<string, MigrationDestinationLinkIndexEntry>();
  for (const entry of canonical.entries) {
    byKey.set(entry.destinationObjectId, entry);
    for (const alias of entry.sourceStableIds) byKey.set(alias, entry);
    if (entry.locator.kind === 'lims_entity') byKey.set(entry.locator.entityId, entry);
  }

  return (rawTargetId: string): ResolvedMigrationDestination | null => {
    if (!isSafeMigrationDestinationIdentifier(rawTargetId)) return null;
    const entry = byKey.get(rawTargetId);
    if (!entry) return null;
    const locator = entry.locator;
    if (locator.kind === 'lims_entity') {
      return Object.freeze({ ...entry, matchedKey: rawTargetId, locator });
    }
    const absolutePath = joinWorkspacePath(root, locator.relativePath);
    if (!isPathInsideBoundary(absolutePath, root)) return null;
    return Object.freeze({
      ...entry,
      matchedKey: rawTargetId,
      locator: Object.freeze({ ...locator, absolutePath }),
    });
  };
}

export function isSafeMigrationDestinationIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.normalize('NFC') === value &&
    SAFE_IDENTIFIER.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

export function isSafeMigrationDestinationRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RELATIVE_PATH_LENGTH ||
    value.normalize('NFC') !== value ||
    value.includes('\\') ||
    isAbsolutePathLike(value) ||
    containsControlCharacters(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  if (isProtectedImportReplacementPath(value)) return false;
  return segments.every((segment) => {
    if (!segment || segment === '.' || segment === '..') return false;
    if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) return false;
    if (WINDOWS_RESERVED_SEGMENT.test(segment)) return false;
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
        return false;
      }
    } catch {
      if (segment.includes('%')) return false;
    }
    return true;
  });
}

function validateEntry(
  value: MigrationDestinationLinkIndexEntryInput,
  index: number
): MigrationDestinationLinkIndexEntry {
  const entry = requireRecord(value, `Destination link entry ${index + 1} must be an object.`);
  assertExactKeys(
    entry,
    ['destinationObjectId', 'sourceStableIds', 'locator', 'title'],
    `Destination link entry ${index + 1}`
  );
  const destinationObjectId = requireIdentifier(
    entry.destinationObjectId,
    `Destination link entry ${index + 1} destination object ID`
  );
  if (!Array.isArray(entry.sourceStableIds) || entry.sourceStableIds.length === 0) {
    fail(`Destination link entry ${index + 1} requires at least one source stable ID.`);
  }
  if (entry.sourceStableIds.length > MAX_SOURCE_ALIASES_PER_ENTRY) {
    fail(
      `Destination link entry ${index + 1} cannot exceed ${MAX_SOURCE_ALIASES_PER_ENTRY} source stable IDs.`
    );
  }
  const sourceStableIds = entry.sourceStableIds.map((sourceId, sourceIndex) =>
    requireIdentifier(
      sourceId,
      `Destination link entry ${index + 1} source stable ID ${sourceIndex + 1}`
    )
  );
  sourceStableIds.sort(compareText);
  const localKeys = new Set<string>([destinationObjectId]);
  for (const sourceId of sourceStableIds) {
    if (localKeys.has(sourceId)) {
      fail(`Destination link resolution key ${sourceId} is duplicated.`);
    }
    localKeys.add(sourceId);
  }
  const locator = validateLocator(entry.locator, index, destinationObjectId);
  const title = requireTitle(entry.title, `Destination link entry ${index + 1} title`);
  return Object.freeze({
    destinationObjectId,
    sourceStableIds: Object.freeze(sourceStableIds),
    locator,
    title,
  });
}

function assertUniqueResolutionKeys(entries: readonly MigrationDestinationLinkIndexEntry[]): void {
  const keys = new Set<string>();
  const paths = new Set<string>();
  for (const entry of entries) {
    const entryKeys = new Set([
      entry.destinationObjectId,
      ...entry.sourceStableIds,
      ...(entry.locator.kind === 'lims_entity' ? [entry.locator.entityId] : []),
    ]);
    for (const key of entryKeys) {
      if (keys.has(key)) fail(`Destination link resolution key ${key} is duplicated.`);
      keys.add(key);
    }
    if (entry.locator.kind !== 'workspace_path') continue;
    if (paths.has(entry.locator.relativePath)) {
      fail(`Destination link path ${entry.locator.relativePath} is assigned to multiple objects.`);
    }
    paths.add(entry.locator.relativePath);
  }
}

function validateLocator(
  value: unknown,
  entryIndex: number,
  destinationObjectId: string
): MigrationDestinationLocator {
  const locator = requireRecord(
    value,
    `Destination link entry ${entryIndex + 1} locator must be an object.`
  );
  if (locator.kind === 'workspace_path') {
    assertExactKeys(
      locator,
      ['kind', 'relativePath', 'tabType'],
      `Destination link entry ${entryIndex + 1} workspace locator`
    );
    const generatedCollection =
      locator.tabType === 'scientific-document' &&
      /^folder-[a-f0-9]{24}$/u.test(destinationObjectId) &&
      locator.relativePath === `.dnaforge/migration/collections/${destinationObjectId}.json`;
    let relativePath: string;
    if (generatedCollection) {
      relativePath = `.dnaforge/migration/collections/${destinationObjectId}.json`;
    } else if (isSafeMigrationDestinationRelativePath(locator.relativePath)) {
      relativePath = locator.relativePath;
    } else {
      fail(`Destination link entry ${entryIndex + 1} has an unsafe workspace-relative path.`);
    }
    if (
      typeof locator.tabType !== 'string' ||
      !MIGRATION_DESTINATION_TAB_TYPES.has(locator.tabType as MigrationDestinationTabType)
    ) {
      fail(`Destination link entry ${entryIndex + 1} has an unsupported tab type.`);
    }
    return Object.freeze({
      kind: 'workspace_path',
      relativePath,
      tabType: locator.tabType as MigrationDestinationTabType,
    });
  }
  if (locator.kind === 'lims_entity') {
    assertExactKeys(
      locator,
      ['kind', 'entityId'],
      `Destination link entry ${entryIndex + 1} LIMS locator`
    );
    return Object.freeze({
      kind: 'lims_entity',
      entityId: requireIdentifier(
        locator.entityId,
        `Destination link entry ${entryIndex + 1} LIMS entity ID`
      ),
    });
  }
  fail(`Destination link entry ${entryIndex + 1} has an unsupported locator kind.`);
}

function requireIdentifier(value: unknown, label: string): string {
  if (!isSafeMigrationDestinationIdentifier(value)) fail(`${label} is invalid.`);
  return value;
}

function requireTitle(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is invalid.`);
  const title = value.trim().normalize('NFC');
  if (!title || title.length > MAX_TITLE_LENGTH || containsControlCharacters(title)) {
    fail(`${label} is invalid.`);
  }
  return title;
}

function validateWorkspaceRoot(value: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolutePathLike(value) ||
    /[\0\r\n]/.test(value) ||
    value.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')
  ) {
    fail('Migration workspace root must be an absolute traversal-free path.');
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
}

function joinWorkspacePath(root: string, relativePath: string): string {
  return root.endsWith('/') ? `${root}${relativePath}` : `${root}/${relativePath}`;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const expectedKeys = new Set(expected);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expectedKeys.has(key))) {
    fail(`${label} contains unknown or missing fields.`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function fail(message: string): never {
  throw new MigrationDestinationLinkIndexError(message);
}
