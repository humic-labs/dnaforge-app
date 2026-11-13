import { describe, it, expect } from 'vitest';
import { featureAliases, resolveFeaturesByName } from './feature-aliases';
import type { Annotation } from './types';

function annotation(partial: Partial<Annotation> & { type: string }): Annotation {
  return {
    name: '',
    start: 1,
    end: 100,
    direction: 1,
    ...partial,
  } as Annotation;
}

const REFSEQ_FFS = annotation({
  type: 'ncRNA',
  name: 'ffs',
  start: 476448,
  end: 476561,
  qualifiers: {
    ncRNA_class: ['other'],
    gene: ['ffs'],
    locus_tag: ['b0455'],
    gene_synonym: ['ECK0449'],
    product: ['signal recognition particle 4.5S RNA'],
    db_xref: ['ASAP:ABE-0001579', 'ECOCYC:EG30027', 'GeneID:944909'],
  },
});

const APE_FFS = annotation({
  type: 'ncRNA',
  name: 'ffs ncRNA (signal recognition particle 4.5S RNA)',
  start: 1192467,
  end: 1192580,
  qualifiers: {
    label: ['ffs ncRNA (signal recognition particle 4.5S RNA)'],
    ApEinfo_revcolor: ['#9eafd2'],
    ApEinfo_fwdcolor: ['#9eafd2'],
  },
});

describe('featureAliases — structured identity from either export shape', () => {
  it('reads every identity kind out of a canonical RefSeq feature', () => {
    const aliases = featureAliases(REFSEQ_FFS);

    expect(aliases.geneSymbol).toBe('ffs');
    expect(aliases.locusTag).toBe('b0455');
    expect(aliases.synonyms).toContain('ECK0449');
    expect(aliases.product).toBe('signal recognition particle 4.5S RNA');
    expect(aliases.xrefs).toContainEqual({ db: 'GeneID', id: '944909' });
    expect(aliases.xrefs).toContainEqual({ db: 'ECOCYC', id: 'EG30027' });
  });

  it('recovers gene symbol AND product from a flattened export label', () => {
    const aliases = featureAliases(APE_FFS);

    expect(aliases.geneSymbol).toBe('ffs');
    expect(aliases.product).toBe('signal recognition particle 4.5S RNA');
    expect(aliases.exportLabel).toBe('ffs ncRNA (signal recognition particle 4.5S RNA)');
  });

  it('never treats a display label as a locus tag or a cross-reference', () => {
    const aliases = featureAliases(APE_FFS);

    expect(aliases.locusTag).toBeUndefined();
    expect(aliases.xrefs).toHaveLength(0);
  });

  it('does not fabricate a gene symbol from prose', () => {
    const aliases = featureAliases(
      annotation({ type: 'misc_feature', name: 'similar to hypothetical protein' })
    );

    expect(aliases.geneSymbol).toBeUndefined();
  });

  it('leaves a bare Benchling "<NAME> gene" label usable', () => {
    const aliases = featureAliases(
      annotation({ type: 'misc_feature', name: 'PAU8 gene', qualifiers: { label: ['PAU8 gene'] } })
    );

    expect(aliases.geneSymbol).toBe('PAU8');
  });

  it('splits a semicolon-delimited Benchling label into name and description', () => {
    const aliases = featureAliases(
      annotation({
        type: 'misc_feature',
        name: 'ARS102; Autonomously Replicating Sequence',
        qualifiers: { label: ['ARS102; Autonomously Replicating Sequence'] },
      })
    );

    expect(aliases.geneSymbol).toBe('ARS102');
    expect(aliases.product).toBe('Autonomously Replicating Sequence');
  });

  it('keeps every db_xref namespace rather than only taxon', () => {
    const aliases = featureAliases(REFSEQ_FFS);
    expect(aliases.xrefs.map((x) => x.db).sort()).toEqual(['ASAP', 'ECOCYC', 'GeneID']);
  });

  it('never surfaces the translation as an identity', () => {
    const aliases = featureAliases(
      annotation({
        type: 'CDS',
        name: 'thrA',
        qualifiers: { gene: ['thrA'], translation: ['MRVLKFGGTSVANAERFLRVADILESNAR'] },
      })
    );

    const everyAlias = [
      aliases.geneSymbol,
      aliases.locusTag,
      aliases.product,
      ...aliases.synonyms,
      ...aliases.xrefs.map((x) => x.id),
    ];
    expect(everyAlias).not.toContain('MRVLKFGGTSVANAERFLRVADILESNAR');
  });
});

