import { describe, expect, it } from 'vitest';
import type { Annotation } from '@waypoint/sequence-utils';
import {
  annotationsWithCdsExtensionPreview,
  arrowHitTest,
  arrowRectForEnd,
  buildExtendedCdsPreview,
  cdsExtensionKeyFor,
  cdsExtensionOriginalBounds,
  cdsExtensionHoveredEnds,
  cdsExtensionIdentityKey,
  cdsExtensionPreviewDirection,
  cdsExtensionPreviewEnds,
  cdsWithoutExtensionPreview,
  buildExtendedCdsPreviewForEnds,
  committedBoundsForExtensionPreview,
  committedQualifiersForExtensionPreview,
  extensionQualifiersForSavedRow,
  positionWithinCdsBounds,
  positionWithinLine,
  extensionRangeFor,
  incompleteCdsEnds,
  isCdsExtensionPreview,
  isPredictedCodonCell,
  CDS_EXTENSION_DIRECTION_QUALIFIER,
  CDS_EXTENSION_HOVER_QUALIFIER,
  CDS_EXTENSION_ORIGINAL_QUALIFIER,
  type CdsExtensionArrowBounds,
} from '../cds-extension-affordance';
import { createCdsExtensionHoverStore } from '../cds-extension-hover-store';
import { nearestRowCopyForBp } from '../layout-utils';
import { annotationLayoutKey } from '../useSequenceLayout';
import type { CodonCellRenderData } from '../codon-rendering';

const SEQ = 'ATGAAACCCGGGTAATTT';

describe('incompleteCdsEnds', () => {
  it('offers only the 3-prime end when the CDS starts on ATG but has no stop', () => {
    expect(incompleteCdsEnds({ start: 0, end: 8, direction: 1 }, SEQ, false)).toEqual([
      'three-prime',
    ]);
  });

  it('offers nothing when the CDS is complete at both ends', () => {
    expect(incompleteCdsEnds({ start: 0, end: 14, direction: 1 }, SEQ, false)).toEqual([]);
  });

  it('offers the 5-prime end when the CDS begins mid-protein', () => {
    const ends = incompleteCdsEnds({ start: 6, end: 14, direction: 1 }, SEQ, false);
    expect(ends).toContain('five-prime');
  });

  it('treats GTG as a start only under the bacterial code', () => {
    const seq = 'TTTGTGAAACCCTAA';
    expect(incompleteCdsEnds({ start: 3, end: 14, direction: 1 }, seq, false)).toContain(
      'five-prime'
    );
    expect(
      incompleteCdsEnds({ start: 3, end: 14, direction: 1, geneticCode: 11 }, seq, false)
    ).not.toContain('five-prime');
  });

  it('offers no arrow when the end is incomplete but there is nowhere to extend', () => {
    expect(incompleteCdsEnds({ start: 0, end: 11, direction: 1 }, 'GTGAAACCCTAA', false)).toEqual(
      []
    );
  });
});

describe('extensionRangeFor', () => {
  it('returns the in-frame range up to and including the stop', () => {
    expect(
      extensionRangeFor({ start: 0, end: 8, direction: 1 }, SEQ, false, 'three-prime')
    ).toEqual({ start: 9, end: 14, openEnded: false, addedBases: 6 });
  });
});

const cell = (codonX: number, genomicStart: number): CodonCellRenderData => ({
  codonX,
  visibleWidth: 30,
  leftEdge: 'flat' as never,
  rightEdge: 'flat' as never,
  aa: 'M',
  renderLetter: true,
  genomicStart,
  genomicEnd: genomicStart + 2,
});

