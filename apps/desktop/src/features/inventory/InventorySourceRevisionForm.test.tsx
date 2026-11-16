import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  applyInventoryTable,
  createInventoryState,
  inventoryAvailability,
  inventoryStorageConditionsProjection,
  inventoryTablePreview,
  type InventoryReceiveTableFields,
  type InventorySourceRevisionRowPreview,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventorySourceRevisionPreviewSnapshot,
} from '../../shared/inventory-client';
import {
  InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventorySourceRevisionForm } from './InventorySourceRevisionForm';

const native = vi.hoisted(() => ({ dialog: { open: vi.fn() }, fs: { readFileBounded: vi.fn() } }));
vi.mock('../../platform', () => ({ platform: () => native }));
const digest = `sha256:${'a'.repeat(64)}` as const;
const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
const context = { at: 100, principal, authority: principal };
const columns =
  'source_id,name,material_key,quantity_kind,quantity,unit,quality,vessel_kind,vessel_key,location_key,slot';
const previousFields: InventoryReceiveTableFields = {
  source_id: '0007',
  name: 'Original tube',
  material_key: 'sample',
  quantity_kind: 'known',
  quantity: '80',
  unit: 'uL',
  quality: 'usable',
  vessel_kind: 'new',
  vessel_key: '',
  location_key: 'freezer',
  slot: 'A',
};
const revisedFields: InventoryReceiveTableFields = {
  ...previousFields,
  name: 'Revised external label',
  quantity: '90',
  quality: 'quarantined',
  slot: 'C',
};
const csv = (fields: InventoryReceiveTableFields) =>
  columns +
  '\n' +
  columns
    .split(',')
    .map((key) => fields[key as keyof InventoryReceiveTableFields])
    .join(',') +
  '\n';
const sourceText = csv(revisedFields);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function stateFixture(): InventoryState {
  const setup = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-storage',
          id: 'box',
          name: 'Actual box',
          slots: ['A', 'B', 'C'],
          placement: { kind: 'root' },
        },
      ],
    },
    context
  );
  if (!setup.ok) throw new Error(setup.message);
  const table = {
    namespace: 'source-register',
    delimiter: ',' as const,
    materials: [{ key: 'sample', materialId: 'material' }],
    locations: [{ key: 'freezer', target: { kind: 'storage' as const, storageId: 'box' } }],
    vessels: [],
    skips: [],
  };
  const target = {
    projectId: 'project',
    inventoryId: 'inventory',
    present: true,
    revision: setup.state.revision,
  };
  const plan = inventoryTablePreview(setup.state, {
    target,
    sourceText: csv(previousFields),
    options: table,
    bindings: [{ ...table.materials[0], kind: 'admitted', fingerprint: digest }],
    asOf: 100,
    principal,
    authority: principal,
    maxBytes: 17 * 1024 * 1024,
  });
  if (plan.kind !== 'ready') throw new Error('Expected receiving fixture.');
  const received = applyInventoryTable(
    setup.state,
    {
      target,
      sourceText: csv(previousFields),
      options: plan.options,
      expectedPlanDigest: plan.planDigest,
    },
    context,
    17 * 1024 * 1024
  );
  if (!received.ok) throw new Error(received.message);
  const binding = Object.values(received.state.tableBindings)[0];
  const actual = applyInventoryCommandBatch(
    received.state,
    {
      expectedRevision: received.state.revision,
      commands: [
        {
          kind: 'consume',
          stockId: binding.stockId,
          quantity: { value: '17', unit: 'uL' },
          reason: 'Actual intervening use',
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
          purpose: 'Preserve this hold',
        },
      ],
    },
    context
  );
  if (!actual.ok) throw new Error(actual.message);
  return actual.state;
}

