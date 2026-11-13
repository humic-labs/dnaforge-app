import { describe, expect, it } from 'vitest';

import {
  AnnotationResidentPageStore,
  estimateAnnotationPresentationPageBytes,
} from './annotation-resident-page-store';
import type {
  AnnotationPresentationPage,
  AnnotationResidentPagePublication,
  Feature,
} from './types';

const SOURCE = 'GRCh38-human';
const LENGTH = 10_000;
const TRACK = 'mRNA';

function feature(input: {
  id: number;
  start: number;
  end?: number;
  pageTrack?: string;
  canonicalIdentity?: string;
}): Feature {
  return {
    id: input.id,
    type: input.pageTrack ?? TRACK,
    annotationTrackId: input.pageTrack ?? TRACK,
    annotationTrackLane: input.id % 12,
    start: input.start,
    end: input.end ?? input.start + 20,
    direction: input.id % 2 === 0 ? 'forward' : 'reverse',
    displayName: `tx-${input.id}`,
    color: 0x336699,
    lane: input.id % 12,
    exons: [{ start: input.start + 1, end: input.end ?? input.start + 20 }],
    transcriptId: `transcript-${input.id}`,
    sourceId: `source-${input.id}`,
    canonicalIdentity: input.canonicalIdentity,
  };
}

function page(input: {
  pageKey: string;
  start: number;
  end: number;
  revision?: string;
  features?: Feature[];
  trackId?: string;
  chromosomeId?: string;
}): AnnotationPresentationPage {
  const features = input.features ?? [];
  return {
    contract: 'annotation-presentation-page.v1',
    pageKey: input.pageKey,
    chromosomeId: input.chromosomeId ?? 'chr1',
    trackId: input.trackId ?? TRACK,
    trackOrder: 0,
    laneCapacity: 12,
    ownerStartBp: input.start,
    ownerEndBp: input.end,
    maxFeatureEndBp: features.reduce(
      (maximum, candidate) => Math.max(maximum, candidate.end),
      input.end
    ),
    contentRevision: input.revision ?? `revision:${input.pageKey}:1`,
    features,
  };
}

function snapshot(input: {
  generation: number;
  pages?: AnnotationPresentationPage[];
  policyKey?: string;
  sourceIdentity?: string;
  genomeLengthBp?: number;
  exactCoverage?: Array<{ startBp: number; endBp: number }>;
  requestedLayerTypes?: string[];
}): AnnotationResidentPagePublication {
  return {
    contract: 'annotation-resident-page-publication.v1',
    sourceIdentity: input.sourceIdentity ?? SOURCE,
    genomeLengthBp: input.genomeLengthBp ?? LENGTH,
    policyKey: input.policyKey ?? 'canonical:lanes=12',
    generation: input.generation,
    requestedLayerTypes: input.requestedLayerTypes ?? [TRACK],
    exactCoverage: input.exactCoverage ?? [],
    pages: input.pages ?? [],
  };
}

function featuresInPage(count: number, ownerStartBp: number, idBase = 0): Feature[] {
  return Array.from({ length: count }, (_, index) =>
    feature({
      id: idBase + index,
      start: ownerStartBp + index * 10,
      end: ownerStartBp + index * 10 + 5,
    })
  );
}

