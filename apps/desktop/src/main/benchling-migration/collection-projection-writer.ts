import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { NativeWorkspacePlacement } from '../../shared/native-workspace-manifest';
import { isSafeWorkspaceRelativePath } from './safe-workspace-path';
import { isProtectedImportReplacementPath } from '../../shared/benchling-import-decision';
import type {
  MigrationScope,
  ValidationScopedBoundarySourceIdMode,
} from '../../shared/benchling-migration';
import {
  serializeCollectionProjection,
  type CollectionProjection,
  type NativeCollectionDocument,
  type ScopedFolderMetadata,
} from './collection-projection';
import {
  SCOPED_BOUNDARY_EVIDENCE_PATH,
  parseScopedBoundaryEvidenceV1,
  serializeScopedBoundaryEvidenceV1,
  type ScopedBoundaryEvidenceV1,
} from './scoped-boundary-evidence';

export { SCOPED_BOUNDARY_EVIDENCE_PATH } from './scoped-boundary-evidence';

export const COLLECTION_PROJECTION_MANIFEST_PATH = '.dnaforge/migration/collection-projection.json';
export const SCOPED_FOLDER_BOUNDARY_PATH = '.dnaforge/migration/scoped-folder-boundary.json';
export type CollectionProjectionLayout = 'legacy-v1' | 'native-v2';

type PersistedScopedFolderBoundary = {
  schema: 'dnaforge.scoped-folder-boundary.v1';
  runId: string;
  scope: Exclude<MigrationScope, { kind: 'file' }>;
  sourceAccountHash: string;
  folders: ScopedFolderMetadata[];
};

export type WrittenCollectionProjection = {
  manifestPath: string;
  collectionDocumentPaths: string[];
  nativeFolderPaths: string[];
};

