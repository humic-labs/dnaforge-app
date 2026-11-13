import { asSchema, zodSchema } from 'ai';
import type { z } from 'zod';
import type { RendererToolDefinition } from './renderer-tools';
import { rendererToolSdkInputSchema } from './catalog/types';

export function portableToolSchemaObject(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...portableSchema } = schema;
  return normalizeSchema(portableSchema);
}

function normalizeSchema(
  schema: Record<string, unknown>,
  localRoot?: string
): Record<string, unknown> {
  const result = { ...schema };
  if (localRoot && typeof result.$ref === 'string') {
    if (result.$ref === '#') result.$ref = localRoot;
    else if (result.$ref.startsWith('#/')) result.$ref = localRoot + result.$ref.slice(1);
  }
  const child = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? normalizeSchema(value as Record<string, unknown>, localRoot)
      : value;
  for (const key of [
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
  ]) {
    const value = result[key];
    if (value && typeof value === 'object' && !Array.isArray(value))
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, value]) => [name, child(value)])
      );
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(result[key])) result[key] = result[key].map(child);
  }
  if (Array.isArray(result.items)) {
    result.prefixItems = result.items.map(child);
    result.items = child(result.additionalItems ?? true);
    delete result.additionalItems;
  } else result.items = child(result.items);
  if (result.items === undefined) delete result.items;
  for (const key of [
    'additionalProperties',
    'unevaluatedProperties',
    'contains',
    'propertyNames',
    'not',
    'if',
    'then',
    'else',
  ]) {
    if (key in result) result[key] = child(result[key]);
  }
  return result;
}

export function rendererInputSchema(definition: RendererToolDefinition): Record<string, unknown> {
  const schema = portableToolSchemaObject(
    asSchema(rendererToolSdkInputSchema(definition)).jsonSchema as Record<string, unknown>
  );
  const requirement = definition.transportInputRequirement;
  if (!requirement) return schema;
  return {
    ...schema,
    [requirement.kind === 'exactly-one' ? 'oneOf' : 'anyOf']: requirement.fields.map((field) => ({
      required: [field],
    })),
  };
}

export function portableToolSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return portableToolSchemaObject(
    zodSchema(schema, { useReferences: true }).jsonSchema as Record<string, unknown>
  );
}

export function wrapRendererOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ok: { const: true }, result: normalizeSchema(schema, '#/properties/result') },
    required: ['ok', 'result'],
    additionalProperties: true,
  };
}
