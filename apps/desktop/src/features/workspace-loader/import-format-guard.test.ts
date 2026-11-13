// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { assessImportFile } from './import-format-guard';

describe('assessImportFile — multi-FASTA fail-closed ', () => {
  it('passes a single-record FASTA', () => {
    const r = assessImportFile({ content: '>seqA\nACGTACGTAC\n', filename: 'one.fasta' });
    expect(r.ok).toBe(true);
    expect(r.block).toBeUndefined();
  });

  it('BLOCKS a multi-record FASTA with the record count and filename in the message', () => {
    const content = ['>seqA', 'ACGT', '>seqB', 'TTTT', '>seqC', 'GGGG'].join('\n');
    const r = assessImportFile({ content, filename: 'reads.fasta' });
    expect(r.ok).toBe(false);
    expect(r.block?.kind).toBe('multi-record-fasta');
    expect(r.block?.recordCount).toBe(3);
    expect(r.block?.message).toContain('reads.fasta');
    expect(r.block?.message).toContain('3');
  });

  it('handles CRLF line endings', () => {
    const content = '>a\r\nACGT\r\n>b\r\nTTTT\r\n';
    const r = assessImportFile({ content, filename: 'x.fa' });
    expect(r.ok).toBe(false);
    expect(r.block?.recordCount).toBe(2);
  });

  it('passes a non-FASTA file (GenBank) untouched — this guard is FASTA-specific', () => {
    const r = assessImportFile({ content: 'LOCUS  pUC19  2686 bp\n//\n', filename: 'pUC19.gb' });
    expect(r.ok).toBe(true);
  });

  it('passes empty / whitespace content (not FASTA)', () => {
    expect(assessImportFile({ content: '   \n', filename: 'blank.txt' }).ok).toBe(true);
  });
});
