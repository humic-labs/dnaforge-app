import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  InventoryValidationError,
  parseInventoryCommand,
  parseInventoryCommandBatch,
  parseInventoryState,
  type InventoryCommand,
  type InventoryState,
  type InventoryTransition,
} from './inventory';

function decide(state: InventoryState, commands: readonly InventoryCommand[]): InventoryTransition {
  return applyInventoryCommandBatch(
    state,
    parseInventoryCommandBatch({ expectedRevision: state.revision, commands })
  );
}

function run(state: InventoryState, commands: readonly InventoryCommand[]): InventoryState {
  const result = decide(state, commands);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.state;
}

function fixture(value = '100'): InventoryState {
  return run(createInventoryState(), [
    {
      kind: 'create-storage',
      id: 'freezer',
      name: 'Freezer',
      slots: ['shelf-1', 'shelf-2'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-storage',
      id: 'box',
      name: 'Box',
      slots: ['A1', 'B1'],
      placement: { kind: 'located', storageId: 'freezer', slotId: 'shelf-1' },
    },
    {
      kind: 'create-vessel',
      id: 'tube',
      name: 'Preparation tube',
      placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
    },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'tube',
      materialId: 'material-1',
      quantity: { kind: 'known', value, unit: 'uL' },
      quality: 'usable',
    },
  ]);
}

function freeze(state: InventoryState): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(visit);
    Object.freeze(value);
  };
  visit(state);
}

