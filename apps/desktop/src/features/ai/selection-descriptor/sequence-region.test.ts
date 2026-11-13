import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  parseGenBankFull,
  type AnnotatedSequence,
  type Annotation,
  type AnnotationDirection,
  type ColoredCutSite,
  type RestrictionEnzyme,
} from '@waypoint/sequence-utils';

import type { ActiveOverlaySnapshot } from './active-overlays';
import { LARGE_REGION_BP, buildSequenceRegionDescriptor } from './sequence-region';
import type { SequenceDescriptorInput } from './types';

const REPO_ROOT = join(__dirname, '../../../../../..');
const PUC19_PATH = join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb');
const ECOLI_REGION_PATH = join(REPO_ROOT, 'test-fixtures/sequences/linear/ecoli-mg1655-region.gb');

const puc19: AnnotatedSequence = parseGenBankFull(readFileSync(PUC19_PATH, 'utf8'));
const ecoliRegion: AnnotatedSequence = parseGenBankFull(readFileSync(ECOLI_REGION_PATH, 'utf8'));

const LACZ_START = 146;
const LACZ_END = 469;

function withLaczDirection(direction: AnnotationDirection): AnnotatedSequence {
  return {
    ...puc19,
    annotations: puc19.annotations.map((a: Annotation) =>
      a.type === 'CDS' && a.start === LACZ_START && a.end === LACZ_END ? { ...a, direction } : a
    ),
  };
}

function region(
  documentId: string,
  start: number,
  end: number,
  wraps?: boolean
): SequenceDescriptorInput & { range: { start: number; end: number; wraps?: boolean } } {
  return { kind: 'sequence_region', documentId, range: { start, end, wraps } };
}

describe('sequence_region — strand is READ from the containing CDS, not hard-assumed +', () => {
  it('reports - for the real reverse lacZ CDS', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, LACZ_START, LACZ_END), puc19, 3);
    expect(d.measured.strand).toBe('-');
  });

  it('reports + when the SAME containing CDS is explicitly forward-strand (synthetic control)', () => {
    const d = buildSequenceRegionDescriptor(
      region(PUC19_PATH, LACZ_START, LACZ_END),
      withLaczDirection(1),
      3
    );
    expect(d.measured.strand).toBe('+');
  });

  it('reports unspecified when no CDS overlaps the selection', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 1, 100), puc19, 3);
    expect(d.measured.strand).toBe('unspecified');
    expect(d.measured.readingFrames).toHaveLength(0);
  });
});

describe('sequence_region — range-overlap scan (not a point query)', () => {
  it('surfaces a feature whose whole span sits INSIDE a larger selection', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 480, 520), puc19, 3);
    const operator = d.measured.overlappingFeatures.find(
      (f) => f.type === 'protein_bind' && f.start === 489
    );
    expect(operator).toBeDefined();
    expect(operator?.end).toBe(505);
    expect(operator?.name).toBe('lac operator');
    expect(operator?.relation).toBe('selection-contains-feature');
    expect(operator!.start).toBeGreaterThan(480);
    expect(operator!.end).toBeLessThan(520);
  });

  it('marks a feature that strictly contains the selection as feature-contains-selection', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 200, 210), puc19, 3);
    const cds = d.measured.overlappingFeatures.find(
      (f) => f.type === 'CDS' && f.start === LACZ_START
    );
    expect(cds).toBeDefined();
    expect(cds?.relation).toBe('feature-contains-selection');
  });
});

describe('sequence_region — large selection does NOT eagerly compute GC', () => {
  it('LARGE_REGION_BP threshold is 50k', () => {
    expect(LARGE_REGION_BP).toBe(50_000);
  });

  it('skips GC over the raw slice for a selection above the threshold', () => {
    const d = buildSequenceRegionDescriptor(
      region(ECOLI_REGION_PATH, 1, ecoliRegion.length),
      ecoliRegion,
      1
    );
    expect(d.measured.length).toBeGreaterThan(LARGE_REGION_BP);
    expect(d.measured.gcComputed).toBe(false);
    expect(d.measured.gcPercentWholeSelection).toBeNull();
  });

  it('DOES compute GC for a small selection on the same sequence (contrast)', () => {
    const d = buildSequenceRegionDescriptor(region(ECOLI_REGION_PATH, 1, 1000), ecoliRegion, 1);
    expect(d.measured.length).toBeLessThanOrEqual(LARGE_REGION_BP);
    expect(d.measured.gcComputed).toBe(true);
    expect(typeof d.measured.gcPercentWholeSelection).toBe('number');
  });
});

