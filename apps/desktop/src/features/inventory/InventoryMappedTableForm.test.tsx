import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryMappedTablePreview,
  inventoryStorageConditionsProjection,
  type InventoryMappedTableChoices,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryMappedTablePreviewSnapshot,
} from '../../shared/inventory-client';
import {
  InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryMappedTableForm } from './InventoryMappedTableForm';

const native = vi.hoisted(() => ({ dialog: { open: vi.fn() }, fs: { readFileBounded: vi.fn() } }));
vi.mock('../../platform', () => ({ platform: () => native }));
const fingerprint = `sha256:${'a'.repeat(64)}` as const;
const principal = { kind: 'local-profile' as const, profileKey: 'b'.repeat(64) };
const sourceText =
  'Primer ID,Oligo Sequence,Plate,Well,QC Flag,Freezer Box\nMP001,ACGT,Plate-7,A01,pass,Box A\n';
const options: InventoryMappedTableChoices = {
  namespace: 'primer-register',
  delimiter: ',',
  columns: { sourceId: 'Primer ID', plate: 'Plate', well: 'Well' },
  materials: [{ sourceId: 'MP001', materialId: 'material-1' }],
  plates: [
    {
      sourcePlate: 'Plate-7',
      storageId: 'plate',
      positions: [{ sourceWell: 'A01', position: 'A1' }],
    },
  ],
  quantity: { kind: 'unknown', reason: 'The register has no volume measurements' },
  qualities: [
    { sourceId: 'MP001', quality: 'usable', reason: 'Explicit physical quality decision' },
  ],
  evidenceOnlyColumns: ['Oligo Sequence', 'QC Flag', 'Freezer Box'].map((column) => ({
    column,
    reason: 'Retain source fields without interpreting physical facts',
  })),
  skips: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function fixture(pinned = false) {
  const created = applyInventoryCommandBatch(createInventoryState(), {
    expectedRevision: 0,
    commands: [
      {
        kind: 'create-layout-storage',
        id: 'plate',
        name: 'Explicitly sized plate',
        layout: { kind: 'fixed-well', rows: 2, columns: 2 },
        placement: { kind: 'root' },
      },
    ],
  });
  if (!created.ok) throw new Error(created.message);
  const data: InventoryData = {
    project: {
      projectId: 'project',
      defaultInventoryId: 'inventory',
      name: 'Destination',
      path: '/synthetic',
      pinned,
    },
    state: created.state,
    history: [],
    availability: null,
    storageConditions: {
      ...inventoryStorageConditionsProjection(created.state, {
        asOf: 100,
        freshnessMaxAgeMs: null,
      }),
      projectId: 'project',
      inventoryId: 'inventory',
      revision: created.state.revision,
      principal,
    },
  };
  const result = (
    choices: InventoryMappedTableChoices,
    text = sourceText
  ): InventoryMappedTablePreviewSnapshot => ({
    ...inventoryMappedTablePreview(created.state, {
      target: {
        projectId: 'project',
        inventoryId: 'inventory',
        present: true,
        revision: created.state.revision,
      },
      sourceText: text,
      options: choices,
      bindings: choices.materials.map((material) => ({
        ...material,
        kind: 'admitted' as const,
        fingerprint,
      })),
      asOf: 100,
      principal,
      authority: principal,
      maxBytes: 17 * 1024 * 1024,
    }),
    asOf: 100,
    principal,
  });
  const client = {
    ...unavailableInventoryClient(),
    materials: vi.fn(async () => ({
      items: [{ id: 'material-1', name: 'Scientific primer', registryId: null }],
      nextCursor: null,
    })),
    previewMappedTable: vi.fn(
      async (request: { options: InventoryMappedTableChoices; sourceText: string }) =>
        result(request.options, request.sourceText)
    ),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const receiveMappedTable = vi.spyOn(controller, 'receiveMappedTable').mockResolvedValue(null);
  const props = {
    data,
    client,
    controller,
    status: { kind: 'ready' as const, data } as InventoryControllerState,
    onClose: vi.fn(),
  };
  return { props, client, controller, receiveMappedTable, result };
}
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
}
async function inspect() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview mapped receiving' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-mapped-import')).not.toHaveAttribute(
      'data-preview-state',
      'previewing'
    )
  );
}
async function start() {
  fireEvent.change(screen.getByLabelText('Mapped source namespace'), {
    target: { value: options.namespace },
  });
  fireEvent.change(screen.getByLabelText('Original spreadsheet text'), {
    target: { value: sourceText },
  });
  await inspect();
}
async function resolve() {
  await start();
  choose('Source ID column', 'Primer ID');
  choose('Plate column', 'Plate');
  choose('Well column', 'Well');
  fireEvent.change(screen.getByLabelText('Reason for evidence-only columns'), {
    target: { value: options.evidenceOnlyColumns[0].reason },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Retain remaining columns as evidence' }));
  fireEvent.click(screen.getByLabelText('Declare unknown quantity'));
  fireEvent.change(screen.getByLabelText('Reason for unknown quantity'), {
    target: { value: options.quantity.reason },
  });
  await inspect();
}
async function rowDecisions() {
  choose(
    'Destination plate for Plate-7',
    'Explicitly sized plate · Explicitly sized plate · plate'
  );
  choose('Position for Plate-7 / A01', 'A1');
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'Scientific record for source MP001' })
    ).toBeInTheDocument()
  );
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'Scientific record for source MP001' })
    ).not.toBeDisabled()
  );
  fireEvent.click(screen.getByRole('combobox', { name: 'Scientific record for source MP001' }));
  await screen.findByRole('option', { name: 'Scientific primer · material-1', exact: true });
  fireEvent.click(
    screen.getByRole('option', { name: 'Scientific primer · material-1', exact: true })
  );
  choose('Quality for source MP001', 'Usable');
  fireEvent.change(screen.getByLabelText('Quality reason for source MP001'), {
    target: { value: options.qualities[0].reason },
  });
  await inspect();
}