function fixture(pinned = false) {
  const state = stateFixture();
  const binding = Object.values(state.tableBindings)[0];
  const availability = inventoryAvailability(state, principal, 100);
  const data: InventoryData = {
    project: {
      projectId: 'project',
      defaultInventoryId: 'inventory',
      name: 'Destination project',
      path: '/synthetic',
      pinned,
    },
    state,
    history: [],
    availability: null,
    storageConditions: {
      ...inventoryStorageConditionsProjection(state, { asOf: 100, freshnessMaxAgeMs: null }),
      projectId: 'project',
      inventoryId: 'inventory',
      revision: state.revision,
      principal,
    },
  };
  const row: InventorySourceRevisionRowPreview = {
    index: 2,
    sourceId: '0007',
    bindingKey: Object.keys(state.tableBindings)[0],
    kind: 'needs-acknowledgement',
    previousRowSha256: binding.rowSha256,
    previousFields,
    revisedFields,
    binding,
    destination: {
      kind: 'new-vessel',
      placement: { kind: 'located', storageId: 'box', slotId: 'C' },
    },
    actual: {
      stock: state.stocks[binding.stockId],
      vessel: state.vessels[binding.vesselId],
      custody: availability.items[binding.vesselId],
      availability: availability.stocks[binding.stockId],
    },
    reason: null,
    issues: [],
  };
  const options = {
    table: {
      namespace: 'source-register',
      delimiter: ',' as const,
      materials: [{ key: 'sample', materialId: 'material' }],
      locations: [{ key: 'freezer', target: { kind: 'storage' as const, storageId: 'box' } }],
      vessels: [],
      skips: [],
    },
    acknowledgements: [
      {
        sourceId: '0007',
        expectedPreviousRowSha256: binding.rowSha256,
        reason: 'Accept revised external register only',
      },
    ],
    preimages: [{ sourceId: '0007', fields: previousFields }],
  };
  const base = {
    schema: 'dnaforge.inventory-source-revision-preview.v1' as const,
    target: {
      projectId: 'project',
      inventoryId: 'inventory',
      present: true,
      revision: state.revision,
    },
    sourceSha256: digest,
    materialKeys: ['sample'],
    locationKeys: ['freezer'],
    vesselKeys: [],
    asOf: 100,
    principal,
  };
  const needs: InventorySourceRevisionPreviewSnapshot = {
    ...base,
    kind: 'needs-acknowledgement',
    rows: [row],
    issues: [],
    options: null,
    planDigest: null,
  };
  const ready: InventorySourceRevisionPreviewSnapshot = {
    ...base,
    kind: 'ready',
    rows: [{ ...row, kind: 'proposed', reason: options.acknowledgements[0].reason }],
    issues: [],
    options,
    planDigest: digest,
  };
  const client = {
    ...unavailableInventoryClient,
    materials: vi.fn(async () => ({
      items: [{ id: 'material', name: 'Material', kind: 'record', registryId: null }],
      nextCursor: null,
    })),
    previewSourceRevision: vi.fn(async () => ready),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => undefined });
  const acknowledge = vi.spyOn(controller, 'acknowledgeSourceRevision').mockResolvedValue(null);
  const props = {
    data,
    controller,
    client,
    status: { kind: 'ready', data } as InventoryControllerState,
    onClose: vi.fn(),
  };
  return { props, client, controller, acknowledge, binding, needs, ready, options, row };
}

async function compare(text = sourceText) {
  fireEvent.change(screen.getByLabelText('Source revision namespace'), {
    target: { value: 'source-register' },
  });
  fireEvent.change(screen.getByLabelText('Revised receive table text'), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Compare revised source' }));
  await screen.findByTestId('inventory-source-revision-preview');
}
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
}

it('shows previous source, revised source and actual stock as different facts', async () => {
  const f = fixture();
  f.client.previewSourceRevision.mockResolvedValueOnce(f.needs);
  render(<InventorySourceRevisionForm {...f.props} />);
  await compare();
  expect(
    within(screen.getByRole('region', { name: 'Previous source baseline' })).getByText(
      'Quantity: 80 µL'
    )
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole('region', { name: 'Previous source baseline' })).getByText(
      'Position: A'
    )
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole('region', { name: 'Revised source record' })).getByText(
      'Quantity: 90 µL'
    )
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole('region', { name: 'Revised source record' })).getByText(
      'Quality: quarantined'
    )
  ).toBeInTheDocument();
  const actual = screen.getByRole('region', { name: 'Actual inventory' });
  expect(actual).toHaveTextContent('Quantity: 63 µL');
  expect(actual).toHaveTextContent('Actual box / B');
  expect(actual).toHaveTextContent('Quality: usable');
  expect(actual).toHaveTextContent('Held: 60 µL');
  expect(screen.getByRole('button', { name: 'Acknowledge source revision' })).toBeDisabled();
});

