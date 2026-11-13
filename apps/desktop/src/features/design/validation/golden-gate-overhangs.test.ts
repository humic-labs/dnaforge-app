// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { DesignRegion } from '../types';
import {
  checkDuplicateOverhangs,
  checkGoldenGateRdFragmentCompatibility,
  checkInternalSitesInPcrRegions,
  countInternalSites,
  formatInternalCutCountLabel,
  goldenGateConflictTitle,
  summarizeInternalSitesByEnzyme,
} from './golden-gate-overhangs';

function pcrRegion(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

describe('checkInternalSitesInPcrRegions — internal-site footprints  #8)', () => {
  it('records forward AND reverse-complement recognition footprints as region-local 0-indexed [start,end) with strand', () => {
    const seq = 'AAAAGGTCTCAAAAGAGACCAAAA';
    const conflicts = checkInternalSitesInPcrRegions([pcrRegion('p1', seq)], 'BsaI');

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe('internal-site');
    expect(conflicts[0].message).toContain('2 extra BsaI recognition site(s)');
    expect(conflicts[0].internalSites).toEqual([
      { start: 4, end: 10, strand: 'forward' },
      { start: 14, end: 20, strand: 'reverse' },
    ]);
  });

  it('finds overlapping forward occurrences (indexOf advances by 1)', () => {
    const seq = 'GGTCTCGGTCTC';
    const conflicts = checkInternalSitesInPcrRegions([pcrRegion('p1', seq)], 'BsaI');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].internalSites).toEqual([
      { start: 0, end: 6, strand: 'forward' },
      { start: 6, end: 12, strand: 'forward' },
    ]);
  });

  it('skips RD regions (already digested) and PCR regions with no internal sites', () => {
    const rd: DesignRegion = {
      ...pcrRegion('rd1', 'GGTCTCAAAA'),
      sourceType: 'rd',
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
    };
    const clean = pcrRegion('clean', 'AAAACCCCGGGGTTTT');
    const conflicts = checkInternalSitesInPcrRegions([rd, clean], 'BsaI');
    expect(conflicts).toEqual([]);
  });

  it('tags the conflict with the right region index/id for downstream coordinate mapping', () => {
    const conflicts = checkInternalSitesInPcrRegions(
      [pcrRegion('clean', 'AAAACCCC'), pcrRegion('p2', 'TTGGTCTCTT')],
      'BsaI'
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].regionId).toBe('p2');
    expect(conflicts[0].regionIndex).toBe(1);
    expect(conflicts[0].internalSites).toEqual([{ start: 2, end: 8, strand: 'forward' }]);
  });

  it('precomputes per-enzyme part labels so the picker can show hits before a click', () => {
    const regions = [pcrRegion('p1', 'AAAAGGTCTCAAAA'), pcrRegion('p2', 'TTTGAAGACTTT')];
    const byEnzyme = summarizeInternalSitesByEnzyme(regions);

    expect(countInternalSites(byEnzyme.BsaI)).toBe(1);
    expect(countInternalSites(byEnzyme.BbsI)).toBe(1);
    expect(countInternalSites(byEnzyme.BsmBI)).toBe(0);
    expect(formatInternalCutCountLabel(countInternalSites(byEnzyme.BsaI))).toBe('1 internal cut');
    expect(formatInternalCutCountLabel(2)).toBe('2 internal cuts');
    expect(formatInternalCutCountLabel(0)).toBeNull();
  });
});

describe('Golden Gate error copy — plain-language reword ', () => {
  function rdRegion(id: string, ggType: 'insert' | 'backbone' | 'unusable' | 'rd'): DesignRegion {
    return {
      id,
      sourceSequenceId: `source-${id}`,
      sourceSequenceName: id,
      sourceStart: 0,
      sourceEnd: 120,
      sequence: 'ATCG'.repeat(30),
      annotations: [],
      sourceType: 'rd',
      ggType,
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
      rdSourceEnzyme: 'BsaI',
      rdSourceEnzymeName: 'BsaI',
    };
  }

  it('flags a backbone RD fragment used as an insert (behavior unchanged) with plain-language copy', () => {
    const conflicts = checkGoldenGateRdFragmentCompatibility(
      [rdRegion('pUC19-bb', 'backbone')],
      'BsaI'
    );
    const polarity = conflicts.find((c) => c.type === 'rd-fragment-not-insert');
    expect(polarity).toBeDefined();
    expect(polarity!.message).toContain('pUC19-bb');
    expect(polarity!.message.toLowerCase()).toContain('insert');
    expect(polarity!.message).not.toMatch(/re-digest/i);
    expect(polarity!.message).not.toMatch(/insert-polarity RD fragments only/i);
  });

  it('does NOT flag an insert-polarity RD fragment (behavior unchanged)', () => {
    const conflicts = checkGoldenGateRdFragmentCompatibility(
      [rdRegion('insert', 'insert')],
      'BsaI'
    );
    expect(conflicts.some((c) => c.type === 'rd-fragment-not-insert')).toBe(false);
  });

  it('accepts a backbone fragment only when its source is the selected destination vector', () => {
    const destinationBackbone = rdRegion('DVA_AE', 'backbone');
    const selected = checkGoldenGateRdFragmentCompatibility([destinationBackbone], 'BsaI', {
      backboneSequenceId: destinationBackbone.sourceSequenceId,
    });
    const differentVector = checkGoldenGateRdFragmentCompatibility([destinationBackbone], 'BsaI', {
      backboneSequenceId: 'source-other-vector',
    });

    expect(selected.some((conflict) => conflict.type === 'rd-fragment-not-insert')).toBe(false);
    expect(differentVector.some((conflict) => conflict.type === 'rd-fragment-not-insert')).toBe(
      true
    );
  });

  it('titles are plain-language, not Type IIS jargon ', () => {
    expect(goldenGateConflictTitle('rd-fragment-not-insert')).toBe(
      "This part can't be used as an insert"
    );
    expect(goldenGateConflictTitle('internal-site')).toBe('Enzyme site inside this part');
    expect(goldenGateConflictTitle('self-ligation')).toBe('Both ends have the same overhang');
  });

  it('reworded internal-site copy names the enzyme and what breaks (no Type IIS jargon)', () => {
    const pcr: DesignRegion = {
      id: 'pcr-internal',
      sourceSequenceId: 'source-pcr-internal',
      sourceSequenceName: 'pcr-internal',
      sourceStart: 0,
      sourceEnd: 14,
      sequence: 'AAAAGGTCTCAAAA',
      annotations: [],
      sourceType: 'pcr',
    };
    const conflicts = checkInternalSitesInPcrRegions([pcr], 'BsaI');
    const internal = conflicts.find((c) => c.type === 'internal-site');
    expect(internal).toBeDefined();
    expect(internal!.message).toContain('BsaI');
    expect(internal!.message.toLowerCase()).toContain('cut');
    expect(internal!.message).not.toMatch(
      /internal BsaI site\(s\) - would be cut during digestion/i
    );
  });

  it('reworded self-ligation copy is plain-language (both ends same overhang)', () => {
    const conflicts = checkDuplicateOverhangs(
      { index: 0, upstream: { sequence: 'AATG' }, downstream: { sequence: 'AATG' } } as Parameters<
        typeof checkDuplicateOverhangs
      >[0],
      new Set<string>()
    );
    const selfLig = conflicts.find((c) => c.type === 'self-ligation');
    expect(selfLig).toBeDefined();
    expect(selfLig!.message.toLowerCase()).toContain('both ends');
    expect(selfLig!.message).not.toMatch(/would self-ligate/i);
  });
});