describe('physical inventory command transitions', () => {
  it('receives a distinct stock into a vessel and commits one atomic revision', () => {
    const state = fixture();
    expect(state.revision).toBe(1);
    expect(state.stocks.stock).toEqual({
      id: 'stock',
      source: { kind: 'unattributed', rootStockId: 'stock' },
      vesselId: 'tube',
      materialId: 'material-1',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    });
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('allows an empty unplaced vessel without creating fictional stock', () => {
    const state = run(createInventoryState(), [
      { kind: 'create-vessel', id: 'empty', name: 'Empty tube', placement: { kind: 'unplaced' } },
    ]);
    expect(state.vessels.empty.lifecycle).toBe('active');
    expect(Object.keys(state.stocks)).toEqual([]);
  });

  it('preserves stock and immediate child placement when its containing box moves', () => {
    const initial = fixture();
    freeze(initial);
    const state = run(initial, [
      {
        kind: 'move-storage',
        id: 'box',
        placement: { kind: 'located', storageId: 'freezer', slotId: 'shelf-2' },
      },
    ]);
    expect(state.vessels.tube).toEqual(initial.vessels.tube);
    expect(state.stocks.stock).toEqual(initial.stocks.stock);
    expect(state.storage.box.placement).toEqual({
      kind: 'located',
      storageId: 'freezer',
      slotId: 'shelf-2',
    });
    expect(initial.storage.box.placement).toMatchObject({ slotId: 'shelf-1' });
  });

  it('releases a vessel position and places it again through explicit moves', () => {
    const unplaced = run(fixture(), [
      { kind: 'move-vessel', id: 'tube', placement: { kind: 'unplaced' } },
    ]);
    const placed = run(unplaced, [
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'B1' },
      },
    ]);
    expect(unplaced.vessels.tube.placement).toEqual({ kind: 'unplaced' });
    expect(placed.vessels.tube.placement).toMatchObject({ slotId: 'B1' });
  });

  it('refuses stale competing commands without mutating either placement or balance', () => {
    const initial = fixture();
    const moved = run(initial, [
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'B1' },
      },
    ]);
    const result = applyInventoryCommandBatch(moved, {
      expectedRevision: initial.revision,
      commands: [
        { kind: 'consume', stockId: 'stock', quantity: { value: '20', unit: 'uL' }, reason: 'PCR' },
      ],
    });
    expect(result).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
    expect(moved.stocks.stock.quantity).toMatchObject({ value: '100' });
    expect(moved.vessels.tube.placement).toMatchObject({ slotId: 'B1' });
  });

  it.each([
    [
      {
        kind: 'move-storage',
        id: 'freezer',
        placement: { kind: 'located', storageId: 'box', slotId: 'B1' },
      },
      'CONTAINMENT_CYCLE',
    ],
    [
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'absent' },
      },
      'INVALID_PLACEMENT',
    ],
    [
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'absent', slotId: 'A1' },
      },
      'STORAGE_NOT_FOUND',
    ],
    [
      {
        kind: 'create-vessel',
        id: 'second',
        name: 'Second tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
      },
      'SLOT_OCCUPIED',
    ],
    [
      {
        kind: 'create-vessel',
        id: 'stock',
        name: 'Reused identity',
        placement: { kind: 'unplaced' },
      },
      'ID_ALREADY_EXISTS',
    ],
  ] as const)('rejects an invalid physical placement or identity: %s', (command, code) => {
    const state = fixture();
    const before = JSON.stringify(state);
    freeze(state);
    expect(decide(state, [command])).toMatchObject({ ok: false, code });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('rolls back an earlier consumption and placement when a later batch command fails', () => {
    const state = fixture();
    const before = JSON.stringify(state);
    freeze(state);
    const result = decide(state, [
      { kind: 'consume', stockId: 'stock', quantity: { value: '20', unit: 'uL' }, reason: 'PCR' },
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'B1' },
      },
      {
        kind: 'move-storage',
        id: 'freezer',
        placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
      },
    ]);
    expect(result).toMatchObject({ ok: false, code: 'CONTAINMENT_CYCLE' });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('rejects a second physical stock in a vessel instead of silently creating a mixture', () => {
    expect(
      decide(fixture(), [
        {
          kind: 'receive-stock',
          id: 'second-stock',
          vesselId: 'tube',
          materialId: 'material-2',
          quantity: { kind: 'known', value: '10', unit: 'uL' },
          quality: 'usable',
        },
      ])
    ).toMatchObject({ ok: false, code: 'STOCK_ALREADY_PRESENT' });
  });

  it('keeps usability independent of location and preserves a release reason in the command contract', () => {
    const initial = fixture();
    const quarantined = run(initial, [
      { kind: 'set-quality', stockId: 'stock', quality: 'quarantined', reason: 'QC pending' },
    ]);
    expect(quarantined.vessels.tube).toEqual(initial.vessels.tube);
    expect(
      decide(quarantined, [
        { kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'PCR' },
      ])
    ).toMatchObject({ ok: false, code: 'STOCK_QUARANTINED' });
    const released = run(quarantined, [
      { kind: 'set-quality', stockId: 'stock', quality: 'usable', reason: 'QC passed' },
    ]);
    expect(
      run(released, [
        { kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'PCR' },
      ]).stocks.stock.quantity
    ).toEqual({ kind: 'known', value: '99', unit: 'uL' });
  });

  it('makes disposal terminal, frees the occupied position, and retains the last known amount', () => {
    const disposed = run(fixture(), [
      { kind: 'dispose-vessel', id: 'tube', reason: 'Contaminated' },
    ]);
    expect(disposed.vessels.tube).toMatchObject({
      lifecycle: 'disposed',
      placement: { kind: 'unplaced' },
    });
    expect(disposed.stocks.stock.quantity).toEqual({ kind: 'known', value: '100', unit: 'uL' });
    for (const command of [
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
      },
      { kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'PCR' },
      { kind: 'reconcile', stockId: 'stock', quantity: { kind: 'unknown' }, reason: 'Correction' },
      { kind: 'set-quality', stockId: 'stock', quality: 'usable', reason: 'Correction' },
    ] satisfies InventoryCommand[]) {
      expect(decide(disposed, [command])).toMatchObject({ ok: false, code: 'VESSEL_DISPOSED' });
    }
    expect(
      run(disposed, [
        {
          kind: 'create-vessel',
          id: 'replacement',
          name: 'Replacement',
          placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
        },
      ]).vessels.replacement.lifecycle
    ).toBe('active');
  });
});

