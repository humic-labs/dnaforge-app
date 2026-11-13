import { opendir, realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import { isGenbankPath, materializeGenbankSources } from './genbank-reference-source';
import { resolveNcbiDatasetsSelection } from './ncbi-datasets-reference-resolver';
import type {
  LocalReferenceSourceSelection,
  ResolvedLocalReferenceSources,
} from './local-reference-source-types';

export type {
  LocalReferenceSourceSelection,
  ResolvedLocalReferenceSources,
} from './local-reference-source-types';

export const MAX_GENERIC_REFERENCE_FOLDER_ENTRIES = 4_096;

const FASTA_EXTENSIONS = new Set(['.fa', '.fasta', '.fna', '.ffn', '.frn']);
const GFF3_EXTENSIONS = new Set(['.gff', '.gff3']);

export async function resolveLocalReferenceSelection(input: {
  readonly selection: LocalReferenceSourceSelection;
  readonly stagingRoot: string;
}): Promise<ResolvedLocalReferenceSources> {
  const selectedPath = await realpath(resolve(input.selection.path)).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open the selected reference source: ${detail}`);
  });
  const metadata = await stat(selectedPath);
  const selectedKind = metadata.isDirectory() ? 'folder' : metadata.isFile() ? 'file' : null;
  if (!selectedKind) {
    throw new Error('The selected custom reference source is not a regular file or folder.');
  }
  const ncbi = await resolveNcbiDatasetsSelection({
    selectedPath,
    selectedKind,
    stagingRoot: input.stagingRoot,
  });
  if (ncbi) return ncbi;
  if (selectedKind === 'file') {
    if (isGenbankPath(selectedPath)) {
      return {
        kind: 'generic-folder',
        sourcePaths: await materializeGenbankSources(selectedPath, input.stagingRoot),
      };
    }
    return { kind: 'standalone-fasta', sourcePaths: [selectedPath] };
  }
  return resolveGenericReferenceFolder(selectedPath);
}

export async function resolveGenericReferenceFolder(
  selectedPath: string
): Promise<ResolvedLocalReferenceSources> {
  if (typeof selectedPath !== 'string' || selectedPath.trim().length === 0) {
    throw new Error('The selected reference folder path is invalid.');
  }

  const folderPath = await realpath(resolve(selectedPath)).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open the selected reference folder: ${detail}`);
  });
  const folderMetadata = await stat(folderPath);
  if (!folderMetadata.isDirectory()) {
    throw new Error('The selected custom reference source is not a folder.');
  }

  const fastaPaths: string[] = [];
  const gff3Paths: string[] = [];
  const directory = await opendir(folderPath);
  let entryCount = 0;
  for await (const entry of directory) {
    entryCount += 1;
    if (entryCount > MAX_GENERIC_REFERENCE_FOLDER_ENTRIES) {
      throw new Error(
        `This folder contains more than ${MAX_GENERIC_REFERENCE_FOLDER_ENTRIES.toLocaleString(
          'en-US'
        )} items. Choose the specific folder that contains one reference assembly.`
      );
    }
    const candidateKind = referenceCandidateKind(entry.name);
    if (!candidateKind) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Reference source candidates must be regular files, not symbolic links: ${entry.name}`
      );
    }
    if (!entry.isFile()) {
      throw new Error(`Reference source candidate is not a regular file: ${entry.name}`);
    }
    const candidatePath = await realpath(resolve(folderPath, entry.name));
    if (candidateKind === 'fasta') fastaPaths.push(candidatePath);
    else gff3Paths.push(candidatePath);
  }

  fastaPaths.sort();
  gff3Paths.sort();
  if (fastaPaths.length !== 1 || gff3Paths.length > 1) {
    throw new Error(
      `This folder must contain exactly one FASTA sequence file and at most one GFF3 annotation file. Found ${fastaPaths.length} FASTA and ${gff3Paths.length} GFF3 candidates.`
    );
  }

  return {
    kind: 'generic-folder',
    sourcePaths: gff3Paths.length === 1 ? [fastaPaths[0], gff3Paths[0]] : [fastaPaths[0]],
  };
}

function referenceCandidateKind(name: string): 'fasta' | 'gff3' | null {
  const lowerName = name.toLowerCase();
  const uncompressedName = lowerName.endsWith('.gz') ? lowerName.slice(0, -3) : lowerName;
  const extension = extname(uncompressedName);
  if (FASTA_EXTENSIONS.has(extension)) return 'fasta';
  if (GFF3_EXTENSIONS.has(extension)) return 'gff3';
  return null;
}
