import { parseDelimitedRows } from '@waypoint/scientific-objects/delimited-rows';
import { applyInventoryCommandBatch } from './inventory-state';
import { inventoryAvailability } from './inventory-reservations';
import { inventoryItemCustody } from './inventory-custody';
import { inventoryObservationKey } from './inventory-observation-identity';
import { inventoryTableCanonicalJson, inventoryTableSha256 } from './inventory-table-binding';
import { normalizeInventoryVolume } from './inventory-volume';
import {
  parseInventoryCommand,
  parseInventoryExecutionContext,
  parseInventoryState,
} from './inventory-validation';
import {
  createInventoryState,
  INVENTORY_DECIMAL_PATTERN,
  INVENTORY_VOLUME_UNITS,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryCommand,
  type InventoryCustodyDestination,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryTransition,
} from './inventory-types';
import type {
  InventoryObservationInput,
  InventoryObservationSubject,
} from './inventory-observation-types';
import {
  INVENTORY_STOCKTAKE_COLUMNS,
  type InventoryStocktakeApplication,
  type InventoryStocktakeChoices,
  type InventoryStocktakeFields,
  type InventoryStocktakeIssue,
  type InventoryStocktakePreview,
  type InventoryStocktakePreviewInput,
  type InventoryStocktakeRowPreview,
  type InventoryStocktakeSubjectSnapshot,
} from './inventory-stocktake-types';

const exactKey = (value: unknown, max = 256): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  Boolean(value.trim()) &&
  !value.includes('\0');
const exactObject = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
const issue = (code: string, pointer: string, message: string): InventoryStocktakeIssue => ({
  code,
  pointer,
  message,
});
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = <T extends { readonly key: string }>(values: readonly T[]) =>
  [...values].sort((a, b) => order(a.key, b.key));

function validSubject(value: unknown): value is InventoryObservationSubject {
  if (exactObject(value, ['kind', 'stockId']))
    return value.kind === 'stock' && exactKey(value.stockId);
  return (
    exactObject(value, ['kind', 'item']) &&
    value.kind === 'item' &&
    exactObject(value.item, ['kind', 'id']) &&
    (value.item.kind === 'storage' || value.item.kind === 'vessel') &&
    exactKey(value.item.id, value.item.kind === 'vessel' ? 1024 : 256)
  );
}

function validateChoices(options: InventoryStocktakeChoices): readonly InventoryStocktakeIssue[] {
  const issues: InventoryStocktakeIssue[] = [];
  if (!exactObject(options, ['namespace', 'delimiter', 'subjects', 'locations', 'decisions']))
    return [
      issue(
        'STOCKTAKE_OPTIONS_INVALID',
        '/options',
        'Stocktake choices require exactly the declared fields.'
      ),
    ];
  if (!exactKey(options.namespace))
    issues.push(
      issue(
        'STOCKTAKE_NAMESPACE_INVALID',
        '/options/namespace',
        'Choose an exact nonblank source namespace.'
      )
    );
  if (options.delimiter !== ',' && options.delimiter !== '\t')
    issues.push(
      issue('STOCKTAKE_DELIMITER_INVALID', '/options/delimiter', 'Choose comma or tab explicitly.')
    );
  for (const name of ['subjects', 'locations', 'decisions'] as const) {
    const values = options[name];
    if (!Array.isArray(values)) {
      issues.push(
        issue(
          'STOCKTAKE_OPTIONS_INVALID',
          `/options/${name}`,
          'Resolutions require explicit lists.'
        )
      );
      continue;
    }
    const keys = new Set<string>();
    for (const [index, value] of values.entries()) {
      const pointer = `/options/${name}/${index}`;
      const key = name === 'decisions' ? value?.observationId : value?.key;
      if (!exactKey(key) || keys.has(key))
        issues.push(
          issue(
            'STOCKTAKE_RESOLUTION_KEY_INVALID',
            pointer,
            'Resolution identities must be exact, nonblank and unique.'
          )
        );
      else keys.add(key);
      if (name === 'subjects') {
        if (!exactObject(value, ['key', 'subject']) || !validSubject(value.subject))
          issues.push(
            issue(
              'STOCKTAKE_SUBJECT_INVALID',
              pointer,
              'Select an explicit stock or physical item.'
            )
          );
      } else if (name === 'locations') {
        if (
          !exactObject(value, ['key', 'target']) ||
          !(
            (exactObject(value.target, ['kind']) &&
              (value.target.kind === 'root' || value.target.kind === 'unplaced')) ||
            (exactObject(value.target, ['kind', 'storageId']) &&
              value.target.kind === 'storage' &&
              exactKey(value.target.storageId)) ||
            (exactObject(value.target, ['kind', 'stackId']) &&
              value.target.kind === 'stack-top' &&
              exactKey(value.target.stackId))
          )
        )
          issues.push(
            issue(
              'STOCKTAKE_LOCATION_INVALID',
              pointer,
              'Select an explicit root, unplaced, storage or stack-top destination.'
            )
          );
      } else if (
        !exactObject(value, ['observationId', 'choice']) ||
        !(
          (exactObject(value.choice, ['kind']) && value.choice.kind === 'record-only') ||
          (exactObject(value.choice, ['kind', 'reason']) &&
            (value.choice.kind === 'apply' || value.choice.kind === 'skip') &&
            exactKey(value.choice.reason, 2000))
        )
      )
        issues.push(
          issue(
            'STOCKTAKE_DECISION_INVALID',
            pointer,
            'Choose record only, apply with a reason, or skip with a reason.'
          )
        );
    }
  }
  return issues;
}

