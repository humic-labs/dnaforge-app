// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeAnnotationDiff, computeSequenceDiff, extractRawSequence } from './sequence-diff';
import type { AnnotationDiffResult } from './sequence-diff';

describe('extractRawSequence', () => {
  it('extracts sequence from ORIGIN section', () => {
    const gb = `LOCUS test 10 bp DNA linear
ORIGIN
        1 atcgatcgat
//`;
    expect(extractRawSequence(gb)).toBe('atcgatcgat');
  });

  it('strips line numbers and spaces', () => {
    const gb = `ORIGIN\n        1 atcg atcg\n       11 tttt\n//`;
    expect(extractRawSequence(gb)).toBe('atcgatcgtttt');
  });

  it('throws when ORIGIN is missing instead of treating the record as empty DNA', () => {
    expect(() => extractRawSequence('LOCUS test')).toThrow(/ORIGIN section is missing/i);
  });
});

describe('computeSequenceDiff', () => {
  it('returns empty for identical sequences', async () => {
    const result = await computeSequenceDiff('ATCGATCG', 'ATCGATCG');
    expect(result.changes).toEqual([]);
  });

  it('detects insertion in the middle', async () => {
    const result = await computeSequenceDiff('ATCGATCG', 'ATCGCCATCG');
    expect(result.insertions).toBe(1);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      type: 'insertion',
      position: 4,
      length: 2,
      newBases: 'CC',
    });
    expect(result.mutations).toBe(0);
  });

  it('detects deletion in the middle', async () => {
    const result = await computeSequenceDiff('ATCGATCG', 'ATCGCG');
    expect(result.deletions).toBe(1);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      type: 'deletion',
      position: 4,
      length: 2,
      oldBases: 'AT',
    });
    expect(result.mutations).toBe(0);
  });

  it('detects single-base mutation', async () => {
    const result = await computeSequenceDiff('ATCGATCG', 'ATCGGTCG');
    expect(result.mutations).toBe(1);
    expect(result.changes[0]).toMatchObject({
      type: 'mutation',
      position: 4,
      length: 1,
      oldBases: 'A',
      newBases: 'G',
    });
  });

  it('detects multi-base replacement as del+ins (NW prefers gaps over multi-mismatch)', async () => {
    const result = await computeSequenceDiff('ATCGATCG', 'ATCGGGCG');
    expect(result.deletedBp + result.insertedBp).toBeGreaterThan(0);
    expect(result.changes.length).toBeGreaterThanOrEqual(1);
  });

  it('detects insertion at the start', async () => {
    const result = await computeSequenceDiff('ATCG', 'CCATCG');
    expect(result.insertions).toBe(1);
    expect(result.changes[0]).toMatchObject({
      type: 'insertion',
      position: 0,
      length: 2,
      newBases: 'CC',
    });
  });

  it('detects insertion at the end', async () => {
    const result = await computeSequenceDiff('ATCG', 'ATCGCC');
    expect(result.insertions).toBe(1);
    expect(result.changes[0]).toMatchObject({
      type: 'insertion',
      position: 4,
      length: 2,
      newBases: 'CC',
    });
  });

  it('detects deletion at the start', async () => {
    const result = await computeSequenceDiff('CCATCG', 'ATCG');
    expect(result.deletions).toBe(1);
    expect(result.changes[0]).toMatchObject({
      type: 'deletion',
      position: 0,
      length: 2,
      oldBases: 'CC',
    });
  });

  it('detects replacement (different lengths)', async () => {
    const result = await computeSequenceDiff('AAATGBB', 'AACCBB');
    const totalOldBp = result.changes.reduce(
      (sum, c) => sum + (c.type === 'deletion' || c.type === 'mutation' ? c.length : 0),
      0
    );
    const totalNewBp = result.changes.reduce(
      (sum, c) => sum + (c.type === 'insertion' || c.type === 'mutation' ? c.length : 0),
      0
    );
    expect(totalOldBp).toBeGreaterThan(0);
    expect(totalNewBp).toBeGreaterThan(0);
  });

  it('detects two scattered insertions separately (Myers diff)', async () => {
    const result = await computeSequenceDiff('AAAAABBBBBCCCCC', 'AAAAAXBBBBBYCCCCC');
    expect(result.insertions).toBe(2);
    expect(result.mutations).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]).toMatchObject({ type: 'insertion', position: 5, length: 1 });
    expect(result.changes[1]).toMatchObject({ type: 'insertion', position: 11, length: 1 });
  });

  it('detects scattered deletion + insertion separately', async () => {
    const result = await computeSequenceDiff('AAAAAXBBBBBCCCCC', 'AAAAABBBBBYCCCCC');
    expect(result.deletions).toBe(1);
    expect(result.insertions).toBe(1);
    expect(result.changes[0]).toMatchObject({ type: 'deletion', position: 5, length: 1 });
    expect(result.changes[1]).toMatchObject({ type: 'insertion', position: 10, length: 1 });
  });

  it('detects mutation (same-length replacement)', async () => {
    const result = await computeSequenceDiff('ATCGATCG', 'ATCGGTCG');
    expect(result.mutations).toBe(1);
    expect(result.changes[0]).toMatchObject({ type: 'mutation', position: 4, length: 1 });
  });

  it('handles empty old sequence', async () => {
    const result = await computeSequenceDiff('', 'ATCG');
    expect(result.insertions).toBe(1);
    expect(result.insertedBp).toBe(4);
  });

  it('handles empty new sequence', async () => {
    const result = await computeSequenceDiff('ATCG', '');
    expect(result.deletions).toBe(1);
    expect(result.deletedBp).toBe(4);
  });

  it('detects case change as mutation (case-sensitive)', async () => {
    const result = await computeSequenceDiff('atcgatcg', 'ATCGATCG');
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.mutations).toBeGreaterThan(0);
  });

  it('same case = no changes', async () => {
    const result = await computeSequenceDiff('atcgatcg', 'atcgatcg');
    expect(result.changes).toEqual([]);
  });

  it('detects insertion preserving surrounding case', async () => {
    const result = await computeSequenceDiff('atcgatcg', 'atcgCCatcg');
    expect(result.insertions).toBe(1);
    expect(result.changes[0]).toMatchObject({
      type: 'insertion',
      position: 4,
      length: 2,
    });
  });

  it('merges split deletions in repetitive DNA sequences', async () => {
    const result = await computeSequenceDiff('ATATATATATAT', 'ATATATATAT'.slice(0, -1));
    expect(result.deletions).toBe(1);
    expect(result.changes.filter((c) => c.type === 'deletion')).toHaveLength(1);
  });

  it('does not merge split deletions from diffChars ambiguity', async () => {
    const result = await computeSequenceDiff('ATATATATATAT', 'ATATATAAT');
    expect(result.deletedBp).toBe(3);
  });

  it('does NOT merge non-adjacent deletions', async () => {
    const result = await computeSequenceDiff('AAAAAXBBBBBXCCCCC', 'AAAAABBBBBCCCCC');
    expect(result.deletions).toBe(2);
  });
});

