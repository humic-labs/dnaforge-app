import type { MutationMarker } from '@waypoint/workspace-editor';
import type { FunctionalImpact } from '@waypoint/sequence-utils';
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
  apiAnalysis: NonNullable<AlignmentApiResponse['analysis']>
): StructuralAnalysis {
  return {
    structuralRegions: apiAnalysis.structural_regions.map((sr) => ({
      id: sr.id,
      type: sr.type as StructuralType,
      confidence: sr.confidence,
      severity: sr.severity,
      columnStart: sr.column_start,
      columnEnd: sr.column_end,
      refStart: sr.ref_start,
      refEnd: sr.ref_end,
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
  let start = 0;
  let end = 0;
  let refPos = 0;
  let hasCoverage = false;

  for (let i = 0; i < alignedRef.length; i++) {
    if (alignedRef[i] !== '-') {
      refPos++;
      if (alignedQuery[i] !== '-') {
        if (!hasCoverage) start = refPos;
        hasCoverage = true;
        end = refPos;
      }
    }
  }

  return { start, end };
}

export function getAlignmentEvidence(alignedRef: string, alignedQuery: string) {
  const first = alignedQuery.search(/[^-]/);
  const last = alignedQuery.replace(/-+$/, '').length - 1;
  let total = 0;
  let unresolved = 0;
  let ambiguousInsertions = 0;
  for (let col = 0; col < alignedRef.length; col++) {
    const ref = alignedRef[col].toUpperCase();
    const query = (alignedQuery[col] ?? '').toUpperCase();
    if (ref === '-') {
      if (query !== '-' && !/^[ACGTU]$/.test(query)) ambiguousInsertions++;
      continue;
    }
    total++;
    if (
      first < 0 ||
      col < first ||
      col > last ||
      !/^[ACGTU]$/.test(ref) ||
      (query !== '-' && !/^[ACGTU]$/.test(query))
    )
      unresolved++;
  }
  return {
    total,
    unresolved,
    ambiguousInsertions,
    complete:
      total > 0 &&
      alignedRef.length === alignedQuery.length &&
      unresolved === 0 &&
      ambiguousInsertions === 0,
  };
}

export function computeTrackMutations(track: VerificationTrack): MutationMarker[] {
  if (!track.alignment) return [];

  const gappedRef = track.alignment.alignedReference;
  const gappedQuery = track.alignment.alignedQuery;

  if (!gappedRef || gappedRef.length === 0) return [];

  const refPosToColumnMap = new Map<number, number>();
  let refPos = 0;
  let lastRefPos = 0;
  let lastCol = 0;
  for (let col = 0; col < gappedRef.length; col++) {
    if (gappedRef[col] !== '-') {
      refPos++;
      refPosToColumnMap.set(refPos, col);
      lastRefPos = refPos;
      lastCol = col;
    }
  }

  const maxCol = gappedRef.length - 1;

  return track.mutations
    .map((mutation): MutationMarker | null => {
      const startCol = refPosToColumnMap.get(mutation.position);

      if (startCol === undefined) {
        debugWarn(
          `[computeTrackMutations] Mutation position ${mutation.position} not found in alignment (ref length: ${lastRefPos})`
        );
        return null;
      }

      if (mutation.type === 'substitution') {
        return {
          column: startCol,
          type: mutation.type,
          refBase: mutation.referenceBase,
          queryBase: mutation.alternateBase,
          refPosition: mutation.position,
        };
      } else if (mutation.type === 'deletion') {
        const length = mutation.length || 1;
        const endPos = mutation.position + length - 1;

        let endCol: number;
        if (endPos > lastRefPos) {
          endCol = lastCol;
        } else {
          endCol = refPosToColumnMap.get(endPos) ?? startCol;
        }

        return {
          column: startCol,
          endColumn: length > 1 ? endCol : undefined,
          type: mutation.type,
          refBase: mutation.referenceBase,
          queryBase: '-',
          refPosition: mutation.position,
        };
      } else {
        const anchorCol = startCol;
        const insertionLength = mutation.length || mutation.alternateBase?.length || 1;

        const gapCols: number[] = [];
        for (let col = anchorCol - 1; col >= 0 && gapCols.length < insertionLength; col--) {
          if (gappedRef[col] === '-' && gappedQuery[col] !== '-') {
            gapCols.unshift(col);
          } else {
            break;
          }
        }

        if (gapCols.length === 0) {
          for (let col = anchorCol + 1; col <= maxCol && gapCols.length < insertionLength; col++) {
            if (gappedRef[col] === '-' && gappedQuery[col] !== '-') {
              gapCols.push(col);
            } else {
              break;
            }
          }
        }

        let insertStart: number;
        let insertEnd: number;

        if (gapCols.length > 0) {
          insertStart = gapCols[0];
          insertEnd = gapCols[gapCols.length - 1];
        } else {
          insertStart = anchorCol;
          insertEnd = anchorCol;
        }

        return {
          column: insertStart,
          endColumn: insertEnd !== insertStart ? insertEnd : undefined,
          type: mutation.type,
          refBase: '-',
          queryBase: mutation.alternateBase,
          refPosition: mutation.position,
        };
      }
    })
    .filter((marker): marker is MutationMarker => marker !== null);
}
