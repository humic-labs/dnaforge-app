import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  applyInventoryHierarchy,
  createInventoryState,
  INVENTORY_HIERARCHY_COLUMNS,
  inventoryHierarchyPreview,
  inventoryHierarchyStorageId,
  inventoryStackItems,
  inventoryTableBindingKey,
  inventoryWellId,
  parseInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryHierarchyChoices,
  type InventoryHierarchyFields,
  type InventoryHierarchyPreviewInput,
  type InventoryState,
} from './inventory';

const context: InventoryExecutionContext = {
  at: 1000,
  principal: { kind: 'agent', identityId: 'synthetic-importer' },
  authority: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
};
const options: InventoryHierarchyChoices = {
  namespace: 'synthetic:hierarchy:stable',
  delimiter: ',',
  parents: [],
  skips: [],
};
const field = (
  source_id: string,
  extra: Partial<InventoryHierarchyFields> = {}
): InventoryHierarchyFields => ({
  source_id,
  name: source_id,
  layout_kind: 'named',
  positions: '["A","B"]',
  rows: '',
  columns: '',
  capacity: '',
  parent_kind: 'root',
  parent_key: '',
  slot: '',
  ...extra,
});
const quoted = (value: string) =>
  /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const table = (
  rows: readonly InventoryHierarchyFields[],
  delimiter: ',' | '\t' = ',',
  columns: readonly string[] = INVENTORY_HIERARCHY_COLUMNS
) =>
  '\uFEFF' +
  columns.join(delimiter) +
  '\r\n' +
  rows
    .map((row) =>
      columns.map((column) => quoted(row[column as keyof InventoryHierarchyFields])).join(delimiter)
    )
    .join('\r\n') +
  '\r\n';
