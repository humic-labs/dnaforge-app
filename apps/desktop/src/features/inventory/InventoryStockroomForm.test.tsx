import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  applyInventoryArrival,
  applyInventoryCommandBatch,
  inventoryArrivalPreview,
  inventoryAvailability,
  inventoryStockroomProjection,
  inventoryStorageConditionsProjection,
  type InventoryArrivalChoices,
  type InventoryCommand,
} from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryStockroomForm } from './InventoryStockroomForm';

const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
  scope = { projectId: 'project', inventoryId: 'inventory' };
function fixture(extra: readonly InventoryCommand[] = []) {
  const sourceText = JSON.stringify({
    schema: 'dnaforge.inventory-arrival-source.v1',
    identity: { namespace: 'stockroom-fixture', arrivalId: 'delivery-one' },
    supplier: 'Synthetic supplier',
    observedAt: null,
    observationReason: 'Physical receipt',
    scope: { kind: 'selected-components', reason: 'One observed reagent' },
    documents: [],
    packages: [],
    components: [
      {
        key: 'component',
        packageKey: null,
        label: 'Original reagent',
        productCode: null,
        componentBatch: 'batch',
      },
    ],
    claims: [],
  });
  const options: InventoryArrivalChoices = {
    components: [
      {
        kind: 'identified',
        componentKey: 'component',
        materialId: 'material',
        lot: {
          kind: 'new',
          lotKey: 'lot',
          name: 'Batch',
          supplier: 'Synthetic supplier',
          lotNumber: 'batch',
          managementReason: 'Begin quality controls',
        },
        quantity: { kind: 'known', value: '1', unit: 'mg' },
        quantityBasis: { kind: 'measurement', reason: 'Actual mass' },
        stockQuality: { value: 'usable', reason: 'Local stock quality' },
        vessel: { name: 'Reagent vial', placement: { kind: 'unplaced' } },
      },
    ],
  };
  const target = { ...scope, present: false, revision: 0 };
  const preview = inventoryArrivalPreview(null, {
    target,
    sourceText,
    options,
    bindings: [
      {
        kind: 'admitted',
        key: 'component',
        materialId: 'material',
        fingerprint: `sha256:${'b'.repeat(64)}`,
      },
    ],
    asOf: 100,
    principal,
    authority: principal,
    maxBytes: 17 * 1024 * 1024,
  });
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const arrived = applyInventoryArrival(
    null,
    { target, sourceText, options: preview.options, expectedPlanDigest: preview.planDigest },
    { at: 100, principal, authority: principal },
    17 * 1024 * 1024
  );
  if (!arrived.ok) throw Error(arrived.message);
  const component = preview.arrival.components[0],
    commands: InventoryCommand[] = [
      {
        kind: 'assess-lot',
        lotId: component.target.lotId!,
        assessment: 'released',
        reason: 'Local release',
      },
      {
        kind: 'consume',
        stockId: component.target.stockId!,
        quantity: { value: '100', unit: 'ug' },
        reason: 'Use before expectation matching',
      },
      {
        kind: 'record-expected-delivery',
        id: 'line',
        name: 'Expected reagent',
        supplier: null,
        externalReference: null,
        materialId: 'material',
        quantity: { value: '1', unit: 'mg' },
        reason: 'Local expected amount',
      },
      ...extra,
    ];
  const result = applyInventoryCommandBatch(
    arrived.state,
    { expectedRevision: arrived.state.revision, commands },
    { at: 101, principal, authority: principal }
  );
  if (!result.ok) throw Error(result.message);
  const state = result.state,
    native = unavailableInventoryClient();
  native.materials = vi.fn(async () => ({
    items: [{ id: 'material', name: 'Material', kind: 'reagent', registryId: null }],
    nextCursor: null,
  }));
  const data: InventoryData = {
    project: {
      ...scope,
      projectId: scope.projectId,
      defaultInventoryId: scope.inventoryId,
      name: 'Project',
      path: '/synthetic',
      pinned: false,
    },
    state,
    history: [],
    availability: {
      ...inventoryAvailability(state, principal, 102),
      ...scope,
      revision: state.revision,
      asOf: 102,
      principal,
    },
    stockroom: {
      ...inventoryStockroomProjection(state, principal, 102),
      ...scope,
      revision: state.revision,
      asOf: 102,
      principal,
    },
    storageConditions: {
      ...inventoryStorageConditionsProjection(state, { asOf: 102, freshnessMaxAgeMs: null }),
      ...scope,
      revision: state.revision,
      principal,
    },
  };
  const controller = new InventoryController(native, { read: () => [], write: () => {} }),
    submit = vi.spyOn(controller, 'submit').mockResolvedValue(null);
  return {
    data,
    submit,
    component,
    props: {
      data,
      status: { kind: 'ready' as const, data },
      controller,
      client: native,
      onClose: vi.fn(),
    },
  };
}
function choose(label: string, option: string | RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}
afterEach(() => vi.restoreAllMocks());

