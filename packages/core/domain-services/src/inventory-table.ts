import { parseDelimitedRows } from '@waypoint/scientific-objects/delimited-rows';
import { inventoryRecordIdExists } from './inventory-configuration';
import { applyInventoryCommandBatch } from './inventory-state';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import {
  createInventoryState,
  INVENTORY_DECIMAL_PATTERN,
  INVENTORY_VOLUME_UNITS,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryQuantity,
  type InventoryState,
  type InventoryTransition,
  type InventoryVesselPlacement,
} from './inventory-types';
import {
  inventoryTableBindingKey,
  inventoryTableCanonicalJson,
  inventoryTableRecordIds,
  inventoryTableSha256,
} from './inventory-table-binding';
import {
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  type InventoryReceiveTableFields,
  type InventoryResolvedTableOptions,
  type InventoryTableApplication,
  type InventoryTableBinding,
  type InventoryTableBindingObservation,
  type InventoryTableChoices,
  type InventoryTableIssue,
  type InventoryTablePreview,
  type InventoryTablePreviewInput,
  type InventoryTableRowPreview,
  type InventoryTableSha256,
} from './inventory-table-types';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const exactKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 256 &&
  Boolean(value.trim()) &&
  !value.includes('\0');
const issue = (code: string, pointer: string, message: string): InventoryTableIssue => ({
  code,
  pointer,
  message,
});
const sorted = <T extends { readonly key: string }>(rows: readonly T[]): readonly T[] =>
  [...rows].sort((a, b) => order(a.key, b.key));

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validateChoices(options: InventoryTableChoices): readonly InventoryTableIssue[] {
  const issues: InventoryTableIssue[] = [];
  if (
    !exactObject(options, ['namespace', 'delimiter', 'materials', 'locations', 'vessels', 'skips'])
  )
    return [
      issue(
        'TABLE_OPTIONS_INVALID',
        '/options',
        'Table choices require exactly the declared fields.'
      ),
    ];
  if (!exactKey(options.namespace))
    issues.push(
      issue(
        'TABLE_NAMESPACE_INVALID',
        '/options/namespace',
        'Supply an exact nonblank source namespace of at most 256 characters.'
      )
    );
  if (options.delimiter !== ',' && options.delimiter !== '\t')
    issues.push(
      issue('TABLE_DELIMITER_INVALID', '/options/delimiter', 'Select comma or tab explicitly.')
    );
  for (const name of ['materials', 'locations', 'vessels', 'skips'] as const) {
    const values = options[name];
    if (!Array.isArray(values)) {
      issues.push(
        issue(
          'TABLE_OPTIONS_INVALID',
          `/options/${name}`,
          'Table resolutions require an explicit list.'
        )
      );
      continue;
    }
    const keys = new Set<string>();
    for (const [index, value] of values.entries()) {
      const pointer = `/options/${name}/${index}`;
      const key = name === 'skips' ? value?.sourceId : value?.key;
      if (!exactKey(key))
        issues.push(
          issue(
            'TABLE_RESOLUTION_KEY_INVALID',
            pointer,
            'Resolution keys are exact nonblank text of at most 256 characters.'
          )
        );
      else if (keys.has(key))
        issues.push(
          issue(
            'TABLE_RESOLUTION_DUPLICATE',
            pointer,
            `The exact resolution key ${JSON.stringify(key)} repeats.`
          )
        );
      else keys.add(key);
      if (name === 'materials') {
        if (
          !exactObject(value, ['key', 'materialId']) &&
          !exactObject(value, ['key', 'materialId', 'fingerprint'])
        )
          issues.push(
            issue(
              'TABLE_OPTIONS_INVALID',
              pointer,
              'A material choice requires a key and materialId.'
            )
          );
        if (!exactKey(value?.materialId))
          issues.push(
            issue('TABLE_MATERIAL_INVALID', pointer, 'Choose an explicit scientific record.')
          );
        if (
          value &&
          typeof value === 'object' &&
          'fingerprint' in value &&
          (typeof value.fingerprint !== 'string' || !HASH.test(value.fingerprint))
        )
          issues.push(
            issue(
              'TABLE_MATERIAL_INVALID',
              pointer,
              'Resolved scientific records require a SHA-256 fingerprint.'
            )
          );
      } else if (name === 'locations') {
        if (
          !exactObject(value, ['key', 'target']) ||
          (!(exactObject(value.target, ['kind']) && value.target.kind === 'unplaced') &&
            !(
              exactObject(value.target, ['kind', 'storageId']) &&
              value.target.kind === 'storage' &&
              exactKey(value.target.storageId)
            ))
        )
          issues.push(
            issue(
              'TABLE_LOCATION_INVALID',
              pointer,
              'Choose explicit unplaced stock or an existing storage identifier.'
            )
          );
      } else if (name === 'vessels') {
        if (
          !exactObject(value, ['key', 'vesselId']) ||
          typeof value.vesselId !== 'string' ||
          !value.vesselId.trim() ||
          value.vesselId.length > 1024 ||
          value.vesselId.includes('\0')
        )
          issues.push(
            issue(
              'TABLE_VESSEL_INVALID',
              pointer,
              'Choose an explicit existing vessel or permanent well.'
            )
          );
      } else if (
        !exactObject(value, ['sourceId', 'reason']) ||
        typeof value.reason !== 'string' ||
        !value.reason.trim() ||
        value.reason.length > 2000 ||
        value.reason.includes('\0')
      )
        issues.push(
          issue('TABLE_SKIP_INVALID', pointer, 'Skipping a source row requires an explicit reason.')
        );
    }
  }
  return issues;
}

