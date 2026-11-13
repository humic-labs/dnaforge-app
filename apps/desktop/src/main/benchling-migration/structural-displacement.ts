import { lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ProjectionReceipt } from '../../shared/benchling-migration';
import type {
  BenchlingMigrationActionAllocation,
  BenchlingMigrationRollbackState,
} from '../../shared/benchling-migration-action-journal';
import { fingerprintExistingDestination } from './destination-name-allocator';
import { assertProjectionReceiptDestinationIntegrity } from './projection-writer';

type Displaced = Extract<BenchlingMigrationRollbackState, { kind: 'displaced' }>;

export async function prepareStructuralParentReplacements(
  workspacePath: string,
  allocations: readonly BenchlingMigrationActionAllocation[]
): Promise<void> {
  for (const rollback of parentDisplacements(allocations)) {
    await verifyParents(workspacePath, rollback.targetRelativePath);
    await verifyParents(workspacePath, rollback.backupRelativePath);
    const backup = await fingerprintExistingDestination(workspacePath, rollback.backupRelativePath);
    const target = await fingerprintExistingDestination(workspacePath, rollback.targetRelativePath);
    if (backup) {
      if (
        JSON.stringify(backup) !== JSON.stringify(rollback.expectedExistingState) ||
        (target !== null && target.kind !== 'directory')
      ) {
        throw new Error('Structural parent replacement no longer matches its journal.');
      }
    } else {
      if (JSON.stringify(target) !== JSON.stringify(rollback.expectedExistingState)) {
        throw new Error('Structural parent replacement changed after it was reviewed.');
      }
      await mkdir(dirname(join(workspacePath, rollback.backupRelativePath)), { recursive: true });
      await rename(
        join(workspacePath, rollback.targetRelativePath),
        join(workspacePath, rollback.backupRelativePath)
      );
    }
    await mkdir(join(workspacePath, rollback.targetRelativePath), { recursive: true });
  }
}

export async function restoreStructuralParentReplacements(
  workspacePath: string,
  allocations: readonly BenchlingMigrationActionAllocation[],
  receipts: readonly ProjectionReceipt[]
): Promise<void> {
  const displacements = new Map<string, Displaced>();
  for (const allocation of allocations) {
    if (allocation.rollback.kind === 'displaced')
      displacements.set(allocation.rollback.targetRelativePath, allocation.rollback);
  }
  for (const rollback of displacements.values()) {
    const backup = await fingerprintExistingDestination(workspacePath, rollback.backupRelativePath);
    if (!backup) continue;
    if (JSON.stringify(backup) !== JSON.stringify(rollback.expectedExistingState)) {
      throw new Error('Structural rollback backup changed; the backup was preserved.');
    }
    const ownedReceipts = receipts.filter((receipt) =>
      allocations.some(
        (allocation) =>
          allocation.sourceObjectId === receipt.sourceObjectId &&
          allocation.destinationEntityId === receipt.destinationObjectId
      )
    );
    const ownedRoots = ownedReceipts.flatMap((receipt) => {
      const destination = receipt.destination;
      if (!destination || destination.kind === 'catalog-record') return [];
      const root =
        destination.kind === 'file' ? destination.relativePath : destination.rootRelativePath;
      return root === rollback.targetRelativePath ||
        root.startsWith(`${rollback.targetRelativePath}/`)
        ? [root]
        : [];
    });
    for (const receipt of ownedReceipts) {
      const destination = receipt.destination;
      const root =
        destination?.kind === 'file'
          ? destination.relativePath
          : destination?.kind === 'package'
            ? destination.rootRelativePath
            : null;
      if (root && ownedRoots.includes(root))
        await assertProjectionReceiptDestinationIntegrity({ workspacePath, receipt });
    }
    const files: string[] = [];
    const directories: string[] = [];
    const visit = async (path: string): Promise<void> => {
      const stats = await lstat(join(workspacePath, path));
      if (stats.isSymbolicLink())
        throw new Error('Structural rollback found a symbolic link; the backup was preserved.');
      const owned = ownedRoots.some((root) => path === root || path.startsWith(`${root}/`));
      if (stats.isFile()) {
        if (!owned)
          throw new Error('Structural rollback found unrelated data; the backup was preserved.');
        files.push(path);
      } else if (stats.isDirectory()) {
        if (
          path !== rollback.targetRelativePath &&
          !owned &&
          !ownedRoots.some((root) => root.startsWith(`${path}/`))
        ) {
          throw new Error(
            'Structural rollback found an unrelated directory; the backup was preserved.'
          );
        }
        for (const entry of await readdir(join(workspacePath, path)))
          await visit(`${path}/${entry}`);
        directories.push(path);
      } else throw new Error('Structural rollback found an unsupported file type.');
    };
    const target = await fingerprintExistingDestination(workspacePath, rollback.targetRelativePath);
    if (target) await visit(rollback.targetRelativePath);
    for (const file of files) await rm(join(workspacePath, file));
    for (const directory of directories) await rmdir(join(workspacePath, directory));
    await rename(
      join(workspacePath, rollback.backupRelativePath),
      join(workspacePath, rollback.targetRelativePath)
    );
  }
}

function parentDisplacements(
  allocations: readonly BenchlingMigrationActionAllocation[]
): Displaced[] {
  const result = new Map<string, Displaced>();
  for (const allocation of allocations) {
    if (allocation.rollback.kind !== 'displaced') continue;
    const destination = allocation.destination;
    const root =
      destination.kind === 'file'
        ? destination.relativePath
        : destination.kind === 'package'
          ? destination.rootRelativePath
          : destination.parentRelativePath;
    if (
      root.startsWith(`${allocation.rollback.targetRelativePath}/`) ||
      (destination.kind === 'catalog-record' && root === allocation.rollback.targetRelativePath)
    ) {
      result.set(allocation.rollback.targetRelativePath, allocation.rollback);
    }
  }
  return [...result.values()];
}

async function verifyParents(workspacePath: string, relativePath: string): Promise<void> {
  const segments = relativePath.split('/');
  for (let count = 1; count < segments.length; count += 1) {
    try {
      const stats = await lstat(join(workspacePath, ...segments.slice(0, count)));
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new Error('Structural displacement parent is not a regular directory.');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }
}