const target = (state: InventoryState | null) => ({
  projectId: 'project',
  inventoryId: 'inventory',
  present: state !== null,
  revision: state?.revision ?? 0,
});
const input = (
  state: InventoryState | null,
  rows: readonly InventoryHierarchyFields[],
  choices = options
): InventoryHierarchyPreviewInput => ({
  target: target(state),
  sourceText: table(rows, choices.delimiter),
  options: choices,
  asOf: Math.max(context.at, (state?.lastRecordedAt ?? 0) + 1),
  principal: context.principal,
  authority: context.authority,
  maxBytes: 17 * 1024 * 1024,
});
const preview = (
  state: InventoryState | null,
  rows: readonly InventoryHierarchyFields[],
  choices = options
) => inventoryHierarchyPreview(state, input(state, rows, choices));
function apply(
  state: InventoryState | null,
  rows: readonly InventoryHierarchyFields[],
  choices = options,
  execution = context
): InventoryState {
  const facts = {
    ...input(state, rows, choices),
    asOf: execution.at,
    principal: execution.principal,
    authority: execution.authority,
  };
  const plan = inventoryHierarchyPreview(state, facts);
  if (plan.kind !== 'ready') throw new Error(JSON.stringify(plan.issues));
  const result = applyInventoryHierarchy(
    state,
    {
      target: facts.target,
      sourceText: facts.sourceText,
      options: plan.options,
      expectedPlanDigest: plan.planDigest,
    },
    execution,
    facts.maxBytes
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
function commands(state: InventoryState, batch: readonly InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands: batch },
    { ...context, at: state.lastRecordedAt + 1 }
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
const bound = (state: InventoryState, id: string, namespace = options.namespace) =>
  state.hierarchyBindings[inventoryTableBindingKey(namespace, id)];
const tree = [
  field('00-top', {
    layout_kind: 'fixed-well',
    positions: '',
    rows: '1',
    columns: '2',
    parent_kind: 'source',
    parent_key: 'stack',
    slot: '2',
  }),
  field('plate', {
    layout_kind: 'fixed-well',
    positions: '',
    rows: '2',
    columns: '2',
    parent_kind: 'source',
    parent_key: 'box',
    slot: 'A1',
  }),
  field('stack', {
    layout_kind: 'stack',
    positions: '',
    capacity: '2',
    parent_kind: 'source',
    parent_key: 'shelf',
    slot: 'Stack',
  }),
  field('tube-box', {
    layout_kind: 'removable-tube',
    positions: '',
    rows: '2',
    columns: '2',
    parent_kind: 'source',
    parent_key: 'shelf',
    slot: 'TubeBox',
  }),
  field('box', {
    layout_kind: 'grid',
    positions: '',
    rows: '2',
    columns: '2',
    parent_kind: 'source',
    parent_key: 'shelf',
    slot: 'BoxA',
  }),
  field('shelf', {
    positions: '["BoxA","BoxB","Stack","TubeBox"]',
    parent_kind: 'source',
    parent_key: 'freezer',
    slot: 'Shelf1',
  }),
  field('zz-bottom', {
    layout_kind: 'fixed-well',
    positions: '',
    rows: '1',
    columns: '2',
    parent_kind: 'source',
    parent_key: 'stack',
    slot: '1',
  }),
  field('freezer', { positions: '["Shelf1"]' }),
];

describe('canonical hierarchy import', () => {
  it('creates shuffled hierarchy and explicit stack order through existing owners in one revision', () => {
    const plan = preview(null, tree);
    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') throw new Error('Expected ready hierarchy.');
    expect(plan.commands).toHaveLength(10);
    const state = apply(null, tree);
    expect(state.revision).toBe(1);
    expect(Object.keys(state.storage)).toHaveLength(8);
    expect(Object.keys(state.vessels)).toHaveLength(8);
    expect(Object.keys(state.stocks)).toHaveLength(0);
    expect(Object.keys(state.hierarchyBindings)).toHaveLength(8);
    const stack = bound(state, 'stack').storageId;
    expect(inventoryStackItems(state, stack).map((value) => value.id)).toEqual([
      bound(state, 'zz-bottom').storageId,
      bound(state, '00-top').storageId,
    ]);
    const plate = bound(state, 'plate').storageId;
    expect(state.vessels[inventoryWellId(plate, 'B2')]).toMatchObject({
      kind: 'fixed-well',
      placement: { kind: 'located', storageId: plate, slotId: 'B2' },
    });
    expect(state.storage[plate].configuration.typeVersionId).toBeNull();
    expect(parseInventoryState(state)).toEqual(state);
  });
  it('has deterministic plans independent of input and resolution order except the pinned source bytes', () => {
    const first = preview(null, tree),
      second = preview(null, [...tree].reverse());
    if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('Expected plans.');
    expect(first.commands).toEqual(second.commands);
    expect(first.bindingAdditions).toEqual(second.bindingAdditions);
    expect(first.planDigest).not.toBe(second.planDigest);
  });
  it('preserves leading zeros, spaces, quoted names and non-ASCII text', () => {
    const row = field(' 0007 ', { name: 'Freezer, α\nsecond line', positions: '["01","B"]' });
    const state = apply(null, [row]);
    expect(bound(state, ' 0007 ').sourceId).toBe(' 0007 ');
    expect(state.storage[bound(state, ' 0007 ').storageId].name).toBe(row.name);
    expect(state.storage[bound(state, ' 0007 ').storageId].layout).toEqual({
      kind: 'named',
      slots: ['01', 'B'],
    });
  });
  it('accepts explicit TSV and reordered canonical headers', () => {
    const facts = input(null, [field('root')], { ...options, delimiter: '\t' });
    const columns = [...INVENTORY_HIERARCHY_COLUMNS].reverse();
    expect(
      inventoryHierarchyPreview(null, {
        ...facts,
        sourceText: table([field('root')], '\t', columns),
      }).kind
    ).toBe('ready');
  });
  it.each([
    { positions: '["A","A"]' },
    { positions: '{"A":1,"A":2}' },
    { positions: '[]' },
    { positions: '[""]' },
    { layout_kind: 'grid', positions: '', rows: '01', columns: '2' },
    { layout_kind: 'grid', positions: '', rows: '101', columns: '100' },
    { layout_kind: 'fixed-well', positions: '', rows: '2', columns: '2', capacity: '1' },
    { layout_kind: 'stack', positions: '', capacity: '0' },
    { layout_kind: 'stack', positions: '', capacity: '2', rows: '1' },
    { layout_kind: 'freezer' },
  ])('refuses contradictory layout fields %j without state changes', (extra) => {
    const state = createInventoryState();
    const before = JSON.stringify(state);
    const plan = preview(state, [field('bad', extra)]);
    expect(plan.kind).toBe('blocked');
    expect(plan.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HIERARCHY_LAYOUT_INVALID' })])
    );
    expect(JSON.stringify(state)).toBe(before);
  });
  it('rejects duplicate identities even if one is skipped', () => {
    expect(
      preview(null, [field('same'), field('same')], {
        ...options,
        skips: [{ sourceId: 'same', reason: 'Explicit exclusion' }],
      }).kind
    ).toBe('blocked');
  });
  it('blocks malformed quoting, wrong widths, duplicate/unknown headers and invalid UTF-8 text', () => {
    const facts = input(null, [field('root')]);
    for (const sourceText of [
      facts.sourceText + '"unterminated',
      facts.sourceText + 'too,few\n',
      facts.sourceText.replace('source_id,name', 'source_id,source_id'),
      facts.sourceText.replace('source_id,name', 'unexpected,name'),
      facts.sourceText + '\ud800',
    ])
      expect(inventoryHierarchyPreview(null, { ...facts, sourceText }).kind).toBe('blocked');
  });
  it('requires complete external-parent mappings and refuses extras', () => {
    const parent = commands(createInventoryState(), [
      {
        kind: 'create-storage',
        id: 'existing',
        name: 'Existing',
        slots: ['A'],
        placement: { kind: 'root' },
      },
    ]);
    const child = field('child', { parent_kind: 'existing', parent_key: 'destination', slot: 'A' });
    const missing = preview(parent, [child]);
    expect(missing.kind).toBe('blocked');
    expect(missing.parentKeys).toEqual(['destination']);
    expect(
      preview(parent, [child], {
        ...options,
        parents: [{ key: 'destination', storageId: 'existing' }],
      }).kind
    ).toBe('ready');
    expect(
      preview(parent, [child], {
        ...options,
        parents: [
          { key: 'destination', storageId: 'existing' },
          { key: 'extra', storageId: 'existing' },
        ],
      }).kind
    ).toBe('blocked');
  });
  it('refuses missing and cyclic source parents before commands', () => {
    for (const rows of [
      [field('self', { parent_kind: 'source', parent_key: 'self', slot: 'A' })],
      [
        field('first', { parent_kind: 'source', parent_key: 'second', slot: 'A' }),
        field('second', { parent_kind: 'source', parent_key: 'first', slot: 'A' }),
      ],
      [field('child', { parent_kind: 'source', parent_key: 'absent', slot: 'A' })],
    ])
      expect(preview(null, rows).kind).toBe('blocked');
  });
  it('refuses a late occupied slot for the entire hierarchy', () => {
    const state = createInventoryState();
    const rows = [
      field('root'),
      field('first', { parent_kind: 'source', parent_key: 'root', slot: 'A' }),
      field('late', { parent_kind: 'source', parent_key: 'root', slot: 'A' }),
    ];
    const plan = preview(state, rows);
    expect(plan.kind).toBe('blocked');
    expect(plan.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLOT_OCCUPIED' })])
    );
    expect(state).toEqual(createInventoryState());
  });
  it('respects tube-box and fixed-well placement restrictions', () => {
    for (const kind of ['removable-tube', 'fixed-well']) {
      const plan = preview(null, [
        field('root', { layout_kind: kind, positions: '', rows: '1', columns: '1' }),
        field('child', { parent_kind: 'source', parent_key: 'root', slot: 'A1' }),
      ]);
      expect(plan.kind).toBe('blocked');
    }
  });
  it.each(['0', '01', '2', '3', '1.0'])(
    'refuses noncontiguous or noncanonical first stack ordinal %s',
    (slot) => {
      const plan = preview(null, [
        field('stack', { layout_kind: 'stack', positions: '', capacity: '2' }),
        field('plate', {
          layout_kind: 'fixed-well',
          positions: '',
          rows: '1',
          columns: '1',
          parent_kind: 'source',
          parent_key: 'stack',
          slot,
        }),
      ]);
      expect(plan.kind).toBe('blocked');
    }
  );
  it('appends to an existing stack only after its current prefix', () => {
    const state = commands(createInventoryState(), [
      {
        kind: 'create-layout-storage',
        id: 'existing-stack',
        name: 'Stack',
        layout: { kind: 'stack', capacity: 2, removal: 'top-only' },
        placement: { kind: 'root' },
      },
      {
        kind: 'create-layout-storage',
        id: 'first',
        name: 'First plate',
        layout: { kind: 'fixed-well', rows: 1, columns: 1 },
        placement: { kind: 'root' },
      },
      { kind: 'push-stack', stackId: 'existing-stack', item: { kind: 'storage', id: 'first' } },
    ]);
    const selected = { ...options, parents: [{ key: 'target', storageId: 'existing-stack' }] };
    const row = field('second', {
      parent_kind: 'existing',
      parent_key: 'target',
      slot: '2',
      layout_kind: 'fixed-well',
      positions: '',
      rows: '1',
      columns: '1',
    });
    const after = apply(state, [row], selected, { ...context, at: 1001 });
    expect(inventoryStackItems(after, 'existing-stack').map((value) => value.id)).toEqual([
      'first',
      bound(after, 'second').storageId,
    ]);
    expect(preview(state, [{ ...row, slot: '1' }], selected).kind).toBe('blocked');
  });
  it('does not duplicate or reset placement or disposal after a bound source is reused', () => {
    const rows = [
      field('root'),
      field('child', {
        parent_kind: 'source',
        parent_key: 'root',
        slot: 'A',
        layout_kind: 'fixed-well',
        positions: '',
        rows: '1',
        columns: '1',
      }),
    ];
    let state = apply(null, rows);
    const original = state.hierarchyBindings;
    state = commands(state, [
      {
        kind: 'move-storage',
        id: bound(state, 'child').storageId,
        placement: { kind: 'located', storageId: bound(state, 'root').storageId, slotId: 'B' },
      },
    ]);
    expect(preview(state, [...rows].reverse()).kind).toBe('no-change');
    expect(state.hierarchyBindings).toEqual(original);
    state = commands(state, [
      {
        kind: 'dispose-plate',
        id: bound(state, 'child').storageId,
        reason: 'Synthetic end of life',
      },
    ]);
    expect(preview(state, rows).kind).toBe('no-change');
    expect(preview(state, [rows[0], { ...rows[1], name: 'External renamed' }]).kind).toBe(
      'blocked'
    );
  });
  it('refuses a changed original external-parent mapping even if current placement matches it', () => {
    const state = commands(createInventoryState(), [
      {
        kind: 'create-storage',
        id: 'first',
        name: 'First',
        slots: ['A'],
        placement: { kind: 'root' },
      },
      {
        kind: 'create-storage',
        id: 'second',
        name: 'Second',
        slots: ['A'],
        placement: { kind: 'root' },
      },
    ]);
    const rows = [
      field('child', { parent_kind: 'existing', parent_key: 'destination', slot: 'A' }),
    ];
    const selected = { ...options, parents: [{ key: 'destination', storageId: 'first' }] };
    const received = apply(state, rows, selected, { ...context, at: 1001 });
    const moved = commands(received, [
      {
        kind: 'move-storage',
        id: bound(received, 'child').storageId,
        placement: { kind: 'located', storageId: 'second', slotId: 'A' },
      },
    ]);
    expect(
      preview(moved, rows, { ...selected, parents: [{ key: 'destination', storageId: 'second' }] })
        .kind
    ).toBe('blocked');
  });
  it('does not accept occupied generated identities without a binding', () => {
    const id = inventoryHierarchyStorageId(target(null), options.namespace, 'root');
    const state = commands(createInventoryState(), [
      {
        kind: 'create-storage',
        id,
        name: 'Unrelated occupied identifier',
        slots: ['A'],
        placement: { kind: 'root' },
      },
    ]);
    expect(preview(state, [field('root')]).kind).toBe('blocked');
  });
  it('requires skip reasons and never invents an unbound skipped parent', () => {
    const rows = [
      field('root'),
      field('child', { parent_kind: 'source', parent_key: 'root', slot: 'A' }),
    ];
    expect(
      preview(null, rows, {
        ...options,
        skips: [{ sourceId: 'root', reason: 'Explicit exclusion' }],
      }).kind
    ).toBe('blocked');
    expect(
      preview(null, [field('root')], { ...options, skips: [{ sourceId: 'root', reason: '' }] }).kind
    ).toBe('blocked');
    expect(
      preview(null, [field('root')], {
        ...options,
        skips: [{ sourceId: 'root', reason: 'Explicit exclusion' }],
      }).kind
    ).toBe('no-change');
    const state = apply(null, [field('root')]);
    expect(
      preview(state, rows, {
        ...options,
        skips: [{ sourceId: 'root', reason: 'Already present parent excluded from this proposal' }],
      }).kind
    ).toBe('ready');
  });
  it('handles prototype-like exact source keys and explicit parent keys', () => {
    const rows = [
      field('__proto__'),
      field('constructor', { parent_kind: 'source', parent_key: '__proto__', slot: 'A' }),
    ];
    const state = apply(null, rows, { ...options, namespace: '__proto__' });
    expect(Object.keys(state.hierarchyBindings)).toHaveLength(2);
    expect(preview(state, rows, { ...options, namespace: '__proto__' }).kind).toBe('no-change');
  });
  it('refuses generated command counts beyond 256 without splitting', () => {
    const rows = Array.from({ length: 257 }, (_, i) => field(String(i)));
    const plan = preview(null, rows);
    expect(plan.kind).toBe('blocked');
    expect(plan.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'HIERARCHY_BATCH_TOO_LARGE' })])
    );
  });
  it('pins source, scope and revision while excluding the native acceptance clock from the plan', () => {
    const facts = input(null, [field('root')]);
    const first = inventoryHierarchyPreview(null, facts),
      later = inventoryHierarchyPreview(null, { ...facts, asOf: 2000 });
    if (first.kind !== 'ready' || later.kind !== 'ready') throw new Error('Expected ready plans.');
    expect(later.planDigest).toBe(first.planDigest);
    expect(
      applyInventoryHierarchy(
        null,
        {
          target: facts.target,
          sourceText: facts.sourceText + '\n',
          options,
          expectedPlanDigest: first.planDigest,
        },
        context,
        facts.maxBytes
      ).ok
    ).toBe(false);
    expect(
      inventoryHierarchyPreview(null, { ...facts, target: { ...facts.target, present: true } }).kind
    ).toBe('blocked');
    expect(inventoryHierarchyPreview(null, { ...facts, maxBytes: 1 }).kind).toBe('blocked');
  });
  it('preserves stable physical bindings and wells across archive adoption into another scope', () => {
    const state = apply(null, tree);
    const adopted = adoptInventoryState(
      null,
      state,
      {
        source: {
          archiveSha256: 'sha256:' + 'b'.repeat(64),
          projectId: 'origin',
          inventoryId: 'origin-inventory',
          revision: state.revision,
        },
        materialBindings: {},
      },
      { ...context, at: 2000 }
    );
    if (!adopted.ok) throw new Error(adopted.message);
    expect(adopted.state.hierarchyBindings).toEqual(state.hierarchyBindings);
    expect(adopted.state.storage).toEqual(state.storage);
    expect(adopted.state.vessels).toEqual(state.vessels);
    const plan = inventoryHierarchyPreview(adopted.state, {
      ...input(adopted.state, tree),
      target: {
        ...target(adopted.state),
        projectId: 'destination',
        inventoryId: 'destination-inventory',
      },
      asOf: 3000,
    });
    expect(plan.kind).toBe('no-change');
  });
  it('upcasts v15 without rewriting input and validates hierarchy binding keys and references', () => {
    const state = apply(null, [field('root')]);
    const { hierarchyBindings: _hierarchy, ...rest } = state;
    const raw = { ...rest, schema: 'dnaforge.inventory.v15' };
    const bytes = JSON.stringify(raw);
    const upgraded = parseInventoryState(raw);
    expect(upgraded.schema).toBe('dnaforge.inventory.v16');
    expect(upgraded.hierarchyBindings).toEqual({});
    expect(upgraded.tableBindings).toEqual(state.tableBindings);
    expect(upgraded.observations).toEqual(state.observations);
    expect(JSON.stringify(raw)).toBe(bytes);
    const binding = bound(state, 'root');
    expect(() => parseInventoryState({ ...state, hierarchyBindings: { forged: binding } })).toThrow(
      'exact source namespace'
    );
    expect(() =>
      parseInventoryState({
        ...state,
        hierarchyBindings: {
          [inventoryTableBindingKey(binding.namespace, binding.sourceId)]: {
            ...binding,
            storageId: 'absent',
          },
        },
      })
    ).toThrow('existing storage');
  });
});