describe('computeAnnotationDiff', () => {
  it('detects added annotation', () => {
    const old = [{ name: 'AmpR', type: 'CDS', start: 100, end: 500, direction: 1 }];
    const new_ = [...old, { name: 'GFP', type: 'CDS', start: 600, end: 900, direction: 1 }];
    const result = computeAnnotationDiff(old, new_);
    expect(result.added).toBe(1);
    expect(result.changes.find((c) => c.type === 'added')).toMatchObject({
      type: 'added',
      name: 'GFP',
    });
  });

  it('detects removed annotation', () => {
    const old = [
      { name: 'AmpR', type: 'CDS', start: 100, end: 500, direction: 1 },
      { name: 'ori', type: 'rep_origin', start: 1000, end: 1500, direction: 1 },
    ];
    const new_ = [old[0]];
    const result = computeAnnotationDiff(old, new_);
    expect(result.removed).toBe(1);
    expect(result.changes.find((c) => c.type === 'removed')).toMatchObject({
      name: 'ori',
    });
  });

  it('does NOT flag position-only changes (implicit from sequence edits)', () => {
    const old = [{ name: 'AmpR', type: 'CDS', start: 100, end: 500, direction: 1 }];
    const new_ = [{ name: 'AmpR', type: 'CDS', start: 150, end: 550, direction: 1 }];
    const result = computeAnnotationDiff(old, new_);
    expect(result.modified).toBe(0);
  });

  it('ignores pure register shift from upstream insertion', () => {
    const old = [{ name: 'AmpR', type: 'CDS', start: 100, end: 500, direction: 1 }];
    const new_ = [{ name: 'AmpR', type: 'CDS', start: 103, end: 503, direction: 1 }];
    const seqChanges = [{ type: 'insertion' as const, position: 50, length: 3, newBases: 'NNN' }];
    const result = computeAnnotationDiff(old, new_, seqChanges);
    expect(result.modified).toBe(0);
    expect(result.changes).toHaveLength(0);
  });

  it('does NOT flag boundary change from sequence edit even with register shift', () => {
    const old = [{ name: 'AmpR', type: 'CDS', start: 100, end: 500, direction: 1 }];
    const new_ = [{ name: 'AmpR', type: 'CDS', start: 103, end: 550, direction: 1 }];
    const seqChanges = [{ type: 'insertion' as const, position: 50, length: 3, newBases: 'NNN' }];
    const result = computeAnnotationDiff(old, new_, seqChanges);
    expect(result.modified).toBe(0);
  });

  it('detects modified annotation (type change)', () => {
    const old = [{ name: 'Feature1', type: 'CDS', start: 1, end: 100, direction: 1 }];
    const new_ = [{ name: 'Feature1', type: 'gene', start: 1, end: 100, direction: 1 }];
    const result = computeAnnotationDiff(old, new_);
    expect(result.modified).toBe(1);
    expect(result.changes[0].changes).toContain('type: CDS → gene');
  });

  it('returns empty for identical annotations', () => {
    const anns = [{ name: 'AmpR', type: 'CDS', start: 100, end: 500, direction: 1 }];
    const result = computeAnnotationDiff(anns, [...anns]);
    expect(result.changes).toEqual([]);
  });

  it('handles empty annotation arrays', () => {
    const result = computeAnnotationDiff([], []);
    expect(result).toEqual({ changes: [], added: 0, removed: 0, modified: 0 });
  });

  it('matches annotations case-insensitively', () => {
    const old = [{ name: 'AmpR', type: 'CDS', start: 100, end: 500, direction: 1 }];
    const new_ = [{ name: 'ampr', type: 'CDS', start: 100, end: 500, direction: 1 }];
    const result = computeAnnotationDiff(old, new_);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('handles multiple added and removed', () => {
    const old = [
      { name: 'A', type: 'CDS', start: 1, end: 10, direction: 1 },
      { name: 'B', type: 'gene', start: 20, end: 30, direction: 1 },
    ];
    const new_ = [
      { name: 'C', type: 'promoter', start: 40, end: 50, direction: 1 },
      { name: 'D', type: 'CDS', start: 60, end: 70, direction: 1 },
    ];
    const result = computeAnnotationDiff(old, new_);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(2);
  });
});
