import { describe, expect, it } from 'vitest';

import {
  assertReferenceSemanticGroupIntegrityV1,
  reconcileReferenceMemberSemantics,
  type ReconcileReferenceMemberSemanticsInput,
} from './reference-semantics';

const BASE: Omit<ReconcileReferenceMemberSemanticsInput, 'sources'> = {
  chrom: 'chr1',
  sourceSeqId: 'NC_000001.11',
  lengthBp: 1_000,
  role: 'assembled-molecule',
  circular: false,
  moleculeClass: 'whole-chromosome',
};

describe('reconcileReferenceMemberSemantics', () => {
  it.each([
    ['centromere', 300, 400],
    ['SO:0000577', 300, 400],
    [' CENTROMERE ', 300, 400],
  ] as const)('normalizes GFF3 %s coordinates', (type, start, end) => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'gff3-features',
          evidenceId: 'gff',
          records: [{ type, start, end }],
        },
      ],
    });

    expect(result.morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 299, endBp: 400 },
      topology: 'internal',
    });
    expect(result.features).toContainEqual({
      type: 'centromere-region',
      interval: { startBp: 299, endBp: 400 },
      topology: 'internal',
      evidenceIds: ['gff'],
    });
  });

  it('normalizes an INSDC centromere but rejects fuzzy bounds', () => {
    expect(
      reconcileReferenceMemberSemantics({
        ...BASE,
        sources: [
          {
            kind: 'insdc-features',
            evidenceId: 'insdc',
            records: [{ key: 'centromere', start: 301, end: 400, locationStatus: 'exact' }],
          },
        ],
      }).morphology
    ).toEqual({
      kind: 'localized',
      interval: { startBp: 300, endBp: 400 },
      topology: 'internal',
    });

    expect(
      reconcileReferenceMemberSemantics({
        ...BASE,
        sources: [
          {
            kind: 'insdc-features',
            evidenceId: 'insdc',
            records: [{ key: 'centromere', start: 301, end: 400, locationStatus: 'fuzzy' }],
          },
        ],
      }).morphology
    ).toEqual({ kind: 'generic-contig', reason: 'ambiguous-evidence' });
  });

  it('normalizes only NCBI biological gaps explicitly typed as centromeres', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'ncbi-assembly-gaps',
          evidenceId: 'ncbi-gaps',
          records: [
            { gapType: 'telomere', start: 1, end: 100 },
            { gapType: 'centromere', start: 101, end: 250 },
            { gapType: 'heterochromatin', start: 251, end: 275 },
          ],
        },
      ],
    });

    expect(result.morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 100, endBp: 250 },
      topology: 'internal',
    });
  });

  it('merges adjoining UCSC acen pieces without retaining stain vocabulary', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'ucsc-cytobands',
          evidenceId: 'ucsc',
          records: [
            { start: 0, end: 300, stain: 'gneg' },
            { start: 300, end: 350, stain: 'acen' },
            { start: 350, end: 425, stain: 'acen' },
          ],
        },
      ],
    });

    expect(result.morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 300, endBp: 425 },
      topology: 'internal',
    });
  });

  it('deduplicates repeated equivalent rows and accumulates their evidence', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'gff3-features',
          evidenceId: 'producer-gff',
          records: [
            { type: 'centromere', start: 301, end: 400 },
            { type: 'centromere', start: 301, end: 400 },
          ],
        },
        {
          kind: 'insdc-features',
          evidenceId: 'feature-table',
          records: [{ key: 'centromere', start: 301, end: 400, locationStatus: 'exact' }],
        },
      ],
    });

    expect(result.features).toContainEqual({
      type: 'centromere-region',
      interval: { startBp: 300, endBp: 400 },
      topology: 'internal',
      evidenceIds: ['feature-table', 'producer-gff'],
    });
  });

  it('fails closed instead of averaging or selecting conflicting coordinates', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'gff3-features',
          evidenceId: 'left',
          records: [{ type: 'centromere', start: 201, end: 300 }],
        },
        {
          kind: 'ucsc-cytobands',
          evidenceId: 'right',
          records: [{ start: 700, end: 800, stain: 'acen' }],
        },
      ],
    });

    expect(result.morphology).toEqual({ kind: 'generic-contig', reason: 'conflicting-evidence' });
    expect(result.diagnostics).toContain('conflicting-centromere-regions');
  });

  it.each([
    [0, 100, 'terminal-start'],
    [900, 1_000, 'terminal-end'],
    [400, 500, 'internal'],
  ] as const)('classifies %s..%s as %s geometry', (start, end, topology) => {
    expect(
      reconcileReferenceMemberSemantics({
        ...BASE,
        sources: [
          {
            kind: 'ucsc-cytobands',
            evidenceId: 'geometry',
            records: [{ start, end, stain: 'acen' }],
          },
        ],
      }).morphology
    ).toEqual({ kind: 'localized', interval: { startBp: start, endBp: end }, topology });
  });

  it('applies reviewed terminal topology without changing the source interval', () => {
    expect(
      reconcileReferenceMemberSemantics({
        ...BASE,
        sources: [
          {
            kind: 'ncbi-assembly-gaps',
            evidenceId: 'mouse-gap-report',
            records: [{ gapType: 'centromere', start: 110_001, end: 3_000_000 }],
          },
          {
            kind: 'reviewed-centromere-topology',
            evidenceId: 'mouse-short-arm-adjudication',
            topology: 'terminal-start',
          },
        ],
        lengthBp: 195_154_279,
      }).morphology
    ).toEqual({
      kind: 'localized',
      interval: { startBp: 110_000, endBp: 3_000_000 },
      topology: 'terminal-start',
    });
  });

  it('admits a reviewed exact-assembly centromere region through the pure boundary', () => {
    expect(
      reconcileReferenceMemberSemantics({
        ...BASE,
        sources: [
          {
            kind: 'reviewed-centromere-region',
            evidenceId: 'assembly-paper',
            interval: { startBp: 300, endBp: 425 },
          },
        ],
      }).morphology
    ).toEqual({
      kind: 'localized',
      interval: { startBp: 300, endBp: 425 },
      topology: 'internal',
    });
  });

  it('normalizes adjoining NCBI p/q arms to a coordinate boundary without inventing width', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'ncbi-ideogram-arms',
          evidenceId: 'ncbi-ideogram',
          records: [
            { arm: 'p', start: 0, stop: 300 },
            { arm: 'q', start: 300, stop: 999 },
          ],
        },
      ],
    });

    expect(result.morphology).toEqual({
      kind: 'localized-boundary',
      positionBp: 300,
      topology: 'internal',
    });
    expect(result.features).toContainEqual({
      type: 'centromere-boundary',
      positionBp: 300,
      topology: 'internal',
      evidenceIds: ['ncbi-ideogram'],
    });
  });

  it('normalizes a full-span q arm to a terminal-start boundary', () => {
    expect(
      reconcileReferenceMemberSemantics({
        ...BASE,
        sources: [
          {
            kind: 'ncbi-ideogram-arms',
            evidenceId: 'ncbi-ideogram',
            records: [{ arm: 'q', start: 0, stop: 999 }],
          },
        ],
      }).morphology
    ).toEqual({ kind: 'localized-boundary', positionBp: 0, topology: 'terminal-start' });
  });

  it.each([
    [
      [
        { arm: 'p', start: 0, stop: 299 },
        { arm: 'q', start: 300, stop: 999 },
      ],
      'non-adjoining arms',
    ],
    [
      [
        { arm: 'p', start: 0, stop: 300 },
        { arm: 'p', start: 0, stop: 325 },
        { arm: 'q', start: 300, stop: 999 },
      ],
      'multiple p arms',
    ],
    [[{ arm: 'q', start: 25, stop: 999 }], 'partial single arm'],
  ] as const)('fails closed for ambiguous NCBI ideogram evidence: %s', (records, _label) => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [{ kind: 'ncbi-ideogram-arms', evidenceId: 'ncbi-ideogram', records }],
    });

    expect(result.morphology).toEqual({ kind: 'generic-contig', reason: 'ambiguous-evidence' });
    expect(result.diagnostics).toContain('ambiguous-centromere-boundary');
  });

  it.each([
    ['metacentric', 'start'],
    ['submetacentric', 'start'],
    ['acrocentric', 'start'],
    ['telocentric', 'start'],
    ['acrocentric', 'end'],
  ] as const)(
    'keeps reviewed %s morphology as an explicitly non-positional schematic',
    (centromereClass, shortArmAt) => {
      const result = reconcileReferenceMemberSemantics({
        ...BASE,
        sources: [
          {
            kind: 'reviewed-cytogenetic-morphology',
            evidenceId: 'exact-assembly-ideogram',
            centromereClass,
            shortArmAt,
          },
        ],
      });

      expect(result.morphology).toEqual({ kind: 'schematic', centromereClass, shortArmAt });
      expect(result.features).toEqual([]);
      expect(result.properties).toEqual([
        {
          type: 'centromere-architecture',
          value: 'localized',
          evidenceIds: ['exact-assembly-ideogram'],
        },
      ]);
    }
  );

  it('fails closed when reviewed cytogenetic morphology assertions disagree', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'reviewed-cytogenetic-morphology',
          evidenceId: 'first-ideogram',
          centromereClass: 'acrocentric',
          shortArmAt: 'start',
        },
        {
          kind: 'reviewed-cytogenetic-morphology',
          evidenceId: 'second-ideogram',
          centromereClass: 'submetacentric',
          shortArmAt: 'start',
        },
      ],
    });

    expect(result.morphology).toEqual({ kind: 'generic-contig', reason: 'conflicting-evidence' });
    expect(result.diagnostics).toContain('conflicting-cytogenetic-morphology');
  });

  it('fails closed when reviewed topology assertions disagree', () => {
    expect(
      reconcileReferenceMemberSemantics({
        ...BASE,
        sources: [
          {
            kind: 'gff3-features',
            evidenceId: 'coordinate',
            records: [{ type: 'centromere', start: 301, end: 400 }],
          },
          {
            kind: 'reviewed-centromere-topology',
            evidenceId: 'one',
            topology: 'terminal-start',
          },
          {
            kind: 'reviewed-centromere-topology',
            evidenceId: 'two',
            topology: 'terminal-end',
          },
        ],
      }).morphology
    ).toEqual({ kind: 'generic-contig', reason: 'conflicting-evidence' });
  });

  it('projects a reviewed holocentric assertion without fabricating a pinch', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'reviewed-architecture',
          evidenceId: 'celegans-primary-literature',
          value: 'holocentric',
        },
      ],
    });

    expect(result.morphology).toEqual({ kind: 'holocentric' });
    expect(result.properties).toEqual([
      {
        type: 'centromere-architecture',
        value: 'holocentric',
        evidenceIds: ['celegans-primary-literature'],
      },
    ]);
  });

  it.each(['acentric', 'unsupported'] as const)(
    'fails closed for reviewed %s architecture',
    (value) => {
      expect(
        reconcileReferenceMemberSemantics({
          ...BASE,
          sources: [{ kind: 'reviewed-architecture', evidenceId: value, value }],
        }).morphology
      ).toEqual({
        kind: 'generic-contig',
        reason: value === 'acentric' ? 'acentric' : 'unsupported-architecture',
      });
    }
  );

  it('projects a split chromosome arm to its real adjoining-member boundary', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      chrom: 'chr2L',
      sourceSeqId: '2L',
      moleculeClass: 'chromosome-arm',
      sources: [
        {
          kind: 'reviewed-chromosome-arm',
          evidenceId: 'flybase-r6',
          groupId: 'chr2',
          segmentIndex: 0,
          orientation: 'telomere-to-centromere',
        },
      ],
    });

    expect(result.chromosomeGroup).toEqual({
      id: 'chr2',
      segmentIndex: 0,
      orientation: 'telomere-to-centromere',
    });
    expect(result.morphology).toEqual({ kind: 'between-members', groupId: 'chr2', side: 'right' });
  });

  it('normalizes origin aliases as an extensibility proof without affecting morphology', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'gff3-features',
          evidenceId: 'origin-gff',
          records: [{ type: 'SO:0000296', start: 501, end: 525 }],
        },
        {
          kind: 'insdc-features',
          evidenceId: 'origin-insdc',
          records: [{ key: 'rep_origin', start: 501, end: 525, locationStatus: 'exact' }],
        },
      ],
    });

    expect(result.features).toContainEqual({
      type: 'origin-of-replication',
      interval: { startBp: 500, endBp: 525 },
      evidenceIds: ['origin-gff', 'origin-insdc'],
    });
    expect(result.morphology).toEqual({ kind: 'generic-contig', reason: 'missing-semantics' });
  });

  it('keeps a reviewed whole chromosome rounded when its localized centromere position is unresolved', () => {
    const result = reconcileReferenceMemberSemantics({
      ...BASE,
      sources: [
        {
          kind: 'reviewed-architecture',
          evidenceId: 'reviewed-monocentric-chromosome',
          value: 'localized',
        },
      ],
    });

    expect(result.properties).toEqual([
      {
        type: 'centromere-architecture',
        value: 'localized',
        evidenceIds: ['reviewed-monocentric-chromosome'],
      },
    ]);
    expect(result.features).toEqual([]);
    expect(result.morphology).toEqual({ kind: 'unlocalized-centromere' });

    expect(
      reconcileReferenceMemberSemantics({
        ...BASE,
        moleculeClass: 'chromosome-arm',
        sources: [
          {
            kind: 'reviewed-architecture',
            evidenceId: 'reviewed-monocentric-arm',
            value: 'localized',
          },
        ],
      }).morphology
    ).toEqual({ kind: 'generic-contig', reason: 'missing-semantics' });
  });

  it.each([
    ['mitochondrion', false, 'organelle'],
    ['assembled-molecule', true, 'whole-chromosome'],
    ['unplaced-scaffold', false, 'scaffold'],
    ['unlocalized-scaffold', false, 'scaffold'],
    ['other', false, 'generic-contig'],
  ] as const)(
    'fails closed for %s members even with centromere evidence',
    (role, circular, moleculeClass) => {
      expect(
        reconcileReferenceMemberSemantics({
          ...BASE,
          role,
          circular,
          moleculeClass,
          sources: [
            {
              kind: 'gff3-features',
              evidenceId: 'ineligible',
              records: [{ type: 'centromere', start: 301, end: 400 }],
            },
          ],
        }).morphology
      ).toEqual({ kind: 'generic-contig', reason: 'ineligible-member' });
    }
  );

  it('fails closed when multiple architecture assertions disagree', () => {
    expect(
      reconcileReferenceMemberSemantics({
        ...BASE,
        sources: [
          { kind: 'reviewed-architecture', evidenceId: 'one', value: 'holocentric' },
          { kind: 'reviewed-architecture', evidenceId: 'two', value: 'localized' },
        ],
      }).morphology
    ).toEqual({ kind: 'generic-contig', reason: 'conflicting-evidence' });
  });
});

