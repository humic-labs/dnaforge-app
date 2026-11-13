import { beforeAll, describe, expect, it } from 'vitest';

import { loadAnnotationCatalogs } from './annotation-catalog-registry';
import { bundledStoreBridge } from './__tests__/bundled-store-bridge';

beforeAll(async () => {
  await loadAnnotationCatalogs(bundledStoreBridge());
});

import { parseGenBankFull, type Annotation } from '@waypoint/sequence-utils';

import {
  catalogDocumentIdentifiers,
  catalogForSequenceDocument,
  geneModelFromAnnotation,
  geneModelsContentKey,
  geneModelsFromAnnotations,
  geneSpansByNameAndLocusTag,
  sequenceReaderFor,
} from './document-identity';

function originBlock(bases: string): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bases.length; offset += 60) {
    const chunk =
      bases
        .slice(offset, offset + 60)
        .match(/.{1,10}/g)
        ?.join(' ') ?? '';
    lines.push(`${String(offset + 1).padStart(9)} ${chunk}`);
  }
  return lines.join('\n');
}

function genbankFixture(): string {
  const bases = 'acgt'.repeat(25);
  return [
    'LOCUS       TOY_000001               100 bp    DNA     circular BCT 01-JAN-2026',
    'DEFINITION  Toy record for gene coordinate conversion.',
    'ACCESSION   TOY_000001',
    'VERSION     TOY_000001.1',
    'FEATURES             Location/Qualifiers',
    '     source          1..100',
    '     gene            3..20',
    '                     /gene="alpA"',
    '                     /locus_tag="b9001"',
    '     CDS             3..20',
    '                     /gene="alpA"',
    '                     /locus_tag="b9001"',
    '     gene            complement(30..45)',
    '                     /gene="betB"',
    '                     /locus_tag="b9002"',
    '     gene            50..100',
    '                     /locus_tag="b9003"',
    'ORIGIN',
    originBlock(bases),
    '//',
    '',
  ].join('\n');
}

describe('gene models from an open GenBank document', () => {
  const document = parseGenBankFull(genbankFixture());

  it('converts 1-based inclusive gene features to 0-based half-open genes with strand', () => {
    expect(geneModelsFromAnnotations(document.annotations, document.length)).toEqual([
      { name: 'alpA', locusTag: 'b9001', start: 2, end: 20, strand: '+' },
      { name: 'betB', locusTag: 'b9002', start: 29, end: 45, strand: '-' },
      { name: 'b9003', locusTag: 'b9003', start: 49, end: 100, strand: '+' },
    ]);
  });

  it('skips genes without a strand, genes that wrap the origin, and genes past the end', () => {
    const base: Annotation = { name: 'x', type: 'gene', start: 10, end: 20, direction: 1 };
    expect(geneModelFromAnnotation({ ...base, direction: 0 }, 100)).toBeNull();
    expect(geneModelFromAnnotation({ ...base, start: 90, end: 5 }, 100)).toBeNull();
    expect(geneModelFromAnnotation({ ...base, end: 101 }, 100)).toBeNull();
    expect(geneModelFromAnnotation({ ...base, type: 'CDS' }, 100)).toBeNull();
  });

  it('identifies the document by its LOCUS name, since ACCESSION and VERSION are not kept', () => {
    expect(catalogDocumentIdentifiers(document)).toEqual(['TOY_000001']);
    expect(catalogForSequenceDocument(document)).toBeNull();
    expect(
      catalogForSequenceDocument({ ...document, name: 'NC_000913', length: 4_641_652 })
    ).not.toBeNull();
  });

  it('keys gene models by content, not by array identity', () => {
    const genes = [
      { name: 'thrA', locusTag: 'b0002', start: 336, end: 2799, strand: '+' as const },
      { name: 'thrB', locusTag: 'b0003', start: 2800, end: 3733, strand: '+' as const },
    ];
    const key = geneModelsContentKey(genes);
    expect(key.startsWith('2|b0002|b0003|')).toBe(true);
    expect(geneModelsContentKey(genes.map((gene) => ({ ...gene })))).toBe(key);
    expect(geneModelsContentKey([genes[0], { ...genes[1], start: 2801 }])).not.toBe(key);
    expect(geneModelsContentKey([genes[0], { ...genes[1], strand: '-' }])).not.toBe(key);
    expect(geneModelsContentKey([genes[0], { ...genes[1], name: 'thrX' }])).not.toBe(key);
    expect(geneModelsContentKey([genes[0]])).not.toBe(key);
  });

  it('finds each gene under its locus tag and its name', () => {
    const thrA = { name: 'thrA', locusTag: 'b0002', start: 336, end: 2799, strand: '+' as const };
    const insI2a = { name: 'insI2', locusTag: 'b1404', start: 10, end: 20, strand: '-' as const };
    const insI2b = { name: 'insI2', locusTag: 'b4284', start: 30, end: 40, strand: '-' as const };
    const spans = geneSpansByNameAndLocusTag([thrA, insI2a, insI2b]);
    expect(spans.get('b0002')).toBe(thrA);
    expect(spans.get('thrA')).toBe(thrA);
    expect(spans.get('b4284')).toBe(insI2b);
    expect(spans.get('insI2')).toBe(insI2a);
  });

  it('reads uppercase forward-strand slices', () => {
    const reader = sequenceReaderFor(document.sequence);
    expect(reader.lengthBp).toBe(100);
    expect(reader.slice(0, 8)).toBe(document.sequence.slice(0, 8).toUpperCase());
  });
});
