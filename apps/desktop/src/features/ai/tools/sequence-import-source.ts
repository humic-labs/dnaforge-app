
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  parseBiologyContent,
  parseBiologyFile,
  type ParsedBiologyFile,
} from './parse-biology-file';
import { resolveMultiRootPath, type ResolvedMultiRootPath } from './path-utils';
import { sidecarFetchSequenceBytes, sidecarFetchSequenceUrlBytes } from './sidecar-client';
import { isAbsolutePathLike } from '../../../shared/path-boundary';

export const sequenceImportSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('local_file'),
      path: z
        .string()
        .min(1)
        .max(2000)
        .describe('Absolute local path, or project-relative path, to a GenBank/FASTA file.'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('url'),
      url: z
        .string()
        .min(1)
        .max(2000)
        .describe('Credential-free public HTTP or HTTPS GenBank/FASTA URL.'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('addgene'),
      plasmidId: z.string().min(1).max(100).describe('Future Addgene plasmid id.'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ncbi'),
      accession: z.string().min(1).max(100).describe('NCBI nucleotide accession.'),
      database: z.enum(['nuccore', 'nucleotide']).optional(),
    })
    .strict(),
]);

export type SequenceImportSource = z.infer<typeof sequenceImportSourceSchema>;

export interface SequenceImportProvenance {
  provider: string;
  fetchedVia: 'filesystem' | 'sidecar';
  sourceUrl?: string;
  license?: string;
  attribution?: string;
  contentSha256?: string;
  versionIdentifier?: string;
  organism?: string;
  definition?: string;
  taxonId?: string;
}

export type LoadedSequenceImportSource = {
  source: {
    kind: SequenceImportSource['kind'];
    path?: string;
    absolutePath?: string;
    url?: string;
    plasmidId?: string;
    accession?: string;
    database?: string;
    provenance?: SequenceImportProvenance;
  };
  parsedFile: ParsedBiologyFile;
  defaultFileName: string;
};

type LoadSequenceImportSourceInput = {
  source?: SequenceImportSource;
  sourcePath?: string;
};

type ResolvedImportPath = {
  absolutePath: string;
  displayPath: string;
};

export interface LoadSequenceImportSourceOptions {
  grantedCapabilities?: readonly string[];
  abortSignal?: AbortSignal;
}

export async function loadSequenceImportSource(
  folders: WorkspaceFolder[],
  input: LoadSequenceImportSourceInput,
  options: LoadSequenceImportSourceOptions = {}
): Promise<LoadedSequenceImportSource> {
  const source = normalizeSequenceImportSource(input);

  if (source.kind === 'url') {
    return loadUrlImportSource(source, options);
  }
  if (source.kind === 'addgene') {
    throw new Error(
      "Addgene import isn't available yet. For now, download the sequence from Addgene and import it as a local file."
    );
  }
  if (source.kind === 'ncbi') {
    return loadNcbiImportSource(source, options);
  }

  if (!hasSupportedSequenceExtension(source.path)) {
    throw new Error('import_sequence only accepts GenBank or FASTA files.');
  }

  const resolved = resolveImportSourcePath(folders, source.path);
  const parsedFile = await parseBiologyFile(resolved.absolutePath);
  return {
    source: {
      kind: 'local_file',
      path: resolved.displayPath,
      absolutePath: resolved.absolutePath,
      provenance: {
        provider: 'local_file',
        fetchedVia: 'filesystem',
      },
    },
    parsedFile,
    defaultFileName: baseName(source.path),
  };
}

async function loadUrlImportSource(
  source: Extract<SequenceImportSource, { kind: 'url' }>,
  options: LoadSequenceImportSourceOptions
): Promise<LoadedSequenceImportSource> {
  const result = await sidecarFetchSequenceUrlBytes(
    { url: source.url },
    {
      ...(options.grantedCapabilities
        ? { grantedCapabilities: options.grantedCapabilities }
        : {}),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    }
  );
  const parsedFile = parseBiologyContent(result.content);
  const canonicalUrl = result.sourceUrl ?? result.externalId;
  return {
    source: {
      kind: 'url',
      url: canonicalUrl,
      provenance: {
        provider: result.provider,
        fetchedVia: 'sidecar',
        sourceUrl: canonicalUrl,
        license: result.license,
        attribution: result.attribution,
        contentSha256: result.contentSha256,
        versionIdentifier: result.versionIdentifier,
      },
    },
    parsedFile,
    defaultFileName: urlFileName(canonicalUrl),
  };
}

