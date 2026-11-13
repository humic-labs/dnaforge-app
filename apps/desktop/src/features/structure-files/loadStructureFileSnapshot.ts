import { withUserMessage } from '@waypoint/user-messages';
import { getCurrentCatalogFileForEntity } from '../../db/workspace-catalog';
import { platform } from '../../platform';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import {
  getStructureFileSnapshot,
  registerStructureFileSnapshot,
  registerStructureFileSnapshotForLease,
  waitForStructureFileSnapshotRegistrationForTests,
  type StructureFileSnapshotLease,
  type StructureFileSnapshot,
} from './structure-file-snapshots';

export type StructureFileLoadErrorCode =
  | 'invalid-reference'
  | 'read-error'
  | 'read-timeout'
  | 'empty-file'
  | 'unsupported-cif'
  | 'revision-changed';

export class StructureFileLoadError extends Error {
  constructor(
    readonly code: StructureFileLoadErrorCode,
    message: string,
    readonly filePath?: string
  ) {
    super(message);
    this.name = 'StructureFileLoadError';
    if (code === 'unsupported-cif') withUserMessage(this, 'structure.unsupportedCoordinates');
  }
}

const STRUCTURE_FILE_READ_TIMEOUT_MS = 30_000;

export interface StructureFileSnapshotLocator {
  structureViewId: string;
  entityId: string;
  revisionId: string;
  coordinateDigestSha256: string;
  artifactPath: string;
  format: 'mmcif' | 'pdb' | 'binary-cif';
}

export function structureFileSnapshotLocatorFromAttrs(
  attrs: Structure3dAttrs | undefined
): StructureFileSnapshotLocator | null {
  const artifact = attrs?.structureArtifactRef;
  const structureViewId = attrs?.structureViewIdentity?.structureViewId;
  if (!artifact || !structureViewId) return null;
  return {
    structureViewId,
    entityId: artifact.entityId,
    revisionId: artifact.revisionId,
    coordinateDigestSha256: artifact.coordinateDigestSha256,
    artifactPath: artifact.artifactPath,
    format: artifact.format,
  };
}

export async function loadStructureFileSnapshot(
  locator: StructureFileSnapshotLocator | null,
  workspaceFolders: ReadonlyArray<{ path: string }>,
  lease?: StructureFileSnapshotLease
): Promise<StructureFileSnapshot> {
  if (!locator) {
    throw new StructureFileLoadError(
      'invalid-reference',
      'This structure tab has no pinned coordinate-file revision.'
    );
  }
  const structureViewId = locator.structureViewId;

  const cached = getStructureFileSnapshot(structureViewId);
  if (
    cached &&
    cached.revisionId === locator.revisionId &&
    cached.coordinateDigestSha256 === locator.coordinateDigestSha256
  ) {
    return cached;
  }

  const filePath = await resolveCurrentStructureFilePath(
    locator.entityId,
    locator.artifactPath,
    workspaceFolders
  );
  const encoding = locator.format === 'binary-cif' ? 'binary' : 'text';
  const parser = locator.format === 'pdb' ? 'pdb' : 'mmcif';

  let data: string | Uint8Array;
  try {
    data =
      encoding === 'binary'
        ? await withTimeout(
            platform().fs.readFile(filePath),
            STRUCTURE_FILE_READ_TIMEOUT_MS,
            filePath
          )
        : await withTimeout(
            platform().fs.readTextFile(filePath),
            STRUCTURE_FILE_READ_TIMEOUT_MS,
            filePath
          );
  } catch (error) {
    if (error instanceof StructureFileLoadError) throw error;
    throw new StructureFileLoadError('read-error', readableFilesystemError(error), filePath);
  }

  const coordinateDigestSha256 = await digestStructureData(data);
  if (coordinateDigestSha256 !== locator.coordinateDigestSha256) {
    throw new StructureFileLoadError(
      'revision-changed',
      'This coordinate file changed after the view was pinned. Reopen the file to create its new revision.',
      filePath
    );
  }
  validateMacromolecularCoordinateData(data, parser, filePath);

  const snapshot: StructureFileSnapshot = {
    structureViewId,
    revisionId: locator.revisionId,
    filePath,
    coordinateDigestSha256,
    parser,
    encoding,
    data,
  };
  await waitForStructureFileSnapshotRegistrationForTests();
  if (lease) registerStructureFileSnapshotForLease(snapshot, lease);
  else registerStructureFileSnapshot(snapshot);
  return snapshot;
}

async function resolveCurrentStructureFilePath(
  entityId: string,
  artifactPath: string,
  workspaceFolders: ReadonlyArray<{ path: string }>
): Promise<string> {
  try {
    const current = await getCurrentCatalogFileForEntity(entityId);
    if (current?.path) return current.path;
  } catch {}
  if (isAbsolutePathLike(artifactPath)) return artifactPath;
  if (artifactPath.split(/[\\/]/).includes('..')) {
    throw new StructureFileLoadError(
      'invalid-reference',
      'The coordinate-file path escapes its project root.'
    );
  }
  if (workspaceFolders.length !== 1) {
    throw new StructureFileLoadError(
      'invalid-reference',
      'The coordinate-file project is not open.'
    );
  }
  return `${workspaceFolders[0].path.replace(/[\\/]+$/, '')}/${artifactPath.replace(/^[\\/]+/, '')}`;
}

function validateMacromolecularCoordinateData(
  data: string | Uint8Array,
  parser: 'pdb' | 'mmcif',
  filePath: string
): void {
  if (data.length === 0 || (typeof data === 'string' && data.trim().length === 0)) {
    throw new StructureFileLoadError('empty-file', 'The coordinate file is empty.', filePath);
  }
  if (parser === 'mmcif' && typeof data === 'string' && !/(?:^|\n)_atom_site(?:\.|_)/m.test(data)) {
    throw new StructureFileLoadError(
      'unsupported-cif',
      'This CIF does not contain a macromolecular atom_site table. Open it as text instead.',
      filePath
    );
  }
}

async function digestStructureData(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, filePath: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(
      () =>
        reject(
          new StructureFileLoadError(
            'read-timeout',
            'Reading the coordinate file timed out. Retry or reveal the file in Finder.',
            filePath
          )
        ),
      timeoutMs
    );
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function readableFilesystemError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/enoent|not found|no such file/i.test(message)) return 'The coordinate file is missing.';
  if (/eacces|eperm|permission/i.test(message)) {
    return 'DNAForge does not have permission to read this coordinate file.';
  }
  return 'DNAForge could not read this coordinate file.';
}

function isAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}
