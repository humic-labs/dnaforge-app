import { inventoryAvailability } from './inventory-reservations';
import { inventoryItemCustody } from './inventory-custody';
import { inventoryTableChoiceIssues } from './inventory-table';
import {
  inventoryReceiveSourceKey,
  inventoryReceiveTableFieldIssues,
  inventoryReceiveTableRowSha256,
  parseInventoryReceiveTableSource,
} from './inventory-receive-source';
import {
  inventoryTableBindingKey,
  inventoryTableCanonicalJson,
  inventoryTableSha256,
  inventoryTableSourceBaseline,
} from './inventory-table-binding';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import {
  createInventoryState,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryTransition,
} from './inventory-types';
import type {
  InventoryReceiveTableFields,
  InventoryTableBinding,
  InventoryTableIssue,
} from './inventory-table-types';
import type {
  InventoryResolvedSourceRevisionOptions,
  InventorySourceRevisionAcknowledgement,
  InventorySourceRevisionApplication,
  InventorySourceRevisionPreimage,
  InventorySourceRevisionPreview,
  InventorySourceRevisionPreviewInput,
  InventorySourceRevisionRowPreview,
} from './inventory-source-revision-types';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = <T extends { readonly key: string }>(rows: readonly T[]): readonly T[] =>
  [...rows].sort((a, b) => order(a.key, b.key));
const exactObject = (value: unknown, keys: readonly string[]): boolean =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
const issue = (code: string, pointer: string, message: string): InventoryTableIssue => ({
  code,
  pointer,
  message,
});

