import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  FolderMigrationScope,
  FolderTreeMigrationScope,
} from '../../shared/benchling-migration';

const LOCAL_EXPORT_HIERARCHY_SCHEMA = 'dnaforge.benchling.local-export-hierarchy.v1' as const;

type LocalFolderMigrationScope = FolderMigrationScope | FolderTreeMigrationScope;

export type LocalBenchlingExportHierarchyFolder = Readonly<{
  id: string;
  name: string;
  parentId: string | null;
  relativePath: string;
  depth: number;
  included: boolean;
}>;

export type LocalBenchlingExportExcludedChildFolder = Readonly<{
  name: string;
  relativePath: string;
  sourceObjectCount: number;
}>;

export type LocalBenchlingExportHierarchyEvidence = Readonly<{
  schema: typeof LOCAL_EXPORT_HIERARCHY_SCHEMA;
  scopeKind: 'folder' | 'folder_tree';
  rootFolderId: string;
  rootFolderName: string;
  folders: readonly LocalBenchlingExportHierarchyFolder[];
  excludedChildFolders: readonly LocalBenchlingExportExcludedChildFolder[];
  excludedChildFolderCount: number;
  selectedSourceObjectCount: number;
  excludedSourceObjectCount: number;
}>;

export type LocalBenchlingExportHierarchyItem = Readonly<{
  canonicalPath: string;
  sourceObjectId: string;
  sourceKind: 'notebook_entry' | 'sequence' | 'protein' | 'protocol' | 'registry_record';
  membershipFolderId: string;
  included: boolean;
}>;

export type LocalBenchlingExportCanonicalItem = Readonly<{
  canonicalPath: string;
  sourceObjectId: string;
  sourceKind: 'notebook_entry' | 'sequence' | 'protein' | 'protocol' | 'registry_record';
}>;

export type LocalBenchlingExportHierarchyPlan = Readonly<{
  items: readonly LocalBenchlingExportHierarchyItem[];
  evidence: LocalBenchlingExportHierarchyEvidence;
}>;

export class LocalBenchlingExportHierarchyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalBenchlingExportHierarchyError';
  }
}

