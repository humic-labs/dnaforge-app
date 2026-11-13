import type { IndexedGenomeManifest } from '../../shared/indexed-genome';

export interface IndexedGenomePathInput {
  sourcePath: string;
  workspaceRoot: string;
  sizeBytes?: number;
  sourceMtimeMs?: number;
  sourceCtimeMs?: number;
}

export interface IndexedGenomePaths {
  chrom: string;
  outputDir: string;
  metadataPath: string;
  manifest: IndexedGenomeManifest;
}

const GENBANK_EXTENSIONS = new Set(['gb', 'gbk', 'gbff', 'genbank']);
const GFF3_EXTENSIONS = new Set(['gff', 'gff3']);
const ANNOTATION_BEARING_EXTENSIONS = new Set([...GENBANK_EXTENSIONS, ...GFF3_EXTENSIONS]);
export const CURRENT_INDEXED_GENOME_SCHEMA = 5;

export function isAnnotationBearingExtension(ext: string | undefined): boolean {
  return ANNOTATION_BEARING_EXTENSIONS.has((ext ?? '').toLowerCase());
}

export function extensionForPath(filePath: string): string {
  const fileName = basenameForPath(filePath).toLowerCase();
  const gzStripped = fileName.endsWith('.gz') ? fileName.slice(0, -3) : fileName;
  const dot = gzStripped.lastIndexOf('.');
  return dot >= 0 ? gzStripped.slice(dot + 1) : '';
}

export function basenameForPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || filePath;
}

export function safeIndexedGenomeName(filePath: string): string {
  const base = basenameForPath(filePath);
  const lower = base.toLowerCase();
  let withoutExt = base;
  const stripIfMatches = (suffix: string): boolean => {
    if (lower.endsWith(suffix)) {
      withoutExt = base.slice(0, base.length - suffix.length);
      return true;
    }
    return false;
  };
  const compoundFirst = ['.gff3.gz', '.gff.gz', '.gbff.gz', '.fasta.gz', '.fna.gz', '.fa.gz'];
  let stripped = false;
  for (const cmpd of compoundFirst) {
    if (stripIfMatches(cmpd)) {
      stripped = true;
      break;
    }
  }
  if (!stripped) {
    const dot = base.lastIndexOf('.');
    withoutExt = dot > 0 ? base.slice(0, dot) : base;
  }
  const sanitized = withoutExt.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const prefixed = /^[A-Za-z0-9]/.test(sanitized) ? sanitized : `genome_${sanitized}`;
  return (prefixed || 'genome').slice(0, 80);
}

export function buildIndexedGenomePaths(input: IndexedGenomePathInput): IndexedGenomePaths {
  const chrom = safeIndexedGenomeName(input.sourcePath);
  const hash = stablePathHash(
    [
      `schema-${CURRENT_INDEXED_GENOME_SCHEMA}`,
      input.sourcePath,
      input.sizeBytes ?? 'size-unknown',
      input.sourceMtimeMs ?? 'mtime-unknown',
      input.sourceCtimeMs ?? 'ctime-unknown',
    ].join(':')
  );
  const outputDir = joinPath(input.workspaceRoot, '.waypoint', 'genome-index', `${chrom}-${hash}`);
  const fastaPath = joinPath(outputDir, `${chrom}.fa.gz`);
  const faiPath = joinPath(outputDir, `${chrom}.fa.gz.fai`);
  const gziPath = joinPath(outputDir, `${chrom}.fa.gz.gzi`);
  const metadataPath = joinPath(outputDir, `${chrom}.waypoint-index.json`);
  const ext = extensionForPath(input.sourcePath);
  const hasAnnotations = isAnnotationBearingExtension(ext);

  return {
    chrom,
    outputDir,
    metadataPath,
    manifest: {
      chrom,
      fastaPath,
      faiPath,
      gziPath,
      gffPath: hasAnnotations ? joinPath(outputDir, `${chrom}.gff3.gz`) : null,
      tbiPath: hasAnnotations ? joinPath(outputDir, `${chrom}.gff3.gz.tbi`) : null,
    },
  };
}

export function joinPath(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const cleanRoot = root.replace(/[\\/]+$/, '');
  const cleanParts = parts
    .map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter((part) => part.length > 0);
  return [cleanRoot, ...cleanParts].join(sep);
}

function stablePathHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
