import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryStorageConditionsProjection,
  type InventoryCommand,
  type InventoryQuantityInput,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryMaterialPage,
} from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryForm } from './InventoryForm';
import { InventoryContentsForm } from './InventoryContentsForm';
import { InventoryMaterialForm } from './InventoryMaterialForm';
import { InventoryReservationForm } from './InventoryReservationForm';
import { InventoryStockAvailability } from './InventoryReservations';

const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const context = { at: 1000, principal, authority: principal };

function fixture(
  quantity: InventoryQuantityInput = { kind: 'known', value: '1', unit: 'mg' },
  extraCommands: readonly InventoryCommand[] = []
) {
  const commands: InventoryCommand[] = [
    { kind: 'create-vessel', id: 'tube', name: 'Measured tube', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'tube',
      materialId: 'material',
      quantity,
      quality: 'usable',
    },
    {
      kind: 'create-vessel',
      id: 'unknown',
      name: 'Unidentified tube',
      placement: { kind: 'unplaced' },
    },
    {
      kind: 'record-vessel-contents',
      vesselId: 'unknown',
      knowledge: 'unidentified',
      reason: 'Physical material observed',
    },
    ...extraCommands,
  ];
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    { expectedRevision: 0, commands },
    context
  );
  if (!result.ok) throw new Error(result.message);
  const state = result.state;
  const scope = {
    projectId: 'project',
    inventoryId: 'inventory:project',
    revision: state.revision,
    principal,
  };
  const data: InventoryData = {
    project: {
      projectId: 'project',
      defaultInventoryId: scope.inventoryId,
      name: 'Owned project',
      path: '/synthetic',
      pinned: false,
    },
    state,
    history: [],
    availability: { ...inventoryAvailability(state, principal, 1000), ...scope, asOf: 1000 },
    storageConditions: {
      ...inventoryStorageConditionsProjection(state, { asOf: 1000, freshnessMaxAgeMs: null }),
      ...scope,
    },
  };
  const client = {
    ...unavailableInventoryClient(),
    materials: vi.fn(
      async (): Promise<InventoryMaterialPage> => ({
        items: [
          { id: 'material', name: 'Current scientific record', kind: 'primer', registryId: null },
        ],
        nextCursor: null,
      })
    ),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const submit = vi.spyOn(controller, 'submit').mockResolvedValue(null);
  return {
    props: { data, status: { kind: 'ready' as const, data }, client, controller, onClose: vi.fn() },
    submit,
  };
}

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: label, exact: true }), {
    target: { value },
  });
}
async function material() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Material' }));
  fireEvent.click(await screen.findByRole('option', { name: /Current scientific record/ }));
}
function submit(name: string) {
  fireEvent.click(screen.getByRole('button', { name, exact: true }));
}

it.each([
  ['mg', '1.0000'],
  ['item', '900719925474099312345678901'],
  ['nmol', '0.0000000000000000001'],
])('receives exact %s input through the ordinary form', async (unit, value) => {
  const f = fixture();
  render(<InventoryForm {...f.props} dialog={{ kind: 'receive' }} onMaterial={vi.fn()} />);
  fill('Container name', 'New measured tube');
  await material();
  choose('Unit', unit);
  fill('Quantity', value);
  submit('Receive stock');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'receive-stock', quantity: { kind: 'known', value, unit } }),
    ])
  );
});

it('retains the chosen mass unit when receiving an unknown amount', async () => {
  const f = fixture();
  render(<InventoryForm {...f.props} dialog={{ kind: 'receive' }} onMaterial={vi.fn()} />);
  fill('Container name', 'Unknown mass tube');
  await material();
  choose('Unit', 'mg');
  choose('Quantity measurement', 'Unknown quantity');
  expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveTextContent('mg');
  expect(screen.queryByRole('textbox', { name: 'Quantity', exact: true })).toBeNull();
  submit('Receive stock');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'receive-stock', quantity: { kind: 'unknown', unit: 'mg' } }),
    ])
  );
});

it('refuses fractional item input before any command submission', async () => {
  const f = fixture();
  render(<InventoryForm {...f.props} dialog={{ kind: 'receive' }} onMaterial={vi.fn()} />);
  fill('Container name', 'Count tube');
  await material();
  choose('Unit', 'item');
  fill('Quantity', '1.5');
  submit('Receive stock');
  expect(await screen.findByText('An item count requires a whole number.')).toBeVisible();
  expect(f.submit).not.toHaveBeenCalled();
});