describe('sequence_region — readingFrames are correct-or-unknown (never a wrong %3)', () => {
  const VALID_PHASES = [0, 1, 2, 'unknown'];

  it('a codon-aligned selection over the lacZ CDS yields phase 0', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, LACZ_START, LACZ_END), puc19, 3);
    expect(d.measured.readingFrames).toHaveLength(1);
    const frame = d.measured.readingFrames[0];
    expect(VALID_PHASES).toContain(frame.phase);
    expect(frame.phase).toBe(0);
    expect(frame.startCodonAligned).toBe(true);
    expect(frame.lengthIsCodonMultiple).toBe(true);
    expect(frame.frameshiftIfDeleted).toBe(false);
    expect(frame.translTable).toBe(11);
    expect(frame.strand).toBe('-');
    expect(frame.codingBasesInSelection).toBe(LACZ_END - LACZ_START + 1);
  });

  it('a 1 bp-offset selection genuinely RECOMPUTES the phase (not hardcoded 0)', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, LACZ_START, LACZ_END - 1), puc19, 3);
    expect(d.measured.readingFrames).toHaveLength(1);
    const frame = d.measured.readingFrames[0];
    expect(VALID_PHASES).toContain(frame.phase);
    expect(frame.phase).toBe(1);
    expect(frame.strand).toBe('-');
    expect(frame.startCodonAligned).toBe(false);
    expect(frame.lengthIsCodonMultiple).toBe(false);
    expect(frame.frameshiftIfDeleted).toBe(true);
    expect(frame.codingBasesInSelection).toBe(323);
  });

  it('recomputes phase from the opposite edge for the explicit forward-strand control', () => {
    const d = buildSequenceRegionDescriptor(
      region(PUC19_PATH, LACZ_START + 1, LACZ_END),
      withLaczDirection(1),
      3
    );
    expect(d.measured.readingFrames).toHaveLength(1);
    expect(d.measured.readingFrames[0]).toMatchObject({
      strand: '+',
      phase: 1,
      startCodonAligned: false,
      lengthIsCodonMultiple: false,
      frameshiftIfDeleted: true,
      codingBasesInSelection: 323,
      translTable: 11,
    });
  });

  it('keeps reverse phase 0 when only the coding three-prime edge is offset', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, LACZ_START + 1, LACZ_END), puc19, 3);
    expect(d.measured.readingFrames).toHaveLength(1);
    expect(d.measured.readingFrames[0]).toMatchObject({
      strand: '-',
      phase: 0,
      startCodonAligned: true,
      lengthIsCodonMultiple: false,
      frameshiftIfDeleted: true,
      codingBasesInSelection: 323,
      translTable: 11,
    });
  });
});

describe('sequence_region — top-level frame-preservation field (measured.lengthIsCodonMultiple / lengthModThree)', () => {
  it('true + modThree 0 for a codon-multiple selection (404..469 = 66 bp)', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 404, 469), puc19, 3);
    expect(d.measured.length).toBe(66);
    expect(d.measured.lengthIsCodonMultiple).toBe(true);
    expect(d.measured.lengthModThree).toBe(0);
  });

  it('false + modThree 1 for a non-multiple selection (403..469 = 67 bp)', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 403, 469), puc19, 3);
    expect(d.measured.length).toBe(67);
    expect(d.measured.lengthIsCodonMultiple).toBe(false);
    expect(d.measured.lengthModThree).toBe(1);
  });

  it('modThree 2 for a length ≡ 2 (mod 3) selection (402..469 = 68 bp)', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 402, 469), puc19, 3);
    expect(d.measured.length).toBe(68);
    expect(d.measured.lengthIsCodonMultiple).toBe(false);
    expect(d.measured.lengthModThree).toBe(2);
  });

  it('a single 1 bp selection is NOT a codon multiple (modThree 1)', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 200, 200), puc19, 3);
    expect(d.measured.length).toBe(1);
    expect(d.measured.lengthIsCodonMultiple).toBe(false);
    expect(d.measured.lengthModThree).toBe(1);
  });

  it('derives from the WHOLE selection length (distinct from the per-CDS readingFrames flag)', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, LACZ_START - 1, LACZ_END), puc19, 3);
    expect(d.measured.length).toBe(325);
    expect(d.measured.lengthIsCodonMultiple).toBe(false);
    expect(d.measured.lengthModThree).toBe(1);
    expect(d.measured.readingFrames).toHaveLength(1);
    expect(d.measured.readingFrames[0]).toMatchObject({
      codingBasesInSelection: 324,
      phase: 0,
      lengthIsCodonMultiple: true,
      frameshiftIfDeleted: false,
    });
  });

  it('positiveModulo guard: a degenerate 0-length selection yields true + 0 (never NaN/negative)', () => {
    const emptySeq: AnnotatedSequence = { ...puc19, sequence: '', length: 0, annotations: [] };
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 1, 1), emptySeq, 1);
    expect(d.measured.length).toBe(0);
    expect(d.measured.lengthModThree).toBe(0);
    expect(d.measured.lengthIsCodonMultiple).toBe(true);
  });

  it('leaves a contiguous descriptor otherwise unchanged and serializes the field into the fence', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, LACZ_START, LACZ_END), puc19, 3);
    expect(d.measured.start).toBe(LACZ_START);
    expect(d.measured.end).toBe(LACZ_END);
    expect(d.measured.strand).toBe('-');
    expect(d.measured.disjoint).toBeUndefined();
    const serialized = JSON.stringify(d);
    expect(serialized).toContain('"lengthIsCodonMultiple"');
    expect(serialized).toContain('"lengthModThree"');
  });
});

