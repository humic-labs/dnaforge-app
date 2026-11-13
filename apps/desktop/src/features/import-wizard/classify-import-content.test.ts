// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { classifyImportContent, describeImportContent } from './classify-import-content';

describe('describeImportContent (unified disposition descriptor)', () => {
  it('a sequence defaults to a workspace copy, with registry as an explicit opt-in', () => {
    const d = describeImportContent({ name: 'plasmid.gb' });
    expect(d.lane).toBe('sequence');
    expect(d.defaultDisposition).toBe('workspace');
    expect(d.allowedDispositions).toEqual(['workspace', 'registry']);
  });

  it('a table defaults to keeping the file, with record creation as an explicit choice', () => {
    const d = describeImportContent({ name: 'strains.csv' });
    expect(d.lane).toBe('tabular');
    expect(d.defaultDisposition).toBe('workspace');
    expect(d.allowedDispositions).toEqual(['workspace', 'registry-entities']);
  });

  it('an opaque asset can ONLY be a workspace copy — it may NEVER register (fail-closed)', () => {
    const d = describeImportContent({ name: 'protocol.pdf' });
    expect(d.lane).toBe('opaque-asset');
    expect(d.defaultDisposition).toBe('workspace');
    expect(d.allowedDispositions).toEqual(['workspace']);
    expect(d.allowedDispositions).not.toContain('registry');
  });

  it('the descriptor lane always agrees with the bare classifier', () => {
    for (const name of ['x.csv', 'y.gb', 'z.pdf', 'a.fasta', 'b.xlsx']) {
      expect(describeImportContent({ name }).lane).toBe(classifyImportContent({ name }));
    }
  });
});

describe('classifyImportContent', () => {
  describe('tabular', () => {
    it.each(['data.csv', 'plate.tsv', 'primers.xlsx', 'legacy.xls'])(
      'classifies %s as tabular by extension',
      (name) => {
        expect(classifyImportContent({ name })).toBe('tabular');
      }
    );

    it('is case-insensitive for tabular extensions', () => {
      expect(classifyImportContent({ name: 'DATA.CSV' })).toBe('tabular');
    });

    it('classifies a tabular file even when content is present', () => {
      expect(classifyImportContent({ name: 'x.csv', content: 'a,b\n1,2' })).toBe('tabular');
    });
  });

  describe('sequence — extension signal (no content)', () => {
    it.each(['plasmid.gb', 'clone.gbk', 'rec.genbank', 'reads.fasta', 'x.fa', 'y.fna', 'z.seq'])(
      'classifies %s as sequence from the extension when no content is available',
      (name) => {
        expect(classifyImportContent({ name })).toBe('sequence');
      }
    );

    it('is case-insensitive for sequence extensions', () => {
      expect(classifyImportContent({ name: 'PLASMID.GB' })).toBe('sequence');
    });

    it('does not promise sequence support for an unimplemented codec', () => {
      expect(classifyImportContent({ name: 'entry.embl' })).toBe('opaque-asset');
    });
  });

  describe('sequence — binary formats trust the extension', () => {
    it('classifies .ab1 as sequence even with unparseable (binary) content', () => {
      expect(classifyImportContent({ name: 'trace.ab1', content: '\x00\x01\x02binaryjunk' })).toBe(
        'sequence'
      );
    });

    it('classifies .dna (SnapGene) as sequence even with unparseable content', () => {
      expect(
        classifyImportContent({ name: 'construct.dna', content: '\x00SnapGene\x00junk' })
      ).toBe('sequence');
    });
  });

  describe('sequence — text formats validated against content', () => {
    it('classifies a valid FASTA by content', () => {
      expect(classifyImportContent({ name: 'seq.fasta', content: '>seq1\nACGTACGTACGT\n' })).toBe(
        'sequence'
      );
    });

    it('classifies a valid GenBank by content', () => {
      const gb = 'LOCUS       TEST        12 bp    DNA     linear   01-JAN-2026\nORIGIN\n//\n';
      expect(classifyImportContent({ name: 'x.gb', content: gb })).toBe('sequence');
    });

    it('classifies a MULTI-record FASTA as sequence (record-count is a later concern)', () => {
      const multi = '>a\nACGTACGT\n>b\nTTTTGGGG\n>c\nCCCCAAAA\n';
      expect(classifyImportContent({ name: 'many.fasta', content: multi })).toBe('sequence');
    });
  });

  describe('fail toward opaque-asset (never mislabel)', () => {
    it('downgrades a sequence-EXTENSION file whose content is NOT a biology format', () => {
      expect(
        classifyImportContent({
          name: 'notreally.fasta',
          content: 'this is plainly english prose, not a sequence.',
        })
      ).toBe('opaque-asset');
    });

    it('downgrades an EMPTY text sequence file to opaque-asset', () => {
      expect(classifyImportContent({ name: 'empty.gb', content: '' })).toBe('opaque-asset');
    });
  });

  describe('opaque-asset default', () => {
    it.each(['photo.png', 'notes.txt', 'archive.zip', 'report.pdf', 'script.py'])(
      'classifies %s as opaque-asset',
      (name) => {
        expect(classifyImportContent({ name })).toBe('opaque-asset');
      }
    );

    it('classifies an extensionless file as opaque-asset', () => {
      expect(classifyImportContent({ name: 'Makefile' })).toBe('opaque-asset');
    });

    it('classifies a dotfile (leading dot only) as opaque-asset', () => {
      expect(classifyImportContent({ name: '.gitignore' })).toBe('opaque-asset');
    });

    it('ignores sizeBytes — it does not change the class', () => {
      expect(classifyImportContent({ name: 'photo.png', sizeBytes: 999999 })).toBe('opaque-asset');
      expect(classifyImportContent({ name: 'plasmid.gb', sizeBytes: 10 })).toBe('sequence');
    });
  });
});