it('identifies existing material with an explicit unknown molar amount', async () => {
  const f = fixture();
  render(
    <InventoryContentsForm
      {...f.props}
      dialog={{ kind: 'contents', action: 'identify', vesselId: 'unknown' }}
    />
  );
  await material();
  choose('Unit', 'nmol');
  choose('Quantity measurement', 'Unknown quantity');
  choose('Stock quality', 'Quarantined');
  fill('Reason', 'Scientific identity checked; amount is unmeasured');
  submit('Identify contents');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'identify-vessel-stock',
      quantity: { kind: 'unknown', unit: 'nmol' },
      quality: 'quarantined',
    }),
  ]);
});

it('reconciles unknown mass without changing the stock measurement dimension', async () => {
  const f = fixture();
  render(
    <InventoryForm
      {...f.props}
      dialog={{ kind: 'reconcile', stockId: 'stock' }}
      onMaterial={vi.fn()}
    />
  );
  expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveTextContent('ng');
  fireEvent.click(screen.getByRole('combobox', { name: 'Unit' }));
  expect(screen.queryByRole('option', { name: 'µL', exact: true })).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: 'mg', exact: true }));
  choose('Quantity measurement', 'Unknown quantity');
  fill('Reason', 'No remaining mass measurement');
  submit('Record quantity');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    {
      kind: 'reconcile',
      stockId: 'stock',
      quantity: { kind: 'unknown', unit: 'mg' },
      reason: 'No remaining mass measurement',
    },
  ]);
});

it('limits whole-count use to item and preserves the large string exactly', async () => {
  const f = fixture({ kind: 'known', value: '900719925474099312345678901', unit: 'item' });
  render(
    <InventoryForm {...f.props} dialog={{ kind: 'use', stockId: 'stock' }} onMaterial={vi.fn()} />
  );
  fireEvent.click(screen.getByRole('combobox', { name: 'Unit' }));
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.click(screen.getByRole('option', { name: 'item', exact: true }));
  fill('Quantity', '9007199254740993');
  fill('Reason', 'Counted withdrawal');
  submit('Use stock');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    {
      kind: 'consume',
      stockId: 'stock',
      quantity: { value: '9007199254740993', unit: 'item' },
      reason: 'Counted withdrawal',
    },
  ]);
});

it('transfers mass using a compatible prefix and keeps the original decimal string', async () => {
  const f = fixture();
  render(<InventoryMaterialForm {...f.props} dialog={{ kind: 'transfer', stockId: 'stock' }} />);
  choose('Unit', 'mg');
  fill('Source amount (mg)', '0.250000000000000001');
  fill('Destination container name', 'Mass aliquot');
  fill('Reason', 'Measured mass split');
  submit('Transfer or aliquot');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'transfer',
        quantity: { value: '0.250000000000000001', unit: 'mg' },
      }),
    ])
  );
});

it('reserves mass with a same-dimension prefix', async () => {
  const f = fixture();
  render(
    <InventoryReservationForm
      {...f.props}
      dialog={{ kind: 'reserve-quantity', stockId: 'stock' }}
    />
  );
  choose('Unit', 'mg');
  fill('Quantity (mg)', '0.6');
  fill('Purpose', 'Planned mass experiment');
  submit('Reserve quantity');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({ kind: 'reserve-quantity', quantity: { value: '0.6', unit: 'mg' } }),
  ]);
});

it.each(['quantity', 'item'] as const)(
  'uses the declared basis of a %s reservation claim independently of the transfer prefix',
  async (kind) => {
    const f = fixture({ kind: 'known', value: '1', unit: 'mg' }, [
      kind === 'quantity'
        ? {
            kind: 'reserve-quantity',
            id: 'hold',
            stockId: 'stock',
            quantity: { value: '0.3', unit: 'mg' },
            purpose: 'Mass hold',
            deadline: null,
          }
        : {
            kind: 'reserve-item',
            id: 'hold',
            item: { kind: 'vessel', id: 'tube' },
            purpose: 'Mass hold',
            deadline: null,
          },
    ]);
    render(<InventoryMaterialForm {...f.props} dialog={{ kind: 'transfer', stockId: 'stock' }} />);
    choose('Unit', 'mg');
    fill('Source amount (mg)', '0.25');
    fill('Destination container name', 'Claimed mass aliquot');
    fill('Reason', 'Split held mass');
    submit('Add reservation claim');
    fireEvent.click(screen.getByRole('combobox', { name: 'Reservation claim 1' }));
    fireEvent.click(screen.getByRole('option', { name: /Mass hold/ }));
    fill('Reservation claim 1 quantity (ng)', '100000');
    submit('Transfer or aliquot');
    await waitFor(() => expect(f.submit).toHaveBeenCalled());
    expect(f.submit.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'fulfill-reservations',
          claims: [{ reservationId: 'hold', quantity: { value: '100000', unit: 'ng' } }],
          withdrawal: expect.objectContaining({
            kind: 'transfer',
            quantity: { value: '0.25', unit: 'mg' },
          }),
        }),
      ])
    );
  }
);