describe('arrowRectForEnd', () => {
  const cells = [cell(0, 0), cell(30, 3), cell(60, 6)];

  it('puts the 3-prime arrow to the right of the outermost cell', () => {
    const rect = arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 8, 0, 20);
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThan(60 + 30);
  });

  it('puts the 5-prime arrow to the left of the first cell', () => {
    const rect = arrowRectForEnd(cells, 1, 'five-prime', 100, 20, 0, 0, 20);
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeLessThan(0);
  });

  it('draws nothing when the CDS end is not on this line', () => {
    expect(arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 99, 0, 20)).toBeNull();
  });

  it('still anchors when the CDS ends on a partial codon with no cell', () => {
    const rect = arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 9, 0, 20);
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThan(60 + 30);
  });

  it('mirrors for a reverse-strand CDS', () => {
    const forward = arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 8, 0, 20);
    const reverse = arrowRectForEnd(cells, -1, 'three-prime', 100, 20, 8, 0, 20);
    expect(reverse!.x).toBeLessThan(forward!.x);
  });

  it('still draws on the row that wraps the origin', () => {
    const rect = arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 2685, 2631, 24);
    expect(rect).not.toBeNull();
  });

  it('keeps the whole arrow inside the drawable width when asked', () => {
    const unclamped = arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 8, 0, 20);
    const bound = unclamped!.x + 4;
    const clamped = arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 8, 0, 20, bound);
    expect(clamped!.x + clamped!.width).toBeLessThanOrEqual(bound);
  });

  it('leaves the arrow alone when it already fits', () => {
    const plain = arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 8, 0, 20);
    const roomy = arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 8, 0, 20, 10_000);
    expect(roomy!.x).toBe(plain!.x);
  });

  it('still rejects a base that the wrapping row genuinely does not cover', () => {
    expect(arrowRectForEnd(cells, 1, 'three-prime', 100, 20, 1200, 2631, 24)).toBeNull();
  });
});

describe('positionWithinLine', () => {
  it('treats the row end as EXCLUSIVE, the way Layout2DRow reports it', () => {
    expect(positionWithinLine(60, 120, 60)).toBe(true);
    expect(positionWithinLine(60, 120, 119)).toBe(true);
    expect(positionWithinLine(60, 120, 59)).toBe(false);
    expect(positionWithinLine(60, 120, 120)).toBe(false);
  });

  it('gives a shared boundary base to exactly one of the two rows', () => {
    expect(positionWithinLine(60, 120, 120)).toBe(false);
    expect(positionWithinLine(120, 180, 120)).toBe(true);
  });

  it('reads a row whose end is lower than its start as crossing the origin', () => {
    expect(positionWithinLine(2631, 24, 2685)).toBe(true);
    expect(positionWithinLine(2631, 24, 2631)).toBe(true);
    expect(positionWithinLine(2631, 24, 0)).toBe(true);
    expect(positionWithinLine(2631, 24, 23)).toBe(true);
    expect(positionWithinLine(2631, 24, 24)).toBe(false);
    expect(positionWithinLine(2631, 24, 2630)).toBe(false);
  });
});

describe('arrowHitTest', () => {
  const bounds: CdsExtensionArrowBounds[] = [
    {
      cdsKey: 'a',
      direction: 'three-prime',
      kind: 'extend',
      pointsRight: true,
      x: 100,
      y: 50,
      width: 7,
      height: 9,
      anchorBp: 8,
    },
  ];

  it('hits inside the padded rectangle', () => {
    expect(arrowHitTest(bounds, 103, 54)?.cdsKey).toBe('a');
    expect(arrowHitTest(bounds, 97, 48)?.cdsKey).toBe('a');
  });

  it('misses well outside it', () => {
    expect(arrowHitTest(bounds, 140, 54)).toBeNull();
    expect(arrowHitTest(bounds, 103, 90)).toBeNull();
  });
});

const incompleteCds: {
  name: string;
  type: string;
  start: number;
  end: number;
  direction: 1;
  qualifiers?: Record<string, string[]>;
} = {
  name: 'orfA',
  type: 'CDS',
  start: 1,
  end: 9,
  direction: 1,
};

