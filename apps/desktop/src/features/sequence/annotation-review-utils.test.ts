// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';
import {
  getConfidenceLevel,
  calculateOverlapPercent,
  detectDuplicate,
  createDraftAnnotations,
  draftsToCommittedAnnotations,
  commitReviewedAnnotations,
  resolveDraftForViewerAnnotation,
} from './annotation-review-utils';
import type { PlannotateFeature, DraftAnnotation } from './types';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';

function makeFeature(
  partial: Omit<
    PlannotateFeature,
    'ref_start' | 'ref_end' | 'ref_length' | 'db_source' | 'fragment'
  > &
    Partial<
      Pick<PlannotateFeature, 'ref_start' | 'ref_end' | 'ref_length' | 'db_source' | 'fragment'>
    >
): PlannotateFeature {
  return {
    ref_start: 1,
    ref_end: partial.end - partial.start,
    ref_length: partial.end - partial.start,
    db_source: 'protein',
    fragment: false,
    ...partial,
  };
}

describe('getConfidenceLevel', () => {
  it('returns high for confidence >= 95', () => {
    expect(getConfidenceLevel(95)).toBe('high');
    expect(getConfidenceLevel(100)).toBe('high');
    expect(getConfidenceLevel(99.5)).toBe('high');
  });

  it('returns medium for confidence >= 80 and < 95', () => {
    expect(getConfidenceLevel(80)).toBe('medium');
    expect(getConfidenceLevel(94.9)).toBe('medium');
    expect(getConfidenceLevel(87)).toBe('medium');
  });

  it('returns low for confidence < 80', () => {
    expect(getConfidenceLevel(79.9)).toBe('low');
    expect(getConfidenceLevel(50)).toBe('low');
    expect(getConfidenceLevel(0)).toBe('low');
  });
});

describe('calculateOverlapPercent', () => {
  it('returns 100 for identical ranges', () => {
    const result = calculateOverlapPercent({ start: 100, end: 200 }, { start: 100, end: 200 });
    expect(result).toBe(100);
  });

  it('returns 0 for non-overlapping ranges', () => {
    const result = calculateOverlapPercent({ start: 100, end: 200 }, { start: 300, end: 400 });
    expect(result).toBe(0);
  });

  it('calculates partial overlap correctly', () => {
    const result = calculateOverlapPercent({ start: 100, end: 200 }, { start: 150, end: 250 });
    expect(result).toBeCloseTo(50.5, 0);
  });

  it('handles when B is contained within A', () => {
    const result = calculateOverlapPercent({ start: 100, end: 300 }, { start: 150, end: 200 });
    expect(result).toBeCloseTo(25.4, 0);
  });

  it('handles when A is contained within B', () => {
    const result = calculateOverlapPercent({ start: 150, end: 200 }, { start: 100, end: 300 });
    expect(result).toBe(100);
  });

  it('handles adjacent ranges (no overlap)', () => {
    const result = calculateOverlapPercent({ start: 100, end: 199 }, { start: 200, end: 300 });
    expect(result).toBe(0);
  });
});

