import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryStorageConditionsProjection,
  type InventoryCommand,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryMaterialPage,
} from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryLotControlsForm, InventoryStockLotControls } from './InventoryLotControlsForm';
import { InventoryMaterialForm } from './InventoryMaterialForm';
import { InventoryForm } from './InventoryForm';
import { InventoryReservationForm } from './InventoryReservationForm';
import { historyLabel } from './inventory-view';

const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const context = { at: 1000, principal, authority: principal };
const source = {
  url: 'https://example.test/recall',
  title: 'Supplier notice',
  locator: 'Lot section',
  readAt: '2026-11-16',
  documentRevision: 'v2',
  sha256: null,
};
function fixture(extra: readonly InventoryCommand[] = [], pinned = false) {
  const commands: InventoryCommand[] = [
    {
      kind: 'create-lot',
      id: 'lot',
      materialId: 'material',
      name: 'Supplier batch',
      origin: { kind: 'received', supplier: 'Supplier', lotNumber: 'L123' },
    },
    { kind: 'create-vessel', id: 'tube', name: 'Lot tube', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-lot-stock',
      id: 'stock',
      vesselId: 'tube',
      lotId: 'lot',
      quantity: { kind: 'known', value: '10', unit: 'uL' },
      quality: 'usable',
    },
    ...extra,
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
      pinned,
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
        items: [{ id: 'material', name: 'Current material', kind: 'primer', registryId: null }],
        nextCursor: null,
      })
    ),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const submit = vi.spyOn(controller, 'submit').mockResolvedValue(null);
  return {
    props: { data, client, controller, status: { kind: 'ready' as const, data }, onClose: vi.fn() },
    submit,
  };
}
const managed: InventoryCommand = {
  kind: 'manage-lot',
  lotId: 'lot',
  reason: 'Start local management',
};
const released: InventoryCommand = {
  kind: 'assess-lot',
  lotId: 'lot',
  assessment: 'released',
  reason: 'Checked local acceptance criteria',
};
const recall = (id: string): InventoryCommand => ({
  kind: 'record-lot-recall',
  id,
  lotId: 'lot',
  observedAt: null,
  source: null,
  reason: `Supplier recall ${id}`,
});
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const fill = (name: string, value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name, exact: true }), { target: { value } });
function choose(name: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name, exact: true }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
}
function renderControls(f: ReturnType<typeof fixture>, lotId = 'lot') {
  return render(<InventoryLotControlsForm {...f.props} dialog={{ kind: 'lot-controls', lotId }} />);
}

it('creates and starts managing a new lot in one batch with an explicit reason', async () => {
  const f = fixture();
  render(<InventoryMaterialForm {...f.props} dialog={{ kind: 'lot' }} />);
  fill('Batch name', 'New managed batch');
  fireEvent.click(screen.getByRole('combobox', { name: 'Output material' }));
  fireEvent.click(await screen.findByRole('option', { name: /Current material/ }));
  fill('Supplier', 'Synthetic supplier');
  fill('Supplier lot number', 'LOT-2');
  fill('Reason', 'Start managed receiving');
  click('Add lot or preparation');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  const commands = f.submit.mock.calls[0][0];
  expect(commands).toEqual([
    expect.objectContaining({ kind: 'create-lot', name: 'New managed batch' }),
    {
      kind: 'manage-lot',
      lotId: 'id' in commands[0] ? commands[0].id : '',
      reason: 'Start managed receiving',
    },
  ]);
  expect(screen.getByText(/new lot starts Unassessed/)).toBeVisible();
});

it('starts management of a legacy lot without inventing a release', async () => {
  const f = fixture();
  renderControls(f);
  click('Start managing lot');
  fill('Reason', 'Begin local quality decisions');
  click('Start managing lot');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    { kind: 'manage-lot', lotId: 'lot', reason: 'Begin local quality decisions' },
  ]);
});

it.each(['Released', 'Quarantined', 'Rejected'])(
  'records explicit %s assessment and its reason',
  async (label) => {
    const f = fixture([managed]);
    renderControls(f);
    click('Record assessment');
    choose('Lot assessment', label);
    fill('Reason', 'Reviewed physical lot evidence');
    click('Record lot assessment');
    await waitFor(() => expect(f.submit).toHaveBeenCalled());
    expect(f.submit.mock.calls[0][0]).toEqual([
      {
        kind: 'assess-lot',
        lotId: 'lot',
        assessment: label.toLowerCase(),
        reason: 'Reviewed physical lot evidence',
      },
    ]);
  }
);

