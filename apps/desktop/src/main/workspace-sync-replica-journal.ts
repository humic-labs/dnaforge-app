import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type Database from 'better-sqlite3';
import git from 'isomorphic-git';

import { flushFileAndParentDirectoryRequired } from './database-recovery';
import { hashWorkspaceSyncFileOnDisk } from './workspace-sync-blob-cache';
import { restoreManagedHeadAndIndex, resolveHeadCommit } from './workspace-git';

const JOURNAL_NAME = 'replica-pull-journal.json';
const JOURNAL_VERSION = 2;
const LEGACY_TEXT_HASH_JOURNAL_VERSION = 1;
const STAGING_PREFIX = '.dnaforge-sync-pull-';
const OWNED_STAGING_PREFIX = `${STAGING_PREFIX}v1-`;
const STAGING_OWNER_KEY_LENGTH = 16;

type ReplicaJournalPhase =
  | 'staging'
  | 'prepared'
  | 'files_installed'
  | 'git_committed'
  | 'sqlite_committed'
  | 'rolled_back';

interface ReplicaJournalFile {
  relativePath: string;
  sha256: string;
}

export interface ReplicaPullJournal {
  version: typeof LEGACY_TEXT_HASH_JOURNAL_VERSION | typeof JOURNAL_VERSION;
  phase: ReplicaJournalPhase;
  repoPath: string;
  workspaceUuid: string;
  oldHead: string;
  newHead: string | null;
  targetRemoteVersionId: string;
  targetRemoteVersionNumber: number;
  operationPaths: string[];
  backups: ReplicaJournalFile[];
  installs: ReplicaJournalFile[];
}

export interface ReplicaPullJournalHandle {
  path: string;
  readonly value: Readonly<ReplicaPullJournal>;
  markFilesInstalled(): void;
  markGitCommitted(newHead: string): void;
  markSqliteCommitted(): void;
  commit(cleanup: () => Promise<void>): Promise<void>;
  rollback(restoreFiles: () => Promise<void>): Promise<void>;
  finishRollback(cleanup: () => Promise<void>): Promise<void>;
}

export interface ReplicaPullRecoveryResult {
  recovered: number;
  completed: number;
  quarantined: Array<{
    workspaceId: number;
    workspaceUuid: string;
    workspacePath: string;
    errorMessage: string;
  }>;
}

type ReplicaPullJournalIdentity = Pick<
  ReplicaPullJournal,
  'repoPath' | 'workspaceUuid' | 'oldHead' | 'targetRemoteVersionId' | 'targetRemoteVersionNumber'
>;

export function replicaPullStagingPrefix(workspaceUuid: string): string {
  if (workspaceUuid.length === 0) {
    throw new Error('Replica staging ownership requires a workspace UUID.');
  }
  return `${OWNED_STAGING_PREFIX}${replicaStagingOwnerKey(workspaceUuid)}-`;
}

export function createReplicaPullJournal(
  stagingRoot: string,
  input: Omit<ReplicaPullJournal, 'version' | 'phase' | 'newHead'>
): ReplicaPullJournalHandle {
  return writeReplicaPullJournal(stagingRoot, 'prepared', input);
}

export function createReplicaPullStagingJournal(
  stagingRoot: string,
  input: ReplicaPullJournalIdentity
): void {
  writeReplicaPullJournal(stagingRoot, 'staging', {
    ...input,
    operationPaths: [],
    backups: [],
    installs: [],
  });
}

