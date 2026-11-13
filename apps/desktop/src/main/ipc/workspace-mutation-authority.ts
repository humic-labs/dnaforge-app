import { assertWorkspaceWriteAllowed } from '../workspace-write-admission';
import type Database from 'better-sqlite3';

import {
  findKnownWorkspaceRoot,
  withKnownWorkspacePathMutation,
  workspaceMutationRootIdentity,
  tryAcquireWorkspaceMutationShared,
  withKnownWorkspacePathsMutationAcrossWorkspaces,
} from '../workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from './workspace-mutation-capability';
import { recoverNativeCatalogRecordPublications } from '../native-catalog-record-mutations';
import {
  assertRendererDatabaseStatementAllowed,
  notifyRendererDatabaseStatementSettled,
} from '../workspace-sync-database-fence';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import {
  assertUnversionedSequencePackageMutationAllowed,
  createRegisteredSequencePackagePublicationContext,
} from '../sequence-package-registry-publication';
import { assertEnrolledPrimerPathMutationAllowed } from '../primer-artifact-mutation-guard';
import { assertWorkspaceMigrationActionsSettled } from '../workspace-migration-admission';
import { assertProjectFilesystemMutationAllowed } from '../project-filesystem-authority';

interface DeclaredRendererWorkspaceMutationInput<T> {
  db: Database.Database;
  ownerId: number;
  workspaceRoot: string;
  mutationPaths?: readonly string[];

  additionalWorkspacePaths?: readonly string[];
  mutationToken?: string;
  operation: (lease?: () => void) => Promise<T>;
  fileWrite?: boolean;
}

export async function withDeclaredRendererWorkspaceMutation<T>(
  input: DeclaredRendererWorkspaceMutationInput<T>
): Promise<T> {
  const writePaths = input.mutationPaths?.length ? input.mutationPaths : [input.workspaceRoot];
  if (input.fileWrite) assertWorkspaceWriteAllowed(input.db, writePaths);
  const owningRoot = findKnownWorkspaceRoot(input.db, input.workspaceRoot);
  if (!owningRoot) throw new Error('WORKSPACE_MUTATION_UNKNOWN_WORKSPACE');
  for (const path of input.mutationPaths ?? []) {
    if (findKnownWorkspaceRoot(input.db, path) !== owningRoot) {
      throw new Error('WORKSPACE_MUTATION_DECLARED_ROOT_MISMATCH');
    }
  }
  const roots = [
    ...new Set([
      owningRoot,
      ...(input.additionalWorkspacePaths ?? [])
        .map((path) => findKnownWorkspaceRoot(input.db, path))
        .filter((root): root is string => root !== null),
    ]),
  ].sort();
  const operation = async (lease?: () => void) => {
    if (input.fileWrite) assertWorkspaceWriteAllowed(input.db, writePaths);
    for (const root of roots) {
      await assertWorkspaceMigrationActionsSettled(root);
      await recoverNativeCatalogRecordPublications({
        db: input.db,
        workspacePath: root,
        runDatabase: (run) => {
          assertRendererDatabaseStatementAllowed(input.db, input.ownerId);
          return run();
        },
      });
    }
    return input.operation(lease);
  };
  if (input.mutationToken) {
    const reentry = await workspaceMutationCapabilities.runWithToken(
      input.mutationToken,
      input.ownerId,
      owningRoot,
      async () => {
        const releases: Array<() => void> = [];
        try {
          for (const root of roots) {
            if (root === owningRoot) continue;
            const release = tryAcquireWorkspaceMutationShared(root);
            if (!release)
              throw new Error('WORKSPACE_MUTATION_ADDITIONAL_ROOT_BUSY: Retry catalog binding.');
            releases.push(release);
          }
          return await operation();
        } finally {
          for (const release of releases.reverse()) release();
        }
      }
    );
    if (!reentry.active) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
    return reentry.value;
  }
  return withKnownWorkspacePathsMutationAcrossWorkspaces(input.db, roots, (leases) =>
    operation(leases.get(owningRoot))
  );
}

async function assertScientificFilesystemMutationAllowed(
  db: Database.Database,
  ownerId: number,
  paths: readonly string[]
): Promise<void> {
  const runDatabase = <T>(work: () => T): T => {
    assertRendererDatabaseStatementAllowed(db, ownerId);
    try {
      return work();
    } finally {
      notifyRendererDatabaseStatementSettled(db);
    }
  };
  await assertUnversionedSequencePackageMutationAllowed(
    createRegisteredSequencePackagePublicationContext({ db, runDatabase }),
    paths
  );
  runDatabase(() => assertEnrolledPrimerPathMutationAllowed(db, paths));
}

export async function assertUnversionedRendererFilesystemMutationAllowed(
  db: Database.Database,
  ownerId: number,
  paths: readonly string[]
): Promise<void> {
  await assertScientificFilesystemMutationAllowed(db, ownerId, paths);
  await assertProjectFilesystemMutationAllowed(db, paths);
}

export async function assertWorkspaceFileTrashMutationAllowed(
  db: Database.Database,
  ownerId: number,
  paths: readonly string[],
  contentPaths: readonly string[]
): Promise<void> {
  await assertScientificFilesystemMutationAllowed(db, ownerId, paths);
  await assertProjectFilesystemMutationAllowed(db, contentPaths);
}

export function withDeclaredRendererFilesystemMutation<T>(
  input: DeclaredRendererWorkspaceMutationInput<T>
): Promise<T> {
  return withDeclaredRendererWorkspaceMutation({
    ...input,
    operation: async () => {
      await assertUnversionedRendererFilesystemMutationAllowed(
        input.db,
        input.ownerId,
        input.mutationPaths ?? [input.workspaceRoot]
      );
      return input.operation();
    },
  });
}

export async function withKnownRendererFilesystemMutation<T>(input: {
  db: Database.Database;
  ownerId: number;
  paths: readonly string[];
  mutationToken?: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const { db, ownerId, paths, mutationToken } = input;
  assertRendererDatabaseStatementAllowed(db, ownerId);
  const directRoots = paths.map((path) => findKnownWorkspaceRoot(db, path));

  const canonicalPaths = paths.map(workspaceMutationRootIdentity);
  const containingProjects = (
    db
      .prepare(
        `SELECT path FROM workspaces WHERE path IS NOT NULL AND archived_at IS NULL AND trashed_at IS NULL`
      )
      .all() as Array<{ path: string }>
  )
    .map((row) => workspaceMutationRootIdentity(row.path))
    .filter((root) => canonicalPaths.some((path) => isPathInsideBoundary(root, path)));
  const roots = [...new Set([...directRoots, ...containingProjects])].filter(
    (root): root is string => root !== null
  );
  if (roots.length > 1) throw new Error('WORKSPACE_MUTATION_CROSSES_KNOWN_WORKSPACES');
  const operation = async () => {
    await assertUnversionedRendererFilesystemMutationAllowed(db, ownerId, paths);
    return input.operation();
  };
  if (mutationToken) {
    if (!roots[0]) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
    const reentry = await workspaceMutationCapabilities.runWithToken(
      mutationToken,
      ownerId,
      roots[0],
      operation
    );
    if (!reentry.active) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
    return reentry.value;
  }
  return withKnownWorkspacePathMutation(db, roots.length ? roots : paths, operation);
}