const observationInput = (value: InventoryObservationInput): InventoryObservationInput => ({
  namespace: value.namespace,
  observationId: value.observationId,
  subject: value.subject,
  fact:
    value.fact.kind === 'quantity' &&
    value.fact.quantity.kind === 'unknown' &&
    'unit' in value.fact.quantity &&
    value.fact.quantity.unit === 'uL'
      ? { kind: 'quantity', quantity: { kind: 'unknown' } }
      : value.fact,
  observedAt: value.observedAt,
  reason: value.reason,
});

export function inventoryStocktakePreview(
  state: InventoryState | null,
  input: InventoryStocktakePreviewInput
): InventoryStocktakePreview {
  const sourceText = typeof input.sourceText === 'string' ? input.sourceText : '';
  const sourceSha256 = inventoryTableSha256(sourceText);
  const rows: InventoryStocktakeRowPreview[] = [];
  const subjectKeys = new Set<string>();
  const locationKeys = new Set<string>();
  const issues: InventoryStocktakeIssue[] = [];
  const commands: InventoryCommand[] = [];
  const facts = () => ({
    schema: 'dnaforge.inventory-stocktake-preview.v1' as const,
    sourceSha256,
    target: { ...input.target },
    subjectKeys: [...subjectKeys].sort(order),
    locationKeys: [...locationKeys].sort(order),
    rows,
  });
  const blocked = (): InventoryStocktakePreview => ({
    ...facts(),
    kind: 'blocked',
    issues,
    commands: [],
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
        'STOCKTAKE_SOURCE_TOO_LARGE',
        '/sourceText',
        'The exact source must fit the inline native transport limit.'
      )
    );
  if (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(sourceText)
    ) !== sourceText
  )
    issues.push(
      issue(
        'STOCKTAKE_SOURCE_UTF8_INVALID',
        '/sourceText',
        'The exact source requires valid UTF-8 text.'
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
          'STOCKTAKE_TARGET_CHANGED',
          '/target',
          'The target presence, scope and revision must match the inspected inventory.'
        )
      );
    if (context.at < previous.lastRecordedAt)
      issues.push(
        issue(
          'CLOCK_REGRESSION',
          '/asOf',
          'Native recording time precedes the inventory clock floor.'
        )
      );
  } catch (error) {
    issues.push(
      issue(
        'STOCKTAKE_TARGET_INVALID',
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
    issues.push(issue('STOCKTAKE_PARSE_INVALID', '/sourceText', parsed.error));
    return blocked();
  }
  const [headers, ...records] = parsed.rows;
  if (
    !headers ||
    headers.length !== INVENTORY_STOCKTAKE_COLUMNS.length ||
    new Set(headers).size !== headers.length ||
    INVENTORY_STOCKTAKE_COLUMNS.some((column) => !headers.includes(column))
  ) {
    issues.push(
      issue(
        'STOCKTAKE_HEADERS_INVALID',
        '/sourceText',
        `Use every stocktake column exactly once and no others: ${INVENTORY_STOCKTAKE_COLUMNS.join(', ')}.`
      )
    );
    return blocked();
  }
  const subjects = new Map(input.options.subjects.map((value) => [value.key, value.subject]));
  const locations = new Map(input.options.locations.map((value) => [value.key, value.target]));
  const decisions = new Map(
    input.options.decisions.map((value) => [value.observationId, value.choice])
  );
  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    const pointer = `/rows/${index + 2}`;
    const rowIssues: InventoryStocktakeIssue[] = [];
    const rowIssue = (code: string, field: string, message: string) =>
      rowIssues.push(issue(code, `${pointer}/${field}`, message));
    const fields =
      record.length === headers.length
        ? (Object.fromEntries(
            headers.map((header, cell) => [header, record[cell]])
          ) as unknown as InventoryStocktakeFields)
        : null;
    const observationId = fields?.observation_id ?? null;
    const row: InventoryStocktakeRowPreview = {
      index: index + 2,
      observationId,
      observationKey: null,
      fields,
      kind: 'blocked',
      subject: null,
      fact: null,
      observedAt: null,
      existing: null,
      before: null,
      after: null,
      issues: rowIssues,
    };
    if (!fields)
      rowIssue(
        'STOCKTAKE_ROW_WIDTH_INVALID',
        '',
        'Every row requires exactly the declared fields.'
      );
    if (!exactKey(observationId))
      rowIssue(
        'STOCKTAKE_ID_INVALID',
        'observation_id',
        'Supply an exact nonblank stable observation identity.'
      );
    else if (ids.has(observationId))
      rowIssue(
        'STOCKTAKE_ID_DUPLICATE',
        'observation_id',
        'The observation identity repeats in this source.'
      );
    else ids.add(observationId);
    const choice = observationId === null ? undefined : decisions.get(observationId);
    if (choice?.kind === 'skip' && !rowIssues.length) {
      rows.push({ ...row, kind: 'skipped' });
      continue;
    }
    if (!fields || rowIssues.length) {
      rows.push(row);
      issues.push(...rowIssues);
      continue;
    }
    if (fields.subject_key) subjectKeys.add(fields.subject_key);
    if (fields.location_key) locationKeys.add(fields.location_key);
    const subject = subjects.get(fields.subject_key) ?? null;
    if (!exactKey(fields.subject_key) || !subject)
      rowIssue(
        'STOCKTAKE_SUBJECT_UNRESOLVED',
        'subject_key',
        'Resolve this key to one explicit inventory stock or physical item.'
      );
    if (!choice)
      rowIssue(
        'STOCKTAKE_DECISION_UNRESOLVED',
        'observation_id',
        'Choose record only, apply with a reason, or skip with a reason.'
      );
    let observedAt: number | null = null;
    if (fields.observed_at !== 'unknown') {
      const parsedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(fields.observed_at)
        ? Date.parse(fields.observed_at)
        : NaN;
      if (
        !Number.isSafeInteger(parsedAt) ||
        parsedAt < 0 ||
        new Date(parsedAt).toISOString() !== fields.observed_at
      )
        rowIssue(
          'STOCKTAKE_TIME_INVALID',
          'observed_at',
          'Use unknown or an exact UTC ISO timestamp with milliseconds.'
        );
      else if (parsedAt > context.at)
        rowIssue(
          'OBSERVATION_TIME_FUTURE',
          'observed_at',
          'An observation cannot follow native recording time.'
        );
      else observedAt = parsedAt;
    }
    let fact: InventoryObservationInput['fact'] | null = null;
    if (subject?.kind === 'stock') {
      if (fields.presence !== 'not-observed' || fields.location_key !== '' || fields.slot !== '')
        rowIssue(
          'STOCKTAKE_STOCK_FIELDS_INVALID',
          'presence',
          'A stock quantity observation requires presence=not-observed and empty location fields.'
        );
      if (fields.quantity_kind === 'unknown' && fields.quantity === '' && fields.unit === '')
        fact = { kind: 'quantity', quantity: { kind: 'unknown' } };
      else if (
        fields.quantity_kind === 'known' &&
        fields.quantity.length <= 128 &&
        new RegExp(INVENTORY_DECIMAL_PATTERN, 'u').test(fields.quantity) &&
        INVENTORY_VOLUME_UNITS.includes(fields.unit as (typeof INVENTORY_VOLUME_UNITS)[number])
      ) {
        try {
          fact = {
            kind: 'quantity',
            quantity: {
              kind: 'known',
              ...normalizeInventoryVolume({
                value: fields.quantity,
                unit: fields.unit as (typeof INVENTORY_VOLUME_UNITS)[number],
              }),
            },
          };
        } catch (error) {
          rowIssue(
            'STOCKTAKE_QUANTITY_INVALID',
            'quantity',
            error instanceof Error ? error.message : 'Invalid quantity.'
          );
        }
      } else
        rowIssue(
          'STOCKTAKE_QUANTITY_INVALID',
          'quantity',
          'Declare known volume with decimal and supported unit, or unknown with blank value/unit.'
        );
    } else if (subject?.kind === 'item') {
      if (fields.quantity_kind !== 'not-observed' || fields.quantity !== '' || fields.unit !== '')
        rowIssue(
          'STOCKTAKE_ITEM_FIELDS_INVALID',
          'quantity_kind',
          'An item presence observation requires quantity_kind=not-observed and blank quantity/unit.'
        );
      if (fields.presence === 'missing' && fields.location_key === '' && fields.slot === '')
        fact = { kind: 'presence', value: 'missing' };
      else if (fields.presence === 'found') {
        const target = locations.get(fields.location_key);
        let destination: InventoryCustodyDestination | null = null;
        if (target?.kind === 'storage' && exactKey(fields.slot, 512))
          destination = { kind: 'located', storageId: target.storageId, slotId: fields.slot };
        else if (target && target.kind !== 'storage' && fields.slot === '')
          destination = { ...target };
        if (!exactKey(fields.location_key) || !destination)
          rowIssue(
            'STOCKTAKE_LOCATION_UNRESOLVED',
            'location_key',
            'Found items require an explicit destination and a slot only for storage.'
          );
        else fact = { kind: 'presence', value: 'found', destination };
      } else
        rowIssue(
          'STOCKTAKE_PRESENCE_INVALID',
          'presence',
          'Declare missing with blank location fields or found with an explicit destination.'
        );
    }
    if (!exactKey(fields.reason, 2000))
      rowIssue(
        'STOCKTAKE_REASON_INVALID',
        'reason',
        'Every observation requires a nonblank reason.'
      );
    const key = inventoryObservationKey(input.options.namespace, fields.observation_id);
    const existing = Object.hasOwn(previous.observations, key) ? previous.observations[key] : null;
    let kind: InventoryStocktakeRowPreview['kind'] = 'blocked';
    if (!rowIssues.length && subject && fact && choice && choice.kind !== 'skip') {
      const observation: InventoryObservationInput = {
        namespace: input.options.namespace,
        observationId: fields.observation_id,
        subject,
        fact,
        observedAt,
        reason: fields.reason,
      };
      try {
        parseInventoryCommand({ kind: 'record-inventory-observation', ...observation });
      } catch (error) {
        rowIssue(
          'STOCKTAKE_OBSERVATION_INVALID',
          '',
          error instanceof Error ? error.message : 'Invalid observation.'
        );
      }
      if (
        existing &&
        inventoryTableCanonicalJson(observationInput(existing)) !==
          inventoryTableCanonicalJson(observation)
      )
        rowIssue(
          'STOCKTAKE_OBSERVATION_CONFLICT',
          'observation_id',
          'This observation identity already records different immutable facts. A new measurement requires a new identity.'
        );
      if (
        existing?.application.kind === 'applied' &&
        choice.kind === 'apply' &&
        existing.application.reason !== choice.reason
      )
        rowIssue(
          'STOCKTAKE_APPLICATION_CONFLICT',
          'observation_id',
          'This observation was already applied with a different recorded reason.'
        );
      if (!rowIssues.length) {
        if (!existing) commands.push({ kind: 'record-inventory-observation', ...observation });
        if (choice.kind === 'apply' && existing?.application.kind !== 'applied') {
          commands.push({
            kind: 'apply-inventory-observation',
            observationKey: key,
            reason: choice.reason,
          });
          kind = 'apply';
        } else kind = existing ? 'unchanged' : 'record';
      }
    }
    rows.push({
      ...row,
      kind: rowIssues.length ? 'blocked' : kind,
      observationKey: key,
      subject,
      fact,
      observedAt,
      existing,
    });
    issues.push(...rowIssues);
  }
  for (const [name, values, used] of [
    ['subjects', input.options.subjects, subjectKeys],
    ['locations', input.options.locations, locationKeys],
  ] as const)
    for (const [index, value] of values.entries())
      if (!used.has(value.key))
        issues.push(
          issue(
            'STOCKTAKE_RESOLUTION_UNUSED',
            `/options/${name}/${index}`,
            'Remove resolutions not used by an unskipped row.'
          )
        );
  for (const [index, decision] of input.options.decisions.entries())
    if (!ids.has(decision.observationId))
      issues.push(
        issue(
          'STOCKTAKE_DECISION_UNUSED',
          `/options/decisions/${index}`,
          'Remove decisions not present in this source.'
        )
      );
  if (commands.length > MAX_INVENTORY_BATCH_COMMANDS)
    issues.push(
      issue(
        'STOCKTAKE_BATCH_TOO_LARGE',
        '/commands',
        `This proposal requires ${commands.length} commands; the atomic limit is ${MAX_INVENTORY_BATCH_COMMANDS}. No rows were applied.`
      )
    );
  if (issues.length) return blocked();
  const options: InventoryStocktakeChoices = {
    namespace: input.options.namespace,
    delimiter: input.options.delimiter,
    subjects: sorted(input.options.subjects),
    locations: sorted(input.options.locations),
    decisions: [...input.options.decisions].sort((a, b) => order(a.observationId, b.observationId)),
  };
  const transition = commands.length
    ? applyInventoryCommandBatch(
        previous,
        { expectedRevision: previous.revision, commands },
        context
      )
    : { ok: true as const, state: previous };
  if (!transition.ok) {
    issues.push(
      issue(transition.code, '/commands', `The entire stocktake is blocked: ${transition.message}`)
    );
    return blocked();
  }
  const beforeAvailability = inventoryAvailability(previous, context.principal, context.at);
  const afterAvailability = inventoryAvailability(transition.state, context.principal, context.at);
  const snapshot = (
    current: InventoryState,
    availability: typeof beforeAvailability,
    subject: InventoryObservationSubject
  ): InventoryStocktakeSubjectSnapshot => {
    const stock = subject.kind === 'stock' ? current.stocks[subject.stockId] : null;
    const item =
      subject.kind === 'item' ? subject.item : { kind: 'vessel' as const, id: stock!.vesselId };
    return {
      quantity: stock?.quantity ?? null,
      custody: inventoryItemCustody(current, item, context.principal, context.at),
      availability: subject.kind === 'stock' ? availability.stocks[subject.stockId] : null,
    };
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.subject)
      rows[index] = {
        ...row,
        before: snapshot(previous, beforeAvailability, row.subject),
        after: snapshot(transition.state, afterAvailability, row.subject),
      };
  }
  if (!commands.length)
    return { ...facts(), kind: 'no-change', issues: [], commands: [], options, planDigest: null };
  const planDigest = inventoryTableSha256(
    inventoryTableCanonicalJson({
      format: 'dnaforge.inventory-stocktake-plan.v1',
      sourceSha256,
      target: input.target,
      options,
      commands,
    })
  );
  return { ...facts(), kind: 'ready', issues: [], commands, options, planDigest };
}

export function applyInventoryStocktake(
  state: InventoryState | null,
  input: InventoryStocktakeApplication,
  context: InventoryExecutionContext,
  maxBytes: number
): InventoryTransition {
  const preview = inventoryStocktakePreview(state, {
    ...input,
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
          ? (preview.issues[0]?.message ?? 'The stocktake is blocked.')
          : 'The stocktake has no changes to apply.',
    };
  if (preview.planDigest !== input.expectedPlanDigest)
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      message: 'The stocktake source, choices or target changed. Preview again.',
    };
  return applyInventoryCommandBatch(
    state ?? createInventoryState(),
    { expectedRevision: preview.target.revision, commands: preview.commands },
    context
  );
}
