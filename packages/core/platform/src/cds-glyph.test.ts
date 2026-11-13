import { describe, expect, it } from 'vitest';
import {
  cdsMorphPhases,
  CDS_MORPH_TIMING,
  planCdsCompoundLabels,
  type CdsLabelRegion,
} from './cds-glyph';

describe('portable CDS morph phases', () => {
  it('grows rectangular bars before starting chevrons and letters together', () => {
    expect(cdsMorphPhases(0)).toMatchObject({
      bandProgress: 0,
      chevronProgress: 0,
      residueAlpha: 0,
    });
    const early = cdsMorphPhases(0.2);
    expect(early.bandProgress).toBeGreaterThan(0);
    expect(early.bandProgress).toBeLessThan(1);
    expect(early.chevronProgress).toBe(0);
    expect(early.residueAlpha).toBe(0);
    expect(cdsMorphPhases(CDS_MORPH_TIMING.chevronStart).bandProgress).toBe(1);
    expect(cdsMorphPhases(CDS_MORPH_TIMING.chevronStart).residueAlpha).toBe(0);
    for (const p of [0.66, 0.75, 0.9, 1]) {
      const phase = cdsMorphPhases(p);
      expect(phase.bandProgress).toBe(1);
      expect(phase.residueAlpha).toBe(phase.chevronProgress);
      expect(phase.residueAlpha).toBeGreaterThan(0);
    }
  });

  it('is continuous at the adjustable cutoff and preserves the linked start when tuned', () => {
    for (const chevronStart of [0.35, 0.65, 0.8]) {
      const timing = { ...CDS_MORPH_TIMING, chevronStart };
      const below = cdsMorphPhases(chevronStart - 1e-5, timing);
      const above = cdsMorphPhases(chevronStart + 1e-5, timing);
      expect(Math.abs(above.bandProgress - below.bandProgress)).toBeLessThan(1e-7);
      expect(above.chevronProgress).toBeLessThan(1e-7);
      expect(cdsMorphPhases(chevronStart - 0.01, timing).residueAlpha).toBe(0);
      expect(cdsMorphPhases(chevronStart + 0.01, timing).residueAlpha).toBeGreaterThan(0);
      expect(cdsMorphPhases(1, timing)).toMatchObject({
        bandProgress: 1,
        chevronProgress: 1,
        residueAlpha: 1,
      });
    }
  });
});

const region = (kind: CdsLabelRegion['kind'], left: number, right: number, n: number) => ({
  kind,
  left,
  right,
  text: `${kind} ${n}`,
  rangeStart: left,
  rangeEnd: right - 1,
});
const measure = (s: string) => s.length * 6;

describe('centered CDS compound labels', () => {
  it.each([
    ['exon', 'intron', 'exon'],
    ['intron', 'exon', 'intron'],
    ['exon', 'exon', 'intron'],
    ['intron', 'intron', 'exon'],
  ] as const)('prefixes the screen-left chip once for %j', (...kinds) => {
    const regions = kinds.map((kind, i) => region(kind, i * 400, i * 400 + 300, i + 1));
    const groups = planCdsCompoundLabels(regions, 'INS', measure, 0, 1200);
    expect(groups).toHaveLength(3);
    const names = groups.flatMap((group) => group.parts).filter((part) => part.kind === 'gene');
    expect(names).toHaveLength(1);
    expect(groups[0].parts[0]).toBe(names[0]);
    for (let i = 0; i < groups.length; i++)
      expect((groups[i].left + groups[i].right) / 2).toBe((regions[i].left + regions[i].right) / 2);
  });

  it('keeps crowded intron chips inline while exon chips stack in the upper band', () => {
    const regions = [
      region('exon', 0, 30, 1),
      region('intron', 30, 55, 1),
      region('exon', 55, 90, 2),
    ];
    const groups = planCdsCompoundLabels(regions, 'INS', measure, 0, 90);
    expect(
      groups.some(
        (g) => g.parts.some((p) => p.kind === 'intron') && g.parts.some((p) => p.kind === 'exon')
      )
    ).toBe(false);
    const intron = groups.find((g) => g.parts.some((p) => p.kind === 'intron'))!;
    expect((intron.left + intron.right) / 2).toBe(42.5);
    expect(intron.left).toBeGreaterThanOrEqual(30);
    expect(intron.right).toBeLessThanOrEqual(55);
    expect(groups.flatMap((g) => g.parts).filter((p) => p.kind === 'gene')).toHaveLength(1);
  });

  it('uses the clipped visible midpoint and preserves biological hit ranges', () => {
    const groups = planCdsCompoundLabels(
      [region('intron', -500, 500, 1)],
      'INS',
      measure,
      100,
      300
    );
    expect((groups[0].left + groups[0].right) / 2).toBe(200);
    expect(groups[0].parts[1]).toMatchObject({ rangeStart: -500, rangeEnd: 499 });
  });
});