describe('sequence_region — kept features inline sanitized name/gene/product', () => {
  it('surfaces the lacZ CDS with its gene + product + name qualifiers', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 200, 210), puc19, 3);
    const cds = d.measured.overlappingFeatures.find(
      (f) => f.type === 'CDS' && f.start === LACZ_START
    );
    expect(cds).toBeDefined();
    expect(cds?.gene).toBe('lacZ');
    expect(cds?.product).toBe('LacZ alpha fragment');
    expect(typeof cds?.name).toBe('string');
    expect(cds?.name && cds.name.length).toBeGreaterThan(0);
    expect(cds?.name).toBe('lacZ-alpha');
  });

  it('sanitizes explicitly synthetic name, gene and product control characters', () => {
    const annotated: AnnotatedSequence = {
      ...puc19,
      annotations: puc19.annotations.map((a: Annotation) =>
        a.type === 'CDS' && a.start === LACZ_START && a.end === LACZ_END
          ? {
              ...a,
              name: '  lacZ\u0000-alpha\u202E\t  ',
              qualifiers: {
                ...a.qualifiers,
                gene: ['\tlacZ\u0007\n'],
                product: [' LacZ\u200B  alpha\nfragment '],
              },
            }
          : a
      ),
    };
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 200, 210), annotated, 3);
    expect(
      d.measured.overlappingFeatures.find((f) => f.type === 'CDS' && f.start === LACZ_START)
    ).toMatchObject({
      name: 'lacZ-alpha',
      gene: 'lacZ',
      product: 'LacZ alpha fragment',
      strand: '-',
      start: 146,
      end: 469,
      relation: 'feature-contains-selection',
    });
  });
});

describe('sequence_region — visibleOverlays (WYSIWYG) is present only with canvas context', () => {
  function enzyme(name: string, recognition: string): RestrictionEnzyme {
    return { name, recognition_sequence: recognition } as unknown as RestrictionEnzyme;
  }
  const overlappingSite: ColoredCutSite = {
    enzyme: enzyme('BsaI', 'GGTCTC'),
    cutPositionTop: 703,
    cutPositionBottom: 707,
    recognitionStart: 701,
    recognitionEnd: 707,
    strand: 'forward',
    color: '#3366cc',
  };
  const overlays: ActiveOverlaySnapshot = {
    restrictionSites: { visible: true, sites: [overlappingSite] },
    orfs: { visible: false, items: [] },
    primers: { visible: true, items: [] },
  };

  it('populates measured.visibleOverlays when activeOverlays is supplied', () => {
    const d = buildSequenceRegionDescriptor(
      { ...region(PUC19_PATH, 700, 710), activeOverlays: overlays },
      puc19,
      3
    );
    const vo = d.measured.visibleOverlays;
    expect(vo).toBeDefined();
    expect(vo?.restrictionSites.visible).toBe(true);
    expect(vo?.restrictionSites.items?.map((s) => s.enzyme)).toContain('BsaI');
    expect(vo?.orfs.visible).toBe(false);
    expect('items' in (vo?.orfs ?? {})).toBe(false);
    expect(vo?.primers.visible).toBe(true);
    expect(vo?.primers.items).toEqual([]);
  });

  it('OMITS measured.visibleOverlays when no activeOverlays is supplied (no canvas context)', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, 700, 710), puc19, 3);
    expect('visibleOverlays' in d.measured).toBe(false);
  });
});

describe('sequence_region — envelope shape', () => {
  it('carries the SELDESC v2 envelope and never inlines bases', () => {
    const d = buildSequenceRegionDescriptor(region(PUC19_PATH, LACZ_START, LACZ_END), puc19, 7);
    expect(d.schemaVersion).toBe(2);
    expect(d.kind).toBe('sequence_region');
    expect(d.bases).toBe('not_included');
    expect(d.coordinateSystem).toBe('1-indexed-inclusive');
    expect(d.sourceVersion).toBe(7);
    expect(d.locator.documentId).toBe(PUC19_PATH);
    expect(d.measured.restrictionSitesComputed).toBe(false);
    expect(d.measured.motifsComputed).toBe(false);
    expect(d.fetch.rawFallback?.tool).toBe('get_selection_bases');
  });
});
