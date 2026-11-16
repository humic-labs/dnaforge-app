import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  applyInventorySourceRevision,
  applyInventoryTable,
  createInventoryState,
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  inventoryReceiveTableRowSha256,
  inventorySourceRevisionPreview,
  inventoryTableBindingKey,
  inventoryTablePreview,
  inventoryTableSha256,
  inventoryTableSourceBaseline,
  parseInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryReceiveTableFields,
  type InventorySourceRevisionChoices,
  type InventorySourceRevisionPreviewInput,
  type InventoryState,
  type InventoryTableChoices,
} from './inventory';

const context: InventoryExecutionContext = {
  at: 20,
  principal: { kind: 'agent', identityId: 'receiver' },
  authority: { kind: 'local-profile', profileKey: 'profile' },
};
const original: InventoryReceiveTableFields = {
  source_id: '0007',
  name: 'Tube, original\nsecond line',
  material_key: 'material',
  quantity_kind: 'known',
  quantity: '80',
  unit: 'uL',
  quality: 'usable',
  vessel_kind: 'new',
  vessel_key: '',
  location_key: 'location',
  slot: 'A',
};
const revised: InventoryReceiveTableFields = {
  ...original,
  name: 'Revised external name',
  quantity: '90',
  quality: 'quarantined',
  slot: 'C',
};
const tableChoices: InventoryTableChoices = {
  namespace: 'register:stable',
  delimiter: ',',
  materials: [{ key: 'material', materialId: 'scientific-record' }],
  locations: [{ key: 'location', target: { kind: 'storage', storageId: 'box' } }],
  vessels: [],
  skips: [],
};
const key = inventoryTableBindingKey(tableChoices.namespace, original.source_id);
const table = (fields: readonly InventoryReceiveTableFields[], delimiter = ',') =>
  [
    INVENTORY_RECEIVE_TABLE_COLUMNS.join(delimiter),
    ...fields.map((row) =>
      INVENTORY_RECEIVE_TABLE_COLUMNS.map(
        (column) => `"${row[column].replaceAll('"', '""')}"`
      ).join(delimiter)
    ),
  ].join('\r\n');
