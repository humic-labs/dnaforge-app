import { asSchema, zodSchema } from 'ai';
import { z } from 'zod';
import {
  MAX_INVENTORY_BATCH_COMMANDS,
  inventoryCommandJsonSchema,
  parseInventoryCommandBatch,
} from '@waypoint/domain-services';
import {
  inventoryPreviewArrivalRequestSchema,
  inventoryApplyArrivalRequestSchema,
  inventoryArrivalDocumentRequestSchema,
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
  inventoryPreviewStocktakeRequestSchema,
  inventoryApplyStocktakeRequestSchema,
  inventoryPreviewHierarchyRequestSchema,
  inventoryPreviewMappedTableRequestSchema,
  inventoryApplyMappedTableRequestSchema,
  inventoryApplyHierarchyRequestSchema,
  inventoryPreviewSourceRevisionRequestSchema,
  inventoryAcknowledgeSourceRequestSchema,
  inventoryInspectBenchlingCaptureRequestSchema,
  inventoryPreviewBenchlingCaptureRequestSchema,
  inventoryApplyBenchlingCaptureRequestSchema,
} from '../../../shared/inventory-command';
import { jsonObjectSchema } from '../../../shared/json-value';
import { resultTool, toolFailure } from '../../agent-bridge/public/tool-result';

