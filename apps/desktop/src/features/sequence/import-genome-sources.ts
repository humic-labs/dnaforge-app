import type { LocalAuthorityContext } from '../../shared/local-indexed-track-authority';
import { trackAdmissionRequestLabel, type TrackAdmissionRequestV1 } from '@waypoint/genome-data';

import type { AlignmentReferenceIdentity } from './alignment-header-client';
import {
  attachAlignedReadRequest,
  type AlignedReadImportPhase,
  type LocalCramReferenceResolver,
} from './attach-aligned-read-request';
import { attachTrackAdmissionRequest } from './attach-track-source';
import {
  attachVariantRequest,
  commitVariantSourceToTab,
  type VariantSourceCommit,
} from './attach-variant-request';
import { admitTrackSource, resolveTrackAdmissionRequest } from './track-admission';

export type GenomeSourceImportFamily = 'data' | 'reads' | 'variants';

export function genomeSourceImportFamily(formatId: string | undefined): GenomeSourceImportFamily {
  if (formatId === 'bam' || formatId === 'cram') return 'reads';
  if (formatId === 'vcf' || formatId === 'bcf') return 'variants';
  return 'data';
}

export interface GenomeSourceImportProgress {
  readonly request: TrackAdmissionRequestV1;
  readonly label: string;
  readonly family: GenomeSourceImportFamily;
  readonly phase: AlignedReadImportPhase | 'admitting';
  readonly stepNumber: number;
  readonly stepCount: number;
  readonly sourceNumber: number;
  readonly sourceCount: number;
}

export type GenomeSourceImportFailureCode = 'INVALID_REQUEST' | 'CANCELLED' | 'ADMISSION_FAILED';

export type GenomeSourceImportOutcome =
  | Readonly<{
      request: TrackAdmissionRequestV1;
      label: string;
      family: GenomeSourceImportFamily;
      status: 'added' | 'duplicate';
      trackId: string;
    }>
  | Readonly<{
      request: TrackAdmissionRequestV1;
      label: string;
      family: GenomeSourceImportFamily;
      status: 'failed';
      code: GenomeSourceImportFailureCode;
      message: string;
    }>;

export interface ImportGenomeSourcesInput {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly assemblyDisplayName: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly requests: ReadonlyArray<TrackAdmissionRequestV1>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: GenomeSourceImportProgress) => void;
  readonly resolveLocalCramReference?: LocalCramReferenceResolver;
  readonly commitVariantSource?: VariantSourceCommit;
  readonly localAuthorityContext?: LocalAuthorityContext;
  readonly admit?: typeof admitTrackSource;
}

export async function importGenomeSources(
  input: ImportGenomeSourcesInput
): Promise<ReadonlyArray<GenomeSourceImportOutcome>> {
  const outcomes: GenomeSourceImportOutcome[] = [];
  const sourceCount = input.requests.length;
  for (const [index, request] of input.requests.entries()) {
    let resolved: TrackAdmissionRequestV1;
    try {
      resolved = resolveTrackAdmissionRequest(request, input.assemblyId);
    } catch (error) {
      outcomes.push({
        request,
        label: safeLabel(request),
        family: genomeSourceImportFamily(request.formatId),
        status: 'failed',
        code: 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const family = genomeSourceImportFamily(resolved.formatId);
    const label = trackAdmissionRequestLabel(resolved);
    if (input.signal?.aborted) {
      outcomes.push({
        request: resolved,
        label,
        family,
        status: 'failed',
        code: 'CANCELLED',
        message: `${label} was not added because the import was cancelled.`,
      });
      continue;
    }
    const progress = (
      phase: GenomeSourceImportProgress['phase'],
      stepNumber: number,
      stepCount: number
    ) =>
      input.onProgress?.({
        request: resolved,
        label,
        family,
        phase,
        stepNumber,
        stepCount,
        sourceNumber: index + 1,
        sourceCount,
      });
    progress('admitting', 1, 1);
    try {
      switch (family) {
        case 'reads': {
          const attached = await attachAlignedReadRequest({
            request: resolved,
            genome: {
              laneOwnerId: input.laneOwnerId,
              assemblyId: input.assemblyId,
              displayName: input.assemblyDisplayName,
              references: input.assemblyReferences,
            },
            signal: input.signal,
            onProgress: (phase, _label, stepNumber) => progress(phase, stepNumber, 4),
            resolveLocalCramReference: input.resolveLocalCramReference,
            admit: input.admit,
          });
          attached.coverage?.catch(() => undefined);
          outcomes.push({
            request: resolved,
            label: attached.label,
            family,
            status: attached.status,
            trackId: attached.trackId,
          });
          break;
        }
        case 'variants': {
          const attached = await attachVariantRequest({
            request: resolved,
            assemblyId: input.assemblyId,
            assemblyReferences: input.assemblyReferences,
            signal: input.signal,
            commit: input.commitVariantSource ?? commitVariantSourceToTab(input.laneOwnerId),
            admit: input.admit,
          });
          outcomes.push({
            request: resolved,
            label: attached.label,
            family,
            status: attached.status,
            trackId: attached.trackId,
          });
          break;
        }
        default: {
          const attached = await attachTrackAdmissionRequest({
            laneOwnerId: input.laneOwnerId,
            assemblyId: input.assemblyId,
            assemblyReferences: input.assemblyReferences,
            request: resolved,
            signal: input.signal,
            localAuthorityContext: input.localAuthorityContext,
            admit: input.admit,
          });
          outcomes.push({
            request: resolved,
            label: attached.label,
            family,
            status: attached.status,
            trackId: attached.trackId,
          });
        }
      }
    } catch (error) {
      outcomes.push({
        request: resolved,
        label,
        family,
        status: 'failed',
        code: input.signal?.aborted ? 'CANCELLED' : 'ADMISSION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

function safeLabel(request: TrackAdmissionRequestV1): string {
  try {
    return trackAdmissionRequestLabel(request);
  } catch {
    return request.label ?? 'Genomic data';
  }
}
