import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  inferCatalogFileKind,
  isManagedEntityArtifactPath,
  isManagedPrimerArtifactPath,
  isTextSequenceFileKind,
} from '../shared/catalog-file-kind';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { readTablePackageInMain } from './table-package';
import { tablePackagePaths } from '../shared/table-package';
import type {
  WorkspaceArtifactDiscoveryRequest,
  WorkspaceArtifactDiscoveryResult,
  WorkspaceCatalogKnownFile,
} from '../shared/workspace-git-types';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const CATALOG_KINDS = new Set([
  'genbank',
  'fasta',
  'fastq',
  'alignment',
  'trace',
  'waypoint-notebook',
  'waypoint-design',
  'waypoint-residue-selection',
  'waypoint-protocol',
  'waypoint-protocol-run',
  'dnaforge-table',
  'pdb',
  'mmcif',
  'binary-cif',
]);
const MAX_FILES = 10_000;
const MAX_DEPTH = 40;

function hidden(name: string): boolean {
  return name.startsWith('.');
}

function normalizedMtime(fileStat: { mtimeMs: number }): number {
  return fileStat.mtimeMs;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest('hex')}`;
}

function knownFileMap(
  knownFiles: readonly WorkspaceCatalogKnownFile[]
): Map<string, WorkspaceCatalogKnownFile> {
  return new Map(knownFiles.map((file) => [file.path, file]));
}

export async function discoverWorkspaceArtifacts(
  request: WorkspaceArtifactDiscoveryRequest
): Promise<WorkspaceArtifactDiscoveryResult> {
  const { rootPath, knownFiles } = request;
  const knownByPath = knownFileMap(knownFiles);
  const unseenKnownPaths = new Set(knownByPath.keys());
  const projection: NonNullable<WorkspaceArtifactDiscoveryResult['catalogProjection']> = {
    candidates: [],
    missingPaths: [],
    scannedFileCount: 0,
    visibleFileCount: 0,
  };
  const result: WorkspaceArtifactDiscoveryResult = {
    primerArtifactPaths: [],
    entityArtifactPaths: [],
    scannedEntries: 0,
    errors: [],
    catalogProjection: projection,
  };
  let traversalComplete = true;

  const observePath = (path: string): void => {
    unseenKnownPaths.delete(path);
  };

  const addCatalogCandidate = async (path: string, fileKind: string): Promise<void> => {
    try {
      const fileStat = await stat(path);
      const modifiedAt = normalizedMtime(fileStat);
      let contentHash: string | null = null;
      if (isTextSequenceFileKind(fileKind)) {
        const known = knownByPath.get(path);
        if (
          known?.contentHash &&
          known.sizeBytes === fileStat.size &&
          known.modifiedAt === modifiedAt
        ) {
          contentHash = known.contentHash;
        } else if (fileStat.size <= HARD_CAP_BYTES) {
          contentHash = await sha256File(path);
        }
      }
      projection.candidates.push({
        path,
        fileKind,
        sizeBytes: fileStat.size,
        modifiedAt,
        contentHash,
      });
    } catch (error) {
      result.errors.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const observeArtifactMeta = (absolutePath: string, relativePath: string): void => {
    const kind = inferCatalogFileKind(relativePath);
    if (isManagedEntityArtifactPath(relativePath, kind)) {
      result.entityArtifactPaths.push(absolutePath);
    }
  };

  async function walk(
    directoryPath: string,
    relativeDir: string,
    depth: number,
    plasmidPackageRoot: string | null = null
  ): Promise<void> {
    if (depth > MAX_DEPTH || projection.scannedFileCount >= MAX_FILES) {
      traversalComplete = false;
      return;
    }
    const tableHeadPath = tablePackagePaths(directoryPath).headPath;
    let tablePackageFound = false;
    try {
      tablePackageFound = (await stat(tableHeadPath)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.errors.push({
          path: tableHeadPath,
          message: error instanceof Error ? error.message : String(error),
        });
        traversalComplete = false;
        return;
      }
    }
    if (tablePackageFound) {
      projection.scannedFileCount += 1;
      projection.visibleFileCount += 1;
      observePath(tableHeadPath);
      try {
        const table = await readTablePackageInMain({
          workspaceRoot: rootPath,
          packageRoot: directoryPath,
        });
        if (table.head.status !== 'active')
          throw new Error('The table migration is pending recovery.');
        await addCatalogCandidate(tableHeadPath, 'dnaforge-table');
      } catch (error) {
        result.errors.push({
          path: tableHeadPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      traversalComplete = false;
      result.errors.push({
        path: directoryPath,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const entry of entries) {
      if (projection.scannedFileCount >= MAX_FILES) {
        traversalComplete = false;
        return;
      }
      result.scannedEntries += 1;
      if (hidden(entry.name)) continue;
      const absolutePath = join(directoryPath, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        const notebookMetaPath = join(absolutePath, '.forge', 'notebook.json');
        try {
          const notebookMetaStat = await stat(notebookMetaPath);
          if (notebookMetaStat.isFile()) {
            projection.scannedFileCount += 1;
            projection.visibleFileCount += 1;
            observePath(absolutePath);
            observeArtifactMeta(notebookMetaPath, `${relativePath}/.forge/notebook.json`);
            await addCatalogCandidate(absolutePath, 'waypoint-notebook');
            continue;
          }
        } catch {}

        const scientificMetaCandidates = [
          { name: 'protocol.json', kind: 'waypoint-protocol' },
          { name: 'protocol-run.json', kind: 'waypoint-protocol-run' },
        ] as const;
        let scientificPackageFound = false;
        for (const candidate of scientificMetaCandidates) {
          const metaPath = join(absolutePath, '.forge', candidate.name);
          try {
            if ((await stat(metaPath)).isFile()) {
              projection.scannedFileCount += 1;
              projection.visibleFileCount += 1;
              observePath(metaPath);
              await addCatalogCandidate(metaPath, candidate.kind);
              scientificPackageFound = true;
              break;
            }
          } catch {}
        }
        if (scientificPackageFound) continue;

        const plasmidMetaPath = join(absolutePath, '.forge', 'plasmid.json');
        try {
          const plasmidMetaStat = await stat(plasmidMetaPath);
          if (plasmidMetaStat.isFile()) {
            projection.scannedFileCount += 1;
            projection.visibleFileCount += 1;
            observePath(absolutePath);
            observeArtifactMeta(plasmidMetaPath, `${relativePath}/.forge/plasmid.json`);
            await walk(absolutePath, relativePath, depth + 1, absolutePath);
            continue;
          }
        } catch {}
        await walk(absolutePath, relativePath, depth + 1, plasmidPackageRoot);
        continue;
      }
      if (!entry.isFile()) continue;
      if (plasmidPackageRoot !== null) continue;

      projection.scannedFileCount += 1;
      if (!entry.name.toLowerCase().endsWith('.waypoint.json')) {
        projection.visibleFileCount += 1;
      }
      observePath(absolutePath);
      if (isManagedPrimerArtifactPath(relativePath)) {
        result.primerArtifactPaths.push(absolutePath);
      }
      const fileKind = inferCatalogFileKind(relativePath);
      observeArtifactMeta(absolutePath, relativePath);
      if (CATALOG_KINDS.has(fileKind)) await addCatalogCandidate(absolutePath, fileKind);
    }
  }

  const rootNotebookMetaPath = join(rootPath, '.forge', 'notebook.json');
  let rootIsNotebookPackage = false;
  try {
    rootIsNotebookPackage = (await stat(rootNotebookMetaPath)).isFile();
  } catch {
    rootIsNotebookPackage = false;
  }
  if (rootIsNotebookPackage) {
    projection.scannedFileCount += 1;
    observePath(rootPath);
    observeArtifactMeta(rootNotebookMetaPath, '.forge/notebook.json');
    await addCatalogCandidate(rootPath, 'waypoint-notebook');
  } else {
    const rootScientificPackageCandidates = [
      { name: 'protocol.json', kind: 'waypoint-protocol' },
      { name: 'protocol-run.json', kind: 'waypoint-protocol-run' },
    ] as const;
    let rootScientificPackageFound = false;
    for (const candidate of rootScientificPackageCandidates) {
      const metaPath = join(rootPath, '.forge', candidate.name);
      try {
        if ((await stat(metaPath)).isFile()) {
          projection.scannedFileCount += 1;
          projection.visibleFileCount += 1;
          observePath(metaPath);
          await addCatalogCandidate(metaPath, candidate.kind);
          rootScientificPackageFound = true;
          break;
        }
      } catch {}
    }
    if (rootScientificPackageFound) {
      result.primerArtifactPaths.sort((left, right) => left.localeCompare(right));
      result.entityArtifactPaths.sort((left, right) => left.localeCompare(right));
      projection.candidates.sort((left, right) => left.path.localeCompare(right.path));
      projection.missingPaths = [...unseenKnownPaths].sort((left, right) =>
        left.localeCompare(right)
      );
      return result;
    }
    const rootPlasmidMetaPath = join(rootPath, '.forge', 'plasmid.json');
    let rootIsPlasmidPackage = false;
    try {
      rootIsPlasmidPackage = (await stat(rootPlasmidMetaPath)).isFile();
    } catch {
      rootIsPlasmidPackage = false;
    }
    if (rootIsPlasmidPackage) {
      projection.scannedFileCount += 1;
      projection.visibleFileCount += 1;
      observePath(rootPath);
      observeArtifactMeta(rootPlasmidMetaPath, '.forge/plasmid.json');
    }
    await walk(rootPath, '', 0, rootIsPlasmidPackage ? rootPath : null);
  }

  result.primerArtifactPaths.sort((left, right) => left.localeCompare(right));
  result.entityArtifactPaths.sort((left, right) => left.localeCompare(right));
  projection.candidates.sort((left, right) => left.path.localeCompare(right.path));
  projection.missingPaths = traversalComplete
    ? [...unseenKnownPaths].sort((left, right) => left.localeCompare(right))
    : [];
  return result;
}
