import { describe, expect, it } from 'vitest';
import type { ColoredCutSite, ORF, RestrictionEnzyme } from '@waypoint/sequence-utils';
import type { PrimerDisplay } from '@waypoint/workspace-editor';

import { projectVisibleOverlays, type ActiveOverlaySnapshot } from './active-overlays';
import type { SelectionRange } from '../../../../../../packages/core/workspace-editor/src/selection-model';

const SEQ_LEN = 200;

function enzyme(name: string, recognition: string): RestrictionEnzyme {
  return { name, recognition_sequence: recognition } as unknown as RestrictionEnzyme;
}

function cutSite(opts: {
  name?: string;
  recognition?: string;
  recognitionStart: number;
  recognitionEnd: number;
  cutPositionTop?: number;
  strand?: 'forward' | 'reverse';
}): ColoredCutSite {
  return {
    enzyme: enzyme(opts.name ?? 'EcoRI', opts.recognition ?? 'GAATTC'),
    cutPositionTop: opts.cutPositionTop ?? opts.recognitionStart + 1,
    cutPositionBottom: opts.recognitionStart + 5,
    recognitionStart: opts.recognitionStart,
    recognitionEnd: opts.recognitionEnd,
    strand: opts.strand ?? 'forward',
    color: '#3366cc',
  };
}

function orf(opts: {
  start: number;
  end: number;
  frame?: number;
  strand?: '+' | '-';
  length?: number;
}): ORF {
  return {
    start: opts.start,
    end: opts.end,
    frame: opts.frame ?? 1,
    strand: opts.strand ?? '+',
    length: opts.length ?? opts.end - opts.start + 1,
  };
}

function primer(opts: {
  id?: string;
  name: string;
  start: number;
  end: number;
  direction?: 'forward' | 'reverse';
}): PrimerDisplay {
  return {
    id: opts.id ?? 'p1',
    name: opts.name,
    start: opts.start,
    end: opts.end,
    direction: opts.direction ?? 'forward',
    bases: 'ACGTACGTACGT',
    tm: 60,
    gc: 50,
  };
}

function snapshot(over: {
  sites?: ColoredCutSite[];
  orfs?: ORF[];
  primers?: PrimerDisplay[];
  restrictionVisible?: boolean;
  orfsVisible?: boolean;
  primersVisible?: boolean;
}): ActiveOverlaySnapshot {
  return {
    restrictionSites: { visible: over.restrictionVisible ?? true, sites: over.sites ?? [] },
    orfs: { visible: over.orfsVisible ?? true, items: over.orfs ?? [] },
    primers: { visible: over.primersVisible ?? true, items: over.primers ?? [] },
  };
}

const sel = (start: number, end: number, wraps = false): SelectionRange => ({ start, end, wraps });

describe('projectVisibleOverlays — cut site: recognitionEnd is 0-idx EXCLUSIVE', () => {
  it('converts the exact drawn box to 1-idx inclusive (adversarial)', () => {
    const site = cutSite({
      name: 'EcoRI',
      recognition: 'GAATTC',
      recognitionStart: 9,
      recognitionEnd: 15,
      cutPositionTop: 10,
      strand: 'forward',
    });
    const out = projectVisibleOverlays(snapshot({ sites: [site] }), sel(0, 100), SEQ_LEN);
    expect(out.restrictionSites.items).toHaveLength(1);
    const cs = out.restrictionSites.items![0];
    expect(cs.start).toBe(10);
    expect(cs.end).toBe(15);
    expect(cs.end - cs.start + 1).toBe(6);
    expect(cs.cutPosition).toBe(11);
    expect(cs.enzyme).toBe('EcoRI');
    expect(cs.recognitionSequence).toBe('GAATTC');
    expect(cs.strand).toBe('+');
    expect(cs.relation).toBe('selection-contains-feature');
  });

  it("maps 'reverse' strand to '-'", () => {
    const site = cutSite({ recognitionStart: 20, recognitionEnd: 26, strand: 'reverse' });
    const out = projectVisibleOverlays(snapshot({ sites: [site] }), sel(0, 100), SEQ_LEN);
    expect(out.restrictionSites.items![0].strand).toBe('-');
  });
});

