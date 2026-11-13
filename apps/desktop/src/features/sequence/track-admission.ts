import type { LocalAuthorityContext } from '../../shared/local-indexed-track-authority';
import {
  createDefaultFormatRegistry,
  formatInputFromTrackAdmissionRequest,
  parseTrackAdmissionRequestV1,
  type AdmittedTrackSource,
  type LocalFileTrackSourceV1,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import type { AlignmentReferenceIdentity } from './alignment-header-client';
import {
  admitAlignedReadTrackRequest,
  type AlignedReadAdmissionProgress,
  type AlignedReadRuntimeAdmission,
} from './aligned-read-track-admission';
import { admitIndexedBigBedRequest, admitIndexedBigWigRequest } from './indexed-track-admission';
import {
  admitTextIntervalTrackRequest,
  isTextIntervalFormatId,
} from './text-interval-track-admission';
import { admitVariantTrackRequest, type VariantRuntimeAdmission } from './variant-track-admission';

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  bam: 'BAM',
  bcf: 'BCF',
  bed: 'BED',
  bigbed: 'BigBed',
  bigwig: 'BigWig',
  cram: 'CRAM',
  fasta: 'FASTA',
  genbank: 'GenBank',
  genepred: 'genePred',
  gff3: 'GFF/GTF',
  gtf: 'GTF',
  narrowpeak: 'narrowPeak',
  broadpeak: 'broadPeak',
  refflat: 'refFlat',
  vcf: 'VCF',
};

export async function admitTrackSource(input: {
  readonly request: TrackAdmissionRequestV1;
  readonly assemblyId: string;
  readonly assemblyDisplayName?: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly signal?: AbortSignal;
  readonly localAuthorityContext?: LocalAuthorityContext;
  readonly onAlignedReadProgress?: (progress: AlignedReadAdmissionProgress) => void;
  readonly onAlignedReadRuntime?: (runtime: AlignedReadRuntimeAdmission) => void;
  readonly onVariantRuntime?: (runtime: VariantRuntimeAdmission) => void;
  readonly reuseRememberedPreparation?: boolean;
  readonly resolveLocalCramReference?: (
    request: TrackAdmissionRequestV1
  ) => Promise<LocalFileTrackSourceV1 | null>;
}): Promise<AdmittedTrackSource> {
  const request = resolveTrackAdmissionRequest(input.request, input.assemblyId);

  switch (request.formatId) {
    case 'bam':
    case 'cram':
      return admitAlignedReadTrackRequest({
        request,
        assemblyReferences: input.assemblyReferences,
        ...(input.assemblyDisplayName ? { assemblyDisplayName: input.assemblyDisplayName } : {}),
        signal: input.signal,
        ...(input.onAlignedReadProgress ? { onProgress: input.onAlignedReadProgress } : {}),
        ...(input.onAlignedReadRuntime ? { onRuntimeReady: input.onAlignedReadRuntime } : {}),
        ...(input.resolveLocalCramReference
          ? { resolveLocalCramReference: input.resolveLocalCramReference }
          : {}),
      });
    case 'bigbed':
      return admitIndexedBigBedRequest({
        request,
        assemblyReferences: input.assemblyReferences,
        signal: input.signal,
        localAuthorityContext: input.localAuthorityContext,
      });
    case 'bigwig':
      return admitIndexedBigWigRequest({
        request,
        assemblyReferences: input.assemblyReferences,
        signal: input.signal,
        localAuthorityContext: input.localAuthorityContext,
      });
    case 'bcf':
    case 'vcf':
      return admitVariantTrackRequest({
        request,
        assemblyReferences: input.assemblyReferences,
        signal: input.signal,
        ...(input.onVariantRuntime ? { onRuntimeReady: input.onVariantRuntime } : {}),
        ...(input.reuseRememberedPreparation ? { reuseRememberedPreparation: true } : {}),
      });
    default: {
      if (isTextIntervalFormatId(request.formatId)) {
        return admitTextIntervalTrackRequest({
          request,
          assemblyReferences: input.assemblyReferences,
          signal: input.signal,
          localAuthorityContext: input.localAuthorityContext,
        });
      }
      const formatId = request.formatId ?? 'unknown';
      const name = FORMAT_NAMES[formatId] ?? formatId.toUpperCase();
      throw new Error(`${name} viewing is not implemented by the track admission registry.`);
    }
  }
}

export function resolveTrackAdmissionRequest(
  value: TrackAdmissionRequestV1,
  assemblyId: string
): TrackAdmissionRequestV1 {
  const parsed = parseTrackAdmissionRequestV1(value);
  if (parsed.assemblyId !== assemblyId) {
    throw new Error(`Track source belongs to assembly ${parsed.assemblyId}, not ${assemblyId}.`);
  }
  return parsed.formatId ? parsed : detectDirectFormat(parsed);
}

function detectDirectFormat(request: TrackAdmissionRequestV1): TrackAdmissionRequestV1 {
  const sourceInput = formatInputFromTrackAdmissionRequest(request);
  const handler = createDefaultFormatRegistry().detect(sourceInput);
  if (!handler) {
    throw new Error('The genomic data format could not be detected from this source.');
  }
  return parseTrackAdmissionRequestV1({ ...request, formatId: handler.id });
}
