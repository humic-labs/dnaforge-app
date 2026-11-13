import { z } from 'zod';
import { ActionNameSchema, DescriptorMetadataSchema, EntityRefSchema } from './common.ts';

export const ProvenanceSourceSchema = z.object({
  entity: EntityRefSchema,
  role: z.enum(['parent', 'template', 'primer', 'fragment', 'reference']),
  externalId: z.string().optional().describe('e.g. GenBank accession, UniProt ID'),
});
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

export const ProvenanceRecordAssertionSchema = z.object({
  derivedEntity: EntityRefSchema,
  derivationKind: z.enum(['cloning', 'pcr', 'assembly', 'mutation', 'import', 'translation']),
  sources: z.array(ProvenanceSourceSchema).min(1, {
    message:
      'A ProvenanceRecord must list at least one source — purely synthetic outputs use kind=import with a single literal source.',
  }),
  actionName: ActionNameSchema.describe('domain.verb of the action that produced the entity.'),
  attachedAtFieldExists: z.boolean().default(true),
});
export type ProvenanceRecordAssertion = z.infer<typeof ProvenanceRecordAssertionSchema>;

export const ProvenanceEvalDescriptorSchema = DescriptorMetadataSchema.extend({
  kind: z.literal('provenance'),
  actionName: ActionNameSchema,
  input: z.unknown(),
  expectedProvenance: ProvenanceRecordAssertionSchema,
});
export type ProvenanceEvalDescriptor = z.infer<typeof ProvenanceEvalDescriptorSchema>;
