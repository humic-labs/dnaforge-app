export type ParserRoute = 'legacy' | 'indexed';

export interface ParserDispatchStat {
  sizeBytes: number;
  ext: string;
  sampledFeatureCount?: number;
}

const MIB = 1024 * 1024;

export const PARSER_DISPATCH_LIMITS = {
  genbankIndexedBytes: 20 * MIB,
  fastaIndexedBytes: 64 * MIB,
  denseFeatureCount: 20_000,
} as const;

const GENBANK_EXTENSIONS = new Set(['gb', 'gbk', 'gbff', 'genbank']);
const FASTA_EXTENSIONS = new Set(['fa', 'fasta', 'fna']);
const GFF3_EXTENSIONS = new Set(['gff', 'gff3']);

export function dispatchRouteFor(stat: ParserDispatchStat): ParserRoute {
  const ext = normalizeExtension(stat.ext);
  const featureCount =
    typeof stat.sampledFeatureCount === 'number' && Number.isFinite(stat.sampledFeatureCount)
      ? Math.max(0, stat.sampledFeatureCount)
      : undefined;

  if (featureCount !== undefined && featureCount >= PARSER_DISPATCH_LIMITS.denseFeatureCount) {
    return 'indexed';
  }

  if (GFF3_EXTENSIONS.has(ext)) {
    return 'indexed';
  }

  if (GENBANK_EXTENSIONS.has(ext)) {
    return stat.sizeBytes >= PARSER_DISPATCH_LIMITS.genbankIndexedBytes ? 'indexed' : 'legacy';
  }

  if (FASTA_EXTENSIONS.has(ext)) {
    return stat.sizeBytes >= PARSER_DISPATCH_LIMITS.fastaIndexedBytes ? 'indexed' : 'legacy';
  }

  return 'legacy';
}

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
}
