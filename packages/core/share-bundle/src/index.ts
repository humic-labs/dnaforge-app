import { createHash } from 'node:crypto';
import {
  DEFAULT_SHARE_BUNDLE_LIMITS,
  isSafeRelativePath,
  workspaceSyncSensitivePathExclusion,
  type ShareBundleLimits,
} from './shared';
import {
  WORKSPACE_SYNC_MANIFEST_READ_LIMITS,
  workspaceSyncManifestHashInput,
  WORKSPACE_SYNC_MANIFEST_MAX_BLOB_BYTES,
  WORKSPACE_SYNC_MANIFEST_MAX_FILES,
} from './workspace-sync-manifest';
import {
  MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION,
  isPortableSequencePackageHistory,
} from './sequence-package-admission';

export * from './deep-share';
export * from './desktop-sync-claim';
export * from './workspace-sync-manifest';
export * from './sequence-package-admission';
export * from './workspace-sync-storage-policy';
export * from './workspace-sync-publication-policy';
export { BUNDLE_SCHEMA_CAPABILITY_HEADER, WORKSPACE_SYNC_BUNDLE_SCHEMA_VERSION } from './protocol';
export {
  DEFAULT_SHARE_BUNDLE_LIMITS,
  isSafeRelativePath,
  workspaceSyncSensitivePathExclusion,
  type ShareBundleLimits,
} from './shared';

export const SHARE_BUNDLE_SCHEMA_VERSION = 2;

export const DESKTOP_SYNC_HOSTED_PLATFORM_BODY_MAX_BYTES = 4_500_000;
export const DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES = 4 * 1024 * 1024;
export const DESKTOP_SYNC_LATEST_JSON_MAX_BYTES = DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES + 256 * 1024;

export const DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,
  maxBundleBytes: 256 * 1024 * 1024,
  maxFiles: 2000,
} as const;

export const DEFAULT_WORKSPACE_SYNC_MANIFEST_LIMITS = {
  maxFileBytes: WORKSPACE_SYNC_MANIFEST_MAX_BLOB_BYTES,
  maxBundleBytes: WORKSPACE_SYNC_MANIFEST_MAX_BLOB_BYTES,
  maxFiles: WORKSPACE_SYNC_MANIFEST_MAX_FILES,
} as const;

export const WORKSPACE_SYNC_BUNDLE_V1_READ_LIMITS = DEFAULT_SHARE_BUNDLE_LIMITS;

export const DEFAULT_WORKSPACE_SYNC_ENCODED_BUNDLE_MAX_BYTES = 384 * 1024 * 1024;

export function workspaceSyncUploadWireBytes(
  baseVersionId: string | null,
  bundle: WorkspaceSyncBundle
): number {
  return Buffer.byteLength(JSON.stringify({ baseVersionId, bundle }), 'utf8');
}

export function resolveShareBundleLimits(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): ShareBundleLimits {
  return resolveBundleLimits(env, DEFAULT_SHARE_BUNDLE_LIMITS);
}

export function resolveWorkspaceSyncBundleLimits(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): ShareBundleLimits {
  return resolveBoundedBundleLimits(env, DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS);
}

export function resolveWorkspaceSyncManifestLimits(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): ShareBundleLimits {
  return resolveBoundedBundleLimits(env, DEFAULT_WORKSPACE_SYNC_MANIFEST_LIMITS);
}

function resolveBoundedBundleLimits(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  defaults: ShareBundleLimits
): ShareBundleLimits {
  const resolved = resolveBundleLimits(env, defaults);
  return {
    maxFileBytes: Math.min(resolved.maxFileBytes, defaults.maxFileBytes),
    maxBundleBytes: Math.min(resolved.maxBundleBytes, defaults.maxBundleBytes),
    maxFiles: Math.min(resolved.maxFiles, defaults.maxFiles),
  };
}

export function resolveWorkspaceSyncEncodedBundleMaxBytes(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): number {
  return Math.min(
    readPositiveInt(
      env.DNAFORGE_SYNC_MAX_ENCODED_BUNDLE_BYTES,
      DEFAULT_WORKSPACE_SYNC_ENCODED_BUNDLE_MAX_BYTES
    ),
    DEFAULT_WORKSPACE_SYNC_ENCODED_BUNDLE_MAX_BYTES
  );
}

function resolveBundleLimits(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  defaults: ShareBundleLimits
): ShareBundleLimits {
  return {
    maxFileBytes: readPositiveInt(env.DNAFORGE_SYNC_MAX_FILE_BYTES, defaults.maxFileBytes),
    maxBundleBytes: readPositiveInt(env.DNAFORGE_SYNC_MAX_BUNDLE_BYTES, defaults.maxBundleBytes),
    maxFiles: readPositiveInt(env.DNAFORGE_SYNC_MAX_FILES, defaults.maxFiles),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type SharedDesignFileKind =
  | 'molecular-document'
  | 'structure'
  | 'genbank'
  | 'fasta'
  | 'notebook'
  | 'design'
  | 'assembly-sidecar'
  | 'primer-table'
  | 'native-workspace-manifest'
  | 'lims-audit-log'
  | 'lims-sheet'
  | 'lims-manifest';

export type ShareBundleExcludedReason =
  | 'unsupported'
  | 'private-raw-data'
  | 'reference-pointer'
  | 'file-too-large'
  | 'bundle-too-large';

export type WorkspaceSyncFileKind = SharedDesignFileKind | 'workspace-resource';

const WORKSPACE_RESOURCE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

export function workspaceSyncResourceMediaType(relativePath: string): string | null {
  if (
    isSafeRelativePath(relativePath) &&
    !hasReservedWindowsName(relativePath) &&
    relativePath.split('/').at(-1) === '.gitignore' &&
    relativePath
      .split('/')
      .slice(0, -1)
      .every((part) => part.toLowerCase() !== '.git')
  ) {
    return 'text/plain';
  }
  if (
    !isSafeRelativePath(relativePath) ||
    hasReservedWindowsName(relativePath) ||
    relativePath.split('/').some((part) => part.startsWith('.'))
  ) {
    return null;
  }
  return WORKSPACE_RESOURCE_MEDIA_TYPES[extensionFor(relativePath.toLowerCase())] ?? null;
}
export type WorkspaceSyncExcludedReason = ShareBundleExcludedReason;

export interface ShareBundleFile {
  id: string;
  relativePath: string;
  name: string;
  kind: SharedDesignFileKind;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  content: string;
  encoding?: 'base64';
}

export interface ShareBundleExcludedFile {
  relativePath: string;
  reason: ShareBundleExcludedReason;
  sizeBytes: number | null;
}

interface ShareBundleBase {
  capturedAt: string;
  workspace: {
    id: string;
    name: string;
  };
  files: ShareBundleFile[];
  excludedFiles: ShareBundleExcludedFile[];
  limits: ShareBundleLimits;
  provenance: {
    source: 'dnaforge-desktop';
    appVersion: string;
    contentSha256: string;
  };
}

export interface ShareBundleV1 extends ShareBundleBase {
  schemaVersion: 1;
}

export interface ShareBundleV2 extends ShareBundleBase {
  schemaVersion: 2;
}

export type ShareBundle = ShareBundleV1 | ShareBundleV2;

export interface WorkspaceSyncFile {
  id: string;
  relativePath: string;
  name: string;
  kind: WorkspaceSyncFileKind;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  content: string;
  encoding?: 'base64' | 'blob';
}

export function decodeBundleFileContent(file: {
  content: string;
  encoding?: 'base64' | 'blob';
}): Uint8Array {
  if (file.encoding === 'blob')
    throw new Error('Blob-backed file bytes must be read from verified local storage.');
  if (file.encoding === undefined) return Buffer.from(file.content, 'utf8');
  if (
    file.encoding !== 'base64' ||
    file.content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)
  ) {
    throw new Error('Bundle file has invalid base64 content.');
  }
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.toString('base64') !== file.content) {
    throw new Error('Bundle file base64 content is not canonical.');
  }
  return bytes;
}

