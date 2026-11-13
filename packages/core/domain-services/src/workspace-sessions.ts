import { parseWorkspacePath, validatePortableWorkspaceTree } from '@waypoint/workspace-revisions';

export type WorkspaceRuntimeKind =
  | 'electron'
  | 'hosted-browser'
  | 'browser-directory'
  | 'local-bridge'
  | 'remote-provider';

export type WorkspaceAuthorityKind =
  | 'dnaforge-revision-graph'
  | 'dnaforge-manifest-revisions'
  | 'local-working-copy'
  | 'external-provider';

export type WorkspaceIdentityFidelity = 'stable-resource-id' | 'path-placement-only';

export interface WorkspaceSessionCapabilities {
  readonly createWorkspace: boolean;
  readonly multiFile: boolean;
  readonly write: boolean;
  readonly rename: boolean;
  readonly move: boolean;
  readonly delete: boolean;
  readonly watch: boolean;
  readonly history: boolean;
  readonly restore: boolean;
}

export interface WorkspaceRuntimeDescriptor {
  readonly kind: WorkspaceRuntimeKind;
  readonly authority: WorkspaceAuthorityKind;
  readonly identityFidelity: WorkspaceIdentityFidelity;
  readonly capabilities: WorkspaceSessionCapabilities;
}

export interface WorkspaceSessionPrincipal {
  readonly id: string;
  readonly label: string;
  readonly secondaryLabel?: string;
}

export interface WorkspaceSessionWorkspace {
  readonly workspaceId: string;
  readonly clientWorkspaceId?: string;
  readonly displayName: string;
  readonly latestRevisionId: string | null;
  readonly latestRevisionNumber: number;
  readonly versionCount?: number;
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WorkspaceSessionIndex {
  readonly preferredWorkspaceId?: string | null;
  readonly principal?: WorkspaceSessionPrincipal;
  readonly workspaces: readonly WorkspaceSessionWorkspace[];
}

export interface WorkspaceSessionFile {
  readonly resourceId: string | null;
  readonly path: string;
  readonly contentRevision: string;
  readonly contentSha256: string | null;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface WorkspaceSessionSnapshot {
  readonly workspaceId: string;
  readonly revisionId: string | null;
  readonly revisionNumber: number;
  readonly files: readonly WorkspaceSessionFile[];
  readonly localRevisionId?: string;
}

export interface WorkspaceSessionRevision {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly sizeBytes: number;
  readonly createdByLabel?: string;
}

export interface WorkspaceSessionFileWrite {
  readonly resourceId?: string | null;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface WorkspaceSessionPublicationCondition {
  readonly kind: 'managed-operation-result';
  readonly operationId: string;
  readonly inputRevision: string;
  readonly baseRevisionId: string;
  readonly outputPath: string;
}

export interface WorkspaceSessionAdapter {
  readonly descriptor: WorkspaceRuntimeDescriptor;
  listWorkspaces(): Promise<WorkspaceSessionIndex>;
  createWorkspace(
    displayName: string,
    expectedAccountId?: string
  ): Promise<WorkspaceSessionWorkspace>;
  loadWorkspace(workspace: WorkspaceSessionWorkspace): Promise<WorkspaceSessionSnapshot>;
  readFile(input: {
    readonly snapshot: WorkspaceSessionSnapshot;
    readonly file: WorkspaceSessionFile;
  }): Promise<Uint8Array>;
  commit(input: {
    readonly snapshot: WorkspaceSessionSnapshot;
    readonly writes: readonly WorkspaceSessionFileWrite[];
    readonly removePaths?: readonly string[];
    readonly onProgress?: (sentBytes: number, totalBytes: number) => void;
    readonly operationId?: string;
    readonly publicationCondition?: WorkspaceSessionPublicationCondition;
    readonly expectedAccountId?: string;
  }): Promise<WorkspaceSessionSnapshot>;
  listHistory?(workspace: WorkspaceSessionWorkspace): Promise<readonly WorkspaceSessionRevision[]>;
  retainRecoveryCandidate?(input: {
    readonly snapshot: WorkspaceSessionSnapshot;
    readonly writes: readonly WorkspaceSessionFileWrite[];
    readonly removePaths?: readonly string[];
    readonly operationId: string;
    readonly expectedAccountId?: string;
  }): Promise<{
    readonly id: string;
    readonly expiresAt: string;
    readonly coverage: 'captured-bytes' | 'incomplete';
  }>;
  restoreRevision?(input: {
    readonly workspace: WorkspaceSessionWorkspace;
    readonly snapshot: WorkspaceSessionSnapshot;
    readonly revisionId: string;
    readonly expectedAccountId?: string;
  }): Promise<WorkspaceSessionSnapshot>;
}

export type WorkspaceSessionContractErrorCode = 'UNSAFE_PATH' | 'PATH_COLLISION' | 'INVALID_FILE';

export class WorkspaceSessionContractError extends Error {
  constructor(
    readonly code: WorkspaceSessionContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceSessionContractError';
  }
}

export interface WorkspaceSessionFileReplacement {
  readonly resourceId?: string | null;
  readonly path: string;
  readonly contentRevision: string;
  readonly contentSha256: string | null;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface MergeWorkspaceSessionFilesOptions {
  readonly removePaths?: readonly string[];
}

export function mergeWorkspaceSessionFiles(
  current: readonly WorkspaceSessionFile[],
  replacements: readonly WorkspaceSessionFileReplacement[],
  options: MergeWorkspaceSessionFilesOptions = {}
): WorkspaceSessionFile[] {
  const byPath = new Map<string, WorkspaceSessionFile>();
  for (const file of current) {
    validateFile(file);
    byPath.set(file.path, { ...file });
  }
  for (const removed of options.removePaths ?? []) {
    for (const path of [...byPath.keys()]) {
      if (path === removed || path.startsWith(`${removed}/`)) {
        byPath.delete(path);
      }
    }
  }
  for (const replacement of replacements) {
    validateFile({ resourceId: replacement.resourceId ?? null, ...replacement });
    const previous = byPath.get(replacement.path);
    byPath.set(replacement.path, {
      resourceId:
        replacement.resourceId === undefined
          ? (previous?.resourceId ?? null)
          : replacement.resourceId,
      path: replacement.path,
      contentRevision: replacement.contentRevision,
      contentSha256: replacement.contentSha256,
      sizeBytes: replacement.sizeBytes,
      contentType: replacement.contentType,
    });
  }

  const files = [...byPath.values()];
  const tree = validatePortableWorkspaceTree({ files });
  if (!tree.ok) {
    throw new WorkspaceSessionContractError('PATH_COLLISION', tree.errors.join(' '));
  }
  return files.sort((left, right) => compareUtf8(left.path, right.path));
}

function validateFile(file: WorkspaceSessionFile): void {
  const parsedPath = parseWorkspacePath(file.path);
  if (file.path !== file.path.trim() || !parsedPath.ok || parsedPath.value !== file.path) {
    throw new WorkspaceSessionContractError(
      'UNSAFE_PATH',
      `Workspace placement is unsafe: ${file.path}.`
    );
  }
  if (
    !isSafeRevision(file.contentRevision) ||
    (file.contentSha256 !== null && !/^[a-f0-9]{64}$/u.test(file.contentSha256)) ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes < 0 ||
    !isSafeContentType(file.contentType) ||
    (file.resourceId !== null && file.resourceId.trim().length === 0)
  ) {
    throw new WorkspaceSessionContractError(
      'INVALID_FILE',
      `Workspace placement metadata is invalid: ${file.path}.`
    );
  }
}

function isSafeRevision(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function isSafeContentType(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