describe('detectDuplicate', () => {
  const existingAnnotations = [
    { name: 'AmpR', type: 'CDS', start: 100, end: 500, strand: 1 },
    { name: 'ColE1 origin', type: 'rep_origin', start: 600, end: 1200, strand: 0 },
    { name: 'T7 promoter', type: 'promoter', start: 1300, end: 1350, strand: 1 },
  ];

  it('detects exact name match with significant reciprocal overlap', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'AmpR',
      start: 100,
      end: 500,
      strand: 1,
      identity: 100,
      coverage: 100,
      type: 'CDS',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toBe('exact');
    expect(result.existingAnnotationName).toBe('AmpR');
  });

  it('detects exact name match case-insensitively', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'ampr',
      start: 100,
      end: 500,
      strand: 1,
      identity: 100,
      coverage: 100,
      type: 'CDS',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toBe('exact');
  });

  it('detects type match with high reciprocal overlap (>80% both directions)', () => {
    const draft2: PlannotateFeature = makeFeature({
      name: 'Different Name',
      start: 130,
      end: 530,
      strand: 1,
      identity: 95,
      coverage: 95,
      type: 'CDS',
    });

    const result = detectDuplicate(draft2, existingAnnotations);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toBe('overlap');
  });

  it('detects position match (within 5% of length) with same type', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'Something Else',
      start: 1302,
      end: 1352,
      strand: 1,
      identity: 90,
      coverage: 90,
      type: 'promoter',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toBe('position');
    expect(result.existingAnnotationName).toBe('T7 promoter');
  });

  it('returns not duplicate for truly new annotation', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'KanR',
      start: 2000,
      end: 2800,
      strand: 1,
      identity: 98,
      coverage: 98,
      type: 'CDS',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('returns not duplicate when name matches but no overlap', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'AmpR',
      start: 5000,
      end: 5500,
      strand: 1,
      identity: 98,
      coverage: 98,
      type: 'CDS',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(false);
  });

  it('returns not duplicate when same position but opposite strand', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'Reverse AmpR',
      start: 100,
      end: 500,
      strand: -1,
      identity: 100,
      coverage: 100,
      type: 'CDS',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(false);
  });

  it('returns not duplicate for small feature inside large one (asymmetric overlap)', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'Small Feature',
      start: 700,
      end: 800,
      strand: 1,
      identity: 95,
      coverage: 95,
      type: 'rep_origin',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(false);
  });

  it('detects duplicate when both features are similar size with high overlap', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'Similar Origin',
      start: 650,
      end: 1150,
      strand: 0,
      identity: 95,
      coverage: 95,
      type: 'rep_origin',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toBe('overlap');
  });

  it('uses relative position tolerance (5% of feature length)', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'Shifted AmpR-like',
      start: 125,
      end: 525,
      strand: 1,
      identity: 90,
      coverage: 90,
      type: 'CDS',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(true);
  });

  it('handles strand=0 (no strand) matching any strand', () => {
    const draft: PlannotateFeature = makeFeature({
      name: 'ColE1 origin',
      start: 600,
      end: 1200,
      strand: 1,
      identity: 100,
      coverage: 100,
      type: 'rep_origin',
    });

    const result = detectDuplicate(draft, existingAnnotations);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toBe('exact');
  });
});

describe('createDraftAnnotations', () => {
  const existingAnnotations = [{ name: 'AmpR', type: 'CDS', start: 100, end: 500 }];

  it('creates draft annotations with calculated confidence', () => {
    const features: PlannotateFeature[] = [
      makeFeature({
        name: 'KanR',
        start: 1000,
        end: 1800,
        strand: 1,
        identity: 98,
        coverage: 95,
        type: 'CDS',
      }),
    ];

    const drafts = createDraftAnnotations(features, existingAnnotations);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].name).toBe('KanR');
    expect(drafts[0].confidence).toBeCloseTo(93.1, 1);
    expect(drafts[0].accepted).toBe(true);
    expect(drafts[0].duplicateStatus.isDuplicate).toBe(false);
  });

  it('auto-rejects duplicates', () => {
    const features: PlannotateFeature[] = [
      makeFeature({
        name: 'AmpR',
        start: 100,
        end: 500,
        strand: 1,
        identity: 100,
        coverage: 100,
        type: 'CDS',
      }),
    ];

    const drafts = createDraftAnnotations(features, existingAnnotations);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].accepted).toBe(false);
    expect(drafts[0].duplicateStatus.isDuplicate).toBe(true);
    expect(drafts[0].duplicateStatus.reason).toBe('exact');
  });

  it('assigns unique IDs to each draft', () => {
    const features: PlannotateFeature[] = [
      makeFeature({
        name: 'Feature1',
        start: 100,
        end: 200,
        strand: 1,
        identity: 90,
        coverage: 90,
      }),
      makeFeature({
        name: 'Feature2',
        start: 300,
        end: 400,
        strand: -1,
        identity: 85,
        coverage: 85,
      }),
    ];

    const drafts = createDraftAnnotations(features, []);

    expect(drafts[0].id).toBeDefined();
    expect(drafts[1].id).toBeDefined();
    expect(drafts[0].id).not.toBe(drafts[1].id);
  });

  it('preserves all original feature properties', () => {
    const features: PlannotateFeature[] = [
      makeFeature({
        name: 'TestFeature',
        start: 100,
        end: 200,
        strand: -1,
        identity: 92,
        coverage: 88,
        type: 'promoter',
        description: 'A test feature',
      }),
    ];

    const drafts = createDraftAnnotations(features, []);

    expect(drafts[0].name).toBe('TestFeature');
    expect(drafts[0].start).toBe(100);
    expect(drafts[0].end).toBe(200);
    expect(drafts[0].strand).toBe(-1);
    expect(drafts[0].identity).toBe(92);
    expect(drafts[0].coverage).toBe(88);
    expect(drafts[0].type).toBe('promoter');
    expect(drafts[0].description).toBe('A test feature');
  });
});

