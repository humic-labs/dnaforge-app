// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { GenomeFeature } from '@waypoint/genome-data';

import {
  findOrphanParentIds,
  findOrphanParentIdsBounded,
  markUnresolvedParents,
} from './orphan-parent-rescue';

function feature(overrides: Partial<GenomeFeature>): GenomeFeature {
  return {
    chrom: 'chr11',
    source: 'test',
    type: 'exon',
    start: 0,
    end: 100,
    score: null,
    strand: '+',
    phase: null,
    attributes: {},
    raw: '',
    ...overrides,
  };
}

describe('findOrphanParentIds (Phase 3 Slice 3a)', () => {
  it('returns an empty list when every Parent= reference is satisfied in-window', () => {
    const mrnaParent = feature({
      type: 'mRNA',
      start: 1000,
      end: 2000,
      attributes: { ID: ['tx-1'] },
    });
    const exonChild = feature({
      type: 'exon',
      start: 1100,
      end: 1300,
      attributes: { ID: ['ex-1'], Parent: ['tx-1'] },
    });
    expect(findOrphanParentIds([mrnaParent, exonChild])).toEqual([]);
  });

  it('lists the Parent= IDs of in-window children whose parent is missing', () => {
    const orphanExon = feature({
      type: 'exon',
      start: 100,
      end: 200,
      attributes: { ID: ['ex-1'], Parent: ['tx-missing'] },
    });
    const orphanCds = feature({
      type: 'CDS',
      start: 110,
      end: 190,
      attributes: { ID: ['cds-1'], Parent: ['tx-missing'] },
    });
    expect(findOrphanParentIds([orphanExon, orphanCds])).toEqual(['tx-missing']);
  });

  it('dedupes when multiple children share the same orphan parent', () => {
    const a = feature({
      type: 'exon',
      attributes: { ID: ['ex-a'], Parent: ['tx-missing'] },
    });
    const b = feature({
      type: 'exon',
      attributes: { ID: ['ex-b'], Parent: ['tx-missing'] },
    });
    const c = feature({
      type: 'CDS',
      attributes: { ID: ['cds-c'], Parent: ['tx-missing'] },
    });
    expect(findOrphanParentIds([a, b, c])).toEqual(['tx-missing']);
  });

  it('returns IDs in stable (sorted) order for cache-key stability', () => {
    const features = [
      feature({ type: 'exon', attributes: { ID: ['ex-1'], Parent: ['tx-z'] } }),
      feature({ type: 'exon', attributes: { ID: ['ex-2'], Parent: ['tx-a'] } }),
      feature({ type: 'exon', attributes: { ID: ['ex-3'], Parent: ['tx-m'] } }),
    ];
    expect(findOrphanParentIds(features)).toEqual(['tx-a', 'tx-m', 'tx-z']);
  });

  it('ignores non-transcript-child types (a `gene` with a Parent= is unusual but not an orphan child)', () => {
    const geneRow = feature({
      type: 'gene',
      attributes: { ID: ['g-1'], Parent: ['region-X'] },
    });
    expect(findOrphanParentIds([geneRow])).toEqual([]);
  });

  it('skips children with no Parent= attribute (root-level row)', () => {
    const rootExon = feature({
      type: 'exon',
      attributes: { ID: ['ex-orphan'] },
    });
    expect(findOrphanParentIds([rootExon])).toEqual([]);
  });

  it('handles whitespace-only Parent= refs as no-ops', () => {
    const child = feature({
      type: 'exon',
      attributes: { ID: ['ex-1'], Parent: ['   ', ''] },
    });
    expect(findOrphanParentIds([child])).toEqual([]);
  });

  it('handles multi-parent children: surfaces every missing parent, hides every satisfied one', () => {
    const parent1 = feature({
      type: 'mRNA',
      start: 1000,
      end: 2000,
      attributes: { ID: ['tx-1'] },
    });
    const polycistronicChild = feature({
      type: 'exon',
      attributes: { ID: ['ex-1'], Parent: ['tx-1', 'tx-2'] },
    });
    expect(findOrphanParentIds([parent1, polycistronicChild])).toEqual(['tx-2']);
  });

  it('treats whitespace-padded ID matches correctly (trim semantics)', () => {
    const parent = feature({
      type: 'mRNA',
      attributes: { ID: ['tx-1'] },
    });
    const child = feature({
      type: 'exon',
      attributes: { ID: ['ex-1'], Parent: ['  tx-1  '] },
    });
    expect(findOrphanParentIds([parent, child])).toEqual([]);
  });

  it('returns every transcript-child type that can carry Parent=', () => {
    const childTypes = [
      'exon',
      'CDS',
      'five_prime_UTR',
      'three_prime_UTR',
      'UTR',
      'start_codon',
      'stop_codon',
    ];
    const features = childTypes.map((type, i) =>
      feature({ type, attributes: { ID: [`c-${i}`], Parent: [`tx-${i}`] } })
    );
    expect(findOrphanParentIds(features)).toEqual([
      'tx-0',
      'tx-1',
      'tx-2',
      'tx-3',
      'tx-4',
      'tx-5',
      'tx-6',
    ]);
  });
});

