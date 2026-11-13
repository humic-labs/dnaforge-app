import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  MigrationIssue,
  MigrationRun,
  ProjectionReceipt,
  ValidationDestinationArtifactEvidence,
} from '../../shared/benchling-migration';
import { parseBenchlingMigrationActionJournal } from '../../shared/benchling-migration-action-journal';
import { benchlingMigrationActionJournalRelativePath } from './action-journal';

const LEGACY_INSTALLED_PROJECTION_PATHS = [
  { relativePath: 'Benchling Imports', kind: 'directory' },
  { relativePath: '.dnaforge/migration/registry-projections', kind: 'directory' },
  { relativePath: '.dnaforge/migration/collection-projection.json', kind: 'file' },
  { relativePath: '.dnaforge/migration/destination-link-index.v1.json', kind: 'file' },
] as const;

type ProjectionContractRestartReason =
  | 'run_version_mismatch'
  | 'receipt_version_mismatch'
  | 'unreceipted_projection_entries';

export class ProjectionContractRestartRequiredError extends Error {
  readonly code = 'projection_contract_restart_required' as const;

  constructor(
    readonly reason: ProjectionContractRestartReason,
    readonly expectedVersion: string
  ) {
    super(restartMessage(reason, expectedVersion));
    this.name = 'ProjectionContractRestartRequiredError';
  }
}

export function projectionContractRestartIssue(
  error: ProjectionContractRestartRequiredError
): MigrationIssue {
  return {
    code: error.code,
    message: error.message,
    blocking: true,
    details: {
      reason: error.reason,
    },
  };
}

export function assertProjectionContractResumeSafe(input: {
  run: MigrationRun;
  receipts: readonly ProjectionReceipt[];
  expectedVersion: string;
  provenZeroSourceProjection?: {
    sourceObjectCount: 0;
    destinationArtifacts: readonly ValidationDestinationArtifactEvidence[];
  };
}): void {
  if (input.receipts.length === 0) {
    const actionJournal = readActionJournalIfPresent(input.run.workspacePath, input.run.id);
    if (actionJournal) {
      if (input.run.converterVersions.projection !== input.expectedVersion) {
        throw new ProjectionContractRestartRequiredError(
          'run_version_mismatch',
          input.expectedVersion
        );
      }
      return;
    }
    const installedProjectionState = inspectInstalledProjectionEntries(input.run.workspacePath);
    if (installedProjectionState !== 'none') {
      const currentZeroSourceProjection =
        installedProjectionState === 'safe' &&
        input.provenZeroSourceProjection?.sourceObjectCount === 0 &&
        input.run.converterVersions.projection === input.expectedVersion &&
        matchesClosedWorldZeroSourceProjection(
          input.run.workspacePath,
          input.provenZeroSourceProjection.destinationArtifacts
        );
      if (currentZeroSourceProjection) return;
      if (
        input.provenZeroSourceProjection?.sourceObjectCount === 0 &&
        input.run.converterVersions.projection !== input.expectedVersion
      ) {
        throw new ProjectionContractRestartRequiredError(
          'run_version_mismatch',
          input.expectedVersion
        );
      }
      throw new ProjectionContractRestartRequiredError(
        'unreceipted_projection_entries',
        input.expectedVersion
      );
    }
    return;
  }

  const mismatchedReceipt = input.receipts.find(
    (receipt) => receipt.converterVersion !== input.expectedVersion
  );
  if (mismatchedReceipt) {
    throw new ProjectionContractRestartRequiredError(
      'receipt_version_mismatch',
      input.expectedVersion
    );
  }
  if (input.run.converterVersions.projection !== input.expectedVersion) {
    throw new ProjectionContractRestartRequiredError('run_version_mismatch', input.expectedVersion);
  }
}

type InstalledProjectionState = 'none' | 'safe' | 'unsafe';