function makeDraft(partial: Partial<DraftAnnotation> = {}): DraftAnnotation {
  return {
    id: 'draft-0',
    name: 'AmpR',
    start: 100,
    end: 900,
    strand: 1,
    identity: 99.234,
    coverage: 98.7,
    fragment: false,
    type: 'CDS',
    description: 'beta-lactamase',
    ref_start: 1,
    ref_end: 800,
    ref_length: 800,
    db_source: 'protein',
    confidence: 98,
    accepted: true,
    duplicateStatus: { isDuplicate: false },
    ...partial,
  };
}

describe('draftsToCommittedAnnotations ', () => {
  it('produces the committed shape that the styling predicate classifies as REAL, not a draft', () => {
    const [committed] = draftsToCommittedAnnotations([makeDraft()]);

    expect(committed.qualifiers?.source?.[0]).toBe('pLannotate');
    expect(committed.qualifiers?.source?.[0]).not.toBe('pLannotate-draft');
    expect(committed.qualifiers?.status).toBeUndefined();

    const isDraft = committed.qualifiers?.source?.[0] === 'pLannotate-draft';
    const isAccepted = committed.qualifiers?.status?.[0] === 'accepted';
    const isUncheckedDraft = isDraft && !isAccepted;
    expect(isDraft).toBe(false);
    expect(isUncheckedDraft).toBe(false);
  });

  it('maps draft fields onto the Annotation shape (coords, direction, color, formatted metadata)', () => {
    const [committed] = draftsToCommittedAnnotations([
      makeDraft({ start: 5, end: 50, strand: -1, type: 'promoter' }),
    ]);
    expect(committed.name).toBe('AmpR');
    expect(committed.start).toBe(5);
    expect(committed.end).toBe(50);
    expect(committed.direction).toBe(-1);
    expect(committed.type).toBe('promoter');
    expect(committed.color).toBe('#22C55E');
    expect(committed.qualifiers?.identity?.[0]).toBe('99.2');
    expect(committed.qualifiers?.coverage?.[0]).toBe('98.7');
    expect(committed.qualifiers?.description?.[0]).toBe('beta-lactamase');
  });

  it('maps strand 0 to direction 0 and uses the canonical default color for unknown types', () => {
    const [committed] = draftsToCommittedAnnotations([
      makeDraft({ strand: 0, type: 'oddball_type' }),
    ]);
    expect(committed.direction).toBe(0);
    expect(committed.type).toBe('oddball_type');
    expect(committed.color).toBe('#9CA3AF');
  });

  it('returns one committed annotation per accepted draft (the merge input)', () => {
    const committed = draftsToCommittedAnnotations([
      makeDraft({ id: 'a', name: 'AmpR' }),
      makeDraft({ id: 'b', name: 'ori' }),
    ]);
    expect(committed).toHaveLength(2);
    expect(committed.map((c) => c.name)).toEqual(['AmpR', 'ori']);
  });

  it('synthesizes a join() _locationString for an origin-spanning (start>end) feature', () => {
    const [committed] = draftsToCommittedAnnotations(
      [makeDraft({ start: 2500, end: 50, strand: 1, type: 'CDS' })],
      3000
    );
    expect(committed.start).toBe(2500);
    expect(committed.end).toBe(50);
    expect(committed.qualifiers?._locationString?.[0]).toBe('join(2500..3000,1..50)');
  });

  it('wraps the join() in complement() for a reverse-strand origin-spanning feature', () => {
    const [committed] = draftsToCommittedAnnotations(
      [makeDraft({ start: 2500, end: 50, strand: -1 })],
      3000
    );
    expect(committed.qualifiers?._locationString?.[0]).toBe('complement(join(2500..3000,1..50))');
  });

  it('does NOT add _locationString for a normal (start<=end) feature', () => {
    const [committed] = draftsToCommittedAnnotations([makeDraft({ start: 100, end: 900 })], 3000);
    expect(committed.qualifiers?._locationString).toBeUndefined();
  });

  it('does NOT synthesize a wrap location when the sequence length is unknown', () => {
    const [committed] = draftsToCommittedAnnotations([makeDraft({ start: 2500, end: 50 })]);
    expect(committed.qualifiers?._locationString).toBeUndefined();
  });
});

