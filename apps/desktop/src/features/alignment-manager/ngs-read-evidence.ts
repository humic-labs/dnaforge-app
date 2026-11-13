import { z } from 'zod';
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const ngsReadEvidenceSchema = z.object({
  documentId: z.string(),
  inputRevision: z.string(),
  sourceLabel: z.string(),
  sourceSha256: hash,
  referenceSha256: hash,
  totalReads: z.number().int().nonnegative(),
  totalBases: z.number().int().nonnegative(),
  mappedReads: z.number().int().nonnegative(),
  unmappedReads: z.number().int().nonnegative(),
  mappingQualityReads: z.number().int().nonnegative(),
  coverage: z.array(z.number().int().nonnegative()).max(250000),
  circularMethod: z.enum(['linear', 'two-origins-central-half']),
  settings: z
    .object({
      documentId: z.string(),
      readPath: z.string(),
      referenceSequence: z.string(),
      isCircular: z.boolean(),
      preset: z.enum(['sr', 'map-ont', 'lr:hq', 'map-hifi']),
      minBaseQuality: z.number(),
      minMappingQuality: z.number(),
      minDepth: z.number(),
      minAlternateCount: z.number(),
      minAlleleFraction: z.number(),
      threads: z.number(),
    })
    .strict(),
  versions: z.record(z.string()),
  commands: z.array(z.array(z.string())),
  artifacts: z
    .array(
      z
        .object({
          originOffset: z.number().int().nonnegative(),
          alignmentPath: z.string(),
          referencePath: z.string(),
          pileupPath: z.string(),
          alignmentSha256: hash,
          pileupSha256: hash,
        })
        .strict()
    )
    .max(2),
  excludedAlleles: z.number().int().nonnegative(),
  countBasis: z.string(),
});
export const savedNgsReadEvidenceSchema = ngsReadEvidenceSchema
  .extend({ operationId: z.string() })
  .strict();
export type NgsReadEvidence = z.infer<typeof savedNgsReadEvidenceSchema>;