function writeReplicaPullJournal(
  stagingRoot: string,
  phase: 'staging' | 'prepared',
  input: Omit<ReplicaPullJournal, 'version' | 'phase' | 'newHead'>
): ReplicaPullJournalHandle {
  let value: Readonly<ReplicaPullJournal> = Object.freeze({
    version: JOURNAL_VERSION,
    phase,
    newHead: null,
    ...input,
    repoPath: realpathSync(input.repoPath),
  });
  validateReplicaPullJournal(value, stagingRoot);
  const path = join(stagingRoot, JOURNAL_NAME);
  writeJournalDurably(path, value);
  let lifecycle: 'active' | 'rolling_back' | 'files_restored' | 'completed' = 'active';
  const requirePhase = (...phases: ReplicaJournalPhase[]): void => {
    if (lifecycle !== 'active' || !phases.includes(value.phase)) {
      throw new Error(`Replica transaction cannot advance from ${value.phase}/${lifecycle}.`);
    }
  };
  const publish = (nextPhase: ReplicaJournalPhase, newHead = value.newHead): void => {
    const next = { ...value, phase: nextPhase, newHead };
    validateReplicaPullJournal(next, stagingRoot);
    writeJournalDurably(path, next);
    value = Object.freeze(next);
  };
  return {
    path,
    get value() {
      return value;
    },
    markFilesInstalled: () => {
      requirePhase('prepared');
      publish('files_installed');
    },
    markGitCommitted: (newHead) => {
      requirePhase('files_installed');
      if (!isGitOid(newHead)) throw new Error('Replica Git acceptance requires a valid commit.');
      publish('git_committed', newHead);
    },
    markSqliteCommitted: () => {
      requirePhase('git_committed');
      publish('sqlite_committed');
    },
    commit: async (cleanup) => {
      if (lifecycle === 'completed' && value.phase === 'sqlite_committed') return;
      requirePhase('sqlite_committed');
      lifecycle = 'completed';
      await cleanup();
    },
    rollback: async (restoreFiles) => {
      if (lifecycle === 'files_restored') return;
      requirePhase('prepared', 'files_installed', 'git_committed');
      lifecycle = 'rolling_back';
      try {
        await restoreFiles();
        lifecycle = 'files_restored';
      } catch (error) {
        lifecycle = 'active';
        throw error;
      }
    },
    finishRollback: async (cleanup) => {
      if (lifecycle === 'completed' && value.phase === 'rolled_back') return;
      if (lifecycle !== 'files_restored') {
        throw new Error('Replica rollback must restore files before completion.');
      }
      publish('rolled_back');
      lifecycle = 'completed';
      await cleanup();
    },
  };
}

