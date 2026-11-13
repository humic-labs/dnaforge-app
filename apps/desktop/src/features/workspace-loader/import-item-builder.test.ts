import { describe, it, expect } from 'vitest';
import { buildImportItem } from './import-item-builder';

describe('buildImportItem ', () => {
  it('marks a folder without a format or block', () => {
    const it0 = buildImportItem({ path: '/d/Laura Export', name: 'Laura Export', kind: 'folder' });
    expect(it0.kind).toBe('folder');
    expect(it0.format).toBeUndefined();
    expect(it0.block).toBeUndefined();
  });

  it('detects GenBank by content and leaves it unblocked', () => {
    const it0 = buildImportItem({
      path: '/d/pUC19.gb',
      name: 'pUC19.gb',
      kind: 'file',
      content: 'LOCUS pUC19 2686 bp\n//\n',
    });
    expect(it0.format).toBe('genbank');
    expect(it0.block).toBeUndefined();
  });

  it('detects a single-record FASTA as fasta, unblocked', () => {
    const it0 = buildImportItem({
      path: '/d/one.fasta',
      name: 'one.fasta',
      kind: 'file',
      content: '>seqA\nACGTACGT\n',
    });
    expect(it0.format).toBe('fasta');
    expect(it0.block).toBeUndefined();
  });

  it('BLOCKS a multi-record FASTA (item 7) while still labeling it fasta', () => {
    const it0 = buildImportItem({
      path: '/d/reads.fasta',
      name: 'reads.fasta',
      kind: 'file',
      content: ['>a', 'ACGT', '>b', 'TTTT'].join('\n'),
    });
    expect(it0.format).toBe('fasta');
    expect(it0.block?.kind).toBe('multi-record-fasta');
    expect(it0.block?.recordCount).toBe(2);
  });

  it('labels an unrecognized file "unknown" (detectFormat throws) without crashing', () => {
    const it0 = buildImportItem({
      path: '/d/notes.txt',
      name: 'notes.txt',
      kind: 'file',
      content: 'just some free text, not a sequence',
    });
    expect(it0.format).toBe('unknown');
    expect(it0.block).toBeUndefined();
  });

  it('detects format from the filename extension even without content', () => {
    const it0 = buildImportItem({ path: '/d/x.gb', name: 'x.gb', kind: 'file' });
    expect(it0.format).toBe('genbank');
    expect(it0.block).toBeUndefined();
  });
});
