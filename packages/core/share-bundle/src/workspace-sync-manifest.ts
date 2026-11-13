import { createHash } from 'node:crypto';
import { workspaceSyncManifestHashInput } from './workspace-sync-manifest-canonical';
export { workspaceSyncManifestHashInput } from './workspace-sync-manifest-canonical';
import { isSafeRelativePath } from './shared';
import type { WorkspaceSyncStoragePolicy } from './workspace-sync-storage-policy';
import {
  WORKSPACE_SYNC_MANIFEST_MAX_FILES,
  WORKSPACE_SYNC_MANIFEST_MAX_PATH_LENGTH,
  WORKSPACE_SYNC_MANIFEST_MAX_CONTENT_TYPE_LENGTH,
} from './workspace-sync-limits';

export { WORKSPACE_SYNC_MANIFEST_MAX_FILES } from './workspace-sync-limits';
export { validatePortableWorkspaceTree as validateWorkspaceSyncManifestTree } from '@waypoint/workspace-revisions';

export const WORKSPACE_SYNC_MANIFEST_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_SYNC_MANIFEST_MAX_BLOB_BYTES = Number.MAX_SAFE_INTEGER;
export const WORKSPACE_SYNC_MANIFEST_READ_LIMITS = {
  maxFileBytes: Number.MAX_SAFE_INTEGER,
  maxBundleBytes: Number.MAX_SAFE_INTEGER,
  maxFiles: WORKSPACE_SYNC_MANIFEST_MAX_FILES,
} as const;
export const DESKTOP_SYNC_MANIFEST_JSON_MAX_BYTES = 4 * 1024 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MANIFEST_KEYS = new Set(['schemaVersion', 'files']);
const FILE_KEYS = new Set(['path', 'contentSha256', 'sizeBytes', 'contentType']);

export interface WorkspaceSyncManifestFileV1 {
  path: string;
  contentSha256: string;
  sizeBytes: number;
  contentType: string;
}

export interface WorkspaceSyncManifestV1 {
  schemaVersion: typeof WORKSPACE_SYNC_MANIFEST_SCHEMA_VERSION;
  files: WorkspaceSyncManifestFileV1[];
}

export type WorkspaceSyncManifestParseResult =
  | { ok: true; manifest: WorkspaceSyncManifestV1 }
  | { ok: false; errors: string[] };

export function parseWorkspaceSyncManifest(
  value: unknown,
  policy?: Pick<WorkspaceSyncStoragePolicy, 'maxFileBytes' | 'maxProjectBytes' | 'maxFiles'>
): WorkspaceSyncManifestParseResult {
  if (!isRecord(value)) return invalid('manifest must be an object');
  if (hasUnsupportedKeys(value, MANIFEST_KEYS)) {
    return invalid('manifest contains unsupported fields');
  }
  if (value.schemaVersion !== WORKSPACE_SYNC_MANIFEST_SCHEMA_VERSION) {
    return invalid(`schemaVersion must be ${WORKSPACE_SYNC_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.files)) return invalid('files must be an array');
  const maxFiles = Math.min(
    policy?.maxFiles ?? WORKSPACE_SYNC_MANIFEST_MAX_FILES,
    WORKSPACE_SYNC_MANIFEST_MAX_FILES
  );
  if (value.files.length > maxFiles) {
    return invalid(`files must contain at most ${maxFiles} entries`);
  }

  const errors: string[] = [];
  const files: WorkspaceSyncManifestFileV1[] = [];
  const paths = new Set<string>();
  const caseFoldedPaths = new Set<string>();

  for (const [index, candidate] of value.files.entries()) {
    const label = `files[${index}]`;
    if (!isRecord(candidate)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (hasUnsupportedKeys(candidate, FILE_KEYS)) {
      errors.push(`${label} contains unsupported fields`);
      continue;
    }

    const path = candidate.path;
    const contentSha256 = candidate.contentSha256;
    const sizeBytes = candidate.sizeBytes;
    const contentType = candidate.contentType;
    let valid = true;

    if (!isCanonicalManifestPath(path)) {
      errors.push(`${label}.path is unsafe`);
      valid = false;
    } else {
      if (paths.has(path)) {
        errors.push(`${label}.path is duplicated`);
        valid = false;
      }
      paths.add(path);
      const caseFolded = path.toLocaleLowerCase('en-US');
      if (caseFoldedPaths.has(caseFolded)) {
        errors.push(`${label}.path collides case-insensitively`);
        valid = false;
      }
      caseFoldedPaths.add(caseFolded);
    }
    if (typeof contentSha256 !== 'string' || !SHA256_HEX.test(contentSha256)) {
      errors.push(`${label}.contentSha256 must be a lowercase SHA-256 digest`);
      valid = false;
    }
    if (
      typeof sizeBytes !== 'number' ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > (policy?.maxFileBytes ?? Number.MAX_SAFE_INTEGER)
    ) {
      errors.push(`${label}.sizeBytes must be a safe non-negative integer`);
      valid = false;
    }
    if (!isCanonicalContentType(contentType)) {
      errors.push(`${label}.contentType is invalid`);
      valid = false;
    }

    if (
      valid &&
      typeof path === 'string' &&
      typeof contentSha256 === 'string' &&
      typeof sizeBytes === 'number' &&
      typeof contentType === 'string'
    ) {
      files.push({ path, contentSha256, sizeBytes, contentType });
    }
  }

  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > (policy?.maxProjectBytes ?? Number.MAX_SAFE_INTEGER)
  ) {
    errors.push('files total size exceeds the project limit');
  }
  if (errors.length > 0) return { ok: false, errors };
  files.sort(compareManifestFiles);
  return {
    ok: true,
    manifest: { schemaVersion: WORKSPACE_SYNC_MANIFEST_SCHEMA_VERSION, files },
  };
}

export function workspaceSyncManifestRequestHashInput(
  baseVersionId: string | null,
  manifest: WorkspaceSyncManifestV1
): string {
  const base = baseVersionId ?? '';
  const manifestSha256 = createHash('sha256')
    .update(workspaceSyncManifestHashInput(manifest), 'utf8')
    .digest('hex');
  return [
    'dnaforge.workspace-sync-manifest-request/v1',
    `${utf8ByteLength(base)}:${base}`,
    manifestSha256,
    '',
  ].join('\n');
}

function isCanonicalManifestPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length <= WORKSPACE_SYNC_MANIFEST_MAX_PATH_LENGTH &&
    !value.includes('\\') &&
    !containsControlCharacter(value) &&
    isSafeRelativePath(value)
  );
}

function isCanonicalContentType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= WORKSPACE_SYNC_MANIFEST_MAX_CONTENT_TYPE_LENGTH &&
    !containsControlCharacter(value)
  );
}

function compareManifestFiles(
  left: WorkspaceSyncManifestFileV1,
  right: WorkspaceSyncManifestFileV1
): number {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUnsupportedKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function invalid(error: string): WorkspaceSyncManifestParseResult {
  return { ok: false, errors: [error] };
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
