import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  applyInventoryStocktake,
  createInventoryState,
  inventoryAvailability,
  inventoryObservationKey,
  inventoryStocktakePreview,
  inventoryTableSha256,
  inventoryWellId,
  INVENTORY_STOCKTAKE_COLUMNS,
  parseInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryObservationInput,
  type InventoryState,
  type InventoryStocktakeChoices,
  type InventoryStocktakeFields,
  type InventoryStocktakePreviewInput,
} from './inventory';

const context: InventoryExecutionContext = {
  at: 1000,
  principal: { kind: 'agent', identityId: 'observer' },
  authority: { kind: 'local-profile', profileKey: 'profile' },
};
const volume = (value: string) => ({ kind: 'known' as const, value, unit: 'uL' as const });
function execute(
  state: InventoryState,
  commands: readonly InventoryCommand[],
  actor = context
): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    actor
  );
  if (!result.ok) throw new Error(result.code + ': ' + result.message);
  return result.state;
}
function fixture(): InventoryState {
  return execute(createInventoryState(), [
    {
      kind: 'create-storage',
      id: 'box',
      name: 'Box',
      slots: ['A', 'B'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-vessel',
      id: 'tube',
      name: 'Tube',
      placement: { kind: 'located', storageId: 'box', slotId: 'A' },
    },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'tube',
      materialId: 'material',
      quantity: volume('100'),
      quality: 'usable',
    },
    {
      kind: 'create-layout-storage',
      id: 'plate',
      name: 'Plate',
      layout: { kind: 'fixed-well', rows: 1, columns: 1 },
      placement: { kind: 'root' },
    },
    {
      kind: 'receive-stock',
      id: 'well-stock',
      vesselId: inventoryWellId('plate', 'A1'),
      materialId: 'material',
      quantity: volume('50'),
      quality: 'usable',
    },
  ]);
}
const options: InventoryStocktakeChoices = {
  namespace: 'lab:observations',
  delimiter: ',',
  subjects: [{ key: 'sample', subject: { kind: 'stock', stockId: 'stock' } }],
  locations: [],
  decisions: [
    { observationId: '001', choice: { kind: 'apply', reason: 'Apply measured quantity' } },
  ],
};
const row: InventoryStocktakeFields = {
  observation_id: '001',
  subject_key: 'sample',
  observed_at: 'unknown',
  quantity_kind: 'known',
  quantity: '20.000',
  unit: 'uL',
  presence: 'not-observed',
  location_key: '',
  slot: '',
  reason: 'Measured residual',
};
function table(rows: readonly InventoryStocktakeFields[], delimiter = ','): string {
  const quote = (text: string) => '"' + text.replaceAll('"', '""') + '"';
  return [
    INVENTORY_STOCKTAKE_COLUMNS.join(delimiter),
    ...rows.map((value) =>
      INVENTORY_STOCKTAKE_COLUMNS.map((key) => quote(value[key])).join(delimiter)
    ),
  ].join('\r\n');
}
function input(
  state: InventoryState | null,
  sourceText = table([row]),
  choices = options
): InventoryStocktakePreviewInput {
  return {
    target: {
      projectId: 'project',
      inventoryId: 'inventory',
      present: state !== null,
      revision: state?.revision ?? 0,
    },
    sourceText,
    options: choices,
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes: 1024 * 1024,
  };
}
function apply(
  state: InventoryState,
  sourceText = table([row]),
  choices = options
): InventoryState {
  const preview = inventoryStocktakePreview(state, input(state, sourceText, choices));
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview.issues));
  const result = applyInventoryStocktake(
    state,
    {
      target: preview.target,
      sourceText,
      options: preview.options,
      expectedPlanDigest: preview.planDigest,
    },
    context,
    1024 * 1024
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
function observation(
  overrides: Partial<InventoryObservationInput> = {}
): InventoryObservationInput {
  return {
    namespace: options.namespace,
    observationId: '001',
    subject: { kind: 'stock', stockId: 'stock' },
    observedAt: null,
    fact: { kind: 'quantity', quantity: volume('20') },
    reason: row.reason,
    ...overrides,
  };
}

describe('inventory observations and stocktake plans', () => {
  it('measures below active holds without releasing them or changing checked-out custody', () => {
    const before = execute(fixture(), [
      {
        kind: 'reserve-quantity',
        id: 'hold',
        stockId: 'stock',
        quantity: { value: '40', unit: 'uL' },
        deadline: null,
        purpose: 'Experiment',
      },
      {
        kind: 'checkout-item',
        item: { kind: 'vessel', id: 'tube' },
        dueAt: null,
        reason: 'Carried to bench',
      },
    ]);
    const preview = inventoryStocktakePreview(before, input(before));
    expect(preview.kind).toBe('ready');
    expect(preview.rows[0].before?.quantity).toEqual(volume('100'));
    expect(preview.rows[0].after?.availability).toMatchObject({
      held: { value: '40', unit: 'uL' },
      blockers: expect.arrayContaining([{ code: 'ALLOCATION_SHORTFALL' }]),
    });
    const state = apply(before);
    expect(state.stocks.stock.quantity).toEqual(volume('20'));
    expect(state.reservations).toEqual(before.reservations);
    expect(state.vessels.tube).toEqual(before.vessels.tube);
    expect(
      state.observations[inventoryObservationKey(options.namespace, '001')].application.kind
    ).toBe('applied');
    expect(parseInventoryState(state)).toEqual(state);
  });
  it('records without correction, then explicitly applies the same pending observation once', () => {
    const before = fixture();
    const recordOnly = {
      ...options,
      decisions: [{ observationId: '001', choice: { kind: 'record-only' as const } }],
    };
    const recorded = apply(before, table([row]), recordOnly);
    expect(recorded.stocks).toEqual(before.stocks);
    expect(recorded.vessels).toEqual(before.vessels);
    expect(
      recorded.observations[inventoryObservationKey(options.namespace, '001')].application
    ).toEqual({ kind: 'unapplied' });
    const pending = inventoryStocktakePreview(recorded, input(recorded));
    expect(pending.kind).toBe('ready');
    expect(pending.commands).toHaveLength(1);
    const applied = apply(recorded);
    expect(applied.stocks.stock.quantity).toEqual(volume('20'));
    const used = execute(applied, [
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '5', unit: 'uL' },
        reason: 'Later use',
      },
    ]);
    const reimport = inventoryStocktakePreview(used, input(used));
    expect(reimport.kind).toBe('no-change');
    expect(reimport.rows[0].before?.quantity).toEqual(volume('15'));
    expect(reimport.commands).toEqual([]);
  });
  it('reports missing and locates an explicit item while retaining quantity and holds', () => {
    const before = execute(fixture(), [
      {
        kind: 'reserve-quantity',
        id: 'hold',
        stockId: 'stock',
        quantity: { value: '40', unit: 'uL' },
        deadline: null,
        purpose: 'Experiment',
      },
    ]);
    const subject = { kind: 'item' as const, item: { kind: 'vessel' as const, id: 'tube' } };
    const missing: InventoryStocktakeFields = {
      ...row,
      quantity_kind: 'not-observed',
      quantity: '',
      unit: '',
      presence: 'missing',
    };
    const selected: InventoryStocktakeChoices = {
      ...options,
      subjects: [{ key: 'sample', subject }],
    };
    const lost = apply(before, table([missing]), selected);
    expect(lost.vessels.tube).toMatchObject({ custody: { kind: 'missing' } });
    expect(lost.stocks).toEqual(before.stocks);
    expect(lost.reservations).toEqual(before.reservations);
    const found = {
      ...missing,
      observation_id: '002',
      presence: 'found',
      location_key: 'destination',
      slot: 'B',
    };
    const foundChoices: InventoryStocktakeChoices = {
      ...selected,
      locations: [{ key: 'destination', target: { kind: 'storage', storageId: 'box' } }],
      decisions: [
        { observationId: '002', choice: { kind: 'apply', reason: 'Found and put away' } },
      ],
    };
    const located = apply(lost, table([found]), foundChoices);
    expect(located.vessels.tube).toMatchObject({ custody: { kind: 'available' } });
    expect(located.vessels.tube.placement).toEqual({
      kind: 'located',
      storageId: 'box',
      slotId: 'B',
    });
    expect(located.stocks).toEqual(before.stocks);
    expect(located.reservations).toEqual(before.reservations);
  });
  it('refuses independent permanent-well custody and rolls back earlier observation writes', () => {
    const before = fixture();
    const missing = {
      ...row,
      observation_id: '002',
      subject_key: 'well',
      quantity_kind: 'not-observed',
      quantity: '',
      unit: '',
      presence: 'missing',
    };
    const choices: InventoryStocktakeChoices = {
      ...options,
      subjects: [
        ...options.subjects,
        {
          key: 'well',
          subject: { kind: 'item', item: { kind: 'vessel', id: inventoryWellId('plate', 'A1') } },
        },
      ],
      decisions: [
        ...options.decisions,
        {
          observationId: '002',
          choice: { kind: 'apply', reason: 'Cannot detach a permanent well' },
        },
      ],
    };
    const preview = inventoryStocktakePreview(
      before,
      input(before, table([row, missing]), choices)
    );
    expect(preview).toMatchObject({ kind: 'blocked', issues: [{ code: 'FIXED_WELL_IMMUTABLE' }] });
    expect(before.observations).toEqual({});
    expect(before.stocks.stock.quantity).toEqual(volume('100'));
  });
  it('records well stock quantity independently of plate custody', () => {
    const before = fixture();
    const selected: InventoryStocktakeChoices = {
      ...options,
      subjects: [{ key: 'sample', subject: { kind: 'stock', stockId: 'well-stock' } }],
    };
    const state = apply(before, table([row]), selected);
    expect(state.stocks['well-stock'].quantity).toEqual(volume('20'));
    expect(state.storage.plate).toEqual(before.storage.plate);
  });
  it.each(['known zero', 'unknown'] as const)('preserves %s as an explicit measurement', (kind) => {
    const source =
      kind === 'unknown'
        ? { ...row, quantity_kind: 'unknown', quantity: '', unit: '' }
        : { ...row, quantity: '0' };
    const state = apply(fixture(), table([source]));
    expect(state.stocks.stock.quantity).toEqual(
      kind === 'unknown' ? { kind: 'unknown' } : volume('0')
    );
  });
  it('uses source namespace and exact leading-zero identity independently of file quoting or decimal units', () => {
    const state = apply(fixture());
    const changedFormatting = { ...row, quantity: '0.020', unit: 'mL' };
    const preview = inventoryStocktakePreview(
      state,
      input(state, '\uFEFF' + table([changedFormatting]) + '\r\n')
    );
    expect(preview.kind).toBe('no-change');
    expect(Object.values(state.observations)[0].observationId).toBe('001');
    expect(inventoryObservationKey('x', '001')).not.toBe(inventoryObservationKey('x', '1'));
    expect(inventoryObservationKey(' x', '001')).not.toBe(inventoryObservationKey('x', '001'));
  });
  it.each(['quantity', 'subject', 'time', 'reason'] as const)(
    'refuses changed immutable %s under the same observation identity',
    (change) => {
      const state = apply(fixture());
      const source = {
        ...row,
        ...(change === 'quantity'
          ? { quantity: '21' }
          : change === 'time'
            ? { observed_at: '1970-01-01T00:00:00.001Z' }
            : change === 'reason'
              ? { reason: 'Changed reason' }
              : {}),
      };
      const choices =
        change === 'subject'
          ? {
              ...options,
              subjects: [
                { key: 'sample', subject: { kind: 'stock' as const, stockId: 'well-stock' } },
              ],
            }
          : options;
      expect(
        inventoryStocktakePreview(state, input(state, table([source]), choices))
      ).toMatchObject({
        kind: 'blocked',
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'STOCKTAKE_OBSERVATION_CONFLICT' }),
        ]),
      });
    }
  );
  it('refuses changed application reason without changing an already-applied observation', () => {
    const state = apply(fixture());
    const choices: InventoryStocktakeChoices = {
      ...options,
      decisions: [
        { observationId: '001', choice: { kind: 'apply', reason: 'Different justification' } },
      ],
    };
    expect(inventoryStocktakePreview(state, input(state, table([row]), choices)).kind).toBe(
      'blocked'
    );
  });
  it('requires native context and refuses forged stock/item combinations and future observations', () => {
    const before = fixture();
    const record = { kind: 'record-inventory-observation' as const, ...observation() };
    expect(
      applyInventoryCommandBatch(before, { expectedRevision: before.revision, commands: [record] })
    ).toMatchObject({ ok: false, code: 'CONTEXT_REQUIRED' });
    expect(
      applyInventoryCommandBatch(
        before,
        {
          expectedRevision: before.revision,
          commands: [{ ...record, fact: { kind: 'presence', value: 'missing' } }],
        },
        context
      )
    ).toMatchObject({ ok: false, code: 'INVALID_INVENTORY_INPUT' });
    expect(
      applyInventoryCommandBatch(
        before,
        { expectedRevision: before.revision, commands: [{ ...record, observedAt: 1001 }] },
        context
      )
    ).toMatchObject({ ok: false, code: 'OBSERVATION_TIME_FUTURE' });
  });
  it('rejects duplicate recording and direct repeated application without changing facts', () => {
    const state = apply(fixture());
    const repeated = applyInventoryCommandBatch(
      state,
      {
        expectedRevision: state.revision,
        commands: [{ kind: 'record-inventory-observation', ...observation() }],
      },
      context
    );
    expect(repeated).toMatchObject({ ok: false, code: 'OBSERVATION_ALREADY_EXISTS' });
    expect(
      applyInventoryCommandBatch(
        state,
        {
          expectedRevision: state.revision,
          commands: [
            {
              kind: 'apply-inventory-observation',
              observationKey: inventoryObservationKey(options.namespace, '001'),
              reason: 'Try to repeat correction',
            },
          ],
        },
        context
      )
    ).toMatchObject({ ok: false, code: 'OBSERVATION_ALREADY_APPLIED' });
    expect(state.stocks.stock.quantity).toEqual(volume('20'));
  });
  it.each([
    ['', 'STOCKTAKE_TIME_INVALID'],
    ['1970-01-01', 'STOCKTAKE_TIME_INVALID'],
    ['1970-02-30T00:00:00.000Z', 'STOCKTAKE_TIME_INVALID'],
    ['1970-01-01T00:00:01.001Z', 'OBSERVATION_TIME_FUTURE'],
  ])('refuses invalid or future source time %s', (observed_at, code) => {
    const state = fixture();
    expect(
      inventoryStocktakePreview(state, input(state, table([{ ...row, observed_at }])))
    ).toMatchObject({
      kind: 'blocked',
      issues: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });
  it('accepts exact UTC source time separately from native recording time', () => {
    const state = apply(fixture(), table([{ ...row, observed_at: '1970-01-01T00:00:00.123Z' }]));
    expect(Object.values(state.observations)[0]).toMatchObject({ observedAt: 123, at: 1000 });
  });
  it('does not infer a row decision, subject, location or quantity', () => {
    const state = fixture();
    expect(
      inventoryStocktakePreview(
        state,
        input(state, table([row]), { ...options, subjects: [], decisions: [] })
      )
    ).toMatchObject({ kind: 'blocked', commands: [] });
    expect(
      inventoryStocktakePreview(state, input(state, table([{ ...row, quantity: '' }]))).kind
    ).toBe('blocked');
  });
  it('allows explicit skips without requiring semantic bindings, but never skips duplicate identities or malformed structure', () => {
    const state = fixture();
    const skip: InventoryStocktakeChoices = {
      ...options,
      subjects: [],
      decisions: [
        { observationId: '001', choice: { kind: 'skip', reason: 'Exclude reviewed source error' } },
      ],
    };
    expect(
      inventoryStocktakePreview(state, input(state, table([{ ...row, quantity: 'bad' }]), skip))
        .kind
    ).toBe('no-change');
    expect(inventoryStocktakePreview(state, input(state, table([row, row]), skip)).kind).toBe(
      'blocked'
    );
    expect(inventoryStocktakePreview(state, input(state, table([row]) + ',extra', skip)).kind).toBe(
      'blocked'
    );
  });
  it.each([
    'extra header',
    'duplicate header',
    'bad quote',
    'invalid UTF8',
    'extra resolution',
    'extra choice',
    'duplicate choice',
  ] as const)('strictly refuses %s', (invalid) => {
    const state = fixture();
    let source = table([row]);
    let choices = options;
    if (invalid === 'extra header') source = source.replace('reason', 'reason,other');
    if (invalid === 'duplicate header') source = source.replace('subject_key', 'observation_id');
    if (invalid === 'bad quote') source += '"';
    if (invalid === 'invalid UTF8') source += '\uD800';
    if (invalid === 'extra resolution')
      choices = {
        ...options,
        subjects: [
          ...options.subjects,
          { key: 'unused', subject: { kind: 'stock', stockId: 'stock' } },
        ],
      };
    if (invalid === 'extra choice')
      choices = {
        ...options,
        decisions: [
          ...options.decisions,
          { observationId: 'unused', choice: { kind: 'record-only' } },
        ],
      };
    if (invalid === 'duplicate choice')
      choices = { ...options, decisions: [...options.decisions, ...options.decisions] };
    expect(inventoryStocktakePreview(state, input(state, source, choices)).kind).toBe('blocked');
  });
  it('supports strict TSV and prototype-shaped source keys', () => {
    const state = fixture();
    const choices: InventoryStocktakeChoices = {
      ...options,
      namespace: '__proto__',
      delimiter: '\t',
      subjects: [{ key: 'constructor', subject: { kind: 'stock', stockId: 'stock' } }],
      decisions: [{ observationId: '__proto__', choice: { kind: 'record-only' } }],
    };
    const source = table(
      [{ ...row, observation_id: '__proto__', subject_key: 'constructor' }],
      '\t'
    );
    expect(
      apply(state, source, choices).observations[inventoryObservationKey('__proto__', '__proto__')]
        .application.kind
    ).toBe('unapplied');
  });
  it('pins source and target in its plan while excluding native read time', () => {
    const state = fixture();
    const first = inventoryStocktakePreview(state, input(state));
    const later = inventoryStocktakePreview(state, { ...input(state), asOf: 2000 });
    expect(first.kind).toBe('ready');
    expect(later.planDigest).toBe(first.planDigest);
    if (first.kind !== 'ready') throw new Error('Ready expected');
    expect(
      applyInventoryStocktake(
        state,
        {
          target: first.target,
          sourceText: table([row]) + '\n',
          options: first.options,
          expectedPlanDigest: first.planDigest,
        },
        context,
        1024 * 1024
      )
    ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
    expect(
      inventoryStocktakePreview(state, {
        ...input(state),
        target: { ...first.target, revision: state.revision + 1 },
      }).kind
    ).toBe('blocked');
    expect(inventoryStocktakePreview(state, { ...input(state), maxBytes: 1 }).kind).toBe('blocked');
  });
  it('refuses oversized atomic plans without silently splitting rows', () => {
    const state = fixture();
    const records = Array.from({ length: 129 }, (_, index) => ({
      ...row,
      observation_id: String(index),
    }));
    const choices: InventoryStocktakeChoices = {
      ...options,
      decisions: records.map((record) => ({
        observationId: record.observation_id,
        choice: { kind: 'apply', reason: 'Measured' },
      })),
    };
    expect(inventoryStocktakePreview(state, input(state, table(records), choices))).toMatchObject({
      kind: 'blocked',
      issues: [{ code: 'STOCKTAKE_BATCH_TOO_LARGE' }],
    });
    expect(state.observations).toEqual({});
  });
  it('preserves observations, application actors and stable source identity across archive adoption', () => {
    const state = apply(fixture());
    const imported = adoptInventoryState(
      null,
      state,
      {
        source: {
          archiveSha256: inventoryTableSha256('archive'),
          projectId: 'source',
          inventoryId: 'source-inventory',
          revision: state.revision,
        },
        materialBindings: { material: 'mapped-material' },
      },
      { ...context, at: 2000 }
    );
    if (!imported.ok) throw new Error(imported.message);
    const record = Object.values(imported.state.observations)[0];
    expect(record.by.kind).toBe('imported');
    expect(record.application).toMatchObject({ kind: 'applied', by: { kind: 'imported' } });
    const preview = inventoryStocktakePreview(imported.state, {
      ...input(imported.state),
      asOf: 2000,
      target: { ...input(imported.state).target, projectId: 'destination' },
    });
    expect(preview.kind).toBe('no-change');
    expect(parseInventoryState(imported.state)).toEqual(imported.state);
  });
  it('applies an imported pending observation under the real local actor and preserves flat attribution on readoption', () => {
    const pending = apply(fixture(), table([row]), {
      ...options,
      decisions: [{ observationId: '001', choice: { kind: 'record-only' } }],
    });
    const source = {
      archiveSha256: inventoryTableSha256('pending archive'),
      projectId: 'source',
      inventoryId: 'source-inventory',
      revision: pending.revision,
    };
    const adopted = adoptInventoryState(
      null,
      pending,
      { source, materialBindings: { material: 'mapped-material' } },
      { ...context, at: 2000 }
    );
    if (!adopted.ok) throw new Error(adopted.message);
    const applied = execute(
      adopted.state,
      [
        {
          kind: 'apply-inventory-observation',
          observationKey: inventoryObservationKey(options.namespace, '001'),
          reason: 'Apply imported observation locally',
        },
      ],
      { ...context, at: 2001, principal: { kind: 'agent', identityId: 'local-importer' } }
    );
    const record = Object.values(applied.observations)[0];
    expect(record.by.kind).toBe('imported');
    expect(record.application).toMatchObject({
      kind: 'applied',
      by: { kind: 'agent', identityId: 'local-importer' },
      at: 2001,
    });
    const again = adoptInventoryState(
      null,
      applied,
      {
        source: {
          ...source,
          archiveSha256: inventoryTableSha256('again'),
          revision: applied.revision,
        },
        materialBindings: { 'mapped-material': 'another-material' },
      },
      { ...context, at: 3000 }
    );
    if (!again.ok) throw new Error(again.message);
    expect(Object.values(again.state.observations)[0].by).toEqual(record.by);
    expect(Object.values(again.state.observations)[0].application).toMatchObject({
      kind: 'applied',
      by: { kind: 'imported', principal: { kind: 'agent', identityId: 'local-importer' } },
    });
  });
  it('upcasts v13 state without changing source bytes or imported attribution and validates observation keys', () => {
    const state = fixture();
    const { observations: _observations, ...v13 } = state;
    const legacy = { ...v13, schema: 'dnaforge.inventory.v13' };
    const bytes = JSON.stringify(legacy);
    const upcast = parseInventoryState(legacy);
    expect(upcast.observations).toEqual({});
    expect(JSON.stringify(legacy)).toBe(bytes);
    const recorded = apply(state);
    const entry = Object.values(recorded.observations)[0];
    expect(() => parseInventoryState({ ...recorded, observations: { wrong: entry } })).toThrow(
      /key/
    );
    expect(() =>
      parseInventoryState({
        ...recorded,
        observations: {
          [inventoryObservationKey(options.namespace, '001')]: { ...entry, at: 1001 },
        },
      })
    ).toThrow(/time/);
  });
});