export function bundleFileContentSha256(file: {
  content: string;
  encoding?: 'base64' | 'blob';
}): string {
  return createHash('sha256').update(decodeBundleFileContent(file)).digest('hex');
}

export type WorkspaceSyncExcludedSummary = Record<
  WorkspaceSyncExcludedReason,
  { count: number; bytesApprox: number | null }
>;

export interface WorkspaceSyncBundleV1 {
  schemaVersion: 1;
  capturedAt: string;
  workspace: {
    id: string;
    name: string;
  };
  files: WorkspaceSyncFile[];
  excludedSummary: WorkspaceSyncExcludedSummary;
  limits: ShareBundleLimits;
  provenance: {
    source: 'dnaforge-desktop';
    appVersion: string;
    contentSha256: string;
  };
}

export interface WorkspaceSyncBundleV2 extends Omit<WorkspaceSyncBundleV1, 'schemaVersion'> {
  schemaVersion: 2;
}

export interface WorkspaceSyncBundleV3 extends Omit<WorkspaceSyncBundleV1, 'schemaVersion'> {
  schemaVersion: 3;
}

export type WorkspaceSyncBundle =
  | WorkspaceSyncBundleV1
  | WorkspaceSyncBundleV2
  | WorkspaceSyncBundleV3;

export type WorkspaceSyncUploadAdmissionResult =
  | { ok: true; rawContentBytes: number; encodedBundleBytes: number }
  | {
      ok: false;
      errors: string[];
      rawContentBytes: number;
      encodedBundleBytes: number;
    };

export type NewBundleFilePolicyResult =
  | { ok: true }
  | {
      ok: false;
      errors: string[];
    };

export interface NewBundleFileCandidate {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly content?: unknown;
  readonly encoding?: unknown;
}

export interface NewBundleFileCandidateClassification {
  readonly relativePath: string;
  readonly classification: ShareFileClassification;
  readonly atomicSequencePackageRoot?: string;
}

export type NewBundleFileCandidatePolicyResult =
  | { ok: true; files: NewBundleFileCandidateClassification[] }
  | {
      ok: false;
      files: NewBundleFileCandidateClassification[];
      errors: string[];
    };

export type ShareFileClassification =
  | {
      action: 'include';
      kind: SharedDesignFileKind;
      contentType: string;
      reason?: undefined;
    }
  | {
      action: 'exclude';
      reason: ShareBundleExcludedReason;
      kind?: undefined;
      contentType?: undefined;
    };

const GENBANK_EXTENSIONS = new Set(['.gb', '.gbk', '.gbff', '.genbank']);

export function classifyShareFile(
  relativePath: string,
  sizeBytes: number,
  limits: ShareBundleLimits = DEFAULT_SHARE_BUNDLE_LIMITS
): ShareFileClassification {
  const lower = relativePath.toLowerCase();
  const extension = extensionFor(lower);

  const sensitive = workspaceSyncSensitivePathExclusion(relativePath);
  if (sensitive) return { action: 'exclude', reason: sensitive };
  if (sizeBytes > limits.maxFileBytes) {
    return { action: 'exclude', reason: 'file-too-large' };
  }

  const limsClassification = classifyLimsSyncExportPath(lower);
  if (limsClassification) {
    return limsClassification;
  }
  if (lower === '.dnaforge/native-workspace.json' || lower === '.forge/catalog.json') {
    return {
      action: 'include',
      kind: 'native-workspace-manifest',
      contentType: 'application/json',
    };
  }

  const notebookPackageClassification = classifyNotebookPackageMemberPath(lower);
  if (notebookPackageClassification) {
    if (sizeBytes > limits.maxFileBytes) {
      return { action: 'exclude', reason: 'file-too-large' };
    }
    return notebookPackageClassification;
  }

  const plasmidPackageClassification = classifySequencePackageMemberPath(lower);
  if (plasmidPackageClassification) {
    if (sizeBytes > limits.maxFileBytes) {
      return { action: 'exclude', reason: 'file-too-large' };
    }
    return plasmidPackageClassification;
  }

  if (lower.endsWith('.wpnote.json')) {
    return { action: 'include', kind: 'notebook', contentType: 'application/json' };
  }
  if (lower.endsWith('.dnaforge-molecular.json')) {
    return { action: 'include', kind: 'molecular-document', contentType: 'application/json' };
  }
  if (['.pdb', '.cif', '.mmcif', '.bcif'].includes(extension)) {
    return {
      action: 'include',
      kind: 'structure',
      contentType: extension === '.bcif' ? 'application/octet-stream' : 'text/plain',
    };
  }
  if (lower.endsWith('.wpdesign.json')) {
    return { action: 'include', kind: 'design', contentType: 'application/json' };
  }
  if (lower.endsWith('.waypoint-assembly.json')) {
    return { action: 'include', kind: 'assembly-sidecar', contentType: 'application/json' };
  }
  if (lower.endsWith('.primers.csv')) {
    return { action: 'include', kind: 'primer-table', contentType: 'text/csv' };
  }
  if (lower.endsWith('.primers.fasta') || lower.endsWith('.primers.fa')) {
    return { action: 'include', kind: 'primer-table', contentType: 'text/plain' };
  }
  if (GENBANK_EXTENSIONS.has(extension)) {
    return { action: 'include', kind: 'genbank', contentType: 'text/plain' };
  }
  if (['.fa', '.fasta', '.fas', '.fna', '.ffn', '.faa'].includes(extension)) {
    return { action: 'include', kind: 'fasta', contentType: 'text/plain' };
  }
  return { action: 'exclude', reason: 'unsupported' };
}