describe('buildExtendedCdsPreview', () => {
  it('widens the CDS itself rather than producing a second annotation', () => {
    const preview = buildExtendedCdsPreview(incompleteCds, SEQ, 'three-prime', false);
    expect(preview).not.toBeNull();
    expect(preview!.name).toBe('orfA');
    expect(preview!.type).toBe('CDS');
    expect(preview!.start).toBe(1);
  });

  it('runs all the way through the stop codon, not just one codon further', () => {
    const preview = buildExtendedCdsPreview(incompleteCds, SEQ, 'three-prime', false);
    expect(preview!.end).toBe(15);
  });

  it('records where the CDS originally stopped', () => {
    const preview = buildExtendedCdsPreview(incompleteCds, SEQ, 'three-prime', false);
    expect(preview!.qualifiers?.[CDS_EXTENSION_ORIGINAL_QUALIFIER]).toEqual(['1..9']);
    expect(cdsExtensionOriginalBounds(preview!)).toEqual({ start: 1, end: 9 });
    expect(cdsExtensionPreviewDirection(preview!)).toBe('three-prime');
  });

  it('leaves the frame anchor alone when only the 3-prime end moves', () => {
    const preview = buildExtendedCdsPreview(
      { ...incompleteCds, qualifiers: { codon_start: ['2'] } },
      SEQ,
      'three-prime'
    );
    expect(preview!.qualifiers?.codon_start).toEqual(['2']);
  });

  it('restarts the frame at base 1 when the 5-prime end moves', () => {
    const preview = buildExtendedCdsPreview(
      { ...incompleteCds, start: 7, end: 15 },
      SEQ,
      'five-prime'
    );
    expect(preview!.start).toBe(1);
    expect(preview!.qualifiers?.codon_start).toEqual(['1']);
  });

  it('returns null when there is nothing to extend into', () => {
    expect(buildExtendedCdsPreview(incompleteCds, 'ATGAAACCC', 'three-prime', false)).toBeNull();
  });

  it('does not treat an ordinary annotation as a preview', () => {
    expect(isCdsExtensionPreview(incompleteCds)).toBe(false);
  });
});

describe('annotationsWithCdsExtensionPreview', () => {
  const others = [{ name: 'other', type: 'misc_feature', start: 40, end: 50, direction: 1 }];
  const annotations = [incompleteCds, ...others];
  const arrow = {
    cdsKey: cdsExtensionKeyFor(incompleteCds),
    direction: 'three-prime' as const,
    kind: 'extend' as const,
  };

  it('replaces the CDS in place, keeping every other annotation', () => {
    const next = annotationsWithCdsExtensionPreview(annotations, arrow, SEQ, false);
    expect(next).toHaveLength(2);
    expect(next[0]!.end).toBe(15);
    expect(next[1]).toBe(others[0]);
  });

  it('returns the same array when no arrow is active, so nothing re-renders', () => {
    expect(annotationsWithCdsExtensionPreview(annotations, null, SEQ, false)).toBe(annotations);
  });

  it('returns the same array when the arrow names a CDS that is no longer there', () => {
    const stale = {
      cdsKey: 'gone|CDS|100|200',
      direction: 'three-prime' as const,
      kind: 'extend' as const,
    };
    expect(annotationsWithCdsExtensionPreview(annotations, stale, SEQ, false)).toBe(annotations);
  });

  it('is idempotent for an end that is already grown', () => {
    const once = annotationsWithCdsExtensionPreview(annotations, arrow, SEQ, false);
    const twice = annotationsWithCdsExtensionPreview(once, arrow, SEQ, false);
    expect(twice[0]!.start).toBe(once[0]!.start);
    expect(twice[0]!.end).toBe(once[0]!.end);
  });

  it('ignores an undo arrow, which has nothing to preview', () => {
    const undo = { ...arrow, kind: 'undo' as const };
    expect(annotationsWithCdsExtensionPreview(annotations, undo, SEQ, false)).toBe(annotations);
  });
});

describe('isPredictedCodonCell', () => {
  const original = { start: 1, end: 9 };

  it('is false for a codon inside the annotated part', () => {
    expect(isPredictedCodonCell(original, { genomicStart: 3, genomicEnd: 5 })).toBe(false);
  });

  it('is true for a codon past the original 3-prime end', () => {
    expect(isPredictedCodonCell(original, { genomicStart: 9, genomicEnd: 11 })).toBe(true);
  });

  it('is true for a codon before the original 5-prime start', () => {
    expect(isPredictedCodonCell({ start: 7, end: 15 }, { genomicStart: 0, genomicEnd: 2 })).toBe(
      true
    );
  });
});