it('omits volume mixing choices for an existing mass destination', async () => {
  const f = fixture({ kind: 'known', value: '1', unit: 'mg' }, [
    {
      kind: 'create-vessel',
      id: 'destination',
      name: 'Existing mass aliquot',
      placement: { kind: 'unplaced' },
    },
    {
      kind: 'transfer',
      sourceStockId: 'stock',
      quantity: { value: '0.1', unit: 'mg' },
      destination: { kind: 'new-stock', stockId: 'destination-stock', vesselId: 'destination' },
      reason: 'Create shared origin',
    },
    { kind: 'create-vessel', id: 'volume', name: 'Volume stock', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-stock',
      id: 'volume-stock',
      vesselId: 'volume',
      materialId: 'material',
      quantity: { kind: 'known', value: '1', unit: 'uL' },
      quality: 'usable',
    },
  ]);
  render(<InventoryMaterialForm {...f.props} dialog={{ kind: 'transfer', stockId: 'stock' }} />);
  choose('Transfer destination', 'Existing compatible stock');
  fireEvent.click(screen.getByRole('combobox', { name: 'Existing stock' }));
  expect(screen.queryByRole('option', { name: /Volume stock/ })).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: /Existing mass aliquot/ }));
  expect(screen.queryByRole('combobox', { name: 'Result mixing' })).toBeNull();
  fill('Source amount (ng)', '1');
  fill('Reason', 'Return measured mass to the shared origin');
  submit('Transfer or aliquot');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    {
      kind: 'transfer',
      sourceStockId: 'stock',
      quantity: { value: '1', unit: 'ng' },
      destination: { kind: 'existing-stock', stockId: 'destination-stock' },
      reason: 'Return measured mass to the shared origin',
    },
  ]);
});

it('uses one explicit mass amount for both the reservation claim and withdrawal', async () => {
  const f = fixture();
  render(
    <InventoryReservationForm
      {...f.props}
      dialog={{ kind: 'fulfill-reservation', stockId: 'stock', reservationId: 'hold' }}
    />
  );
  choose('Unit', 'mg');
  fill('Quantity (mg)', '0.2');
  fill('Reason', 'Used measured mass from the hold');
  submit('Use reserved stock');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    {
      kind: 'fulfill-reservations',
      claims: [{ reservationId: 'hold', quantity: { value: '0.2', unit: 'mg' } }],
      withdrawal: {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '0.2', unit: 'mg' },
        reason: 'Used measured mass from the hold',
      },
    },
  ]);
});

it('shows the mass basis of unknown on-hand and zero held availability', () => {
  const f = fixture({ kind: 'unknown', unit: 'mg' });
  render(<InventoryStockAvailability data={f.props.data} stockId="stock" />);
  expect(
    screen
      .getByTestId('inventory-stock-availability')
      .querySelector('[data-availability="On hand"]')
  ).toHaveTextContent('Unknown ng');
  expect(
    screen.getByTestId('inventory-stock-availability').querySelector('[data-availability="Held"]')
  ).toHaveTextContent('0 ng');
});

it.each(['transfer', 'pool', 'dilute'] as const)('blocks %s from unknown mass stock', (kind) => {
  const f = fixture({ kind: 'unknown', unit: 'mg' });
  render(<InventoryMaterialForm {...f.props} dialog={{ kind, stockId: 'stock' }} />);
  expect(
    screen.getByRole('button', {
      name:
        kind === 'transfer'
          ? 'Transfer or aliquot'
          : kind === 'pool'
            ? 'Pool stocks'
            : 'Dilute stock',
      exact: true,
    })
  ).toBeDisabled();
  expect(
    screen.getByText('Record a measured quantity before withdrawing this stock.')
  ).toBeVisible();
});

it('blocks volume mixing of known mass stock while preserving volume-only limits', () => {
  const f = fixture();
  const first = render(
    <InventoryMaterialForm {...f.props} dialog={{ kind: 'pool', stockId: 'stock' }} />
  );
  expect(screen.getByRole('button', { name: 'Pool stocks', exact: true })).toBeDisabled();
  expect(screen.getByText('Pooling and dilution require stock measured by volume.')).toBeVisible();
  first.unmount();
  render(<InventoryMaterialForm {...f.props} dialog={{ kind: 'limits', vesselId: 'tube' }} />);
  expect(screen.getByLabelText('Capacity (µL)')).toBeVisible();
  expect(screen.getByLabelText('Dead volume (µL)')).toBeVisible();
  expect(screen.queryByRole('combobox', { name: 'Unit' })).toBeNull();
});
