import { isPrimerArtifactPath } from './catalog-file-kind';
import { isNotebookPackageMetaPath } from '../db/notebook-package';
import { isForgePackageMetaPath } from './forge-package-path';
import { isSequencePackageFileKind, isSequencePackageMetaPath } from '../db/sequence-package';
import {
  pathIsAtOrUnder,
  pathRelativeToBoundary,
  rebasePath,
  stripTrailingSep,
} from './path-boundary';

export interface CatalogRelocationFile {
  id: string;
  entity_id: string;
  path: string;
  file_kind: string;
  size_bytes: number | null;
  modified_at: number | null;
}

export interface CatalogRelocationEntity {
  id: string;
  name: string;
  locator: string;
  metadata: string | null;
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

function inferCatalogFileKind(filePath: string): string {
  const name = basename(filePath);
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith('.wpnote.json')) return 'waypoint-notebook';
  if (lowerName.endsWith('.wpdesign.json')) return 'waypoint-design';
  if (lowerName.endsWith('.wpselection.json')) return 'waypoint-residue-selection';
  if (isNotebookPackageMetaPath(filePath)) return 'waypoint-notebook';
  if (isForgePackageMetaPath(filePath, 'table.json')) return 'dnaforge-table';
  if (isSequencePackageMetaPath(filePath)) return 'waypoint-sequence';
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  if (!extension) return 'file';
  if (['gb', 'gbk', 'gbff', 'genbank'].includes(extension)) return 'genbank';
  if (['fa', 'fasta', 'fna', 'ffn', 'faa'].includes(extension)) return 'fasta';
  if (['fq', 'fastq'].includes(extension)) return 'fastq';
  if (['ab1', 'scf'].includes(extension)) return 'trace';
  if (['sam', 'bam', 'cram', 'aln', 'clustal', 'maf'].includes(extension)) return 'alignment';
  if (extension === 'pdb') return 'pdb';
  if (['cif', 'mmcif', 'mcif'].includes(extension)) return 'mmcif';
  if (extension === 'bcif') return 'binary-cif';
  return extension;
}

export function findCatalogRelocationConflict(
  files: readonly Pick<CatalogRelocationFile, 'id' | 'entity_id' | 'path'>[],
  entityAtLocator: (locator: string) => { id: string } | undefined,
  oldPath: string,
  newPath: string
): string | null {
  const oldAbs = stripTrailingSep(oldPath);
  const newAbs = stripTrailingSep(newPath);
  if (oldAbs === newAbs) return null;
  const movers = files.filter((file) => pathIsAtOrUnder(file.path, oldAbs));
  const fileIds = new Set(movers.map((file) => file.id));
  const entityIds = new Set(movers.map((file) => file.entity_id));
  for (const file of movers) {
    const path = rebasePath(file.path, oldAbs, newAbs);
    const conflict = files.find((other) => other.path === path);
    if (conflict && !fileIds.has(conflict.id)) return path;
    const entity = entityAtLocator(`file://${path}`);
    if (entity && !entityIds.has(entity.id)) return path;
  }
  return null;
}

export function planCatalogFileRelocation(
  file: CatalogRelocationFile,
  entity: CatalogRelocationEntity | undefined,
  input: { oldPath: string; newPath: string; workspaceRoot: string | null; now: number },
  stat: { sizeBytes: number | null; modifiedAt: number | null }
) {
  const originalPath = file.path;
  const movedPath = rebasePath(originalPath, input.oldPath, input.newPath);
  const root = input.workspaceRoot;
  const workspaceRoot =
    root && pathIsAtOrUnder(movedPath, root)
      ? root
      : root && pathIsAtOrUnder(root, input.oldPath)
        ? rebasePath(root, input.oldPath, input.newPath)
        : root;
  const relativePath = workspaceRoot ? pathRelativeToBoundary(movedPath, workspaceRoot) : null;
  if (
    file.file_kind === 'primer-artifact' &&
    isPrimerArtifactPath(originalPath) &&
    !isPrimerArtifactPath(movedPath)
  )
    throw new Error('Keep the .primer.json extension when renaming a saved primer.');
  const fileKind =
    file.file_kind === 'primer-artifact' ||
    file.file_kind === 'folder' ||
    file.file_kind === 'waypoint-notebook' ||
    file.file_kind === 'waypoint-design' ||
    file.file_kind === 'dnaforge-table' ||
    isSequencePackageFileKind(file.file_kind)
      ? file.file_kind
      : inferCatalogFileKind(movedPath);
  let entityPatch: Pick<CatalogRelocationEntity, 'name' | 'locator' | 'metadata'> | null = null;
  if (entity?.locator === `file://${originalPath}`) {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = entity.metadata ? JSON.parse(entity.metadata) : {};
    } catch {}
    const placement = metadata.placement;
    const movedMetadata =
      placement &&
      typeof placement === 'object' &&
      !Array.isArray(placement) &&
      (placement as Record<string, unknown>).kind === 'file' &&
      (placement as Record<string, unknown>).relativePath ===
        (workspaceRoot ? pathRelativeToBoundary(originalPath, workspaceRoot) : null)
        ? { ...metadata, placement: { ...placement, relativePath } }
        : metadata;
    entityPatch = {
      name: entity.name === basename(originalPath) ? basename(movedPath) : entity.name,
      locator: `file://${movedPath}`,
      metadata: JSON.stringify({ ...movedMetadata, path: movedPath, previousPath: originalPath }),
    };
  }
  return {
    file: {
      path: movedPath,
      relative_path: relativePath,
      file_kind: fileKind,
      size_bytes: stat.sizeBytes ?? file.size_bytes,
      modified_at: stat.modifiedAt ?? file.modified_at,
      last_seen_at: input.now,
      updated_at: input.now,
    },
    entity: entityPatch,
    eventPayload: JSON.stringify({ oldPath: originalPath, newPath: movedPath }),
  };
}
