import { z } from 'zod';
import { jsonObjectSchema } from '../../../shared/json-value';

export const externalFetchPayloadSchema = z.object({
  external_resource_id: z.string(), provider: z.string(), external_id: z.string(), cache_hit: z.boolean(),
  license: z.string().nullable(), attribution: z.string().nullable(), metadata: jsonObjectSchema,
  xref_count: z.number().int().nonnegative(), binding_id: z.string().nullable().optional(),
  agent_artifact_id: z.string().nullable().optional(),
});
export const externalFetchOutputSchema = externalFetchPayloadSchema.extend({ok: z.literal(true), status: z.number().int()});
const xref = z.object({
  from_resource_id: z.string(), to_resource_id: z.string(), xref_type: z.string(),
  evidence: z.string().nullable().optional(), confidence: z.number().nullable().optional(),
  source_provider: z.string().nullable().optional(), version: z.string().nullable().optional(),
  identity: z.number().nullable().optional(), coverage: z.number().nullable().optional(),
  alignment_coords: jsonObjectSchema.nullable().optional(), metadata: jsonObjectSchema.nullable().optional(),
});
export const externalXrefPayloadSchema = z.object({resource_id: z.string(), target_provider: z.string().nullable().optional(),
  xrefs: z.array(xref), total: z.number().int().nonnegative()});
export const externalXrefOutputSchema = externalXrefPayloadSchema.omit({target_provider: true}).extend({ok: z.literal(true), status: z.number().int()});
