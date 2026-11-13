import type { AlignedReadSourceGenerationV1 } from '../../shared/aligned-read-source-generation';
import type {
  RemoteAlignmentLocatorV1,
  RemoteAlignmentMaterializationV1,
  RemoteFileReceiptV1,
  RemoteGenomicsRuntimeStateV1,
  RemoteSshFailureV1,
} from '../../shared/remote-genomics-ipc';

export interface RemotePileupConnectionState {
  readonly sourceId?: string;
  readonly state: RemoteGenomicsRuntimeStateV1;
  readonly attempt: number;
  readonly transportGeneration: number;
  readonly lastFailure: RemoteSshFailureV1 | null;
  readonly updatedAt: number;
}

export interface PileupSource {
  bamPath: string;
  indexPath?: string;
  referencePath?: string;
  generation?: AlignedReadSourceGenerationV1;
  grantExpiresAtMs?: number;
  htsget?: {
    readonly sourceToken: string;
    readonly sourceIdentity: string;
    readonly format: 'BAM' | 'CRAM';
  };
  remote?: {
    locator: RemoteAlignmentLocatorV1;
    sessionId?: string;
    tileBaseUrl?: string;
    generation?: {
      alignment: RemoteFileReceiptV1;
      index: RemoteFileReceiptV1;
    };
    connection?: RemotePileupConnectionState;
  };
  admissionError?: string;
}

export function remoteAlignmentHeaderSource(
  materialization: RemoteAlignmentMaterializationV1
): PileupSource {
  return {
    bamPath: materialization.bamUrl,
    indexPath: materialization.indexPath,
    ...(materialization.tileBaseUrl
      ? {
          remote: { locator: materialization.locator, tileBaseUrl: materialization.tileBaseUrl },
        }
      : {}),
  };
}

export function pileupSourceRequestFields(source: PileupSource): Record<string, unknown> {
  if (source.admissionError) {
    throw new Error(source.admissionError);
  }
  const fields: Record<string, unknown> = source.htsget
    ? {
        htsgetToken: source.htsget.sourceToken,
        htsgetSourceIdentity: source.htsget.sourceIdentity,
        htsgetFormat: source.htsget.format,
      }
    : { bamPath: source.bamPath };
  if (!source.htsget && source.indexPath != null) fields.indexPath = source.indexPath;
  if (source.referencePath != null) fields.referencePath = source.referencePath;
  if (source.generation != null) fields.sourceGeneration = source.generation;
  return fields;
}