function urlFileName(rawUrl: string): string {
  try {
    return baseName(new URL(rawUrl).pathname);
  } catch {
    return 'sequence.gb';
  }
}

async function loadNcbiImportSource(
  source: Extract<SequenceImportSource, { kind: 'ncbi' }>,
  options: LoadSequenceImportSourceOptions
): Promise<LoadedSequenceImportSource> {
  const database = source.database ?? 'nuccore';
  const fetchOptions = {
    ...(options.grantedCapabilities ? { grantedCapabilities: options.grantedCapabilities } : {}),
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  };
  const result =
    Object.keys(fetchOptions).length > 0
      ? await sidecarFetchSequenceBytes({ externalId: source.accession }, fetchOptions)
      : await sidecarFetchSequenceBytes({ externalId: source.accession });
  const parsedFile = parseBiologyContent(result.content);
  const metadata = result.metadata ?? {};

  return {
    source: {
      kind: 'ncbi',
      accession: result.externalId,
      database,
      provenance: {
        provider: result.provider,
        fetchedVia: 'sidecar',
        sourceUrl: result.sourceUrl,
        license: result.license,
        attribution: result.attribution,
        contentSha256: result.contentSha256 || undefined,
        versionIdentifier: result.versionIdentifier,
        organism: stringMetaField(metadata.organism),
        definition: stringMetaField(metadata.definition),
        taxonId: stringMetaField(metadata.taxon_id),
      },
    },
    parsedFile,
    defaultFileName: `${sanitizeFileName(result.externalId)}.gb`,
  };
}

function stringMetaField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function normalizeSequenceImportSource(
  input: LoadSequenceImportSourceInput
): SequenceImportSource {
  if (input.source && input.sourcePath) {
    throw new Error('Pass either source or sourcePath, not both.');
  }
  if (input.source) {
    return input.source;
  }
  if (input.sourcePath) {
    return legacySourcePathToImportSource(input.sourcePath);
  }
  throw new Error('import_sequence requires source or sourcePath.');
}

export function legacySourcePathToImportSource(sourcePath: string): SequenceImportSource {
  if (isUrl(sourcePath)) {
    return { kind: 'url', url: sourcePath };
  }
  return { kind: 'local_file', path: sourcePath };
}

export function resolveImportSourcePath(
  folders: WorkspaceFolder[],
  sourcePath: string
): ResolvedImportPath {
  if (isAbsolutePath(sourcePath)) {
    return {
      absolutePath: sourcePath,
      displayPath: sourcePath,
    };
  }

  const resolved = resolveMultiRootPath(folders, sourcePath);
  return {
    absolutePath: resolved.absolutePath,
    displayPath: displayPathForResolvedTarget(folders, resolved),
  };
}

export function displayPathForResolvedTarget(
  folders: WorkspaceFolder[],
  resolved: ResolvedMultiRootPath
): string {
  return folders.length > 1
    ? `${resolved.folder.name}/${resolved.relativePath}`
    : resolved.relativePath;
}

export function defaultTargetPath(fileName: string): string {
  return `imports/${sanitizeFileName(baseName(fileName))}`;
}

export function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const name = normalized.split('/').pop();
  return name || 'sequence.gb';
}

export function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '.';
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'sequence.gb';
}

export function hasSupportedSequenceExtension(path: string): boolean {
  return /\.(gb|gbk|gbff|genbank|fa|fas|fasta|fna|ffn)$/i.test(path);
}

function isAbsolutePath(path: string): boolean {
  return isAbsolutePathLike(path);
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
