import { asSchema, zodSchema } from 'ai';
import { z } from 'zod';
import {
  MAX_INVENTORY_BATCH_COMMANDS,
  inventoryCommandJsonSchema,
  parseInventoryCommandBatch,
} from '@waypoint/domain-services';
import {
  inventoryCatalogUpdatePreviewRequestSchema,
  inventoryResolveItemCodeRequestSchema,
  inventoryPrepareLabelRequestSchema,
  inventoryStorageConditionsRequestSchema,
  inventoryReceiptSchema,
  inventoryExportSnapshotRequestSchema,
  inventoryPreviewImportRequestSchema,
  inventoryApplyImportRequestSchema,
  inventoryPreviewTableRequestSchema,
  inventoryApplyTableRequestSchema,
} from '../../../shared/inventory-command';
import { jsonObjectSchema } from '../../../shared/json-value';
import { resultTool, toolFailure } from '../../agent-bridge/public/tool-result';

const project = z.string().min(1).max(4096);
const identity = z.string().min(1).max(256);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scope = { project, inventoryId: identity };
const plainInput = z.discriminatedUnion('kind', [
  inventoryPreviewTableRequestSchema.extend({ kind: z.literal('preview-table') }).strict(),
  inventoryApplyTableRequestSchema.extend({ kind: z.literal('apply-table') }).strict(),
  inventoryExportSnapshotRequestSchema.extend({ kind: z.literal('export-snapshot') }).strict(),
  inventoryPreviewImportRequestSchema.extend({ kind: z.literal('preview-import') }).strict(),
  inventoryApplyImportRequestSchema.extend({ kind: z.literal('apply-import') }).strict(),
  z.object({ kind: z.literal('projects') }).strict(),
  z.object({ kind: z.literal('catalog'), project }).strict(),
  inventoryCatalogUpdatePreviewRequestSchema
    .extend({ kind: z.literal('catalog-update-preview') })
    .strict(),
  inventoryResolveItemCodeRequestSchema.extend({ kind: z.literal('resolve-item-code') }).strict(),
  inventoryPrepareLabelRequestSchema.extend({ kind: z.literal('prepare-label') }).strict(),
  inventoryStorageConditionsRequestSchema
    .extend({ kind: z.literal('storage-conditions') })
    .strict(),
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
  z.object({ ...ok, kind: z.literal('table-preview'), preview: jsonObjectSchema }).strict(),
  z.object({ ...ok, kind: z.literal('export-snapshot'), artifact: jsonObjectSchema }).strict(),
  z.object({ ...ok, kind: z.literal('import-preview'), preview: jsonObjectSchema }).strict(),
  z.object({ ...ok, kind: z.literal('catalog'), entries: z.array(jsonObjectSchema) }).strict(),
  z
    .object({ ...ok, kind: z.literal('catalog-update-preview'), preview: jsonObjectSchema })
    .strict(),
  z.object({ ...ok, kind: z.literal('item-code-resolution'), lookup: jsonObjectSchema }).strict(),
  z.object({ ...ok, kind: z.literal('label-artifact'), artifact: jsonObjectSchema }).strict(),
  z.object({ ...ok, kind: z.literal('storage-conditions'), conditions: jsonObjectSchema }).strict(),
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
  'Preview a strict canonical receive table with preview-table, format receive-v1 and exact sourceText. Supply a stable source namespace, explicit comma or tab delimiter, material/location/existing-vessel bindings and reason-bearing skipped source IDs. The required columns are source_id,name,material_key,quantity_kind,quantity,unit,quality,vessel_kind,vessel_key,location_key,slot. Every column must appear exactly once; no inferred headers, values, units, scientific identities, unplaced choice or silent extra columns. A new vessel requires a name and explicit location key; an existing empty vessel or permanent well requires its bound vessel key and blank name/location/slot fields. Known zero differs from explicit unknown quantity. Preview reports every source row, proposed commands and blocking issues without writes. Stable namespace plus exact source_id prevents duplicates when rows reorder or the file changes. Unchanged imported rows remain unchanged even after later consumption or movement; changed source facts or resolutions require reconciliation and refuse. Apply only a ready preview with apply-table, its exact sourceText, resolved options/fingerprints, expectedPlanDigest, expectedRevision and one stable operationId. All generated commands and source bindings commit atomically under the existing 256-command limit; never split silently. An uncertain result must recover or retry that exact operation. This format does not imply Benchling header compatibility or stocktake correction support. ' +
  'Export a lossless native inventory archive with export-snapshot and format native-v1. It captures one admitted state and complete accepted history without changing inventory or writing a file. Preview an exact sourceText using preview-import and options.bindings [{sourceMaterialId,destinationMaterialId}]. Preview is read-only; it reports source-linked refusals, exact scientific bindings, responsibilities and proposed identities. Only a ready preview supplies complete resolved options with fingerprints and a planDigest. Apply into an absent inventory with apply-import, the identical sourceText, those resolved options, expectedPlanDigest, expectedRevision and one stable operationId. Reuse the original operation or exact request after an uncertain result before creating a new intent. Adoption creates destination records under the current native receipt; imported source history remains evidence. Imported holders never gain current authority by matching an agent ID; source clocks cannot advance native acceptance. No populated-target merging, automatic scientific identity matching, silent chunking or spreadsheet/Benchling compatibility is implied. ' +
  'Read storage-conditions in an explicit project and inventory with required freshnessMaxAgeMs null for no age policy or a nonnegative safe integer in milliseconds. This read returns separate specified capability, operator-reported target and installed qualified-support assessments at one native revision and asOf time. Reported setpoints are not sensor measurements, and a supported temperature assessment is not overall sample suitability. Record the thermal relationship independently with record-thermal-context: inherit uses surroundings, self declares own temperature control, and unknown blocks inheritance. Evidence, withdrawal and reports never change this relationship. New qualified-envelope assertions declare scope physical-and-thermal-arrangement; legacy qualifications with unrecorded thermal scope remain inapplicable. Unknowns, conflicts, source scope and freshness remain explicit. It never changes stock, quality, holds, custody or placement. Record temperature claims, setpoints and stock/lot requirements only through execute with explicit observation time (timestamp or null); trusted recorded time and actor come from the native owner. ' +
  'Use prepare-label with an active exact codeId and mediaProfileId qr-50x30-300dpi or qr-80x50-300dpi to render an immutable existing-code QR SVG artifact. Its symbol contains the exact alias value only; namespace and explicit project/inventory context are required for lookup. The artifact retains full target and binding snapshots, source revision, exact SVG and SHA256. Rendered does not mean independently decoded, saved, printed, attached or physically scanned. Preparation is read-only, grants no access, and refuses retired bindings, disposed targets, unsupported text or layout overflow. Missing custody remains explicit and does not establish location. No file or printer is written. ' +
  'Resolve exact physical item codes with resolve-item-code in an explicit project and inventory. Pass query.namespace as an exact technical namespace or null for all namespaces and query.value as the unchanged code. Case, leading zeros and spaces matter. Invalid, not found, retired and ambiguous are distinct results; never prefer one ambiguous match or fall back to scientific material search. The lookup returns current target facts, custody and stock availability at one revision. Codes grant no access, and URL text is not navigation. Lookup never changes inventory. ' +
  'Use catalog-update-preview with an exact catalogEntryId and inventoryId to classify built-in definitions and inspect source scope and installed references without inventory writes. Any definition conflict blocks applying the entire pack. Apply selected new definitions through execute at the current revision; identical retired definitions remain retired. ' +
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
