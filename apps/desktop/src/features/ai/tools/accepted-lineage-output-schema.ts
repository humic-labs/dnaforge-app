import { z } from 'zod';
import { jsonObjectSchema } from '../../../shared/json-value';

const id = z.string();
const nullableText = z.string().nullable();
const count = z.number().int().nonnegative();
const range = z
  .object({ start: z.number(), end: z.number(), wraps: z.boolean().optional() })
  .strict();
const segment = range
  .extend({
    strand: z.enum(['forward', 'reverse', 'none']).optional(),
    role: z.enum([
      'included-template',
      'included-spacer',
      'source-flank',
      'restriction-scar',
      'primer-tail',
      'primer-binding-site',
    ]),
  })
  .strict();
const node = z.union([
  z
    .object({ id, kind: z.literal('construct'), constructId: id, packageId: id, name: z.string() })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('draft_revision'),
      designId: id,
      designVersion: count.optional(),
      canonicalDraftChecksum: id.optional(),
      parentAcceptedAssemblyVersionId: id.optional(),
      reopenIdempotencyKey: nullableText.optional(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('accepted_assembly_version'),
      acceptedAssemblyVersionId: id,
      acceptedAt: id,
      acceptedBy: nullableText,
      lifecycleState: z.enum([
        'draft',
        'accepted',
        'writing',
        'written',
        'write_failed',
        'reopen_conflict',
      ]),
      canonicalDraftChecksum: id,
      validationClean: z.boolean(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('product_sequence_version'),
      constructId: id,
      versionId: id,
      checksum: id,
      genBankChecksum: nullableText,
      topology: z.enum(['linear', 'circular']),
      length: count,
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('source_sequence_version'),
      constructId: nullableText,
      versionId: nullableText,
      sourceSequenceId: id,
      name: z.string(),
      checksum: nullableText,
      length: count.nullable(),
      topology: z.enum(['linear', 'circular']).nullable(),
      identityStatus: z.enum(['stable', 'legacy-locator']),
      freshness: z.enum(['current', 'source_outdated', 'unknown']),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('artifact'),
      artifactKind: z.enum(['product_genbank', 'accepted_record', 'primer_csv', 'primer_fasta']),
      checksum: nullableText,
    })
    .strict(),
]);
const edge = z
  .object({
    id,
    kind: z.enum([
      'revision_of',
      'reopened_from',
      'accepted_from_draft',
      'uses_source_version',
      'produces_product_version',
      'has_artifact',
    ]),
    from: id,
    to: id,
    regionId: id.optional(),
    sourceType: z.enum(['pcr', 'restriction-digest']).optional(),
    copiedDirection: z.enum(['forward', 'reverse-complement']).optional(),
    selectedSourceRange: range.optional(),
    includedSourceSegments: z.array(segment).optional(),
  })
  .strict();

                                                                                               
export const acceptedLineageSchema = z
  .object({
    schemaVersion: z.literal(1),
    rootConstructId: id,
    acceptedAssemblyVersionId: id,
    nodes: z.array(node),
    edges: z.array(edge),
    catalogEvents: z.array(
      z
        .object({
          id,
          eventType: id,
          actor: id,
          summary: nullableText,
          payload: jsonObjectSchema.nullable(),
          createdAt: z.number(),
        })
        .strict()
    ),
    warnings: z.array(
      z
        .object({
          code: z.enum(['legacy_source_identity', 'missing_source_checksum']),
          message: z.string(),
          regionId: id,
        })
        .strict()
    ),
  })
  .strict();
