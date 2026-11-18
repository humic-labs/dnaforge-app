import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import { isSafeRelativePath } from '@waypoint/share-bundle';
import type { WorkspaceSyncSelection } from '../shared/workspace-sync-selection';
import { executeManagedGit } from './workspace-git/native';
import {
  readWorkspaceSyncReplicaFiles,
  recordWorkspaceSyncReplicaFiles,
} from './workspace-sync-replica-files';
import { isWorkspaceSyncOperationalPath } from './workspace-sync-paths';
import { canonicalWorkspacePath } from './primer-artifact-files';

const MAX_RULE_BYTES = 64 * 1024;
const LEGACY_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.next',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  'tmp',
  'temp',
  '.tmp',
  '.cache',
  'vendor',
]);

interface MembershipBinding {
  owner_account_id: string;
  remote_workspace_id: string | null;
  remote_latest_version_id: string | null;
}

export interface WorkspaceSyncMembership {
  readonly workspaceUuid: string;
  readonly repoPath: string;
  readonly acceptedPaths: ReadonlySet<string>;
  readonly ignoredPaths: ReadonlySet<string>;
  readonly requiredPaths: Set<string>;
  readonly ruleFiles: WorkspaceSyncSelection['ruleFiles'];
  readonly policyHash: string;
  readonly settingsKey: string;
  readonly bound: boolean;
  readonly acceptedPathsKnown: boolean;
  readonly adopted: boolean;
  readonly pending: boolean;
}

export class WorkspaceSyncSelectionError extends Error {
  readonly code = 'SELECTION_REVIEW_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSyncSelectionError';
  }
}

export async function readWorkspaceSyncMembership(
  db: Database.Database,
  input: { workspaceUuid: string; repoPath: string }
): Promise<WorkspaceSyncMembership> {
  const binding = db
    .prepare(
      'SELECT owner_account_id, remote_workspace_id, remote_latest_version_id FROM workspace_sync_bindings WHERE workspace_uuid = ?'
    )
    .get(input.workspaceUuid) as MembershipBinding | undefined;
  const accepted =
    binding?.remote_workspace_id && binding.remote_latest_version_id
      ? readWorkspaceSyncReplicaFiles(db, {
          workspaceUuid: input.workspaceUuid,
          remoteWorkspaceId: binding.remote_workspace_id,
          remoteVersionId: binding.remote_latest_version_id,
        })
      : [];
  const [ignoredOutput, selectedOutput] = await Promise.all([
    executeManagedGit(input.repoPath, [
      'ls-files',
      '--cached',
      '--others',
      '--ignored',
      '--exclude-per-directory=.gitignore',
      '-z',
    ]),
    executeManagedGit(input.repoPath, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-per-directory=.gitignore',
      '-z',
    ]),
  ]);
  const policyPaths = new Set([
    '.gitignore',
    ...`${selectedOutput}${ignoredOutput}`
      .split('\0')
      .filter((path) => basename(path) === '.gitignore'),
  ]);
  const ruleFiles: WorkspaceSyncSelection['ruleFiles'] = [];
  for (const relativePath of [...policyPaths].sort()) {
    if (!isSafeRelativePath(relativePath) || isWorkspaceSyncOperationalPath(relativePath)) continue;
    const path = join(input.repoPath, relativePath);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RULE_BYTES)
      throw new WorkspaceSyncSelectionError(
        `Project rules must be a regular file of at most 64 KiB: ${relativePath}`
      );
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: input.repoPath,
      path,
      artifactNoun: 'project sync rules',
    });
    if (canonical.candidate !== join(canonical.root, relativePath))
      throw new WorkspaceSyncSelectionError(
        `Project rules cannot follow a symbolic link: ${relativePath}`
      );
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await readFile(path)
    );
    ruleFiles.push({ relativePath, content });
  }
  const policyHash = createHash('sha256').update(JSON.stringify(ruleFiles)).digest('hex');
  const settingsKey = [
    'workspace_sync_selection',
    input.workspaceUuid,
    binding?.owner_account_id ?? '',
    binding?.remote_workspace_id ?? '',
  ]
    .map(encodeURIComponent)
    .join(':');
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingsKey) as
    | { value: string }
    | undefined;
  let adopted = false;
  let pending = false;
  if (row) {
    try {
      const value: unknown = JSON.parse(row.value);
      adopted = Boolean(
        value &&
        typeof value === 'object' &&
        'version' in value &&
        value.version === 1 &&
        'state' in value &&
        value.state === 'active' &&
        'policyHash' in value &&
        value.policyHash === policyHash
      );
      pending = !adopted;
    } catch {
      pending = true;
    }
  }
  return {
    ...input,
    acceptedPaths: new Set(accepted ?? []),
    requiredPaths: new Set(),
    ignoredPaths: new Set(ignoredOutput.split('\0').filter(Boolean)),
    ruleFiles,
    policyHash,
    settingsKey,
    bound: Boolean(binding?.remote_workspace_id),
    acceptedPathsKnown: accepted !== null,
    adopted,
    pending,
  };
}

export function isWorkspaceSyncProjectIgnored(
  membership: WorkspaceSyncMembership,
  path: string
): boolean {
  if (
    basename(path) === '.gitignore' ||
    membership.acceptedPaths.has(path) ||
    membership.requiredPaths.has(path)
  )
    return false;
  if (!membership.acceptedPathsKnown) return false;
  return membership.ignoredPaths.has(path);
}