describe('🟥 cross-exporter parity — the invariant that broke', () => {
  const QUERIES = ['ffs', 'signal recognition particle 4.5S RNA'];

  it.each(QUERIES)('resolves %j identically in canonical and flattened records', (query) => {
    const fromRefSeq = resolveFeaturesByName([REFSEQ_FFS], query);
    const fromApe = resolveFeaturesByName([APE_FFS], query);

    expect(fromRefSeq).toHaveLength(1);
    expect(fromApe).toHaveLength(1);
    expect(fromRefSeq[0].matchedOn).toBe(fromApe[0].matchedOn);
  });

  it('resolves identifiers that ONLY the canonical record carries', () => {
    expect(resolveFeaturesByName([REFSEQ_FFS], 'b0455')).toHaveLength(1);
    expect(resolveFeaturesByName([REFSEQ_FFS], 'ECK0449')).toHaveLength(1);
    expect(resolveFeaturesByName([REFSEQ_FFS], 'GeneID:944909')).toHaveLength(1);
  });
});

describe('resolveFeaturesByName — ranked, typed matches', () => {
  const thrA = annotation({
    type: 'CDS',
    name: 'thrA',
    qualifiers: { gene: ['thrA'], locus_tag: ['b0002'], product: ['bifunctional aspartokinase'] },
  });
  const decoy = annotation({
    type: 'CDS',
    name: 'decoy',
    qualifiers: { gene: ['decoy'], locus_tag: ['thrA'] },
  });

  it('ranks an exact locus tag above an exact gene symbol', () => {
    const matches = resolveFeaturesByName([thrA, decoy], 'thrA');

    expect(matches[0].feature).toBe(decoy);
    expect(matches[0].matchedOn).toBe('locusTag');
    expect(matches[1].feature).toBe(thrA);
    expect(matches[1].matchedOn).toBe('geneSymbol');
  });

  it('reports every candidate instead of silently taking the first', () => {
    expect(resolveFeaturesByName([thrA, decoy], 'thrA')).toHaveLength(2);
  });

  it('matches case-insensitively', () => {
    expect(resolveFeaturesByName([thrA], 'THRA')[0].feature).toBe(thrA);
  });

  it('marks an exact match exact and a substring match not', () => {
    expect(resolveFeaturesByName([thrA], 'thrA')[0].exact).toBe(true);
    expect(resolveFeaturesByName([thrA], 'aspartokinase')[0].exact).toBe(false);
  });

  it('ranks an exact product match above a substring product match', () => {
    const exact = annotation({ type: 'CDS', name: 'x', qualifiers: { product: ['lactase'] } });
    const partial = annotation({
      type: 'CDS',
      name: 'y',
      qualifiers: { product: ['lactase-like hydrolase'] },
    });

    const matches = resolveFeaturesByName([partial, exact], 'lactase');
    expect(matches[0].feature).toBe(exact);
  });

  it('returns nothing for a query that matches no identity', () => {
    expect(resolveFeaturesByName([thrA], 'nonexistent')).toHaveLength(0);
  });

  it('filters to a caller-supplied predicate before ranking', () => {
    const geneFeature = annotation({ type: 'gene', name: 'ffs', qualifiers: { gene: ['ffs'] } });
    const matches = resolveFeaturesByName([geneFeature, REFSEQ_FFS], 'ffs', {
      filter: (f) => f.type !== 'gene',
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].feature).toBe(REFSEQ_FFS);
  });

  it('ignores an empty or whitespace-only query', () => {
    expect(resolveFeaturesByName([thrA], '   ')).toHaveLength(0);
  });
});