function inspectInstalledProjectionEntries(workspacePathInput: string): InstalledProjectionState {
  const workspacePath = resolve(workspacePathInput);
  let found = false;
  for (const installedPath of LEGACY_INSTALLED_PROJECTION_PATHS) {
    let currentPath = workspacePath;
    const segments = installedPath.relativePath.split('/');
    for (const [index, segment] of segments.entries()) {
      currentPath = join(currentPath, segment);
      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(currentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
      if (stats.isSymbolicLink() || (index < segments.length - 1 && !stats.isDirectory())) {
        return 'unsafe';
      }
      if (index === segments.length - 1) {
        const expectedShape =
          installedPath.kind === 'directory' ? stats.isDirectory() : stats.isFile();
        if (!expectedShape) return 'unsafe';
        found = true;
      }
    }
  }
  return found ? 'safe' : 'none';
}

function readActionJournalIfPresent(workspacePath: string, actionId: string) {
  try {
    return parseBenchlingMigrationActionJournal(
      JSON.parse(
        readFileSync(
          join(workspacePath, benchlingMigrationActionJournalRelativePath(actionId)),
          'utf8'
        )
      )
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function matchesClosedWorldZeroSourceProjection(
  workspacePathInput: string,
  artifactsInput: readonly ValidationDestinationArtifactEvidence[]
): boolean {
  try {
    const workspacePath = resolve(workspacePathInput);
    const artifacts = [...artifactsInput];
    const artifactPaths = artifacts.map((artifact) => artifact.path);
    if (new Set(artifactPaths).size !== artifactPaths.length) return false;

    const collectionManifest = artifacts.filter(
      (artifact) => artifact.kind === 'collection_projection_manifest'
    );
    const destinationIndex = artifacts.filter(
      (artifact) => artifact.kind === 'destination_link_index'
    );
    const nativeCollections = artifacts.filter((artifact) => artifact.kind === 'native_collection');
    const nativeFolders = artifacts.filter((artifact) => artifact.kind === 'native_folder');
    if (
      collectionManifest.length !== 1 ||
      collectionManifest[0]?.path !== '.dnaforge/migration/collection-projection.json' ||
      destinationIndex.length !== 1 ||
      destinationIndex[0]?.path !== '.dnaforge/migration/destination-link-index.v1.json' ||
      nativeCollections.length === 0 ||
      nativeFolders.length !== nativeCollections.length ||
      artifacts.length !== nativeCollections.length + nativeFolders.length + 2
    ) {
      return false;
    }

    const collectionFiles = nativeCollections.map((artifact) => artifact.path);
    const folderFiles = nativeFolders.map((artifact) => artifact.path);
    if (!collectionFiles.every(isNativeCollectionDocumentPath)) return false;
    if (!folderFiles.every(isNativeFolderKeepPath)) return false;
    const expectedImportFiles = [...collectionFiles, ...folderFiles].sort();
    const expectedImportDirectories = projectionDirectoriesForFiles(
      'Benchling Imports',
      expectedImportFiles
    );
    const actualImports = listRegularTree(workspacePath, 'Benchling Imports');
    if (
      !sameStringArray(actualImports.files, expectedImportFiles) ||
      !sameStringArray(actualImports.directories, expectedImportDirectories)
    ) {
      return false;
    }

    const registryTree = listRegularTreeIfPresent(
      workspacePath,
      '.dnaforge/migration/registry-projections'
    );
    if (
      registryTree &&
      (registryTree.files.length !== 0 ||
        !sameStringArray(registryTree.directories, ['.dnaforge/migration/registry-projections']))
    ) {
      return false;
    }

    for (const artifact of artifacts) {
      if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) return false;
      const path = resolve(workspacePath, artifact.path);
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== artifact.sha256) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isNativeCollectionDocumentPath(path: string): boolean {
  const match =
    /^Benchling Imports\/Collections\/(folder-[a-f0-9]{24})\/([^/]+)\.dnaforge-collection\.json$/u.exec(
      path
    );
  return Boolean(match && match[1] === match[2]);
}

function isNativeFolderKeepPath(path: string): boolean {
  return (
    path.startsWith('Benchling Imports/Folders/') &&
    path.endsWith('/.gitkeep') &&
    !path.split('/').some((segment) => segment === '..' || segment === '')
  );
}

function projectionDirectoriesForFiles(root: string, files: readonly string[]): string[] {
  const directories = new Set([root]);
  for (const file of files) {
    let directory = dirname(file).replaceAll('\\', '/');
    while (directory === root || directory.startsWith(`${root}/`)) {
      directories.add(directory);
      if (directory === root) break;
      directory = dirname(directory).replaceAll('\\', '/');
    }
  }
  return [...directories].sort();
}

function listRegularTreeIfPresent(
  workspacePath: string,
  relativeRoot: string
): { files: string[]; directories: string[] } | null {
  try {
    lstatSync(resolve(workspacePath, relativeRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return listRegularTree(workspacePath, relativeRoot);
}

function listRegularTree(
  workspacePath: string,
  relativeRoot: string
): { files: string[]; directories: string[] } {
  const rootPath = resolve(workspacePath, relativeRoot);
  const rootStats = lstatSync(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('Projection root is not a regular directory.');
  }
  const files: string[] = [];
  const directories = [relativeRoot];
  const visit = (relativeDirectory: string): void => {
    const entries = readdirSync(resolve(workspacePath, relativeDirectory), {
      withFileTypes: true,
    }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const stats = lstatSync(resolve(workspacePath, relativePath));
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw new Error('Projection tree contains a symlink.');
      }
      if (entry.isDirectory() && stats.isDirectory()) {
        directories.push(relativePath);
        visit(relativePath);
      } else if (entry.isFile() && stats.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error('Projection tree contains a non-regular entry.');
      }
    }
  };
  visit(relativeRoot);
  return { files: files.sort(), directories: directories.sort() };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function restartMessage(reason: ProjectionContractRestartReason, expectedVersion: string): string {
  if (reason === 'unreceipted_projection_entries') {
    return (
      'This migration contains installed projection files without matching durable receipts, ' +
      'so DNAForge cannot prove which projection contract wrote them. ' +
      'Start a new migration and select the same original Benchling export again. The failed ' +
      'locked run and its captured source will remain preserved.'
    );
  }
  if (reason === 'receipt_version_mismatch') {
    return (
      'This migration contains a projection receipt from an incompatible or unknown contract, ' +
      `but this DNAForge build requires ${expectedVersion}. ` +
      'Start a new migration and select the same original Benchling export again. The failed ' +
      'locked run and its captured source will remain preserved.'
    );
  }
  return (
    'This migration records an incompatible or unknown projection contract, ' +
    `but this DNAForge build requires ${expectedVersion}. ` +
    'Start a new migration and select the same original Benchling export again. The failed ' +
    'locked run and its captured source will remain preserved.'
  );
}
