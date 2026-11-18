import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  applyInventoryTable,
  createInventoryState,
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  INVENTORY_SCHEMA,
  inventoryScientificReferences,
  inventoryTableBindingKey,
  inventoryTablePreview,
  inventoryTableRecordIds,
  inventoryTableSha256,
  inventoryWellId,
  parseInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryReceiveTableFields,
  type InventoryState,
  type InventoryTableChoices,
  type InventoryTablePreviewInput,
} from './inventory';

const context: InventoryExecutionContext = {
  at: 20,
  principal: { kind: 'agent', identityId: 'receiver' },
  authority: { kind: 'local-profile', profileKey: 'profile' },
};
const choices: InventoryTableChoices = {
  namespace: 'source-project:001',
  delimiter: ',',
  materials: [{ key: 'material', materialId: 'scientific-record' }],
  locations: [{ key: 'location', target: { kind: 'unplaced' } }],
  vessels: [],
  skips: [],
};
const row: InventoryReceiveTableFields = {
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
function table(rows: readonly InventoryReceiveTableFields[], delimiter = ','): string {
  const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
  return [
    INVENTORY_RECEIVE_TABLE_COLUMNS.join(delimiter),
    ...rows.map((record) =>
      INVENTORY_RECEIVE_TABLE_COLUMNS.map((key) => quote(record[key])).join(delimiter)
    ),
  ].join('\r\n');
}
function input(
  state: InventoryState | null,
  sourceText = table([row]),
  options = choices
): InventoryTablePreviewInput {
  return {
    target: {
      projectId: 'project',
      inventoryId: 'inventory',
      present: state !== null,
      revision: state?.revision ?? 0,
    },
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
  };
}
function receive(
  state: InventoryState | null = null,
  sourceText = table([row]),
  options = choices
): InventoryState {
  const proposal = input(state, sourceText, options);
  const preview = inventoryTablePreview(state, proposal);
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview.issues));
  const result = applyInventoryTable(
    state,
    {
      target: proposal.target,
      sourceText,
      options: preview.options,
      expectedPlanDigest: preview.planDigest,
    },
    context,
    proposal.maxBytes
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
function execute(state: InventoryState, commands: readonly InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...context, at: state.lastRecordedAt + 1 }
  );
  if (!result.ok) throw new Error(result.message);
  return parseInventoryState(result.state);
}
function fixture(): InventoryState {
  return execute(createInventoryState(), [
    {
      kind: 'create-storage',
      id: 'freezer',
      name: 'Freezer',
      slots: ['A1', 'A2'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-layout-storage',
      id: 'plate',
      name: 'Plate',
      layout: { kind: 'fixed-well', rows: 1, columns: 2 },
      placement: { kind: 'root' },
    },
    {
      kind: 'create-vessel',
      id: 'existing-tube',
      name: 'Existing tube',
      placement: { kind: 'unplaced' },
    },
  ]);
}

describe('strict canonical receive tables', () => {
  it('pins raw source while preserving exact IDs, quoted names, known zero and explicit unknowns', () => {
    const sourceText =
      '\uFEFF' +
      table([
        { ...row, source_id: ' 001 ', name: 'Tube, "one"\ncontinued', quantity: '0.000' },
        { ...row, source_id: '001', quantity_kind: 'unknown', quantity: '', unit: '' },
      ]) +
      '\r\n';
    const preview = inventoryTablePreview(null, input(null, sourceText));
    expect(preview.kind).toBe('ready');
    expect(preview.sourceSha256).toBe(inventoryTableSha256(sourceText));
    const state = receive(null, sourceText);
    expect(state.schema).toBe(INVENTORY_SCHEMA);
    expect(state.revision).toBe(1);
    expect(Object.values(state.stocks).map((stock) => stock.quantity)).toEqual([
      { kind: 'known', value: '0', unit: 'uL' },
      { kind: 'unknown', unit: 'uL' },
    ]);
    expect(state.vessels[Object.values(state.tableBindings)[0].vesselId].name).toBe(
      'Tube, "one"\ncontinued'
    );
    expect(Object.values(state.tableBindings).map((binding) => binding.sourceId)).toEqual([
      ' 001 ',
      '001',
    ]);
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('accepts TSV and reordered canonical headers without guessing a delimiter', () => {
    const columns = [...INVENTORY_RECEIVE_TABLE_COLUMNS].reverse();
    const sourceText = [columns.join('\t'), columns.map((key) => row[key]).join('\t')].join('\n');
    const options = { ...choices, delimiter: '\t' as const };
    expect(inventoryTablePreview(null, input(null, sourceText, options)).kind).toBe('ready');
    expect(inventoryTablePreview(null, input(null, sourceText)).kind).toBe('blocked');
  });

  it.each([
    ['extra header', table([row]).replace('source_id,', 'extra,source_id,')],
    ['duplicate header', table([row]).replace('name,', 'source_id,')],
    ['missing header', table([row]).replace('name,', '')],
    ['row width', table([row]) + ',extra'],
    [
      'interior blank row',
      table([row]) + '\n\n' + INVENTORY_RECEIVE_TABLE_COLUMNS.map((key) => row[key]).join(','),
    ],
    ['unclosed quote', table([row]) + '\n"unfinished'],
    ['text after closing quote', table([row]) + '\n"001"x,rest'],
    ['invalid UTF-8 text', table([{ ...row, name: '\uD800' }])],
  ])('blocks %s with no executable proposal', (_name, sourceText) => {
    const preview = inventoryTablePreview(null, input(null, sourceText));
    expect(preview).toMatchObject({
      kind: 'blocked',
      commands: [],
      bindingAdditions: {},
      options: null,
      planDigest: null,
    });
  });

  it.each([
    { ...row, quantity_kind: '', quantity: '', unit: '' },
    { ...row, quantity_kind: 'unknown' },
    { ...row, quantity: '-1' },
    { ...row, quantity: '1e3' },
    { ...row, unit: 'µL' },
    { ...row, quality: '' },
    { ...row, vessel_kind: '' },
    { ...row, location_key: '' },
    { ...row, source_id: '' },
  ])('requires explicit valid row facts %#', (badRow) => {
    expect(inventoryTablePreview(null, input(null, table([badRow]))).kind).toBe('blocked');
  });

  it('reports explicit material and location keys before any bindings exist', () => {
    const options = { ...choices, materials: [], locations: [] };
    const preview = inventoryTablePreview(null, input(null, table([row]), options));
    expect(preview).toMatchObject({
      kind: 'blocked',
      materialKeys: ['material'],
      locationKeys: ['location'],
      commands: [],
    });
    expect(preview.issues.map((value) => value.code)).toContain('TABLE_MATERIAL_UNRESOLVED');
    expect(preview.issues.map((value) => value.code)).toContain('TABLE_LOCATION_UNRESOLVED');
  });

  it('rejects duplicate source identities even when explicitly skipped', () => {
    const options = {
      ...choices,
      materials: [],
      locations: [],
      skips: [{ sourceId: row.source_id, reason: 'Explicit exclusion' }],
    };
    const preview = inventoryTablePreview(null, input(null, table([row, row]), options));
    expect(preview.kind).toBe('blocked');
    expect(preview.issues.map((value) => value.code)).toContain('TABLE_SOURCE_ID_DUPLICATE');
  });

  it('allows an explicit semantic-row skip without inventing stock or a receipt', () => {
    const badRow = { ...row, quantity_kind: 'unresolved' };
    const options = {
      ...choices,
      materials: [],
      locations: [],
      skips: [{ sourceId: row.source_id, reason: 'Verify original amount first' }],
    };
    const preview = inventoryTablePreview(null, input(null, table([badRow]), options));
    expect(preview).toMatchObject({
      kind: 'no-change',
      commands: [],
      rows: [{ kind: 'skipped', reason: 'Verify original amount first' }],
    });
  });

  it('keeps prototype-like keys exact and refuses duplicate, extra or unavailable resolutions', () => {
    const sourceText = table([
      { ...row, source_id: '__proto__', material_key: 'constructor', location_key: '__proto__' },
    ]);
    const options = {
      ...choices,
      namespace: '__proto__',
      materials: [{ key: 'constructor', materialId: 'scientific-record' }],
      locations: [{ key: '__proto__', target: { kind: 'unplaced' as const } }],
    };
    expect(inventoryTablePreview(null, input(null, sourceText, options)).kind).toBe('ready');
    expect(
      inventoryTablePreview(
        null,
        input(null, sourceText, {
          ...options,
          materials: [...options.materials, ...options.materials],
        })
      ).kind
    ).toBe('blocked');
    expect(
      inventoryTablePreview(
        null,
        input(null, sourceText, { ...options, vessels: [{ key: 'unused', vesselId: 'tube' }] })
      ).kind
    ).toBe('blocked');
    const unavailable = input(null, sourceText, options);
    expect(
      inventoryTablePreview(null, {
        ...unavailable,
        bindings: [{ ...options.materials[0], kind: 'unavailable', reason: 'Foreign project' }],
      }).kind
    ).toBe('blocked');
  });

  it('receives into an existing empty movable vessel and a permanent well without moving either', () => {
    const state = fixture();
    const sourceText = table([
      { ...row, name: '', vessel_kind: 'existing', vessel_key: 'tube', location_key: '' },
      {
        ...row,
        source_id: '002',
        name: '',
        vessel_kind: 'existing',
        vessel_key: 'well',
        location_key: '',
      },
    ]);
    const options = {
      ...choices,
      locations: [],
      vessels: [
        { key: 'tube', vesselId: 'existing-tube' },
        { key: 'well', vesselId: inventoryWellId('plate', 'A1') },
      ],
    };
    const result = receive(state, sourceText, options);
    expect(result.vessels).toEqual(state.vessels);
    expect(Object.values(result.stocks).map((stock) => stock.vesselId)).toEqual([
      'existing-tube',
      inventoryWellId('plate', 'A1'),
    ]);
    expect(Object.values(result.tableBindings).map((binding) => binding.destination)).toEqual([
      { kind: 'existing-vessel' },
      { kind: 'existing-vessel' },
    ]);
  });

  it('rolls back a late occupied placement and two rows targeting the same vessel', () => {
    const state = fixture(),
      before = JSON.stringify(state);
    const options = {
      ...choices,
      locations: [{ key: 'location', target: { kind: 'storage' as const, storageId: 'freezer' } }],
    };
    const collision = inventoryTablePreview(
      state,
      input(
        state,
        table([
          { ...row, slot: 'A1' },
          { ...row, source_id: '002', slot: 'A1' },
        ]),
        options
      )
    );
    expect(collision.kind).toBe('blocked');
    expect(collision.commands).toEqual([]);
    const sameVessel = {
      ...choices,
      locations: [],
      vessels: [{ key: 'tube', vesselId: 'existing-tube' }],
    };
    const existingRow = {
      ...row,
      name: '',
      vessel_kind: 'existing',
      vessel_key: 'tube',
      location_key: '',
    };
    expect(
      inventoryTablePreview(
        state,
        input(state, table([existingRow, { ...existingRow, source_id: '002' }]), sameVessel)
      ).kind
    ).toBe('blocked');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('does not regenerate existing identities after source reorder, consumption, movement, quarantine or disposal', () => {
    const source = [row, { ...row, source_id: '002' }];
    let state = receive(fixture(), table(source));
    const first = state.tableBindings[inventoryTableBindingKey(choices.namespace, '001')];
    state = execute(state, [
      {
        kind: 'consume',
        stockId: first.stockId,
        quantity: { value: '1', unit: 'uL' },
        reason: 'Actual use',
      },
      {
        kind: 'move-vessel',
        id: first.vesselId,
        placement: { kind: 'located', storageId: 'freezer', slotId: 'A1' },
      },
      {
        kind: 'set-quality',
        stockId: first.stockId,
        quality: 'quarantined',
        reason: 'Observation',
      },
      { kind: 'dispose-vessel', id: first.vesselId, reason: 'Actual disposal' },
    ]);
    const preview = inventoryTablePreview(state, input(state, table([...source].reverse())));
    expect(preview).toMatchObject({ kind: 'no-change', commands: [] });
    expect(preview.rows.every((value) => value.kind === 'unchanged')).toBe(true);
    expect(state.stocks[first.stockId].quantity).toEqual({
      kind: 'known',
      value: '19',
      unit: 'uL',
    });
    expect(state.vessels[first.vesselId].lifecycle).toBe('disposed');
  });

  it('requires reconciliation for revised source facts or changed explicit resolutions', () => {
    const state = receive();
    for (const sourceText of [
      table([{ ...row, quantity: '21' }]),
      table([{ ...row, quantity: '20' }]),
      table([{ ...row, name: 'Renamed source' }]),
    ]) {
      const preview = inventoryTablePreview(state, input(state, sourceText));
      expect(preview.kind).toBe('blocked');
      expect(preview.issues.map((value) => value.code)).toContain('TABLE_ROW_NEEDS_RECONCILIATION');
    }
    const changed = {
      ...choices,
      materials: [{ key: 'material', materialId: 'different-record' }],
    };
    expect(inventoryTablePreview(state, input(state, table([row]), changed)).kind).toBe('blocked');
  });

  it('permits a mixed proposal with unchanged and new rows in one revision', () => {
    const state = receive();
    const preview = inventoryTablePreview(
      state,
      input(state, table([row, { ...row, source_id: '002' }]))
    );
    expect(preview.kind).toBe('ready');
    expect(preview.commands).toHaveLength(2);
    expect(preview.rows.map((value) => value.kind)).toEqual(['unchanged', 'create']);
    const result = receive(state, table([row, { ...row, source_id: '002' }]));
    expect(result.revision).toBe(state.revision + 1);
    expect(Object.keys(result.stocks)).toHaveLength(2);
  });

  it('refuses generated physical IDs occupied without a lifetime source binding', () => {
    const scope = input(null).target;
    const ids = inventoryTableRecordIds(scope, choices.namespace, row.source_id);
    const state = execute(createInventoryState(), [
      {
        kind: 'create-vessel',
        id: ids.vesselId,
        name: 'Unrelated physical tube',
        placement: { kind: 'unplaced' },
      },
    ]);
    const preview = inventoryTablePreview(state, input(state));
    expect(preview.kind).toBe('blocked');
    expect(preview.issues.map((value) => value.code)).toContain('TABLE_ID_OCCUPIED');
  });

  it('counts generated commands and refuses oversized atomic proposals without silently splitting', () => {
    const source = Array.from({ length: 128 }, (_, index) => ({
      ...row,
      source_id: String(index),
    }));
    expect(inventoryTablePreview(null, input(null, table(source))).kind).toBe('ready');
    const oversized = inventoryTablePreview(
      null,
      input(null, table([...source, { ...row, source_id: '128' }]))
    );
    expect(oversized.kind).toBe('blocked');
    expect(oversized.issues.map((value) => value.code)).toContain('TABLE_BATCH_TOO_LARGE');
    expect(oversized.commands).toEqual([]);
  });

  it('pins target presence/revision, source and fingerprints while excluding acceptance clock from the plan', () => {
    const proposal = input(null),
      preview = inventoryTablePreview(null, proposal);
    if (preview.kind !== 'ready') throw new Error('Expected plan');
    expect(inventoryTablePreview(null, { ...proposal, asOf: 21 })).toMatchObject({
      kind: 'ready',
      planDigest: preview.planDigest,
    });
    const changedFingerprint = inventoryTablePreview(null, {
      ...proposal,
      bindings: proposal.bindings.map((binding) => ({
        ...binding,
        kind: 'admitted' as const,
        fingerprint: inventoryTableSha256('changed'),
      })),
    });
    expect(changedFingerprint.planDigest).not.toBe(preview.planDigest);
    expect(
      inventoryTablePreview(null, { ...proposal, target: { ...proposal.target, present: true } })
        .kind
    ).toBe('blocked');
    expect(
      applyInventoryTable(
        null,
        {
          target: proposal.target,
          sourceText: table([{ ...row, quantity: '21' }]),
          options: preview.options,
          expectedPlanDigest: preview.planDigest,
        },
        context,
        proposal.maxBytes
      ).ok
    ).toBe(false);
    const state = receive();
    expect(
      inventoryTablePreview(state, {
        ...input(state),
        target: { ...proposal.target, present: true },
      }).kind
    ).toBe('blocked');
  });

  it('preserves v12 origins/imported actors during strict upcast and rejects forged binding maps', () => {
    let source = receive();
    source = execute(source, [
      {
        kind: 'attach-item-code',
        id: 'source-code',
        namespace: 'lab',
        value: '0001',
        item: { kind: 'vessel', id: Object.values(source.tableBindings)[0].vesselId },
        reason: 'Recorded before archive adoption',
      },
    ]);
    const adopted = adoptInventoryState(
      null,
      source,
      {
        source: {
          archiveSha256: inventoryTableSha256('archive'),
          projectId: 'source',
          inventoryId: 'inventory',
          revision: source.revision,
        },
        materialBindings: { 'scientific-record': 'destination-record' },
      },
      { ...context, at: 100 }
    );
    if (!adopted.ok) throw new Error(adopted.message);
    const {
      vesselBindings: _vessels,
      hierarchyBindings: _hierarchy,
      tableBindings: _bindings,
      observations: _observations,
      scientificWorks: _scientificWorks,
      scientificCitations: _scientificCitations,
      platePlanVersions: _platePlanVersions,
      scientificCitationWithdrawals: _scientificCitationWithdrawals,
      expectedDeliveries: _expected,
      arrivalAllocations: _allocations,
      reorderRules: _rules,
      arrivals: _arrivals,
      lotRecalls: _recalls,
      openingObservations: _openingObservations,
      validityFacts: _validityFacts,
      ...v12
    } = adopted.state;
    const old = {
      ...v12,
      schema: 'dnaforge.inventory.v12',
      stocks: Object.fromEntries(
        Object.entries(v12.stocks).map(
          ([
            id,
            {
              lotConstraints: _constraints,
              opening: _opening,
              validity: _validity,
              inheritedValidity: _inheritedValidity,
              ...stock
            },
          ]) => [id, stock]
        )
      ),
      lots: Object.fromEntries(
        Object.entries(v12.lots).map(
          ([
            id,
            {
              lotConstraints: _constraints,
              controls: _controls,
              validity: _validity,
              inheritedValidity: _inheritedValidity,
              ...lot
            },
          ]) => [id, lot]
        )
      ),
      vessels: Object.fromEntries(
        Object.entries(v12.vessels).map(([id, { contentsKnowledge: _knowledge, ...vessel }]) => [
          id,
          vessel,
        ])
      ),
    };
    const before = JSON.stringify(old),
      upcast = parseInventoryState(old);
    expect(JSON.stringify(old)).toBe(before);
    expect(upcast.origin).toEqual(adopted.state.origin);
    expect(upcast.itemCodes['source-code'].assignedBy).toEqual(
      adopted.state.itemCodes['source-code'].assignedBy
    );
    expect(upcast.itemCodes['source-code'].assignedBy.kind).toBe('imported');
    expect(upcast.tableBindings).toEqual({});
    expect(upcast.schema).toBe(INVENTORY_SCHEMA);
    const binding = Object.values(source.tableBindings)[0];
    expect(() => parseInventoryState({ ...source, tableBindings: { forged: binding } })).toThrow(
      'exact source namespace'
    );
    expect(() =>
      parseInventoryState({
        ...source,
        tableBindings: {
          ...source.tableBindings,
          [inventoryTableBindingKey('another', 'row')]: {
            ...binding,
            namespace: 'another',
            sourceId: 'row',
            materialId: 'foreign',
          },
        },
      })
    ).toThrow('existing stock');
  });

  it('maps binding material references during adoption and resolves bindings before deriving destination-scoped IDs', () => {
    const source = receive();
    const adopted = adoptInventoryState(
      null,
      source,
      {
        source: {
          archiveSha256: inventoryTableSha256('archive'),
          projectId: 'source-project',
          inventoryId: 'source-inventory',
          revision: source.revision,
        },
        materialBindings: { 'scientific-record': 'destination-record' },
      },
      { ...context, at: 100 }
    );
    if (!adopted.ok) throw new Error(adopted.message);
    const binding = Object.values(adopted.state.tableBindings)[0];
    expect(binding.materialId).toBe('destination-record');
    expect(binding.stockId).toBe(Object.values(source.tableBindings)[0].stockId);
    expect(
      inventoryScientificReferences(adopted.state)
        .find((value) => value.materialId === 'destination-record')
        ?.pointers.some((pointer) => pointer.startsWith('/tableBindings/'))
    ).toBe(true);
    const options = {
      ...choices,
      materials: [{ key: 'material', materialId: 'destination-record' }],
    };
    const proposal = input(adopted.state, table([row]), options);
    const preview = inventoryTablePreview(adopted.state, {
      ...proposal,
      asOf: 101,
      target: {
        ...proposal.target,
        projectId: 'destination-project',
        inventoryId: 'destination-inventory',
      },
    });
    expect(preview).toMatchObject({
      kind: 'no-change',
      rows: [{ stockId: binding.stockId, vesselId: binding.vesselId, kind: 'unchanged' }],
    });
  });
});
