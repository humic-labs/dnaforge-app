import fs, { existsSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import git from 'isomorphic-git';

import type { ProjectionReceipt } from '../../shared/benchling-migration';
import {
  BENCHLING_MIGRATION_INSTALL_STATES,
  type BenchlingMigrationActionAllocation,
  type BenchlingMigrationActionJournal,
  type BenchlingMigrationInstallState,
} from '../../shared/benchling-migration-action-journal';
import { NATIVE_WORKSPACE_MANIFEST_PATH } from '../../shared/native-workspace-manifest';
import { commitOwnedPathsIfDirty, resolveHeadCommit } from '../workspace-git';
import {
  advancePersistedBenchlingMigrationAllocations,
  readBenchlingMigrationActionJournal,
  recordBenchlingMigrationActionCommittedHead,
  recordBenchlingMigrationActionComplete,
} from './action-journal';
import { fingerprintExistingDestination } from './destination-name-allocator';
import { verifyExternalZipSource } from './external-zip-source';
import { assertProjectionReceiptDestinationIntegrity } from './projection-writer';
import { discardActionLimsStaging, verifiedActionLimsPaths } from './generated-lims-publication';

export type BenchlingMigrationActionRecoveryCode =
  | 'source_integrity'
  | 'destination_integrity'
  | 'catalog_integrity'
  | 'catalog_commit_uncertain'
  | 'manifest_integrity'
  | 'git_integrity'
  | 'recovery_incomplete';

export class BenchlingMigrationActionRecoveryError extends Error {
  constructor(
    readonly code: BenchlingMigrationActionRecoveryCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'BenchlingMigrationActionRecoveryError';
  }
}

export type BenchlingMigrationActionRecoveryResult = Readonly<
  | { kind: 'complete'; journal: BenchlingMigrationActionJournal }
  | { kind: 'resume_required'; journal: BenchlingMigrationActionJournal }
>;

export type BenchlingMigrationActionRecoveryDeps = Readonly<{
  receipts: readonly ProjectionReceipt[];
  assertMutationLeaseHeld: () => void;
  completeCatalog: (
    journal: BenchlingMigrationActionJournal,
    allocations: readonly BenchlingMigrationActionAllocation[]
  ) => void | Promise<void>;
  mergeManifest: (
    journal: BenchlingMigrationActionJournal,
    allocations: readonly BenchlingMigrationActionAllocation[]
  ) => void | Promise<void>;
  verifyCatalogManifestAgreement: (
    journal: BenchlingMigrationActionJournal,
    allocations: readonly BenchlingMigrationActionAllocation[]
  ) => void | Promise<void>;
  now?: () => string;
  verifyExternalSource?: typeof verifyExternalZipSource;
}>;

const STATE_RANK = new Map(
  BENCHLING_MIGRATION_INSTALL_STATES.map((state, index) => [state, index])
);

export async function recoverBenchlingMigrationAction(
  workspacePath: string,
  actionId: string,
  deps: BenchlingMigrationActionRecoveryDeps
): Promise<BenchlingMigrationActionRecoveryResult> {
  deps.assertMutationLeaseHeld();
  let journal = await readBenchlingMigrationActionJournal(workspacePath, actionId);
  if (!journal) throw integrity('destination_integrity', 'Migration action journal is missing.');
  assertJournalOwner(workspacePath, journal);

  const emptyActionPending = journal.allocations.length === 0 && !journal.completedAt;
  if (
    !emptyActionPending &&
    journal.allocations.every((allocation) => allocation.installState === 'complete')
  ) {
    await assertCompletedGitBoundary(workspacePath, journal);
    journal = await recordBenchlingMigrationActionComplete(
      journal,
      (deps.now ?? (() => new Date().toISOString()))()
    );
    await discardActionLimsStaging(workspacePath, journal.actionId);
    return { kind: 'complete', journal };
  }

  try {
    await (deps.verifyExternalSource ?? verifyExternalZipSource)(journal.externalSource);
  } catch (error) {
    throw integrity(
      'source_integrity',
      'Migration source fingerprint is unavailable or changed.',
      error
    );
  }

  const resumable = journal.allocations.filter((allocation) =>
    isBefore(allocation.installState, 'installed')
  );
  if (resumable.length > 0) {
    await discardHiddenActionTemps(workspacePath, resumable);
    return { kind: 'resume_required', journal };
  }

  await verifyInstalledAllocations(workspacePath, journal, deps.receipts);
  await verifyDisplacedRootOwnership(workspacePath, journal.allocations);

  const installed = allocationsAt(journal, 'installed');
  if (installed.length > 0 || emptyActionPending) {
    try {
      await deps.completeCatalog(journal, installed);
    } catch (error) {
      if (
        error instanceof BenchlingMigrationActionRecoveryError &&
        error.code === 'catalog_commit_uncertain'
      )
        throw error;
      throw integrity(
        'catalog_integrity',
        'Migration catalog transaction did not complete.',
        error
      );
    }
    try {
      journal = await advanceAllocations(
        workspacePath,
        journal,
        installed,
        'catalog_committed',
        deps
      );
    } catch (error) {
      throw integrity(
        'catalog_commit_uncertain',
        'Catalog committed but its journal boundary could not be recorded. Resume without restoring displaced paths.',
        error
      );
    }
  }

  const catalogCommitted = allocationsAt(journal, 'catalog_committed');
  if (catalogCommitted.length > 0 || emptyActionPending) {
    try {
      await deps.mergeManifest(journal, catalogCommitted);
    } catch (error) {
      throw integrity('manifest_integrity', 'Migration manifest merge did not complete.', error);
    }
    journal = await advanceAllocations(
      workspacePath,
      journal,
      catalogCommitted,
      'manifest_committed',
      deps
    );
  }

  const manifestCommitted = allocationsAt(journal, 'manifest_committed');
  if (manifestCommitted.length > 0 || emptyActionPending) {
    try {
      await deps.verifyCatalogManifestAgreement(journal, manifestCommitted);
    } catch (error) {
      throw integrity(
        'manifest_integrity',
        'Migration filesystem, catalog, and manifest disagree.',
        error
      );
    }
    journal = await publishOwnedGitBoundary(workspacePath, journal, deps);
    journal = await advanceAllocations(workspacePath, journal, manifestCommitted, 'complete', deps);
  }

  if (!journal.allocations.every((allocation) => allocation.installState === 'complete')) {
    throw integrity('recovery_incomplete', 'Migration action recovery stopped before completion.');
  }
  journal = await recordBenchlingMigrationActionComplete(
    journal,
    (deps.now ?? (() => new Date().toISOString()))()
  );
  await discardDisplacementBackups(workspacePath, journal.allocations);
  await discardActionLimsStaging(workspacePath, journal.actionId);
  return { kind: 'complete', journal };
}

async function verifyInstalledAllocations(
  workspacePath: string,
  journal: BenchlingMigrationActionJournal,
  receipts: readonly ProjectionReceipt[]
): Promise<void> {
  const receiptBySource = new Map(receipts.map((receipt) => [receipt.sourceObjectId, receipt]));
  for (const allocation of journal.allocations) {
    const receipt = receiptBySource.get(allocation.sourceObjectId);
    if (!receipt) {
      throw integrity(
        'destination_integrity',
        `Installed migration receipt is missing: ${allocation.sourceObjectId}`
      );
    }
    if (
      receipt.destinationObjectId !== allocation.destinationEntityId ||
      JSON.stringify(receipt.destination) !== JSON.stringify(allocation.destination)
    ) {
      throw integrity(
        'destination_integrity',
        `Installed migration identity changed: ${allocation.sourceObjectId}`
      );
    }
    try {
      await assertProjectionReceiptDestinationIntegrity({ workspacePath, receipt });
    } catch (error) {
      throw integrity(
        'recovery_incomplete',
        `Installed migration bytes changed after publication: ${allocation.sourceObjectId}`,
        error
      );
    }
    if (allocation.rollback.kind === 'displaced') {
      const backup = await fingerprintExistingDestination(
        workspacePath,
        allocation.rollback.backupRelativePath
      );
      if (JSON.stringify(backup) !== JSON.stringify(allocation.rollback.expectedExistingState)) {
        throw integrity(
          'destination_integrity',
          `Migration displacement backup changed: ${allocation.sourceObjectId}`
        );
      }
    }
  }
}

async function publishOwnedGitBoundary(
  workspacePath: string,
  journal: BenchlingMigrationActionJournal,
  deps: BenchlingMigrationActionRecoveryDeps
): Promise<BenchlingMigrationActionJournal> {
  const generatedPaths = await verifiedActionLimsPaths(workspacePath, journal.actionId);
  if (journal.durability.kind === 'local_filesystem') return journal;
  if (journal.durability.committedHead) {
    await assertCompletedGitBoundary(workspacePath, journal);
    return journal;
  }

  const currentHead = await resolveHeadCommit(workspacePath);
  const ownedPaths = [...portableOwnedPaths(journal.allocations), ...generatedPaths];
  if (currentHead !== journal.durability.preActionHead) {
    if (
      currentHead &&
      (await isRecoveredOwnedCommit(
        workspacePath,
        currentHead,
        journal.durability.preActionHead,
        journal.actionId,
        ownedPaths
      ))
    ) {
      return recordBenchlingMigrationActionCommittedHead({
        workspacePath,
        actionId: journal.actionId,
        expectedPreActionHead: journal.durability.preActionHead,
        committedHead: currentHead,
        updatedAt: now(deps),
      });
    }
    throw integrity('git_integrity', 'Managed project HEAD changed during migration recovery.');
  }
  let committedHead: string;
  try {
    committedHead =
      (await commitOwnedPathsIfDirty(workspacePath, `Import Benchling action ${journal.actionId}`, {
        paths: ownedPaths,
        expectedHead: journal.durability.preActionHead,
      })) ?? journal.durability.preActionHead;
  } catch (error) {
    throw integrity('git_integrity', 'Owned-path Git publication failed.', error);
  }
  return recordBenchlingMigrationActionCommittedHead({
    workspacePath,
    actionId: journal.actionId,
    expectedPreActionHead: journal.durability.preActionHead,
    committedHead,
    updatedAt: now(deps),
  });
}

async function isRecoveredOwnedCommit(
  workspacePath: string,
  currentHead: string,
  expectedParent: string,
  actionId: string,
  ownedPaths: readonly string[]
): Promise<boolean> {
  const commit = await git.readCommit({ fs, dir: workspacePath, oid: currentHead });
  if (
    commit.commit.parent.length !== 1 ||
    commit.commit.parent[0] !== expectedParent ||
    commit.commit.message.trim() !== `Import Benchling action ${actionId}`
  ) {
    return false;
  }
  const matrix = await git.statusMatrix({
    fs,
    dir: workspacePath,
    filepaths: [...ownedPaths],
    ignored: true,
  });
  return matrix.every(([, head, workdir]) => head === workdir);
}

async function assertCompletedGitBoundary(
  workspacePath: string,
  journal: BenchlingMigrationActionJournal
): Promise<void> {
  if (journal.durability.kind !== 'managed_git') return;
  if (!journal.durability.committedHead) {
    throw integrity('git_integrity', 'Completed migration action has no committed HEAD.');
  }
  try {
    await git.readCommit({ fs, dir: workspacePath, oid: journal.durability.committedHead });
  } catch (error) {
    throw integrity(
      'git_integrity',
      'Completed migration action commit is no longer available in the project repository.',
      error
    );
  }
}

function portableOwnedPaths(allocations: readonly BenchlingMigrationActionAllocation[]): string[] {
  const paths = new Set<string>([NATIVE_WORKSPACE_MANIFEST_PATH]);
  for (const allocation of allocations) {
    if (allocation.rollback.kind === 'displaced') paths.add(allocation.rollback.targetRelativePath);
    for (const path of allocation.actionOwnedPaths) {
      if (!path.toLowerCase().startsWith('.dnaforge/')) paths.add(path);
    }
  }
  return [...paths].sort();
}

async function verifyDisplacedRootOwnership(
  workspacePath: string,
  allocations: readonly BenchlingMigrationActionAllocation[]
): Promise<void> {
  const roots = new Set(
    allocations.flatMap((allocation) =>
      allocation.rollback.kind === 'displaced' ? [allocation.rollback.targetRelativePath] : []
    )
  );
  const allowed = allocations.flatMap((allocation) => {
    switch (allocation.destination.kind) {
      case 'file':
        return [{ path: allocation.destination.relativePath, directory: false }];
      case 'package':
        return [{ path: allocation.destination.rootRelativePath, directory: true }];
      case 'catalog-record':
        return [];
    }
  });
  const visit = async (path: string): Promise<void> => {
    const stats = await lstat(join(workspacePath, path));
    if (stats.isSymbolicLink())
      throw integrity('destination_integrity', 'Displaced parent contains a symbolic link.');
    if (stats.isDirectory()) {
      for (const name of await readdir(join(workspacePath, path))) await visit(`${path}/${name}`);
    } else if (
      !stats.isFile() ||
      !allowed.some(
        (entry) => path === entry.path || (entry.directory && path.startsWith(`${entry.path}/`))
      )
    ) {
      throw integrity(
        'destination_integrity',
        'Displaced parent contains a file outside this action.'
      );
    }
  };
  for (const root of roots) await visit(root);
}

async function advanceAllocations(
  workspacePath: string,
  journal: BenchlingMigrationActionJournal,
  allocations: readonly BenchlingMigrationActionAllocation[],
  nextState: BenchlingMigrationInstallState,
  deps: BenchlingMigrationActionRecoveryDeps
): Promise<BenchlingMigrationActionJournal> {
  return advancePersistedBenchlingMigrationAllocations({
    workspacePath,
    actionId: journal.actionId,
    sourceObjectIds: allocations.map((allocation) => allocation.sourceObjectId),
    nextState,
    updatedAt: now(deps),
  });
}

async function discardHiddenActionTemps(
  workspacePath: string,
  allocations: readonly BenchlingMigrationActionAllocation[]
): Promise<void> {
  await rm(join(workspacePath, '.dnaforge', 'migration', 'projection-staging'), {
    recursive: true,
    force: true,
  });
  for (const allocation of allocations) {
    const destinationPath =
      allocation.destination.kind === 'file' ? allocation.destination.relativePath : null;
    if (!destinationPath) continue;
    const parent = join(workspacePath, dirname(destinationPath));
    if (!existsSync(parent)) continue;
    const prefix = `.${basename(destinationPath)}.`;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.startsWith(prefix) &&
        entry.name.endsWith('.dnaforge-migration.tmp')
      ) {
        await rm(join(parent, entry.name), { force: true });
      }
    }
  }
}

