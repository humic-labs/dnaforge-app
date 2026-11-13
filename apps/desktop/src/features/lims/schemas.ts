import { z } from 'zod';
import {
  LIMS_BUILTIN_SCHEMAS,
  LIMS_ENTITY_KINDS,
  parseLimsSchemaFields,
  validateLimsEntityFields,
  type LimsBuiltinSchemaDefinition,
  type LimsSchemaKind,
} from '../../shared/lims';

export const limsFieldTypeSchema = z.enum([
  'text',
  'long_text',
  'number',
  'boolean',
  'enum',
  'date',
  'dna_sequence',
  'rna_sequence',
  'protein_sequence',
  'quantity',
  'record_relationship',
  'attachment_reference',
  'formula_result',
  'string_array',
  'genetic_code',
]);

export const limsFieldDefinitionSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    label: z.string().min(1),
    type: limsFieldTypeSchema,
    required: z.boolean().optional(),
    suggested: z.boolean().optional(),
    enumOptions: z.array(z.string().min(1)).optional(),
    maxLength: z.number().int().positive().optional(),
    minValue: z.number().finite().optional(),
    maxValue: z.number().finite().optional(),
    minDate: z.string().datetime({ offset: true }).optional(),
    maxDate: z.string().datetime({ offset: true }).optional(),
    description: z.string().optional(),
    requireResolved: z.boolean().optional(),
    intrinsic: z.enum(['sequence.length', 'sequence.topology', 'sequence.geneticCode']).optional(),
    readOnly: z.boolean().optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'enum' && (!field.enumOptions || field.enumOptions.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['enumOptions'],
        message: 'enum fields require enumOptions',
      });
    }
    if (field.required && field.suggested) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suggested'],
        message: 'required fields cannot also be suggested optionals',
      });
    }
    if (
      field.minValue !== undefined &&
      field.maxValue !== undefined &&
      field.minValue > field.maxValue
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxValue'],
        message: 'maxValue must be greater than or equal to minValue',
      });
    }
    if (
      field.minDate !== undefined &&
      field.maxDate !== undefined &&
      Date.parse(field.minDate) > Date.parse(field.maxDate)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxDate'],
        message: 'maxDate must be on or after minDate',
      });
    }
  });

export const limsRelationshipTypeDefinitionSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  inverseName: z.string().optional(),
  fromKindHint: z.union([z.enum(LIMS_ENTITY_KINDS), z.literal('any')]).optional(),
  toKindHint: z.union([z.enum(LIMS_ENTITY_KINDS), z.literal('any')]).optional(),
  cardinality: z.enum(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']),
  directional: z.boolean(),
  description: z.string().min(1),
  ontologyMapping: z.string().optional(),
  builtin: z.boolean(),
});

const LIMS_SCHEMA_KINDS = ['entity', 'relationship_type'] as [LimsSchemaKind, LimsSchemaKind];

export const limsSchemaDefinitionSchema = z.object({
  kind: z.enum(LIMS_SCHEMA_KINDS),
  name: z.string().min(1),
  baseKind: z.string().min(1).optional(),
  version: z.number().int().positive().optional(),
  displayName: z.string().min(1),
  description: z.string().min(1),
  builtin: z.boolean(),
  fields: z.array(limsFieldDefinitionSchema),
  relationship: limsRelationshipTypeDefinitionSchema.optional(),
});

export function assertBuiltinSchemasAreMetaValid(
  schemas: readonly LimsBuiltinSchemaDefinition[] = LIMS_BUILTIN_SCHEMAS
): void {
  for (const schema of schemas) {
    limsSchemaDefinitionSchema.parse(schema);
  }
}

export function validateEntityInstanceFromFieldsJson(
  kind: string,
  fields: Record<string, unknown>,
  schemaFieldsJson: string
): string[] {
  const definition = parseLimsSchemaFields(schemaFieldsJson);
  return validateLimsEntityFields(kind, fields, definition.fields, definition.baseKind);
}