export async function writeCollectionProjection(input: {
  workspacePath: string;
  projection: CollectionProjection;
  layout?: CollectionProjectionLayout;
}): Promise<WrittenCollectionProjection> {
  const layout = input.layout ?? 'legacy-v1';
  const workspacePath = resolve(input.workspacePath);
  const manifestText = serializeCollectionProjection(input.projection);
  const collectionDocumentPaths = input.projection.collections
    .map((collection) => nativeCollectionDocumentPath(collection, layout))
    .sort();
  const nativeFolderPaths = [...nativeFolderPathMap(input.projection, layout).values()].sort();
  const collectionDocumentPathSet = new Set(collectionDocumentPaths);
  const nativeFolderPathSet = new Set(nativeFolderPaths);
  let previousProjection: CollectionProjection | null = null;
  try {
    previousProjection = await readCollectionProjection(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const previousCollectionDocumentPaths = new Set(
    previousProjection?.collections.map((collection) =>
      nativeCollectionDocumentPath(collection, layout)
    ) ?? []
  );
  const previousNativeFolderPaths = new Set(
    previousProjection ? nativeFolderPathMap(previousProjection, layout).values() : []
  );
  const staleFolderPaths = [...previousNativeFolderPaths]
    .filter((path) => !nativeFolderPathSet.has(path))
    .sort()
    .reverse();
  for (const path of staleFolderPaths) await assertRemovableFolderMarker(workspacePath, path);

  for (const collection of input.projection.collections) {
    await atomicWriteContained(
      workspacePath,
      nativeCollectionDocumentPath(collection, layout),
      `${JSON.stringify(collection, null, 2)}\n`
    );
  }
  for (const folderPath of nativeFolderPaths) {
    const relativePath = `${folderPath}/.gitkeep`;
    await assertNoSymlinkSegments(workspacePath, folderPath);
    const marker = join(workspacePath, relativePath);
    await mkdir(dirname(marker), { recursive: true });
    try {
      await writeFile(marker, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await lstat(marker);
      if (!existing.isFile() || existing.isSymbolicLink() || (await readFile(marker)).length !== 0)
        throw new Error('Existing folder marker was changed outside the import.');
    }
  }
  for (const stalePath of [...previousCollectionDocumentPaths]
    .filter((path) => !collectionDocumentPathSet.has(path))
    .sort()) {
    await rm(join(workspacePath, stalePath), { force: true });
    await removeEmptyDirectory(join(workspacePath, dirname(stalePath)));
  }
  for (const stalePath of staleFolderPaths) {
    await assertRemovableFolderMarker(workspacePath, stalePath);
    await rm(join(workspacePath, stalePath, '.gitkeep'), { force: true });
    await removeEmptyDirectory(join(workspacePath, stalePath));
  }
  await atomicWriteContained(workspacePath, COLLECTION_PROJECTION_MANIFEST_PATH, manifestText);

  const persisted = await readCollectionProjection(workspacePath);
  if (serializeCollectionProjection(persisted) !== manifestText) {
    throw new Error('Persisted collection projection does not match its deterministic manifest.');
  }
  for (const collection of input.projection.collections) {
    const path = nativeCollectionDocumentPath(collection, layout);
    const persistedDocument = JSON.parse(
      await readFile(join(workspacePath, path), 'utf8')
    ) as NativeCollectionDocument;
    if (JSON.stringify(persistedDocument) !== JSON.stringify(collection)) {
      throw new Error(`Persisted native collection ${collection.id} failed read-back validation.`);
    }
  }

  return {
    manifestPath: COLLECTION_PROJECTION_MANIFEST_PATH,
    collectionDocumentPaths,
    nativeFolderPaths,
  };
}

async function assertRemovableFolderMarker(
  workspacePath: string,
  folderPath: string
): Promise<void> {
  await assertNoSymlinkSegments(workspacePath, folderPath);
  const marker = join(workspacePath, folderPath, '.gitkeep');
  try {
    const metadata = await lstat(marker);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (await readFile(marker)).length !== 0)
      throw new Error('Existing folder marker was changed outside the import.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeEmptyDirectory(directoryPath: string): Promise<void> {
  try {
    await rmdir(directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
}

export async function readCollectionProjection(
  workspacePath: string
): Promise<CollectionProjection> {
  return JSON.parse(
    await readFile(join(resolve(workspacePath), COLLECTION_PROJECTION_MANIFEST_PATH), 'utf8')
  ) as CollectionProjection;
}

export async function persistScopedFolderBoundary(input: {
  workspacePath: string;
  runId: string;
  scope: Exclude<MigrationScope, { kind: 'file' }>;
  sourceAccountHash: string;
  folders: ScopedFolderMetadata[];
}): Promise<void> {
  const boundary: PersistedScopedFolderBoundary = {
    schema: 'dnaforge.scoped-folder-boundary.v1',
    runId: input.runId,
    scope: input.scope,
    sourceAccountHash: input.sourceAccountHash,
    folders: [...input.folders].sort((left, right) => left.ref.id.localeCompare(right.ref.id)),
  };
  const workspacePath = resolve(input.workspacePath);
  const serialized = `${JSON.stringify(boundary, null, 2)}\n`;
  try {
    const existing = await readFile(join(workspacePath, SCOPED_FOLDER_BOUNDARY_PATH), 'utf8');
    if (existing !== serialized) {
      throw new Error('The persisted scoped folder boundary is immutable.');
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await atomicWriteContained(workspacePath, SCOPED_FOLDER_BOUNDARY_PATH, serialized);
}

export async function readScopedFolderBoundary(input: {
  workspacePath: string;
  runId: string;
  scope: Exclude<MigrationScope, { kind: 'file' }>;
  sourceAccountHash: string;
}): Promise<ScopedFolderMetadata[]> {
  const boundary = JSON.parse(
    await readFile(join(resolve(input.workspacePath), SCOPED_FOLDER_BOUNDARY_PATH), 'utf8')
  ) as PersistedScopedFolderBoundary;
  if (
    boundary.schema !== 'dnaforge.scoped-folder-boundary.v1' ||
    boundary.runId !== input.runId ||
    JSON.stringify(boundary.scope) !== JSON.stringify(input.scope) ||
    boundary.sourceAccountHash !== input.sourceAccountHash
  ) {
    throw new Error('Persisted scoped folder boundary does not match this migration run.');
  }
  return boundary.folders;
}

export async function persistScopedBoundaryEvidence(input: {
  workspacePath: string;
  evidence: ScopedBoundaryEvidenceV1;
  sourceIdMode?: ValidationScopedBoundarySourceIdMode;
}): Promise<void> {
  const workspacePath = resolve(input.workspacePath);
  const serialized = serializeScopedBoundaryEvidenceV1(input.evidence, {
    sourceIdMode: input.sourceIdMode,
  });
  try {
    const existing = await readFile(join(workspacePath, SCOPED_BOUNDARY_EVIDENCE_PATH), 'utf8');
    if (existing !== serialized) {
      throw new Error('The persisted scoped boundary evidence is immutable.');
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await atomicWriteContained(workspacePath, SCOPED_BOUNDARY_EVIDENCE_PATH, serialized);
}

export async function readScopedBoundaryEvidence(input: {
  workspacePath: string;
  runId: string;
  scope: Exclude<MigrationScope, { kind: 'file' }>;
  sourceAccountHash: string;
  sourceIdMode?: ValidationScopedBoundarySourceIdMode;
}): Promise<ScopedBoundaryEvidenceV1> {
  const evidence = parseScopedBoundaryEvidenceV1(
    await readFile(join(resolve(input.workspacePath), SCOPED_BOUNDARY_EVIDENCE_PATH), 'utf8'),
    { sourceIdMode: input.sourceIdMode }
  );
  if (
    evidence.runId !== input.runId ||
    JSON.stringify(evidence.scope) !== JSON.stringify(input.scope) ||
    evidence.sourceAccountHash !== input.sourceAccountHash
  ) {
    throw new Error('Persisted scoped boundary evidence does not match this migration run.');
  }
  return evidence;
}

export function nativeCollectionDocumentPath(
  collection: Pick<NativeCollectionDocument, 'id'>,
  layout: CollectionProjectionLayout = 'legacy-v1'
): string {
  if (!/^folder-[a-f0-9]{24}$/.test(collection.id)) {
    throw new Error(`Native collection ID ${collection.id} is not a deterministic migration ID.`);
  }
  return layout === 'native-v2'
    ? `.dnaforge/migration/collections/${collection.id}.json`
    : `Benchling Imports/Collections/${collection.id}/${collection.id}.dnaforge-collection.json`;
}

export function preserveNativeFolderPlacements(
  projection: CollectionProjection,
  entities: readonly { id: string; type: string; placement?: NativeWorkspacePlacement }[]
): CollectionProjection {
  const ids = new Set(projection.collections.map((folder) => folder.id));
  return {
    ...projection,
    nativeFolderPaths: Object.fromEntries(
      entities.flatMap((entity) =>
        entity.type === 'folder' && ids.has(entity.id) && entity.placement?.kind === 'file'
          ? [[entity.id, entity.placement.relativePath]]
          : []
      )
    ),
  };
}

export function nativeFolderPathMap(
  projection: CollectionProjection,
  layout: CollectionProjectionLayout = 'legacy-v1'
): Map<string, string> {
  const byId = new Map(projection.collections.map((folder) => [folder.id, folder]));
  const readableSegmentById = new Map(
    projection.collections.map((folder) => [folder.id, readableNativeFolderSegment(folder.title)])
  );
  const siblingNameCounts = new Map<string, number>();
  for (const folder of projection.collections) {
    const readable = requireReadableSegment(readableSegmentById, folder.id);
    const siblingKey = `${folder.parentCollectionId ?? '<root>'}\0${readable.toLowerCase()}`;
    siblingNameCounts.set(siblingKey, (siblingNameCounts.get(siblingKey) ?? 0) + 1);
  }
  const paths = new Map<string, string>();
  const owners = new Map<string, string>();
  const pathKey = (path: string) => path.normalize('NFC').toLowerCase();
  if (layout === 'native-v2')
    for (const [id, path] of Object.entries(projection.nativeFolderPaths ?? {})) {
      if (
        !byId.has(id) ||
        !isSafeWorkspaceRelativePath(path) ||
        isProtectedImportReplacementPath(path) ||
        owners.has(pathKey(path))
      )
        throw new Error('Existing native folder placement is invalid.');
      paths.set(id, path);
      owners.set(pathKey(path), id);
    }
  const resolving = new Set<string>();
  const resolveFolder = (folder: NativeCollectionDocument): string => {
    const existing = paths.get(folder.id);
    if (existing) return existing;
    if (resolving.has(folder.id))
      throw new Error(`Native folder hierarchy cycles at ${folder.id}.`);
    resolving.add(folder.id);
    const parent = folder.parentCollectionId ? byId.get(folder.parentCollectionId) : null;
    if (folder.parentCollectionId && !parent) {
      throw new Error(`Native folder ${folder.id} has an unknown parent.`);
    }
    const parentPath = parent
      ? resolveFolder(parent)
      : layout === 'native-v2'
        ? ''
        : 'Benchling Imports/Folders';
    const readable = requireReadableSegment(readableSegmentById, folder.id);
    const siblingKey = `${folder.parentCollectionId ?? '<root>'}\0${readable.toLowerCase()}`;
    const segment =
      siblingNameCounts.get(siblingKey) === 1 ? readable : `${readable}-${folder.id.slice(-8)}`;
    let path = parentPath ? `${parentPath}/${segment}` : segment;
    if (owners.has(pathKey(path))) {
      const stable = `${readable}-${folder.id.slice(-8)}`;
      let ordinal = 1;
      do {
        const disambiguated = ordinal === 1 ? stable : `${stable}-${ordinal}`;
        path = parentPath ? `${parentPath}/${disambiguated}` : disambiguated;
        ordinal++;
      } while (owners.has(pathKey(path)));
    }
    paths.set(folder.id, path);
    owners.set(pathKey(path), folder.id);
    resolving.delete(folder.id);
    return path;
  };
  for (const folder of projection.collections) resolveFolder(folder);
  return paths;
}

function requireReadableSegment(segments: ReadonlyMap<string, string>, folderId: string): string {
  const segment = segments.get(folderId);
  if (segment === undefined) throw new Error(`Native folder ${folderId} has no readable segment.`);
  return segment;
}

function readableNativeFolderSegment(title: string): string {
  const readable = title
    .normalize('NFC')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  return readable || 'Imported folder';
}

async function atomicWriteContained(
  workspacePath: string,
  relativePath: string,
  content: string
): Promise<void> {
  const destination = resolve(workspacePath, relativePath);
  if (destination !== workspacePath && !destination.startsWith(`${workspacePath}${sep}`)) {
    throw new Error('Collection projection destination escapes the staging workspace.');
  }
  await assertNoSymlinkSegments(workspacePath, dirname(relativePath));
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function assertNoSymlinkSegments(workspacePath: string, relativeDirectory: string) {
  let current = workspacePath;
  for (const segment of relativeDirectory.split('/')) {
    if (!segment || segment === '.') continue;
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Collection projection path contains a symlink: ${segment}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Collection projection path contains a non-directory: ${segment}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