it('records only an explicit expectation with exact decimal input and no supplier order authority', async () => {
  const f = fixture();
  render(<InventoryStockroomForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record expected delivery' }));
  fireEvent.change(screen.getByLabelText('Expected delivery name'), {
    target: { value: 'Expected exact mass' },
  });
  fireEvent.change(screen.getByLabelText('Find scientific material'), {
    target: { value: 'material' },
  });
  await waitFor(() => expect(f.props.client.materials).toHaveBeenCalled());
  choose('Scientific material', /^Material/);
  fireEvent.change(screen.getByLabelText('Expected amount'), {
    target: { value: '0.000000000000000001' },
  });
  choose('Amount unit', 'mg');
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Local expectation without order submission' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record expected delivery' }));
  await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'record-expected-delivery',
      materialId: 'material',
      quantity: { value: '0.000000000000000001', unit: 'mg' },
      supplier: null,
      externalReference: null,
    }),
  ]);
});
it('matches original one mg even after current remaining stock is only900000ng', async () => {
  const f = fixture();
  render(<InventoryStockroomForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Match received material' }));
  choose('Original received component', /^delivery-one · Original reagent/);
  expect(screen.getByTestId('inventory-allocation-original-balance').textContent).toContain(
    'Original received amount: 1000000 ng'
  );
  expect(f.data.state.stocks[f.component.target.stockId!].quantity).toEqual({
    kind: 'known',
    value: '900000',
    unit: 'ng',
  });
  fireEvent.change(screen.getByLabelText('Amount to match'), { target: { value: '1' } });
  choose('Amount unit', 'mg');
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Original receipt fulfills expectation independently of use' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Match received material' }));
  await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'allocate-arrival',
      lineId: 'line',
      arrivalId: Object.keys(f.data.state.arrivals)[0],
      componentKey: 'component',
      quantity: { value: '1', unit: 'mg' },
    }),
  ]);
});
it('requires both reorder policies instead of silently choosing withdrawal or validity coverage', async () => {
  const f = fixture();
  render(<InventoryStockroomForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Record reorder rule' }));
  fireEvent.change(screen.getByLabelText('Reorder rule name'), {
    target: { value: 'Explicit policy' },
  });
  fireEvent.change(screen.getByLabelText('Find scientific material'), {
    target: { value: 'material' },
  });
  await waitFor(() => expect(f.props.client.materials).toHaveBeenCalled());
  choose('Scientific material', /^Material/);
  fireEvent.change(screen.getByLabelText('Reorder threshold'), { target: { value: '1' } });
  choose('Amount unit', 'ng');
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Explicit native action and coverage basis' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record reorder rule' }));
  await screen.findByText('Choose both reorder policies explicitly.');
  expect(f.submit).not.toHaveBeenCalled();
  choose('Reorder action basis', 'Suitable for reservation');
  choose('Reorder validity basis', 'Confirmed current validity for the selected action');
  fireEvent.click(screen.getByRole('button', { name: 'Record reorder rule' }));
  await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'record-reorder-rule',
      threshold: { value: '1', unit: 'ng' },
      actionBasis: 'reserve',
      validityBasis: 'confirmed-current-validity',
    }),
  ]);
});
it('renders native unknown-balance classification and rejects a same-revision foreign report', () => {
  const f = fixture([
    {
      kind: 'create-vessel',
      id: 'unknown-vessel',
      name: 'Unknown mass',
      placement: { kind: 'unplaced' },
    },
    {
      kind: 'receive-stock',
      id: 'unknown-stock',
      vesselId: 'unknown-vessel',
      materialId: 'material',
      quantity: { kind: 'unknown', unit: 'ng' },
      quality: 'usable',
    },
    {
      kind: 'record-reorder-rule',
      id: 'rule',
      name: 'Need measured amount',
      materialId: 'material',
      threshold: { value: '2', unit: 'mg' },
      actionBasis: 'withdraw',
      validityBasis: 'current-recorded-rules',
      reason: 'Explicit rule',
    },
  ]);
  const view = render(<InventoryStockroomForm {...f.props} />);
  expect(screen.getByText('Conclusion: Needs measurement')).toBeDefined();
  expect(screen.getByText(/Eligible unknown amounts: 1/)).toBeDefined();
  const wrong = { ...f.data, stockroom: { ...f.data.stockroom!, inventoryId: 'foreign' } };
  view.rerender(
    <InventoryStockroomForm {...f.props} data={wrong} status={{ kind: 'ready', data: wrong }} />
  );
  expect(screen.getByText(/Stockroom projection is unavailable or stale/)).toBeDefined();
  expect(screen.queryByText('Conclusion: Needs measurement')).toBeNull();
});
