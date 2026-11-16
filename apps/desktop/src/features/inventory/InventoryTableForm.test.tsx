import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryStorageConditionsProjection,
  type InventoryResolvedTableOptions,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryTablePreviewSnapshot,
} from '../../shared/inventory-client';
import {
  InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryTableForm } from './InventoryTableForm';

const native = vi.hoisted(() => ({
  dialog: { open: vi.fn() },
  fs: { readFileBounded: vi.fn() },
}));
vi.mock('../../platform', () => ({ platform: () => native }));

const digest = `sha256:${'a'.repeat(64)}` as const;
const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
const sourceText =
  'source_id,name,material_key,quantity_kind,quantity,unit,quality,vessel_kind,vessel_key,location_key,slot\n0007,Tube,sample,known,0,uL,usable,new,,bench,\n';
const options: InventoryResolvedTableOptions = {
  namespace: 'source-register',
  delimiter: ',',
  materials: [{ key: 'sample', materialId: 'material', fingerprint: digest }],
  locations: [{ key: 'bench', target: { kind: 'unplaced' } }],
  vessels: [],
  skips: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function data(state = createInventoryState(), pinned = false): InventoryData {
  return {
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
}

function ready(): InventoryTablePreviewSnapshot {
  return {
    schema: 'dnaforge.inventory-table-preview.v1',
    kind: 'ready',
    target: { projectId: 'project', inventoryId: 'inventory', present: false, revision: 0 },
    sourceSha256: digest,
    materialKeys: ['sample'],
    locationKeys: ['bench'],
    vesselKeys: [],
    bindings: [{ key: 'sample', materialId: 'material', kind: 'admitted', fingerprint: digest }],
    rows: [
      {
        index: 2,
        sourceId: '0007',
        fields: {
          source_id: '0007',
          name: 'Tube',
          material_key: 'sample',
          quantity_kind: 'known',
          quantity: '0',
          unit: 'uL',
          quality: 'usable',
          vessel_kind: 'new',
          vessel_key: '',
          location_key: 'bench',
          slot: '',
        },
        kind: 'create',
        stockId: 'stock',
        vesselId: 'tube',
        reason: null,
        issues: [],
      },
    ],
    issues: [],
    commands: [
      { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
    ],
    bindingAdditions: {},
    planDigest: digest,
    options,
    asOf: 100,
    principal,
  };
}

function blocked(): InventoryTablePreviewSnapshot {
  const result = ready();
  return {
    ...result,
    kind: 'blocked',
    rows: result.rows.map((row) => ({ ...row, kind: 'blocked' })),
    issues: [
      { code: 'BINDING_MISSING', pointer: '/options', message: 'Choose explicit bindings.' },
    ],
    commands: [],
    bindingAdditions: {},
    planDigest: null,
    options: null,
  };
}

function fixture(pinned = false) {
  const current = data(createInventoryState(), pinned);
  const client = {
    ...unavailableInventoryClient(),
    materials: vi.fn(async () => ({
      items: [{ id: 'material', name: 'Material', kind: 'sequence', registryId: null }],
      nextCursor: null,
    })),
    previewTable: vi.fn(async () => ready()),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const receive = vi.spyOn(controller, 'receiveTable').mockResolvedValue(null);
  const props = {
    data: current,
    controller,
    client,
    status: { kind: 'ready' as const, data: current } as InventoryControllerState,
    onClose: vi.fn(),
  };
  return { props, client, controller, receive };
}

async function preview(text = sourceText) {
  fireEvent.change(screen.getByLabelText('Source namespace'), {
    target: { value: 'source-register' },
  });
  fireEvent.change(screen.getByLabelText('Table source text'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview table' }));
  await screen.findByTestId('inventory-table-preview');
}
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
}

it('requires explicit material and location choices, then submits the exact resolved plan', async () => {
  const f = fixture();
  f.client.previewTable.mockResolvedValueOnce(blocked());
  render(<InventoryTableForm {...f.props} />);
  await preview();
  expect(screen.getByRole('button', { name: 'Receive table stocks' })).toBeDisabled();
  await waitFor(() => expect(f.client.materials).toHaveBeenCalled());
  choose('Scientific record for sample', 'Material · material');
  choose('Location for bench', 'Explicitly unplaced');
  expect(screen.queryByTestId('inventory-table-preview')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview table' }));
  await screen.findByText('Ready for atomic receiving');
  expect(f.client.previewTable).toHaveBeenLastCalledWith({
    project: 'project',
    inventoryId: 'inventory',
    format: 'receive-v1',
    sourceText,
    options: {
      namespace: 'source-register',
      delimiter: ',',
      materials: [{ key: 'sample', materialId: 'material' }],
      locations: [{ key: 'bench', target: { kind: 'unplaced' } }],
      vessels: [],
      skips: [],
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Receive table stocks' }));
  expect(f.receive).toHaveBeenCalledWith(sourceText, options, digest);
  expect(screen.getByTestId('inventory-table-rows')).toHaveTextContent('0007');
  expect(screen.getByTestId('inventory-table-rows')).toHaveTextContent('0 uL');
});

it('invalidates a ready preview when source, namespace or delimiter changes', async () => {
  const f = fixture();
  render(<InventoryTableForm {...f.props} />);
  await preview();
  fireEvent.change(screen.getByLabelText('Source namespace'), { target: { value: 'revised' } });
  expect(screen.queryByTestId('inventory-table-preview')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview table' }));
  await screen.findByText('Ready for atomic receiving');
  choose('Delimiter', 'TSV — tab separated');
  expect(screen.queryByTestId('inventory-table-preview')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview table' }));
  await screen.findByText('Ready for atomic receiving');
  fireEvent.change(screen.getByLabelText('Table source text'), {
    target: { value: 'changed source' },
  });
  expect(screen.getByRole('button', { name: 'Receive table stocks' })).toBeDisabled();
  expect(f.receive).not.toHaveBeenCalled();
});

it('marks target revision changes stale and permits read-only preview without applying', async () => {
  const f = fixture(true);
  const view = render(<InventoryTableForm {...f.props} />);
  await preview();
  expect(screen.getByRole('button', { name: 'Receive table stocks' })).toBeDisabled();
  const changed = applyInventoryCommandBatch(createInventoryState(), {
    expectedRevision: 0,
    commands: [
      { kind: 'create-vessel', id: 'other', name: 'Other', placement: { kind: 'unplaced' } },
    ],
  });
  if (!changed.ok) throw new Error(changed.message);
  const next = data(changed.state, true);
  view.rerender(
    <InventoryTableForm {...f.props} data={next} status={{ kind: 'ready', data: next }} />
  );
  expect(screen.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'stale'
  );
  expect(screen.getByText(/This table preview is stale/)).toBeInTheDocument();
  expect(f.receive).not.toHaveBeenCalled();
});

it('keeps cancellation byte-exact and rejects malformed UTF-8 without replacing source', async () => {
  const f = fixture();
  render(<InventoryTableForm {...f.props} />);
  await preview();
  native.dialog.open.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: 'Choose receive table file' }));
  await screen.findByText('Ready for atomic receiving');
  expect(screen.getByLabelText('Table source text')).toHaveValue(sourceText);
  native.dialog.open.mockResolvedValueOnce('/synthetic/source.csv');
  native.fs.readFileBounded.mockResolvedValueOnce(Uint8Array.from([0xc3, 0x28]));
  fireEvent.click(screen.getByRole('button', { name: 'Choose receive table file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-table-import')).toHaveAttribute(
      'data-preview-state',
      'failed'
    )
  );
  expect(screen.getByLabelText('Table source text')).toHaveValue(sourceText);
  expect(screen.getByRole('button', { name: 'Receive table stocks' })).toBeDisabled();
});

it('retains a chosen file with exact CRLF source bytes and fences late work after unmount', async () => {
  const f = fixture();
  const raw = sourceText.replaceAll('\n', '\r\n');
  native.dialog.open.mockResolvedValueOnce('/synthetic/source.csv');
  native.fs.readFileBounded.mockResolvedValueOnce(new TextEncoder().encode(raw));
  const view = render(<InventoryTableForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose receive table file' }));
  await waitFor(() => expect(screen.getByLabelText('Table source text')).toHaveValue(sourceText));
  expect(screen.getByText('/synthetic/source.csv')).toBeInTheDocument();
  const pending = deferred<InventoryTablePreviewSnapshot>();
  f.client.previewTable.mockReturnValueOnce(pending.promise);
  fireEvent.change(screen.getByLabelText('Source namespace'), {
    target: { value: 'source-register' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview table' }));
  expect(f.client.previewTable.mock.calls[0][0].sourceText).toBe(raw);
  view.unmount();
  await act(async () => pending.resolve(ready()));
  expect(f.receive).not.toHaveBeenCalled();
});

it('records explicit skip reasons and removes mappings used only by skipped rows', async () => {
  const f = fixture();
  render(<InventoryTableForm {...f.props} />);
  await preview();
  await waitFor(() => expect(f.client.materials).toHaveBeenCalled());
  choose('Scientific record for sample', 'Material · material');
  choose('Location for bench', 'Explicitly unplaced');
  fireEvent.click(screen.getByLabelText('Skip table source 0007'));
  fireEvent.change(screen.getByLabelText('Skip reason for table source 0007'), {
    target: { value: 'Awaiting source correction' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview table' }));
  await waitFor(() => expect(f.client.previewTable).toHaveBeenCalledTimes(2));
  expect(f.client.previewTable.mock.calls[1][0].options).toMatchObject({
    skips: [{ sourceId: '0007', reason: 'Awaiting source correction' }],
    materials: [],
    locations: [],
  });
  expect(screen.getByText(/Skipping does not delete stock or mark it missing/)).toBeInTheDocument();
});

it('refuses previews from another scope and locks source intent during an unknown operation', async () => {
  const f = fixture();
  f.client.previewTable.mockResolvedValueOnce({
    ...ready(),
    target: { ...ready().target, projectId: 'other' },
  });
  const view = render(<InventoryTableForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Source namespace'), {
    target: { value: 'source-register' },
  });
  fireEvent.change(screen.getByLabelText('Table source text'), { target: { value: sourceText } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview table' }));
  await screen.findByText('The table preview belongs to another project or inventory.');
  const status: InventoryControllerState = {
    kind: 'outcome-unknown',
    data: f.props.data,
    attempt: {
      summary: 'Receive inventory table',
      request: {
        kind: 'receive-table',
        project: 'project',
        inventoryId: 'inventory',
        operationId: 'original',
        expectedRevision: 0,
        sourceText,
        options,
        expectedPlanDigest: digest,
      },
    },
    message: 'Outcome unknown',
  };
  view.rerender(<InventoryTableForm {...f.props} status={status} />);
  expect(screen.getByLabelText('Table source text')).toBeDisabled();
  expect(screen.getByLabelText('Source namespace')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Preview table' })).toBeDisabled();
  expect(f.receive).not.toHaveBeenCalled();
});

it('offers the lifetime-bound existing vessel even after receiving, use and disposal', async () => {
  const f = fixture();
  const received = applyInventoryCommandBatch(createInventoryState(), {
    expectedRevision: 0,
    commands: [
      {
        kind: 'create-vessel',
        id: 'bound-well',
        name: 'Bound well',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: 'bound-well',
        materialId: 'material',
        quantity: { kind: 'known', value: '3', unit: 'uL' },
        quality: 'usable',
      },
    ],
  });
  if (!received.ok) throw new Error(received.message);
  const current = data({
    ...received.state,
    vessels: { 'bound-well': { ...received.state.vessels['bound-well'], lifecycle: 'disposed' } },
    tableBindings: {
      [digest]: {
        namespace: 'source-register',
        sourceId: '0007',
        rowSha256: digest,
        stockId: 'stock',
        vesselId: 'bound-well',
        materialId: 'material',
        destination: { kind: 'existing-vessel' },
      },
    },
  });
  const original = blocked();
  f.client.previewTable.mockResolvedValueOnce({
    ...original,
    target: { ...original.target, revision: current.state.revision, present: true },
    locationKeys: [],
    vesselKeys: ['well'],
    rows: original.rows.map((row) => ({
      ...row,
      fields: row.fields
        ? { ...row.fields, name: '', vessel_kind: 'existing', vessel_key: 'well', location_key: '' }
        : null,
    })),
  });
  render(
    <InventoryTableForm {...f.props} data={current} status={{ kind: 'ready', data: current }} />
  );
  await preview();
  fireEvent.click(screen.getByRole('combobox', { name: 'Existing vessel for well' }));
  expect(
    screen.getByRole('option', {
      name: 'Bound well · Unplaced · bound-well · Already bound to this source',
    })
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('option', {
      name: 'Bound well · Unplaced · bound-well · Already bound to this source',
    })
  );
  expect(f.receive).not.toHaveBeenCalled();
});

it('retains parsed source rows so an invalid skip reason can be corrected', async () => {
  const f = fixture();
  render(<InventoryTableForm {...f.props} />);
  await preview();
  fireEvent.click(screen.getByLabelText('Skip table source 0007'));
  f.client.previewTable.mockResolvedValueOnce({
    ...blocked(),
    rows: [],
    materialKeys: [],
    locationKeys: [],
    vesselKeys: [],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview table', exact: true }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-table-import')).toHaveAttribute(
      'data-preview-state',
      'blocked'
    )
  );
  expect(screen.getByLabelText('Skip reason for table source 0007')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Receive table stocks', exact: true })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Skip reason for table source 0007'), {
    target: { value: 'Not a current source row' },
  });
  expect(screen.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'editing'
  );
  f.controller.dispose();
});
