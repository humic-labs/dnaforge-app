import { describe, expect, it } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { SequenceVariantCall } from '@waypoint/api-client';
import { buildStructureDrawerRequestFromCds } from '../structure-drawer/public/api/build-structure-request';
import { sha256Hex } from '../structure-drawer/public/api/protein-identity';
import { residueMeasurementSchema } from '../page/public/embeds/structure3d/residueMeasurement';
import { buildVariantProteinMeasurement } from './variant-protein-measurement';
import type { VariantAnalysis } from './variant-analysis';

const sequence = {
  name: 'reference',
  sequence: 'ATGAAAGGTTAA',
  circular: false,
  annotations: [{ id: 'cds', name: 'reporter', type: 'CDS', start: 1, end: 12, direction: 1 }],
} as AnnotatedSequence;
const request = buildStructureDrawerRequestFromCds({
  cds: sequence.annotations![0],
  sequence,
  entityId: 'document',
})!;
const call = (
  id: string,
  position: number,
  reference: string,
  alternate: string,
  count: number | null = 2,
  total: number | null = 10
): SequenceVariantCall => ({
  id,
  position,
  reference,
  alternate,
  allele_index: 1,
  quality: 50,
  filters: ['PASS'],
  genotype: '0/1',
  alternate_count: count,
  total_allele_count: total,
});
const analysis = (calls: SequenceVariantCall[]): VariantAnalysis => ({
  kind: 'sequence-variant-analysis',
  version: 1,
  documentId: 'document',
  name: 'sample',
  sourceLabel: 'sample.vcf',
  sourceIdentity: 'source:one',
  referenceSha256: sha256Hex(sequence.sequence),
  chrom: 'reference',
  sample: 'sample',
  countBasis: 'FORMAT/AD',
  calls,
  createdAt: 1,
});
const options = {
  name: 'Allele fraction',
  filter: 'pass-or-unfiltered' as const,
  effect: 'all' as const,
};
const build = (
  calls: SequenceVariantCall[],
  extra: Partial<Parameters<typeof buildVariantProteinMeasurement>[0]> = {}
) =>
  buildVariantProteinMeasurement({
    analysisId: 'analysis',
    analysis: analysis(calls),
    sequence,
    request,
    ...options,
    ...extra,
  });