export function planLocalBenchlingExportHierarchy(input: {
  scope: LocalFolderMigrationScope;
  canonicalItems: readonly LocalBenchlingExportCanonicalItem[];
}): LocalBenchlingExportHierarchyPlan {
  const rootFolderId = selectedRootId(input.scope);
  const canonicalItems = validatedCanonicalItems(input.canonicalItems);
  if (canonicalItems.length === 0) {
    throw new LocalBenchlingExportHierarchyError(
      'The local Benchling folder ZIP contains no supported canonical entities.'
    );
  }

  const parsed = canonicalItems.map(parseOfficialItemPath);
  assertOneRepresentationPerMembership(parsed);
  assertNoNormalizedFolderPathCollisions(parsed);
  const rootNames = sortedUnique(parsed.map((item) => item.folderSegments[0]));
  if (rootNames.length !== 1) {
    throw new LocalBenchlingExportHierarchyError(
      `The local Benchling folder ZIP contains ${rootNames.length} possible selected roots.`
    );
  }
  const rootFolderName = rootNames[0];

  const folderPaths = new Set<string>();
  for (const item of parsed) {
    for (let length = 1; length <= item.folderSegments.length; length += 1) {
      folderPaths.add(item.folderSegments.slice(0, length).join('/'));
    }
  }
  const sortedFolderPaths = [...folderPaths].sort(compareText);
  const folderIdByPath = new Map<string, string>();
  for (const folderPath of sortedFolderPaths) {
    folderIdByPath.set(
      folderPath,
      folderPath === rootFolderName
        ? rootFolderId
        : localBenchlingExportDescendantFolderId(rootFolderId, folderPath)
    );
  }

  const includeDescendants = input.scope.kind === 'folder_tree';
  const folders = sortedFolderPaths.map((folderPath) => {
    const segments = folderPath.split('/');
    const parentPath = segments.slice(0, -1).join('/');
    return Object.freeze({
      id: requiredMapValue(folderIdByPath, folderPath),
      name: segments[segments.length - 1],
      parentId: parentPath ? requiredMapValue(folderIdByPath, parentPath) : null,
      relativePath: folderPath,
      depth: segments.length - 1,
      included: includeDescendants || segments.length === 1,
    } satisfies LocalBenchlingExportHierarchyFolder);
  });

  const items = parsed
    .map((item) =>
      Object.freeze({
        canonicalPath: item.canonicalPath,
        sourceObjectId: item.sourceObjectId,
        sourceKind: item.sourceKind,
        membershipFolderId: requiredMapValue(folderIdByPath, item.membershipFolderPath),
        included: includeDescendants || item.folderSegments.length === 1,
      } satisfies LocalBenchlingExportHierarchyItem)
    )
    .sort((left, right) => compareText(left.canonicalPath, right.canonicalPath));

  const childFolderPaths = sortedFolderPaths.filter(
    (folderPath) => folderPath.split('/').length === 2
  );
  const selectedSourceObjectIds = new Set(
    items.filter((item) => item.included).map((item) => item.sourceObjectId)
  );
  const excludedSourceObjectIds = new Set(
    items
      .filter((item) => !item.included && !selectedSourceObjectIds.has(item.sourceObjectId))
      .map((item) => item.sourceObjectId)
  );
  const excludedChildFolders = includeDescendants
    ? []
    : childFolderPaths.map((childFolderPath) => {
        const childPrefix = `${childFolderPath}/`;
        const sourceObjectCount = new Set(
          parsed
            .filter(
              (item) =>
                !selectedSourceObjectIds.has(item.sourceObjectId) &&
                (item.membershipFolderPath === childFolderPath ||
                  item.membershipFolderPath.startsWith(childPrefix))
            )
            .map((item) => item.sourceObjectId)
        ).size;
        return Object.freeze({
          name: path.posix.basename(childFolderPath),
          relativePath: childFolderPath,
          sourceObjectCount,
        } satisfies LocalBenchlingExportExcludedChildFolder);
      });
  const selectedSourceObjectCount = selectedSourceObjectIds.size;
  const evidence = Object.freeze({
    schema: LOCAL_EXPORT_HIERARCHY_SCHEMA,
    scopeKind: input.scope.kind,
    rootFolderId,
    rootFolderName,
    folders: Object.freeze(folders),
    excludedChildFolders: Object.freeze(excludedChildFolders),
    excludedChildFolderCount: excludedChildFolders.length,
    selectedSourceObjectCount,
    excludedSourceObjectCount: excludedSourceObjectIds.size,
  } satisfies LocalBenchlingExportHierarchyEvidence);

  return Object.freeze({ items: Object.freeze(items), evidence });
}

function selectedRootId(scope: LocalFolderMigrationScope): string {
  const roots = scope.kind === 'folder' ? [scope.folder] : scope.roots;
  if (roots.length !== 1) {
    throw new LocalBenchlingExportHierarchyError(
      `A local Benchling folder ZIP requires exactly one selected root; found ${roots.length}.`
    );
  }
  const rootId = roots[0]?.id.trim();
  if (!rootId) {
    throw new LocalBenchlingExportHierarchyError(
      'A local Benchling folder ZIP requires a non-empty selected root ID.'
    );
  }
  return rootId;
}

function validatedCanonicalItems(
  canonicalItems: readonly LocalBenchlingExportCanonicalItem[]
): LocalBenchlingExportCanonicalItem[] {
  if (!Array.isArray(canonicalItems)) {
    throw new LocalBenchlingExportHierarchyError(
      'Local Benchling folder ZIP canonical items must be an array.'
    );
  }
  const sorted = [...canonicalItems].sort((left, right) =>
    compareText(left.canonicalPath, right.canonicalPath)
  );
  const paths = new Set<string>();
  const tablePaths = new Set<string>();
  for (const item of sorted) {
    if (!item || typeof item !== 'object') {
      throw new LocalBenchlingExportHierarchyError(
        'The local Benchling folder ZIP contains invalid canonical item evidence.'
      );
    }
    const pathKey =
      item.sourceKind === 'registry_record'
        ? `${item.canonicalPath}\0${item.sourceObjectId}`
        : item.canonicalPath;
    if (
      paths.has(pathKey) ||
      (item.sourceKind === 'registry_record'
        ? paths.has(item.canonicalPath)
        : tablePaths.has(item.canonicalPath))
    ) {
      throw new LocalBenchlingExportHierarchyError(
        'The local Benchling folder ZIP contains a duplicate canonical object path.'
      );
    }
    if (
      (item.sourceKind === 'notebook_entry' &&
        !/^(?:etr|bfi)_[A-Za-z0-9]+$/u.test(item.sourceObjectId)) ||
      (item.sourceKind === 'sequence' && !/^seq_[A-Za-z0-9]+$/u.test(item.sourceObjectId)) ||
      (item.sourceKind === 'protein' && !/^prtn_[A-Za-z0-9]+$/u.test(item.sourceObjectId)) ||
      (item.sourceKind === 'protocol' && !/^prt_[A-Za-z0-9]+$/u.test(item.sourceObjectId)) ||
      (item.sourceKind === 'registry_record' &&
        !/^(?:bfi_[A-Za-z0-9]+|local-row-[a-f0-9]{64})$/u.test(item.sourceObjectId))
    ) {
      throw new LocalBenchlingExportHierarchyError(
        'The local Benchling folder ZIP canonical object type and identity disagree.'
      );
    }
    paths.add(pathKey);
    if (item.sourceKind === 'registry_record') tablePaths.add(item.canonicalPath);
  }
  return sorted;
}

