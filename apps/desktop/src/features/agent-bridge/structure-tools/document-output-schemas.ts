import { z } from 'zod';
import { jsonObjectSchema, jsonValueSchema } from '../../../shared/json-value';
import { molecularDocumentOwnerSchema } from '../../../shared/molecular-document-owner';
import { molecularDocumentReferenceSchema } from '../../../shared/molecular-document-reference';

const count = z.number().int().nonnegative();
export const molecularDocumentBindingOutputFields = {
  documentOwner: molecularDocumentOwnerSchema,
  documentReference: molecularDocumentReferenceSchema.optional(),
};

export const molecularDocumentParametersOutputSchema = z.object({
  schema: z.literal('dnaforge.molecular-document-parameters.v1'),
  sceneSha256: z.string().regex(/^[a-f0-9]{64}$/),
  valueSchemaDialect: z.literal('https://json-schema.org/draft/2020-12/schema'),
  validation: z.string(),
  parameters: z.array(
    z.object({
      path: z.string(),
      nodeKind: z.string(),
      nodeRef: z.string().optional(),
      viewId: z.string().optional(),
      name: z.string(),
      value: jsonValueSchema.optional(),
      required: z.boolean(),
      default: jsonValueSchema.optional(),
      description: z.string(),
      valueSchema: jsonObjectSchema,
    })
  ),
  total: count,
  nextOffset: count.nullable(),
  write: z.object({
    tool: z.literal('mol_apply_scene'),
    fields: z.array(z.enum(['parameterEdits', 'expectedSceneSha256'])),
    atomic: z.literal(true),
    effectiveValueContract: z.string(),
  }),
  dataColor: z.object({
    tool: z.literal('mol_data'),
    operations: z.array(z.enum(['inspect', 'publish', 'apply'])),
    retains: z.array(z.string()),
  }),
});
