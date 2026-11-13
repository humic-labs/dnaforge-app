import { describe, it, expect } from 'vitest';
import { importBucketFor, groupItemsByBucket } from './import-bucket';
import type { ImportItem } from '../workspace-loader/import-wizard-state';

function f(name: string, extra: Partial<ImportItem> = {}): ImportItem {
  return { path: `/d/${name}`, name, kind: 'file', ...extra };
}

describe('importBucketFor  Phase 0b — composed classifier)', () => {
  it('splits Sequences from Reads via detectFormat, not the biology lump', () => {
    expect(importBucketFor(f('pUC19.gb', { format: 'genbank' }))).toBe('Sequences');
    expect(importBucketFor(f('rbcL.fasta', { format: 'fasta' }))).toBe('Sequences');
    expect(importBucketFor(f('reads.fastq', { format: 'fastq' }))).toBe('Reads');
    expect(importBucketFor(f('trace.ab1', { format: 'ab1' }))).toBe('Reads');
  });

  it('fixes the .fastq bug even when format is unset (extension fallback)', () => {
    expect(importBucketFor(f('reads.fastq'))).toBe('Reads');
    expect(importBucketFor(f('trace.ab1'))).toBe('Reads');
    expect(importBucketFor(f('x.gb'))).toBe('Sequences');
  });

  it('buckets the non-biology families by extension', () => {
    expect(importBucketFor(f('plate.xlsx'))).toBe('Tabular');
    expect(importBucketFor(f('notes.csv'))).toBe('Tabular');
    expect(importBucketFor(f('protocol.pdf'))).toBe('Documents');
    expect(importBucketFor(f('gel.png'))).toBe('Images');
    expect(importBucketFor(f('mystery.xyz'))).toBe('Unsorted');
  });

  it('a fail-closed multi-record FASTA goes to Multi-record (needs a strategy)', () => {
    expect(
      importBucketFor(
        f('pool.fasta', {
          format: 'fasta',
          block: { kind: 'multi-record-fasta', recordCount: 7, message: '7 sequences' },
        })
      )
    ).toBe('Multi-record');
  });

  it('folders are not type-bucketed (kept intact, decision #4)', () => {
    expect(importBucketFor({ path: '/d/Proj', name: 'Proj', kind: 'folder' })).toBe('Unsorted');
  });

  it('groupItemsByBucket returns non-empty buckets in canonical order', () => {
    const groups = groupItemsByBucket([
      f('plate.xlsx'),
      f('a.gb', { format: 'genbank' }),
      f('r.fastq', { format: 'fastq' }),
      f('b.fasta', { format: 'fasta' }),
    ]);
    expect(groups.map((g) => g.bucket)).toEqual(['Sequences', 'Reads', 'Tabular']);
    expect(groups[0].items.map((i) => i.name)).toEqual(['a.gb', 'b.fasta']);
    expect(groups[1].items.map((i) => i.name)).toEqual(['r.fastq']);
  });
});