describe('assertReferenceSemanticGroupIntegrityV1', () => {
  const arm = (
    chrom: string,
    segmentIndex: number,
    orientation: 'telomere-to-centromere' | 'centromere-to-telomere'
  ) =>
    reconcileReferenceMemberSemantics({
      ...BASE,
      chrom,
      sourceSeqId: chrom,
      moleculeClass: 'chromosome-arm',
      sources: [
        {
          kind: 'reviewed-chromosome-arm',
          evidenceId: 'arm-map',
          groupId: 'chr2',
          segmentIndex,
          orientation,
        },
      ],
    });
  const pair = [
    arm('chr2L', 0, 'telomere-to-centromere'),
    arm('chr2R', 1, 'centromere-to-telomere'),
  ];

  it('admits exactly one adjacent, correctly oriented arm pair', () => {
    expect(() => assertReferenceSemanticGroupIntegrityV1(pair)).not.toThrow();
  });

  it('rejects incomplete and non-adjacent arm groups', () => {
    expect(() => assertReferenceSemanticGroupIntegrityV1(pair.slice(0, 1))).toThrow(
      /complete adjacent pair/i
    );
    expect(() =>
      assertReferenceSemanticGroupIntegrityV1([
        pair[0],
        reconcileReferenceMemberSemantics({
          ...BASE,
          chrom: 'unrelated',
          sourceSeqId: 'unrelated',
          sources: [],
        }),
        pair[1],
      ])
    ).toThrow(/complete adjacent pair/i);
  });
});
