import { describe, it, expect } from 'vitest';
import { classifyMutation, type Mutation, type Annotation } from './mutation-classifier';
import { buildCustomGeneticCode } from './custom-genetic-codes';

describe('classifyMutation', () => {
  const referenceSeq = 'ATGGCTAAATGA';
  const _querySeq = 'ATGGCTAAATGA';

  const cdsAnnotation: Annotation = {
    name: 'TestGene',
    type: 'CDS',
    start: 1,
    end: 12,
    direction: 1,
  };

  const promoterAnnotation: Annotation = {
    name: 'Promoter',
    type: 'promoter',
    start: 1,
    end: 12,
    direction: 1,
  };

  describe('substitutions in CDS', () => {
    it('classifies synonymous mutation (no AA change)', () => {
      const mutation: Mutation = {
        type: 'substitution',
        position: 6,
        ref_base: 'T',
        query_base: 'C',
      };
      const queryWithMutation = 'ATGGCCAAATGA';

      const result = classifyMutation(mutation, referenceSeq, queryWithMutation, [cdsAnnotation]);

      expect(result.in_annotation).toBe(true);
      expect(result.annotation_names).toContain('TestGene');
      expect(result.affects_cds).toBe(true);
      expect(result.cds_name).toBe('TestGene');
      expect(result.classification).toBe('synonymous');
      expect(result.amino_acid_change).toBeUndefined();
    });

    it('classifies missense mutation (AA change)', () => {
      const mutation: Mutation = {
        type: 'substitution',
        position: 5,
        ref_base: 'C',
        query_base: 'A',
      };
      const queryWithMutation = 'ATGGATAAATGA';

      const result = classifyMutation(mutation, referenceSeq, queryWithMutation, [cdsAnnotation]);

      expect(result.in_annotation).toBe(true);
      expect(result.affects_cds).toBe(true);
      expect(result.classification).toBe('missense');
      expect(result.amino_acid_change).toBe('A2D');
    });

    it('classifies nonsense mutation (creates stop codon)', () => {
      const mutation: Mutation = {
        type: 'substitution',
        position: 7,
        ref_base: 'A',
        query_base: 'T',
      };
      const queryWithMutation = 'ATGGCTTAATGA';

      const result = classifyMutation(mutation, referenceSeq, queryWithMutation, [cdsAnnotation]);

      expect(result.in_annotation).toBe(true);
      expect(result.affects_cds).toBe(true);
      expect(result.classification).toBe('nonsense');
      expect(result.amino_acid_change).toBe('K3*');
    });
  });

  describe('indels in CDS', () => {
    it('classifies single-base insertion as frameshift', () => {
      const mutation: Mutation = {
        type: 'insertion',
        position: 4,
        ref_base: '-',
        query_base: 'G',
        length: 1,
      };
      const queryWithInsertion = 'ATGGGCTAAATGA';

      const result = classifyMutation(mutation, referenceSeq, queryWithInsertion, [cdsAnnotation]);

      expect(result.affects_cds).toBe(true);
      expect(result.classification).toBe('frameshift');
    });

    it('classifies 3-base insertion as in-frame (not frameshift)', () => {
      const mutation: Mutation = {
        type: 'insertion',
        position: 3,
        ref_base: '-',
        query_base: 'ATG',
        length: 3,
      };
      const queryWithInsertion = 'ATGATGGCTAAATGA';

      const result = classifyMutation(mutation, referenceSeq, queryWithInsertion, [cdsAnnotation]);

      expect(result.affects_cds).toBe(true);
      expect(result.classification).not.toBe('frameshift');
    });

    it('classifies single-base deletion as frameshift', () => {
      const mutation: Mutation = {
        type: 'deletion',
        position: 4,
        ref_base: 'G',
        query_base: '-',
        length: 1,
      };
      const queryWithDeletion = 'ATGCTAAATGA';

      const result = classifyMutation(mutation, referenceSeq, queryWithDeletion, [cdsAnnotation]);

      expect(result.affects_cds).toBe(true);
      expect(result.classification).toBe('frameshift');
    });

    it('classifies 3-base deletion as in-frame (not frameshift)', () => {
      const mutation: Mutation = {
        type: 'deletion',
        position: 4,
        ref_base: 'GCT',
        query_base: '-',
        length: 3,
      };
      const queryWithDeletion = 'ATGAAATGA';

      const result = classifyMutation(mutation, referenceSeq, queryWithDeletion, [cdsAnnotation]);

      expect(result.affects_cds).toBe(true);
      expect(result.classification).not.toBe('frameshift');
    });
  });

  describe('mutations outside annotations', () => {
    it('returns non-coding for mutation with no overlapping annotations', () => {
      const mutation: Mutation = {
        type: 'substitution',
        position: 5,
        ref_base: 'C',
        query_base: 'A',
      };

      const result = classifyMutation(mutation, referenceSeq, 'ATGGATAAATGA', []);

      expect(result.in_annotation).toBe(false);
      expect(result.annotation_names).toEqual([]);
      expect(result.affects_cds).toBe(false);
      expect(result.classification).toBeUndefined();
    });
  });

  describe('mutations in non-CDS annotations', () => {
    it('marks in_annotation=true but affects_cds=false for promoter mutation', () => {
      const mutation: Mutation = {
        type: 'substitution',
        position: 5,
        ref_base: 'C',
        query_base: 'A',
      };

      const result = classifyMutation(mutation, referenceSeq, 'ATGGATAAATGA', [promoterAnnotation]);

      expect(result.in_annotation).toBe(true);
      expect(result.annotation_names).toContain('Promoter');
      expect(result.affects_cds).toBe(false);
      expect(result.classification).toBeUndefined();
    });
  });

  describe('multiple overlapping annotations', () => {
    it('lists all overlapping annotation names', () => {
      const mutation: Mutation = {
        type: 'substitution',
        position: 5,
        ref_base: 'C',
        query_base: 'A',
      };

      const result = classifyMutation(mutation, referenceSeq, 'ATGGATAAATGA', [
        cdsAnnotation,
        promoterAnnotation,
      ]);

      expect(result.in_annotation).toBe(true);
      expect(result.annotation_names).toContain('TestGene');
      expect(result.annotation_names).toContain('Promoter');
      expect(result.affects_cds).toBe(true);
      expect(result.cds_name).toBe('TestGene');
    });
  });

  describe('reverse strand CDS', () => {
    it('correctly classifies mutation in reverse strand CDS', () => {
      const reverseCds: Annotation = {
        name: 'ReverseGene',
        type: 'CDS',
        start: 1,
        end: 12,
        direction: -1,
      };

      const mutation: Mutation = {
        type: 'substitution',
        position: 5,
        ref_base: 'C',
        query_base: 'A',
      };

      const result = classifyMutation(mutation, referenceSeq, 'ATGGATAAATGA', [reverseCds]);

      expect(result.affects_cds).toBe(true);
      expect(result.cds_name).toBe('ReverseGene');
      expect(['synonymous', 'missense', 'nonsense']).toContain(result.classification);
    });
  });
});

