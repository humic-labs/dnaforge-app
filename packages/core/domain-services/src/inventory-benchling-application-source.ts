import {
  JsonNumberLexeme,
  parseUniqueJson,
  parseUniqueJsonWithNumberLexemes,
} from '@waypoint/scientific-objects/unique-json';
import { inspectInventoryBenchlingCapture } from './inventory-benchling-source';
import { interpretInventoryBenchlingQuantity } from './inventory-benchling-quantity';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import { inventoryReceiveSourceKey } from './inventory-receive-source';
import { parseInventoryCommandBatch } from './inventory-validation';
import {
  MAX_INVENTORY_STORAGE_SLOTS,
  type InventoryLayout,
  type InventoryQuantityInput,
} from './inventory-types';
import type {
  InventoryBenchlingCaptureInspection,
  InventoryBenchlingRecord,
  InventoryBenchlingField,
} from './inventory-benchling-types';
import type { InventoryTableIssue } from './inventory-table-types';
import type {
  InventoryBenchlingCaptureChoices,
  InventoryBenchlingCapturedChoice,
  InventoryBenchlingFactChoice,
  InventoryBenchlingPlacementBasis,
  InventoryBenchlingPositionChoice,
  InventoryBenchlingRecordDecision,
  InventoryBenchlingQuantityChoice,
  InventoryBenchlingStoragePlacementChoice,
  InventoryBenchlingVesselPlacementChoice,
  InventoryBenchlingStorageDefinition,
} from './inventory-benchling-application-types';

export class BenchlingApplicationError extends Error {
  constructor(readonly issue: InventoryTableIssue) {
    super(issue.message);
  }
}
export function fail(code: string, pointer: string, message: string): never {
  throw new BenchlingApplicationError({ code, pointer, message });
}
export const requireReason = (value: unknown): value is string =>
  typeof value === 'string' &&
  Boolean(value.trim()) &&
  value.length <= 2000 &&
  !value.includes('\0');
export function shape(value: unknown, keys: readonly string[], pointer: string): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail('BENCHLING_CHOICE_INVALID', pointer, `Supply exactly ${keys.join(', ')}.`);
}
export const recordKey = (record: { kind: string; sourceId: string }) =>
  JSON.stringify([record.kind, record.sourceId]);
const semantic = (field: InventoryBenchlingField | undefined): unknown =>
  !field
    ? { kind: 'omitted' }
    : field.kind === 'present'
      ? { kind: field.kind, jsonText: field.jsonText }
      : field.kind === 'conflict'
        ? { kind: field.kind, alternatives: field.alternatives }
        : { kind: field.kind };
export type SourcePlacement =
  | { kind: 'root' }
  | { kind: 'unplaced' }
  | { kind: 'source'; parentSourceId: string; slot: string }
  | { kind: 'existing'; storageId: string; slot: string };
export interface ResolvedBenchlingStorage {
  record: InventoryBenchlingRecord;
  decision: Extract<InventoryBenchlingRecordDecision, { disposition: 'storage' }>;
  name: string;
  layout: InventoryLayout;
  placement: SourcePlacement;
  rowSha256: `sha256:${string}`;
}
export interface ResolvedBenchlingVessel {
  record: InventoryBenchlingRecord;
  decision: Extract<InventoryBenchlingRecordDecision, { disposition: 'vessel' }>;
  target:
    | { kind: 'movable'; name: string; placement: SourcePlacement }
    | { kind: 'fixed-well'; plateSourceId: string; position: string };
  rowSha256: `sha256:${string}`;
  contents:
    | { kind: 'empty' | 'unobserved' | 'unidentified'; reason: string }
    | {
        kind: 'identify';
        reason: string;
        materialId: string;
        materialKey: string;
        quantity: InventoryQuantityInput;
        quality: 'usable' | 'quarantined';
      };
}
export interface ResolvedBenchlingSource {
  inspection: InventoryBenchlingCaptureInspection;
  choices: InventoryBenchlingCaptureChoices;
  storage: ResolvedBenchlingStorage[];
  vessels: ResolvedBenchlingVessel[];
}

