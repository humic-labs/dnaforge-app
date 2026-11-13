const CAPTURED_ATTACHMENT_PATH =
  /^\.dnaforge\/migration\/archive\/blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/;
const MIGRATION_WORKSPACE_MARKER_RELATIVE_PATH = '.dnaforge/migration/workspace.json';
const MIGRATION_WORKSPACE_MARKER_SCHEMA = 'dnaforge.benchling-migration-workspace.v1';
const MAX_MIGRATION_WORKSPACE_MARKER_BYTES = 16 * 1024;
const NATIVE_NOTEBOOK_ASSET_PATH = /(?:^|\/)assets\/[^/]+$/u;

export type CapturedMigrationWorkspaceFolder = { path: string };

export type CapturedMigrationMarkerReader = (
  path: string,
  maxBytes: number
) => Promise<{ text: string; bytesRead: number }>;

export type CapturedMigrationAttachmentReader = (
  path: string,
  maxBytes: number
) => Promise<Uint8Array>;

export type VerifiedNativeNotebookAsset = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

export function capturedMigrationAttachmentRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.normalize('NFC') !== value) return null;
  const normalized = value.replace(/\\/g, '/');
  const match = CAPTURED_ATTACHMENT_PATH.exec(normalized);
  if (!match || match[1] !== match[2].slice(0, 2)) return null;
  return normalized;
}

export function nativeNotebookAssetRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.normalize('NFC') !== value) return null;
  const normalized = value.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
    !NATIVE_NOTEBOOK_ASSET_PATH.test(normalized) ||
    hasAsciiControlCharacter(normalized)
  ) {
    return null;
  }
  return normalized;
}

export async function readNativeNotebookAsset(input: {
  relativePath: unknown;
  notebookPackagePath: unknown;
  currentNotebookPackage?: Readonly<{
    relativePath: unknown;
    owningRoot: unknown;
  }>;
  folders: readonly CapturedMigrationWorkspaceFolder[];
  maxBytes: number;
  exists: (path: string) => Promise<boolean>;
  readFileBounded: CapturedMigrationAttachmentReader;
}): Promise<VerifiedNativeNotebookAsset> {
  const relativePath = nativeNotebookAssetRelativePath(input.relativePath);
  if (!relativePath) throw new Error('Notebook asset path is invalid');
  const notebookPackagePath = nativeNotebookPackageRelativePath(input.notebookPackagePath);
  if (!notebookPackagePath) throw new Error('Notebook package path is invalid');

  if (input.currentNotebookPackage) {
    const currentPackagePath = nativeNotebookPackageRelativePath(
      input.currentNotebookPackage.relativePath
    );
    const currentRoot = normalizeWorkspaceRoot(input.currentNotebookPackage.owningRoot);
    if (!currentPackagePath || !currentRoot) {
      throw new Error('Current notebook package location is invalid');
    }
    const currentAssetPath = `${currentRoot}/${currentPackagePath}/${relativePath}`;
    if (await input.exists(currentAssetPath).catch(() => false)) {
      const bytes = await input.readFileBounded(currentAssetPath, input.maxBytes);
      assertCapturedMigrationAttachmentReadSize(bytes, input.maxBytes);
      return { path: currentAssetPath, bytes };
    }
  }

  const candidates: string[] = [];
  const visitedRoots = new Set<string>();
  for (const folder of input.folders) {
    const root = normalizeWorkspaceRoot(folder?.path);
    if (!root || visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    const path = `${root}/${notebookPackagePath}/${relativePath}`;
    if (await input.exists(path).catch(() => false)) candidates.push(path);
  }
  if (candidates.length === 0) throw new Error('Notebook asset is unavailable');
  if (candidates.length !== 1) throw new Error('Notebook asset project is ambiguous');
  const path = candidates[0];
  const bytes = await input.readFileBounded(path, input.maxBytes);
  assertCapturedMigrationAttachmentReadSize(bytes, input.maxBytes);
  return { path, bytes };
}

function nativeNotebookPackageRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.normalize('NFC') !== value) return null;
  const normalized = value.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
    hasAsciiControlCharacter(normalized)
  ) {
    return null;
  }
  return normalized;
}

export async function resolveCapturedMigrationAttachmentPath(input: {
  relativePath: unknown;
  migrationRunId: unknown;
  folders: readonly CapturedMigrationWorkspaceFolder[];
  readMarker: CapturedMigrationMarkerReader;
}): Promise<string> {
  const relativePath = capturedMigrationAttachmentRelativePath(input.relativePath);
  if (!relativePath) throw new Error('Captured attachment path is invalid');
  const migrationRunId = validMigrationRunId(input.migrationRunId);
  if (!migrationRunId) throw new Error('Captured attachment migration identity is unavailable');

  const matchingRoots: string[] = [];
  const visitedRoots = new Set<string>();
  for (const folder of input.folders) {
    const root = normalizeWorkspaceRoot(folder?.path);
    if (!root || visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    try {
      const result = await input.readMarker(
        `${root}/${MIGRATION_WORKSPACE_MARKER_RELATIVE_PATH}`,
        MAX_MIGRATION_WORKSPACE_MARKER_BYTES + 1
      );
      if (
        !Number.isSafeInteger(result.bytesRead) ||
        result.bytesRead < 0 ||
        result.bytesRead > MAX_MIGRATION_WORKSPACE_MARKER_BYTES ||
        new TextEncoder().encode(result.text).byteLength > MAX_MIGRATION_WORKSPACE_MARKER_BYTES
      ) {
        continue;
      }
      const marker = JSON.parse(result.text) as unknown;
      if (
        isRecord(marker) &&
        marker.schema === MIGRATION_WORKSPACE_MARKER_SCHEMA &&
        marker.status === 'unlocked' &&
        marker.runId === migrationRunId &&
        typeof marker.workspaceId === 'string' &&
        marker.workspaceId.length > 0
      ) {
        matchingRoots.push(root);
      }
    } catch {}
  }

  if (matchingRoots.length === 0) {
    throw new Error('Captured attachment migration project is unavailable');
  }
  if (matchingRoots.length !== 1) {
    throw new Error('Captured attachment migration project is ambiguous');
  }
  return `${matchingRoots[0]}/${relativePath}`;
}

export function assertCapturedMigrationAttachmentReadSize(
  bytes: Uint8Array,
  maxBytes: number
): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Captured attachment byte limit is invalid');
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error('Captured attachment is too large for bounded in-app verification');
  }
}

export async function readVerifiedCapturedMigrationAttachment(input: {
  path: string;
  expectedSha256: string;
  maxBytes: number;
  readFileBounded: CapturedMigrationAttachmentReader;
}): Promise<Uint8Array> {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
    throw new Error('Captured attachment SHA-256 is invalid');
  }
  const bytes = await input.readFileBounded(input.path, input.maxBytes);
  assertCapturedMigrationAttachmentReadSize(bytes, input.maxBytes);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  if (sha256 !== input.expectedSha256) {
    throw new Error('Captured attachment failed SHA-256 verification');
  }
  return bytes;
}

function validMigrationRunId(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.normalize('NFC') !== value ||
    hasAsciiControlCharacter(value)
  ) {
    return null;
  }
  return value;
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function normalizeWorkspaceRoot(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return null;
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '');
  if (!normalized || (!normalized.startsWith('/') && !/^[A-Za-z]:\//u.test(normalized))) {
    return null;
  }
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