export function classifyShareFileForNewBundle(
  relativePath: string,
  sizeBytes: number,
  limits: ShareBundleLimits = DEFAULT_SHARE_BUNDLE_LIMITS
): ShareFileClassification {
  const normalizedPath = relativePath.normalize('NFC').replace(/\\/gu, '/');
  const leafName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  if (
    normalizedPath.toLowerCase().startsWith('.dnaforge/migration/') ||
    /^\..+\.[a-z0-9-]+\.dnaforge-migration\.tmp$/iu.test(leafName)
  ) {
    return { action: 'exclude', reason: 'unsupported' };
  }
  const classification = classifyShareFile(relativePath, sizeBytes, limits);
  if (classification.action === 'include' && classification.kind.startsWith('lims-')) {
    return { action: 'exclude', reason: 'unsupported' };
  }
  return classification;
}

export function validateNewBundleFilePolicy(
  bundle: Pick<ShareBundle | WorkspaceSyncBundle, 'files'> & { schemaVersion?: number },
  limits: ShareBundleLimits = DEFAULT_SHARE_BUNDLE_LIMITS
): NewBundleFilePolicyResult {
  const candidatePolicy = classifyNewBundleFileCandidates(bundle.files, limits);
  const errors: string[] = candidatePolicy.ok ? [] : [...candidatePolicy.errors];
  for (const [index, file] of bundle.files.entries()) {
    const newBundleClassification = candidatePolicy.files[index]!.classification;
    if (
      bundle.schemaVersion === 3 &&
      newBundleClassification.action === 'exclude' &&
      newBundleClassification.reason === 'unsupported' &&
      file.kind === 'workspace-resource' &&
      workspaceSyncResourceMediaType(file.relativePath) === file.contentType
    )
      continue;
    if (newBundleClassification.action === 'exclude') {
      if (
        newBundleClassification.reason === 'file-too-large' ||
        newBundleClassification.reason === 'bundle-too-large'
      ) {
        continue;
      }
      errors.push(
        `files[${index}].relativePath is excluded from new bundles (${newBundleClassification.reason})`
      );
      continue;
    }
    if (file.kind !== newBundleClassification.kind) {
      errors.push(`files[${index}].kind does not match new-bundle policy`);
    }
    if (file.contentType !== newBundleClassification.contentType) {
      errors.push(`files[${index}].contentType does not match new-bundle policy`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function classifyNewBundleFileCandidates(
  files: readonly NewBundleFileCandidate[],
  limits: ShareBundleLimits = DEFAULT_SHARE_BUNDLE_LIMITS
): NewBundleFileCandidatePolicyResult {
  const sequencePackages = discoverSequencePackageAuthorities(files);
  const notebookRoots = validatedNotebookRootsFromFiles(files);
  const classified = files.map((file) => {
    const classification = classifyBundleFile(
      file.relativePath,
      file.sizeBytes,
      notebookRoots,
      sequencePackages.declaredMemberPaths,
      limits
    );
    const newBundleClassification =
      classification.action === 'include' && classification.kind.startsWith('lims-')
        ? ({ action: 'exclude', reason: 'unsupported' } as const)
        : classification;
    const normalizedPath = normalizeRelativePath(file.relativePath);
    const atomicSequencePackageRoot = normalizedPath
      ? sequencePackages.packageRootsByPath.get(normalizedPath)
      : undefined;
    return {
      relativePath: file.relativePath,
      classification: newBundleClassification,
      ...(atomicSequencePackageRoot ? { atomicSequencePackageRoot } : {}),
    };
  });
  return sequencePackages.errors.length > 0
    ? { ok: false, files: classified, errors: sequencePackages.errors }
    : { ok: true, files: classified };
}

export function bundleContainsLegacyLimsExport(
  bundle: Pick<ShareBundle | WorkspaceSyncBundle, 'files'>
): boolean {
  return bundle.files.some(
    (file) => classifyLimsSyncExportPath(file.relativePath.toLowerCase()) !== null
  );
}

export function classifyLimsSyncExportPath(
  relativePathLower: string
): ShareFileClassification | null {
  const marker = '.waypoint/lims/';
  const idx = relativePathLower.indexOf(marker);
  if (idx < 0) return null;
  if (idx > 0 && relativePathLower[idx - 1] !== '/') return null;

  const rest = relativePathLower.slice(idx + marker.length);
  if (rest === 'manifest.json') {
    return { action: 'include', kind: 'lims-manifest', contentType: 'application/json' };
  }
  if (rest.startsWith('log/') && rest.endsWith('.jsonl')) {
    const name = rest.slice('log/'.length);
    if (name.length > 0 && !name.includes('/')) {
      return { action: 'include', kind: 'lims-audit-log', contentType: 'application/x-ndjson' };
    }
  }
  if (rest.startsWith('sheets/') && rest.endsWith('.csv')) {
    const name = rest.slice('sheets/'.length);
    if (name.length > 0 && !name.includes('/')) {
      return { action: 'include', kind: 'lims-sheet', contentType: 'text/csv' };
    }
  }
  return null;
}

export function classifyNotebookPackageMemberPath(
  relativePathLower: string
): ShareFileClassification | null {
  const parts = relativePathLower.split('/');
  if (parts.length < 2) return null;

  if (
    parts.length >= 3 &&
    parts[parts.length - 2] === '.forge' &&
    parts[parts.length - 1] === 'notebook.json'
  ) {
    return { action: 'include', kind: 'notebook', contentType: 'application/json' };
  }

  const forgeIndex = parts.lastIndexOf('.forge');
  if (
    forgeIndex >= 1 &&
    forgeIndex < parts.length - 2 &&
    (parts[forgeIndex + 1] === 'blocks' || parts[forgeIndex + 1] === 'migrations') &&
    parts[parts.length - 1].endsWith('.json')
  ) {
    return { action: 'include', kind: 'notebook', contentType: 'application/json' };
  }

  if (parts.length >= 2 && parts[parts.length - 1].endsWith('.md')) {
    const fileName = parts[parts.length - 1];
    const parentName = parts[parts.length - 2];
    if (fileName === `${parentName}.md`) {
      return { action: 'include', kind: 'notebook', contentType: 'text/markdown' };
    }
  }

  return null;
}

export function classifyValidatedNotebookAssetPath(
  relativePath: string,
  packageRoot: string,
  sizeBytes: number,
  limits: ShareBundleLimits = DEFAULT_SHARE_BUNDLE_LIMITS
): ShareFileClassification {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedRoot = normalizeRelativePath(packageRoot);
  if (
    !normalizedPath ||
    !normalizedRoot ||
    !normalizedPath.startsWith(`${normalizedRoot}/assets/`)
  ) {
    return { action: 'exclude', reason: 'unsupported' };
  }
  const sensitive = workspaceSyncSensitivePathExclusion(relativePath);
  if (sensitive) return { action: 'exclude', reason: sensitive };
  if (sizeBytes > limits.maxFileBytes) {
    return { action: 'exclude', reason: 'file-too-large' };
  }
  return { action: 'include', kind: 'notebook', contentType: 'application/octet-stream' };
}

function validatedNotebookRootsFromFiles(
  files: readonly { relativePath?: unknown; content?: unknown; encoding?: unknown }[]
): Set<string> {
  const roots = new Set<string>();
  for (const file of files) {
    if (
      typeof file.relativePath !== 'string' ||
      typeof file.content !== 'string' ||
      file.encoding !== undefined
    ) {
      continue;
    }
    const normalizedPath = normalizeRelativePath(file.relativePath);
    const markerSuffix = '/.forge/notebook.json';
    if (!normalizedPath?.endsWith(markerSuffix)) continue;
    const root = normalizedPath.slice(0, -markerSuffix.length);
    const rootSegments = root.split('/');
    const stem = rootSegments[rootSegments.length - 1];
    if (!stem) continue;
    try {
      const metadata = JSON.parse(file.content) as Record<string, unknown>;
      const authority = metadata.authority;
      const payloads = metadata.payloads;
      if (
        metadata.schema === 'waypoint.notebook.v1' &&
        metadata.kind === 'notebook' &&
        metadata.formatVersion === 2 &&
        authority &&
        typeof authority === 'object' &&
        !Array.isArray(authority) &&
        (authority as Record<string, unknown>).type === 'markdown' &&
        (authority as Record<string, unknown>).path === `${stem}.md` &&
        (authority as Record<string, unknown>).codec === 'dnaforge.notebook-markdown.v1' &&
        payloads &&
        typeof payloads === 'object' &&
        !Array.isArray(payloads) &&
        (payloads as Record<string, unknown>).blocksDirectory === 'blocks' &&
        (payloads as Record<string, unknown>).schema === 'waypoint.notebook.block.v1'
      ) {
        roots.add(root);
      }
    } catch {}
  }
  return roots;
}

function classifyBundleFile(
  relativePath: string,
  sizeBytes: number,
  notebookRoots: ReadonlySet<string>,
  sequencePackageMemberPaths: ReadonlySet<string>,
  limits: ShareBundleLimits = DEFAULT_SHARE_BUNDLE_LIMITS
): ShareFileClassification {
  const ordinary = classifyShareFile(relativePath, sizeBytes, limits);
  if (ordinary.action === 'include' || ordinary.reason !== 'unsupported') return ordinary;
  for (const packageRoot of notebookRoots) {
    const asset = classifyValidatedNotebookAssetPath(relativePath, packageRoot, sizeBytes, limits);
    if (asset.action === 'include' || asset.reason !== 'unsupported') return asset;
  }
  if (sequencePackageMemberPaths.has(relativePath)) {
    return {
      action: 'include',
      kind: 'assembly-sidecar',
      contentType: 'application/octet-stream',
    };
  }
  return ordinary;
}

interface SequencePackageAuthorityDiscovery {
  declaredMemberPaths: Set<string>;
  packageRootsByPath: Map<string, string>;
  errors: string[];
}

function discoverSequencePackageAuthorities(
  files: readonly { relativePath?: unknown; content?: unknown; encoding?: unknown }[]
): SequencePackageAuthorityDiscovery {
  const normalizedFilePaths = new Set<string>();
  for (const file of files) {
    if (typeof file.relativePath !== 'string') continue;
    const normalized = normalizeRelativePath(file.relativePath);
    if (normalized) normalizedFilePaths.add(normalized);
  }

  const declaredMemberPaths = new Set<string>();
  const packageRootsByPath = new Map<string, string>();
  const packageRootsByStableId = new Map<string, string>();
  const errors: string[] = [];
  for (const file of files) {
    if (typeof file.relativePath !== 'string') continue;
    const markerPath = normalizeRelativePath(file.relativePath);
    if (!markerPath) continue;
    const parts = markerPath.split('/');
    if (
      parts.length < 3 ||
      parts[parts.length - 2]?.toLowerCase() !== '.forge' ||
      parts[parts.length - 1]?.toLowerCase() !== 'plasmid.json'
    ) {
      continue;
    }
    const packageRoot = parts.slice(0, -2).join('/');
    const authority = parsePortableSequencePackageAuthority(file, packageRoot);
    if (authority.kind === 'unsupported') {
      errors.push(`sequence package ${packageRoot} has unsupported authoritative state`);
      continue;
    }
    if (authority.kind === 'legacy') continue;
    const existingRoot = packageRootsByStableId.get(authority.stableId);
    if (existingRoot && existingRoot !== packageRoot) {
      errors.push(
        `sequence package ${packageRoot} duplicates stable id ${authority.stableId} from ${existingRoot}`
      );
    } else {
      packageRootsByStableId.set(authority.stableId, packageRoot);
    }
    for (const requiredPath of authority.requiredPaths) {
      if (!normalizedFilePaths.has(requiredPath)) {
        errors.push(`sequence package ${packageRoot} is incomplete: missing ${requiredPath}`);
      }
      packageRootsByPath.set(requiredPath, packageRoot);
    }
    for (const memberPath of authority.declaredMemberPaths) {
      declaredMemberPaths.add(memberPath);
    }
  }
  return { declaredMemberPaths, packageRootsByPath, errors };
}

type PortableSequencePackageAuthority =
  | {
      kind: 'supported';
      stableId: string;
      requiredPaths: Set<string>;
      declaredMemberPaths: Set<string>;
    }
  | { kind: 'legacy' }
  | { kind: 'unsupported' };

function parsePortableSequencePackageAuthority(
  file: { content?: unknown; encoding?: unknown },
  packageRoot: string
): PortableSequencePackageAuthority {
  if (typeof file.content !== 'string' || file.encoding !== undefined) {
    return { kind: 'unsupported' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return { kind: 'unsupported' };
  }
  if (!isPlainRecord(parsed)) return { kind: 'unsupported' };
  if (
    !['waypoint.sequence.v1', 'waypoint.plasmid.v1'].includes(
      typeof parsed.schema === 'string' ? parsed.schema : ''
    ) ||
    !['sequence', 'plasmid'].includes(typeof parsed.kind === 'string' ? parsed.kind : '') ||
    typeof parsed.id !== 'string' ||
    !parsed.id.trim() ||
    !isPlainRecord(parsed.product)
  ) {
    return { kind: 'unsupported' };
  }

  const productFile = portablePackageProductFile(parsed.product.file);
  if (!productFile) return { kind: 'unsupported' };
  const formatVersion = parsed.formatVersion === undefined ? 1 : parsed.formatVersion;
  if (
    typeof formatVersion !== 'number' ||
    !Number.isInteger(formatVersion) ||
    formatVersion < 1 ||
    formatVersion > MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION
  ) {
    return { kind: 'unsupported' };
  }
  if (formatVersion < 4) return { kind: 'legacy' };
  if (!Array.isArray(parsed.members)) return { kind: 'unsupported' };

  const requiredPaths = new Set<string>([
    `${packageRoot}/.forge/plasmid.json`,
    `${packageRoot}/${productFile}`,
  ]);
  const declaredMemberPaths = new Set<string>();
  const declaredMemberIds = new Set<string>();
  const memberByPath = new Map<string, Record<string, unknown>>();
  for (const member of parsed.members) {
    if (
      !isPlainRecord(member) ||
      typeof member.id !== 'string' ||
      !member.id.trim() ||
      typeof member.role !== 'string' ||
      !member.role.trim() ||
      typeof member.path !== 'string'
    ) {
      return { kind: 'unsupported' };
    }
    const memberId = member.id.trim();
    if (declaredMemberIds.has(memberId)) return { kind: 'unsupported' };
    declaredMemberIds.add(memberId);
    const memberPath = normalizeRelativePath(member.path);
    if (!memberPath?.startsWith('contents/') || memberPath === 'contents/') {
      return { kind: 'unsupported' };
    }
    const portablePath = `${packageRoot}/${memberPath}`;
    if (requiredPaths.has(portablePath)) return { kind: 'unsupported' };
    requiredPaths.add(portablePath);
    declaredMemberPaths.add(portablePath);
    memberByPath.set(memberPath, member);
  }
  if (!isPortableSequencePackageHistory(parsed, formatVersion, memberByPath)) {
    return { kind: 'unsupported' };
  }
  return {
    kind: 'supported',
    stableId: parsed.id.trim(),
    requiredPaths,
    declaredMemberPaths,
  };
}

function portablePackageProductFile(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.includes('/') || value.includes('\\')) {
    return null;
  }
  if (!isSafeRelativePath(value) || !GENBANK_EXTENSIONS.has(extensionFor(value.toLowerCase()))) {
    return null;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function classifySequencePackageMemberPath(
  relativePathLower: string
): ShareFileClassification | null {
  const parts = relativePathLower.split('/');
  if (
    parts.length >= 3 &&
    parts[parts.length - 2] === '.forge' &&
    parts[parts.length - 1] === 'plasmid.json'
  ) {
    return { action: 'include', kind: 'assembly-sidecar', contentType: 'application/json' };
  }
  const fileName = parts[parts.length - 1] ?? '';
  if (fileName.endsWith('.gb.waypoint.json') || fileName.endsWith('.gbk.waypoint.json')) {
    return { action: 'include', kind: 'assembly-sidecar', contentType: 'application/json' };
  }
  return null;
}

export function shareBundleHashInput(bundle: ShareBundle): string {
  return JSON.stringify({
    ...bundle,
    provenance: { ...bundle.provenance, contentSha256: '' },
  });
}

export function workspaceSyncBundleHashInput(bundle: WorkspaceSyncBundle): string {
  if (bundle.schemaVersion === 3)
    return workspaceSyncManifestHashInput({
      schemaVersion: 1,
      files: bundle.files.map((file) => ({
        path: file.relativePath,
        contentSha256: file.sha256,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
      })),
    });
  return stableJsonStringify({
    ...bundle,
    capturedAt: '',
    provenance: { ...bundle.provenance, contentSha256: '' },
  });
}

export function workspaceSyncVersionRequestHashInput(
  baseVersionId: string | null,
  bundle: WorkspaceSyncBundle
): string {
  return stableJsonStringify({
    baseVersionId,
    bundle: {
      ...bundle,
      capturedAt: '',
      provenance: { ...bundle.provenance, contentSha256: '' },
    },
  });
}

function collectShareBundleFileErrors(bundle: Partial<ShareBundle>, errors: string[]): void {
  if (!Array.isArray(bundle.files)) {
    errors.push('files must be an array');
    return;
  }
  if (bundle.files.length > (bundle.limits?.maxFiles ?? DEFAULT_SHARE_BUNDLE_LIMITS.maxFiles)) {
    errors.push(
      `files must contain at most ${bundle.limits?.maxFiles ?? DEFAULT_SHARE_BUNDLE_LIMITS.maxFiles} entries`
    );
    return;
  }
  const maxFileBytes = bundle.limits?.maxFileBytes ?? DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes;
  const normalizedPaths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  for (const [index, file] of bundle.files.entries()) {
    if (!file || typeof file !== 'object') {
      errors.push(`files[${index}] must be an object`);
      continue;
    }
    if (!isSafeRelativePath(file.relativePath)) {
      errors.push(`files[${index}].relativePath is unsafe`);
    } else {
      const normalizedPath = normalizeRelativePath(file.relativePath);
      if (normalizedPath) {
        if (normalizedPaths.has(normalizedPath)) {
          errors.push(`files[${index}].relativePath is duplicated`);
        }
        normalizedPaths.add(normalizedPath);
        const caseFolded = normalizedPath.toLocaleLowerCase('en-US');
        if (caseFoldedPaths.has(caseFolded)) {
          errors.push(`files[${index}].relativePath collides case-insensitively`);
        }
        caseFoldedPaths.add(caseFolded);
      }
    }
    if (typeof file.content !== 'string') errors.push(`files[${index}].content must be a string`);
    if (bundle.schemaVersion === 1 && file.encoding !== undefined) {
      errors.push(`files[${index}].encoding is not allowed in schemaVersion 1`);
    } else if (file.encoding !== undefined && file.encoding !== 'base64') {
      errors.push(`files[${index}].encoding must be base64 when present`);
    }
    let bytes: Uint8Array | null = null;
    if (typeof file.content === 'string') {
      try {
        bytes = decodeBundleFileContent(file);
      } catch {
        errors.push(`files[${index}].content is not valid for its encoding`);
      }
    }
    if (typeof file.sizeBytes !== 'number' || file.sizeBytes < 0) {
      errors.push(`files[${index}].sizeBytes must be non-negative`);
    } else if (bytes && file.sizeBytes !== bytes.byteLength) {
      errors.push(`files[${index}].sizeBytes does not match decoded content length`);
    } else if (file.sizeBytes > maxFileBytes) {
      errors.push(`files[${index}].sizeBytes exceeds the per-file limit`);
    }
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
      errors.push(`files[${index}].sha256 must be a sha256 hex digest`);
    } else if (bytes && file.sha256.toLowerCase() !== bundleFileContentSha256(file)) {
      errors.push(`files[${index}].sha256 does not match decoded content`);
    }
  }
}

export function validateShareBundle(
  value: unknown
): { ok: true; bundle: ShareBundle } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['bundle must be an object'] };
  }
  const bundle = value as Partial<ShareBundle>;
  if (bundle.schemaVersion !== 1 && bundle.schemaVersion !== SHARE_BUNDLE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be 1 or ${SHARE_BUNDLE_SCHEMA_VERSION}`);
  }
  if (typeof bundle.capturedAt !== 'string' || Number.isNaN(Date.parse(bundle.capturedAt))) {
    errors.push('capturedAt must be an ISO timestamp');
  }
  if (
    !bundle.workspace ||
    typeof bundle.workspace.name !== 'string' ||
    !bundle.workspace.name.trim()
  ) {
    errors.push('workspace.name is required');
  }
  collectShareBundleFileErrors(bundle, errors);
  if (!Array.isArray(bundle.excludedFiles)) {
    errors.push('excludedFiles must be an array');
  } else {
    for (const [index, file] of bundle.excludedFiles.entries()) {
      if (!file || typeof file !== 'object' || !isSafeRelativePath(file.relativePath)) {
        errors.push(`excludedFiles[${index}].relativePath is unsafe`);
      }
    }
  }
  if (!bundle.provenance || bundle.provenance.source !== 'dnaforge-desktop') {
    errors.push('provenance.source must be dnaforge-desktop');
  }
  if (
    !bundle.provenance ||
    typeof bundle.provenance.contentSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(bundle.provenance.contentSha256)
  ) {
    errors.push('provenance.contentSha256 must be a sha256 hex digest');
  }
  return errors.length ? { ok: false, errors } : { ok: true, bundle: bundle as ShareBundle };
}

const BUNDLE_EXCLUDE_REASON_ERROR: Record<string, (index: number) => string> = {
  'private-raw-data': (index) => `files[${index}].relativePath is private raw data`,
  'reference-pointer': (index) => `files[${index}].relativePath is a reference pointer`,
  unsupported: (index) => `files[${index}].relativePath is unsupported`,
  'file-too-large': (index) => `files[${index}].sizeBytes exceeds the per-file limit`,
  'bundle-too-large': (index) => `files[${index}].sizeBytes exceeds the bundle limit`,
};

function collectWorkspaceSyncBundleHeaderErrors(
  rawBundle: Record<string, unknown>,
  bundle: Partial<WorkspaceSyncBundle> & { excludedFiles?: unknown },
  expectedVersion: 1 | 2 | 3
): string[] {
  const errors: string[] = [];
  if ('excludedFiles' in rawBundle) {
    errors.push('excludedFiles is not allowed in WorkspaceSyncBundleV1');
  }
  if (bundle.schemaVersion !== expectedVersion) {
    errors.push(`schemaVersion must be ${expectedVersion}`);
  }
  if (typeof bundle.capturedAt !== 'string' || Number.isNaN(Date.parse(bundle.capturedAt))) {
    errors.push('capturedAt must be an ISO timestamp');
  }
  if (!bundle.workspace || typeof bundle.workspace.id !== 'string' || !bundle.workspace.id.trim()) {
    errors.push('workspace.id is required');
  }
  if (
    !bundle.workspace ||
    typeof bundle.workspace.name !== 'string' ||
    !bundle.workspace.name.trim()
  ) {
    errors.push('workspace.name is required');
  }
  if (!isWorkspaceSyncExcludedSummary(bundle.excludedSummary)) {
    errors.push('excludedSummary must contain aggregate excluded-file counts only');
  }
  if (!isBundleLimits(bundle.limits)) {
    errors.push('limits must match the bundle limits shape');
  }
  if (!bundle.provenance || bundle.provenance.source !== 'dnaforge-desktop') {
    errors.push('provenance.source must be dnaforge-desktop');
  }
  if (
    !bundle.provenance ||
    typeof bundle.provenance.contentSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(bundle.provenance.contentSha256)
  ) {
    errors.push('provenance.contentSha256 must be a sha256 hex digest');
  }
  return errors;
}

function appendWorkspaceSyncBundleFileEntryErrors(args: {
  file: WorkspaceSyncBundle['files'][number] | null | undefined;
  index: number;
  expectedVersion: 1 | 2 | 3;
  limits: typeof WORKSPACE_SYNC_BUNDLE_V1_READ_LIMITS;
  notebookRoots: Set<string>;
  declaredSequencePackageMemberPaths: Set<string>;
  normalizedPaths: Set<string>;
  caseFoldedPaths: Set<string>;
  errors: string[];
}): number {
  const {
    file,
    index,
    expectedVersion,
    limits,
    notebookRoots,
    declaredSequencePackageMemberPaths,
    normalizedPaths,
    caseFoldedPaths,
    errors,
  } = args;
  if (!file || typeof file !== 'object') {
    errors.push(`files[${index}] must be an object`);
    return 0;
  }

  const relativePath =
    typeof file.relativePath === 'string' ? normalizeRelativePath(file.relativePath) : null;
  if (!relativePath) {
    errors.push(`files[${index}].relativePath is unsafe`);
  } else {
    if (normalizedPaths.has(relativePath)) {
      errors.push(`files[${index}].relativePath is duplicated`);
    }
    normalizedPaths.add(relativePath);

    const caseFolded = relativePath.toLocaleLowerCase('en-US');
    if (caseFoldedPaths.has(caseFolded)) {
      errors.push(`files[${index}].relativePath collides case-insensitively`);
    }
    caseFoldedPaths.add(caseFolded);

    if (hasReservedWindowsName(relativePath)) {
      errors.push(`files[${index}].relativePath uses a reserved Windows name`);
    }

    const classification = classifyBundleFile(
      relativePath,
      typeof file.sizeBytes === 'number' ? file.sizeBytes : 0,
      notebookRoots,
      declaredSequencePackageMemberPaths,
      limits
    );
    const privateResourceMediaType =
      expectedVersion === 3 &&
      classification.action === 'exclude' &&
      classification.reason === 'unsupported'
        ? workspaceSyncResourceMediaType(relativePath)
        : null;
    if (privateResourceMediaType) {
      if (file.kind !== 'workspace-resource')
        errors.push(`files[${index}].kind does not match relativePath`);
      if (file.contentType !== privateResourceMediaType)
        errors.push(`files[${index}].contentType does not match relativePath`);
    } else if (classification.action === 'exclude') {
      const reasonError = BUNDLE_EXCLUDE_REASON_ERROR[classification.reason];
      if (reasonError) errors.push(reasonError(index));
    } else {
      if (file.kind !== classification.kind) {
        errors.push(`files[${index}].kind does not match relativePath`);
      }
      if (file.contentType !== classification.contentType) {
        errors.push(`files[${index}].contentType does not match relativePath`);
      }
    }
  }

  if (typeof file.id !== 'string' || !file.id.trim()) {
    errors.push(`files[${index}].id is required`);
  }
  if (typeof file.name !== 'string' || !file.name.trim()) {
    errors.push(`files[${index}].name is required`);
  }
  if (typeof file.content !== 'string') {
    errors.push(`files[${index}].content must be a string`);
    return 0;
  }
  if (expectedVersion === 1 && file.encoding !== undefined) {
    errors.push(`files[${index}].encoding is not allowed in schemaVersion 1`);
    return 0;
  }
  if (expectedVersion === 3 && file.encoding === 'blob') {
    if (file.content !== '')
      errors.push(`files[${index}].content must be empty for a blob reference`);
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > limits.maxFileBytes
    ) {
      errors.push(`files[${index}].sizeBytes exceeds the per-file limit`);
    }
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      errors.push(`files[${index}].sha256 must be a lowercase sha256 hex digest`);
    }
    return Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0 ? file.sizeBytes : 0;
  }
  if (file.encoding !== undefined && file.encoding !== 'base64') {
    errors.push(`files[${index}].encoding must be base64 when present`);
    return 0;
  }

  let actualBytes: Uint8Array;
  try {
    actualBytes = decodeBundleFileContent(file);
  } catch {
    errors.push(`files[${index}].content is not valid for its encoding`);
    return 0;
  }
  const actualSizeBytes = actualBytes.byteLength;
  if (typeof file.sizeBytes !== 'number' || file.sizeBytes < 0) {
    errors.push(`files[${index}].sizeBytes must be non-negative`);
  } else if (file.sizeBytes !== actualSizeBytes) {
    errors.push(`files[${index}].sizeBytes does not match decoded content length`);
  }
  if (actualSizeBytes > limits.maxFileBytes) {
    errors.push(`files[${index}].sizeBytes exceeds the per-file limit`);
  }

  const actualSha256 = bundleFileContentSha256(file);
  if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
    errors.push(`files[${index}].sha256 must be a sha256 hex digest`);
  } else if (file.sha256.toLowerCase() !== actualSha256) {
    errors.push(`files[${index}].sha256 does not match content`);
  }
  return actualSizeBytes;
}

function validateWorkspaceSyncBundleVersion(
  value: unknown,
  expectedVersion: 1 | 2 | 3
): { ok: true; bundle: WorkspaceSyncBundle } | { ok: false; errors: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['bundle must be an object'] };
  }
  const rawBundle = value as Record<string, unknown>;
  const bundle = value as Partial<WorkspaceSyncBundle> & { excludedFiles?: unknown };
  const errors = collectWorkspaceSyncBundleHeaderErrors(rawBundle, bundle, expectedVersion);

  const limits =
    expectedVersion === 3
      ? WORKSPACE_SYNC_MANIFEST_READ_LIMITS
      : WORKSPACE_SYNC_BUNDLE_V1_READ_LIMITS;
  let totalBytes = 0;
  const normalizedPaths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  const sequencePackages =
    expectedVersion >= 2 && Array.isArray(bundle.files)
      ? discoverSequencePackageAuthorities(bundle.files)
      : { declaredMemberPaths: new Set<string>(), errors: [] };
  errors.push(...sequencePackages.errors);
  const notebookRoots = Array.isArray(bundle.files)
    ? validatedNotebookRootsFromFiles(bundle.files)
    : new Set<string>();

  if (!Array.isArray(bundle.files)) {
    errors.push('files must be an array');
  } else if (bundle.files.length > limits.maxFiles) {
    errors.push(`files must contain at most ${limits.maxFiles} entries`);
  } else {
    for (const [index, file] of bundle.files.entries()) {
      totalBytes += appendWorkspaceSyncBundleFileEntryErrors({
        file,
        index,
        expectedVersion,
        limits,
        notebookRoots,
        declaredSequencePackageMemberPaths: sequencePackages.declaredMemberPaths,
        normalizedPaths,
        caseFoldedPaths,
        errors,
      });
    }
  }

  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBundleBytes) {
    errors.push('files total size exceeds the bundle limit');
  }

  return errors.length
    ? { ok: false, errors }
    : { ok: true, bundle: bundle as WorkspaceSyncBundle };
}

export function validateWorkspaceSyncBundleV1(
  value: unknown
): { ok: true; bundle: WorkspaceSyncBundleV1 } | { ok: false; errors: string[] } {
  const result = validateWorkspaceSyncBundleVersion(value, 1);
  return result.ok ? { ok: true, bundle: result.bundle as WorkspaceSyncBundleV1 } : result;
}

export function validateWorkspaceSyncBundleV2(
  value: unknown
): { ok: true; bundle: WorkspaceSyncBundleV2 } | { ok: false; errors: string[] } {
  const result = validateWorkspaceSyncBundleVersion(value, 2);
  return result.ok ? { ok: true, bundle: result.bundle as WorkspaceSyncBundleV2 } : result;
}

export function validateWorkspaceSyncBundle(
  value: unknown
): { ok: true; bundle: WorkspaceSyncBundle } | { ok: false; errors: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['bundle must be an object'] };
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (version === 1) return validateWorkspaceSyncBundleV1(value);
  if (version === 2) return validateWorkspaceSyncBundleV2(value);
  if (version === 3) return validateWorkspaceSyncBundleVersion(value, 3);
  return { ok: false, errors: ['schemaVersion must be 1, 2 or 3'] };
}

export function validateWorkspaceSyncUploadAdmission(
  bundle: WorkspaceSyncBundle,
  options: {
    limits?: ShareBundleLimits;
    maxEncodedBundleBytes?: number;
  } = {}
): WorkspaceSyncUploadAdmissionResult {
  const limits =
    options.limits ??
    (bundle.schemaVersion === 3
      ? WORKSPACE_SYNC_MANIFEST_READ_LIMITS
      : DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS);
  const maxEncodedBundleBytes =
    options.maxEncodedBundleBytes ?? DEFAULT_WORKSPACE_SYNC_ENCODED_BUNDLE_MAX_BYTES;
  const errors: string[] = [];
  let rawContentBytes = 0;
  if (bundle.schemaVersion === 3 && !options.limits) {
    errors.push('backend storage policy limits are required for new uploads');
  }

  const filePolicy = validateNewBundleFilePolicy(bundle, limits);
  if (!filePolicy.ok) errors.push(...filePolicy.errors);

  if (bundle.files.length > limits.maxFiles) {
    errors.push(`files must contain at most ${limits.maxFiles} entries`);
  }
  for (const [index, file] of bundle.files.entries()) {
    const sizeBytes =
      bundle.schemaVersion === 3 && file.encoding === 'blob'
        ? file.sizeBytes
        : decodeBundleFileContent(file).byteLength;
    rawContentBytes += sizeBytes;
    if (sizeBytes > limits.maxFileBytes) {
      errors.push(`files[${index}].sizeBytes exceeds the new-upload per-file limit`);
    }
  }
  if (rawContentBytes > limits.maxBundleBytes) {
    errors.push('files total size exceeds the new-upload raw-content limit');
  }

  const encodedBundleBytes = utf8ByteLength(JSON.stringify(bundle));
  if (encodedBundleBytes > maxEncodedBundleBytes) {
    errors.push('encoded bundle JSON exceeds the new-upload encoded-bundle limit');
  }

  return errors.length
    ? { ok: false, errors, rawContentBytes, encodedBundleBytes }
    : { ok: true, rawContentBytes, encodedBundleBytes };
}

function normalizeRelativePath(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed !== value) return null;
  if (!isSafeRelativePath(trimmed)) return null;
  if (trimmed.includes('\\')) return null;
  return trimmed;
}

function hasReservedWindowsName(relativePath: string): boolean {
  return relativePath.split('/').some((part) => {
    const basename = part
      .trim()
      .replace(/[. ]+$/u, '')
      .split('.')[0]
      ?.toUpperCase();
    return Boolean(
      basename &&
      (WINDOWS_RESERVED_NAMES.has(basename) ||
        /^COM[1-9]$/u.test(basename) ||
        /^LPT[1-9]$/u.test(basename))
    );
  });
}

function isBundleLimits(value: unknown): value is ShareBundleLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.maxFileBytes === 'number' &&
    candidate.maxFileBytes >= 0 &&
    typeof candidate.maxBundleBytes === 'number' &&
    candidate.maxBundleBytes >= 0 &&
    typeof candidate.maxFiles === 'number' &&
    candidate.maxFiles >= 0
  );
}

function isWorkspaceSyncExcludedSummary(value: unknown): value is WorkspaceSyncExcludedSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  if (
    Object.keys(summary).some(
      (key) => !(WORKSPACE_SYNC_EXCLUDED_REASONS as readonly string[]).includes(key)
    )
  ) {
    return false;
  }
  return WORKSPACE_SYNC_EXCLUDED_REASONS.every((reason) => {
    const entry = summary[reason];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => key !== 'count' && key !== 'bytesApprox')) {
      return false;
    }
    return (
      typeof candidate.count === 'number' &&
      candidate.count >= 0 &&
      (candidate.bytesApprox === null ||
        (typeof candidate.bytesApprox === 'number' && candidate.bytesApprox >= 0))
    );
  });
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

function toStableJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) {
    throw new TypeError('Cannot canonicalize circular JSON value');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const arrayValue = value.map((item) => toStableJsonValue(item, seen));
    seen.delete(value);
    return arrayValue;
  }

  const record = value as Record<string, unknown>;
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined || typeof child === 'function' || typeof child === 'symbol') {
      continue;
    }
    stable[key] = toStableJsonValue(child, seen);
  }
  seen.delete(value);
  return stable;
}

const WORKSPACE_SYNC_EXCLUDED_REASONS: readonly WorkspaceSyncExcludedReason[] = [
  'unsupported',
  'private-raw-data',
  'reference-pointer',
  'file-too-large',
  'bundle-too-large',
];

const WINDOWS_RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CLOCK$']);

function extensionFor(lowerPath: string): string {
  const lastSlash = lowerPath.lastIndexOf('/');
  const name = lastSlash >= 0 ? lowerPath.slice(lastSlash + 1) : lowerPath;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}
