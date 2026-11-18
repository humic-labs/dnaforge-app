import { describe, expect, it } from 'vitest';
import { entityColorFamily, entityIconClassName } from './entity-color-family';

describe('entity color family', () => {
  it.each([
    ['sequence', 'dna'],
    ['plasmid', 'dna'],
    ['design', 'dna'],
    ['genome', 'dna'],
    ['primer', 'dna'],
    ['rna_oligo', 'rna'],
    ['rna_sequence', 'rna'],
    ['guide_rna', 'rna'],
    ['protein', 'protein'],
    ['structure', 'protein'],
    ['molecular-document', 'protein'],
    ['alignment', 'data'],
    ['annotation', 'data'],
    ['table', 'data'],
    ['track-view', 'data'],
    ['config', 'code'],
    ['html', 'code'],
    ['notebook', 'neutral'],
    ['strain', 'neutral'],
    ['record', 'neutral'],
    ['folder', 'neutral'],
    ['image', 'neutral'],
    ['archive', 'neutral'],
    ['unknown', 'neutral'],
  ])('assigns %s to %s', (kind, family) => {
    expect(entityColorFamily({ kind })).toBe(family);
  });

  it.each([
    ['sample.fa', 'dna'],
    ['sample.fa.gz', 'dna'],
    ['sample.FNA.BGZF', 'dna'],
    ['sample.frn.gz', 'rna'],
    ['sample.faa', 'protein'],
    ['sample.bcif', 'protein'],
    ['sample.gff3.gz', 'data'],
    ['sample.bam', 'data'],
    ['sample.fastq.gz', 'data'],
    ['result.csv', 'data'],
    ['analysis.py', 'code'],
    ['analysis.js', 'code'],
    ['settings.json', 'code'],
    ['notes.wpnote.json', 'neutral'],
    ['design.wpdesign.json', 'dna'],
    ['map.dnaforge-track-view.json', 'data'],
    ['scene.dnaforge-molecular.json', 'protein'],
    ['steps.dnaforge-protocol.json', 'neutral'],
    ['C:\\project\\Notes\\.forge\\notebook.json', 'neutral'],
    ['notes.pdf', 'neutral'],
    ['microscopy.png', 'neutral'],
    ['archive.zip', 'neutral'],
  ])('resolves %s from its content format', (path, family) => {
    expect(entityColorFamily({ path })).toBe(family);
  });

  it('uses declared RNA metadata before a general sequence suffix', () => {
    expect(entityColorFamily({ kind: 'sequence', molecule: 'mRNA', path: '/rna.gb' })).toBe('rna');
    expect(entityColorFamily({ kind: 'rna_sequence', path: '/record.json' })).toBe('rna');
    expect(entityColorFamily({ kind: 'rna_oligo', path: '/oligo.primer.json' })).toBe('rna');
  });

  it('retains typed annotation identity when its source molecule is RNA', () => {
    expect(entityColorFamily({ kind: 'annotation', molecule: 'RNA' })).toBe('data');
  });

  it('refines general biology glyph categories using the source format', () => {
    expect(entityColorFamily({ kind: 'biology', path: '/protein.faa' })).toBe('protein');
    expect(entityColorFamily({ kind: 'biology', path: '/features.gff' })).toBe('data');
    expect(entityColorFamily({ kind: 'biology', path: '/sequence.frn' })).toBe('rna');
  });

  it('keeps custom sequence schemas in their package family', () => {
    expect(entityColorFamily({ kind: 'custom-sequence', packageKind: 'sequence' })).toBe('dna');
  });

  it('keeps folder names from inheriting file suffix colors', () => {
    expect(entityColorFamily({ path: '/data.json', isDirectory: true })).toBe('neutral');
  });

  it('treats unknown names as data rather than object properties', () => {
    expect(entityColorFamily({ kind: 'constructor' })).toBe('neutral');
    expect(entityColorFamily({ path: '/unknown.toString' })).toBe('neutral');
  });

  it('adds semantic color classes while preserving caller layout', () => {
    expect(entityIconClassName({ kind: 'rna_oligo' }, 'h-4 w-4')).toBe(
      'h-4 w-4 entity-icon-color entity-icon-color-rna'
    );
  });

  it('preserves semantic context when an entity glyph adds its default', () => {
    const rna = entityIconClassName({ kind: 'rna_oligo' }, 'h-4 w-4');
    expect(entityIconClassName({ kind: 'primer' }, rna)).toBe(rna);
  });
});