describe('spliced CDS (join() segments)', () => {
  const splicedRef = 'ATGGCCNNNNNAAATGA';
  const splicedCDS: Annotation = {
    name: 'SplicedGene',
    type: 'CDS',
    start: 1,
    end: 17,
    direction: 1,
    segments: [
      { start: 1, end: 6 },
      { start: 12, end: 17 },
    ],
    qualifiers: { _locationString: ['join(1..6,12..17)'] },
  };

  it('returns affects_cds=false for mutation in intron', () => {
    const mutation: Mutation = {
      type: 'substitution',
      position: 9,
      ref_base: 'N',
      query_base: 'A',
    };

    const result = classifyMutation(mutation, splicedRef, splicedRef, [splicedCDS]);

    expect(result.in_annotation).toBe(true);
    expect(result.affects_cds).toBe(false);
    expect(result.classification).toBeUndefined();
  });

  it('correctly classifies substitution in exon of spliced CDS', () => {
    const mutRef = 'ATGGCCNNNNNAAATGA';
    const mutQuery = 'ATGGACNNNNNAAATGA';
    const mutation: Mutation = {
      type: 'substitution',
      position: 5,
      ref_base: 'C',
      query_base: 'A',
    };

    const result = classifyMutation(mutation, mutRef, mutQuery, [splicedCDS]);

    expect(result.affects_cds).toBe(true);
    expect(result.cds_name).toBe('SplicedGene');
    expect(result.classification).toBe('missense');
    expect(result.amino_acid_change).toBe('A2D');
  });

  it('correctly classifies substitution in reverse-strand spliced CDS', () => {
    const revSplicedCDS: Annotation = {
      name: 'RevSplicedGene',
      type: 'CDS',
      start: 1,
      end: 17,
      direction: -1,
      segments: [
        { start: 1, end: 6 },
        { start: 12, end: 17 },
      ],
      qualifiers: { _locationString: ['join(1..6,12..17)'] },
    };
    const mutRef = 'ATGGCCNNNNNAAATGA';
    const mutQuery = 'ATGGCCNNNNNATATGA';
    const mutation: Mutation = {
      type: 'substitution',
      position: 13,
      ref_base: 'A',
      query_base: 'T',
    };

    const result = classifyMutation(mutation, mutRef, mutQuery, [revSplicedCDS]);

    expect(result.affects_cds).toBe(true);
    expect(result.cds_name).toBe('RevSplicedGene');
    expect(result.classification).toBe('missense');
    expect(result.amino_acid_change).toBe('F2Y');
  });

  it('correctly classifies substitution in second exon', () => {
    const mutRef = 'ATGGCCNNNNNAAATGA';
    const mutQuerySeq = 'ATGGCCNNNNNTAATGA';
    const mutation: Mutation = {
      type: 'substitution',
      position: 13,
      ref_base: 'A',
      query_base: 'T',
    };

    const result = classifyMutation(mutation, mutRef, mutQuerySeq, [splicedCDS]);

    expect(result.affects_cds).toBe(true);
    expect(result.classification).toBe('nonsense');
    expect(result.amino_acid_change).toBe('K3*');
  });
});