describe('commitReviewedAnnotations — the Apply wiring ', () => {
  function makeSequence(): AnnotatedSequence {
    return {
      name: 'pUC19',
      sequence: 'ATGC'.repeat(50),
      length: 200,
      circular: true,
      annotations: [
        {
          name: 'existing',
          type: 'CDS',
          start: 1,
          end: 50,
          direction: 1,
          color: '#000000',
          qualifiers: {},
        },
      ],
    };
  }

  function makeDeps(overrides: Partial<Parameters<typeof commitReviewedAnnotations>[0]> = {}) {
    return {
      sequence: makeSequence(),
      documentId: 'fixture:sequence:puc19',
      acceptedDrafts: [makeDraft({ id: 'd1', name: 'NewFeature' })],
      hasPendingSequenceEdits: false,
      mergeAnnotations: vi.fn(),
      exitReviewMode: vi.fn(),
      save: vi.fn(async () => true),
      ...overrides,
    };
  }

  it('merges accepted drafts into the document model, exits review, and PERSISTS via save()', async () => {
    const deps = makeDeps();
    const result = await commitReviewedAnnotations(deps);

    expect(deps.mergeAnnotations).toHaveBeenCalledTimes(1);
    const [documentId, merged] = deps.mergeAnnotations.mock.calls[0];
    expect(documentId).toBe('fixture:sequence:puc19');
    expect(merged.map((a) => a.name)).toEqual(['NewFeature']);
    expect(merged[0]?.qualifiers?.source?.[0]).toBe('pLannotate');

    expect(deps.exitReviewMode).toHaveBeenCalledWith('fixture:sequence:puc19');

    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('saved');
  });

  it('still calls save() with no accepted drafts (idempotent persist of current state)', async () => {
    const deps = makeDeps({ acceptedDrafts: [] });
    const result = await commitReviewedAnnotations(deps);
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('saved');
  });

  it('reports save-failed (so the caller knows persistence failed)', async () => {
    const deps = makeDeps({ save: vi.fn(async () => false) });
    const result = await commitReviewedAnnotations(deps);
    expect(result.status).toBe('save-failed');
  });

  it('is blocked (no merge, no save) when the draft has pending sequence edits', async () => {
    const deps = makeDeps({ hasPendingSequenceEdits: true });
    const result = await commitReviewedAnnotations(deps);
    expect(result.status).toBe('blocked-pending-edits');
    expect(deps.mergeAnnotations).not.toHaveBeenCalled();
    expect(deps.exitReviewMode).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe('resolveDraftForViewerAnnotation — clicking a candidate on the plasmid map', () => {
  const drafts = [
    { id: 'd1', name: 'AmpR', start: 100, end: 400 },
    { id: 'd2', name: 'ori', start: 500, end: 900 },
    { id: 'd3', name: 'AmpR', start: 1200, end: 1500 },
  ];

  it('resolves an exact (name, start, end) match', () => {
    expect(
      resolveDraftForViewerAnnotation(drafts, { name: 'AmpR', start: 1200, end: 1500 })?.id
    ).toBe('d3');
    expect(resolveDraftForViewerAnnotation(drafts, { name: 'ori', start: 500, end: 900 })?.id).toBe(
      'd2'
    );
  });

  it('resolves a merged overlapping display name', () => {
    expect(
      resolveDraftForViewerAnnotation(drafts, { name: 'ori \u00b7 AmpR', start: 500, end: 900 })?.id
    ).toBe('d2');
  });

  it('NEVER hijacks a committed annotation that shares the clicked identity', () => {
    const committed = [{ name: 'AmpR', start: 100, end: 400 }];
    expect(
      resolveDraftForViewerAnnotation(drafts, { name: 'AmpR', start: 100, end: 400 }, committed)
    ).toBeNull();
    expect(
      resolveDraftForViewerAnnotation(drafts, { name: 'ori', start: 500, end: 900 }, committed)?.id
    ).toBe('d2');
  });

  it('refuses to guess when two drafts share the clicked identity', () => {
    const ambiguous = [
      { id: 'x', name: 'promoter', start: 10, end: 40 },
      { id: 'y', name: 'promoter', start: 10, end: 40 },
    ];
    expect(
      resolveDraftForViewerAnnotation(ambiguous, { name: 'promoter', start: 10, end: 40 })
    ).toBeNull();
  });

  it('does not match on name alone, or on range alone', () => {
    expect(
      resolveDraftForViewerAnnotation(drafts, { name: 'AmpR', start: 999, end: 9999 })
    ).toBeNull();
    expect(
      resolveDraftForViewerAnnotation(drafts, { name: 'renamed', start: 500, end: 900 })
    ).toBeNull();
  });

  it('returns null when nothing matches, so the caller falls through to committed annotations', () => {
    expect(resolveDraftForViewerAnnotation(drafts, { name: 'nope', start: 5, end: 9 })).toBeNull();
    expect(resolveDraftForViewerAnnotation([], { name: 'AmpR', start: 100, end: 400 })).toBeNull();
  });
});