describe('projectVisibleOverlays — ORF: end is 0-idx INCLUSIVE', () => {
  it('converts the exact drawn ORF to 1-idx inclusive (adversarial)', () => {
    const o = orf({ start: 5, end: 104, frame: 2, strand: '-', length: 100 });
    const out = projectVisibleOverlays(snapshot({ orfs: [o] }), sel(0, 150), SEQ_LEN);
    expect(out.orfs.items).toHaveLength(1);
    const proj = out.orfs.items![0];
    expect(proj.start).toBe(6);
    expect(proj.end).toBe(105);
    expect(proj.end - proj.start + 1).toBe(100);
    expect(proj.lengthBp).toBe(100);
    expect(proj.frame).toBe(2);
    expect(proj.strand).toBe('-');
    expect(proj.relation).toBe('selection-contains-feature');
  });
});

describe('projectVisibleOverlays — primer: end is 0-idx EXCLUSIVE', () => {
  it('converts the exact drawn primer to 1-idx inclusive (adversarial)', () => {
    const p = primer({ name: 'M13-F', start: 20, end: 40, direction: 'reverse' });
    const out = projectVisibleOverlays(snapshot({ primers: [p] }), sel(0, 100), SEQ_LEN);
    expect(out.primers.items).toHaveLength(1);
    const proj = out.primers.items![0];
    expect(proj.start).toBe(21);
    expect(proj.end).toBe(40);
    expect(proj.end - proj.start + 1).toBe(20);
    expect(proj.strand).toBe('-');
    expect(proj.relation).toBe('selection-contains-feature');
  });

  it('carries the primer name as UNTRUSTED and sanitizes it', () => {
    const p = primer({ name: 'evil‮name‍', start: 20, end: 40 });
    const out = projectVisibleOverlays(snapshot({ primers: [p] }), sel(0, 100), SEQ_LEN);
    const name = out.primers.items![0].name;
    expect(name?.trust).toBe('untrusted-data');
    expect(name?.value).toBe('evilname');
  });

  it('omits the name key when the primer name is empty', () => {
    const p = primer({ name: '', start: 20, end: 40 });
    const out = projectVisibleOverlays(snapshot({ primers: [p] }), sel(0, 100), SEQ_LEN);
    expect('name' in out.primers.items![0]).toBe(false);
  });
});

describe('projectVisibleOverlays — relation classification', () => {
  it('feature-contains-selection when the overlay strictly contains the selection', () => {
    const o = orf({ start: 0, end: 199 });
    const out = projectVisibleOverlays(snapshot({ orfs: [o] }), sel(50, 60), SEQ_LEN);
    expect(out.orfs.items![0].relation).toBe('feature-contains-selection');
  });

  it('partial-overlap when the overlay straddles a selection boundary', () => {
    const o = orf({ start: 40, end: 80 });
    const out = projectVisibleOverlays(snapshot({ orfs: [o] }), sel(0, 50), SEQ_LEN);
    expect(out.orfs.items![0].relation).toBe('partial-overlap');
  });

  it('drops instances that do NOT overlap the selection', () => {
    const inside = orf({ start: 10, end: 30 });
    const outside = orf({ start: 120, end: 150 });
    const out = projectVisibleOverlays(snapshot({ orfs: [inside, outside] }), sel(0, 50), SEQ_LEN);
    expect(out.orfs.items).toHaveLength(1);
    expect(out.orfs.items![0].start).toBe(11);
  });
});