it('requires an explicit captured baseline and reason, then submits exact resolved evidence', async () => {
  const f = fixture();
  f.client.previewSourceRevision.mockResolvedValueOnce(f.needs);
  render(<InventorySourceRevisionForm {...f.props} />);
  await compare();
  await waitFor(() => expect(f.client.materials).toHaveBeenCalled());
  choose('Scientific record for sample', 'Material · material');
  choose('Location for freezer', 'Actual box · box');
  fireEvent.click(screen.getByLabelText('Acknowledge source 0007'));
  expect(screen.getByLabelText('Previous source hash for 0007')).toHaveValue(f.binding.rowSha256);
  expect(screen.getByLabelText('Previous source hash for 0007')).toHaveAttribute('readonly');
  fireEvent.change(screen.getByLabelText('Reason for source revision 0007'), {
    target: { value: 'Accept revised external register only' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Compare revised source' }));
  await screen.findByText('Ready to acknowledge source revisions');
  expect(f.client.previewSourceRevision).toHaveBeenLastCalledWith({
    project: 'project',
    inventoryId: 'inventory',
    format: 'receive-v1',
    sourceText,
    options: { table: f.options.table, acknowledgements: f.options.acknowledgements },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge source revision' }));
  expect(f.acknowledge).toHaveBeenCalledWith(sourceText, f.options, digest);
  expect(f.props.onClose).not.toHaveBeenCalled();
});

it('retains reason controls after an incomplete choice without retaining a stale comparison', async () => {
  const f = fixture();
  f.client.previewSourceRevision.mockResolvedValueOnce(f.needs).mockResolvedValueOnce({
    ...f.needs,
    kind: 'blocked',
    rows: [],
    materialKeys: [],
    locationKeys: [],
    issues: [
      {
        code: 'REASON_REQUIRED',
        pointer: '/options',
        message: 'Supply an acknowledgement reason.',
      },
    ],
  });
  render(<InventorySourceRevisionForm {...f.props} />);
  await compare();
  fireEvent.click(screen.getByLabelText('Acknowledge source 0007'));
  fireEvent.click(screen.getByRole('button', { name: 'Compare revised source' }));
  await screen.findByText('Supply an acknowledgement reason.');
  expect(screen.getByLabelText('Reason for source revision 0007')).toBeVisible();
  expect(screen.queryByText('Quantity: 63 µL')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Acknowledge source revision' })).toBeDisabled();
  expect(
    screen.getByTestId('inventory-source-revision-rows').querySelector('[data-row-kind="proposed"]')
  ).toBeNull();
  fireEvent.change(screen.getByLabelText('Reason for source revision 0007'), {
    target: { value: 'Accept revised external register only' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Compare revised source' }));
  await screen.findByText('Ready to acknowledge source revisions');
});

it('invalidates edited source decisions and marks changed target snapshots stale', async () => {
  const f = fixture();
  const view = render(<InventorySourceRevisionForm {...f.props} />);
  await compare();
  fireEvent.change(screen.getByLabelText('Source revision namespace'), {
    target: { value: 'different-register' },
  });
  expect(screen.queryByTestId('inventory-source-revision-preview')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Acknowledge source revision' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Compare revised source' }));
  await screen.findByText('Ready to acknowledge source revisions');
  const changed = {
    ...f.props.data,
    state: { ...f.props.data.state, revision: f.props.data.state.revision + 1 },
  };
  view.rerender(
    <InventorySourceRevisionForm
      {...f.props}
      data={changed}
      status={{ kind: 'ready', data: changed }}
    />
  );
  expect(screen.getByTestId('inventory-source-revision-import')).toHaveAttribute(
    'data-preview-state',
    'stale'
  );
  expect(screen.getByRole('button', { name: 'Acknowledge source revision' })).toBeDisabled();
  expect(f.acknowledge).not.toHaveBeenCalled();
});

it('permits read-only comparison and refuses a preview from another scope', async () => {
  const f = fixture(true);
  render(<InventorySourceRevisionForm {...f.props} />);
  await compare();
  expect(screen.getByRole('button', { name: 'Acknowledge source revision' })).toBeDisabled();
  f.client.previewSourceRevision.mockResolvedValueOnce({
    ...f.ready,
    target: { ...f.ready.target, projectId: 'another-project' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Compare revised source' }));
  await screen.findByText('The comparison belongs to another project or inventory.');
  expect(screen.getByRole('button', { name: 'Acknowledge source revision' })).toBeDisabled();
});

it('keeps bound identities available when scientific records are archived and makes skips explicit', async () => {
  const f = fixture();
  f.client.materials.mockResolvedValue({ items: [], nextCursor: null });
  f.client.previewSourceRevision.mockResolvedValueOnce(f.needs);
  render(<InventorySourceRevisionForm {...f.props} />);
  await compare();
  choose('Scientific record for sample', 'Bound scientific record material');
  fireEvent.click(screen.getByLabelText('Acknowledge source 0007'));
  fireEvent.click(screen.getByLabelText('Skip source 0007'));
  expect(screen.queryByLabelText('Reason for source revision 0007')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Skip reason for source 0007'), {
    target: { value: 'Resolve this source separately' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Compare revised source' }));
  await screen.findByTestId('inventory-source-revision-preview');
  expect(f.client.previewSourceRevision).toHaveBeenLastCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        acknowledgements: [],
        table: expect.objectContaining({
          materials: [{ key: 'sample', materialId: 'material' }],
          skips: [{ sourceId: '0007', reason: 'Resolve this source separately' }],
        }),
      }),
    })
  );
});

it('retains exact file bytes and restores the previous comparison when selection is cancelled', async () => {
  const f = fixture();
  const fileText = sourceText.replaceAll('\n', '\r\n');
  native.dialog.open.mockResolvedValueOnce('/synthetic/revised.csv').mockResolvedValueOnce(null);
  native.fs.readFileBounded.mockResolvedValueOnce(new TextEncoder().encode(fileText));
  render(<InventorySourceRevisionForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose revised receive table file' }));
  await screen.findByText('Selected file: /synthetic/revised.csv');
  fireEvent.click(screen.getByRole('button', { name: 'Compare revised source' }));
  await screen.findByTestId('inventory-source-revision-preview');
  expect(f.client.previewSourceRevision).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceText: fileText })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose revised receive table file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-source-revision-preview')).toBeInTheDocument()
  );
  expect(f.client.previewSourceRevision).toHaveBeenCalledOnce();
  const pending = deferred<string | null>();
  native.dialog.open.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Choose revised receive table file' }));
  expect(screen.getByRole('button', { name: 'Acknowledge source revision' })).toBeDisabled();
  await act(async () => {
    pending.resolve(null);
  });
  expect(screen.getByTestId('inventory-source-revision-preview')).toBeInTheDocument();
});