describe('committedBoundsForExtensionPreview', () => {
  it('reports both the original and the widened bounds', () => {
    const preview = buildExtendedCdsPreview(incompleteCds, SEQ, 'three-prime', false)!;
    expect(committedBoundsForExtensionPreview(preview)).toEqual({
      original: { start: 1, end: 9 },
      next: { start: 1, end: 15 },
    });
  });

  it('refuses an annotation that is not a preview', () => {
    expect(committedBoundsForExtensionPreview(incompleteCds)).toBeNull();
  });
});

describe('the active-arrow store', () => {
  const a = { cdsKey: 'a|CDS|1|9', direction: 'three-prime' as const, kind: 'extend' as const };
  const b = { cdsKey: 'b|CDS|1|9', direction: 'five-prime' as const, kind: 'extend' as const };

  it('follows the pointer and lets go when it leaves', () => {
    const store = createCdsExtensionHoverStore();
    store.setHovered(a);
    expect(store.getSnapshot()).toEqual(a);
    store.setHovered(null);
    expect(store.getSnapshot()).toBeNull();
  });

  it('notifies subscribers only when the hovered arrow actually changes', () => {
    const store = createCdsExtensionHoverStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.setHovered(a);
    store.setHovered({ ...a });
    expect(calls).toBe(1);
  });

  it('holds a click until the viewer takes it', () => {
    const store = createCdsExtensionHoverStore();
    store.requestDraft(a);
    expect(store.takeDraftRequest()).toEqual(a);
  });

  it('hands the same click out only once', () => {
    const store = createCdsExtensionHoverStore();
    store.requestDraft(a);
    store.takeDraftRequest();
    expect(store.takeDraftRequest()).toBeNull();
  });

  it('wakes subscribers on a click, so the viewer knows to look', () => {
    const store = createCdsExtensionHoverStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.requestDraft(a);
    expect(calls).toBe(1);
  });

  it('keeps the newest click when one arrives before the last was taken', () => {
    const store = createCdsExtensionHoverStore();
    store.requestDraft(a);
    store.requestDraft(b);
    expect(store.takeDraftRequest()).toEqual(b);
  });

  it('drops the hover and any untaken click on clear', () => {
    const store = createCdsExtensionHoverStore();
    store.setHovered(a);
    store.requestDraft(a);
    store.clear();
    expect(store.getSnapshot()).toBeNull();
    expect(store.takeDraftRequest()).toBeNull();
  });
});

describe('committedQualifiersForExtensionPreview', () => {
  const withFrame = {
    ...incompleteCds,
    qualifiers: {
      codon_start: ['2'],
      gene: ['bla'],
      translation: ['MKV'],
      transl_table: ['11'],
    },
  };

  it('keeps the frame anchor when only the 3-prime end moves', () => {
    const preview = buildExtendedCdsPreview(withFrame, SEQ, 'three-prime', false)!;
    expect(committedQualifiersForExtensionPreview(preview).codon_start).toEqual(['2']);
    expect(committedQualifiersForExtensionPreview(preview).transl_table).toEqual(['11']);
  });

  it('drops the stored protein, which was for the shorter feature', () => {
    const preview = buildExtendedCdsPreview(withFrame, SEQ, 'three-prime', false)!;
    expect(committedQualifiersForExtensionPreview(preview).translation).toBeUndefined();
  });

  it('drops the preview bookkeeping so the committed CDS is an ordinary one', () => {
    const preview = buildExtendedCdsPreview(incompleteCds, SEQ, 'three-prime', false)!;
    const committed = committedQualifiersForExtensionPreview(preview);
    expect(isCdsExtensionPreview({ qualifiers: committed })).toBe(false);
  });

  it('restarts the frame at 1 when the 5-prime end moved', () => {
    const preview = buildExtendedCdsPreview(
      { ...withFrame, start: 7, end: 15 },
      SEQ,
      'five-prime'
    )!;
    expect(committedQualifiersForExtensionPreview(preview).codon_start).toEqual(['1']);
  });
});