export function inventoryTablePreview(
  state: InventoryState | null,
  input: InventoryTablePreviewInput
): InventoryTablePreview {
  const sourceText = typeof input.sourceText === 'string' ? input.sourceText : '';
  const sourceSha256 = inventoryTableSha256(sourceText);
  const rows: InventoryTableRowPreview[] = [];
  const materialKeys = new Set<string>();
  const locationKeys = new Set<string>();
  const vesselKeys = new Set<string>();
  const issues: InventoryTableIssue[] = [];
  const commands: InventoryCommand[] = [];
  const additions = Object.create(null) as Record<string, InventoryTableBinding>;
  const facts = () => ({
    schema: 'dnaforge.inventory-table-preview.v1' as const,
    sourceSha256,
    target: { ...input.target },
    rows,
    materialKeys: [...materialKeys].sort(order),
    locationKeys: [...locationKeys].sort(order),
    vesselKeys: [...vesselKeys].sort(order),
    bindings: input.bindings,
  });
  const blocked = (): InventoryTablePreview => ({
    ...facts(),
    kind: 'blocked',
    issues,
    commands: [],
    bindingAdditions: {},
    options: null,
    planDigest: null,
  });
  if (
    typeof input.sourceText !== 'string' ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    new TextEncoder().encode(sourceText).byteLength > input.maxBytes
  )
    issues.push(
      issue(
        'TABLE_SOURCE_TOO_LARGE',
        '/sourceText',
        'The exact table must fit the inline native transport byte limit.'
      )
    );
  if (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(sourceText)
    ) !== sourceText
  )
    issues.push(
      issue(
        'TABLE_SOURCE_UTF8_INVALID',
        '/sourceText',
        'The exact table requires valid UTF-8 text.'
      )
    );
  issues.push(...validateChoices(input.options));
  let previous: InventoryState;
  let context: InventoryExecutionContext;
  try {
    previous = state === null ? createInventoryState() : parseInventoryState(state);
    context = parseInventoryExecutionContext({
      at: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
    if (
      !exactKey(input.target.projectId) ||
      !exactKey(input.target.inventoryId) ||
      input.target.present !== (state !== null) ||
      input.target.revision !== previous.revision
    )
      issues.push(
        issue(
          'TABLE_TARGET_CHANGED',
          '/target',
          'The exact target scope, presence and revision must match the inspected inventory.'
        )
      );
  } catch (error) {
    issues.push(
      issue(
        'TABLE_TARGET_INVALID',
        '/target',
        error instanceof Error ? error.message : 'Invalid target inventory or authority.'
      )
    );
    return blocked();
  }
  if (issues.length) return blocked();
  const parsed = parseDelimitedRows(
    sourceText.startsWith('\uFEFF') ? sourceText.slice(1) : sourceText,
    input.options.delimiter
  );
  if (!parsed.ok) {
    issues.push(issue('TABLE_PARSE_INVALID', '/sourceText', parsed.error));
    return blocked();
  }
  const [headers, ...records] = parsed.rows;
  if (
    !headers ||
    headers.length !== INVENTORY_RECEIVE_TABLE_COLUMNS.length ||
    new Set(headers).size !== headers.length ||
    INVENTORY_RECEIVE_TABLE_COLUMNS.some((key) => !headers.includes(key))
  ) {
    issues.push(
      issue(
        'TABLE_HEADERS_INVALID',
        '/sourceText',
        `Use every canonical column exactly once and no other columns: ${INVENTORY_RECEIVE_TABLE_COLUMNS.join(', ')}.`
      )
    );
    return blocked();
  }
  const materialChoices = new Map(input.options.materials.map((value) => [value.key, value]));
  const locationChoices = new Map(input.options.locations.map((value) => [value.key, value]));
  const vesselChoices = new Map(input.options.vessels.map((value) => [value.key, value]));
  const skips = new Map(input.options.skips.map((value) => [value.sourceId, value.reason]));
  const observations = new Map<string, InventoryTableBindingObservation>();
  for (const [index, observation] of input.bindings.entries()) {
    if (
      !observation ||
      !exactKey(observation.key) ||
      observations.has(observation.key) ||
      !materialChoices.has(observation.key) ||
      materialChoices.get(observation.key)!.materialId !== observation.materialId
    ) {
      issues.push(
        issue(
          'TABLE_MATERIAL_OBSERVATION_INVALID',
          `/bindings/${index}`,
          'Scientific admission must match one exact declared material choice.'
        )
      );
    } else observations.set(observation.key, observation);
  }
  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    const rowIssues: InventoryTableIssue[] = [];
    const pointer = `/rows/${index + 2}`;
    const fields =
      record.length === headers.length
        ? (Object.fromEntries(
            headers.map((key, cell) => [key, record[cell]])
          ) as unknown as InventoryReceiveTableFields)
        : null;
    const sourceId = fields?.source_id ?? null;
    if (!fields)
      rowIssues.push(
        issue(
          'TABLE_ROW_WIDTH_INVALID',
          pointer,
          'Every row must contain exactly the declared number of fields.'
        )
      );
    if (!exactKey(sourceId))
      rowIssues.push(
        issue(
          'TABLE_SOURCE_ID_INVALID',
          `${pointer}/source_id`,
          'Every row needs an exact stable source identity.'
        )
      );
    else if (ids.has(sourceId))
      rowIssues.push(
        issue(
          'TABLE_SOURCE_ID_DUPLICATE',
          `${pointer}/source_id`,
          `Source identity ${JSON.stringify(sourceId)} repeats in this file.`
        )
      );
    else ids.add(sourceId);
    const skip = sourceId === null ? undefined : skips.get(sourceId);
    if (skip !== undefined && rowIssues.length === 0) {
      rows.push({
        index: index + 2,
        sourceId,
        fields,
        kind: 'skipped',
        stockId: null,
        vesselId: null,
        reason: skip,
        issues: [],
      });
      continue;
    }
    if (!fields || rowIssues.length) {
      rows.push({
        index: index + 2,
        sourceId,
        fields,
        kind: 'blocked',
        stockId: null,
        vesselId: null,
        reason: null,
        issues: rowIssues,
      });
      issues.push(...rowIssues);
      continue;
    }
    if (fields.material_key) materialKeys.add(fields.material_key);
    if (fields.location_key) locationKeys.add(fields.location_key);
    if (fields.vessel_key) vesselKeys.add(fields.vessel_key);
    const rowIssue = (code: string, field: string, message: string) =>
      rowIssues.push(issue(code, `${pointer}/${field}`, message));
    if (!exactKey(fields.material_key))
      rowIssue(
        'TABLE_MATERIAL_KEY_INVALID',
        'material_key',
        'Supply an exact scientific material key.'
      );
    const material = materialChoices.get(fields.material_key);
    const observation = observations.get(fields.material_key);
    if (
      !material ||
      !observation ||
      observation.kind !== 'admitted' ||
      !HASH.test(observation.fingerprint)
    )
      rowIssue(
        'TABLE_MATERIAL_UNRESOLVED',
        'material_key',
        observation?.kind === 'unavailable'
          ? observation.reason
          : 'Resolve this material key to a currently admitted scientific record.'
      );
    let quantity: InventoryQuantity | null = null;
    if (fields.quantity_kind === 'unknown' && fields.quantity === '' && fields.unit === '')
      quantity = { kind: 'unknown' };
    else if (
      fields.quantity_kind === 'known' &&
      fields.quantity.length <= 128 &&
      new RegExp(INVENTORY_DECIMAL_PATTERN, 'u').test(fields.quantity) &&
      INVENTORY_VOLUME_UNITS.includes(fields.unit as (typeof INVENTORY_VOLUME_UNITS)[number])
    )
      quantity = {
        kind: 'known',
        value: fields.quantity,
        unit: fields.unit as (typeof INVENTORY_VOLUME_UNITS)[number],
      };
    else
      rowIssue(
        'TABLE_QUANTITY_INVALID',
        'quantity',
        'Declare known volume with exact decimal and L, mL, uL or nL; unknown volume requires blank quantity and unit.'
      );
    if (fields.quality !== 'usable' && fields.quality !== 'quarantined')
      rowIssue('TABLE_QUALITY_INVALID', 'quality', 'Declare usable or quarantined explicitly.');
    let destination: InventoryTableBinding['destination'] | null = null;
    let selectedVesselId: string | null = null;
    if (fields.vessel_kind === 'new') {
      if (
        !fields.name.trim() ||
        fields.name.length > 512 ||
        fields.name.includes('\0') ||
        fields.vessel_key !== '' ||
        !exactKey(fields.location_key)
      )
        rowIssue(
          'TABLE_NEW_VESSEL_INVALID',
          'vessel_kind',
          'A new vessel requires a name, blank vessel_key and an explicit location_key.'
        );
      const location = locationChoices.get(fields.location_key);
      let placement: InventoryVesselPlacement | null = null;
      if (location?.target.kind === 'unplaced' && fields.slot === '')
        placement = { kind: 'unplaced' };
      else if (
        location?.target.kind === 'storage' &&
        fields.slot.trim() &&
        fields.slot.length <= 512
      )
        placement = { kind: 'located', storageId: location.target.storageId, slotId: fields.slot };
      else
        rowIssue(
          'TABLE_LOCATION_UNRESOLVED',
          'location_key',
          'Resolve the location explicitly; unplaced requires a blank slot and storage requires an exact slot.'
        );
      if (placement) destination = { kind: 'new-vessel', placement };
    } else if (fields.vessel_kind === 'existing') {
      if (
        !exactKey(fields.vessel_key) ||
        fields.name !== '' ||
        fields.location_key !== '' ||
        fields.slot !== ''
      )
        rowIssue(
          'TABLE_EXISTING_VESSEL_INVALID',
          'vessel_kind',
          'An existing vessel requires a vessel_key and blank name, location_key and slot; this does not rename or move it.'
        );
      selectedVesselId = vesselChoices.get(fields.vessel_key)?.vesselId ?? null;
      if (!selectedVesselId)
        rowIssue(
          'TABLE_VESSEL_UNRESOLVED',
          'vessel_key',
          'Resolve this key to an existing empty vessel or permanent well.'
        );
      destination = { kind: 'existing-vessel' };
    } else
      rowIssue('TABLE_VESSEL_KIND_INVALID', 'vessel_kind', 'Select new or existing explicitly.');
    const bindingKey = inventoryTableBindingKey(input.options.namespace, fields.source_id);
    const existing = Object.hasOwn(previous.tableBindings, bindingKey)
      ? previous.tableBindings[bindingKey]
      : undefined;
    const rowSha256 = inventoryTableSha256(
      inventoryTableCanonicalJson({ format: 'dnaforge.inventory-receive-row.v1', fields })
    );
    let stockId: string | null = existing?.stockId ?? null;
    let vesselId: string | null = existing?.vesselId ?? selectedVesselId;
    let kind: InventoryTableRowPreview['kind'] = 'blocked';
    if (existing && destination && material) {
      if (
        existing.rowSha256 !== rowSha256 ||
        existing.materialId !== material.materialId ||
        inventoryTableCanonicalJson(existing.destination) !==
          inventoryTableCanonicalJson(destination) ||
        (destination.kind === 'existing-vessel' && existing.vesselId !== selectedVesselId)
      )
        rowIssue(
          'TABLE_ROW_NEEDS_RECONCILIATION',
          'source_id',
          'This source identity is already bound and its source facts or resolutions changed. Resolve it through explicit reconciliation.'
        );
      else kind = 'unchanged';
    } else if (!existing && destination && material && quantity && rowIssues.length === 0) {
      const generated = inventoryTableRecordIds(
        input.target,
        input.options.namespace,
        fields.source_id
      );
      stockId = generated.stockId;
      vesselId = destination.kind === 'new-vessel' ? generated.vesselId : selectedVesselId;
      if (
        inventoryRecordIdExists(previous, stockId) ||
        (destination.kind === 'new-vessel' && inventoryRecordIdExists(previous, generated.vesselId))
      )
        rowIssue(
          'TABLE_ID_OCCUPIED',
          'source_id',
          'A generated physical identifier is occupied without this source binding. Choose a distinct source namespace or reconcile explicitly.'
        );
      else if (vesselId) {
        kind = 'create';
        if (destination.kind === 'new-vessel')
          commands.push({
            kind: 'create-vessel',
            id: vesselId,
            name: fields.name,
            placement: destination.placement,
          });
        commands.push({
          kind: 'receive-stock',
          id: stockId,
          vesselId,
          materialId: material.materialId,
          quantity,
          quality: fields.quality as 'usable' | 'quarantined',
        });
        additions[bindingKey] = {
          namespace: input.options.namespace,
          sourceId: fields.source_id,
          rowSha256,
          stockId,
          vesselId,
          materialId: material.materialId,
          destination,
        };
      }
    }
    if (rowIssues.length) kind = 'blocked';
    rows.push({
      index: index + 2,
      sourceId,
      fields,
      kind,
      stockId,
      vesselId,
      reason: null,
      issues: rowIssues,
    });
    issues.push(...rowIssues);
  }
  for (const [name, choices, required] of [
    ['materials', input.options.materials, materialKeys],
    ['locations', input.options.locations, locationKeys],
    ['vessels', input.options.vessels, vesselKeys],
  ] as const)
    for (const choice of choices)
      if (!required.has(choice.key))
        issues.push(
          issue(
            'TABLE_RESOLUTION_UNUSED',
            `/options/${name}`,
            `The exact key ${JSON.stringify(choice.key)} is not used by a non-skipped row.`
          )
        );
  for (const skip of input.options.skips)
    if (!ids.has(skip.sourceId))
      issues.push(
        issue(
          'TABLE_SKIP_UNUSED',
          '/options/skips',
          `Source identity ${JSON.stringify(skip.sourceId)} is not present in this file.`
        )
      );
  if (commands.length > MAX_INVENTORY_BATCH_COMMANDS)
    issues.push(
      issue(
        'TABLE_BATCH_TOO_LARGE',
        '/rows',
        `This atomic proposal needs ${commands.length} commands; the existing batch limit is ${MAX_INVENTORY_BATCH_COMMANDS}. It will not be split.`
      )
    );
  if (issues.length) return blocked();
  const resolvedMaterials: InventoryResolvedTableOptions['materials'][number][] = [];
  for (const choice of sorted(input.options.materials)) {
    const observation = observations.get(choice.key);
    if (!observation || observation.kind !== 'admitted')
      throw new Error('Admitted table material missing.');
    resolvedMaterials.push({ ...choice, fingerprint: observation.fingerprint });
  }
  const options: InventoryResolvedTableOptions = {
    namespace: input.options.namespace,
    delimiter: input.options.delimiter,
    materials: resolvedMaterials,
    locations: sorted(input.options.locations),
    vessels: sorted(input.options.vessels),
    skips: [...input.options.skips].sort((a, b) => order(a.sourceId, b.sourceId)),
  };
  if (!commands.length)
    return {
      ...facts(),
      kind: 'no-change',
      issues: [],
      commands: [],
      bindingAdditions: {},
      options,
      planDigest: null,
    };
  const transition = applyInventoryCommandBatch(
    previous,
    { expectedRevision: previous.revision, commands },
    context
  );
  if (!transition.ok) {
    issues.push(issue(transition.code, '/commands', transition.message));
    return blocked();
  }
  try {
    parseInventoryState({
      ...transition.state,
      tableBindings: { ...previous.tableBindings, ...additions },
    });
  } catch (error) {
    issues.push(
      issue(
        'TABLE_BINDING_INVALID',
        '/bindingAdditions',
        error instanceof Error ? error.message : 'Invalid table binding.'
      )
    );
    return blocked();
  }
  const planDigest = inventoryTableSha256(
    inventoryTableCanonicalJson({
      format: 'dnaforge.inventory-receive-table.v1',
      sourceSha256,
      target: input.target,
      options,
      commands,
      bindingAdditions: additions,
    })
  );
  return {
    ...facts(),
    kind: 'ready',
    issues: [],
    commands,
    bindingAdditions: additions,
    options,
    planDigest,
  };
}

export function applyInventoryTable(
  state: InventoryState | null,
  application: InventoryTableApplication,
  context: InventoryExecutionContext,
  maxBytes: number
): InventoryTransition {
  const preview = inventoryTablePreview(state, {
    ...application,
    bindings: application.options.materials.map((value) => ({
      ...value,
      kind: 'admitted' as const,
    })),
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes,
  });
  if (preview.kind !== 'ready' || preview.planDigest !== application.expectedPlanDigest)
    return {
      ok: false,
      code: 'INVALID_INVENTORY_INPUT',
      message:
        preview.kind === 'blocked'
          ? (preview.issues[0]?.message ?? 'The table proposal is blocked.')
          : 'The table plan changed or contains no new stock. Preview it again.',
    };
  const previous = state ?? createInventoryState();
  const result = applyInventoryCommandBatch(
    previous,
    { expectedRevision: application.target.revision, commands: preview.commands },
    context
  );
  if (!result.ok) return result;
  return {
    ok: true,
    state: parseInventoryState({
      ...result.state,
      tableBindings: { ...previous.tableBindings, ...preview.bindingAdditions },
    }),
  };
}