export function inventorySourceRevisionPreview(
  state: InventoryState | null,
  input: InventorySourceRevisionPreviewInput
): InventorySourceRevisionPreview {
  const sourceText = typeof input.sourceText === 'string' ? input.sourceText : '';
  const sourceSha256 = inventoryTableSha256(sourceText);
  const rows: InventorySourceRevisionRowPreview[] = [];
  const issues: InventoryTableIssue[] = [];
  const materialKeys = new Set<string>();
  const locationKeys = new Set<string>();
  const vesselKeys = new Set<string>();
  const facts = () => ({
    schema: 'dnaforge.inventory-source-revision-preview.v1' as const,
    sourceSha256,
    target: { ...input.target },
    rows,
    materialKeys: [...materialKeys].sort(order),
    locationKeys: [...locationKeys].sort(order),
    vesselKeys: [...vesselKeys].sort(order),
  });
  const blocked = (): InventorySourceRevisionPreview => ({
    ...facts(),
    kind: 'blocked',
    issues,
    options: null,
    planDigest: null,
  });
  const optionKeys =
    input.options && typeof input.options === 'object' && 'preimages' in input.options
      ? ['table', 'acknowledgements', 'preimages']
      : ['table', 'acknowledgements'];
  if (!exactObject(input.options, optionKeys) || !Array.isArray(input.options.acknowledgements)) {
    issues.push(
      issue(
        'SOURCE_REVISION_OPTIONS_INVALID',
        '/options',
        'Supply explicit table resolutions and acknowledgement choices.'
      )
    );
    return blocked();
  }
  const tableIssues = inventoryTableChoiceIssues(input.options.table);
  if (tableIssues.length) {
    issues.push(...tableIssues);
    return blocked();
  }
  if (
    input.options.table.materials.some((material) => !exactObject(material, ['key', 'materialId']))
  ) {
    issues.push(
      issue(
        'SOURCE_REVISION_OPTIONS_INVALID',
        '/options/table/materials',
        'Source acknowledgement resolves existing scientific identity without authored admission fingerprints.'
      )
    );
    return blocked();
  }
  const parsed = parseInventoryReceiveTableSource(
    sourceText,
    input.options.table.delimiter,
    input.maxBytes
  );
  if (parsed.issues.length) {
    issues.push(...parsed.issues);
    return blocked();
  }
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
      !inventoryReceiveSourceKey(input.target.projectId) ||
      !inventoryReceiveSourceKey(input.target.inventoryId) ||
      input.target.present !== (state !== null) ||
      input.target.revision !== previous.revision
    )
      issues.push(
        issue(
          'SOURCE_REVISION_TARGET_CHANGED',
          '/target',
          'The target scope, presence and revision must match current inventory.'
        )
      );
    if (context.at < previous.lastRecordedAt)
      issues.push(
        issue('CLOCK_REGRESSION', '/asOf', 'The native recorded time precedes the inventory clock.')
      );
  } catch (error) {
    issues.push(
      issue(
        'SOURCE_REVISION_TARGET_INVALID',
        '/target',
        error instanceof Error ? error.message : 'The target inventory or native actor is invalid.'
      )
    );
    return blocked();
  }
  if (issues.length) return blocked();
  const acknowledgements = new Map<string, InventorySourceRevisionAcknowledgement>();
  for (const [index, acknowledgement] of input.options.acknowledgements.entries()) {
    if (
      !exactObject(acknowledgement, ['sourceId', 'expectedPreviousRowSha256', 'reason']) ||
      !inventoryReceiveSourceKey(acknowledgement.sourceId) ||
      acknowledgements.has(acknowledgement.sourceId)
    ) {
      issues.push(
        issue(
          'SOURCE_REVISION_ACK_INVALID',
          `/options/acknowledgements/${index}`,
          'Each acknowledgement needs one exact source identity, expected baseline hash and reason.'
        )
      );
    } else acknowledgements.set(acknowledgement.sourceId, acknowledgement);
  }
  const preimages = new Map<string, InventoryReceiveTableFields>();
  if (!Array.isArray(input.preimages)) {
    issues.push(
      issue(
        'SOURCE_REVISION_PREIMAGES_INVALID',
        '/preimages',
        'Verified previous source rows require an explicit list.'
      )
    );
    return blocked();
  }
  for (const [index, preimage] of input.preimages.entries()) {
    if (
      !exactObject(preimage, ['sourceId', 'fields']) ||
      !inventoryReceiveSourceKey(preimage.sourceId) ||
      preimages.has(preimage.sourceId) ||
      inventoryReceiveTableFieldIssues(preimage.fields).length ||
      preimage.fields.source_id !== preimage.sourceId
    )
      issues.push(
        issue(
          'SOURCE_REVISION_PREIMAGE_INVALID',
          `/preimages/${index}`,
          'A previous source row must contain verified canonical fields for one exact source identity.'
        )
      );
    else preimages.set(preimage.sourceId, preimage.fields);
  }
  const materials = new Map(input.options.table.materials.map((row) => [row.key, row.materialId]));
  const locations = new Map(input.options.table.locations.map((row) => [row.key, row.target]));
  const vessels = new Map(input.options.table.vessels.map((row) => [row.key, row.vesselId]));
  const skips = new Map(input.options.table.skips.map((row) => [row.sourceId, row.reason]));
  const availability = inventoryAvailability(previous, context.principal, context.at);
  const sourceIds = new Set<string>();
  const resolvedPreimages: InventorySourceRevisionPreimage[] = [];
  let proposedCount = 0;
  for (const parsedRow of parsed.rows) {
    const rowIssues = [...parsedRow.issues];
    const { index, fields, sourceId } = parsedRow;
    if (sourceId !== null) sourceIds.add(sourceId);
    const pointer = `/rows/${index}`;
    const add = (code: string, message: string) => rowIssues.push(issue(code, pointer, message));
    const row: InventorySourceRevisionRowPreview = {
      index,
      sourceId,
      bindingKey: null,
      kind: 'blocked',
      previousRowSha256: null,
      previousFields: null,
      revisedFields: fields,
      binding: null,
      destination: null,
      actual: null,
      reason: null,
      issues: rowIssues,
    };
    const acknowledgement = sourceId === null ? undefined : acknowledgements.get(sourceId);
    const skip = sourceId === null ? undefined : skips.get(sourceId);
    if (skip !== undefined && !rowIssues.length) {
      if (acknowledgement)
        add(
          'SOURCE_REVISION_ACK_SKIP_CONFLICT',
          'A source row cannot be both skipped and acknowledged.'
        );
      rows.push({ ...row, kind: rowIssues.length ? 'blocked' : 'skipped', reason: skip });
      issues.push(...rowIssues);
      continue;
    }
    if (!fields || !sourceId || rowIssues.length) {
      rows.push(row);
      issues.push(...rowIssues);
      continue;
    }
    rowIssues.push(...inventoryReceiveTableFieldIssues(fields, pointer));
    if (fields.material_key) materialKeys.add(fields.material_key);
    if (fields.location_key) locationKeys.add(fields.location_key);
    if (fields.vessel_key) vesselKeys.add(fields.vessel_key);
    const key = inventoryTableBindingKey(input.options.table.namespace, sourceId);
    const binding = Object.hasOwn(previous.tableBindings, key) ? previous.tableBindings[key] : null;
    if (!binding) {
      add(
        'SOURCE_REVISION_UNBOUND',
        'This acknowledgement mode only accepts existing source bindings. Receive new stock separately or explicitly skip this row.'
      );
      rows.push({ ...row, bindingKey: key });
      issues.push(...rowIssues);
      continue;
    }
    const baseline = inventoryTableSourceBaseline(binding);
    const rowHash = inventoryReceiveTableRowSha256(fields);
    const saved = binding.sourceRevisions.at(-1)?.fields;
    const supplied = preimages.get(sourceId);
    let previousFields = saved ?? supplied ?? (rowHash === baseline.rowSha256 ? fields : null);
    if (supplied && inventoryReceiveTableRowSha256(supplied) !== baseline.rowSha256)
      add(
        'SOURCE_REVISION_PREIMAGE_CHANGED',
        'The supplied previous source fields do not match the effective baseline hash.'
      );
    if (!previousFields || inventoryReceiveTableRowSha256(previousFields) !== baseline.rowSha256) {
      previousFields = null;
      add(
        'SOURCE_REVISION_PREIMAGE_UNAVAILABLE',
        'Previous source fields are unavailable. Current inventory cannot substitute for the missing source evidence.'
      );
    }
    if (previousFields) resolvedPreimages.push({ sourceId, fields: previousFields });
    const materialId = materials.get(fields.material_key);
    if (!materialId)
      add(
        'SOURCE_REVISION_MATERIAL_UNRESOLVED',
        'Resolve this source material key explicitly to its already bound scientific identity.'
      );
    else if (materialId !== binding.materialId)
      add('SOURCE_REVISION_IDENTITY_CHANGED', 'Acknowledgement cannot rebind scientific identity.');
    let destination: InventoryTableBinding['destination'] | null = null;
    if (fields.vessel_kind === 'new') {
      const location = locations.get(fields.location_key);
      if (location?.kind === 'unplaced' && fields.slot === '')
        destination = { kind: 'new-vessel', placement: { kind: 'unplaced' } };
      else if (
        location?.kind === 'storage' &&
        fields.slot.trim() &&
        Object.hasOwn(previous.storage, location.storageId)
      )
        destination = {
          kind: 'new-vessel',
          placement: { kind: 'located', storageId: location.storageId, slotId: fields.slot },
        };
      else
        add(
          'SOURCE_REVISION_LOCATION_UNRESOLVED',
          'Resolve the source location to explicit unplaced or known storage with an exact source slot.'
        );
    } else if (fields.vessel_kind === 'existing') {
      destination = { kind: 'existing-vessel' };
      const vesselId = vessels.get(fields.vessel_key);
      if (!vesselId)
        add('SOURCE_REVISION_VESSEL_UNRESOLVED', 'Resolve this source vessel alias explicitly.');
      else if (vesselId !== binding.vesselId)
        add(
          'SOURCE_REVISION_IDENTITY_CHANGED',
          'Acknowledgement cannot replace the bound physical vessel.'
        );
    }
    if (destination && destination.kind !== binding.destination.kind)
      add(
        'SOURCE_REVISION_IDENTITY_CHANGED',
        'Acknowledgement cannot change between a new and an existing vessel binding.'
      );
    const actual = {
      stock: previous.stocks[binding.stockId],
      vessel: previous.vessels[binding.vesselId],
      custody: inventoryItemCustody(
        previous,
        { kind: 'vessel', id: binding.vesselId },
        context.principal,
        context.at
      ),
      availability: availability.stocks[binding.stockId],
    };
    const unchanged =
      rowHash === baseline.rowSha256 &&
      destination !== null &&
      inventoryTableCanonicalJson(destination) ===
        inventoryTableCanonicalJson(baseline.destination);
    let kind: InventorySourceRevisionRowPreview['kind'] = unchanged
      ? 'unchanged'
      : 'needs-acknowledgement';
    if (acknowledgement) {
      if (
        typeof acknowledgement.expectedPreviousRowSha256 !== 'string' ||
        !HASH.test(acknowledgement.expectedPreviousRowSha256) ||
        acknowledgement.expectedPreviousRowSha256 !== baseline.rowSha256
      )
        add(
          'SOURCE_REVISION_BASELINE_CHANGED',
          'The expected previous row hash no longer matches. Compare the source again.'
        );
      if (
        typeof acknowledgement.reason !== 'string' ||
        !acknowledgement.reason.trim() ||
        acknowledgement.reason.length > 2000 ||
        acknowledgement.reason.includes('\0')
      )
        add(
          'SOURCE_REVISION_REASON_REQUIRED',
          'Acknowledging a source revision requires an explicit reason of at most 2000 characters.'
        );
      if (!unchanged) kind = 'proposed';
    }
    if (rowIssues.length) kind = 'blocked';
    if (kind === 'proposed') proposedCount++;
    rows.push({
      ...row,
      bindingKey: key,
      kind,
      previousRowSha256: baseline.rowSha256,
      previousFields,
      binding,
      destination,
      actual,
      reason: acknowledgement?.reason ?? null,
    });
    issues.push(...rowIssues);
  }
  for (const [name, choices, required] of [
    ['materials', input.options.table.materials, materialKeys],
    ['locations', input.options.table.locations, locationKeys],
    ['vessels', input.options.table.vessels, vesselKeys],
  ] as const)
    for (const choice of choices)
      if (!required.has(choice.key))
        issues.push(
          issue(
            'TABLE_RESOLUTION_UNUSED',
            `/options/table/${name}`,
            `The exact key ${JSON.stringify(choice.key)} is not used by a non-skipped row.`
          )
        );
  for (const skip of input.options.table.skips)
    if (!sourceIds.has(skip.sourceId))
      issues.push(
        issue(
          'TABLE_SKIP_UNUSED',
          '/options/table/skips',
          'A skipped source identity is not present in this table.'
        )
      );
  for (const [sourceId] of acknowledgements)
    if (!sourceIds.has(sourceId))
      issues.push(
        issue(
          'SOURCE_REVISION_ACK_UNUSED',
          '/options/acknowledgements',
          'An acknowledged source identity is not present in this table.'
        )
      );
  for (const [sourceId] of preimages)
    if (!sourceIds.has(sourceId) || skips.has(sourceId))
      issues.push(
        issue(
          'SOURCE_REVISION_PREIMAGE_UNUSED',
          '/preimages',
          'A previous source row must belong to a non-skipped row in this table.'
        )
      );
  if (proposedCount > MAX_INVENTORY_BATCH_COMMANDS)
    issues.push(
      issue(
        'SOURCE_REVISION_BATCH_TOO_LARGE',
        '/rows',
        `A source acknowledgement supports at most ${MAX_INVENTORY_BATCH_COMMANDS} changes in one atomic operation; no automatic splitting occurs.`
      )
    );
  if (issues.length) return blocked();
  if (rows.some((row) => row.kind === 'needs-acknowledgement'))
    return {
      ...facts(),
      kind: 'needs-acknowledgement',
      issues: [],
      options: null,
      planDigest: null,
    };
  const options: InventoryResolvedSourceRevisionOptions = {
    table: {
      namespace: input.options.table.namespace,
      delimiter: input.options.table.delimiter,
      materials: sorted(input.options.table.materials),
      locations: sorted(input.options.table.locations),
      vessels: sorted(input.options.table.vessels),
      skips: [...input.options.table.skips].sort((a, b) => order(a.sourceId, b.sourceId)),
    },
    acknowledgements: [...input.options.acknowledgements].sort((a, b) =>
      order(a.sourceId, b.sourceId)
    ),
    preimages: resolvedPreimages.sort((a, b) => order(a.sourceId, b.sourceId)),
  };
  if (!proposedCount)
    return { ...facts(), kind: 'no-change', issues: [], options, planDigest: null };
  if (previous.revision === Number.MAX_SAFE_INTEGER) {
    issues.push(
      issue('REVISION_EXHAUSTED', '/target', 'The inventory revision cannot advance safely.')
    );
    return blocked();
  }
  const planDigest = inventoryTableSha256(
    inventoryTableCanonicalJson({
      format: 'dnaforge.inventory-source-revision-plan.v1',
      sourceSha256,
      target: input.target,
      options,
      changes: rows
        .filter((row) => row.kind === 'proposed')
        .map((row) => ({
          bindingKey: row.bindingKey,
          previousRowSha256: row.previousRowSha256,
          fields: row.revisedFields,
          destination: row.destination,
          reason: row.reason,
        })),
    })
  );
  return { ...facts(), kind: 'ready', issues: [], options, planDigest };
}