describe('annotationLayoutKey tells a hover preview from a draft', () => {
  const widened = (marker: string) => [
    {
      name: 'runner',
      type: 'CDS',
      start: 2554,
      end: 2686,
      direction: 1,
      color: '#888',
      qualifiers: {
        [CDS_EXTENSION_ORIGINAL_QUALIFIER]: ['2569..2686'],
        [marker]: ['five-prime'],
      },
    } as unknown as Annotation,
  ];

  it('gives a drafted end and a hovered end different keys', () => {
    expect(annotationLayoutKey(widened(CDS_EXTENSION_DIRECTION_QUALIFIER))).not.toBe(
      annotationLayoutKey(widened(CDS_EXTENSION_HOVER_QUALIFIER))
    );
  });

  it('still gives two identical annotations the same key', () => {
    expect(annotationLayoutKey(widened(CDS_EXTENSION_DIRECTION_QUALIFIER))).toBe(
      annotationLayoutKey(widened(CDS_EXTENSION_DIRECTION_QUALIFIER))
    );
  });
});

describe('annotationLayoutKey', () => {
  const committed: Annotation = { name: 'orfA', type: 'CDS', start: 1, end: 15, direction: 1 };

  it('tells a live preview apart from the CDS it was committed onto', () => {
    const preview = buildExtendedCdsPreview(incompleteCds, SEQ, 'three-prime', false)!;
    expect(annotationLayoutKey([preview])).not.toBe(annotationLayoutKey([committed]));
  });

  it('still returns the same key for an unchanged list', () => {
    expect(annotationLayoutKey([committed])).toBe(annotationLayoutKey([{ ...committed }]));
  });

  it('changes when an annotation moves', () => {
    expect(annotationLayoutKey([committed])).not.toBe(
      annotationLayoutKey([{ ...committed, end: 18 }])
    );
  });
});

describe('an extension that crosses the origin', () => {
  const TINY = 'TAAGGGATGGCCAAG';

  it("carries a 3' extension through the origin as an origin-spanning CDS", () => {
    const grown = buildExtendedCdsPreviewForEnds(
      { name: 'x', type: 'CDS', start: 7, end: 12, direction: 1 },
      TINY,
      { drafted: ['three-prime'], circular: true }
    )!;
    expect(grown.start).toBe(7);
    expect(grown.end).toBe(3);
    expect(grown.end).toBeLessThan(grown.start);
  });

  it('never emits a coordinate outside the molecule', () => {
    for (const end of ['five-prime', 'three-prime'] as const) {
      const grown = buildExtendedCdsPreviewForEnds(
        { name: 'x', type: 'CDS', start: 7, end: 12, direction: 1 },
        TINY,
        { drafted: [end], circular: true }
      );
      if (!grown) continue;
      expect(grown.start).toBeGreaterThanOrEqual(1);
      expect(grown.start).toBeLessThanOrEqual(TINY.length);
      expect(grown.end).toBeGreaterThanOrEqual(1);
      expect(grown.end).toBeLessThanOrEqual(TINY.length);
    }
  });

  it('refuses to lap the molecule', () => {
    const nearlyWhole = { name: 'x', type: 'CDS', start: 1, end: 12, direction: 1 };
    const grown = buildExtendedCdsPreviewForEnds(nearlyWhole, 'AAAAAAAAAAAAAAA', {
      drafted: ['three-prime'],
      circular: true,
    });
    expect(grown).toBeNull();
  });

  it('leaves a linear molecule stopping at its end', () => {
    const grown = buildExtendedCdsPreviewForEnds(
      { name: 'x', type: 'CDS', start: 7, end: 12, direction: 1 },
      TINY,
      { drafted: ['three-prime'], circular: false }
    );
    if (grown) {
      expect(grown.end).toBeGreaterThanOrEqual(grown.start);
      expect(grown.end).toBeLessThanOrEqual(TINY.length);
    }
  });
});

