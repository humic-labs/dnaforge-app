import { describe, it, expect } from 'vitest';
import { incompleteCdsEnds, buildExtendedCdsPreviewForEnds } from '../cds-extension-affordance';

function codonMolecule(n: number, placements: Array<[number, string]>): string {
  const c = new Array<string>(n).fill('CCC');
  for (const [i, t] of placements) c[i] = t;
  return c.join('');
}

describe('stop JUST past the origin', () => {
  const SEQ = codonMolecule(100, [[2, 'TAA']]);
  const cds = {
    name: 'x',
    type: 'CDS',
    start: 151,
    end: 300,
    strand: 1,
    color: '#888',
    qualifiers: {},
  } as never;
  it('the molecule is what the scenario claims', () => {
    expect(SEQ.length).toBe(300);
    expect(SEQ.slice(6, 9)).toBe('TAA');
  });
  it('offers the 3-prime end', () => {
    expect(incompleteCdsEnds({ start: 150, end: 299, direction: 1 }, SEQ, true)).toContain(
      'three-prime'
    );
  });
  it('extends to 151..9 — the stop is clear of the join', () => {
    const p = buildExtendedCdsPreviewForEnds(cds, SEQ, {
      drafted: ['three-prime'],
      circular: true,
    });
    expect(p && [p.start, p.end]).toEqual([151, 9]);
  });
});

describe('stop FAR past the origin', () => {
  const SEQ = codonMolecule(300, [[100, 'TAA']]);
  const cds = {
    name: 'y',
    type: 'CDS',
    start: 400,
    end: 900,
    strand: 1,
    color: '#888',
    qualifiers: {},
  } as never;
  it('the molecule is what the scenario claims', () => {
    expect(SEQ.length).toBe(900);
    expect(SEQ.slice(300, 303)).toBe('TAA');
  });
  it('offers the 3-prime end', () => {
    expect(incompleteCdsEnds({ start: 399, end: 899, direction: 1 }, SEQ, true)).toContain(
      'three-prime'
    );
  });
  it('extends a third of the way round to 400..303', () => {
    const p = buildExtendedCdsPreviewForEnds(cds, SEQ, {
      drafted: ['three-prime'],
      circular: true,
    });
    expect(p && [p.start, p.end]).toEqual([400, 303]);
  });
});