describe('exact inventory quantity accounting', () => {
  it('subtracts mixed units without floating-point rounding', () => {
    const state = run(fixture('0.3'), [
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '100', unit: 'nL' },
        reason: 'First PCR',
      },
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '0.0001', unit: 'mL' },
        reason: 'Second PCR',
      },
    ]);
    expect(state.stocks.stock.quantity).toEqual({ kind: 'known', value: '0.1', unit: 'uL' });
  });

  it('preserves values beyond the JavaScript safe-integer boundary', () => {
    const state = run(fixture('9007199254740993'), [
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '1', unit: 'uL' },
        reason: 'Exact accounting',
      },
    ]);
    expect(state.stocks.stock.quantity).toEqual({
      kind: 'known',
      value: '9007199254740992',
      unit: 'uL',
    });
  });

  it('distinguishes unknown stock from known zero and requires measurement before consumption', () => {
    const unknown = run(fixture(), [
      {
        kind: 'reconcile',
        stockId: 'stock',
        quantity: { kind: 'unknown' },
        reason: 'Original measurement unreliable',
      },
    ]);
    expect(
      decide(unknown, [
        { kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'PCR' },
      ])
    ).toMatchObject({ ok: false, code: 'QUANTITY_UNKNOWN' });
    const zero = run(unknown, [
      {
        kind: 'reconcile',
        stockId: 'stock',
        quantity: { kind: 'known', value: '0', unit: 'uL' },
        reason: 'Measured empty',
      },
    ]);
    expect(zero.stocks.stock.quantity).toEqual({ kind: 'known', value: '0', unit: 'uL' });
    expect(zero.vessels.tube.lifecycle).toBe('active');
    expect(
      decide(zero, [
        { kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'PCR' },
      ])
    ).toMatchObject({ ok: false, code: 'INSUFFICIENT_QUANTITY' });
  });

  it('rejects negative balance, zero consumption, and an unrepresentable remaining amount atomically', () => {
    expect(
      decide(fixture('1'), [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '1.0001', unit: 'uL' },
          reason: 'PCR',
        },
      ])
    ).toMatchObject({ ok: false, code: 'INSUFFICIENT_QUANTITY' });
    expect(
      decide(fixture('1'), [
        { kind: 'consume', stockId: 'stock', quantity: { value: '0', unit: 'uL' }, reason: 'PCR' },
      ])
    ).toMatchObject({ ok: false, code: 'INVALID_QUANTITY' });
    const source = fixture('9'.repeat(120));
    const before = JSON.stringify(source);
    expect(
      decide(source, [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: `0.${'0'.repeat(120)}1`, unit: 'uL' },
          reason: 'Extreme precision',
        },
      ])
    ).toMatchObject({ ok: false, code: 'INVALID_QUANTITY' });
    expect(JSON.stringify(source)).toBe(before);
    expect(parseInventoryState(JSON.parse(before))).toEqual(source);
  });
});