describe('positionWithinCdsBounds', () => {
  it('handles ordinary ascending bounds', () => {
    expect(positionWithinCdsBounds({ start: 10, end: 20 }, 14)).toBe(true);
    expect(positionWithinCdsBounds({ start: 10, end: 20 }, 25)).toBe(false);
  });

  it('handles bounds that run through the origin', () => {
    expect(positionWithinCdsBounds({ start: 90, end: 10 }, 95)).toBe(true);
    expect(positionWithinCdsBounds({ start: 90, end: 10 }, 5)).toBe(true);
    expect(positionWithinCdsBounds({ start: 90, end: 10 }, 50)).toBe(false);
  });

  it('calls a codon inside origin-spanning bounds annotated, not predicted', () => {
    const wrapped = { start: 90, end: 10 };
    expect(isPredictedCodonCell(wrapped, { genomicStart: 94, genomicEnd: 96 })).toBe(false);
    expect(isPredictedCodonCell(wrapped, { genomicStart: 2, genomicEnd: 4 })).toBe(false);
    expect(isPredictedCodonCell(wrapped, { genomicStart: 40, genomicEnd: 42 })).toBe(true);
  });
});

describe('committedQualifiersForExtensionPreview', () => {
  const withFrame = {
    ...incompleteCds,
    qualifiers: {
      codon_start: ['2'],
      gene: ['bla'],
      translation: ['MKV'],
      transl_table: ['11'],
    },
  };

  it('keeps the frame anchor when only the 3-prime end moves', () => {
    const preview = buildExtendedCdsPreview(withFrame, SEQ, 'three-prime', false)!;
    expect(committedQualifiersForExtensionPreview(preview).codon_start).toEqual(['2']);
    expect(committedQualifiersForExtensionPreview(preview).transl_table).toEqual(['11']);
  });

  it('drops the stored protein, which was for the shorter feature', () => {
    const preview = buildExtendedCdsPreview(withFrame, SEQ, 'three-prime', false)!;
    expect(committedQualifiersForExtensionPreview(preview).translation).toBeUndefined();
  });

  it('drops the preview bookkeeping so the committed CDS is an ordinary one', () => {
    const preview = buildExtendedCdsPreview(incompleteCds, SEQ, 'three-prime', false)!;
    const committed = committedQualifiersForExtensionPreview(preview);
    expect(isCdsExtensionPreview({ qualifiers: committed })).toBe(false);
  });

  it('restarts the frame at 1 when the 5-prime end moved', () => {
    const preview = buildExtendedCdsPreview(
      { ...withFrame, start: 7, end: 15 },
      SEQ,
      'five-prime'
    )!;
    expect(committedQualifiersForExtensionPreview(preview).codon_start).toEqual(['1']);
  });
});

describe('annotationLayoutKey', () => {
  const committed: Annotation = { name: 'orfA', type: 'CDS', start: 1, end: 15, direction: 1 };

  it('tells a live preview apart from the CDS it was committed onto', () => {
    const preview = buildExtendedCdsPreview(incompleteCds, SEQ, 'three-prime', false)!;
    expect(annotationLayoutKey([preview])).not.toBe(annotationLayoutKey([committed]));
  });

  it('still returns the same key for an unchanged list', () => {
    expect(annotationLayoutKey([committed])).toBe(annotationLayoutKey([{ ...committed }]));
  });

  it('changes when an annotation moves', () => {
    expect(annotationLayoutKey([committed])).not.toBe(
      annotationLayoutKey([{ ...committed, end: 18 }])
    );
  });
});

