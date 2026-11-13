import { StrictMode, Suspense } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AnnotationPresentationPage, Genome } from '@waypoint/genome-renderer';
import {
  annotationResidentPagePublicationReducer,
  annotationPresentationSnapshotReducer,
  INITIAL_ANNOTATION_RESIDENT_PAGE_PUBLICATION_STATE,
  INITIAL_ANNOTATION_PRESENTATION_SNAPSHOT_STATE,
  type AnnotationPresentationSnapshotCandidate,
  useAnnotationPresentationSnapshot,
} from './useAnnotationPresentationSnapshot';

const never = new Promise<never>(() => undefined);

function candidate(semanticIdentity: Genome): AnnotationPresentationSnapshotCandidate {
  return {
    semanticIdentity,
    sourceIdentity: 'grch38-source',
    genomeLengthBp: 3_088_269_832,
    policyKey: 'mRNA:canonical:12',
    features: semanticIdentity.features ?? [],
    requestedLayerTypes: ['mRNA'],
    layout: { maxAnnotationLane: 11, maxCdsLane: -1 },
    exactCoverage: [],
  };
}

function Probe({ value, suspend }: { value: Genome; suspend?: boolean }) {
  const snapshot = useAnnotationPresentationSnapshot(candidate(value));
  if (suspend) throw never;
  return (
    <output data-testid="snapshot" data-generation={snapshot?.generation ?? 'none'}>
      {snapshot?.features.length ?? -1}
    </output>
  );
}

describe('useAnnotationPresentationSnapshot committed publication', () => {
  it('retains only active/candidate policy streams instead of pinning every lane toggle', () => {
    const base = candidate({
      name: 'GRCh38',
      sourceIdentity: 'grch38-source',
      length: 3_088_269_832,
      circular: false,
      features: [],
    });
    let state = INITIAL_ANNOTATION_PRESENTATION_SNAPSHOT_STATE;
    for (const policyKey of ['mRNA:canonical:8', 'mRNA:canonical:12', 'mRNA:canonical:24']) {
      state = annotationPresentationSnapshotReducer(state, {
        type: 'publish-committed',
        candidate: { ...base, semanticIdentity: {}, policyKey },
      });
    }
    expect(state.entries.size).toBe(2);
    expect([...state.entries.keys()]).toEqual([
      'grch38-source\u0000mRNA:canonical:12',
      'grch38-source\u0000mRNA:canonical:24',
    ]);
  });

  it('publishes resident pages without constructing flat features or layout authority', () => {
    const page = Object.freeze({
      contract: 'annotation-presentation-page.v1' as const,
      pageKey: 'source\u0000policy\u0000chr1\u0000mRNA\u00000\u00002097152',
      chromosomeId: 'chr1',
      trackId: 'mRNA',
      trackOrder: 0,
      laneCapacity: 12,
      ownerStartBp: 0,
      ownerEndBp: 2_097_152,
      maxFeatureEndBp: 2_097_152,
      contentRevision: 'annotation-page-content.sha256.v1:abc',
      features: Object.freeze([]),
    }) satisfies AnnotationPresentationPage;
    const pages: AnnotationPresentationPage[] = [page];
    const semanticIdentity = {};
    const state = annotationResidentPagePublicationReducer(
      INITIAL_ANNOTATION_RESIDENT_PAGE_PUBLICATION_STATE,
      {
        type: 'publish-committed',
        candidate: {
          semanticIdentity,
          sourceIdentity: 'grch38-source',
          genomeLengthBp: 3_088_269_832,
          policyKey: 'mRNA-source-pages',
          requestedLayerTypes: ['mRNA'],
          exactCoverage: [],
          pages,
        },
      }
    );

    expect(state.current?.pages).not.toBe(pages);
    expect(state.current?.pages[0]).toBe(page);
    expect(Object.isFrozen(state.current?.pages)).toBe(true);
    expect(state.current).not.toHaveProperty('features');
    expect(state.current).not.toHaveProperty('layout');
  });

  it('does not double-allocate a generation under StrictMode effects', async () => {
    const initial: Genome = {
      name: 'GRCh38',
      sourceIdentity: 'grch38-source',
      length: 3_088_269_832,
      circular: false,
      features: [],
    };
    render(
      <StrictMode>
        <Probe value={initial} />
      </StrictMode>
    );

    await waitFor(() =>
      expect(screen.getByTestId('snapshot')).toHaveAttribute('data-generation', '0')
    );
  });

  it('does not consume a generation for a suspended/discarded render', async () => {
    const makeGenome = (featureCount: number): Genome => ({
      name: 'GRCh38',
      sourceIdentity: 'grch38-source',
      length: 3_088_269_832,
      circular: false,
      features: Array.from({ length: featureCount }, (_, id) => ({
        id,
        type: 'mRNA',
        start: id * 10,
        end: id * 10 + 5,
        direction: 'forward' as const,
        displayName: `tx-${id}`,
        color: 0,
        lane: id,
      })),
    });
    const initial = makeGenome(62);
    const discarded = makeGenome(40);
    const committed = makeGenome(28);
    const { rerender } = render(
      <Suspense fallback={<span data-testid="fallback" />}>
        <Probe value={initial} />
      </Suspense>
    );
    await waitFor(() =>
      expect(screen.getByTestId('snapshot')).toHaveAttribute('data-generation', '0')
    );

    rerender(
      <Suspense fallback={<span data-testid="fallback" />}>
        <Probe value={discarded} suspend />
      </Suspense>
    );
    expect(screen.getByTestId('fallback')).toBeInTheDocument();

    rerender(
      <Suspense fallback={<span data-testid="fallback" />}>
        <Probe value={committed} />
      </Suspense>
    );
    await waitFor(() => {
      expect(screen.getByTestId('snapshot')).toHaveAttribute('data-generation', '1');
      expect(screen.getByTestId('snapshot')).toHaveTextContent('28');
    });
  });
});