export function applyInventorySourceRevision(
  state: InventoryState | null,
  input: InventorySourceRevisionApplication,
  context: InventoryExecutionContext,
  maxBytes: number
): InventoryTransition {
  const preview = inventorySourceRevisionPreview(state, {
    ...input,
    preimages: input.options.preimages,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes,
  });
  if (preview.kind !== 'ready')
    return {
      ok: false,
      code: 'INVALID_INVENTORY_INPUT',
      message:
        preview.kind === 'blocked'
          ? (preview.issues[0]?.message ?? 'The source revision is blocked.')
          : 'No fully acknowledged source changes are ready.',
    };
  if (
    preview.planDigest !== input.expectedPlanDigest ||
    inventoryTableCanonicalJson(preview.options) !== inventoryTableCanonicalJson(input.options)
  )
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      message:
        'The source, resolutions, previous fields or target changed. Compare the source again.',
    };
  const previous = state === null ? createInventoryState() : parseInventoryState(state);
  const tableBindings = Object.assign(Object.create(null), previous.tableBindings) as Record<
    string,
    InventoryTableBinding
  >;
  for (const row of preview.rows) {
    if (
      row.kind !== 'proposed' ||
      !row.binding ||
      !row.bindingKey ||
      !row.previousRowSha256 ||
      !row.revisedFields ||
      !row.destination ||
      !row.reason
    )
      continue;
    tableBindings[row.bindingKey] = {
      ...row.binding,
      sourceRevisions: [
        ...row.binding.sourceRevisions,
        {
          previousRowSha256: row.previousRowSha256,
          rowSha256: inventoryReceiveTableRowSha256(row.revisedFields),
          fields: { ...row.revisedFields },
          destination: row.destination,
          reason: row.reason,
          at: context.at,
          by: context.principal,
        },
      ],
    };
  }
  return {
    ok: true,
    state: parseInventoryState({
      ...previous,
      revision: previous.revision + 1,
      lastRecordedAt: context.at,
      tableBindings,
    }),
  };
}
