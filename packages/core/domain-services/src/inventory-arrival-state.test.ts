import { describe, expect, it } from 'vitest';
import { applyInventoryArrival, inventoryArrivalPreview } from './inventory-arrivals';
import { applyInventoryCommandBatch } from './inventory-state';
import { parseInventoryState } from './inventory-validation';
import { inventoryTableSha256 } from './inventory-table-binding';
import type { InventoryArrivalChoices, InventoryArrivalSource } from './inventory-arrival-types';

const principal = { kind: 'local-profile' as const, profileKey: 'arrival-state' };
const context = { at: 100, principal, authority: principal };
function received() {
  const text = 'Mass: 1 mg\nBatch: 0001\n';
  const source: InventoryArrivalSource = {
    schema: 'dnaforge.inventory-arrival-source.v1',
    identity: { namespace: 'lab.delivery', arrivalId: ' 0001 ' },
    supplier: 'Supplier',
    observedAt: 90,
    observationReason: 'Observed actual delivery',
    scope: { kind: 'complete-listed-manifest', reason: 'Both listed vials inspected' },
    documents: [
      {
        key: 'certificate',
        mediaType: 'text/plain',
        body: { encoding: 'utf8', value: text },
        reference: null,
        coverage: { kind: 'full' },
      },
    ],
    packages: [{ key: 'kit', label: 'Kit', productCode: null, packagingBatch: 'PACK-99' }],
    components: [
      {
        key: 'powder',
        packageKey: 'kit',
        label: 'Powder',
        productCode: null,
        componentBatch: '0001',
      },
      {
        key: 'unknown',
        packageKey: 'kit',
        label: 'Unresolved vial',
        productCode: null,
        componentBatch: null,
      },
    ],
    claims: [
      {
        key: 'mass',
        subject: { kind: 'component', componentKey: 'powder' },
        selection: {
          documentKey: 'certificate',
          expectedSha256: inventoryTableSha256(text),
          locator: {
            kind: 'utf8-byte-range',
            startByte: 0,
            endByte: new TextEncoder().encode(text).length,
          },
          verbatim: text,
        },
        claim: { kind: 'quantity', valueLexeme: '1', unitText: 'mg' },
      },
    ],
  };
  const options: InventoryArrivalChoices = {
    components: [
      {
        componentKey: 'powder',
        kind: 'identified',
        materialId: 'material',
        lot: {
          kind: 'new',
          lotKey: 'batch',
          name: 'Batch 0001',
          supplier: 'Supplier',
          lotNumber: '0001',
          managementReason: 'Local assessment required',
        },
        quantity: { kind: 'known', value: '1', unit: 'mg' },
        quantityBasis: {
          kind: 'supplier-declared',
          claimKey: 'mass',
          reason: 'Supplier original amount retained',
        },
        stockQuality: { value: 'usable', reason: 'No separate stock hold' },
        vessel: { name: 'Powder tube', placement: { kind: 'unplaced' } },
      },
      {
        componentKey: 'unknown',
        kind: 'unidentified-physical',
        vessel: { name: 'Unresolved tube', placement: { kind: 'unplaced' } },
        reason: 'Contents identity not established',
      },
    ],
  };
  const target = { projectId: 'project', inventoryId: 'inventory', present: false, revision: 0 };
  const sourceText = JSON.stringify(source);
  const preview = inventoryArrivalPreview(null, {
    target,
    sourceText,
    options,
    bindings: [
      {
        key: 'powder',
        materialId: 'material',
        kind: 'admitted',
        fingerprint: inventoryTableSha256('material'),
      },
    ],
    asOf: context.at,
    principal,
    authority: principal,
    maxBytes: 17 * 1024 * 1024,
  });
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const result = applyInventoryArrival(
    null,
    { target, sourceText, options: preview.options, expectedPlanDigest: preview.planDigest },
    context,
    17 * 1024 * 1024
  );
  if (!result.ok) throw new Error(result.message);
  const arrival = Object.values(result.state.arrivals)[0];
  return { state: result.state, arrival };
}