describe('findOrphanParentIdsBounded', () => {
  it('returns all orphans when under the cap', () => {
    const features = ['a', 'b', 'c'].map((id) =>
      feature({ type: 'exon', attributes: { ID: [`ex-${id}`], Parent: [`tx-${id}`] } })
    );
    const result = findOrphanParentIdsBounded(features, 100);
    expect(result.ids).toEqual(['tx-a', 'tx-b', 'tx-c']);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(3);
  });

  it('truncates to the first N (sorted) and reports total', () => {
    const features = ['z', 'y', 'x', 'a', 'b'].map((id) =>
      feature({ type: 'exon', attributes: { ID: [`ex-${id}`], Parent: [`tx-${id}`] } })
    );
    const result = findOrphanParentIdsBounded(features, 2);
    expect(result.ids).toEqual(['tx-a', 'tx-b']);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(5);
  });

  it('returns empty + truncated when maxIds is 0 and orphans exist', () => {
    const features = [
      feature({ type: 'exon', attributes: { ID: ['ex-1'], Parent: ['tx-missing'] } }),
    ];
    const result = findOrphanParentIdsBounded(features, 0);
    expect(result.ids).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(1);
  });

  it('returns empty + not-truncated when there are no orphans and maxIds is 0', () => {
    const result = findOrphanParentIdsBounded([], 0);
    expect(result.ids).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(0);
  });
});

describe('markUnresolvedParents', () => {
  it('stamps _unresolvedParentId on child rows whose parent was not rescued', () => {
    const child = feature({
      type: 'exon',
      attributes: { ID: ['ex-1'], Parent: ['tx-still-missing'] },
    });
    const rescued = new Set<string>();
    const count = markUnresolvedParents([child], rescued);
    expect(count).toBe(1);
    expect(child.attributes._unresolvedParentId).toEqual(['tx-still-missing']);
  });

  it('does not stamp child rows whose parent was rescued', () => {
    const child = feature({
      type: 'exon',
      attributes: { ID: ['ex-1'], Parent: ['tx-rescued'] },
    });
    const rescued = new Set(['tx-rescued']);
    const count = markUnresolvedParents([child], rescued);
    expect(count).toBe(0);
    expect(child.attributes._unresolvedParentId).toBeUndefined();
  });

  it('handles multi-parent children: stamps only when ALL parents are unrescued', () => {
    const multiParent = feature({
      type: 'exon',
      attributes: { ID: ['ex-1'], Parent: ['tx-a', 'tx-b'] },
    });
    const onlyB = new Set(['tx-b']);
    markUnresolvedParents([multiParent], onlyB);
    expect(multiParent.attributes._unresolvedParentId).toEqual(['tx-a']);
  });

  it('counts marked features and ignores non-transcript-child types', () => {
    const features = [
      feature({ type: 'exon', attributes: { ID: ['ex-1'], Parent: ['tx-x'] } }),
      feature({ type: 'CDS', attributes: { ID: ['cds-1'], Parent: ['tx-x'] } }),
      feature({ type: 'mRNA', attributes: { ID: ['tx-1'], Parent: ['tx-x'] } }),
      feature({ type: 'gene', attributes: { ID: ['g-1'] } }),
    ];
    const count = markUnresolvedParents(features, new Set());
    expect(count).toBe(2);
    expect(features[0].attributes._unresolvedParentId).toEqual(['tx-x']);
    expect(features[1].attributes._unresolvedParentId).toEqual(['tx-x']);
    expect(features[2].attributes._unresolvedParentId).toBeUndefined();
    expect(features[3].attributes._unresolvedParentId).toBeUndefined();
  });
});