function assertOneRepresentationPerMembership(
  items: readonly ReturnType<typeof parseOfficialItemPath>[]
): void {
  const identitiesByMembership = new Set<string>();
  for (const item of items) {
    const key = `${item.sourceObjectId}\0${item.membershipFolderPath}`;
    if (identitiesByMembership.has(key)) {
      throw new LocalBenchlingExportHierarchyError(
        'The local Benchling folder ZIP contains more than one canonical representation for the same object membership.'
      );
    }
    identitiesByMembership.add(key);
  }
}

function assertNoNormalizedFolderPathCollisions(
  items: readonly ReturnType<typeof parseOfficialItemPath>[]
): void {
  const archivePathByNormalizedPath = new Map<string, string>();
  for (const item of items) {
    for (let length = 1; length <= item.folderSegments.length; length += 1) {
      const normalizedPath = item.folderSegments.slice(0, length).join('/');
      const archivePath = item.archiveFolderSegments.slice(0, length).join('/');
      const priorArchivePath = archivePathByNormalizedPath.get(normalizedPath);
      if (priorArchivePath && priorArchivePath !== archivePath) {
        throw new LocalBenchlingExportHierarchyError(
          `Archive folder paths "${priorArchivePath}" and "${archivePath}" normalize to the same folder path.`
        );
      }
      archivePathByNormalizedPath.set(normalizedPath, archivePath);
    }
  }
}

function parseOfficialItemPath(item: LocalBenchlingExportCanonicalItem): {
  canonicalPath: string;
  sourceObjectId: string;
  sourceKind: LocalBenchlingExportCanonicalItem['sourceKind'];
  membershipFolderPath: string;
  folderSegments: string[];
  archiveFolderSegments: string[];
} {
  const canonicalPath = item.canonicalPath;
  if (typeof canonicalPath !== 'string' || !canonicalPath) {
    throw new LocalBenchlingExportHierarchyError(
      'The local Benchling folder ZIP contains an empty canonical object path.'
    );
  }
  const segments = canonicalPath.split('/');
  if (
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new LocalBenchlingExportHierarchyError(
      'A Benchling folder canonical object is not inside one selected root directory.'
    );
  }
  const archiveFolderSegments = segments.slice(0, -1);
  const folderSegments = archiveFolderSegments.map((segment) => segment.normalize('NFC'));
  return {
    canonicalPath,
    sourceObjectId: item.sourceObjectId,
    sourceKind: item.sourceKind,
    membershipFolderPath: folderSegments.join('/'),
    folderSegments,
    archiveFolderSegments,
  };
}

export function localBenchlingExportDescendantFolderId(
  rootFolderId: string,
  folderPath: string
): string {
  const digest = createHash('sha256')
    .update(`dnaforge.benchling.local-folder.v1\0${rootFolderId}\0${folderPath}`)
    .digest('hex');
  return `local_folder_${digest.slice(0, 24)}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function requiredMapValue(map: ReadonlyMap<string, string>, key: string): string {
  const value = map.get(key);
  if (!value) throw new LocalBenchlingExportHierarchyError(`Missing folder identity for ${key}.`);
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