function selected(
  record: InventoryBenchlingRecord,
  field: string,
  choice: InventoryBenchlingCapturedChoice
) {
  shape(
    choice,
    ['kind', 'responseId', 'pointer', 'reason'],
    `/choices/${record.sourceId}/${field}`
  );
  if (choice.kind !== 'captured' || (choice.reason !== null && !requireReason(choice.reason)))
    fail(
      'BENCHLING_FIELD_CHOICE_INVALID',
      '/choices',
      'Choose an exact captured field observation with a valid optional reason.'
    );
  const facts = record.fields[field];
  const observation = facts?.observations.find(
    (item) => item.responseId === choice.responseId && item.pointer === choice.pointer
  );
  if (!observation || observation.kind === 'omitted')
    fail(
      'BENCHLING_FIELD_REFERENCE_INVALID',
      choice.pointer,
      'The reference must name a present or explicit-null observation of this exact record field.'
    );
  if (facts.kind === 'conflict' && !requireReason(choice.reason))
    fail(
      'BENCHLING_CONFLICT_UNRESOLVED',
      choice.pointer,
      'Explain the explicit choice between conflicting source facts.'
    );
  return observation;
}
function fact<T>(
  record: InventoryBenchlingRecord,
  field: string,
  choice: InventoryBenchlingFactChoice<T>
): T {
  if (choice?.kind === 'declared') {
    shape(choice, ['kind', 'value', 'reason'], '/choices');
    if (!requireReason(choice.reason))
      fail(
        'BENCHLING_DECLARATION_REASON_REQUIRED',
        '/choices',
        'A declared interpretation requires a reason.'
      );
    return choice.value;
  }
  const observation = selected(record, field, choice as InventoryBenchlingCapturedChoice);
  return (observation.kind === 'null' ? null : parseUniqueJson(observation.jsonText)) as T;
}
function exactDimension(
  record: InventoryBenchlingRecord,
  field: string,
  choice: InventoryBenchlingCapturedChoice
): number {
  const observation = selected(record, field, choice);
  if (observation.kind !== 'present')
    fail(
      'BENCHLING_DIMENSION_INVALID',
      choice.pointer,
      'A grid dimension requires an observed exact positive integer.'
    );
  const node = parseUniqueJsonWithNumberLexemes(observation.jsonText, { maxNumbers: 1 }).value;
  if (!(node instanceof JsonNumberLexeme))
    fail('BENCHLING_DIMENSION_INVALID', choice.pointer, 'A grid dimension must be a JSON number.');
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(node.lexeme)!;
  if (match[1] || node.lexeme.length > 128 || (match[4]?.length ?? 0) > 4)
    fail(
      'BENCHLING_DIMENSION_INVALID',
      choice.pointer,
      'A grid dimension exceeds the positive integer bound.'
    );
  const power = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length);
  if (power < -128n || power > 128n)
    fail(
      'BENCHLING_DIMENSION_INVALID',
      choice.pointer,
      'A grid dimension exceeds the positive integer bound.'
    );
  const coefficient = BigInt(match[2] + (match[3] ?? ''));
  const scale = 10n ** (power < 0n ? -power : power);
  if (power < 0n && coefficient % scale !== 0n)
    fail('BENCHLING_DIMENSION_INVALID', choice.pointer, 'A grid dimension must be integral.');
  const value = power < 0n ? coefficient / scale : coefficient * scale;
  if (value < 1n || value > BigInt(MAX_INVENTORY_STORAGE_SLOTS))
    fail(
      'BENCHLING_DIMENSION_INVALID',
      choice.pointer,
      'A grid dimension exceeds supported storage positions.'
    );
  return Number(value);
}
function layout(
  record: InventoryBenchlingRecord,
  definition: InventoryBenchlingStorageDefinition,
  records: Map<string, InventoryBenchlingRecord>
): InventoryLayout {
  if (definition?.kind !== record.kind)
    fail(
      'BENCHLING_STORAGE_KIND_INVALID',
      '/choices',
      'The storage definition must match its captured resource kind.'
    );
  if (definition.kind === 'location') {
    shape(definition, ['kind', 'layout'], '/choices');
    const value = fact(record, 'layout', definition.layout);
    if (definition.layout.kind !== 'declared')
      fail('BENCHLING_LAYOUT_REQUIRED', '/choices', 'Locations need a declared local layout.');
    return (
      parseInventoryCommandBatch({
        expectedRevision: 0,
        commands: [
          {
            kind: 'create-layout-storage',
            id: 'shape',
            name: 'shape',
            layout: value,
            placement: { kind: 'root' },
          },
        ],
      }).commands[0] as Extract<
        import('./inventory-types').InventoryCommand,
        { kind: 'create-layout-storage' }
      >
    ).layout;
  }
  shape(
    definition,
    definition.kind === 'box' ? ['kind', 'layout'] : ['kind', 'plateType', 'layout'],
    '/choices'
  );
  let dimensions: { rows: number; columns: number };
  if (definition.layout?.kind === 'declared') {
    shape(definition.layout, ['kind', 'value', 'reason'], '/choices');
    if (!requireReason(definition.layout.reason))
      fail('BENCHLING_LAYOUT_REASON_REQUIRED', '/choices', 'Declared dimensions require a reason.');
    shape(definition.layout.value, ['rows', 'columns'], '/choices');
    dimensions = definition.layout.value;
  } else {
    shape(definition.layout, ['kind', 'schema', 'height', 'width'], '/choices');
    if (definition.layout.kind !== 'captured-schema')
      fail(
        'BENCHLING_LAYOUT_REQUIRED',
        '/choices',
        'Explicitly select a captured schema or declared dimensions.'
      );
    const expectedKind = definition.kind === 'box' ? 'box-schema' : 'plate-schema';
    shape(definition.layout.schema, ['kind', 'sourceId'], '/choices');
    const schema = records.get(recordKey(definition.layout.schema));
    const association = record.fields.schema;
    const associationValue =
      association?.kind === 'present'
        ? (parseUniqueJson(association.jsonText) as { id?: unknown })
        : null;
    if (!schema || schema.kind !== expectedKind || associationValue?.id !== schema.sourceId)
      fail(
        'BENCHLING_SCHEMA_REFERENCE_INVALID',
        '/choices',
        'The selected captured schema must be the unambiguous schema reference of this storage record.'
      );
    dimensions = {
      rows: exactDimension(schema, 'height', definition.layout.height),
      columns: exactDimension(schema, 'width', definition.layout.width),
    };
  }
  const type =
    definition.kind === 'plate' ? fact(record, 'type', definition.plateType) : 'matrix_plate';
  if (type !== 'well_plate' && type !== 'matrix_plate')
    fail(
      'BENCHLING_PLATE_TYPE_INVALID',
      '/choices',
      'Choose well_plate or matrix_plate explicitly.'
    );
  const value = {
    kind: type === 'well_plate' ? ('fixed-well' as const) : ('removable-tube' as const),
    ...dimensions,
  };
  parseInventoryCommandBatch({
    expectedRevision: 0,
    commands: [
      {
        kind: 'create-layout-storage',
        id: 'shape',
        name: 'shape',
        layout: value,
        placement: { kind: 'root' },
      },
    ],
  });
  return value;
}
function placement(
  record: InventoryBenchlingRecord,
  choice: InventoryBenchlingStoragePlacementChoice | InventoryBenchlingVesselPlacementChoice,
  inspection: InventoryBenchlingCaptureInspection
): SourcePlacement {
  const terminal = choice?.kind === 'root' || choice?.kind === 'unplaced';
  shape(
    choice,
    terminal
      ? ['kind', 'basis']
      : choice?.kind === 'source'
        ? ['kind', 'parentSourceId', 'position', 'basis']
        : ['kind', 'storageId', 'position', 'basis', 'reason'],
    '/choices/placement'
  );
  const basis = choice.basis;
  let parent: unknown;
  let capturedPosition: string | null = null;
  if (basis?.kind === 'declared') {
    shape(basis, ['kind', 'reason'], '/choices/placement');
    if (!requireReason(basis.reason))
      fail(
        'BENCHLING_PLACEMENT_REASON_REQUIRED',
        '/choices',
        'Declared placement requires a reason.'
      );
  } else if (basis?.kind === 'captured') {
    const observation = selected(record, 'parentStorageId', basis);
    parent = observation.kind === 'null' ? null : parseUniqueJson(observation.jsonText);
    if (terminal ? parent !== null : typeof parent !== 'string')
      fail(
        'BENCHLING_PARENT_UNRESOLVED',
        '/choices',
        'The selected source parent cannot establish this placement.'
      );
  } else {
    shape(basis, ['kind', 'responseId', 'pointer', 'reason'], '/choices/placement');
    if (basis.kind !== 'membership' || (basis.reason !== null && !requireReason(basis.reason)))
      fail('BENCHLING_MEMBERSHIP_INVALID', '/choices', 'Choose exact membership evidence.');
    const claims = inspection.placements.filter((item) => item.containerId === record.sourceId);
    const claim = claims.find(
      (item) => item.responseId === basis.responseId && item.pointer === basis.pointer
    );
    if (!claim || record.kind !== 'container' || terminal)
      fail(
        'BENCHLING_MEMBERSHIP_INVALID',
        '/choices',
        'This membership does not belong to this exact container.'
      );
    if (
      inspection.issues.some((issue) => issue.code === 'BENCHLING_PLACEMENTS_DIFFER') &&
      !requireReason(basis.reason)
    )
      fail(
        'BENCHLING_CONFLICT_UNRESOLVED',
        '/choices',
        'Explain the explicit membership choice when captured placements differ.'
      );
    parent = claim.kind === 'plate-well' ? claim.plateId : claim.boxId;
    capturedPosition =
      claim.kind === 'plate-well'
        ? claim.position
        : claim.gridPosition.kind === 'present'
          ? (parseUniqueJson(claim.gridPosition.jsonText) as string)
          : null;
  }
  if (terminal) return { kind: choice.kind as 'root' | 'unplaced' };
  const located = choice as Exclude<typeof choice, { kind: 'root' | 'unplaced' }>;
  shape(located.position, ['value', 'basis', 'reason'], '/choices/position');
  if (!inventoryReceiveSourceKey(located.position.value))
    fail('BENCHLING_POSITION_INVALID', '/choices', 'Choose an exact destination position.');
  if (located.position.basis === 'captured-exact') {
    if (
      capturedPosition !== located.position.value ||
      (located.position.reason !== null && !requireReason(located.position.reason))
    )
      fail(
        'BENCHLING_POSITION_REFERENCE_INVALID',
        '/choices',
        'Captured-exact position must equal the chosen membership coordinate.'
      );
  } else if (
    located.position.basis !== 'declared-mapping' ||
    !requireReason(located.position.reason)
  )
    fail(
      'BENCHLING_POSITION_REASON_REQUIRED',
      '/choices',
      'A declared position mapping requires a reason.'
    );
  if (located.kind === 'source') {
    if (
      !inventoryReceiveSourceKey(located.parentSourceId) ||
      (basis.kind !== 'declared' && parent !== located.parentSourceId)
    )
      fail(
        'BENCHLING_PARENT_MISMATCH',
        '/choices',
        'The source parent must match the selected placement evidence.'
      );
    return { kind: 'source', parentSourceId: located.parentSourceId, slot: located.position.value };
  }
  if (
    located.kind !== 'existing' ||
    !inventoryReceiveSourceKey(located.storageId) ||
    !requireReason(located.reason)
  )
    fail(
      'BENCHLING_EXISTING_PARENT_INVALID',
      '/choices',
      'Mapping to existing storage requires an exact ID and a reason.'
    );
  return { kind: 'existing', storageId: located.storageId, slot: located.position.value };
}
function sourceQuantity(
  record: InventoryBenchlingRecord,
  choice: InventoryBenchlingQuantityChoice
): InventoryQuantityInput {
  if (choice?.kind === 'unknown') {
    shape(choice, ['kind', 'reason'], '/choices/quantity');
    if (!requireReason(choice.reason))
      fail(
        'BENCHLING_QUANTITY_REASON_REQUIRED',
        '/choices',
        'Unknown volume requires an explicit reason.'
      );
    return { kind: 'unknown' };
  }
  shape(choice, ['kind', 'sourceField', 'selection'], '/choices/quantity');
  if (
    choice.kind !== 'source-volume' ||
    (choice.sourceField !== 'quantity' && choice.sourceField !== 'volume')
  )
    fail(
      'BENCHLING_QUANTITY_SELECTION_INVALID',
      '/choices',
      'Choose quantity or volume explicitly.'
    );
  const observed = selected(record, choice.sourceField, choice.selection);
  if (
    choice.sourceField === 'volume' &&
    record.fields.quantity?.kind !== 'omitted' &&
    !requireReason(choice.selection.reason)
  )
    fail(
      'BENCHLING_LEGACY_VOLUME_REASON_REQUIRED',
      '/choices',
      'Explain selection of deprecated volume when quantity is also supplied.'
    );
  const interpreted = interpretInventoryBenchlingQuantity({
    sourceField: choice.sourceField,
    field: observed,
  });
  if (interpreted.kind !== 'volume')
    fail(
      'BENCHLING_QUANTITY_UNRESOLVED',
      '/choices',
      'The selected source observation does not establish a supported exact volume; choose unknown with a reason.'
    );
  return interpreted.quantity;
}
function contents(
  record: InventoryBenchlingRecord,
  decision: Extract<InventoryBenchlingRecordDecision, { disposition: 'vessel' }>['contents']
): ResolvedBenchlingVessel['contents'] {
  if (!decision || !requireReason(decision.reason))
    fail(
      'BENCHLING_CONTENTS_REASON_REQUIRED',
      '/choices',
      'Every contents decision requires a reason.'
    );
  if (decision.kind === 'unobserved') {
    shape(decision, ['kind', 'reason'], '/choices');
    return decision;
  }
  shape(
    decision,
    decision.kind === 'identify'
      ? ['kind', 'selection', 'materialId', 'quantity', 'quality', 'reason']
      : decision.kind === 'empty'
        ? ['kind', 'selection', 'quantity', 'reason']
        : ['kind', 'selection', 'reason'],
    '/choices'
  );
  const observation = selected(record, 'contents', decision.selection);
  const value =
    observation.kind === 'present'
      ? parseUniqueJsonWithNumberLexemes(observation.jsonText, { maxDepth: 32, maxNumbers: 100000 })
          .value
      : null;
  if (!Array.isArray(value))
    fail(
      'BENCHLING_CONTENTS_UNRESOLVED',
      '/choices',
      'Select an actual captured contents array, or record unobserved contents.'
    );
  if (decision.kind === 'empty') {
    const quantity = sourceQuantity(record, decision.quantity);
    if (
      value.length ||
      quantity.kind !== 'known' ||
      quantity.value !== '0' ||
      decision.quantity.kind !== 'source-volume'
    )
      fail(
        'BENCHLING_EMPTY_NOT_ESTABLISHED',
        '/choices',
        'An empty decision requires captured contents[] and an explicitly selected exact zero volume.'
      );
    return { kind: 'empty', reason: decision.reason };
  }
  if (decision.kind === 'unidentified') {
    if (!value.length)
      fail(
        'BENCHLING_CONTENTS_UNRESOLVED',
        '/choices',
        'Unidentified contents requires present nonempty source contents; otherwise choose unobserved.'
      );
    return { kind: 'unidentified', reason: decision.reason };
  }
  if (
    decision.kind !== 'identify' ||
    value.length !== 1 ||
    !value[0] ||
    typeof value[0] !== 'object'
  )
    fail(
      'BENCHLING_SINGLE_CONTENT_REQUIRED',
      '/choices',
      'Identification requires exactly one supported content, never the first member of a mixture.'
    );
  const entry = value[0] as {
    entity?: { id?: unknown };
    batch?: { id?: unknown; entity?: { id?: unknown } };
  };
  const entityId = entry.entity?.id ?? entry.batch?.entity?.id;
  if (
    !inventoryReceiveSourceKey(entityId) ||
    (entry.entity?.id && entry.batch?.entity?.id && entry.entity.id !== entry.batch.entity.id) ||
    (entry.batch && !inventoryReceiveSourceKey(entry.batch.id))
  )
    fail(
      'BENCHLING_CONTENT_ID_UNRESOLVED',
      '/choices',
      'The selected single content requires a consistent scientific source identity.'
    );
  if (!inventoryReceiveSourceKey(decision.materialId))
    fail(
      'BENCHLING_MATERIAL_UNRESOLVED',
      '/choices',
      'Choose a current local scientific identity.'
    );
  shape(decision.quality, ['value', 'reason'], '/choices');
  if (
    !['usable', 'quarantined'].includes(decision.quality.value) ||
    !requireReason(decision.quality.reason)
  )
    fail('BENCHLING_QUALITY_UNRESOLVED', '/choices', 'Choose quality explicitly with a reason.');
  const materialKey = entry.batch
    ? `benchling-content:${inventoryTableSha256(canonical({ entityId, batchId: entry.batch.id })).slice(7)}`
    : entityId;
  return {
    kind: 'identify',
    reason: decision.reason,
    materialId: decision.materialId,
    materialKey,
    quantity: sourceQuantity(record, decision.quantity),
    quality: decision.quality.value,
  };
}
export function resolveInventoryBenchlingApplicationSource(
  sourceText: string,
  options: InventoryBenchlingCaptureChoices,
  maxBytes: number
): ResolvedBenchlingSource {
  const inspection = inspectInventoryBenchlingCapture(sourceText, maxBytes);
  if (inspection.kind !== 'inspected' || !inspection.capture)
    fail(
      'BENCHLING_SOURCE_INVALID',
      '/sourceText',
      inspection.issues[0]?.message ?? 'Capture source is invalid.'
    );
  shape(
    options,
    ['scopeAcceptance', 'records', 'sourceIssueDispositions', 'uncapturedPositions'],
    '/options'
  );
  shape(options.scopeAcceptance, ['kind', 'reason'], '/options');
  if (
    options.scopeAcceptance.kind !== 'selected-records' ||
    !requireReason(options.scopeAcceptance.reason) ||
    !Array.isArray(options.records) ||
    !Array.isArray(options.sourceIssueDispositions) ||
    !Array.isArray(options.uncapturedPositions)
  )
    fail(
      'BENCHLING_SCOPE_REQUIRED',
      '/options',
      'Accept the limited selected-record scope and supply explicit decision lists.'
    );
  const records = new Map(inspection.records.map((record) => [recordKey(record), record]));
  const sourceStorageIds = new Set<string>();
  for (const record of inspection.records) {
    if (!['location', 'box', 'plate'].includes(record.kind)) continue;
    if (sourceStorageIds.has(record.sourceId))
      fail(
        'BENCHLING_STORAGE_ID_AMBIGUOUS',
        '/sourceText',
        'Different captured storage kinds share a source ID. Resolve that ambiguity before selecting physical targets.'
      );
    sourceStorageIds.add(record.sourceId);
  }
  const seen = new Set<string>();
  const issueKey = (issue: {
    code: string;
    responseId: string | null;
    bodyPointer: string | null;
  }) => canonical([issue.code, issue.responseId, issue.bodyPointer]);
  const sourceIssues = new Set(inspection.issues.map(issueKey));
  const acceptedIssues = new Set<string>();
  for (const disposition of options.sourceIssueDispositions) {
    shape(
      disposition,
      ['code', 'responseId', 'bodyPointer', 'reason'],
      '/options/sourceIssueDispositions'
    );
    const id = issueKey(disposition);
    if (!sourceIssues.has(id) || acceptedIssues.has(id) || !requireReason(disposition.reason))
      fail(
        'BENCHLING_SOURCE_ISSUE_UNRESOLVED',
        '/options',
        'Each actual source issue needs exactly one reason-bearing disposition.'
      );
    acceptedIssues.add(id);
  }
  if (acceptedIssues.size !== sourceIssues.size)
    fail(
      'BENCHLING_SOURCE_ISSUE_UNRESOLVED',
      '/options',
      'Resolve every reported source issue before applying.'
    );
  const storage: ResolvedBenchlingStorage[] = [];
  const vessels: ResolvedBenchlingVessel[] = [];
  const storageIds = new Set<string>();
  for (const decision of options.records) {
    shape(decision.record, ['kind', 'sourceId'], '/options/records');
    const id = recordKey(decision.record);
    const record = records.get(id);
    if (!record || seen.has(id))
      fail(
        'BENCHLING_RECORD_DISPOSITION_INVALID',
        '/options/records',
        'Each discovered record requires exactly one disposition.'
      );
    seen.add(id);
    if (decision.disposition === 'skip' || decision.disposition === 'evidence') {
      shape(decision, ['record', 'disposition', 'reason'], '/options/records');
      if (
        !requireReason(decision.reason) ||
        (decision.disposition === 'evidence' && !record.kind.endsWith('-schema'))
      )
        fail(
          'BENCHLING_EVIDENCE_REASON_REQUIRED',
          '/options',
          'Explicit skipping or schema evidence requires a reason.'
        );
      continue;
    }
    const raw = (fields: readonly string[]) =>
      Object.fromEntries(fields.map((field) => [field, semantic(record.fields[field])]));
    if (decision.disposition === 'storage') {
      shape(
        decision,
        ['record', 'disposition', 'name', 'definition', 'placement'],
        '/options/records'
      );
      if (!['location', 'box', 'plate'].includes(record.kind) || storageIds.has(record.sourceId))
        fail(
          'BENCHLING_STORAGE_ID_AMBIGUOUS',
          '/options',
          'Source storage kinds must have distinct unambiguous source IDs.'
        );
      storageIds.add(record.sourceId);
      const name = fact(record, 'name', decision.name);
      if (typeof name !== 'string' || !name.trim() || name.length > 512 || name.includes('\0'))
        fail('BENCHLING_NAME_UNRESOLVED', '/choices', 'Choose an explicit usable storage name.');
      const resolvedLayout = layout(record, decision.definition, records);
      const resolvedPlacement = placement(record, decision.placement, inspection);
      if (resolvedPlacement.kind === 'unplaced')
        fail(
          'BENCHLING_STORAGE_PLACEMENT_INVALID',
          '/choices',
          'Storage must have a root or located placement.'
        );
      const schema =
        decision.definition.kind !== 'location' &&
        decision.definition.layout.kind === 'captured-schema'
          ? records.get(recordKey(decision.definition.layout.schema))
          : null;
      const policy = options.uncapturedPositions
        .filter((item) => item.storageSourceId === record.sourceId)
        .map(({ positions }) => [...positions].sort());
      const rowSha256 = inventoryTableSha256(
        canonical({
          format: 'dnaforge.inventory-benchling-physical.v1',
          kind: record.kind,
          sourceId: record.sourceId,
          source: raw([
            'name',
            'parentStorageId',
            'schema',
            ...(record.kind === 'plate' ? ['type'] : []),
          ]),
          schema: schema
            ? { height: semantic(schema.fields.height), width: semantic(schema.fields.width) }
            : null,
          name,
          layout: resolvedLayout,
          placement: resolvedPlacement,
          unavailablePositions: policy,
        })
      );
      storage.push({
        record,
        decision,
        name,
        layout: resolvedLayout,
        placement: resolvedPlacement,
        rowSha256,
      });
    } else {
      shape(decision, ['record', 'disposition', 'target', 'contents'], '/options/records');
      if (decision.disposition !== 'vessel' || record.kind !== 'container')
        fail(
          'BENCHLING_RECORD_KIND_INVALID',
          '/options',
          'Only container records can be imported as vessels.'
        );
      let target: ResolvedBenchlingVessel['target'];
      if (decision.target?.kind === 'movable') {
        shape(decision.target, ['kind', 'name', 'placement'], '/choices');
        const name = fact(record, 'name', decision.target.name);
        if (typeof name !== 'string' || !name.trim() || name.length > 512 || name.includes('\0'))
          fail(
            'BENCHLING_NAME_UNRESOLVED',
            '/choices',
            'A movable vessel needs an explicit usable name.'
          );
        const resolved = placement(record, decision.target.placement, inspection);
        if (resolved.kind === 'root')
          fail(
            'BENCHLING_VESSEL_PLACEMENT_INVALID',
            '/choices',
            'A vessel cannot have a root placement.'
          );
        target = { kind: 'movable', name, placement: resolved };
      } else {
        shape(decision.target, ['kind', 'plateSourceId', 'position', 'basis'], '/choices');
        if (decision.target.kind !== 'fixed-well')
          fail(
            'BENCHLING_VESSEL_TARGET_INVALID',
            '/choices',
            'Choose a movable or fixed-well target explicitly.'
          );
        const resolved = placement(
          record,
          {
            kind: 'source',
            parentSourceId: decision.target.plateSourceId,
            position: decision.target.position,
            basis: decision.target.basis,
          },
          inspection
        );
        if (resolved.kind !== 'source')
          fail(
            'BENCHLING_WELL_TARGET_INVALID',
            '/choices',
            'A permanent well needs its source plate and coordinate.'
          );
        target = {
          kind: 'fixed-well',
          plateSourceId: resolved.parentSourceId,
          position: resolved.slot,
        };
      }
      const memberships = [
        ...new Set(
          inspection.placements
            .filter((item) => item.containerId === record.sourceId)
            .map((item) =>
              canonical(
                item.kind === 'plate-well'
                  ? { kind: item.kind, plateId: item.plateId, position: item.position }
                  : {
                      kind: item.kind,
                      boxId: item.boxId,
                      gridPosition:
                        item.gridPosition.kind === 'present'
                          ? item.gridPosition.jsonText
                          : item.gridPosition.kind,
                      gridNumber:
                        item.gridNumber.kind === 'present'
                          ? item.gridNumber.jsonText
                          : item.gridNumber.kind,
                    }
              )
            )
        ),
      ].sort();
      const rowSha256 = inventoryTableSha256(
        canonical({
          format: 'dnaforge.inventory-benchling-physical.v1',
          kind: record.kind,
          sourceId: record.sourceId,
          source: raw(
            target.kind === 'movable'
              ? ['name', 'parentStorageId', 'schema']
              : ['parentStorageId', 'schema']
          ),
          memberships,
          target,
        })
      );
      vessels.push({
        record,
        decision,
        target,
        rowSha256,
        contents: contents(record, decision.contents),
      });
    }
  }
  if (seen.size !== records.size)
    fail(
      'BENCHLING_RECORD_DISPOSITION_MISSING',
      '/options',
      'Every source record, including schema evidence, needs an explicit disposition.'
    );
  for (const policy of options.uncapturedPositions) {
    shape(policy, ['storageSourceId', 'positions', 'kind', 'reason'], '/options');
    if (
      policy.kind !== 'unavailable' ||
      !requireReason(policy.reason) ||
      !Array.isArray(policy.positions) ||
      policy.positions.length > MAX_INVENTORY_STORAGE_SLOTS ||
      policy.positions.some((position: unknown) => typeof position !== 'string') ||
      new Set(policy.positions).size !== policy.positions.length ||
      !storage.some((item) => item.record.sourceId === policy.storageSourceId)
    )
      fail(
        'BENCHLING_UNCAPTURED_POLICY_INVALID',
        '/options',
        'Supply explicit unique unavailable positions for an imported storage record.'
      );
  }
  return {
    inspection,
    choices: options,
    storage: storage.sort((a, b) =>
      recordKey(a.record) < recordKey(b.record)
        ? -1
        : recordKey(a.record) > recordKey(b.record)
          ? 1
          : 0
    ),
    vessels: vessels.sort((a, b) =>
      a.record.sourceId < b.record.sourceId ? -1 : a.record.sourceId > b.record.sourceId ? 1 : 0
    ),
  };
}