it('requires an explicit assessment selection even when a reason is entered', async () => {
  const f = fixture([managed]);
  renderControls(f);
  click('Record assessment');
  fill('Reason', 'Reason alone is not a release');
  click('Record lot assessment');
  expect(await screen.findByText('Choose an assessment explicitly.')).toBeVisible();
  expect(f.submit).not.toHaveBeenCalled();
});

it('records unknown observation time and absent source explicitly for a new recall', async () => {
  const f = fixture([managed, released]);
  renderControls(f);
  click('Record recall');
  fill('Reason', 'Supplier announced a recall');
  click('Record lot recall');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'record-lot-recall',
      lotId: 'lot',
      observedAt: null,
      source: null,
      reason: 'Supplier announced a recall',
    }),
  ]);
});

it('records exact observation and retained source fields without treating them as release', async () => {
  const f = fixture([managed]);
  renderControls(f);
  click('Record recall');
  choose('Recall observation time', 'Known UTC time');
  fill('Observed at (UTC)', '2026-11-16T10:00:00.000Z');
  choose('Recall source', 'Record source reference');
  for (const [label, value] of [
    ['title', source.title],
    ['URL', source.url],
    ['page or section', source.locator],
    ['document revision', source.documentRevision!],
  ])
    fill(`Recall source ${label}`, value);
  fireEvent.change(screen.getByLabelText('Recall source read date'), {
    target: { value: source.readAt },
  });
  fill('Reason', 'Retain exact supplier notice');
  click('Record lot recall');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'record-lot-recall',
      observedAt: Date.parse('2026-11-16T10:00:00.000Z'),
      source,
    }),
  ]);
});

it('targets only the selected active recall for withdrawal and displays the other recall', async () => {
  const f = fixture([managed, released, recall('first'), recall('second')]);
  renderControls(f);
  expect(screen.getAllByText('Active recall')).toHaveLength(2);
  click('Withdraw recall first');
  fill('Reason', 'First notice withdrawn only');
  click('Withdraw lot recall');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    { kind: 'withdraw-lot-recall', recallId: 'first', reason: 'First notice withdrawn only' },
  ]);
  expect(screen.getByText('Supplier recall second')).toBeVisible();
});

it('shows imported release as evidence requiring an explicit local assessment', () => {
  const f = fixture([managed, released]);
  const lot = f.props.data.state.lots.lot;
  if (lot.controls.kind !== 'managed') throw new Error('Fixture must be managed');
  const imported = {
    kind: 'imported' as const,
    principal,
    source: {
      archiveSha256: `sha256:${'b'.repeat(64)}`,
      projectId: 'foreign',
      inventoryId: 'foreign-inventory',
      revision: 3,
    },
  };
  f.props.data.state = {
    ...f.props.data.state,
    lots: {
      ...f.props.data.state.lots,
      lot: {
        ...lot,
        controls: { kind: 'managed', assessment: { ...lot.controls.assessment, by: imported } },
      },
    },
  };
  renderControls(f);
  expect(screen.getByText(/Imported assessment/)).toBeVisible();
  expect(screen.getByText(/local release decision is required/)).toBeVisible();
  click('Record assessment');
  choose('Lot assessment', 'Released');
  expect(screen.getByRole('button', { name: 'Record lot assessment', exact: true })).toBeEnabled();
});

