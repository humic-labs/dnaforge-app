import { describe, expect, it } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  parseInventoryCommand,
  parseInventoryState,
  type InventoryCommand,
  type InventoryComposition,
  type InventoryCompositionInput,
  type InventoryState,
} from './inventory';

function apply(state: InventoryState, ...commands: InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(state, { expectedRevision: state.revision, commands });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}

function fixture(): InventoryState {
  return apply(
    createInventoryState(),
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
      kind: 'create-vessel' as const,
      id,
      name: id,
      placement: { kind: 'unplaced' as const },
    })),
    ...['a', 'b'].map((id) => ({
      kind: 'receive-stock' as const,
      id: `stock-${id}`,
      vesselId: id,
      materialId: 'dna',
      quantity: { kind: 'known' as const, value: '100', unit: 'uL' as const },
      quality: 'usable' as const,
    }))
  );
}

function measure(stockId: string, composition: InventoryCompositionInput): InventoryCommand {
  return { kind: 'record-composition', stockId, composition, reason: 'Measured composition' };
}

function concentration(value: string): InventoryCompositionInput {
  return { kind: 'homogeneous', analytes: { dna: { kind: 'known', value, unit: 'ng/uL' } } };
}

function known(numerator: string, denominator = '1'): InventoryComposition {
  return {
    kind: 'homogeneous',
    analytes: { dna: { kind: 'known', numerator, denominator, unit: 'ng/uL' } },
  };
}

function pool(mixing?: 'unknown' | 'homogeneous'): InventoryCommand {
  const legacy = {
    kind: 'pool' as const,
    lotId: 'pooled-lot',
    stockId: 'pooled-stock',
    vesselId: 'c',
    materialId: 'dna',
    name: 'Pooled DNA',
    inputs: [
      { stockId: 'stock-a', quantity: { value: '1', unit: 'uL' as const } },
      { stockId: 'stock-b', quantity: { value: '2', unit: 'uL' as const } },
    ],
    reason: 'Pool stocks',
  };
  return mixing === undefined ? legacy : { ...legacy, mixing };
}

function split(): InventoryCommand {
  return {
    kind: 'transfer',
    sourceStockId: 'stock-a',
    quantity: { value: '20', unit: 'uL' },
    destination: { kind: 'new-stock', stockId: 'aliquot', vesselId: 'c' },
    reason: 'Prepare aliquot',
  };
}

