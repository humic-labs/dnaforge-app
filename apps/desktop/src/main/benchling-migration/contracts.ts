import type { BenchlingSourceRef, MigrationScope } from '../../shared/benchling-migration';
import { isLocalExportFolderSourceRef } from '../../shared/benchling-migration';
import { parseExactlyOneBenchlingObjectUrl } from './source-identity';

export class MigrationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationContractError';
  }
}

export function parseMigrationScope(value: unknown): MigrationScope {
  const input = requireRecord(value, 'Migration scope must be an object.');
  if (input.version !== 1) throw new MigrationContractError('Unsupported migration scope version.');
  if (input.kind === 'file') {
    const source = parseSourceRef(input.source, 'file source');
    const acquisition = parseLocalBundleAcquisition(input.acquisition);
    const parsed = parseExactlyOneBenchlingObjectUrl(source.url);
    if (parsed.route !== 'file') {
      throw new MigrationContractError('File scope requires a Benchling object, not a folder.');
    }
    assertMatchingSourceId(source, parsed.objectId);
    return {
      version: 1,
      kind: 'file',
      source: { ...source, url: parsed.canonicalUrl },
      ...(acquisition ? { acquisition } : {}),
    };
  }
  if (input.kind === 'folder') {
    const folder = parseSourceRef(input.folder, 'folder source');
    if (input.includeChildren !== false) {
      throw new MigrationContractError(
        'Direct Folder scope must explicitly exclude child folders.'
      );
    }
    const includeArchived = parseIncludeArchived(input.includeArchived);
    const acquisition = parseLocalBundleAcquisition(input.acquisition);
    if (acquisition === 'local_bundle' && isLocalExportFolderSourceRef(folder)) {
      return {
        version: 1,
        kind: 'folder',
        folder,
        includeChildren: false,
        includeArchived,
        acquisition,
      };
    }
    const parsed = parseExactlyOneBenchlingObjectUrl(folder.url);
    if (parsed.route !== 'folder') {
      throw new MigrationContractError(
        'Folder scope requires a stable Benchling folder reference.'
      );
    }
    assertMatchingSourceId(folder, parsed.objectId);
    return {
      version: 1,
      kind: 'folder',
      folder: {
        ...folder,
        url: acquisition === 'local_bundle' ? parsed.sourceUrl : parsed.canonicalUrl,
      },
      includeChildren: false,
      includeArchived,
      ...(acquisition ? { acquisition } : {}),
    };
  }
  if (input.kind === 'folder_tree') {
    if (!Array.isArray(input.roots) || input.roots.length !== 1) {
      throw new MigrationContractError('Folder Tree scope requires exactly one selected root.');
    }
    if (input.includeChildren !== true) {
      throw new MigrationContractError('Folder Tree scope must explicitly include descendants.');
    }
    const includeArchived = parseIncludeArchived(input.includeArchived);
    const acquisition = parseLocalBundleAcquisition(input.acquisition);
    const root = parseSourceRef(input.roots[0], 'root 1');
    if (acquisition === 'local_bundle' && isLocalExportFolderSourceRef(root)) {
      return {
        version: 1,
        kind: 'folder_tree',
        roots: [root],
        includeChildren: true,
        includeArchived,
        acquisition,
      };
    }
    const parsed = parseExactlyOneBenchlingObjectUrl(root.url);
    if (parsed.route !== 'folder') {
      throw new MigrationContractError('Every Folder Tree root must be a Benchling folder.');
    }
    assertMatchingSourceId(root, parsed.objectId);
    return {
      version: 1,
      kind: 'folder_tree',
      roots: [
        {
          ...root,
          url: acquisition === 'local_bundle' ? parsed.sourceUrl : parsed.canonicalUrl,
        },
      ],
      includeChildren: true,
      includeArchived,
      ...(acquisition ? { acquisition } : {}),
    };
  }
  throw new MigrationContractError('Migration scope kind must be file, folder, or folder_tree.');
}

function parseLocalBundleAcquisition(value: unknown): 'local_bundle' | undefined {
  if (value === undefined) return undefined;
  if (value === 'local_bundle') return value;
  throw new MigrationContractError('Folder acquisition must be local_bundle when provided.');
}

function parseIncludeArchived(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  throw new MigrationContractError('Folder archived-item selection must be a boolean.');
}

export function assertRunScopeMatches(runScope: MigrationScope, requestedScope: unknown): void {
  const normalizedRunScope = parseMigrationScope(runScope);
  const parsed = parseMigrationScope(requestedScope);
  if (JSON.stringify(normalizedRunScope) !== JSON.stringify(parsed)) {
    throw new MigrationContractError('Requested scope does not match the immutable migration run.');
  }
}

function parseSourceRef(value: unknown, label: string): BenchlingSourceRef {
  const source = requireRecord(value, `${label} must be an object.`);
  if (typeof source.id !== 'string' || source.id.trim() === '') {
    throw new MigrationContractError(`${label} requires a stable source ID.`);
  }
  if (typeof source.url !== 'string' || source.url.trim() === '') {
    throw new MigrationContractError(`${label} requires a canonical source URL.`);
  }
  return {
    id: source.id.trim(),
    url: source.url.trim(),
    ...(typeof source.objectType === 'string' && source.objectType.trim()
      ? { objectType: source.objectType.trim() }
      : {}),
  };
}

function assertMatchingSourceId(source: BenchlingSourceRef, parsedId: string): void {
  if (source.id !== parsedId) {
    throw new MigrationContractError(
      `Stable source ID ${source.id} does not match the object URL identity ${parsedId}.`
    );
  }
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MigrationContractError(message);
  }
  return value as Record<string, unknown>;
}
