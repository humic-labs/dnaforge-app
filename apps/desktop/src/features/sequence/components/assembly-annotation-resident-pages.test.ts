// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { AnnotationResidentPagePublication, Feature } from '@waypoint/genome-renderer';
import { computeAnnotationTrackLayoutPlan } from '@waypoint/genome-renderer/pure';
import { AnnotationResidentPageStore } from '@waypoint/genome-renderer/pure';
import { GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP } from '../../../shared/indexed-genome';
import {
  ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
  ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP,
  annotationPageRangesForLocalViewport,
  annotationQueryRangeForLocalOwner,
  buildAnnotationPresentationPages,
  mergeAnnotationPageCoverage,
} from './assembly-annotation-resident-pages';

function feature(start: number, end: number, id = start): Feature {
  return {
    id,
    type: 'mRNA',
    annotationTrackId: 'mRNA',
    annotationTrackLane: 0,
    annotationTrackLaneCapacity: 12,
    start,
    end,
    direction: 'forward',
    displayName: `tx-${id}`,
    color: 0,
    lane: 0,
    exons: [{ start, end }],
  };
}

describe('assembly annotation resident pages', () => {
  it('uses stable aligned owner ranges with prior/next halo pages', () => {
    expect(
      annotationPageRangesForLocalViewport({
        localStartBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP + 100,
        localEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP + 200_100,
        chromosomeLengthBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 4,
        haloPages: 1,
      })
    ).toEqual([
      { localStartBp: 0, localEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP },
      {
        localStartBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
        localEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 2,
      },
      {
        localStartBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 2,
        localEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 3,
      },
    ]);
  });

  it('queries an IPC-safe centered context around a smaller owner page', () => {
    expect(ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP).toBe(GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP);
    const ownerStartBp = ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 10;
    expect(
      annotationQueryRangeForLocalOwner({
        ownerStartBp,
        ownerEndBp: ownerStartBp + ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
        chromosomeLengthBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 64,
      })
    ).toEqual({
      localStartBp:
        ownerStartBp -
        (ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP - ASSEMBLY_ANNOTATION_PAGE_SIZE_BP) / 2,
      localEndBp:
        ownerStartBp +
        ASSEMBLY_ANNOTATION_PAGE_SIZE_BP +
        (ASSEMBLY_ANNOTATION_PAGE_QUERY_SPAN_BP - ASSEMBLY_ANNOTATION_PAGE_SIZE_BP) / 2,
    });
  });

  it('uses the immutable source and versioned projection as the sole page revision authority', async () => {
    const base = {
      sourceIdentity: 'source-a',
      policyKey: 'policy-a',
      chromosomeId: 'chr1',
      ownerStartBp: 0,
      ownerEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
      requestedTracks: [{ trackId: 'mRNA', trackOrder: 0, laneCapacity: 12 }],
    };
    const first = await buildAnnotationPresentationPages({
      ...base,
      features: [feature(10, 100)],
    });
    const revised = await buildAnnotationPresentationPages({
      ...base,
      features: [feature(11, 101)],
    });
    expect(first[0].features).toHaveLength(1);
    expect(revised[0].features).toHaveLength(1);
    expect(revised[0].contentRevision).toBe(first[0].contentRevision);

    const semanticVariants: Feature[] = [
      { ...feature(10, 100), exons: [{ start: 10, end: 99 }] },
      { ...feature(10, 100), cds: [{ start: 20, end: 80 }] },
      { ...feature(10, 100), canonicalIdentity: 'canonical-revision' },
      { ...feature(10, 100), qualifiers: { tag: 'MANE_Select' } },
      { ...feature(10, 100), color: 0xff00ff },
    ];
    for (const variant of semanticVariants) {
      const [page] = await buildAnnotationPresentationPages({ ...base, features: [variant] });
      expect(page.contentRevision).toBe(first[0].contentRevision);
    }
    const [differentSource] = await buildAnnotationPresentationPages({
      ...base,
      sourceIdentity: 'source-b',
      features: [feature(10, 100)],
    });
    expect(differentSource.contentRevision).not.toBe(first[0].contentRevision);
    const [differentProjection] = await buildAnnotationPresentationPages({
      ...base,
      policyKey: 'policy-b',
      features: [feature(10, 100)],
    });
    expect(differentProjection.contentRevision).not.toBe(first[0].contentRevision);
    const [differentLanePolicy] = await buildAnnotationPresentationPages({
      ...base,
      requestedTracks: [{ trackId: 'mRNA', trackOrder: 0, laneCapacity: 11 }],
      features: [{ ...feature(10, 100), annotationTrackLaneCapacity: 11 }],
    });
    expect(differentLanePolicy.contentRevision).not.toBe(first[0].contentRevision);
  });

  it('emits valid empty track pages', async () => {
    const [page] = await buildAnnotationPresentationPages({
      sourceIdentity: 'source-a',
      policyKey: 'policy-a',
      chromosomeId: 'chr1',
      ownerStartBp: 0,
      ownerEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
      requestedTracks: [{ trackId: 'mRNA', trackOrder: 0, laneCapacity: 12 }],
      features: [],
    });
    expect(page.features).toEqual([]);
    expect(page.maxFeatureEndBp).toBe(ASSEMBLY_ANNOTATION_PAGE_SIZE_BP);
    expect(mergeAnnotationPageCoverage([page])).toEqual([
      { startBp: 0, endBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP },
    ]);
  });

  it('keeps logical annotation types on separate immutable track pages', async () => {
    const gene = { ...feature(10, 100, 1), type: 'gene', annotationTrackId: 'gene' };
    const transcript = feature(20, 90, 2);
    const pages = await buildAnnotationPresentationPages({
      sourceIdentity: 'source-a',
      policyKey: 'policy-a',
      chromosomeId: 'chr1',
      ownerStartBp: 0,
      ownerEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
      requestedTracks: [
        { trackId: 'gene', trackOrder: 0, laneCapacity: 12 },
        { trackId: 'mRNA', trackOrder: 1, laneCapacity: 12 },
      ],
      features: [gene, transcript],
    });
    expect(pages.map((page) => page.trackId)).toEqual(['gene', 'mRNA']);
    expect(pages.map(({ trackOrder, laneCapacity }) => ({ trackOrder, laneCapacity }))).toEqual([
      { trackOrder: 0, laneCapacity: 12 },
      { trackOrder: 1, laneCapacity: 12 },
    ]);
    expect(pages[0].features).toEqual([gene]);
    expect(pages[1].features).toEqual([transcript]);
    expect(Object.isFrozen(pages[0].features)).toBe(true);

    const emptyPages = await buildAnnotationPresentationPages({
      sourceIdentity: 'source-a',
      policyKey: 'policy-a',
      chromosomeId: 'chr1',
      ownerStartBp: 0,
      ownerEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
      requestedTracks: [
        { trackId: 'gene', trackOrder: 0, laneCapacity: 12 },
        { trackId: 'mRNA', trackOrder: 1, laneCapacity: 12 },
      ],
      features: [],
    });
    const heightFor = (sourcePages: typeof pages) =>
      computeAnnotationTrackLayoutPlan({
        tracks: sourcePages.map((page) => ({
          trackId: page.trackId,
          laneCapacity: page.laneCapacity,
        })),
        laneStepPx: 10,
        barHeightPx: 6,
        trackGapPx: 4,
      }).totalHeightPx;
    expect(heightFor(emptyPages)).toBe(heightFor(pages));
  });

  it('can republish a retained AA page while adding the next viewport page', async () => {
    const sourceIdentity = 'source-a';
    const policyKey = 'policy-a';
    const firstPages = await buildAnnotationPresentationPages({
      sourceIdentity,
      policyKey,
      chromosomeId: 'chr11',
      ownerStartBp: 0,
      ownerEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
      requestedTracks: [{ trackId: 'mRNA', trackOrder: 0, laneCapacity: 12 }],
      features: [feature(10, 100)],
    });
    const secondPages = await buildAnnotationPresentationPages({
      sourceIdentity,
      policyKey,
      chromosomeId: 'chr11',
      ownerStartBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
      ownerEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 2,
      requestedTracks: [{ trackId: 'mRNA', trackOrder: 0, laneCapacity: 12 }],
      features: [],
    });
    const store = new AnnotationResidentPageStore({
      sourceIdentity,
      genomeLengthBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 2,
    });
    const publication = (
      generation: number,
      pages: AnnotationResidentPagePublication['pages']
    ): AnnotationResidentPagePublication => ({
      contract: 'annotation-resident-page-publication.v1',
      sourceIdentity,
      genomeLengthBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 2,
      policyKey,
      generation,
      requestedLayerTypes: ['mRNA'],
      exactCoverage: mergeAnnotationPageCoverage(pages),
      pages,
    });

    expect(store.applyPublication(publication(0, firstPages))).toMatchObject({
      status: 'applied',
      built: 1,
    });
    expect(store.applyPublication(publication(1, [...firstPages, ...secondPages]))).toMatchObject({
      status: 'applied',
      built: 1,
      reused: 1,
    });
  });

  it('owns a seam-spanning transcript exactly once and records its overlap reach', async () => {
    const spanning = {
      ...feature(ASSEMBLY_ANNOTATION_PAGE_SIZE_BP - 100, ASSEMBLY_ANNOTATION_PAGE_SIZE_BP + 400),
      exons: [
        {
          start: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP - 100,
          end: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP - 20,
        },
        {
          start: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP + 300,
          end: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP + 400,
        },
      ],
      cds: [
        {
          start: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP + 320,
          end: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP + 380,
        },
      ],
    } satisfies Feature;
    const common = {
      sourceIdentity: 'source-a',
      policyKey: 'policy-a',
      chromosomeId: 'chr1',
      requestedTracks: [{ trackId: 'mRNA', trackOrder: 0, laneCapacity: 12 }],
      features: [spanning],
    };
    const [prior] = await buildAnnotationPresentationPages({
      ...common,
      ownerStartBp: 0,
      ownerEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
    });
    const [next] = await buildAnnotationPresentationPages({
      ...common,
      ownerStartBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP,
      ownerEndBp: ASSEMBLY_ANNOTATION_PAGE_SIZE_BP * 2,
    });
    expect(prior.features).toEqual([spanning]);
    expect(prior.features[0].exons).toEqual(spanning.exons);
    expect(prior.features[0].cds).toEqual(spanning.cds);
    expect(prior.maxFeatureEndBp).toBe(ASSEMBLY_ANNOTATION_PAGE_SIZE_BP + 400);
    expect(next.features).toEqual([]);
  });
});
