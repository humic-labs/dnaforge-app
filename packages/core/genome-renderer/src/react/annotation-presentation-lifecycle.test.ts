import { describe, expect, it, vi } from 'vitest';

import type {
  AnnotationFlatPresentationSnapshot,
  AnnotationResidentPagePublication,
  Genome,
} from '@waypoint/genome-renderer';
import {
  annotationFlatPresentationSnapshotMatchesGenome,
  annotationResidentPagePublicationMatchesGenome,
  applyMatchingAnnotationFlatPresentationSnapshot,
  ingestMatchingAnnotationResidentPages,
  invalidateAnnotationHoverAfterSnapshotApply,
} from './annotation-presentation-lifecycle';

const genome: Genome = {
  name: 'GRCh38',
  sourceIdentity: 'grch38-source',
  length: 3_088_269_832,
  circular: false,
};

function snapshot(
  generation: number,
  overrides: Partial<AnnotationFlatPresentationSnapshot> = {}
): AnnotationFlatPresentationSnapshot {
  return {
    contract: 'annotation-presentation-snapshot.v1',
    sourceIdentity: 'grch38-source',
    genomeLengthBp: 3_088_269_832,
    policyKey: 'mRNA:canonical:12',
    generation,
    features: [],
    requestedLayerTypes: ['mRNA'],
    layout: { maxAnnotationLane: 11, maxCdsLane: -1 },
    exactCoverage: [],
    ...overrides,
  };
}

function residentPages(
  generation: number,
  overrides: Partial<AnnotationResidentPagePublication> = {}
): AnnotationResidentPagePublication {
  return {
    contract: 'annotation-resident-page-publication.v1',
    sourceIdentity: 'grch38-source',
    genomeLengthBp: 3_088_269_832,
    policyKey: 'mRNA:source-pages',
    generation,
    requestedLayerTypes: ['mRNA'],
    exactCoverage: [],
    pages: [],
    ...overrides,
  };
}

describe('annotation presentation React lifecycle guard', () => {
  it('applies a matching snapshot synchronously', () => {
    const setAnnotationFlatPresentationSnapshot = vi.fn(() => ({
      status: 'applied' as const,
      generation: 4,
      invalidatedHover: true as const,
    }));
    const current = snapshot(4);

    expect(
      applyMatchingAnnotationFlatPresentationSnapshot(
        { setAnnotationFlatPresentationSnapshot },
        genome,
        current
      )
    ).toEqual({ status: 'applied', generation: 4, invalidatedHover: true });
    expect(setAnnotationFlatPresentationSnapshot).toHaveBeenCalledOnce();
    expect(setAnnotationFlatPresentationSnapshot).toHaveBeenCalledWith(current);
  });

  it('routes resident pages exclusively through the typed ingestion API', () => {
    const ingestAnnotationResidentPages = vi.fn(() => ({
      status: 'applied' as const,
      generation: 7,
      invalidatedHover: true as const,
    }));
    const setAnnotationFlatPresentationSnapshot = vi.fn();
    const current = residentPages(7);

    expect(
      ingestMatchingAnnotationResidentPages(
        { ingestAnnotationResidentPages, setAnnotationFlatPresentationSnapshot },
        genome,
        current
      )
    ).toEqual({ status: 'applied', generation: 7, invalidatedHover: true });
    expect(ingestAnnotationResidentPages).toHaveBeenCalledOnce();
    expect(ingestAnnotationResidentPages).toHaveBeenCalledWith(current);
    expect(setAnnotationFlatPresentationSnapshot).not.toHaveBeenCalled();
  });

  it('does not send a stale source or wrong-length publication to the renderer', () => {
    const setAnnotationFlatPresentationSnapshot = vi.fn();
    const staleSource = snapshot(1, { sourceIdentity: 'previous-source' });
    const wrongLength = snapshot(2, { genomeLengthBp: genome.length - 1 });
    const deprecatedMixedSnapshot = {
      ...snapshot(3),
      pages: [],
    } as unknown as AnnotationFlatPresentationSnapshot;

    expect(annotationFlatPresentationSnapshotMatchesGenome(staleSource, genome)).toBe(false);
    expect(annotationFlatPresentationSnapshotMatchesGenome(wrongLength, genome)).toBe(false);
    expect(annotationFlatPresentationSnapshotMatchesGenome(deprecatedMixedSnapshot, genome)).toBe(
      false
    );
    expect(
      applyMatchingAnnotationFlatPresentationSnapshot(
        { setAnnotationFlatPresentationSnapshot },
        genome,
        staleSource
      )
    ).toBeNull();
    expect(
      applyMatchingAnnotationFlatPresentationSnapshot(
        { setAnnotationFlatPresentationSnapshot },
        genome,
        wrongLength
      )
    ).toBeNull();
    expect(
      applyMatchingAnnotationFlatPresentationSnapshot(
        { setAnnotationFlatPresentationSnapshot },
        genome,
        deprecatedMixedSnapshot
      )
    ).toBeNull();
    expect(setAnnotationFlatPresentationSnapshot).not.toHaveBeenCalled();
  });

  it('rejects stale resident pages before renderer ingress', () => {
    const ingestAnnotationResidentPages = vi.fn();
    const staleSource = residentPages(1, { sourceIdentity: 'previous-source' });
    const wrongLength = residentPages(2, { genomeLengthBp: genome.length - 1 });

    expect(annotationResidentPagePublicationMatchesGenome(staleSource, genome)).toBe(false);
    expect(annotationResidentPagePublicationMatchesGenome(wrongLength, genome)).toBe(false);
    expect(
      ingestMatchingAnnotationResidentPages({ ingestAnnotationResidentPages }, genome, staleSource)
    ).toBeNull();
    expect(
      ingestMatchingAnnotationResidentPages({ ingestAnnotationResidentPages }, genome, wrongLength)
    ).toBeNull();
    expect(ingestAnnotationResidentPages).not.toHaveBeenCalled();
  });

  it('clears artifact-local hover synchronously after an applied publication', () => {
    const state = { hoveredId: 41, hoverPosition: 200 };
    const onFeatureHover = vi.fn();
    const onHoverChange = vi.fn();

    expect(
      invalidateAnnotationHoverAfterSnapshotApply(
        { status: 'applied', generation: 5, invalidatedHover: true },
        state,
        onFeatureHover,
        onHoverChange
      )
    ).toBe(true);
    expect(state).toEqual({ hoveredId: null, hoverPosition: null });
    expect(onFeatureHover).toHaveBeenCalledWith(null);
    expect(onHoverChange).toHaveBeenCalledWith(null);
  });
});