describe('projectVisibleOverlays — cap + overflow', () => {
  it('caps items at OVERLAP_FEATURE_CAP (15) and reports the overflow', () => {
    const sites = Array.from({ length: 20 }, (_, i) =>
      cutSite({ recognitionStart: i * 2, recognitionEnd: i * 2 + 6 })
    );
    const out = projectVisibleOverlays(snapshot({ sites }), sel(0, 199), SEQ_LEN);
    expect(out.restrictionSites.items).toHaveLength(15);
    expect(out.restrictionSites.overflow).toBe(5);
  });

  it('sets no overflow key when at or below the cap', () => {
    const sites = Array.from({ length: 15 }, (_, i) =>
      cutSite({ recognitionStart: i * 2, recognitionEnd: i * 2 + 6 })
    );
    const out = projectVisibleOverlays(snapshot({ sites }), sel(0, 199), SEQ_LEN);
    expect(out.restrictionSites.items).toHaveLength(15);
    expect('overflow' in out.restrictionSites).toBe(false);
  });
});

describe('projectVisibleOverlays — tri-state', () => {
  it('layer OFF → { visible:false } with NO items key (unknown, not none)', () => {
    const site = cutSite({ recognitionStart: 9, recognitionEnd: 15 });
    const out = projectVisibleOverlays(
      snapshot({ sites: [site], restrictionVisible: false }),
      sel(0, 100),
      SEQ_LEN
    );
    expect(out.restrictionSites.visible).toBe(false);
    expect('items' in out.restrictionSites).toBe(false);
    expect('overflow' in out.restrictionSites).toBe(false);
  });

  it('layer ON with zero overlap → { visible:true, items:[] } (genuine none)', () => {
    const out = projectVisibleOverlays(snapshot({ sites: [] }), sel(0, 100), SEQ_LEN);
    expect(out.restrictionSites.visible).toBe(true);
    expect(out.restrictionSites.items).toEqual([]);
  });

  it('mixes states across layers independently', () => {
    const out = projectVisibleOverlays(
      snapshot({
        sites: [cutSite({ recognitionStart: 9, recognitionEnd: 15 })],
        restrictionVisible: true,
        orfs: [orf({ start: 5, end: 60 })],
        orfsVisible: false,
        primers: [],
        primersVisible: true,
      }),
      sel(0, 100),
      SEQ_LEN
    );
    expect(out.restrictionSites.visible).toBe(true);
    expect(out.restrictionSites.items).toHaveLength(1);
    expect(out.orfs.visible).toBe(false);
    expect('items' in out.orfs).toBe(false);
    expect(out.primers.visible).toBe(true);
    expect(out.primers.items).toEqual([]);
  });
});

describe('projectVisibleOverlays — wrap-safe', () => {
  it('handles an origin-crossing SELECTION without throwing', () => {
    const inWrapUpper = orf({ start: 190, end: 199 });
    const outMiddle = orf({ start: 90, end: 100 });
    const out = projectVisibleOverlays(
      snapshot({ orfs: [inWrapUpper, outMiddle] }),
      sel(180, 10, true),
      SEQ_LEN
    );
    expect(out.orfs.items).toHaveLength(1);
    expect(out.orfs.items![0].start).toBe(191);
  });

  it('handles an origin-crossing OVERLAY instance without throwing', () => {
    const site = cutSite({ recognitionStart: 198, recognitionEnd: 3 });
    const out = projectVisibleOverlays(snapshot({ sites: [site] }), sel(0, 50), SEQ_LEN);
    expect(out.restrictionSites.items).toHaveLength(1);
    const cs = out.restrictionSites.items![0];
    expect(cs.start).toBe(199);
    expect(cs.end).toBe(3);
  });

  it('maps a recognition site ending at the origin to the molecule end, never coordinate zero', () => {
    const site = cutSite({ recognitionStart: 194, recognitionEnd: 0 });
    const out = projectVisibleOverlays(snapshot({ sites: [site] }), sel(190, 199), SEQ_LEN);

    expect(out.restrictionSites.items).toHaveLength(1);
    expect(out.restrictionSites.items![0]).toMatchObject({
      start: 195,
      end: SEQ_LEN,
    });
  });
});