describe('an extension that would wrap past the origin', () => {
  const TINY = 'TAAGGGATGGCCAAG';

  it('never widens a CDS past the end of the molecule', () => {
    const preview = buildExtendedCdsPreview(
      { name: 'x', type: 'CDS', start: 7, end: 12, direction: 1 },
      TINY,
      'three-prime',
      false
    );
    if (preview) {
      expect(preview.end).toBeLessThanOrEqual(TINY.length);
      expect(preview.start).toBeGreaterThanOrEqual(1);
    }
  });

  it('never widens a CDS to a start at or before zero', () => {
    const preview = buildExtendedCdsPreview(
      { name: 'x', type: 'CDS', start: 4, end: 12, direction: 1 },
      TINY,
      'five-prime',
      false
    );
    if (preview) {
      expect(preview.start).toBeGreaterThanOrEqual(1);
      expect(preview.end).toBeLessThanOrEqual(TINY.length);
    }
  });

  it('agrees with the arrow: what is offered is what the preview can deliver', () => {
    const cds = { start: 6, end: 11, direction: 1 as const };
    const offered = incompleteCdsEnds(cds, TINY, false);
    for (const end of offered) {
      const preview = buildExtendedCdsPreview(
        { name: 'x', type: 'CDS', start: 7, end: 12, direction: 1 },
        TINY,
        end,
        false
      );
      if (preview) {
        expect(preview.start).toBeGreaterThanOrEqual(1);
        expect(preview.end).toBeLessThanOrEqual(TINY.length);
      }
    }
  });
});

describe('extensionQualifiersForSavedRow', () => {
  const parent = { name: 'orfA', type: 'CDS', start: 1, end: 9, direction: 1 as const };
  const draft = {
    key: cdsExtensionKeyFor(parent),
    extended: buildExtendedCdsPreview(incompleteCds, SEQ, 'three-prime', false)!,
  };

  it('applies the extension when the row saved is still that CDS', () => {
    expect(extensionQualifiersForSavedRow(draft, parent)).toBeDefined();
  });

  it('refuses when a different annotation now sits at that row', () => {
    const shiftedIn = { name: 'downstream_terminator', type: 'terminator', start: 40, end: 60 };
    expect(extensionQualifiersForSavedRow(draft, shiftedIn)).toBeUndefined();
  });

  it('refuses when the CDS kept its name but its bounds moved', () => {
    expect(extensionQualifiersForSavedRow(draft, { ...parent, end: 12 })).toBeUndefined();
  });

  it('refuses when there is no draft, or the row is gone', () => {
    expect(extensionQualifiersForSavedRow(null, parent)).toBeUndefined();
    expect(extensionQualifiersForSavedRow(draft, undefined)).toBeUndefined();
  });
});

describe('nearestRowCopyForBp', () => {
  const layout = {
    lines: [
      { lineIndex: 0, startPos: 0, endPos: 100, y: 0 },
      { lineIndex: 10, startPos: 0, endPos: 100, y: 4000 },
      { lineIndex: 20, startPos: 0, endPos: 100, y: 8000 },
    ],
  };

  it('picks the copy the viewport is actually showing', () => {
    expect(nearestRowCopyForBp(layout, 50, 3980)?.lineIndex).toBe(10);
    expect(nearestRowCopyForBp(layout, 50, 40)?.lineIndex).toBe(0);
    expect(nearestRowCopyForBp(layout, 50, 7900)?.lineIndex).toBe(20);
  });

  it('reports the offset from the top of the viewport, signed', () => {
    expect(nearestRowCopyForBp(layout, 50, 3980)?.offsetPx).toBe(20);
    expect(nearestRowCopyForBp(layout, 50, 4020)?.offsetPx).toBe(-20);
  });

  it('is null when no drawn row covers the base', () => {
    expect(nearestRowCopyForBp(layout, 500, 0)).toBeNull();
    expect(nearestRowCopyForBp(null, 50, 0)).toBeNull();
  });
});