async function discardDisplacementBackups(
  workspacePath: string,
  allocations: readonly BenchlingMigrationActionAllocation[]
): Promise<void> {
  for (const allocation of allocations) {
    if (allocation.rollback.kind !== 'displaced') continue;
    await rm(join(workspacePath, allocation.rollback.backupRelativePath), {
      recursive: true,
      force: true,
    });
  }
}

function allocationsAt(
  journal: BenchlingMigrationActionJournal,
  state: BenchlingMigrationInstallState
): BenchlingMigrationActionAllocation[] {
  return journal.allocations.filter((allocation) => allocation.installState === state);
}

function isBefore(
  current: BenchlingMigrationInstallState,
  boundary: BenchlingMigrationInstallState
): boolean {
  return (STATE_RANK.get(current) ?? -1) < (STATE_RANK.get(boundary) ?? -1);
}

function assertJournalOwner(workspacePath: string, journal: BenchlingMigrationActionJournal): void {
  if (resolve(journal.workspace.workspacePath) !== resolve(workspacePath)) {
    throw integrity('destination_integrity', 'Migration action project identity changed.');
  }
}

function now(deps: BenchlingMigrationActionRecoveryDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function integrity(
  code: BenchlingMigrationActionRecoveryCode,
  message: string,
  cause?: unknown
): BenchlingMigrationActionRecoveryError {
  return new BenchlingMigrationActionRecoveryError(code, message, cause);
}