describe('immutable arrival state', () => {
  it('retains exact delivery identity, component batch, package batch and original amount', () => {
    const { state, arrival } = received();
    expect(parseInventoryState(state)).toEqual(state);
    expect(arrival.identity.arrivalId).toBe(' 0001 ');
    expect(arrival.packages[0].packagingBatch).toBe('PACK-99');
    expect(arrival.components[0].componentBatch).toBe('0001');
    expect(arrival.components[0].receivedQuantity).toEqual({
      kind: 'known',
      value: '1000000',
      unit: 'ng',
    });
    expect(arrival.components[1].receivedQuantity).toBeNull();
  });

  it('upcasts v20 without inventing old arrival facts or rewriting any existing state field', () => {
    const { state } = received(),
      {
        scientificWorks: _scientificWorks,
        scientificCitations: _scientificCitations,
        platePlanVersions: _platePlanVersions,
        scientificCitationWithdrawals: _scientificCitationWithdrawals,
        expectedDeliveries: _expected,
        arrivalAllocations: _allocations,
        reorderRules: _rules,
        arrivals: _arrivals,
        ...rest
      } = state;
    const previous = { ...rest, schema: 'dnaforge.inventory.v20' },
      before = JSON.stringify(previous);
    const parsed = parseInventoryState(previous),
      {
        scientificWorks,
        scientificCitations,
        platePlanVersions,
        scientificCitationWithdrawals,
        expectedDeliveries,
        arrivalAllocations,
        reorderRules,
        arrivals,
        schema: _schema,
        ...unchanged
      } = parsed;
    const { schema: _oldSchema, ...oldFields } = previous;
    expect(scientificWorks).toEqual({});
    expect(arrivals).toEqual({});
    expect(expectedDeliveries).toEqual({});
    expect(arrivalAllocations).toEqual({});
    expect(reorderRules).toEqual({});
    expect(unchanged).toEqual(oldFields);
    expect(JSON.stringify(previous)).toBe(before);
  });

  it('does not mistake later use, quality changes or disposal for an edited original receipt', () => {
    const { state, arrival } = received(),
      component = arrival.components[0];
    const changed = applyInventoryCommandBatch(
      state,
      {
        expectedRevision: state.revision,
        commands: [
          {
            kind: 'assess-lot',
            lotId: component.target.lotId!,
            assessment: 'released',
            reason: 'Local release',
          },
          {
            kind: 'consume',
            stockId: component.target.stockId!,
            quantity: { value: '0.25', unit: 'mg' },
            reason: 'Actual use',
          },
          {
            kind: 'set-quality',
            stockId: component.target.stockId!,
            quality: 'quarantined',
            reason: 'Separate hold',
          },
          { kind: 'dispose-vessel', id: component.target.vesselId!, reason: 'Physical disposal' },
        ],
      },
      { ...context, at: 110 }
    );
    if (!changed.ok) throw new Error(changed.message);
    expect(parseInventoryState(changed.state).arrivals).toEqual(state.arrivals);
    expect(changed.state.stocks[component.target.stockId!].quantity).toEqual({
      kind: 'known',
      value: '750000',
      unit: 'ng',
    });
  });

  it('rejects changed evidence hashes, mismatched source keys and phantom unresolved stock', () => {
    const { state, arrival } = received();
    const mutate = (changes: object) => ({
      ...state,
      arrivals: { [arrival.id]: { ...arrival, ...changes } },
    });
    expect(() =>
      parseInventoryState(mutate({ identity: { ...arrival.identity, arrivalId: 'another' } }))
    ).toThrow();
    expect(() =>
      parseInventoryState(
        mutate({
          claims: [
            {
              ...arrival.claims[0],
              selection: {
                ...arrival.claims[0].selection,
                expectedSha256: inventoryTableSha256('different'),
              },
            },
          ],
        })
      )
    ).toThrow(/document hash/);
    expect(() =>
      parseInventoryState(
        mutate({
          components: [
            {
              ...arrival.components[0],
              target: { ...arrival.components[0].target, componentKey: 'other' },
            },
            arrival.components[1],
          ],
        })
      )
    ).toThrow(/keys must agree/);
    expect(() =>
      parseInventoryState(
        mutate({
          components: [
            arrival.components[0],
            {
              ...arrival.components[1],
              receivedQuantity: { kind: 'known', value: '1', unit: 'uL' },
            },
          ],
        })
      )
    ).toThrow(/Unresolved received/);
  });

  it('rejects a forged original admission or incompatible supplier amount without reading remaining stock', () => {
    const { state, arrival } = received();
    const component = arrival.components[0];
    expect(() =>
      parseInventoryState({
        ...state,
        arrivals: {
          [arrival.id]: {
            ...arrival,
            components: [
              { ...component, receivedQuantity: { kind: 'known', value: '500000', unit: 'ng' } },
              arrival.components[1],
            ],
          },
        },
      })
    ).toThrow(/admission snapshot/);
    expect(() =>
      parseInventoryState({
        ...state,
        arrivals: {
          [arrival.id]: {
            ...arrival,
            claims: [
              {
                ...arrival.claims[0],
                claim: { kind: 'quantity', valueLexeme: '1', unitText: 'uL' },
              },
            ],
          },
        },
      })
    ).toThrow(/incompatible source/);
    expect(() =>
      parseInventoryState({ ...state, arrivals: { [arrival.id]: { ...arrival, at: 101 } } })
    ).toThrow(/native lifetime/);
  });
});