describe('growing both ends', () => {
  const clipped: {
    name: string;
    type: string;
    start: number;
    end: number;
    direction: number;
    qualifiers?: Record<string, string[]>;
  } = { name: 'orfA', type: 'CDS', start: 7, end: 12, direction: 1 };

  it('extends both ends at once when both are asked for', () => {
    const both = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      drafted: ['five-prime', 'three-prime'],
    })!;
    expect(both.start).toBe(1);
    expect(both.end).toBe(15);
    expect(cdsExtensionPreviewEnds(both).sort()).toEqual(['five-prime', 'three-prime']);
  });

  it('does not depend on the order the ends were clicked', () => {
    const a = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      drafted: ['five-prime', 'three-prime'],
    })!;
    const b = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      drafted: ['three-prime', 'five-prime'],
    })!;
    expect([b.start, b.end]).toEqual([a.start, a.end]);
  });

  it('records the TRUE original, not the half-grown middle step', () => {
    const both = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      drafted: ['five-prime', 'three-prime'],
    })!;
    expect(cdsExtensionOriginalBounds(both)).toEqual({ start: 7, end: 12 });
  });

  it('strips back to exactly the CDS it was built from', () => {
    const both = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      drafted: ['five-prime', 'three-prime'],
    })!;
    const back = cdsWithoutExtensionPreview(both)!;
    expect([back.start, back.end]).toEqual([7, 12]);
    expect(isCdsExtensionPreview(back)).toBe(false);
  });

  it('undoing one end leaves the other grown', () => {
    const only3 = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      drafted: ['three-prime'],
      circular: false,
    })!;
    expect(only3.start).toBe(7);
    expect(only3.end).toBe(15);
    expect(cdsExtensionPreviewEnds(only3)).toEqual(['three-prime']);
  });

  it('keeps one identity whether the CDS is drafted or not', () => {
    const both = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      drafted: ['five-prime', 'three-prime'],
    })!;
    expect(cdsExtensionIdentityKey(both)).toBe(cdsExtensionIdentityKey(clipped));
  });
});

describe('hovering an arrow must not turn it into an undo arrow', () => {
  const clipped: {
    name: string;
    type: string;
    start: number;
    end: number;
    direction: number;
    qualifiers?: Record<string, string[]>;
  } = { name: 'orfA', type: 'CDS', start: 7, end: 12, direction: 1 };

  it('records a hovered end separately from a clicked one', () => {
    const hovered = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      hovered: ['three-prime'],
      circular: false,
    })!;
    expect(cdsExtensionPreviewEnds(hovered)).toEqual([]);
    expect(cdsExtensionHoveredEnds(hovered)).toEqual(['three-prime']);
  });

  it('shows a drafted end as drafted, which is what earns the undo arrow', () => {
    const drafted = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      drafted: ['three-prime'],
    })!;
    expect(cdsExtensionPreviewEnds(drafted)).toEqual(['three-prime']);
    expect(cdsExtensionHoveredEnds(drafted)).toEqual([]);
  });

  it('keeps a drafted end drafted when its own arrow is hovered again', () => {
    const both = annotationsWithCdsExtensionPreview(
      [
        buildExtendedCdsPreviewForEnds(clipped, SEQ, {
          drafted: ['three-prime'],
          circular: false,
        })!,
      ],
      { cdsKey: cdsExtensionKeyFor(clipped), direction: 'three-prime', kind: 'extend' },
      SEQ,
      false
    );
    expect(cdsExtensionPreviewEnds(both[0]!)).toEqual(['three-prime']);
  });

  it('hovering the other end grows both, drafted plus hovered', () => {
    const shown = annotationsWithCdsExtensionPreview(
      [
        buildExtendedCdsPreviewForEnds(clipped, SEQ, {
          drafted: ['three-prime'],
          circular: false,
        })!,
      ],
      { cdsKey: cdsExtensionKeyFor(clipped), direction: 'five-prime', kind: 'extend' },
      SEQ,
      false
    );
    expect([shown[0]!.start, shown[0]!.end]).toEqual([1, 15]);
    expect(cdsExtensionPreviewEnds(shown[0]!)).toEqual(['three-prime']);
    expect(cdsExtensionHoveredEnds(shown[0]!)).toEqual(['five-prime']);
  });

  it('drops both markers when the extension is committed', () => {
    const both = buildExtendedCdsPreviewForEnds(clipped, SEQ, {
      drafted: ['three-prime'],
      hovered: ['five-prime'],
      circular: false,
    })!;
    const committed = committedQualifiersForExtensionPreview(both);
    expect(isCdsExtensionPreview({ qualifiers: committed })).toBe(false);
    expect(cdsExtensionHoveredEnds({ qualifiers: committed })).toEqual([]);
  });
});
