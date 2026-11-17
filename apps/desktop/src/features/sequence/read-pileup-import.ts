import { TRACK_DEFAULT_COLORS } from '@waypoint/sequence-utils';
import type { ActiveStressDataset } from './lane-contract-store';
import type { AlignedReadSourceGenerationV1 } from '../../shared/aligned-read-source-generation';
import type { PileupSource } from './pileup-source';

export const ALIGNMENT_TRACK_DIALOG_EXTENSIONS = ['bam', 'cram'];
export const READ_PILEUP_DEFAULT_ROW_HEIGHT_PX = 3;
export const READ_PILEUP_DEFAULT_MAX_ROWS = 80;
export const READ_PILEUP_DEFAULT_OVERFLOW_BAND_HEIGHT_PX = 36;
export const READ_PILEUP_DEFAULT_TRACK_HEIGHT_PX = 276;

interface BuildReadPileupDatasetInput {
  readonly assemblyId: string;
  readonly assemblyDisplayName: string;
  readonly bamPath: string;
  readonly indexPath?: string | null;
  readonly referencePath?: string | null;
  readonly generation?: AlignedReadSourceGenerationV1;
  readonly sourceIdentity?: string;
  readonly label?: string;
  readonly remote?: PileupSource['remote'];
  readonly grantExpiresAtMs?: number;
  readonly htsget?: {
    readonly sourceToken: string;
    readonly sourceIdentity: string;
    readonly format: 'BAM' | 'CRAM';
  };
}

export function buildReadPileupDataset({
  assemblyId,
  assemblyDisplayName,
  bamPath,
  indexPath,
  referencePath,
  generation,
  sourceIdentity,
  label,
  remote,
  grantExpiresAtMs,
  htsget,
}: BuildReadPileupDatasetInput): ActiveStressDataset {
  const scientificPath = sourceIdentity ?? bamPath;
  if (!/\.(?:bam|cram)$/.test(scientificPath.split(/[?#]/, 1)[0]?.toLowerCase() ?? '')) {
    throw new Error('Choose a BAM or CRAM read-alignment file.');
  }
  const fileName = label ?? basenameForPath(scientificPath);
  return {
    kind: 'pileup',
    trackType: 'pileup-genomewide',
    trackId: `pileup-${assemblyId}-${stableSourceHash(sourceIdentity ?? bamPath)}`,
    label: `${assemblyDisplayName}: ${fileName}`,
    color: TRACK_DEFAULT_COLORS.pileupLight,
    laneHeightPx: READ_PILEUP_DEFAULT_ROW_HEIGHT_PX,
    maxLanes: READ_PILEUP_DEFAULT_MAX_ROWS,
    overflowBandHeightPx: READ_PILEUP_DEFAULT_OVERFLOW_BAND_HEIGHT_PX,
    trackPx: READ_PILEUP_DEFAULT_TRACK_HEIGHT_PX,
    records: [],
    source: {
      bamPath,
      ...(indexPath ? { indexPath } : {}),
      ...(referencePath ? { referencePath } : {}),
      ...(generation ? { generation } : {}),
      ...(remote ? { remote } : {}),
      ...(grantExpiresAtMs !== undefined ? { grantExpiresAtMs } : {}),
      ...(htsget ? { htsget } : {}),
    },
  };
}

export function basenameForPath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? path;
  return withoutQuery.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function stableSourceHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(36);
}