describe('saved variant counts to protein measurement', () => {
  it('takes the largest allele fraction per residue without double counting reads', () => {
    const result = build([
      call('one', 4, 'A', 'G', 2, 10),
      call('two', 5, 'A', 'C', 3, 10),
      call('three', 7, 'G', 'A', 0, 10),
    ]);
    expect(result.values).toEqual([
      { residue: 2, value: 0.3 },
      { residue: 3, value: 0 },
    ]);
    expect(result.variantEvidence?.rows).toHaveLength(3);
    expect(result.variantEvidence?.sources[0]).toMatchObject({
      analysisId: 'analysis',
      sourceIdentity: 'source:one',
    });
    expect(result.variantEvidence?.aggregation).toBe('maximum');
  });
  it('keeps missing counts and absent before/after alleles unknown rather than zero', () => {
    expect(build([call('one', 4, 'A', 'G', null, null)]).values).toEqual([
      { residue: 2, value: null },
    ]);
    expect(build([call('one', 4, 'A', 'G'), call('two', 5, 'A', 'C', null, null)]).values).toEqual([
      { residue: 2, value: null },
    ]);
    const result = build([call('one', 4, 'A', 'G')], {
      baseline: { analysisId: 'before', analysis: analysis([call('other', 7, 'G', 'A')]) },
      pseudocount: 1,
    });
    expect(result.values).toEqual([
      { residue: 2, value: null },
      { residue: 3, value: null },
    ]);
  });
  it('derives a signed ratio from per-site counts and retains both sample identities', () => {
    const result = build(
      [call('after-a', 4, 'A', 'G', 9, 10), call('after-b', 7, 'G', 'A', 1, 10)],
      {
        baseline: {
          analysisId: 'before',
          analysis: {
            ...analysis([
              call('before-a', 4, 'A', 'G', 1, 10),
              call('before-b', 7, 'G', 'A', 9, 10),
            ]),
            sourceIdentity: 'source:before',
          },
        },
        pseudocount: 1,
      }
    );
    expect(result.values.map((row) => row.residue)).toEqual([2, 3]);
    expect(result.values[0].value).toBeCloseTo(Math.log2(5), 14);
    expect(result.values[1].value).toBeCloseTo(Math.log2(0.2), 14);
    expect(result.variantEvidence?.kind).toBe('vcf-log2-fraction-ratio');
    expect(result.variantEvidence?.sources.map((s) => s.analysisId)).toEqual([
      'analysis',
      'before',
    ]);
    const corrupted = structuredClone(result);
    corrupted.values[0].value = 0;
    expect(residueMeasurementSchema.safeParse(corrupted).success).toBe(false);
  });
  it('makes unfiltered evidence an explicit choice and preserves filtered omissions', () => {
    const result = build([
      { ...call('unfiltered', 4, 'A', 'G'), filters: [] },
      { ...call('failed', 7, 'G', 'A'), filters: ['LowQual'] },
    ]);
    expect(result.values).toEqual([{ residue: 2, value: 0.2 }]);
    expect(result.variantEvidence?.excluded).toContainEqual({
      analysisId: 'analysis',
      callId: 'failed',
      reason: 'filtered',
    });
    expect(() =>
      build([{ ...call('unfiltered', 4, 'A', 'G'), filters: [] }], { filter: 'pass' })
    ).toThrow(/No eligible/);
  });
  it('matches the selected coding feature, not an identical protein at another locus', () => {
    const duplicated = {
      ...sequence,
      sequence: sequence.sequence + sequence.sequence,
      annotations: [
        ...sequence.annotations!,
        { ...sequence.annotations![0], id: 'other', start: 13, end: 24 },
      ],
    };
    const result = build([call('one', 4, 'A', 'G'), call('other', 16, 'A', 'G', 9, 10)], {
      sequence: duplicated,
      analysis: {
        ...analysis([call('one', 4, 'A', 'G'), call('other', 16, 'A', 'G', 9, 10)]),
        referenceSha256: sha256Hex(duplicated.sequence),
      },
    });
    expect(result.values).toEqual([{ residue: 2, value: 0.2 }]);
  });
  it('refuses a stale reference, changed protein revision, and duplicate variant records', () => {
    expect(() =>
      build([call('one', 4, 'A', 'G')], { sequence: { ...sequence, sequence: 'ATGACAGGTTAA' } })
    ).toThrow(/reference changed/i);
    expect(() =>
      build([call('one', 4, 'A', 'G')], { request: { ...request, translation: 'MRG' } })
    ).toThrow(/protein|coding/i);
    expect(() => build([call('one', 4, 'A', 'G'), call('same', 4, 'A', 'G')])).toThrow(
      /duplicate/i
    );
  });
  it('does not map symbolic alleles or indels as substitutions', () => {
    const result = build([
      call('one', 4, 'A', 'G'),
      { ...call('symbolic', 7, 'G', '<DEL>'), unsupported_reason: 'symbolic allele' },
      call('deletion', 8, 'GT', 'G'),
    ]);
    expect(result.values).toEqual([{ residue: 2, value: 0.2 }]);
    expect(result.variantEvidence?.excluded).toHaveLength(2);
  });
  it('uses reverse-strand codons and excludes synonymous evidence only when requested', () => {
    const reverse = {
      ...sequence,
      sequence: 'TTAACCTTTCAT',
      annotations: [{ ...sequence.annotations![0], direction: -1 as const }],
    };
    const change = call('reverse', 8, 'T', 'C', 3, 12);
    const reverseRequest = buildStructureDrawerRequestFromCds({
      cds: reverse.annotations[0],
      sequence: reverse,
      entityId: 'document',
    })!;
    const measured = build([change], {
      sequence: reverse,
      request: reverseRequest,
      analysis: { ...analysis([change]), referenceSha256: sha256Hex(reverse.sequence) },
    });
    expect(measured.values).toEqual([{ residue: 2, value: 0.25 }]);
    const synonymous = call('synonymous', 6, 'A', 'G', 7, 10);
    const result = build([call('missense', 4, 'A', 'G', 2, 10), synonymous], {
      effect: 'amino-acid-changing',
    });
    expect(result.values).toEqual([{ residue: 2, value: 0.2 }]);
    expect(result.variantEvidence?.excluded).toContainEqual({
      analysisId: 'analysis',
      callId: 'synonymous',
      reason: 'synonymous',
    });
  });
  it('refuses impossible read totals and a mismatched baseline reference', () => {
    expect(() => build([call('invalid', 4, 'A', 'G', 11, 10)])).toThrow(/exceeds/);
    expect(() =>
      build([call('one', 4, 'A', 'G')], {
        baseline: {
          analysisId: 'before',
          analysis: { ...analysis([call('one', 4, 'A', 'G')]), referenceSha256: '0'.repeat(64) },
        },
      })
    ).toThrow(/reference changed/i);
  });
});

it('derives comparison measurements from the original reference identity', () => {
  const result = build([call('one', 4, 'A', 'G', 2, 10)], {
    request: { ...request, comparisonOf: request, identityRequestKey: 'comparison:distinct' },
  });
  expect(result.values).toEqual([{ residue: 2, value: 0.2 }]);
  expect(result.variantEvidence?.proteinFeatureKey).toBe(request.identityRequestKey);
});