describe('batch classification', () => {
  it('classifyMutations enriches all mutations efficiently', async () => {
    const { classifyMutations } = await import('./mutation-classifier');

    const referenceSeq = 'ATGGCTAAATGA';
    const querySeq = 'ATGGATAAATGA';

    const mutations: Mutation[] = [
      { type: 'substitution', position: 5, ref_base: 'C', query_base: 'A' },
    ];

    const annotations: Annotation[] = [
      { name: 'TestGene', type: 'CDS', start: 1, end: 12, direction: 1 },
    ];

    const results = classifyMutations(mutations, referenceSeq, querySeq, annotations);

    expect(results).toHaveLength(1);
    expect(results[0].functional_impact).toBeDefined();
    expect(results[0].functional_impact?.affects_cds).toBe(true);
  });
});

describe('substitutions under a custom genetic code', () => {
  const reference = 'ATGTAGTCGTAA';
  const gene: Annotation = { name: 'amberGene', type: 'CDS', start: 1, end: 12, direction: 1 };

  function amberCode(extra: Record<string, { kind: 'unassigned' }> = {}) {
    const built = buildCustomGeneticCode({
      id: 'gc-3f2a9c1e',
      revision: 1,
      name: 'Amber suppression (pAzF at TAG)',
      base: 11,
      changes: { TAG: { kind: 'residue', residue: 'pAzF' }, ...extra },
      residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
    });
    if (!built.ok) throw new Error('fixture must build');
    return built.definition;
  }

  function substitute(position: number, base: string) {
    const query = reference.slice(0, position - 1) + base + reference.slice(position);
    const mutation: Mutation = {
      type: 'substitution',
      position,
      ref_base: reference[position - 1],
      query_base: base,
    };
    return { mutation, query };
  }

  it('names the non-standard residue in the change, not X', () => {
    const { mutation, query } = substitute(5, 'G');
    const result = classifyMutation(mutation, reference, query, [gene], amberCode());
    expect(result.classification).toBe('missense');
    expect(result.amino_acid_change).toBe('pAzF2W');
  });

  it('does not call two different non-standard meanings synonymous because both read X', () => {
    const { mutation, query } = substitute(5, 'C');
    const code = amberCode({ TCG: { kind: 'unassigned' } });
    const result = classifyMutation(mutation, reference, query, [gene], code);
    expect(result.classification).not.toBe('synonymous');
    expect(result.amino_acid_change).toBe('pAzF2?');
  });

  it('reads a new TAG as the residue, not a premature stop', () => {
    const { mutation, query } = substitute(8, 'A');
    const result = classifyMutation(mutation, reference, query, [gene], amberCode());
    expect(result.classification).toBe('missense');
    expect(result.amino_acid_change).toBe('S3pAzF');
  });
});

describe('mutations where a codon both encodes and terminates', () => {
  const gene = (qualifiers: Record<string, string[]>) => ({
    name: 'reporter',
    type: 'CDS' as const,
    start: 1,
    end: 12,
    direction: 1 as const,
    qualifiers,
  });
  const sub = (position: number) => ({ type: 'substitution' as const, position });

  const ref = 'ATGAAACAGAAA';

  it('calls a new dual-function codon readthrough, not missense or nonsense', () => {
    const result = classifyMutation(sub(7), ref, 'ATGAAATAAAAA', [gene({ transl_table: ['28'] })]);
    expect(result.classification).toBe('readthrough');
  });

  it('still calls a plain new stop nonsense where nothing reads through it', () => {
    const result = classifyMutation(sub(7), ref, 'ATGAAATAGAAA', [gene({ transl_table: ['11'] })]);
    expect(result.classification).toBe('nonsense');
  });

  it('stops applying an exception once its codon is edited away', () => {
    const amber = gene({
      transl_table: ['11'],
      transl_except: ['(pos:7..9,aa:OTHER)'],
      note: ['p-azido-L-phenylalanine (pAzF)'],
    });
    const result = classifyMutation(sub(7), 'ATGAAATAGAAA', 'ATGAAACAGAAA', [amber]);
    expect(result.classification).toBe('missense');
    expect(result.amino_acid_change).toMatch(/pAzF/);
  });

  it('leaves an ordinary substitution alone', () => {
    const result = classifyMutation(sub(6), ref, 'ATGAAGCAGAAA', [gene({ transl_table: ['11'] })]);
    expect(result.classification).toBe('synonymous');
  });
});