describe('measured inventory composition transitions', () => {
  it('receives legacy stock with unknown composition and normalizes a quarantined measurement exactly', () => {
    let state = fixture();
    expect(state.stocks['stock-a'].composition).toEqual({ kind: 'unknown' });
    state = apply(
      state,
      { kind: 'set-quality', stockId: 'stock-a', quality: 'quarantined', reason: 'QC pending' },
      measure('stock-a', {
        kind: 'homogeneous',
        analytes: {
          dna: { kind: 'known', value: '0.125', unit: 'mg/mL' },
          primer: { kind: 'known', value: '0.25', unit: 'uM' },
          salt: { kind: 'unknown' },
        },
      })
    );
    expect(state.stocks['stock-a']).toMatchObject({
      quality: 'quarantined',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      composition: {
        kind: 'homogeneous',
        analytes: {
          dna: { kind: 'known', numerator: '125', denominator: '1', unit: 'ng/uL' },
          primer: { kind: 'known', numerator: '1', denominator: '4000', unit: 'nmol/uL' },
          salt: { kind: 'unknown', reason: 'unmeasured' },
        },
      },
    });
  });

  it('preserves exact existing facts when another analyte is measured without retaining caller references', () => {
    const input: InventoryCompositionInput = {
      kind: 'homogeneous',
      analytes: {
        dna: { kind: 'known', numerator: '50', denominator: '3', unit: 'ng/uL' },
        primer: { kind: 'unknown', reason: 'incompatible-units' },
        salt: { kind: 'known', value: '2.5', unit: 'mM' },
      },
    };
    const command = measure('stock-a', input);
    const state = apply(fixture(), command);
    expect(state.stocks['stock-a'].composition).toEqual({
      kind: 'homogeneous',
      analytes: {
        dna: { kind: 'known', numerator: '50', denominator: '3', unit: 'ng/uL' },
        primer: { kind: 'unknown', reason: 'incompatible-units' },
        salt: { kind: 'known', numerator: '5', denominator: '2', unit: 'nmol/uL' },
      },
    });
    expect(state.stocks['stock-a'].composition).not.toBe(input);
    if (input.kind === 'homogeneous') Object.assign(input.analytes.dna, { numerator: '999' });
    expect(state.stocks['stock-a'].composition).toMatchObject({
      analytes: { dna: { numerator: '50' } },
    });
  });

  it('refuses composition measurement after disposal without changing any state', () => {
    const state = apply(fixture(), { kind: 'dispose-vessel', id: 'a', reason: 'Discard' });
    const before = JSON.stringify(state);
    expect(
      applyInventoryCommandBatch(state, {
        expectedRevision: state.revision,
        commands: [measure('stock-a', concentration('20'))],
      })
    ).toMatchObject({ ok: false, code: 'VESSEL_DISPOSED' });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('inherits exact composition for a new aliquot and freezes preparation source facts', () => {
    const measured = apply(fixture(), measure('stock-a', known('50', '3')));
    const state = apply(measured, split(), {
      kind: 'create-lot',
      id: 'prepared',
      materialId: 'product',
      name: 'Prepared product',
      origin: { kind: 'prepared', sourceStockIds: ['stock-a'], method: 'Preparation' },
    });
    expect(state.stocks.aliquot.composition).toEqual(known('50', '3'));
    expect(state.stocks.aliquot.composition).not.toBe(state.stocks['stock-a'].composition);
    const origin = state.lots.prepared.origin;
    if (origin.kind !== 'prepared') throw new Error('Expected prepared lot');
    expect(origin.inputs[0].composition).toEqual(known('50', '3'));
    expect(origin.inputs[0].composition).not.toBe(state.stocks['stock-a'].composition);
    const after = apply(state, measure('stock-a', concentration('99')));
    expect(after.lots.prepared.origin).toEqual(origin);
    expect(after.stocks.aliquot.composition).toEqual(known('50', '3'));
    expect(measured.stocks['stock-a'].composition).toEqual(known('50', '3'));
  });

  it.each([undefined, 'unknown', 'homogeneous'] as const)(
    'combines an existing destination only with explicit homogeneous output (%s)',
    (mixing) => {
      const state = apply(
        fixture(),
        measure('stock-a', concentration('10')),
        split(),
        measure('aliquot', concentration('20'))
      );
      const legacy = {
        kind: 'transfer' as const,
        sourceStockId: 'aliquot',
        quantity: { value: '10', unit: 'uL' as const },
        destination: { kind: 'existing-stock' as const, stockId: 'stock-a' },
        reason: 'Return aliquot',
      };
      const after = apply(state, mixing === undefined ? legacy : { ...legacy, mixing });
      expect(after.stocks['stock-a'].quantity).toEqual({ kind: 'known', value: '90', unit: 'uL' });
      expect(after.stocks['stock-a'].composition).toEqual(
        mixing === 'homogeneous' ? known('100', '9') : { kind: 'unknown' }
      );
      expect(after.stocks.aliquot.composition).toEqual(known('20'));
    }
  );

  it.each([undefined, 'unknown', 'homogeneous'] as const)(
    'handles a measured zero-volume destination without inventing contributions (%s)',
    (mixing) => {
      const state = apply(
        fixture(),
        measure('stock-a', concentration('10')),
        split(),
        {
          kind: 'consume',
          stockId: 'stock-a',
          quantity: { value: '80', unit: 'uL' },
          reason: 'Use stock',
        },
        measure('stock-a', { kind: 'unknown' })
      );
      const legacy = {
        kind: 'transfer' as const,
        sourceStockId: 'aliquot',
        quantity: { value: '10', unit: 'uL' as const },
        destination: { kind: 'existing-stock' as const, stockId: 'stock-a' },
        reason: 'Return aliquot',
      };
      const after = apply(state, mixing === undefined ? legacy : { ...legacy, mixing });
      expect(after.stocks['stock-a'].composition).toEqual(
        mixing === 'homogeneous' ? known('10') : { kind: 'unknown' }
      );
    }
  );

  it.each([undefined, 'unknown', 'homogeneous'] as const)(
    'pools exact measured contributions while freezing their committed facts (%s)',
    (mixing) => {
      const state = apply(
        fixture(),
        measure('stock-a', concentration('50')),
        measure('stock-b', concentration('0'))
      );
      const pooled = apply(state, pool(mixing));
      expect(pooled.stocks['pooled-stock'].composition).toEqual(
        mixing === 'homogeneous' ? known('50', '3') : { kind: 'unknown' }
      );
      const origin = pooled.lots['pooled-lot'].origin;
      if (origin.kind !== 'pooled') throw new Error('Expected pooled lot');
      expect(origin.inputs.map((input) => input.composition)).toEqual([known('50'), known('0')]);
      expect(origin.inputs[0].composition).not.toBe(pooled.stocks['stock-a'].composition);
      expect(
        apply(pooled, measure('stock-a', concentration('70'))).lots['pooled-lot'].origin
      ).toEqual(origin);
    }
  );

  it('retains unknown analytes and incompatible mass/molar dimensions during explicit homogeneous dilution', () => {
    const state = apply(
      fixture(),
      measure('stock-a', {
        kind: 'homogeneous',
        analytes: {
          dna: { kind: 'known', value: '10', unit: 'ng/uL' },
          primer: { kind: 'known', value: '5', unit: 'mM' },
        },
      }),
      measure('stock-b', {
        kind: 'homogeneous',
        analytes: { dna: { kind: 'known', value: '1', unit: 'uM' } },
      })
    );
    const after = apply(state, {
      kind: 'dilute',
      lotId: 'dilution',
      stockId: 'diluted',
      vesselId: 'c',
      materialId: 'dna',
      name: 'Dilution',
      sample: { stockId: 'stock-a', quantity: { value: '10', unit: 'uL' } },
      diluent: { stockId: 'stock-b', quantity: { value: '90', unit: 'uL' } },
      reason: 'Prepare dilution',
      mixing: 'homogeneous',
    });
    expect(after.stocks.diluted.composition).toEqual({
      kind: 'homogeneous',
      analytes: {
        dna: { kind: 'unknown', reason: 'incompatible-units' },
        primer: { kind: 'unknown', reason: 'missing-input' },
      },
    });
    const origin = after.lots.dilution.origin;
    if (origin.kind !== 'diluted') throw new Error('Expected diluted lot');
    expect(origin.sample.composition).toEqual(state.stocks['stock-a'].composition);
    expect(origin.diluent.composition).toEqual(state.stocks['stock-b'].composition);
  });

  it('does not infer known output from one unmeasured composition', () => {
    const after = apply(fixture(), measure('stock-a', concentration('50')), pool('homogeneous'));
    expect(after.stocks['pooled-stock'].composition).toEqual({ kind: 'unknown' });
  });

  it('rolls back the entire batch when the final exact concentration exceeds the supported range', () => {
    const denominator = `1${'0'.repeat(255)}`;
    const state = apply(
      fixture(),
      measure('stock-a', known('1', denominator)),
      measure('stock-b', known('1', `${denominator.slice(0, -1)}1`))
    );
    const before = JSON.stringify(state);
    expect(
      applyInventoryCommandBatch(state, {
        expectedRevision: state.revision,
        commands: [
          {
            kind: 'consume',
            stockId: 'stock-a',
            quantity: { value: '1', unit: 'uL' },
            reason: 'Earlier debit',
          },
          pool('homogeneous'),
        ],
      })
    ).toMatchObject({ ok: false, code: 'INVALID_QUANTITY' });
    expect(JSON.stringify(state)).toBe(before);
    expect(state.lots['pooled-lot']).toBeUndefined();
    expect(state.stocks['pooled-stock']).toBeUndefined();
  });

  it('rejects malformed measured facts and inappropriate mixing fields at the command boundary', () => {
    for (const value of [
      { kind: 'known', value: '-1', unit: 'ng/uL' },
      { kind: 'known', numerator: '2', denominator: '4', unit: 'ng/uL' },
      { kind: 'known', numerator: '1', denominator: '0', unit: 'ng/uL' },
      { kind: 'known', numerator: '1', denominator: '2', unit: 'mM' },
      { kind: 'known', value: '1', unit: 'ng/uL', numerator: '1', denominator: '1' },
      { kind: 'unknown', reason: 'assumed-zero' },
    ])
      expect(() =>
        parseInventoryCommand({
          kind: 'record-composition',
          stockId: 'stock-a',
          composition: { kind: 'homogeneous', analytes: { dna: value } },
          reason: 'Measurement',
        })
      ).toThrow();
    expect(() => parseInventoryCommand({ ...split(), mixing: 'homogeneous' })).toThrow();
    expect(() => parseInventoryCommand({ ...pool(), mixing: undefined })).toThrow();
    expect(() => parseInventoryCommand({ ...pool(), mixing: 'mixed' })).toThrow();
  });
});