describe('inventory boundary parsing', () => {
  it.each([
    { value: '-1', unit: 'uL' },
    { value: '1e3', unit: 'uL' },
    { value: 'NaN', unit: 'uL' },
    { value: '1', unit: 'mg' },
    { value: 1, unit: 'uL' },
    { value: '1', unit: 'uL', extra: true },
  ])('refuses ambiguous or unsupported volume input: %s', (quantity) => {
    expect(() =>
      parseInventoryCommand({ kind: 'consume', stockId: 'stock', quantity, reason: 'PCR' })
    ).toThrow(InventoryValidationError);
  });

  it('requires explicit placement, known/unknown quantity, reasons, and a supported state schema', () => {
    expect(() =>
      parseInventoryCommand({ kind: 'create-vessel', id: 'tube', name: 'Tube' })
    ).toThrow(InventoryValidationError);
    expect(() =>
      parseInventoryCommand({
        kind: 'reconcile',
        stockId: 'stock',
        quantity: null,
        reason: 'Correction',
      })
    ).toThrow(InventoryValidationError);
    expect(() =>
      parseInventoryCommand({
        kind: 'set-quality',
        stockId: 'stock',
        quality: 'usable',
        reason: ' ',
      })
    ).toThrow(InventoryValidationError);
    expect(() =>
      parseInventoryState({ ...createInventoryState(), schema: 'dnaforge.inventory.v99' })
    ).toThrow(InventoryValidationError);
    expect(() =>
      parseInventoryCommand({
        kind: 'create-storage',
        id: 'rack',
        name: 'Rack',
        slots: ['A', 'A'],
        placement: { kind: 'root' },
      })
    ).toThrow(InventoryValidationError);
  });

  it('protects the public reducer from semantically invalid typed command values', () => {
    const state = createInventoryState();
    const result = applyInventoryCommandBatch(state, {
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-storage',
          id: 'rack',
          name: 'Rack',
          slots: ['A', 'A'],
          placement: { kind: 'root' },
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_INVENTORY_INPUT' });
    expect(state).toEqual(createInventoryState());
  });

  it('refuses dangling records, duplicate occupants, cycles, and disposed placement on readback', () => {
    const state = fixture();
    const copy = () => JSON.parse(JSON.stringify(state)) as InventoryState;
    const dangling = copy();
    Object.assign(dangling.stocks.stock, { vesselId: 'missing' });
    expect(() => parseInventoryState(dangling)).toThrow(InventoryValidationError);
    const duplicate = copy();
    Object.assign(duplicate.vessels, { other: { ...duplicate.vessels.tube, id: 'other' } });
    expect(() => parseInventoryState(duplicate)).toThrow(InventoryValidationError);
    const cycle = copy();
    Object.assign(cycle.storage.freezer, {
      placement: { kind: 'located', storageId: 'box', slotId: 'B1' },
    });
    expect(() => parseInventoryState(cycle)).toThrow(InventoryValidationError);
    const disposed = copy();
    Object.assign(disposed.vessels.tube, { lifecycle: 'disposed' });
    expect(() => parseInventoryState(disposed)).toThrow(InventoryValidationError);
  });

  it('treats object-prototype names as ordinary identifiers without prototype mutation', () => {
    const state = run(createInventoryState(), [
      {
        kind: 'create-storage',
        id: '__proto__',
        name: 'Cabinet',
        slots: ['constructor'],
        placement: { kind: 'root' },
      },
      {
        kind: 'create-vessel',
        id: 'constructor',
        name: 'Tube',
        placement: { kind: 'located', storageId: '__proto__', slotId: 'constructor' },
      },
    ]);
    expect(Object.keys(state.storage)).toEqual(['__proto__']);
    expect(parseInventoryState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(Object.getPrototypeOf(state.storage)).toBeNull();
  });
});

it('exhausts a bounded two-vessel movement, use, hold, and disposal graph through production transitions', () => {
  const start = run(fixture('2'), [
    {
      kind: 'create-vessel',
      id: 'other-tube',
      name: 'Second tube',
      placement: { kind: 'unplaced' },
    },
    {
      kind: 'receive-stock',
      id: 'other-stock',
      vesselId: 'other-tube',
      materialId: 'material-1',
      quantity: { kind: 'known', value: '2', unit: 'uL' },
      quality: 'usable',
    },
  ]);
  const key = (state: InventoryState): string => JSON.stringify({ ...state, revision: 0 });
  const seen = new Set<string>([key(start)]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const state = queue[index];
    const commands: InventoryCommand[] = [];
    for (const id of ['tube', 'other-tube']) {
      for (const slotId of ['A1', 'B1'])
        commands.push({
          kind: 'move-vessel',
          id,
          placement: { kind: 'located', storageId: 'box', slotId },
        });
      commands.push({ kind: 'move-vessel', id, placement: { kind: 'unplaced' } });
      commands.push({ kind: 'dispose-vessel', id, reason: 'Graph disposal' });
    }
    for (const stockId of ['stock', 'other-stock']) {
      commands.push({
        kind: 'consume',
        stockId,
        quantity: { value: '1', unit: 'uL' },
        reason: 'Graph use',
      });
      for (const quality of ['usable', 'quarantined'] as const)
        commands.push({ kind: 'set-quality', stockId, quality, reason: 'Graph quality' });
    }
    for (const command of commands) {
      const before = JSON.stringify(state);
      const result = decide(state, [command]);
      expect(JSON.stringify(state)).toBe(before);
      if (!result.ok) continue;
      const next = result.state;
      const positions = Object.values(next.vessels)
        .filter((vessel) => vessel.placement.kind === 'located')
        .map((vessel) => JSON.stringify(vessel.placement));
      expect(new Set(positions).size).toBe(positions.length);
      for (const vessel of Object.values(next.vessels)) {
        if (vessel.lifecycle === 'disposed') expect(vessel.placement.kind).toBe('unplaced');
      }
      const total = (snapshot: InventoryState) =>
        Object.values(snapshot.stocks).reduce(
          (sum, stock) =>
            sum + (stock.quantity.kind === 'known' ? Number(stock.quantity.value) : 0),
          0
        );
      expect(total(next)).toBe(total(state) - (command.kind === 'consume' ? 1 : 0));
      for (const stock of Object.values(next.stocks)) {
        expect(stock.quantity.kind).toBe('known');
        if (stock.quantity.kind === 'known')
          expect(['0', '1', '2']).toContain(stock.quantity.value);
      }
      expect(parseInventoryState(JSON.parse(JSON.stringify(next)))).toEqual(next);
      const id = key(next);
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(next);
      }
    }
  }
  expect(
    queue.some((state) =>
      Object.values(state.vessels).every((vessel) => vessel.lifecycle === 'disposed')
    )
  ).toBe(true);
});