it('requires explicit column, evidence, quantity, quality and exact well decisions before receiving', async () => {
  const f = fixture();
  render(<InventoryMappedTableForm {...f.props} />);
  await start();
  expect(screen.getByRole('button', { name: 'Receive mapped stocks' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Source ID column' })).toHaveTextContent(
    'Choose source id column'
  );
  expect(screen.getByLabelText('Declare unknown quantity')).not.toBeChecked();
  choose('Source ID column', 'Primer ID');
  choose('Plate column', 'Plate');
  choose('Well column', 'Well');
  fireEvent.change(screen.getByLabelText('Reason for evidence-only columns'), {
    target: { value: options.evidenceOnlyColumns[0].reason },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Retain remaining columns as evidence' }));
  fireEvent.click(screen.getByLabelText('Declare unknown quantity'));
  fireEvent.change(screen.getByLabelText('Reason for unknown quantity'), {
    target: { value: options.quantity.reason },
  });
  await inspect();
  expect(screen.getByRole('combobox', { name: 'Position for Plate-7 / A01' })).toHaveTextContent(
    'choose an exact destination position'
  );
  expect(screen.getByRole('combobox', { name: 'Quality for source MP001' })).toHaveTextContent(
    'Choose physical stock quality'
  );
  await rowDecisions();
  const plan = f.result(options);
  if (plan.kind !== 'ready') throw new Error(JSON.stringify(plan.issues));
  expect(screen.getByTestId('inventory-mapped-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  expect(f.client.previewMappedTable).toHaveBeenLastCalledWith({
    project: 'project',
    inventoryId: 'inventory',
    format: 'mapped-plate-v1',
    sourceText,
    options,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Receive mapped stocks' }));
  expect(f.receiveMappedTable).toHaveBeenCalledWith(sourceText, plan.options, plan.planDigest);
});

it('invalidates ready plans on interpretation edits and preserves reason controls after invalid choices', async () => {
  const f = fixture();
  render(<InventoryMappedTableForm {...f.props} />);
  await resolve();
  await rowDecisions();
  fireEvent.change(screen.getByLabelText('Quality reason for source MP001'), {
    target: { value: '' },
  });
  expect(screen.queryByTestId('inventory-mapped-preview')).not.toBeInTheDocument();
  await inspect();
  expect(screen.getByLabelText('Quality reason for source MP001')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Receive mapped stocks' })).toBeDisabled();
  expect(screen.getByTestId('inventory-mapped-rows')).not.toHaveTextContent(
    'Receive this stock into the selected permanent well'
  );
  fireEvent.click(screen.getByLabelText('Skip mapped source MP001'));
  await inspect();
  expect(screen.getByLabelText('Skip reason for mapped source MP001')).toBeVisible();
  expect(f.receiveMappedTable).not.toHaveBeenCalled();
});

it('marks target changes stale and lets read-only users compare without applying', async () => {
  const f = fixture(true);
  const view = render(<InventoryMappedTableForm {...f.props} />);
  await resolve();
  await rowDecisions();
  expect(screen.getByRole('button', { name: 'Receive mapped stocks' })).toBeDisabled();
  const changed = { ...f.props.data, state: { ...f.props.data.state, revision: 2 } };
  view.rerender(
    <InventoryMappedTableForm
      {...f.props}
      data={changed}
      status={{ kind: 'ready', data: changed }}
    />
  );
  expect(screen.getByTestId('inventory-mapped-import')).toHaveAttribute(
    'data-preview-state',
    'stale'
  );
  expect(f.receiveMappedTable).not.toHaveBeenCalled();
});

it('cancels file selection without discarding a preview and pins actual CRLF file text', async () => {
  const f = fixture();
  render(<InventoryMappedTableForm {...f.props} />);
  await resolve();
  await rowDecisions();
  native.dialog.open.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: 'Choose spreadsheet file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-mapped-import')).toHaveAttribute(
      'data-preview-state',
      'ready'
    )
  );
  const raw = sourceText.replaceAll('\n', '\r\n');
  native.dialog.open.mockResolvedValueOnce('/synthetic/original.csv');
  native.fs.readFileBounded.mockResolvedValueOnce(new TextEncoder().encode(raw));
  fireEvent.click(screen.getByRole('button', { name: 'Choose spreadsheet file' }));
  await screen.findByText('Source file: /synthetic/original.csv');
  await inspect();
  expect(f.client.previewMappedTable.mock.calls.at(-1)?.[0].sourceText).toBe(raw);
  expect(screen.getByLabelText('Declare unknown quantity')).not.toBeChecked();
});

it('ignores late preview completion after source editing or unmount and rejects wrong scope', async () => {
  const f = fixture();
  const delayed = deferred<InventoryMappedTablePreviewSnapshot>();
  f.client.previewMappedTable.mockReturnValueOnce(delayed.promise);
  const view = render(<InventoryMappedTableForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Original spreadsheet text'), {
    target: { value: sourceText },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview mapped receiving' }));
  view.unmount();
  await act(async () => delayed.resolve(f.result(options)));
  expect(f.receiveMappedTable).not.toHaveBeenCalled();
  f.client.previewMappedTable.mockImplementationOnce(async () => ({
    ...f.result(options),
    target: { projectId: 'foreign', inventoryId: 'inventory', present: true, revision: 1 },
  }));
  render(<InventoryMappedTableForm {...f.props} />);
  await start();
  expect(screen.getByTestId('inventory-mapped-import')).toHaveAttribute(
    'data-preview-state',
    'failed'
  );
  expect(
    screen.getByText('The mapped preview belongs to another project or inventory.')
  ).toBeVisible();
});

it('states that an evidence-only no-change preview saves neither a revised source file nor a receipt', async () => {
  const f = fixture();
  const plan = f.result(options);
  if (plan.kind !== 'ready') throw new Error('Expected ready mapped fixture.');
  f.client.previewMappedTable.mockResolvedValue({
    ...plan,
    kind: 'no-change',
    rows: plan.rows.map((row) => ({ ...row, kind: 'unchanged' })),
    issues: [],
    planDigest: null,
  });
  render(<InventoryMappedTableForm {...f.props} />);
  await start();
  expect(screen.getByText('No physical changes')).toBeVisible();
  expect(screen.getByText(/No new source file or receipt is saved/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Receive mapped stocks' })).toBeDisabled();
  expect(f.receiveMappedTable).not.toHaveBeenCalled();
});

it('locks retained source decisions while the submitted mapped outcome is unknown', () => {
  const f = fixture();
  const plan = f.result(options);
  if (plan.kind !== 'ready') throw new Error('Expected ready mapped fixture.');
  const status: InventoryControllerState = {
    kind: 'outcome-unknown',
    data: f.props.data,
    message: 'The response is unavailable.',
    attempt: {
      summary: 'Receive mapped spreadsheet',
      request: {
        kind: 'receive-mapped-table',
        project: 'project',
        inventoryId: 'inventory',
        operationId: 'original-operation',
        expectedRevision: f.props.data.state.revision,
        sourceText,
        options: plan.options,
        expectedPlanDigest: plan.planDigest,
      },
    },
  };
  render(<InventoryMappedTableForm {...f.props} status={status} />);
  expect(screen.getByLabelText('Original spreadsheet text')).toHaveValue(sourceText);
  expect(screen.getByLabelText('Original spreadsheet text')).toBeDisabled();
  expect(screen.getByLabelText('Mapped source namespace')).toBeDisabled();
  expect(screen.getByLabelText('Reason for unknown quantity')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Preview mapped receiving' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Receive mapped stocks' })).toBeDisabled();
  expect(f.receiveMappedTable).not.toHaveBeenCalled();
});
