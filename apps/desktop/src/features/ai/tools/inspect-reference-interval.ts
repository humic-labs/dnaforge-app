   
                                                                                     
  
                                                          
                                                                             
   

import {
  resultTool,
  toolSuccess,
  toolFailure,
  type ToolFailure,
} from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import {
  runReferenceIntervalAction,
  type GenomeDataSource,
  type ReferenceIntervalFailure,
  type ReferenceIntervalOperation,
  type ReferenceIntervalRequest,
  type ReferenceIntervalSuccess,
  type ReferenceIntervalSourceIdentity,
} from '@waypoint/genome-data';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { platform } from '../../../platform';
import { createPlatformIndexedGenomeDataSource } from '../../../shared/platform-indexed-genome-data-source';
import {
  getUserFolders,
  hasNoUserWorkspace,
  NO_WORKSPACE_TOOL_MESSAGE,
  resolveMultiRootPath,
} from './path-utils';

export const inspectReferenceIntervalSchema = z
  .object({
    sourcePath: z
      .string()
      .min(1)
      .describe(
        'Project-relative path to an indexed FASTA (.fa/.fasta/.fna or BGZF-compressed equivalents). Absolute paths are accepted only when they stay inside an open project folder.'
      ),
    chrom: z.string().min(1).describe('Chromosome / contig id in the indexed FASTA.'),
    start0: z.number().int().min(0).describe('0-based half-open interval start.'),
    end0: z.number().int().min(0).describe('0-based half-open interval end.'),
    strand: z
      .enum(['+', '-'])
      .describe('Selected strand. Read still returns genomic forward bases.'),
    operation: z
      .enum(['read', 'reverse_complement', 'translate', 'translate_spliced', 'search', 'extract'])
      .describe(
        'read = exact forward bases; reverse_complement = IUPAC reverse complement; translate = six frames; translate_spliced = CDS children; search = IUPAC motif hits; extract = derived sequence payload with provenance (does not write a file).'
      ),
    wraps: z
      .boolean()
      .optional()
      .describe(
        'True when the interval crosses the origin of a circular chromosome (start0 after end0). Supported for read, reverse_complement, translate, and extract; search and translate_spliced require two linear requests.'
      ),
    circular: z
      .boolean()
      .optional()
      .describe('True when the chromosome is circular. Required with wraps.'),
    motif: z
      .string()
      .min(1)
      .max(16_384)
      .optional()
      .describe('IUPAC DNA motif. Required for operation=search.'),
    featureId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'GFF ID of the transcript/CDS to splice. Required when several CDS groups overlap.'
      ),
    faiPath: z
      .string()
      .min(1)
      .optional()
      .describe('Project-relative FASTA index (.fai). Defaults to sourcePath + ".fai".'),
    gffPath: z
      .string()
      .min(1)
      .optional()
      .describe('Optional project-relative BGZF-compressed GFF3 (.gff.gz/.gff3.gz).'),
    tbiPath: z
      .string()
      .min(1)
      .optional()
      .describe('Optional Tabix index. Defaults to gffPath + ".tbi" when gffPath is set.'),
    maxResults: z.number().int().min(1).max(500).optional().describe('Search hit cap (max 500).'),
  })
  .strict();

export type InspectReferenceIntervalInput = z.infer<typeof inspectReferenceIntervalSchema>;

export interface IndexedReferenceSourceResolution {
  ok: true;
  source: GenomeDataSource;
  identity: ReferenceIntervalSourceIdentity;
}

export type IndexedReferenceSourceResolver = (
  input: InspectReferenceIntervalInput,
  folders: WorkspaceFolder[]
) => Promise<IndexedReferenceSourceResolution | ReferenceIntervalFailure>;

