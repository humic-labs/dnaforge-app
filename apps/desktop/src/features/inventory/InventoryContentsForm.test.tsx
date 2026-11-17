import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryStorageConditionsProjection,
  inventoryVesselContents,
  type InventoryCommand,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryMaterialPage,
} from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryContentsForm } from './InventoryContentsForm';
import { InventoryContentsPanel } from './InventoryContentsPanel';
import { InventoryForm } from './InventoryForm';
import { InventoryMaterialForm } from './InventoryMaterialForm';
import { inventoryContentsLabel } from './inventory-contents-view';
import { historyLabel } from './inventory-view';

const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const context = { at: 1000, principal, authority: principal };
const materialPage = {
  items: [{ id: 'material', name: 'Existing scientific record', kind: 'primer', registryId: null }],
  nextCursor: null,
};

function state(
  kind: 'recorded' | 'unobserved' | 'unidentified' | 'zero' = 'unobserved'
): InventoryState {
  const commands: InventoryCommand[] = [
    { kind: 'create-vessel', id: 'tube', name: 'Physical tube', placement: { kind: 'unplaced' } },
  ];
  if (kind === 'unobserved' || kind === 'unidentified')
    commands.push({
      kind: 'record-vessel-contents',
      vesselId: 'tube',
      knowledge: kind,
      reason: 'Explicit source observation',
    });
  if (kind === 'zero')
    commands.push({
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'tube',
      materialId: 'material',
      quantity: { kind: 'known', value: '0', unit: 'uL' },
      quality: 'usable',
    });
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    { expectedRevision: 0, commands },
    context
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

function fixture(
  kind: Parameters<typeof state>[0] = 'unobserved',
  pinned = false,
  projectId = 'project'
) {
  const inventory = state(kind);
  const data: InventoryData = {
    project: {
      projectId,
      defaultInventoryId: `inventory:${projectId}`,
      name: 'Owned project',
      path: '/synthetic',
      pinned,
    },
    state: inventory,
    history: [],
    availability: null,
    storageConditions: {
      ...inventoryStorageConditionsProjection(inventory, { asOf: 1000, freshnessMaxAgeMs: null }),
      projectId,
      inventoryId: `inventory:${projectId}`,
      revision: inventory.revision,
      principal,
    },
  };
  const client = {
    ...unavailableInventoryClient(),
    materials: vi.fn(async (): Promise<InventoryMaterialPage> => materialPage),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const submit = vi.spyOn(controller, 'submit').mockResolvedValue(null);
  return {
    props: { data, controller, client, status: { kind: 'ready' as const, data }, onClose: vi.fn() },
    submit,
    client,
  };
}

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
}
function reason() {
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Checked the existing physical contents' },
  });
}

it('creates an unobserved container and its declaration in one submitted batch', async () => {
  const f = fixture('recorded');
  render(<InventoryForm {...f.props} dialog={{ kind: 'container' }} onMaterial={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Container name'), {
    target: { value: 'Unobserved tube' },
  });
  choose('Initial contents', 'Contents have not been observed');
  reason();
  fireEvent.click(screen.getByRole('button', { name: 'Add container', exact: true }));
  await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  const commands = f.submit.mock.calls[0][0];
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({ kind: 'create-vessel', name: 'Unobserved tube' });
  expect(commands[1]).toEqual({
    kind: 'record-vessel-contents',
    vesselId: 'id' in commands[0] ? commands[0].id : '',
    knowledge: 'unobserved',
    reason: 'Checked the existing physical contents',
  });
});

it('records unidentified contents using the existing command recovery owner', async () => {
  const f = fixture();
  render(
    <InventoryContentsForm
      {...f.props}
      dialog={{ kind: 'contents', action: 'record', vesselId: 'tube' }}
    />
  );
  choose('Contents status', 'Material is present but unidentified');
  reason();
  fireEvent.click(screen.getByRole('button', { name: 'Record contents status', exact: true }));
  await waitFor(() =>
    expect(f.submit).toHaveBeenCalledWith(
      [
        {
          kind: 'record-vessel-contents',
          vesselId: 'tube',
          knowledge: 'unidentified',
          reason: 'Checked the existing physical contents',
        },
      ],
      'Record contents status'
    )
  );
});

it('identifies existing contents with explicit material, zero amount and quality', async () => {
  const f = fixture('unidentified');
  render(
    <InventoryContentsForm
      {...f.props}
      dialog={{ kind: 'contents', action: 'identify', vesselId: 'tube' }}
    />
  );
  await waitFor(() => expect(f.client.materials).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('combobox', { name: 'Material' }));
  fireEvent.click(await screen.findByRole('option', { name: /^Existing scientific record/ }));
  fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '0' } });
  reason();
  fireEvent.click(screen.getByRole('button', { name: 'Identify contents', exact: true }));
  expect(await screen.findByText('Choose the stock quality explicitly.')).toBeVisible();
  expect(f.submit).not.toHaveBeenCalled();
  choose('Stock quality', 'Quarantined');
  fireEvent.click(screen.getByRole('button', { name: 'Identify contents', exact: true }));
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'identify-vessel-stock',
      vesselId: 'tube',
      materialId: 'material',
      quantity: { kind: 'known', value: '0', unit: 'uL' },
      quality: 'quarantined',
      reason: 'Checked the existing physical contents',
    }),
  ]);
  expect(screen.getByText(/does not record a physical receipt/)).toBeVisible();
});