const target = (
  state: InventoryState | null,
  projectId = 'project',
  inventoryId = 'inventory'
) => ({ projectId, inventoryId, present: state !== null, revision: state?.revision ?? 0 });
function commands(
  state: InventoryState,
  values: readonly InventoryCommand[],
  at = 20
): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands: values },
    { ...context, at }
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
function receive(state: InventoryState, fields = original, options = tableChoices) {
  const sourceText = table([fields], options.delimiter);
  const proposal = inventoryTablePreview(state, {
    target: target(state),
    sourceText,
    options,
    bindings: options.materials.map((material) => ({
      ...material,
      kind: 'admitted',
      fingerprint: inventoryTableSha256(material.materialId),
    })),
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes: 17 * 1024 * 1024,
  });
  if (proposal.kind !== 'ready') throw new Error(JSON.stringify(proposal.issues));
  const applied = applyInventoryTable(
    state,
    {
      target: target(state),
      sourceText,
      options: proposal.options,
      expectedPlanDigest: proposal.planDigest,
    },
    context,
    17 * 1024 * 1024
  );
  if (!applied.ok) throw new Error(applied.message);
  return applied.state;
}
function fixture() {
  const locations = commands(createInventoryState(), [
    {
      kind: 'create-storage',
      id: 'box',
      name: 'Box',
      slots: ['A', 'B', 'C'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-vessel',
      id: 'occupied-c',
      name: 'Occupied position C',
      placement: { kind: 'located', storageId: 'box', slotId: 'C' },
    },
    {
      kind: 'create-vessel',
      id: 'empty-existing',
      name: 'Empty existing vessel',
      placement: { kind: 'unplaced' },
    },
  ]);
  const received = receive(locations);
  const binding = received.tableBindings[key];
  return commands(received, [
    {
      kind: 'consume',
      stockId: binding.stockId,
      quantity: { value: '17', unit: 'uL' },
      reason: 'Actual later use',
    },
    {
      kind: 'move-vessel',
      id: binding.vesselId,
      placement: { kind: 'located', storageId: 'box', slotId: 'B' },
    },
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: binding.stockId,
      quantity: { value: '60', unit: 'uL' },
      deadline: null,
      purpose: 'Preserve active hold',
    },
    {
      kind: 'record-inventory-observation',
      namespace: 'measurements',
      observationId: 'observed-1',
      subject: { kind: 'stock', stockId: binding.stockId },
      observedAt: null,
      fact: { kind: 'quantity', quantity: { kind: 'known', value: '63', unit: 'uL' } },
      reason: 'Preserve independent recorded observation',
    },
  ]);
}
function choices(state: InventoryState, fields = revised): InventorySourceRevisionChoices {
  return {
    table: tableChoices,
    acknowledgements: [
      {
        sourceId: fields.source_id,
        expectedPreviousRowSha256: inventoryTableSourceBaseline(state.tableBindings[key]).rowSha256,
        reason: 'Acknowledge revised external record; preserve physical facts',
      },
    ],
  };
}
function input(
  state: InventoryState,
  fields = revised,
  options = choices(state, fields)
): InventorySourceRevisionPreviewInput {
  return {
    target: target(state),
    sourceText: table([fields]),
    options,
    preimages: [{ sourceId: original.source_id, fields: original }],
    asOf: 30,
    principal: context.principal,
    authority: context.authority,
    maxBytes: 17 * 1024 * 1024,
  };
}
function acknowledge(
  state: InventoryState,
  fields = revised,
  options = choices(state, fields),
  at = 30
) {
  const args = input(state, fields, options);
  const proposal = inventorySourceRevisionPreview(state, {
    ...args,
    asOf: at,
    preimages: state.tableBindings[key].sourceRevisions.length ? [] : args.preimages,
  });
  if (proposal.kind !== 'ready') throw new Error(JSON.stringify(proposal));
  const result = applyInventorySourceRevision(
    state,
    {
      target: args.target,
      sourceText: args.sourceText,
      options: proposal.options,
      expectedPlanDigest: proposal.planDigest,
    },
    { ...context, at },
    args.maxBytes
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
function physical(state: InventoryState) {
  const { revision, lastRecordedAt, tableBindings, ...facts } = state;
  return facts;
}

describe('accepted receive-source revisions', () => {
  it('shows verified previous source, revised source and actual inventory before acknowledgement', () => {
    const state = fixture();
    const preview = inventorySourceRevisionPreview(
      state,
      input(state, revised, { table: tableChoices, acknowledgements: [] })
    );
    expect(preview.kind).toBe('needs-acknowledgement');
    expect(preview.rows[0]).toMatchObject({
      kind: 'needs-acknowledgement',
      previousFields: { quantity: '80', slot: 'A', quality: 'usable' },
      revisedFields: { quantity: '90', slot: 'C', quality: 'quarantined' },
      actual: {
        stock: { quantity: { value: '63' }, quality: 'usable' },
        vessel: { placement: { slotId: 'B' } },
        availability: { held: { value: '60' } },
      },
    });
    expect(state.tableBindings[key].sourceRevisions).toEqual([]);
  });

  it('appends only metadata while preserving original binding, physical facts, holds and observations', () => {
    const state = fixture();
    const accepted = acknowledge(state);
    expect(physical(accepted)).toEqual(physical(state));
    const { sourceRevisions, ...binding } = accepted.tableBindings[key];
    expect(binding).toEqual(
      Object.fromEntries(
        Object.entries(state.tableBindings[key]).filter(([name]) => name !== 'sourceRevisions')
      )
    );
    expect(sourceRevisions).toEqual([
      {
        previousRowSha256: inventoryReceiveTableRowSha256(original),
        rowSha256: inventoryReceiveTableRowSha256(revised),
        fields: revised,
        destination: {
          kind: 'new-vessel',
          placement: { kind: 'located', storageId: 'box', slotId: 'C' },
        },
        reason: choices(state).acknowledgements[0].reason,
        at: 30,
        by: context.principal,
      },
    ]);
    expect(accepted.revision).toBe(state.revision + 1);
    expect(accepted.lastRecordedAt).toBe(30);
    expect(state.tableBindings[key].sourceRevisions).toEqual([]);
  });

  it('does not replenish or move stock when the acknowledged source is reimported after later use', () => {
    const accepted = acknowledge(fixture());
    const used = commands(
      accepted,
      [
        {
          kind: 'consume',
          stockId: accepted.tableBindings[key].stockId,
          quantity: { value: '1', unit: 'uL' },
          reason: 'Later use remains truthful',
        },
      ],
      40
    );
    const preview = inventoryTablePreview(used, {
      target: target(used),
      sourceText: table([revised]),
      options: tableChoices,
      bindings: [
        {
          ...tableChoices.materials[0],
          kind: 'admitted',
          fingerprint: inventoryTableSha256('current-scientific-file'),
        },
      ],
      asOf: 40,
      principal: context.principal,
      authority: context.authority,
      maxBytes: 17 * 1024 * 1024,
    });
    expect(preview.kind).toBe('no-change');
    expect(used.stocks[used.tableBindings[key].stockId].quantity).toEqual({
      kind: 'known',
      value: '62',
      unit: 'uL',
    });
    expect(used.vessels[used.tableBindings[key].vesselId].placement).toMatchObject({ slotId: 'B' });
  });

  it('appends an explicitly acknowledged rollback without deleting source history', () => {
    const accepted = acknowledge(fixture());
    const rolledBack = acknowledge(accepted, original, choices(accepted, original), 40);
    expect(rolledBack.tableBindings[key].sourceRevisions.map((row) => row.rowSha256)).toEqual([
      inventoryReceiveTableRowSha256(revised),
      inventoryReceiveTableRowSha256(original),
    ]);
    expect(rolledBack.tableBindings[key].sourceRevisions[1].previousRowSha256).toBe(
      inventoryReceiveTableRowSha256(revised)
    );
    expect(physical(rolledBack)).toEqual(physical(accepted));
  });

  it('uses saved revision fields as the next baseline without a live journal lookup', () => {
    const accepted = acknowledge(fixture());
    const next = { ...revised, quantity: '91' };
    const preview = inventorySourceRevisionPreview(accepted, {
      ...input(accepted, next, choices(accepted, next)),
      preimages: [],
      asOf: 40,
    });
    expect(preview.kind).toBe('ready');
    expect(preview.rows[0].previousFields).toEqual(revised);
  });

  it.each([
    [
      'scientific rebinding',
      (state: InventoryState) => ({
        ...input(state),
        options: {
          ...choices(state),
          table: {
            ...tableChoices,
            materials: [{ key: 'material', materialId: 'other-scientific-record' }],
          },
        },
      }),
      'SOURCE_REVISION_IDENTITY_CHANGED',
    ],
    [
      'unbound source identity',
      (state: InventoryState) => ({
        ...input(
          state,
          { ...revised, source_id: 'new-unbound' },
          { table: tableChoices, acknowledgements: [] }
        ),
      }),
      'SOURCE_REVISION_UNBOUND',
    ],
    [
      'missing previous source',
      (state: InventoryState) => ({ ...input(state), preimages: [] }),
      'SOURCE_REVISION_PREIMAGE_UNAVAILABLE',
    ],
    [
      'tampered previous source',
      (state: InventoryState) => ({
        ...input(state),
        preimages: [{ sourceId: original.source_id, fields: { ...original, quantity: '79' } }],
      }),
      'SOURCE_REVISION_PREIMAGE_CHANGED',
    ],
    [
      'stale previous hash',
      (state: InventoryState) => ({
        ...input(state),
        options: {
          ...choices(state),
          acknowledgements: [
            {
              ...choices(state).acknowledgements[0],
              expectedPreviousRowSha256: inventoryTableSha256('stale'),
            },
          ],
        },
      }),
      'SOURCE_REVISION_BASELINE_CHANGED',
    ],
    [
      'unknown location',
      (state: InventoryState) => ({
        ...input(state),
        options: {
          ...choices(state),
          table: {
            ...tableChoices,
            locations: [
              {
                key: 'location',
                target: { kind: 'storage' as const, storageId: 'foreign-storage' },
              },
            ],
          },
        },
      }),
      'SOURCE_REVISION_LOCATION_UNRESOLVED',
    ],
    [
      'missing reason',
      (state: InventoryState) => ({
        ...input(state),
        options: {
          ...choices(state),
          acknowledgements: [{ ...choices(state).acknowledgements[0], reason: '' }],
        },
      }),
      'SOURCE_REVISION_REASON_REQUIRED',
    ],
    [
      'clock regression',
      (state: InventoryState) => ({ ...input(state), asOf: 19 }),
      'CLOCK_REGRESSION',
    ],
    [
      'stale target',
      (state: InventoryState) => ({ ...input(state), target: { ...target(state), revision: 0 } }),
      'SOURCE_REVISION_TARGET_CHANGED',
    ],
  ] as const)('refuses %s without changing inventory', (_name, change, code) => {
    const state = fixture();
    const before = JSON.stringify(state);
    const preview = inventorySourceRevisionPreview(state, change(state));
    expect(preview.kind).toBe('blocked');
    expect(preview.issues.some((row) => row.code === code)).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
    expect(preview.rows[0]?.revisedFields ?? null).not.toBeUndefined();
  });

  it('refuses a new/existing vessel-kind switch and physical replacement', () => {
    const state = fixture();
    const existingFields = {
      ...revised,
      name: '',
      vessel_kind: 'existing',
      vessel_key: 'target',
      location_key: '',
      slot: '',
    };
    const switched = inventorySourceRevisionPreview(
      state,
      input(state, existingFields, {
        ...choices(state),
        table: {
          ...tableChoices,
          locations: [],
          vessels: [{ key: 'target', vesselId: state.tableBindings[key].vesselId }],
        },
      })
    );
    expect(switched.kind).toBe('blocked');
    expect(switched.issues.some((row) => row.code === 'SOURCE_REVISION_IDENTITY_CHANGED')).toBe(
      true
    );
    const emptyState = commands(createInventoryState(), [
      { kind: 'create-vessel', id: 'old', name: 'Old', placement: { kind: 'unplaced' } },
      { kind: 'create-vessel', id: 'other', name: 'Other', placement: { kind: 'unplaced' } },
    ]);
    const existing = {
      ...original,
      name: '',
      vessel_kind: 'existing',
      vessel_key: 'vessel',
      location_key: '',
      slot: '',
    };
    const existingOptions = {
      ...tableChoices,
      locations: [],
      vessels: [{ key: 'vessel', vesselId: 'old' }],
    };
    const bound = receive(emptyState, existing, existingOptions);
    const replacement = inventorySourceRevisionPreview(bound, {
      ...input(
        bound,
        { ...existing, quantity: '90' },
        {
          table: { ...existingOptions, vessels: [{ key: 'vessel', vesselId: 'other' }] },
          acknowledgements: choices(bound).acknowledgements,
        }
      ),
      preimages: [{ sourceId: existing.source_id, fields: existing }],
    });
    expect(replacement.kind).toBe('blocked');
    expect(replacement.issues.some((row) => row.code === 'SOURCE_REVISION_IDENTITY_CHANGED')).toBe(
      true
    );
  });

  it('allows source material aliases only while preserving the bound scientific identity', () => {
    const state = fixture();
    const fields = { ...revised, material_key: 'renamed-external-key' };
    const options = {
      ...choices(state),
      table: {
        ...tableChoices,
        materials: [{ key: 'renamed-external-key', materialId: 'scientific-record' }],
      },
    };
    const accepted = acknowledge(state, fields, options);
    expect(accepted.tableBindings[key].materialId).toBe('scientific-record');
    expect(accepted.tableBindings[key].sourceRevisions[0].fields.material_key).toBe(
      'renamed-external-key'
    );
  });

  it('accepts explicit unplaced metadata while keeping actual located stock unchanged', () => {
    const state = fixture();
    const fields = { ...revised, slot: '' };
    const accepted = acknowledge(state, fields, {
      ...choices(state),
      table: { ...tableChoices, locations: [{ key: 'location', target: { kind: 'unplaced' } }] },
    });
    expect(accepted.tableBindings[key].sourceRevisions[0].destination).toEqual({
      kind: 'new-vessel',
      placement: { kind: 'unplaced' },
    });
    expect(accepted.vessels[accepted.tableBindings[key].vesselId].placement).toEqual({
      kind: 'located',
      storageId: 'box',
      slotId: 'B',
    });
  });

  it('supports no-change and explicit skip without writing a revision', () => {
    const state = fixture();
    expect(
      inventorySourceRevisionPreview(
        state,
        input(state, original, { table: tableChoices, acknowledgements: [] })
      ).kind
    ).toBe('no-change');
    const skipped = inventorySourceRevisionPreview(state, {
      ...input(state),
      options: {
        table: {
          ...tableChoices,
          materials: [],
          locations: [],
          skips: [{ sourceId: original.source_id, reason: 'Skip explicitly' }],
        },
        acknowledgements: [],
      },
      preimages: [],
    });
    expect(skipped.kind).toBe('no-change');
    expect(skipped.rows[0].kind).toBe('skipped');
    const conflict = inventorySourceRevisionPreview(state, {
      ...input(state),
      options: {
        ...choices(state),
        table: {
          ...tableChoices,
          materials: [],
          locations: [],
          skips: [{ sourceId: original.source_id, reason: 'Skip' }],
        },
      },
      preimages: [],
    });
    expect(conflict.kind).toBe('blocked');
  });

  it('pins source, options, preimages and target while excluding native read time and actor from the plan hash', () => {
    const state = fixture();
    const first = inventorySourceRevisionPreview(state, input(state));
    const later = inventorySourceRevisionPreview(state, {
      ...input(state),
      asOf: 40,
      principal: { kind: 'agent', identityId: 'different-current-reader' },
    });
    expect(first.kind).toBe('ready');
    expect(later.planDigest).toBe(first.planDigest);
    if (first.kind !== 'ready') throw new Error('Expected plan');
    const changed = applyInventorySourceRevision(
      state,
      {
        target: target(state),
        sourceText: table([{ ...revised, quantity: '91' }]),
        options: first.options,
        expectedPlanDigest: first.planDigest,
      },
      { ...context, at: 40 },
      17 * 1024 * 1024
    );
    expect(changed.ok).toBe(false);
  });

  it('validates every source-chain hash, identity, slot and recorded time', () => {
    const accepted = acknowledge(fixture());
    for (const mutate of [
      (value: typeof accepted) => {
        (
          value.tableBindings[key].sourceRevisions[0] as { previousRowSha256: string }
        ).previousRowSha256 = inventoryTableSha256('wrong');
      },
      (value: typeof accepted) => {
        (value.tableBindings[key].sourceRevisions[0].fields as { quantity: string }).quantity =
          '91';
      },
      (value: typeof accepted) => {
        (value.tableBindings[key].sourceRevisions[0] as { at: number }).at = 31;
      },
      (value: typeof accepted) => {
        const destination = value.tableBindings[key].sourceRevisions[0].destination;
        if (destination.kind === 'new-vessel' && destination.placement.kind === 'located')
          (destination.placement as { slotId: string }).slotId = 'B';
      },
    ]) {
      const broken = structuredClone(accepted);
      mutate(broken);
      expect(() => parseInventoryState(broken)).toThrow();
    }
  });

  it('upcasts actual v13/v14 binding shapes with an empty chain and preserves v14 observation attribution', () => {
    const state = fixture();
    const raw = JSON.parse(JSON.stringify(state));
    raw.schema = 'dnaforge.inventory.v14';
    for (const binding of Object.values(raw.tableBindings) as Record<string, unknown>[])
      delete binding.sourceRevisions;
    const before = JSON.stringify(raw);
    const upcast = parseInventoryState(raw);
    expect(upcast.schema).toBe('dnaforge.inventory.v15');
    expect(upcast.tableBindings[key].sourceRevisions).toEqual([]);
    expect(upcast.observations).toEqual(state.observations);
    expect(JSON.stringify(raw)).toBe(before);
    delete raw.observations;
    raw.schema = 'dnaforge.inventory.v13';
    expect(parseInventoryState(raw).tableBindings[key].sourceRevisions).toEqual([]);
  });

  it('preserves source revision fields and identities across adoption and wraps recorded actors flat', () => {
    const accepted = acknowledge(
      fixture(),
      { ...revised, material_key: 'scientific-record' },
      {
        ...choices(fixture()),
        table: {
          ...tableChoices,
          materials: [{ key: 'scientific-record', materialId: 'scientific-record' }],
        },
      }
    );
    const adoption = adoptInventoryState(
      null,
      accepted,
      {
        source: {
          archiveSha256: inventoryTableSha256('archive'),
          projectId: 'project',
          inventoryId: 'inventory',
          revision: accepted.revision,
        },
        materialBindings: { 'scientific-record': 'destination-material' },
      },
      { ...context, at: 40 }
    );
    if (!adoption.ok) throw new Error(adoption.message);
    const binding = adoption.state.tableBindings[key];
    expect(binding.stockId).toBe(accepted.tableBindings[key].stockId);
    expect(binding.materialId).toBe('destination-material');
    expect(binding.sourceRevisions[0].fields.material_key).toBe('scientific-record');
    expect(binding.sourceRevisions[0].by.kind).toBe('imported');
    const fields = binding.sourceRevisions[0].fields;
    const preview = inventoryTablePreview(adoption.state, {
      target: target(adoption.state, 'destination', 'destination-inventory'),
      sourceText: table([fields]),
      options: {
        ...tableChoices,
        materials: [{ key: 'scientific-record', materialId: 'destination-material' }],
      },
      bindings: [
        {
          key: 'scientific-record',
          materialId: 'destination-material',
          kind: 'admitted',
          fingerprint: inventoryTableSha256('destination-file'),
        },
      ],
      asOf: 40,
      principal: context.principal,
      authority: context.authority,
      maxBytes: 17 * 1024 * 1024,
    });
    expect(preview.kind).toBe('no-change');
    const again = adoptInventoryState(
      null,
      adoption.state,
      {
        source: {
          archiveSha256: inventoryTableSha256('second-archive'),
          projectId: 'destination',
          inventoryId: 'destination-inventory',
          revision: adoption.state.revision,
        },
        materialBindings: { 'destination-material': 'last-material' },
      },
      { ...context, at: 50 }
    );
    if (!again.ok) throw new Error(again.message);
    expect(again.state.tableBindings[key].sourceRevisions[0].by).toEqual(
      binding.sourceRevisions[0].by
    );
  });

  it('retains the exact receive-v1 golden plan digest after canonical binding upgrade', () => {
    const fields: InventoryReceiveTableFields = {
      source_id: '001',
      name: 'Tube',
      material_key: 'material',
      quantity_kind: 'known',
      quantity: '20.000',
      unit: 'uL',
      quality: 'usable',
      vessel_kind: 'new',
      vessel_key: '',
      location_key: 'location',
      slot: '',
    };
    const options: InventoryTableChoices = {
      namespace: 'source-project:001',
      delimiter: ',',
      materials: [{ key: 'material', materialId: 'scientific-record' }],
      locations: [{ key: 'location', target: { kind: 'unplaced' } }],
      vessels: [],
      skips: [],
    };
    const preview = inventoryTablePreview(null, {
      target: target(null),
      sourceText: table([fields]),
      options,
      bindings: [
        {
          ...options.materials[0],
          kind: 'admitted',
          fingerprint: inventoryTableSha256('scientific-record'),
        },
      ],
      asOf: 20,
      principal: context.principal,
      authority: context.authority,
      maxBytes: 17 * 1024 * 1024,
    });
    expect(preview.kind).toBe('ready');
    expect(preview.planDigest).toBe(
      'sha256:30ae63fbdc34dca2b1efa52b2b1b5237f78b9de70831fd8f5af19198e906abf0'
    );
    if (preview.kind === 'ready')
      expect(Object.values(preview.bindingAdditions)[0].sourceRevisions).toEqual([]);
  });

  it('preserves exact prototype-like source and resolution keys', () => {
    const fields = {
      ...original,
      source_id: 'constructor',
      material_key: '__proto__',
      location_key: 'constructor',
    };
    const options: InventoryTableChoices = {
      namespace: '__proto__',
      delimiter: ',',
      materials: [{ key: '__proto__', materialId: 'scientific-record' }],
      locations: [{ key: 'constructor', target: { kind: 'storage', storageId: 'box' } }],
      vessels: [],
      skips: [],
    };
    const state = receive(
      commands(createInventoryState(), [
        {
          kind: 'create-storage',
          id: 'box',
          name: 'Box',
          slots: ['A', 'B'],
          placement: { kind: 'root' },
        },
      ]),
      fields,
      options
    );
    const changed = { ...fields, quantity: '90', slot: 'B' };
    const proposal = inventorySourceRevisionPreview(state, {
      target: target(state),
      sourceText: table([changed]),
      options: {
        table: options,
        acknowledgements: [
          {
            sourceId: 'constructor',
            expectedPreviousRowSha256: inventoryReceiveTableRowSha256(fields),
            reason: 'Exact source key',
          },
        ],
      },
      preimages: [{ sourceId: 'constructor', fields }],
      asOf: 30,
      principal: context.principal,
      authority: context.authority,
      maxBytes: 17 * 1024 * 1024,
    });
    expect(proposal.kind).toBe('ready');
    expect(proposal.rows[0].sourceId).toBe('constructor');
    expect(proposal.rows[0].previousFields).toEqual(fields);
  });

  it.each([
    'duplicate-source',
    'extra-header',
    'wrong-width',
    'malformed-quote',
    'unknown-quantity-value',
    'missing-source-name',
  ])('refuses strict source failure %s with zero changes', (kind) => {
    const state = fixture();
    const args = input(state);
    let sourceText = args.sourceText;
    if (kind === 'duplicate-source') sourceText = table([revised, revised]);
    if (kind === 'extra-header')
      sourceText = table([revised]).replace('source_id,', 'extra,source_id,');
    if (kind === 'wrong-width') sourceText = table([revised]) + ',extra';
    if (kind === 'malformed-quote') sourceText = table([revised]) + '"';
    if (kind === 'unknown-quantity-value')
      sourceText = table([{ ...revised, quantity_kind: 'unknown', quantity: '90' }]);
    if (kind === 'missing-source-name') sourceText = table([{ ...revised, name: '' }]);
    const before = JSON.stringify(state);
    expect(inventorySourceRevisionPreview(state, { ...args, sourceText }).kind).toBe('blocked');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('blocks authored imported execution identity and byte-limit violations', () => {
    const state = fixture();
    expect(inventorySourceRevisionPreview(state, { ...input(state), maxBytes: 1 }).kind).toBe(
      'blocked'
    );
    const args = input(state) as unknown as { principal: unknown };
    args.principal = { kind: 'imported', source: {}, principal: context.principal };
    expect(
      inventorySourceRevisionPreview(state, args as InventorySourceRevisionPreviewInput).kind
    ).toBe('blocked');
  });

  it('refuses acknowledgement above the existing atomic batch limit', () => {
    const options: InventoryTableChoices = {
      ...tableChoices,
      locations: [{ key: 'location', target: { kind: 'unplaced' } }],
    };
    const initialFields = Array.from({ length: 257 }, (_, index) => ({
      ...original,
      source_id: String(index).padStart(4, '0'),
      slot: '',
    }));
    let state: InventoryState | null = null;
    for (let offset = 0; offset < initialFields.length; offset += 100) {
      const fields = initialFields.slice(offset, offset + 100);
      const sourceText = table(fields);
      const proposal = inventoryTablePreview(state, {
        target: target(state),
        sourceText,
        options,
        bindings: [
          {
            ...options.materials[0],
            kind: 'admitted',
            fingerprint: inventoryTableSha256('scientific'),
          },
        ],
        asOf: 20,
        principal: context.principal,
        authority: context.authority,
        maxBytes: 17 * 1024 * 1024,
      });
      if (proposal.kind !== 'ready') throw new Error(JSON.stringify(proposal.issues));
      const applied = applyInventoryTable(
        state,
        {
          target: target(state),
          sourceText,
          options: proposal.options,
          expectedPlanDigest: proposal.planDigest,
        },
        context,
        17 * 1024 * 1024
      );
      if (!applied.ok) throw new Error(applied.message);
      state = applied.state;
    }
    if (!state) throw new Error('Expected bulk source fixture');
    const before = JSON.stringify(state);
    const preview = inventorySourceRevisionPreview(state, {
      target: target(state),
      sourceText: table(initialFields.map((fields) => ({ ...fields, quantity: '90' }))),
      options: {
        table: options,
        acknowledgements: initialFields.map((fields) => ({
          sourceId: fields.source_id,
          expectedPreviousRowSha256: inventoryReceiveTableRowSha256(fields),
          reason: 'Explicit changed source',
        })),
      },
      preimages: initialFields.map((fields) => ({ sourceId: fields.source_id, fields })),
      asOf: 30,
      principal: context.principal,
      authority: context.authority,
      maxBytes: 17 * 1024 * 1024,
    });
    expect(preview.kind).toBe('blocked');
    expect(preview.issues.some((row) => row.code === 'SOURCE_REVISION_BATCH_TOO_LARGE')).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
  });
});
