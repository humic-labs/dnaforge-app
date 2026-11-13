import { z } from 'zod';

const countSnapshot = z
  .object({
    callId: z.string().min(1),
    dnaPosition: z.number().int().positive(),
    reference: z.string().min(1),
    alternate: z.string().min(1),
    alleleIndex: z.number().int().positive(),
    alternateCount: z.number().int().nonnegative().nullable(),
    totalAlleleCount: z.number().int().nonnegative().nullable(),
    filters: z.array(z.string()),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      row.alternateCount !== null &&
      row.totalAlleleCount !== null &&
      row.alternateCount > row.totalAlleleCount
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Alternate count exceeds total allele count.',
      });
  });
export const variantMeasurementEvidenceSchema = z
  .object({
    kind: z.enum(['vcf-allele-fraction', 'vcf-log2-fraction-ratio']),
    referenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    proteinFeatureKey: z.string().min(1),
    filter: z.enum(['pass', 'pass-or-unfiltered', 'all']),
    effect: z.enum(['all', 'amino-acid-changing']),
    aggregation: z.enum(['maximum', 'maximum-absolute']),
    pseudocount: z.number().finite().positive().optional(),
    sources: z
      .array(
        z
          .object({
            analysisId: z.string().min(1),
            name: z.string(),
            sourceIdentity: z.string().min(1),
            sample: z.string(),
            countBasis: z.string(),
          })
          .strict()
      )
      .min(1)
      .max(2),
    rows: z
      .array(
        z
          .object({
            residue: z.number().int().positive(),
            observed: countSnapshot.nullable(),
            baseline: countSnapshot.nullable(),
          })
          .strict()
      )
      .min(1)
      .max(10000),
    excluded: z
      .array(z.object({ analysisId: z.string(), callId: z.string(), reason: z.string() }).strict())
      .max(10000),
  })
  .strict()
  .superRefine((evidence, context) => {
    const ratio = evidence.kind === 'vcf-log2-fraction-ratio';
    if (
      evidence.sources.length !== (ratio ? 2 : 1) ||
      (ratio && !evidence.pseudocount) ||
      (!ratio && evidence.pseudocount !== undefined) ||
      evidence.aggregation !== (ratio ? 'maximum-absolute' : 'maximum')
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Variant signal recipe does not match its sources and aggregation.',
      });
    for (const row of evidence.rows) {
      if ((!row.observed && !row.baseline) || (!ratio && (!row.observed || row.baseline)))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A variant signal row needs its original allele evidence.',
        });
      if (
        row.observed &&
        row.baseline &&
        (row.observed.dnaPosition !== row.baseline.dnaPosition ||
          row.observed.reference !== row.baseline.reference ||
          row.observed.alternate !== row.baseline.alternate)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Before and after counts must describe the same DNA allele.',
        });
    }
  });
export type VariantMeasurementEvidence = z.infer<typeof variantMeasurementEvidenceSchema>;

export function variantSignalValues(evidence: VariantMeasurementEvidence) {
  const values = new Map<number, Array<number | null>>();
  const ratio = evidence.kind === 'vcf-log2-fraction-ratio';
  const fraction = (row: VariantMeasurementEvidence['rows'][number]['observed']) => {
    if (
      !row ||
      row.alternateCount === null ||
      row.totalAlleleCount === null ||
      row.totalAlleleCount === 0
    )
      return null;
    const p = ratio ? evidence.pseudocount! : 0;
    return (row.alternateCount + p) / (row.totalAlleleCount + 2 * p);
  };
  for (const row of evidence.rows) {
    const after = fraction(row.observed),
      before = ratio ? fraction(row.baseline) : null;
    const value = ratio
      ? after === null || before === null
        ? null
        : Math.log2(after / before)
      : after;
    values.set(row.residue, [...(values.get(row.residue) ?? []), value]);
  }
  return [...values]
    .sort(([a], [b]) => a - b)
    .map(([residue, points]) => ({
      residue,
      value: points.some((p) => p === null)
        ? null
        : (points as number[]).reduce((best, value) =>
            evidence.aggregation === 'maximum'
              ? Math.max(best, value)
              : Math.abs(value) > Math.abs(best) ||
                  (Math.abs(value) === Math.abs(best) && value > best)
                ? value
                : best
          ),
    }));
}
