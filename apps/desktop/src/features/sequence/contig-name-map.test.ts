// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { assemblyContigNaming, buildContigNameMap } from './contig-name-map';

const GRCH38 = [
  { name: 'chr1', length: 248_956_422, aliases: ['NC_000001.11', 'CM000663.2', '1'] },
  { name: 'chr2', length: 242_193_529, aliases: ['NC_000002.12', 'CM000664.2', '2'] },
  { name: 'chrM', length: 16_569, aliases: ['NC_012920.1', 'MT'] },
];

describe('lining an assembly up with a source that names contigs differently', () => {
  it('matches the same names', () => {
    const map = buildContigNameMap({
      assembly: GRCH38,
      source: [{ name: 'chr1' }, { name: 'chr2' }],
    });
    expect(map.matches.map((m) => m.how)).toEqual(['exact', 'exact']);
    expect(map.sourceNameFor('chr1')).toBe('chr1');
  });

  it('matches an Ensembl-style source by dropping the prefix', () => {
    const map = buildContigNameMap({ assembly: GRCH38, source: [{ name: '1' }] });
    expect(map.assemblyNameFor('1')).toBe('chr1');
    expect(map.matchForSource('1')?.how).toBe('declared-alias');
  });

  it('matches an accession-named source, which is what defeated every path before', () => {
    const map = buildContigNameMap({
      assembly: GRCH38,
      source: [{ name: 'NC_000001.11' }, { name: 'CM000664.2' }],
    });
    expect(map.assemblyNameFor('NC_000001.11')).toBe('chr1');
    expect(map.assemblyNameFor('CM000664.2')).toBe('chr2');
    expect(map.unmatchedSource).toEqual([]);
  });

  it('reconciles the mitochondrion across conventions', () => {
    const map = buildContigNameMap({ assembly: GRCH38, source: [{ name: 'MT' }] });
    expect(map.assemblyNameFor('MT')).toBe('chrM');
  });

  it('reports a source contig the assembly never claimed', () => {
    const map = buildContigNameMap({
      assembly: GRCH38,
      source: [{ name: 'chr1' }, { name: 'NC_000067.7' }],
    });
    expect(map.unmatchedSource).toEqual(['NC_000067.7']);
    expect(map.assemblyNameFor('NC_000067.7')).toBeUndefined();
  });

  it('reports assembly contigs the source never named', () => {
    const map = buildContigNameMap({ assembly: GRCH38, source: [{ name: 'chr1' }] });
    expect(map.unmatchedAssembly).toEqual(['chr2', 'chrM']);
  });

  it('prefers the exact name over an alias when the source offers both', () => {
    const map = buildContigNameMap({
      assembly: GRCH38,
      source: [{ name: 'chr1' }, { name: 'NC_000001.11' }],
    });
    expect(map.assemblyNameFor('chr1')).toBe('chr1');
    expect(map.ambiguousSource).toEqual(['NC_000001.11']);
  });

  it('prefers the exact name even when the source lists its alias first', () => {
    const map = buildContigNameMap({
      assembly: GRCH38,
      source: [{ name: 'NC_000001.11' }, { name: 'chr1' }],
    });
    expect(map.sourceNameFor('chr1')).toBe('chr1');
    expect(map.ambiguousSource).toEqual(['NC_000001.11']);
  });

  it('prefers a declared alias over a prefix match from another source contig', () => {
    const map = buildContigNameMap({
      assembly: GRCH38,
      source: [{ name: 'CHR1' }, { name: 'NC_000001.11' }],
    });
    expect(map.sourceNameFor('chr1')).toBe('NC_000001.11');
    expect(map.ambiguousSource).toEqual(['CHR1']);
  });

  it('refuses to guess when a name could be two different contigs', () => {
    const confusable = [
      { name: 'chr1', length: 100, aliases: ['shared'] },
      { name: 'chr2', length: 200, aliases: ['shared'] },
    ];
    const map = buildContigNameMap({ assembly: confusable, source: [{ name: 'shared' }] });
    expect(map.ambiguousSource).toEqual(['shared']);
    expect(map.matches).toEqual([]);
  });

  it('records a length disagreement rather than hiding or resolving it', () => {
    const map = buildContigNameMap({
      assembly: GRCH38,
      source: [{ name: 'NC_000001.11', length: 999 }],
    });
    expect(map.matchForAssembly('chr1')?.lengthConflict).toEqual({
      assembly: 248_956_422,
      source: 999,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'reports an invalid declared source length %s as a conflict',
    (length) => {
      const map = buildContigNameMap({
        assembly: GRCH38,
        source: [{ name: 'NC_000001.11', length }],
      });
      expect(map.matchForAssembly('chr1')?.lengthConflict).toEqual({
        assembly: 248_956_422,
        source: length,
      });
    }
  );

  it('leaves a source with no length alone, as a text format has none to give', () => {
    const map = buildContigNameMap({ assembly: GRCH38, source: [{ name: '1' }] });
    expect(map.matchForAssembly('chr1')?.lengthConflict).toBeUndefined();
  });

  it('says how each contig was recognised, so a caller can be strict', () => {
    const map = buildContigNameMap({
      assembly: GRCH38,
      source: [{ name: 'chr1' }, { name: 'NC_000002.12' }],
    });
    expect(map.matchForSource('chr1')?.how).toBe('exact');
    expect(map.matchForSource('NC_000002.12')?.how).toBe('declared-alias');
  });

  it('copes with an assembly that declares nothing beyond its own names', () => {
    const bare = [{ name: 'chr1', length: 100 }];
    const map = buildContigNameMap({ assembly: bare, source: [{ name: '1' }] });
    expect(map.assemblyNameFor('1')).toBe('chr1');
    const stranger = buildContigNameMap({ assembly: bare, source: [{ name: 'NC_000001.11' }] });
    expect(stranger.unmatchedSource).toEqual(['NC_000001.11']);
  });

  it('ignores blank names at either end', () => {
    const map = buildContigNameMap({
      assembly: [...GRCH38, { name: '  ', length: 1 }],
      source: [{ name: '' }, { name: 'chr1' }],
    });
    expect(map.matches).toHaveLength(1);
  });
});

describe('assembly names supplied to track admission', () => {
  it('carries declared aliases and the display name without duplicate names', () => {
    expect(
      assemblyContigNaming([
        {
          chrom: 'chrsegment',
          length: 29_903,
          displayName: 'segment',
          aliases: {
            refseq: ' NC_045512.2 ',
            genbank: 'MN908947.3',
            ucsc: 'chrsegment',
            ensembl: 'segment',
          },
        },
        { chrom: 'empty', length: 0 },
      ])
    ).toEqual([
      {
        name: 'chrsegment',
        length: 29_903,
        aliases: ['NC_045512.2', 'MN908947.3', 'segment'],
      },
    ]);
  });
});
