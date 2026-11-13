import type { GenomeTileFidelity, GenomeTileRequest } from '../../../shared/indexed-genome';

import { type LaneLimit, computeLaneEpoch } from './stable-lane-assignment';

export interface AnnotationTileRequestInput {
  chrom: string;
  start: number;
  end: number;
  lod: number;
  generation: number;
  fidelity: GenomeTileFidelity;
  byteBudget: number;
  annotationOwner?: {
    start: number;
    end: number;
  };
  sourceFingerprint: string;
  visibleTypes: ReadonlySet<string>;
  laneLimit: LaneLimit;
}

export function buildAnnotationTileRequest(input: AnnotationTileRequestInput): GenomeTileRequest {
  const laneEpoch = computeLaneEpoch({
    sourceFingerprint: input.sourceFingerprint,
    chrom: input.chrom,
    visibleTypes: input.visibleTypes,
    laneLimit: input.laneLimit,
  });
  return {
    trackId: `${input.chrom}:annotations`,
    chrom: input.chrom,
    start: input.start,
    end: input.end,
    lod: input.lod,
    generation: input.generation,
    fidelity: input.fidelity,
    byteBudget: input.byteBudget,
    ...(input.annotationOwner ? { annotationOwner: input.annotationOwner } : {}),
    laneEpoch,
  };
}