export function describeWorkspaceSyncSelection(
  membership: WorkspaceSyncMembership,
  includedFiles: readonly { relativePath: string; sizeBytes: number }[]
): WorkspaceSyncSelection {
  const newlyIncludedPaths =
    membership.bound && !membership.adopted
      ? includedFiles
          .filter(
            ({ relativePath }) =>
              !membership.acceptedPaths.has(relativePath) &&
              relativePath
                .split('/')
                .slice(0, -1)
                .some((part) => LEGACY_DIRECTORY_NAMES.has(part))
          )
          .map(({ relativePath }) => relativePath)
          .sort()
      : [];
  const needsReview =
    membership.pending ||
    (membership.bound &&
      !membership.adopted &&
      (newlyIncludedPaths.length > 0 ||
        membership.ruleFiles.length > 0 ||
        !membership.acceptedPathsKnown));
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        workspaceUuid: membership.workspaceUuid,
        settingsKey: membership.settingsKey,
        policyHash: membership.policyHash,
        acceptedPaths: [...membership.acceptedPaths].sort(),
        files: includedFiles.map(({ relativePath, sizeBytes }) => [relativePath, sizeBytes]).sort(),
      })
    )
    .digest('hex');
  return {
    version: 1,
    revision,
    state: needsReview ? 'review-required' : 'active',
    ruleFiles: membership.ruleFiles,
    newlyIncludedPaths,
    protectedFiles: includedFiles
      .filter(({ relativePath }) => membership.ignoredPaths.has(relativePath))
      .map(({ relativePath }) => ({
        relativePath,
        reason: membership.acceptedPaths.has(relativePath)
          ? 'already-backed-up'
          : membership.requiredPaths.has(relativePath)
            ? 'required-scientific'
            : 'project-rules',
      })),
  };
}

export function assertWorkspaceSyncSelectionActive(selection: WorkspaceSyncSelection): void {
  if (selection.state === 'review-required')
    throw new WorkspaceSyncSelectionError(
      'Review the project files and rules in Cloud backup before uploading. Files already backed up remain included.'
    );
}

export function approveWorkspaceSyncMembership(
  db: Database.Database,
  membership: WorkspaceSyncMembership
): void {
  if (!membership.acceptedPathsKnown)
    throw new WorkspaceSyncSelectionError(
      'Reconnect to recover the accepted file list before changing project selection.'
    );
  db.prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
    membership.settingsKey,
    JSON.stringify({ version: 1, state: 'active', policyHash: membership.policyHash }),
    Date.now()
  );
}

export function markWorkspaceSyncSelectionPending(
  db: Database.Database,
  membership: WorkspaceSyncMembership
): void {
  db.prepare('INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
    membership.settingsKey,
    JSON.stringify({ version: 1, state: 'review-required', policyHash: membership.policyHash }),
    Date.now()
  );
}

export async function ensureWorkspaceSyncAcceptedPaths(
  db: Database.Database,
  workspaceUuid: string,
  readPaths: (
    remoteWorkspaceId: string,
    remoteVersionId: string,
    accountId: string
  ) => Promise<string[]>
): Promise<void> {
  const readBinding = () =>
    db
      .prepare(
        'SELECT owner_account_id, remote_workspace_id, remote_latest_version_id FROM workspace_sync_bindings WHERE workspace_uuid = ?'
      )
      .get(workspaceUuid) as MembershipBinding | undefined;
  const binding = readBinding();
  if (!binding?.remote_workspace_id || !binding.remote_latest_version_id) return;
  const identity = {
    workspaceUuid,
    remoteWorkspaceId: binding.remote_workspace_id,
    remoteVersionId: binding.remote_latest_version_id,
  };
  if (readWorkspaceSyncReplicaFiles(db, identity) !== null) return;
  const paths = await readPaths(
    identity.remoteWorkspaceId,
    identity.remoteVersionId,
    binding.owner_account_id
  );
  if (JSON.stringify(readBinding()) !== JSON.stringify(binding))
    throw new WorkspaceSyncSelectionError(
      'The accepted version changed. Refresh the project before reviewing its files.'
    );
  recordWorkspaceSyncReplicaFiles(db, { ...identity, paths, nowMs: Date.now() });
}

export function parseWorkspaceSyncSelectionMetadata(
  value: Record<string, unknown>
): Pick<
  import('./workspace-sync-snapshotter').WorkspaceSyncSnapshot,
  'selection' | 'excludedFiles'
> {
  if (value.selection === undefined && value.excludedFiles === undefined) return {};
  const selection = value.selection as WorkspaceSyncSelection | undefined;
  const excluded = value.excludedFiles as
    | import('../shared/workspace-sync-selection').WorkspaceSyncExcludedFile[]
    | undefined;
  const validPath = (path: unknown) => typeof path === 'string' && isSafeRelativePath(path);
  if (
    !selection ||
    selection.version !== 1 ||
    selection.state !== 'active' ||
    !/^[a-f0-9]{64}$/u.test(selection.revision) ||
    !Array.isArray(selection.ruleFiles) ||
    !selection.ruleFiles.every(
      (file) =>
        file &&
        validPath(file.relativePath) &&
        typeof file.content === 'string' &&
        Buffer.byteLength(file.content, 'utf8') <= MAX_RULE_BYTES
    ) ||
    !Array.isArray(selection.newlyIncludedPaths) ||
    !selection.newlyIncludedPaths.every(validPath) ||
    !Array.isArray(excluded) ||
    !excluded.every(
      (file) =>
        file &&
        validPath(file.relativePath) &&
        Number.isSafeInteger(file.sizeBytes) &&
        file.sizeBytes >= 0 &&
        [
          'project-ignore',
          'unsupported',
          'private-raw-data',
          'reference-pointer',
          'file-too-large',
          'bundle-too-large',
          'selection-review',
        ].includes(file.reason)
    )
  )
    throw new WorkspaceSyncSelectionError(
      'The queued file selection is invalid. Review the project before capturing another backup.'
    );
  return { selection, excludedFiles: excluded };
}