it('permits read-only inspection and suppresses every mutating action', () => {
  const f = fixture([managed, released, recall('active')], true);
  renderControls(f);
  expect(screen.getByText('Active recall')).toBeVisible();
  for (const name of ['Record assessment', 'Record recall', 'Withdraw recall active'])
    expect(screen.queryByRole('button', { name, exact: true })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Lot or preparation' })).toBeEnabled();
  expect(f.submit).not.toHaveBeenCalled();
});

it('displays independent stock quarantine and inherited active recall without zeroing balance', () => {
  const f = fixture([
    managed,
    released,
    recall('active'),
    {
      kind: 'set-quality',
      stockId: 'stock',
      quality: 'quarantined',
      reason: 'Separate stock hold',
    },
  ]);
  render(<InventoryStockLotControls data={f.props.data} stockId="stock" onInspect={vi.fn()} />);
  expect(screen.getByText('Stock quality: Quarantined')).toBeVisible();
  expect(screen.getByText('Lot Supplier batch has an active recall')).toBeVisible();
  expect(screen.getByText('This stock is quarantined')).toBeVisible();
  expect(f.props.data.state.stocks.stock.quantity).toEqual({
    kind: 'known',
    value: '10',
    unit: 'uL',
  });
});

it('blocks use and reserve forms for unassessed stock but preserves physical receiving', () => {
  const f = fixture([managed]);
  const view = render(
    <InventoryForm {...f.props} dialog={{ kind: 'use', stockId: 'stock' }} onMaterial={vi.fn()} />
  );
  expect(screen.getByRole('button', { name: 'Use stock', exact: true })).toBeDisabled();
  view.unmount();
  const reservation = render(
    <InventoryReservationForm
      {...f.props}
      dialog={{ kind: 'reserve-quantity', stockId: 'stock' }}
    />
  );
  expect(screen.getByRole('button', { name: 'Reserve quantity', exact: true })).toBeDisabled();
  reservation.unmount();
  render(<InventoryForm {...f.props} dialog={{ kind: 'receive' }} onMaterial={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Receive stock', exact: true })).toBeEnabled();
});

it('resets a drafted action when selecting a different lot', () => {
  const f = fixture([
    {
      kind: 'create-lot',
      id: 'second',
      materialId: 'material',
      name: 'Second lot',
      origin: { kind: 'received', supplier: 'Other', lotNumber: 'L2' },
    },
  ]);
  renderControls(f);
  click('Start managing lot');
  fill('Reason', 'First lot reason');
  fireEvent.click(screen.getByRole('combobox', { name: 'Lot or preparation' }));
  fireEvent.click(screen.getByRole('option', { name: /Second lot/ }));
  expect(screen.queryByRole('textbox', { name: 'Reason' })).toBeNull();
  expect(screen.getByText('Second lot', { selector: 'h3' })).toBeVisible();
  expect(f.submit).not.toHaveBeenCalled();
});

it('names all lot actions explicitly in accepted history', () => {
  const f = fixture([managed]);
  const state: InventoryState = f.props.data.state;
  expect(historyLabel(managed, state)).toBe('Started managing lot Supplier batch');
  expect(historyLabel(released, state)).toBe('Assessed lot Supplier batch: released');
  expect(historyLabel(recall('R1'), state)).toBe('Recorded recall R1 for Supplier batch');
  expect(
    historyLabel({ kind: 'withdraw-lot-recall', recallId: 'R1', reason: 'Withdrawn' }, state)
  ).toBe('Withdrew recall R1');
});

it.each(['pool', 'dilute'] as const)(
  'starts a new %s output lot unassessed in the same batch',
  async (kind) => {
    const f = fixture([
      { kind: 'create-vessel', id: 'other', name: 'Other tube', placement: { kind: 'unplaced' } },
      {
        kind: 'receive-stock',
        id: 'other-stock',
        vesselId: 'other',
        materialId: 'material',
        quantity: { kind: 'known', value: '10', unit: 'uL' },
        quality: 'usable',
      },
    ]);
    render(<InventoryMaterialForm {...f.props} dialog={{ kind, stockId: 'stock' }} />);
    fill(kind === 'pool' ? 'Source amount (µL)' : 'Sample amount (µL)', '2');
    fireEvent.click(
      screen.getByRole('combobox', { name: kind === 'pool' ? 'Second stock' : 'Tracked diluent' })
    );
    fireEvent.click(screen.getByRole('option', { name: /Other tube/ }));
    fill(kind === 'pool' ? 'Second amount (µL)' : 'Diluent amount (µL)', '3');
    fill('Output batch name', 'Managed output');
    fill('Destination container name', 'Output tube');
    fireEvent.click(screen.getByRole('combobox', { name: 'Output material' }));
    fireEvent.click(await screen.findByRole('option', { name: /Current material/ }));
    fill('Reason', 'Explicit tracked material operation');
    click(kind === 'pool' ? 'Pool stocks' : 'Dilute stock');
    await waitFor(() => expect(f.submit).toHaveBeenCalled());
    const commands = f.submit.mock.calls[0][0];
    const operation = commands.find((command) => command.kind === kind);
    expect(operation).toBeDefined();
    expect(commands.at(-1)).toEqual({
      kind: 'manage-lot',
      lotId: operation && 'lotId' in operation ? operation.lotId : '',
      reason: 'Explicit tracked material operation',
    });
    expect(commands.some((command) => command.kind === 'assess-lot')).toBe(false);
  }
);
