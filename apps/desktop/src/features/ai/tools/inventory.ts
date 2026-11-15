import { asSchema, zodSchema } from 'ai';
import { z } from 'zod';
import {
  MAX_INVENTORY_BATCH_COMMANDS,
  inventoryCommandJsonSchema,
  parseInventoryCommandBatch,
} from '@waypoint/domain-services';
import { inventoryReceiptSchema } from '../../../shared/inventory-command';
import { jsonObjectSchema } from '../../../shared/json-value';
import { resultTool, toolFailure } from '../../agent-bridge/public/tool-result';

const project = z.string().min(1).max(4096);
const identity = z.string().min(1).max(256);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scope = { project, inventoryId: identity };
const plainInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('projects') }).strict(),
  z.object({ kind: z.literal('catalog'), project }).strict(),
  z
    .object({
      kind: z.literal('materials'),
      project,
      query: z.string().max(256),
      cursor: z.string().min(1).max(1024).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('inspect'), ...scope }).strict(),
  z.object({ kind: z.literal('availability'), ...scope }).strict(),
  z.object({ kind: z.literal('operation'), ...scope, operationId: identity }).strict(),
  z
    .object({
      kind: z.literal('history'),
      ...scope,
      afterRevision: revision.optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('execute'),
      ...scope,
      operationId: identity,
      expectedRevision: revision,
      commands: z.array(jsonObjectSchema).min(1).max(MAX_INVENTORY_BATCH_COMMANDS),
    })
    .strict(),
]);

export const inventoryAgentSchema = z
  .object({ operation: plainInput })
  .strict()
  .transform((input) => {
    if (input.operation.kind === 'execute')
      parseInventoryCommandBatch({
        expectedRevision: input.operation.expectedRevision,
        commands: input.operation.commands,
      });
    return input;
  });

export function inventoryAgentJsonSchema(): Record<string, unknown> {
  const schema = asSchema(
    zodSchema(z.object({ operation: plainInput }).strict(), { useReferences: false })
  ).jsonSchema;
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === 'commands'
          ? {
              type: 'array',
              minItems: 1,
              maxItems: MAX_INVENTORY_BATCH_COMMANDS,
              items: inventoryCommandJsonSchema(),
            }
          : replace(child),
      ])
    );
  };
  return replace(schema) as Record<string, unknown>;
}

const ok = { ok: z.literal(true) };
const material = z
  .object({ id: z.string(), name: z.string(), kind: z.string(), registryId: z.string().nullable() })
  .strict();
export const inventoryAgentOutputSchema = z.discriminatedUnion('kind', [
  z.object({ ...ok, kind: z.literal('catalog'), entries: z.array(jsonObjectSchema) }).strict(),
  z
    .object({
      ...ok,
      kind: z.literal('projects'),
      projects: z.array(
        z
          .object({
            projectId: z.string(),
            name: z.string(),
            path: z.string(),
            pinned: z.boolean(),
            defaultInventoryId: z.string(),
          })
          .strict()
      ),
    })
    .strict(),
  z
    .object({
      ...ok,
      kind: z.literal('materials'),
      page: z.object({ items: z.array(material), nextCursor: z.string().nullable() }).strict(),
    })
    .strict(),
  z.object({ ...ok, kind: z.literal('inspection'), state: jsonObjectSchema.nullable() }).strict(),
  z
    .object({ ...ok, kind: z.literal('availability'), availability: jsonObjectSchema.nullable() })
    .strict(),
  z.object({ ...ok, kind: z.literal('execution'), execution: inventoryReceiptSchema }).strict(),
  z
    .object({ ...ok, kind: z.literal('operation'), receipt: inventoryReceiptSchema.nullable() })
    .strict(),
  z
    .object({
      ...ok,
      kind: z.literal('history'),
      entries: z.array(
        z.object({ request: jsonObjectSchema, receipt: inventoryReceiptSchema }).strict()
      ),
    })
    .strict(),
]);

export const INVENTORY_DESCRIPTION =
  'Inspect and change physical laboratory inventory through the same native owner as the Inventory view. Start with projects, then materials in the exact selected project. Inspect the returned defaultInventoryId before changing it. Read catalog for built-in physical type and equipment recipe definitions without installing them. Existing definition ID conflicts require explicit resolution; never overwrite. Execute only needed definitions plus explicit recipe instantiation as one atomic batch. Read availability at the matching revision for exact on-hand, held and unreserved quantities, item custody, reservation actions and blocking reasons. Execute an atomic typed command batch with the inspected expectedRevision and one stable operationId. Exact retries return the original receipt; changed requests require a new explicitly reviewed operation. A timeout leaves the outcome unknown: inspect the original operationId or retry that identical request. Publish immutable physical type and equipment recipe versions, then instantiate explicit pinned versions. Physical metadata is separate from scientific material identity. Allowed child types constrain placement logically; unknown fit remains unknown, and known geometric contradictions refuse placement. Read the physical projection for installed configuration, metadata issues and fit evidence. Reservations do not subtract on-hand quantity. Expiry requires an explicit recorded command. Checkout, transit and missing reports free the previous position and retain immutable last-known location facts. Planned destinations and last-known positions are not current locations. Return or locate requires an explicit valid destination; use stack-top for a stack. A plate or box governs effective custody of its contents, and permanent wells cannot depart independently. Missing or in-transit items block physical use and additions; reconciliation and quality observations remain distinct. Custody never changes quantity or silently releases reservations. Hold ownership, custody responsibility and execution time come from the native authority. Known zero quantity differs from unknown quantity. Scientific designs do not imply physical possession. Placement, quantity, quality, disposal and storage-layout rules are validated by the inventory owner. History retains accepted requests, trusted actors and durable owner context. Read operations need read-workspace; execute also needs write-workspace.';

export function createInventoryTool() {
  return resultTool({
    description: INVENTORY_DESCRIPTION,
    inputSchema: inventoryAgentSchema,
    execute: async () =>
      toolFailure({
        code: 'INVENTORY_NATIVE_ROUTE_REQUIRED',
        error: 'Inventory agent actions require the authenticated native command route.',
        retriable: false,
        stateChanged: false,
        partialEffects: [],
      }),
  });
}