export async function reconcileInterruptedReplicaPulls(
  db: Database.Database
): Promise<ReplicaPullRecoveryResult> {
  const result: ReplicaPullRecoveryResult = { recovered: 0, completed: 0, quarantined: [] };
  const rows = db
    .prepare(
      `SELECT b.workspace_id,
              b.workspace_uuid,
              b.remote_latest_version_id,
              b.remote_latest_version_number,
              b.last_acked_local_head_sha,
              w.path AS workspace_path
       FROM workspace_sync_bindings b
       JOIN workspaces w ON w.id = b.workspace_id`
    )
    .all() as Array<{
    workspace_id: number;
    workspace_uuid: string;
    remote_latest_version_id: string | null;
    remote_latest_version_number: number | null;
    last_acked_local_head_sha: string | null;
    workspace_path: string;
  }>;

  workspaceRows: for (const row of rows) {
    let repoPath: string;
    try {
      repoPath = realpathSync(row.workspace_path);
    } catch (error) {
      result.quarantined.push({
        workspaceId: row.workspace_id,
        workspaceUuid: row.workspace_uuid,
        workspacePath: row.workspace_path,
        errorMessage: `Managed workspace root is unavailable during recovery: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }
    let siblings: string[];
    try {
      siblings = readdirSync(dirname(repoPath));
    } catch (error) {
      result.quarantined.push({
        workspaceId: row.workspace_id,
        workspaceUuid: row.workspace_uuid,
        workspacePath: row.workspace_path,
        errorMessage: `Managed workspace parent is unavailable during recovery: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }
    for (const name of siblings) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      const encodedOwnerKey = replicaStagingOwnerKeyFromName(name);
      const currentOwnerKey = replicaStagingOwnerKey(row.workspace_uuid);
      if (encodedOwnerKey !== null && encodedOwnerKey !== currentOwnerKey) continue;
      if (name.startsWith(OWNED_STAGING_PREFIX) && encodedOwnerKey === null) {
        continue;
      }
      const stagingRoot = join(dirname(repoPath), name);
      const journalPath = join(stagingRoot, JOURNAL_NAME);
      if (!existsSync(journalPath)) continue;
      let journal: ReplicaPullJournal;
      try {
        journal = readReplicaPullJournal(journalPath, stagingRoot);
      } catch (error) {
        if (encodedOwnerKey === null) {
          continue;
        }
        result.quarantined.push({
          workspaceId: row.workspace_id,
          workspaceUuid: row.workspace_uuid,
          workspacePath: row.workspace_path,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        continue workspaceRows;
      }
      try {
        const targetsCurrentPath = journal.repoPath === repoPath;
        const targetsCurrentWorkspace = journal.workspaceUuid === row.workspace_uuid;
        if (!targetsCurrentPath && !targetsCurrentWorkspace) {
          continue;
        }
        if (!targetsCurrentPath || !targetsCurrentWorkspace) {
          throw new Error(`Replica recovery journal does not belong to ${row.workspace_uuid}.`);
        }
        if (journal.phase === 'staging') {
          removeStagingBestEffort(stagingRoot);
          result.recovered += 1;
          continue;
        }
        if (journal.phase === 'sqlite_committed' || journal.phase === 'rolled_back') {
          removeStagingBestEffort(stagingRoot);
          result.completed += 1;
          continue;
        }
        const inferredNewHead = await inferManagedNewHead(repoPath, journal);
        const bindingTargetsJournal =
          row.remote_latest_version_id === journal.targetRemoteVersionId &&
          row.remote_latest_version_number === journal.targetRemoteVersionNumber;
        const sqliteCommitted =
          inferredNewHead !== null &&
          bindingTargetsJournal &&
          row.last_acked_local_head_sha === inferredNewHead;
        if (bindingTargetsJournal && !sqliteCommitted) {
          throw new Error(
            'Replica recovery found SQLite committed without the matching Git state.'
          );
        }
        if (sqliteCommitted) {
          await assertCommittedReplicaMatchesJournal(repoPath, {
            ...journal,
            newHead: inferredNewHead,
          });
          removeStagingBestEffort(stagingRoot);
          result.completed += 1;
          continue;
        }

        await rollbackInterruptedReplica(repoPath, stagingRoot, journal, inferredNewHead);
        removeStagingBestEffort(stagingRoot);
        result.recovered += 1;
      } catch (error) {
        result.quarantined.push({
          workspaceId: row.workspace_id,
          workspaceUuid: row.workspace_uuid,
          workspacePath: row.workspace_path,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        continue workspaceRows;
      }
    }
  }
  return result;
}

function replicaStagingOwnerKey(workspaceUuid: string): string {
  return createHash('sha256')
    .update(workspaceUuid, 'utf8')
    .digest('hex')
    .slice(0, STAGING_OWNER_KEY_LENGTH);
}

function replicaStagingOwnerKeyFromName(name: string): string | null {
  if (!name.startsWith(OWNED_STAGING_PREFIX)) return null;
  const suffix = name.slice(OWNED_STAGING_PREFIX.length);
  const ownerKey = suffix.slice(0, STAGING_OWNER_KEY_LENGTH);
  if (!/^[0-9a-f]{16}$/.test(ownerKey) || suffix[STAGING_OWNER_KEY_LENGTH] !== '-') {
    return null;
  }
  return ownerKey;
}

export function replicaJournalHash(content: string | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof content === 'string') {
    hash.update(content, 'utf8');
  } else {
    hash.update(content);
  }
  return hash.digest('hex');
}

function writeJournalDurably(path: string, journal: ReplicaPullJournal): void {
  const tempPath = `${path}.next-${randomUUID()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(journal, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    flushFileAndParentDirectoryRequired(tempPath);
    renameSync(tempPath, path);
    flushFileAndParentDirectoryRequired(path);
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function readReplicaPullJournal(path: string, stagingRoot: string): ReplicaPullJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Replica recovery journal is unreadable at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  validateReplicaPullJournal(parsed, stagingRoot);
  return parsed;
}

function validateReplicaPullJournal(
  value: unknown,
  stagingRoot: string
): asserts value is ReplicaPullJournal {
  if (
    !isRecord(value) ||
    (value.version !== LEGACY_TEXT_HASH_JOURNAL_VERSION && value.version !== JOURNAL_VERSION)
  ) {
    throw new Error('Replica recovery journal has an unsupported version.');
  }
  if (
    ![
      'staging',
      'prepared',
      'files_installed',
      'git_committed',
      'sqlite_committed',
      'rolled_back',
    ].includes(String(value.phase))
  ) {
    throw new Error('Replica recovery journal has an invalid phase.');
  }
  if (
    typeof value.repoPath !== 'string' ||
    !isAbsolute(value.repoPath) ||
    typeof value.workspaceUuid !== 'string' ||
    value.workspaceUuid.length === 0 ||
    typeof value.oldHead !== 'string' ||
    !isGitOid(value.oldHead) ||
    (value.newHead !== null && (typeof value.newHead !== 'string' || !isGitOid(value.newHead))) ||
    typeof value.targetRemoteVersionId !== 'string' ||
    value.targetRemoteVersionId.length === 0 ||
    !Number.isSafeInteger(value.targetRemoteVersionNumber) ||
    Number(value.targetRemoteVersionNumber) < 1
  ) {
    throw new Error('Replica recovery journal identity is invalid.');
  }
  if (value.phase === 'sqlite_committed' && value.newHead === null) {
    throw new Error('Committed replica recovery journal is missing its Git head.');
  }
  validateRelativePathList(value.operationPaths, 'operationPaths');
  validateJournalFiles(value.backups, 'backups');
  validateJournalFiles(value.installs, 'installs');
  if (
    value.phase === 'staging' &&
    (value.newHead !== null ||
      value.operationPaths.length !== 0 ||
      value.backups.length !== 0 ||
      value.installs.length !== 0)
  ) {
    throw new Error('Replica staging journal contains live-repository operations.');
  }
  const expectedParent = dirname(resolve(value.repoPath));
  const relativeStaging = relative(expectedParent, realpathSync(stagingRoot));
  if (
    relativeStaging.startsWith(`..${sep}`) ||
    relativeStaging === '..' ||
    relativeStaging.includes(sep) ||
    !relativeStaging.startsWith(STAGING_PREFIX)
  ) {
    throw new Error('Replica recovery journal staging path is invalid.');
  }
}

function validateRelativePathList(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => !isSafeRelativePath(entry))) {
    throw new Error(`Replica recovery journal ${label} is invalid.`);
  }
}

function validateJournalFiles(
  value: unknown,
  label: string
): asserts value is ReplicaJournalFile[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !isRecord(entry) ||
        !isSafeRelativePath(entry.relativePath) ||
        typeof entry.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)
    )
  ) {
    throw new Error(`Replica recovery journal ${label} is invalid.`);
  }
}

async function assertCommittedReplicaMatchesJournal(
  repoPath: string,
  journal: ReplicaPullJournal
): Promise<void> {
  if ((await resolveHeadCommit(repoPath)) !== journal.newHead) {
    throw new Error('Committed replica recovery journal does not match Git HEAD.');
  }
  for (const file of journal.installs) {
    if ((await readRegularFileHash(repoPath, file.relativePath, journal.version)) !== file.sha256) {
      throw new Error(`Committed replica file differs during recovery: ${file.relativePath}`);
    }
  }
}

async function rollbackInterruptedReplica(
  repoPath: string,
  stagingRoot: string,
  journal: ReplicaPullJournal,
  inferredNewHead: string | null
): Promise<void> {
  for (const file of [...journal.installs].reverse()) {
    const destination = resolveInsideWithoutSymlinkAncestors(repoPath, file.relativePath);
    if (!existsSync(destination)) continue;
    const currentHash = await readRegularFileHash(repoPath, file.relativePath, journal.version);
    const backup = journal.backups.find((entry) => entry.relativePath === file.relativePath);
    if (backup && currentHash === backup.sha256) continue;
    if (currentHash !== file.sha256) {
      throw new Error(`Replica recovery refused a concurrently edited file: ${file.relativePath}`);
    }
    rmSync(destination, { force: true });
  }

  for (const file of [...journal.backups].reverse()) {
    const destination = resolveInsideWithoutSymlinkAncestors(repoPath, file.relativePath);
    const backupRoot = join(stagingRoot, '.backup');
    const backupPath = resolveInsideWithoutSymlinkAncestors(backupRoot, file.relativePath);
    if (existsSync(destination)) {
      if (
        (await readRegularFileHash(repoPath, file.relativePath, journal.version)) !== file.sha256
      ) {
        throw new Error(`Replica recovery destination was recreated: ${file.relativePath}`);
      }
      continue;
    }
    if (
      !existsSync(backupPath) ||
      (await readRegularFileHash(backupRoot, file.relativePath, journal.version)) !== file.sha256
    ) {
      throw new Error(`Replica recovery backup is missing or changed: ${file.relativePath}`);
    }
    renameSync(backupPath, destination);
  }

  await restoreManagedHeadAndIndex(repoPath, {
    restoreHead: journal.oldHead,
    expectedCurrentHead: inferredNewHead ?? journal.oldHead,
    paths: journal.operationPaths,
  });
}

async function inferManagedNewHead(
  repoPath: string,
  journal: ReplicaPullJournal
): Promise<string | null> {
  const currentHead = await resolveHeadCommit(repoPath);
  if (!currentHead || currentHead === journal.oldHead) return null;
  if (journal.newHead !== null) {
    if (currentHead !== journal.newHead) {
      throw new Error('Replica recovery found an unexpected Git HEAD.');
    }
    return journal.newHead;
  }
  const commit = await git.readCommit({ fs, dir: repoPath, oid: currentHead });
  if (commit.commit.parent.length !== 1 || commit.commit.parent[0] !== journal.oldHead) {
    throw new Error('Replica recovery found an unjournaled Git history change.');
  }
  for (const file of journal.installs) {
    if ((await readRegularFileHash(repoPath, file.relativePath, journal.version)) !== file.sha256) {
      throw new Error(
        'Replica recovery could not prove the unjournaled commit belongs to the pull.'
      );
    }
  }
  return currentHead;
}

async function readRegularFileHash(
  root: string,
  relativePath: string,
  journalVersion: ReplicaPullJournal['version']
): Promise<string> {
  const path = resolveInsideWithoutSymlinkAncestors(root, relativePath);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Replica recovery path is not a regular file: ${path}`);
  }
  return journalVersion === LEGACY_TEXT_HASH_JOURNAL_VERSION
    ? replicaJournalHash(readFileSync(path, 'utf8'))
    : (await hashWorkspaceSyncFileOnDisk(path)).sha256;
}

function resolveInsideWithoutSymlinkAncestors(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, relativePath);
  const relativePathFromRoot = relative(resolvedRoot, path);
  if (
    relativePathFromRoot === '..' ||
    relativePathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativePathFromRoot)
  ) {
    throw new Error('Replica recovery path escapes its root.');
  }
  const segments = relativePathFromRoot.split(sep).filter(Boolean);
  let current = resolvedRoot;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Replica recovery path has an unsafe ancestor: ${current}`);
    }
  }
  return path;
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../');
}

function isGitOid(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removeStagingBestEffort(stagingRoot: string): void {
  try {
    rmSync(stagingRoot, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[workspace-sync] Could not remove reconciled replica staging at ${stagingRoot}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}