const project = z.string().min(1).max(4096);
const identity = z.string().min(1).max(256);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scope = { project, inventoryId: identity };
const plainInput = z.discriminatedUnion('kind', [
  inventoryPreviewArrivalRequestSchema.extend({ kind: z.literal('preview-arrival') }).strict(),
  inventoryApplyArrivalRequestSchema.extend({ kind: z.literal('apply-arrival') }).strict(),
  inventoryArrivalDocumentRequestSchema.extend({ kind: z.literal('arrival-document') }).strict(),
  inventoryPreviewBenchlingCaptureRequestSchema.extend({ kind: z.literal('preview-benchling-capture') }).strict(),
  inventoryApplyBenchlingCaptureRequestSchema.extend({ kind: z.literal('apply-benchling-capture') }).strict(),
  inventoryInspectBenchlingCaptureRequestSchema
    .extend({ kind: z.literal('inspect-benchling-capture') })
    .strict(),
  inventoryPreviewMappedTableRequestSchema
    .extend({ kind: z.literal('preview-mapped-table') })
    .strict(),
  inventoryApplyMappedTableRequestSchema.extend({ kind: z.literal('apply-mapped-table') }).strict(),
  inventoryPreviewHierarchyRequestSchema.extend({ kind: z.literal('preview-hierarchy') }).strict(),
  inventoryApplyHierarchyRequestSchema.extend({ kind: z.literal('apply-hierarchy') }).strict(),
  inventoryPreviewSourceRevisionRequestSchema
    .extend({ kind: z.literal('preview-source-revision') })
    .strict(),
  inventoryAcknowledgeSourceRequestSchema
    .extend({ kind: z.literal('acknowledge-source') })
    .strict(),
  inventoryPreviewStocktakeRequestSchema.extend({ kind: z.literal('preview-stocktake') }).strict(),
  inventoryApplyStocktakeRequestSchema,
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
  z.object({ kind: z.literal('stockroom'), ...scope }).strict(),
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
  z.object({ ...ok, kind: z.literal('stockroom'), stockroom: jsonObjectSchema.nullable() }).strict(),
  z.object({ ...ok, kind: z.literal('arrival-preview'), preview: jsonObjectSchema }).strict(),
  z.object({ ...ok, kind: z.literal('arrival-document'), result: jsonObjectSchema }).strict(),
  z.object({ ...ok, kind: z.literal('benchling-capture-preview'), preview: jsonObjectSchema }).strict(),
  z
    .object({ ...ok, kind: z.literal('benchling-capture-inspection'), result: jsonObjectSchema })
    .strict(),
  z.object({ ...ok, kind: z.literal('mapped-table-preview'), preview: jsonObjectSchema }).strict(),
  z
    .object({ ...ok, kind: z.literal('source-revision-preview'), preview: jsonObjectSchema })
    .strict(),
  z.object({ ...ok, kind: z.literal('stocktake-preview'), preview: jsonObjectSchema }).strict(),
  z.object({ ...ok, kind: z.literal('hierarchy-preview'), preview: jsonObjectSchema }).strict(),
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
  'Read stockroom for expected delivery progress, original received-component allocation remainders and reorder reports at one native projectId/inventoryId/revision/principal/asOf. Use generic execute for record-expected-delivery, allocate-arrival, withdraw-arrival-allocation, close-expected-delivery-remainder, reopen-expected-delivery, record-reorder-rule and retire-reorder-rule. Expectations record explicit scientific material, positive amount, supplier or null, optional externalReference and reason; they never place an order or create on-hand stock. Allocate only original identified known received component amounts by arrivalId+componentKey, never current remaining quantity or package labels. Active allocations are capped across all lines by the original receipt and each line expectation; same scientific material and dimension are required. Use, movement, disposal and eligibility changes never unfulfill an allocation. Close only positive unmatched remainder; reopen explicitly before further matching or withdrawing an allocation on that line. Withdrawn allocations are immutable history and corrections get new IDs. Reorder rules declare positive exact threshold, actionBasis reserve or withdraw, and validityBasis current-recorded-rules or confirmed-current-validity without defaults. Known eligible unreserved stock is a lower bound; reaching threshold proves adequate even with unknown amounts, otherwise relevant eligible unknowns require measurement. Other dimensions and excluded physical stock remain explicit; expected quantities never enter the subtotal. Current-recorded-rules can include disclosed untracked validity and does not prove unexpired material; confirmed-current-validity requires coverage and the selected reserve/withdraw admission. Read nextBoundaryAt and request a new native snapshot at boundaries; never store low/expired flags or use renderer time as business authority. Recording expected deliveries, matching and reports send no vendor messages, purchases or spending. ' +
  'Record actual deliveries with preview-arrival and apply-arrival using exact application-owned dnaforge.inventory-arrival-source.v1 sourceText. Retain original inline supplier documents, explicit full/excerpt scope, package grouping and one reasoned component disposition: identified, unidentified-physical, unobserved-physical, observed-missing or evidence-only. A package batch is distinct from a component lot, product and delivery identity. Bind each identified component to a current admitted scientific material, explicit existing or new managed-unassessed lot, new movable vessel and explicit placement. Known amount needs a separate measurement or exact supported supplier quantity claim; unsupported activity units remain raw evidence and cannot become mass/volume/count. Supplier QC never releases local stock or lot assessment. Preview is read-only. Apply only ready resolved options, original sourceText, planDigest, revision and stable operationId in one atomic transaction, including metadata-only arrivals. Stable namespace plus arrivalId prevents re-receiving after use, movement, disposal or adoption; changed source or original choices need reconciliation. An unchanged delivery is no-change and writes no new receipt or event. A deliberately renamed physical delivery cannot be detected as a duplicate. Recover an uncertain result with the original operation receipt or identical saved request. Read arrival-document by arrivalId, documentKey and expectedSha256 for exact retained bytes through original or nested adopted history; no fetch, OCR or supplier format compatibility is implied. The existing encoded native request limit applies; never split a delivery silently. ' +
  'Opening and validity belong to explicit stock/material episodes. Use record-stock-opening with an observed timestamp or null; correct-stock-opening names the current observation and records opened or unobserved, never a silent reseal/reset. Use record-validity-decision for an independent stock/lot rule family and correct-validity-decision for its exact current head. Preserve sourceText and sourcePrecision separately from an explicit absolute cutoff or positive elapsed milliseconds after the original stock opening. A printed month/year is not a UTC instant or fixed duration. Unresolved and not-required are explicit reasoned decisions; no receipt, movement, quality release or new aliquot invents opening or clears another family. Derived material retains applicable source families and earliest physical derivation bounds, including known-zero destinations; late opening contradictions block rather than extend life. Read native availability.actions.reserve and actions.withdraw instead of filtering blocker codes: a consistently observed sealed stock with an applicable relative rule may reserve, while use requires recording opening first, optionally in the same batch. At native asOf equal to deadline, material is expired; nextBoundaryAt tells clients when to request a fresh native observation. No applicable opening-dependent rule means unobserved opening alone adds no use gate. Imported positive validity requires explicit local reassessment without manufacturing an opening observation; restrictive evidence remains blocking. Recover uncertain operations through their original saved receipt even after later expiry. ' +
  'For new supplier lots and derived preparations, compose create-lot, pool or dilute with manage-lot in the same execute batch. Manage-lot starts local assessment as unassessed; physical receive-lot-stock can record held material but does not release it. Use assess-lot with a reason for released, quarantined or rejected decisions. Stock set-quality remains an independent hold. Record-lot-recall and withdraw-lot-recall retain independent reasoned safety facts; release never clears a recall. Availability discloses all inherited lot restrictions and legacy-partial or untracked coverage. Transfers, preparations and reassociation retain prior lot constraints, so a new lot name cannot erase a hold or recall. Imported released assessments require explicit local reassessment; imported active recalls remain blocking until explicit local withdrawal. Use the original operation receipt for uncertain outcomes. ' +
  'Stock balances have an explicit measurement basis: volume, mass, amount of substance, or whole-item count. Send non-negative decimal strings and an explicit supported unit for known and unknown quantities. Canonical readback uses uL/ng/nmol/item; unknown amount retains its unit. Unitless unknown input is only the retained legacy volume contract. Never interpret package count as content amount or infer density, molecular weight or enzyme activity. Consume, transfer, reserve and fulfill only within the stock basis; ordinary reconciliation or observation application cannot change dimension. Physical capacity/dead-volume and pool/dilute remain volume-specific. Non-volume transfer into existing stock supports unknown mixing only; homogeneous concentration mixing requires volumes. ' +
  'Apply an offline physical capture with preview-benchling-capture and apply-benchling-capture. Retain the original sourceText and explicit per-record choices, field observation references/conflict reasons, layouts, parent/position decisions, source issues and uncaptured-position blocks. The source namespace is in the versioned capture. Empty means selected contents=[] AND exact selected volume zero; unobserved and unidentified contents remain explicit physical vessels, never fake stock. Identify one supported source content through a current local scientific material with explicit quality and exact source volume or a reasoned unknown quantity. Current mass/count units never become volume, and deprecated volume requires an explicit choice. Fixed wells retain plate/coordinate identity; matrix tubes are movable. Preview is read-only. Apply only ready resolved options, material fingerprints, target IDs, canonical source rows and expectedPlanDigest with expectedRevision/stable operationId. One transaction creates all storage/vessel/stock bindings and physical changes; metadata-only new binding changes also commit once without dummy commands. No-change saves no new source or receipt. Bound source IDs survive local movement/use/disposal/adoption and cannot replenish or duplicate stock. Changed stock source requires established source-revision comparison; previous rows come from retained accepted capture history. An uncertain result requires original receipt lookup or the identical saved request. ' +
  'Vessel contents knowledge is separate from stock quantity. Read contentsKnowledge: recorded with no stock means declared empty, recorded with stock means identified even at known zero, and unobserved/unidentified means unresolved. Never infer physical emptiness from no stock. Use record-vessel-contents with vesselId, knowledge and reason to record unobserved or unidentified contents, or record-vessels-contents with a nonempty unique vesselIds list for one atomic bulk declaration. Use declare-vessel-empty only after an explicit empty observation with reason. Use identify-vessel-stock to identify material already present in an unresolved vessel, with id, vesselId, current project materialId, explicit quantity, quality and reason; this is not a new physical receiving event. Actor and time come from the native boundary. Unresolved contents block ordinary receiving and every new-stock material destination; move, custody and disposal remain separate. Contents declarations cannot erase any identified stock, including known zero. ' +
  'Inspect an offline DNAForge Benchling V2 physical capture with inspect-benchling-capture and exact sourceText. This read-only inspection preserves raw responses and exact JSON number tokens and distinguishes omitted fields, explicit null, present values and conflicting observations. Inspect unresolved source facts, placements and pagination without creating inventory, stock, receipts, journal entries or imported authority. It does not connect to Benchling, prove complete exports, support V3 or apply physical inventory. ' +
  'Use preview-mapped-table and apply-mapped-table with mapped-plate-v1 to receive original CSV/TSV plate spreadsheets into existing permanent wells. Preserve the complete raw source and declare every column as source identity, plate, well or reason-bearing evidence only. Bind scientific materials explicitly in the admitted project, map source plate and well labels to existing plate IDs and exact positions, declare unknown quantity with a reason and choose quality per row explicitly. Never strip leading zeros, infer plate dimensions, treat QC labels as quality or interpret box labels as freezers. Preview has no effects; apply accepts only the exact original bytes, resolved fingerprints, choices and ready digest through the existing journal. Stable physical row bindings prevent duplicates; evidence-only edits may yield no physical changes and save no revised source or receipt. Scientific publication and hierarchy creation remain separate visible stages. ' +
  'Compare revised external receive records with preview-source-revision, format receive-v1 and exact sourceText. Supply existing table namespace and explicit same-identity material/location/vessel resolutions plus acknowledgements with sourceId, expectedPreviousRowSha256 and reason. The read-only comparison separates verified previous source fields, revised source fields and actual inventory; missing previous evidence blocks. Acknowledge only a ready plan with acknowledge-source, saved resolved options/preimages, plan digest, expected revision and stable operation ID. This appends source history without receiving, replenishing, renaming, moving, changing quality, custody or holds, or applying measurements. Original bindings remain immutable; scientific rebinding, vessel replacement, vessel-kind changes and unbound rows refuse. Unchanged receive reimports compare the latest accepted source baseline and preserve later use or movement. Original source fields come from retained accepted requests, including archives, never inferred from current stock. A lost acknowledgement requires the original receipt or identical retry. ' +
  'Import explicit hierarchy-v1 CSV/TSV with preview-hierarchy and apply-hierarchy. Required columns are source_id,name,layout_kind,positions,rows,columns,capacity,parent_kind,parent_key,slot. Supply a stable namespace, explicit delimiter, existing-parent mappings and reason-bearing skips. Named positions use a strict JSON array; grids, tube boxes and fixed-well plates require explicit dimensions; stacks require capacity. Parents are explicit root, local source IDs or mapped existing storage. Stack ordinals define order independently of row order. Preview resolves parent graphs and validates the complete existing-command batch without writes. Cycles, missing parents, occupied positions, noncontiguous stacks and oversized atomic batches refuse. Existing source bindings prevent duplication and never reverse later movement or disposal. Changed source facts require separate reconciliation. Apply only the exact ready plan, source, options, revision and stable operation ID; recover uncertain outcomes using the original receipt or identical retry. No equipment specifications, plate dimensions, temperature control, stock or fit qualification are inferred from names. Receive stock in a separate explicit stage. ' +
  'Preview explicit stocktake observations with preview-stocktake, format stocktake-v1 and exact sourceText. Supply a stable observation namespace, explicit delimiter, subject and destination bindings and one explicit decision per observation: record-only, apply with reason, or skip with reason. Required columns are observation_id,subject_key,observed_at,quantity_kind,quantity,unit,presence,location_key,slot,reason. Stock subjects support known or unknown quantity; item subjects support missing or found presence. Unobserved dimensions use not-observed; found requires an explicit destination. Source time is unknown or exact UTC ISO with milliseconds, separate from trusted native recording time. Record-only creates immutable observation facts without changing quantity or custody; a later explicit apply uses the recorded fact once. Quantity measurement preserves holds and custody, including allocation shortfalls. Missing/found corrections preserve quantity and use existing physical custody rules; never infer a plate from a permanent well or missing stock from an omitted row. Reusing an observation identity with changed facts refuses. Reimporting an applied observation never repeats its correction after later use. Apply only a ready preview through apply-stocktake with exact source, options, plan digest, revision and stable operation ID; uncertain outcomes use original receipt recovery or identical retry. Observations and corrections commit through the existing atomic journal and command limit. Changed receive registers are not physical measurements. ' +
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