describe('AnnotationResidentPageStore', () => {
  it('accepts a source-page publication whose type has no flat features or layout authority', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const publication: AnnotationResidentPagePublication = {
      contract: 'annotation-resident-page-publication.v1',
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
      policyKey: 'source-pages:mRNA',
      generation: 0,
      requestedLayerTypes: [TRACK],
      exactCoverage: [{ startBp: 0, endBp: 1_000 }],
      pages: [page({ pageKey: 'typed-page', start: 0, end: 1_000 })],
    };

    expect('features' in publication).toBe(false);
    expect('layout' in publication).toBe(false);
    expect(store.applyPublication(publication)).toMatchObject({
      status: 'applied',
      built: 1,
      generation: 0,
    });
  });

  it('retains unchanged page records by strict equality through 62 → 40 → 28 revisions', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const stableOne = page({ pageKey: 'p1', start: 1_000, end: 2_000 });
    const stableTwo = page({ pageKey: 'p2', start: 2_000, end: 3_000 });
    const firstChanged = page({
      pageKey: 'p0',
      start: 0,
      end: 1_000,
      revision: 'count:62',
      features: featuresInPage(62, 0),
    });
    expect(
      store.applyPublication(
        snapshot({ generation: 0, pages: [firstChanged, stableOne, stableTwo] })
      )
    ).toMatchObject({ status: 'applied', built: 3, reused: 0 });
    const originalStableOne = store.getActiveRecord('canonical:lanes=12', 'p1');
    const originalStableTwo = store.getActiveRecord('canonical:lanes=12', 'p2');
    const originalChanged = store.getActiveRecord('canonical:lanes=12', 'p0');

    const second = store.applyPublication(
      snapshot({
        generation: 1,
        pages: [
          page({
            pageKey: 'p0',
            start: 0,
            end: 1_000,
            revision: 'count:40',
            features: featuresInPage(40, 0),
          }),
          { ...stableOne, features: [...stableOne.features] },
          { ...stableTwo, features: [...stableTwo.features] },
        ],
      })
    );
    expect(second).toMatchObject({ status: 'applied', built: 1, reused: 2 });
    expect(store.getActiveRecord('canonical:lanes=12', 'p1')).toBe(originalStableOne);
    expect(store.getActiveRecord('canonical:lanes=12', 'p2')).toBe(originalStableTwo);
    expect(store.getActiveRecord('canonical:lanes=12', 'p0')).not.toBe(originalChanged);

    const third = store.applyPublication(
      snapshot({
        generation: 2,
        pages: [
          page({
            pageKey: 'p0',
            start: 0,
            end: 1_000,
            revision: 'count:28',
            features: featuresInPage(28, 0),
          }),
          stableOne,
          stableTwo,
        ],
      })
    );
    expect(third).toMatchObject({ status: 'applied', built: 1, reused: 2 });
    expect(store.getActiveRecord('canonical:lanes=12', 'p1')).toBe(originalStableOne);
    expect(store.getActiveRecord('canonical:lanes=12', 'p2')).toBe(originalStableTwo);
    expect(store.getTelemetry().filter(({ type }) => type === 'build')).toHaveLength(5);
  });

  it('owns a seam-crossing feature only by its start page and selects that preceding owner', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const crossing = feature({ id: 1, start: 900, end: 1_250 });
    const owner = page({ pageKey: 'left', start: 0, end: 1_000, features: [crossing] });
    const neighbor = page({ pageKey: 'right', start: 1_000, end: 2_000 });
    expect(
      store.applyPublication(snapshot({ generation: 0, pages: [owner, neighbor] }))
    ).toMatchObject({ status: 'applied' });

    const selection = store.selectVisible({
      sourceIdentity: SOURCE,
      policyKey: 'canonical:lanes=12',
      viewStartBp: 1_100,
      viewEndBp: 1_200,
    });
    expect(selection.status).toBe('ready');
    expect(selection.records.map(({ pageKey }) => pageKey)).toEqual(['left', 'right']);
    expect(
      selection.records.flatMap(({ canonicalFeatureIdentities }) => canonicalFeatureIdentities)
    ).toHaveLength(1);

    const illegalNeighborCopy = page({
      pageKey: 'right-copy',
      start: 1_000,
      end: 2_000,
      features: [crossing],
    });
    expect(
      store.applyPublication(snapshot({ generation: 1, pages: [illegalNeighborCopy] }))
    ).toEqual({ status: 'rejected', reason: 'invalid-page' });
  });

  it('selects only pages named by requestedLayerTypes even when other track pages remain resident', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const mrna = page({
      pageKey: 'mrna:0-1000',
      start: 0,
      end: 1_000,
      trackId: 'mRNA',
      features: [feature({ id: 1, start: 100, pageTrack: 'mRNA' })],
    });
    const enhancer = page({
      pageKey: 'enhancer:0-1000',
      start: 0,
      end: 1_000,
      trackId: 'enhancer',
      features: [feature({ id: 2, start: 200, pageTrack: 'enhancer' })],
    });
    store.applyPublication(
      snapshot({
        generation: 0,
        pages: [mrna, enhancer],
        requestedLayerTypes: ['mRNA'],
        exactCoverage: [{ startBp: 0, endBp: 1_000 }],
      })
    );

    const selection = store.selectVisible({
      sourceIdentity: SOURCE,
      policyKey: 'canonical:lanes=12',
      viewStartBp: 100,
      viewEndBp: 300,
    });

    expect(selection.status).toBe('ready');
    expect(selection.records.map(({ page }) => page.trackId)).toEqual(['mRNA']);
    expect(selection.expectedPageIdentities).toHaveLength(1);
    expect(selection.records.flatMap(({ page }) => page.features).map(({ id }) => id)).toEqual([1]);
  });

  it('accepts a feature at genome coordinate zero while keeping 1-indexed exon spans valid', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const boundaryFeature = feature({ id: 0, start: 0, end: 10 });
    expect(boundaryFeature.exons?.[0]).toEqual({ start: 1, end: 10 });
    expect(
      store.applyPublication(
        snapshot({
          generation: 0,
          pages: [page({ pageKey: 'origin', start: 0, end: 1_000, features: [boundaryFeature] })],
        })
      )
    ).toMatchObject({ status: 'applied', built: 1 });
    expect(store.getActiveRecord('canonical:lanes=12', 'origin')?.page.features[0].start).toBe(0);
  });

  it('treats a valid empty page as exact coverage and does not require geometry', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const empty = page({ pageKey: 'empty', start: 4_000, end: 5_000 });
    expect(empty.maxFeatureEndBp).toBe(empty.ownerEndBp);
    store.applyPublication(
      snapshot({
        generation: 0,
        pages: [empty],
        exactCoverage: [{ startBp: 4_000, endBp: 5_000 }],
      })
    );
    const selection = store.selectVisible({
      sourceIdentity: SOURCE,
      policyKey: 'canonical:lanes=12',
      viewStartBp: 4_200,
      viewEndBp: 4_800,
    });
    expect(selection).toMatchObject({
      status: 'ready',
      coverageComplete: true,
      producerCoverageComplete: true,
      missingPageIdentities: [],
    });
    expect(selection.records).toHaveLength(1);
    expect(selection.records[0].page.features).toEqual([]);
  });

  it('treats producer-exact coverage as complete when a requested track is legitimately empty', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const codingTranscript = {
      ...feature({ id: 1, start: 4_100, end: 4_900, pageTrack: 'mRNA' }),
      cds: [{ start: 4_101, end: 4_899 }],
    };
    const transcript = page({
      pageKey: 'mrna:4000-5000',
      start: 4_000,
      end: 5_000,
      trackId: 'mRNA',
      features: [codingTranscript],
    });
    store.applyPublication(
      snapshot({
        generation: 0,
        pages: [transcript],
        requestedLayerTypes: ['mRNA', 'centromere'],
        exactCoverage: [{ startBp: 4_000, endBp: 5_000 }],
      })
    );

    const selection = store.selectVisible({
      sourceIdentity: SOURCE,
      policyKey: 'canonical:lanes=12',
      viewStartBp: 4_200,
      viewEndBp: 4_800,
    });

    expect(selection).toMatchObject({
      status: 'ready',
      coverageComplete: true,
      producerCoverageComplete: true,
      missingPageIdentities: [],
    });
    expect(selection.records.map(({ page: selectedPage }) => selectedPage.trackId)).toEqual([
      'mRNA',
    ]);
    expect(selection.records[0].page.features[0].cds).toEqual(codingTranscript.cds);
  });

  it('reuses retained pages in reverse even after a later producer range drops them', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const left = page({ pageKey: 'left', start: 0, end: 1_000 });
    const right = page({ pageKey: 'right', start: 1_000, end: 2_000 });
    store.applyPublication(
      snapshot({
        generation: 0,
        pages: [left],
        exactCoverage: [{ startBp: 0, endBp: 1_000 }],
      })
    );
    const firstLeft = store.selectVisible({
      sourceIdentity: SOURCE,
      policyKey: 'canonical:lanes=12',
      viewStartBp: 100,
      viewEndBp: 900,
    }).records[0];
    store.applyPublication(
      snapshot({
        generation: 1,
        pages: [right],
        exactCoverage: [{ startBp: 1_000, endBp: 2_000 }],
      })
    );
    expect(
      store.selectVisible({
        sourceIdentity: SOURCE,
        policyKey: 'canonical:lanes=12',
        viewStartBp: 1_100,
        viewEndBp: 1_900,
      }).status
    ).toBe('ready');
    const reverse = store.selectVisible({
      sourceIdentity: SOURCE,
      policyKey: 'canonical:lanes=12',
      viewStartBp: 100,
      viewEndBp: 900,
    });
    expect(reverse.status).toBe('ready');
    expect(reverse.producerCoverageComplete).toBe(false);
    expect(reverse.records[0]).toBe(firstLeft);
  });

  it('fails closed for stale generations, generation collisions, source/length mismatch, and malformed publications', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const initial = snapshot({
      generation: 4,
      pages: [page({ pageKey: 'p0', start: 0, end: 1_000 })],
    });
    expect(store.applyPublication(initial).status).toBe('applied');
    expect(store.applyPublication(snapshot({ generation: 3, pages: [] }))).toEqual({
      status: 'rejected',
      reason: 'stale-generation',
    });
    expect(store.applyPublication(snapshot({ generation: 4, pages: [] }))).toEqual({
      status: 'rejected',
      reason: 'generation-collision',
    });
    expect(
      store.applyPublication(snapshot({ generation: 0, pages: [], sourceIdentity: 'T2T-CHM13' }))
    ).toEqual({ status: 'rejected', reason: 'source-mismatch' });
    expect(
      store.applyPublication(snapshot({ generation: 0, pages: [], genomeLengthBp: LENGTH - 1 }))
    ).toEqual({ status: 'rejected', reason: 'length-mismatch' });
    const { pages: _pages, ...missingPages } = snapshot({ generation: 5 });
    expect(store.applyPublication(missingPages as never)).toEqual({
      status: 'rejected',
      reason: 'invalid-snapshot',
    });
    expect(store.getActiveRecord('canonical:lanes=12', 'p0')).not.toBeNull();
  });

  it('separates source, policy, page, and revision in framed identity keys', () => {
    const base = {
      sourceIdentity: 'ab',
      policyKey: 'c',
      pageKey: 'd',
      contentRevision: 'e',
    };
    const keys = [
      AnnotationResidentPageStore.identityKey(base),
      AnnotationResidentPageStore.identityKey({ ...base, sourceIdentity: 'a', policyKey: 'bc' }),
      AnnotationResidentPageStore.identityKey({ ...base, pageKey: 'de', contentRevision: '' }),
      AnnotationResidentPageStore.identityKey({ ...base, contentRevision: 'f' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);

    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const sharedPage = page({ pageKey: 'same', start: 0, end: 1_000 });
    store.applyPublication(snapshot({ generation: 0, pages: [sharedPage], policyKey: 'policy-a' }));
    store.applyPublication(snapshot({ generation: 0, pages: [sharedPage], policyKey: 'policy-b' }));
    const a = store.getActiveRecord('policy-a', 'same');
    const b = store.getActiveRecord('policy-b', 'same');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.identityKey).not.toBe(b?.identityKey);
    expect(
      store.selectVisible({
        sourceIdentity: SOURCE,
        policyKey: 'unknown-policy',
        viewStartBp: 0,
        viewEndBp: 100,
      }).reason
    ).toBe('policy-mismatch');

    store.applyPublication(snapshot({ generation: 0, pages: [sharedPage], policyKey: 'policy-c' }));
    expect(
      store.selectVisible({
        sourceIdentity: SOURCE,
        policyKey: 'policy-a',
        viewStartBp: 0,
        viewEndBp: 100,
      }).reason
    ).toBe('policy-mismatch');
    expect(
      store.selectVisible({
        sourceIdentity: SOURCE,
        policyKey: 'policy-b',
        viewStartBp: 0,
        viewEndBp: 100,
      }).status
    ).toBe('ready');
    expect(
      store.selectVisible({
        sourceIdentity: SOURCE,
        policyKey: 'policy-c',
        viewStartBp: 0,
        viewEndBp: 100,
      }).status
    ).toBe('ready');
  });

  it('rejects content-revision and page-key collisions without mutating the active record', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const originalPage = page({
      pageKey: 'p0',
      start: 0,
      end: 1_000,
      revision: 'fixed-revision',
      features: [feature({ id: 1, start: 100 })],
    });
    store.applyPublication(snapshot({ generation: 0, pages: [originalPage] }));
    const originalRecord = store.getActiveRecord('canonical:lanes=12', 'p0');
    const residentCount = store.residentPageCount;

    const corruptSameRevision = page({
      pageKey: 'p0',
      start: 0,
      end: 1_000,
      revision: 'fixed-revision',
      features: [feature({ id: 2, start: 200 })],
    });
    expect(
      store.applyPublication(snapshot({ generation: 1, pages: [corruptSameRevision] }))
    ).toEqual({ status: 'rejected', reason: 'content-revision-collision' });
    expect(store.getActiveRecord('canonical:lanes=12', 'p0')).toBe(originalRecord);
    expect(store.residentPageCount).toBe(residentCount);

    const movedSameKey = page({
      pageKey: 'p0',
      start: 1_000,
      end: 2_000,
      revision: 'moved',
    });
    expect(store.applyPublication(snapshot({ generation: 1, pages: [movedSameKey] }))).toEqual({
      status: 'rejected',
      reason: 'page-key-collision',
    });
    const changedEnvelopeSameKey = {
      ...page({
        pageKey: 'p0',
        start: 0,
        end: 1_000,
        revision: 'changed-envelope',
        features: [feature({ id: 1, start: 100 })],
      }),
      laneCapacity: 13,
    };
    expect(
      store.applyPublication(snapshot({ generation: 1, pages: [changedEnvelopeSameKey] }))
    ).toEqual({ status: 'rejected', reason: 'page-key-collision' });
    expect(store.getActiveRecord('canonical:lanes=12', 'p0')).toBe(originalRecord);
  });

  it('switches only the logical page active revision and retains the prior full identity for reuse', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const revisionOne = page({
      pageKey: 'logical-page',
      start: 0,
      end: 1_000,
      revision: 'revision-1',
      features: [feature({ id: 1, start: 100 })],
    });
    store.applyPublication(snapshot({ generation: 0, pages: [revisionOne] }));
    const first = store.getActiveRecord('canonical:lanes=12', 'logical-page')!;
    const revisionTwo = page({
      pageKey: 'logical-page',
      start: 0,
      end: 1_000,
      revision: 'revision-2',
      features: [feature({ id: 2, start: 200 })],
    });
    expect(store.applyPublication(snapshot({ generation: 1, pages: [revisionTwo] }))).toMatchObject(
      { status: 'applied', built: 1, reused: 0 }
    );
    const second = store.getActiveRecord('canonical:lanes=12', 'logical-page')!;
    expect(second).not.toBe(first);
    expect(second.contentRevision).toBe('revision-2');
    expect(store.getRecord(first.identityKey)).toBe(first);
    expect(store.residentPageCount).toBe(2);
  });

  it('rejects malformed totals, duplicate keys, overlapping owners, and duplicate canonical ownership transactionally', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const original = page({ pageKey: 'original', start: 0, end: 1_000 });
    store.applyPublication(snapshot({ generation: 0, pages: [original] }));
    const originalRecord = store.getActiveRecord('canonical:lanes=12', 'original');

    const malformedTotal = {
      ...page({
        pageKey: 'bad-total',
        start: 1_000,
        end: 2_000,
        features: [feature({ id: 10, start: 1_100, end: 2_100 })],
      }),
      maxFeatureEndBp: 2_000,
    };
    expect(store.applyPublication(snapshot({ generation: 1, pages: [malformedTotal] }))).toEqual({
      status: 'rejected',
      reason: 'invalid-page',
    });
    for (const malformedLayout of [
      { ...page({ pageKey: 'bad-order', start: 1_000, end: 2_000 }), trackOrder: -1 },
      { ...page({ pageKey: 'bad-capacity', start: 1_000, end: 2_000 }), laneCapacity: 0 },
      {
        ...page({
          pageKey: 'lane-overflow',
          start: 1_000,
          end: 2_000,
          features: [feature({ id: 999, start: 1_100 })],
        }),
        laneCapacity: 1,
      },
    ]) {
      expect(store.applyPublication(snapshot({ generation: 1, pages: [malformedLayout] }))).toEqual(
        { status: 'rejected', reason: 'invalid-page' }
      );
    }
    const duplicate = page({ pageKey: 'duplicate', start: 1_000, end: 2_000 });
    expect(
      store.applyPublication(snapshot({ generation: 1, pages: [duplicate, duplicate] }))
    ).toEqual({ status: 'rejected', reason: 'duplicate-page-key' });

    const overlapA = page({ pageKey: 'overlap-a', start: 1_000, end: 2_000 });
    const overlapB = page({ pageKey: 'overlap-b', start: 1_500, end: 2_500 });
    expect(
      store.applyPublication(snapshot({ generation: 1, pages: [overlapA, overlapB] }))
    ).toEqual({ status: 'rejected', reason: 'overlapping-owner-ranges' });

    const duplicateIdentity = 'annotation.v2:duplicate';
    const identityA = page({
      pageKey: 'identity-a',
      start: 1_000,
      end: 2_000,
      features: [feature({ id: 20, start: 1_100, canonicalIdentity: duplicateIdentity })],
    });
    const identityB = page({
      pageKey: 'identity-b',
      start: 2_000,
      end: 3_000,
      features: [feature({ id: 21, start: 2_100, canonicalIdentity: duplicateIdentity })],
    });
    expect(
      store.applyPublication(snapshot({ generation: 1, pages: [identityA, identityB] }))
    ).toEqual({ status: 'rejected', reason: 'duplicate-feature-ownership' });
    expect(store.getActiveRecord('canonical:lanes=12', 'original')).toBe(originalRecord);
    expect(store.residentPageCount).toBe(1);
  });

  it('enforces a byte/count LRU deterministically while visible and selected identities stay pinned', () => {
    let time = 0;
    const p0 = page({
      pageKey: 'p0',
      start: 0,
      end: 1_000,
      features: [feature({ id: 1, start: 100 })],
    });
    const byteBudget = estimateAnnotationPresentationPageBytes(p0) * 2 + 64;
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
      maxResidentPages: 2,
      maxResidentBytes: byteBudget,
      now: () => ++time,
    });
    store.applyPublication(snapshot({ generation: 0, pages: [p0] }));
    const p0Record = store.getActiveRecord('canonical:lanes=12', 'p0')!;
    store.setPinnedPageIdentities({ visible: [p0Record.identityKey] });

    const p1 = page({
      pageKey: 'p1',
      start: 1_000,
      end: 2_000,
      features: [feature({ id: 2, start: 1_100 })],
    });
    const p2 = page({
      pageKey: 'p2',
      start: 2_000,
      end: 3_000,
      features: [feature({ id: 3, start: 2_100 })],
    });
    store.applyPublication(snapshot({ generation: 1, pages: [p1] }));
    const p1Record = store.getActiveRecord('canonical:lanes=12', 'p1')!;
    store.setPinnedPageIdentities({
      visible: [p0Record.identityKey],
      selected: [p1Record.identityKey],
    });
    store.applyPublication(snapshot({ generation: 2, pages: [p2] }));

    expect(store.getRecord(p0Record.identityKey)).toBe(p0Record);
    expect(store.getRecord(p1Record.identityKey)).toBe(p1Record);
    expect(store.getActiveRecord('canonical:lanes=12', 'p2')).toBeNull();
    expect(store.residentPageCount).toBeLessThanOrEqual(2);
    expect(store.residentByteCount).toBeLessThanOrEqual(byteBudget);
    const evictions = store.getTelemetry().filter(({ type }) => type === 'eviction');
    expect(evictions.map(({ pageKey }) => pageKey)).toEqual(['p2']);
    expect(evictions[0]).toMatchObject({ cause: 'snapshot-upsert', residentPageCount: 2 });
  });

  it('reports missing evicted pages as incomplete instead of silently drawing partial coverage', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
      maxResidentPages: 1,
      maxResidentBytes: 1_000_000,
    });
    const left = page({ pageKey: 'left', start: 0, end: 1_000 });
    const right = page({ pageKey: 'right', start: 1_000, end: 2_000 });
    store.applyPublication(snapshot({ generation: 0, pages: [left, right] }));
    const selection = store.selectVisible({
      sourceIdentity: SOURCE,
      policyKey: 'canonical:lanes=12',
      viewStartBp: 0,
      viewEndBp: 2_000,
    });
    expect(selection.coverageComplete).toBe(true);
    expect(selection.status).toBe('incomplete');
    expect(selection.expectedPageIdentities).toHaveLength(2);
    expect(selection.missingPageIdentities).toHaveLength(1);
    expect(selection.records).toHaveLength(1);
  });

  it('stores deep immutable copies rather than caller-mutable page objects', () => {
    const store = new AnnotationResidentPageStore({
      sourceIdentity: SOURCE,
      genomeLengthBp: LENGTH,
    });
    const mutableFeature = feature({ id: 1, start: 100 });
    mutableFeature.qualifiers = { ID: 'original' };
    const mutableFeatures = [mutableFeature];
    const mutablePage = page({
      pageKey: 'immutable',
      start: 0,
      end: 1_000,
      features: mutableFeatures,
    });
    store.applyPublication(snapshot({ generation: 0, pages: [mutablePage] }));
    const record = store.getActiveRecord('canonical:lanes=12', 'immutable')!;
    mutableFeature.displayName = 'mutated';
    mutableFeature.qualifiers.ID = 'mutated';
    mutableFeatures.push(feature({ id: 2, start: 200 }));
    expect(record.page.features).toHaveLength(1);
    expect(record.page.features[0].displayName).toBe('tx-1');
    expect(record.page.features[0].qualifiers?.ID).toBe('original');
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.page)).toBe(true);
    expect(Object.isFrozen(record.page.features[0].exons)).toBe(true);
  });
});
