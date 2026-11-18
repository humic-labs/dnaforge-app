import type { MutationMarker } from '@waypoint/workspace-editor';
import {
  alignmentEvidence,
  interpretReferenceAlignment,
  mutationAlignmentColumns,
  type AlignmentEvidence,
  type AlignmentObservationSource,
  type ReferenceAlignmentObservation,
  type FunctionalImpact,
} from '@waypoint/sequence-utils';
import type {
  VerificationTrack,
  Mutation,
  MutationType,
  MutationEffect,
  TrackStatus,
  StructuralAnalysis,
  StructuralType,
} from '../types';
import type { AlignmentApiResponse } from './alignment-api';
import { debugWarn } from '../../../utils/debug-log';

export function queryInReferenceCoordinates(
  alignedReference: string,
  alignedQuery: string,
  reference: string
): string {
  if (
    alignedReference.length !== alignedQuery.length ||
    degap(alignedReference).toUpperCase() !== reference.toUpperCase()
  ) {
    throw new Error(
      'This alignment does not cover the reference in its original coordinate order. Protein consequences cannot be assigned safely.'
    );
  }
  let projected = '';
  for (let index = 0; index < alignedReference.length; index++) {
    if (alignedReference[index] === '-') continue;
    projected += alignedQuery[index] === '-' ? 'N' : alignedQuery[index];
  }
  return projected;
}

export function toMutationEffect(
  impact: FunctionalImpact,
  mutationType: MutationType
): Mutation['effect'] | undefined {
  if (impact.affects_cds && impact.classification) {
    let classification: MutationEffect;
    if (impact.classification === 'missense' && mutationType === 'insertion') {
      classification = 'inframe_insertion';
    } else if (impact.classification === 'missense' && mutationType === 'deletion') {
      classification = 'inframe_deletion';
    } else {
      classification = impact.classification;
    }

    return {
      featureName: impact.cds_name || impact.annotation_names[0] || '',
      featureType: 'CDS',
      aminoAcidChange: impact.amino_acid_change,
      classification,
    };
  }

  if (impact.in_annotation) {
    return {
      featureName: impact.annotation_names[0] || '',
      featureType: 'annotation',
      classification: 'intergenic',
    };
  }

  return undefined;
}

export function degap(sequence: string): string {
  return sequence.replace(/-/g, '');
}

export function convertMutation(
  apiMutation: AlignmentApiResponse['mutations'][0],
  _index: number
): Mutation {
  const id = `mut-${apiMutation.position}-${apiMutation.type}-${apiMutation.ref_base || ''}-${apiMutation.query_base || ''}`;
  return {
    id,
    position: apiMutation.position,
    type: apiMutation.type,
    referenceBase: apiMutation.ref_base,
    alternateBase: apiMutation.query_base,
    length: apiMutation.length,
  };
}

export function convertStructuralAnalysis(
  apiAnalysis: NonNullable<AlignmentApiResponse['analysis']>,
  observation: ReferenceAlignmentObservation
): StructuralAnalysis {
  const referencePositions = observation.referencePositions.filter(
    (position): position is number => position !== null
  );
  const globalPosition = (localPosition: number | null): number | null => {
    if (localPosition === null) return null;
    const position = referencePositions[localPosition - 1];
    if (position === undefined) {
      throw new Error('A structural region falls outside its retained reference columns.');
    }
    return position;
  };
  return {
    structuralRegions: apiAnalysis.structural_regions.map((sr) => ({
      id: sr.id,
      type: sr.type as StructuralType,
      confidence: sr.confidence,
      severity: sr.severity,
      columnStart: sr.column_start,
      columnEnd: sr.column_end,
      refStart: globalPosition(sr.ref_start),
      refEnd: globalPosition(sr.ref_end),
      lengthColumns: sr.length_columns,
      forwardIdentity: sr.forward_identity,
      mutationIndices: sr.mutation_indices,
      classificationMethod: sr.classification_method,
      classificationDetails: sr.classification_details,
    })),
    pointMutationIndices: apiAnalysis.point_mutations.map((pm) => pm.index),
    overallAssessment: apiAnalysis.overall_assessment,
    warnings: apiAnalysis.warnings,
  };
}

export function getTrackStatus(
  identity: number,
  mutationCount: number,
  overallAssessment?: { result: 'PASS' | 'FAIL' | 'REVIEW' },
  complete = true
): TrackStatus {
  if (!complete) return 'incomplete';
  if (overallAssessment) {
    switch (overallAssessment.result) {
      case 'PASS':
        return mutationCount === 0 ? 'pass' : 'variants';
      case 'FAIL':
        return 'fail';
      case 'REVIEW':
        return 'variants';
    }
  }

  if (identity >= 99.5 && mutationCount === 0) return 'pass';
  if (identity >= 95.0) return 'variants';
  return 'fail';
}

export function calculateCoverage(
  alignedRef: string,
  alignedQuery: string
): { start: number; end: number } {
  const result = interpretReferenceAlignment(
    { alignedReference: alignedRef, alignedQuery },
    { sequence: degap(alignedRef), topology: 'linear' }
  );
  return result.kind === 'placed' ? result.value.coverage : { start: 0, end: 0 };
}

export function getAlignmentEvidence(source: AlignmentObservationSource): AlignmentEvidence;
export function getAlignmentEvidence(alignedRef: string, alignedQuery: string): AlignmentEvidence;
export function getAlignmentEvidence(
  source: AlignmentObservationSource | string,
  alignedQuery?: string
): AlignmentEvidence {
  return alignmentEvidence(
    typeof source === 'string'
      ? {
          alignedReference: source,
          alignedQuery: alignedQuery ?? '',
          circularOffset: 0,
          referenceLength: degap(source).length,
        }
      : source
  );
}

export function computeTrackMutations(track: VerificationTrack): MutationMarker[] {
  if (!track.alignment) return [];

  return track.mutations
    .map((mutation): MutationMarker | null => {
      const columns = mutationAlignmentColumns(
        track.alignment,
        mutation,
        track.testedReference?.topology ??
          ((track.alignment.circularOffset ?? 0) > 0 ? 'circular' : 'linear')
      );
      if (!columns) {
        debugWarn(
          `[computeTrackMutations] Mutation position ${mutation.position} not found in alignment`
        );
        return null;
      }
      return {
        ...columns,
        type: mutation.type,
        refBase: mutation.type === 'insertion' ? '-' : mutation.referenceBase,
        queryBase: mutation.type === 'deletion' ? '-' : mutation.alternateBase,
        refPosition: mutation.position,
      };
    })
    .filter((marker): marker is MutationMarker => marker !== null);
}