it('requires a reason before declaring unresolved contents empty', async () => {
  const f = fixture();
  render(
    <InventoryContentsForm
      {...f.props}
      dialog={{ kind: 'contents', action: 'empty', vesselId: 'tube' }}
    />
  );
  fireEvent.submit(
    screen.getByRole('button', { name: 'Declare empty', exact: true }).closest('form')!
  );
  expect(await screen.findByText('Enter a reason for this contents declaration.')).toBeVisible();
  expect(f.submit).not.toHaveBeenCalled();
  reason();
  fireEvent.click(screen.getByRole('button', { name: 'Declare empty', exact: true }));
  await waitFor(() =>
    expect(f.submit).toHaveBeenCalledWith(
      [
        {
          kind: 'declare-vessel-empty',
          vesselId: 'tube',
          reason: 'Checked the existing physical contents',
        },
      ],
      'Declare empty'
    )
  );
});

it.each(['record', 'empty', 'identify'] as const)(
  'cannot use %s to erase an identified zero stock',
  (action) => {
    const f = fixture('zero');
    render(
      <InventoryContentsForm {...f.props} dialog={{ kind: 'contents', action, vesselId: 'tube' }} />
    );
    expect(
      screen.getByRole('button', {
        name:
          action === 'record'
            ? 'Record contents status'
            : action === 'empty'
              ? 'Declare empty'
              : 'Identify contents',
        exact: true,
      })
    ).toBeDisabled();
    expect(screen.getByText(/no longer eligible/)).toBeVisible();
    expect(f.submit).not.toHaveBeenCalled();
  }
);

it('keeps identified zero and unknown quantities separate from unresolved contents', () => {
  const s = state('zero');
  expect(inventoryContentsLabel(inventoryVesselContents(s, 'tube'))).toBe('Identified contents');
  const changed = {
    ...s,
    stocks: {
      stock: { ...s.stocks.stock, quantity: { kind: 'unknown' as const, unit: 'uL' as const } },
    },
  };
  expect(inventoryContentsLabel(inventoryVesselContents(changed, 'tube'))).toBe(
    'Identified contents'
  );
  expect(
    historyLabel(
      {
        kind: 'identify-vessel-stock',
        id: 'new',
        vesselId: 'tube',
        materialId: 'material',
        quantity: { kind: 'unknown' },
        quality: 'usable',
        reason: 'Explicit identification',
      },
      s
    )
  ).toBe('Identified existing contents in Physical tube');
});

it('exposes state to read-only users while disabling all declaration actions', () => {
  const f = fixture('unidentified', true);
  render(
    <InventoryContentsPanel
      data={f.props.data}
      vesselId="tube"
      editable={false}
      onDialog={vi.fn()}
    />
  );
  expect(screen.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unidentified'
  );
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Receive stock' })).toBeNull();
});

it('blocks a forced unresolved receiving target and excludes unresolved material destinations', () => {
  const f = fixture();
  const rendered = render(
    <InventoryForm
      {...f.props}
      dialog={{ kind: 'receive', vesselId: 'tube' }}
      onMaterial={vi.fn()}
    />
  );
  expect(screen.getByRole('button', { name: 'Receive stock', exact: true })).toBeDisabled();
  expect(screen.getByText(/not declared empty/)).toBeVisible();
  rendered.unmount();
  render(<InventoryMaterialForm {...f.props} dialog={{ kind: 'pool', stockId: 'missing' }} />);
  choose('Destination container', 'New unplaced container');
  fireEvent.click(screen.getByRole('combobox', { name: 'Destination container' }));
  expect(screen.queryByRole('option', { name: 'Physical tube', exact: true })).toBeNull();
});

it('does not close a new project dialog when an old submitted declaration finishes', async () => {
  const old = fixture();
  const current = fixture('unidentified', false, 'other-project');
  let finish!: (value: null) => void;
  old.submit.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const rendered = render(
    <InventoryContentsForm
      {...old.props}
      dialog={{ kind: 'contents', action: 'record', vesselId: 'tube' }}
    />
  );
  reason();
  fireEvent.click(screen.getByRole('button', { name: 'Record contents status', exact: true }));
  rendered.rerender(
    <InventoryContentsForm
      {...current.props}
      dialog={{ kind: 'contents', action: 'record', vesselId: 'tube' }}
    />
  );
  await act(async () => finish(null));
  expect(old.props.onClose).not.toHaveBeenCalled();
  expect(current.props.onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Reason')).toHaveValue('');
});

it('ignores an earlier scientific search response after the source query changes', async () => {
  const f = fixture();
  let first!: (value: InventoryMaterialPage) => void;
  f.client.materials.mockReturnValueOnce(
    new Promise((resolve) => {
      first = resolve;
    })
  );
  render(
    <InventoryContentsForm
      {...f.props}
      dialog={{ kind: 'contents', action: 'identify', vesselId: 'tube' }}
    />
  );
  await waitFor(() => expect(f.client.materials).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Find material'), { target: { value: 'latest' } });
  await waitFor(() => expect(f.client.materials).toHaveBeenCalledTimes(2));
  await act(async () =>
    first({
      items: [{ id: 'stale', name: 'Stale scientific record', kind: 'sequence', registryId: null }],
      nextCursor: null,
    })
  );
  fireEvent.click(screen.getByRole('combobox', { name: 'Material' }));
  expect(screen.queryByRole('option', { name: 'Stale scientific record', exact: true })).toBeNull();
  expect(await screen.findByRole('option', { name: /^Existing scientific record/ })).toBeVisible();
});