export function createInspectReferenceIntervalTool(
  folders: WorkspaceFolder[],
  deps: { resolveSource?: IndexedReferenceSourceResolver } = {}
) {
  const resolveSource = deps.resolveSource ?? resolveIndexedReferenceSource;

  return resultTool({
    description:
      'Read or compute over a bounded interval of an indexed reference FASTA. ' +
      'Pass an explicit project-grounded FASTA path, chromosome, and 0-based half-open ' +
      'coordinates. Does not use the currently open viewer. Operations: exact bases, ' +
      'reverse complement, six-frame translation, spliced/phase-aware CDS translation, ' +
      'IUPAC motif search, and a derived sequence payload with provenance. Large intervals ' +
      'are refused rather than inlined. Search results report whether the result cap hid more matches.',
    inputSchema: inspectReferenceIntervalSchema as z.ZodTypeAny,
    execute: async (
      input: InspectReferenceIntervalInput,
      options?: { abortSignal?: AbortSignal }
    ): Promise<ReferenceIntervalSuccess | ToolFailure> => {
      try {
        const resolved = await resolveSource(input, folders);
        if (resolved.ok !== true)
          return toolFailure({
            ...resolved,
            retriable: false,
            stateChanged: false,
            partialEffects: [],
          });

        const request: ReferenceIntervalRequest = {
          chrom: input.chrom,
          start0: input.start0,
          end0: input.end0,
          strand: input.strand,
          operation: input.operation as ReferenceIntervalOperation,
          ...(input.motif ? { motif: input.motif } : {}),
          ...(input.featureId ? { featureId: input.featureId } : {}),
          ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
          ...(input.wraps ? { wraps: true } : {}),
          ...(input.circular ? { circular: true } : {}),
          ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
        };
        const result = await runReferenceIntervalAction(
          resolved.source,
          request,
          resolved.identity
        );
        return result.ok
          ? toolSuccess({ ...result })
          : toolFailure({ ...result, retriable: false, stateChanged: false, partialEffects: [] });
      } catch (error) {
        return toolFailure({
          code: 'REFERENCE_INTERVAL_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      }
    },
  });
}

export async function resolveIndexedReferenceSource(
  input: InspectReferenceIntervalInput,
  folders: WorkspaceFolder[]
): Promise<IndexedReferenceSourceResolution | ReferenceIntervalFailure> {
  if (hasNoUserWorkspace(folders)) {
    return missingSource(NO_WORKSPACE_TOOL_MESSAGE);
  }

  const userFolders = getUserFolders(folders);
  let fasta: AdmittedWorkspaceFile;
  try {
    fasta = await admitWorkspaceFile(userFolders, input.sourcePath, 'FASTA', 'sequence');
  } catch (err) {
    return missingSource(
      err instanceof Error ? err.message : 'Indexed FASTA path is outside the open project.'
    );
  }

  const fai = await resolveCompanionPath(
    userFolders,
    input.faiPath,
    { folder: fasta.folder, relativePath: `${fasta.relativePath}.fai` },
    'FASTA index (.fai)'
  );
  if (fai.ok === false) return fai;

  let gffAbsolute: string | undefined;
  let tbiAbsolute: string | undefined;
  const workspaceRootPaths = new Set([fasta.canonicalRootPath, fai.canonicalRootPath]);
  if (input.operation === 'translate_spliced' && !input.gffPath) {
    return missingSource('gffPath is required for translate_spliced.');
  }
  if (input.gffPath) {
    const gff = await resolveCompanionPath(userFolders, input.gffPath, null, 'GFF3');
    if (gff.ok === false) return gff;
    gffAbsolute = gff.absolutePath;
    workspaceRootPaths.add(gff.canonicalRootPath);
    const tbi = await resolveCompanionPath(
      userFolders,
      input.tbiPath,
      { folder: gff.folder, relativePath: `${gff.relativePath}.tbi` },
      'Tabix index (.tbi)'
    );
    if (tbi.ok === false) return tbi;
    tbiAbsolute = tbi.absolutePath;
    workspaceRootPaths.add(tbi.canonicalRootPath);
  }

  const identity: ReferenceIntervalSourceIdentity = {
    sourceId: fasta.displayPath,
    fastaPath: fasta.displayPath,
  };

  return {
    ok: true,
    source: createPlatformIndexedGenomeDataSource({
      chrom: input.chrom,
      fastaPath: fasta.absolutePath,
      faiPath: fai.absolutePath,
      ...(gffAbsolute ? { gffPath: gffAbsolute } : {}),
      ...(tbiAbsolute ? { tbiPath: tbiAbsolute } : {}),
      workspaceRootPaths: [...workspaceRootPaths],
    }),
    identity,
  };
}

async function resolveCompanionPath(
  folders: WorkspaceFolder[],
  explicitPath: string | undefined,
  defaultPath: Pick<AdmittedWorkspaceFile, 'folder' | 'relativePath'> | null,
  label: string
): Promise<AdmittedWorkspaceFile | ReferenceIntervalFailure> {
  if (!explicitPath && !defaultPath) {
    return missingSource(`${label} path is required.`);
  }
  try {
    if (explicitPath) return await admitWorkspaceFile(folders, explicitPath, label, 'workspace');
    return await admitResolvedWorkspaceFile(folders.length, defaultPath!, label, 'workspace');
  } catch (err) {
    return missingSource(
      err instanceof Error ? err.message : `${label} path is outside the open project.`
    );
  }
}

type WorkspaceTargetKind = 'sequence' | 'workspace';

interface AdmittedWorkspaceFile {
  ok: true;
  absolutePath: string;
  displayPath: string;
  relativePath: string;
  canonicalRootPath: string;
  folder: WorkspaceFolder;
}

async function admitWorkspaceFile(
  folders: WorkspaceFolder[],
  inputPath: string,
  label: string,
  targetKind: WorkspaceTargetKind
): Promise<AdmittedWorkspaceFile> {
  const resolved = resolveMultiRootPath(folders, inputPath);
  return admitResolvedWorkspaceFile(folders.length, resolved, label, targetKind);
}

async function admitResolvedWorkspaceFile(
  folderCount: number,
  resolved: Pick<AdmittedWorkspaceFile, 'folder' | 'relativePath'>,
  label: string,
  targetKind: WorkspaceTargetKind
): Promise<AdmittedWorkspaceFile> {
  const segments = resolved.relativePath.split('/');
  const admitted = await platform().fs.resolveInlineReferenceTarget({
    roots: [{ name: resolved.folder.name, path: resolved.folder.path }],
    root: resolved.folder.name,
    segments,
    targetKind,
  });
  if (!admitted.ok || admitted.targetType !== 'file') {
    const reason = admitted.ok ? 'wrong-kind' : admitted.code;
    throw new Error(`${label} is not an admitted project file (${reason}).`);
  }
  if (!hasExpectedIndexedFileExtension(admitted.canonicalPath, label)) {
    throw new Error(`${label} has an unsupported file extension.`);
  }
  return {
    ok: true,
    absolutePath: admitted.canonicalPath,
    relativePath: admitted.relativePath,
    canonicalRootPath: admitted.canonicalRootPath,
    displayPath:
      folderCount > 1 ? `${resolved.folder.name}/${admitted.relativePath}` : admitted.relativePath,
    folder: resolved.folder,
  };
}

function hasExpectedIndexedFileExtension(path: string, label: string): boolean {
  const lower = path.toLowerCase();
  if (label === 'FASTA') {
    return ['.fa', '.fasta', '.fna', '.ffn', '.fa.gz', '.fasta.gz', '.fna.gz', '.ffn.gz'].some(
      (extension) => lower.endsWith(extension)
    );
  }
  if (label.startsWith('FASTA index')) return lower.endsWith('.fai');
  if (label === 'GFF3') {
    return ['.gff.gz', '.gff3.gz'].some((extension) => lower.endsWith(extension));
  }
  if (label.startsWith('Tabix index')) return lower.endsWith('.tbi');
  return false;
}

function missingSource(error: string): ReferenceIntervalFailure {
  return { ok: false, code: 'MISSING_SOURCE', error };
}
