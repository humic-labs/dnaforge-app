import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  applyInventoryStocktake,
  createInventoryState,
  inventoryStocktakePreview,
  inventoryStorageConditionsProjection,
  type InventoryState,
  type InventoryStocktakeChoices,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryStocktakePreviewSnapshot,
  type InventoryPreviewStocktakeRequest,
} from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryStocktakeForm } from './InventoryStocktakeForm';

const native = vi.hoisted(() => ({ dialog: { open: vi.fn() }, fs: { readFileBounded: vi.fn() } }));
vi.mock('../../platform', () => ({ platform: () => native }));
const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
const context = { at: 100, principal, authority: principal };
const columns =
  'observation_id,subject_key,observed_at,quantity_kind,quantity,unit,presence,location_key,slot,reason';
const sourceText =
  columns + '\n0001,sample,unknown,known,40,uL,not-observed,,,Measured remaining volume\n';
const recordChoices: InventoryStocktakeChoices = {
  namespace: 'stocktake-register',
  delimiter: ',',
  subjects: [{ key: 'sample', subject: { kind: 'stock', stockId: 'stock' } }],
  locations: [],
  decisions: [{ observationId: '0001', choice: { kind: 'record-only' } }],
};

function state() {
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-storage',
          id: 'box',
          name: 'Box',
          slots: ['A', 'B'],
          placement: { kind: 'root' },
        },
        {
          kind: 'create-vessel',
          id: 'tube',
          name: 'Tube',
          placement: { kind: 'located', storageId: 'box', slotId: 'A' },
        },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'tube',
          materialId: 'material',
          quantity: { kind: 'known', value: '80', unit: 'uL' },
          quality: 'usable',
        },
        {
          kind: 'reserve-quantity',
          id: 'hold',
          stockId: 'stock',
          quantity: { value: '60', unit: 'uL' },
          purpose: 'Held for experiment',
          deadline: null,
        },
      ],
    },
    context
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
function data(current = state(), pinned = false): InventoryData {
  return {
    project: {
      projectId: 'project',
      defaultInventoryId: 'inventory',
      name: 'Stocktake project',
      path: '/synthetic',
      pinned,
    },
    state: current,
    history: [],
    availability: null,
    storageConditions: {
      ...inventoryStorageConditionsProjection(current, { asOf: 100, freshnessMaxAgeMs: null }),
      projectId: 'project',
      inventoryId: 'inventory',
      revision: current.revision,
      principal,
    },
  };
}
function plan(
  current: InventoryState,
  request: Pick<InventoryPreviewStocktakeRequest, 'sourceText' | 'options'>
): InventoryStocktakePreviewSnapshot {
  return {
    ...inventoryStocktakePreview(current, {
      target: {
        projectId: 'project',
        inventoryId: 'inventory',
        present: true,
        revision: current.revision,
      },
      sourceText: request.sourceText,
      options: request.options,
      asOf: 100,
      principal,
      authority: principal,
      maxBytes: 17 * 1024 * 1024,
    }),
    asOf: 100,
    principal,
  };
}
function fixture(current = state(), pinned = false) {
  const value = data(current, pinned);
  const client = {
    ...unavailableInventoryClient(),
    previewStocktake: vi.fn(async (request: InventoryPreviewStocktakeRequest) =>
      plan(current, request)
    ),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const apply = vi.spyOn(controller, 'applyStocktake').mockResolvedValue(null);
  const props = {
    data: value,
    client,
    controller,
    status: { kind: 'ready' as const, data: value },
    onClose: vi.fn(),
  };
  return { props, client, controller, apply };
}
function choose(label: string, name: string | RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label, exact: true }));
  fireEvent.click(screen.getByRole('option', { name, exact: true }));
}
async function inspect() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview stocktake', exact: true }));
  await screen.findByTestId('inventory-stocktake-preview');
}
async function source(text = sourceText) {
  fireEvent.change(screen.getByLabelText('Stocktake source namespace'), {
    target: { value: 'stocktake-register' },
  });
  fireEvent.change(screen.getByLabelText('Stocktake source text'), { target: { value: text } });
  await inspect();
}
async function resolve(choice: 'Record only' | 'Apply observed correction' = 'Record only') {
  choose('Subject for sample', /^Stock: Tube/);
  choose('Decision for 0001', choice);
  if (choice === 'Apply observed correction')
    fireEvent.change(screen.getByLabelText('Apply reason for observation 0001'), {
      target: { value: 'Apply measured quantity' },
    });
  await inspect();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

it('requires an explicit subject and row decision, then records only the exact pinned proposal', async () => {
  const f = fixture();
  render(<InventoryStocktakeForm {...f.props} />);
  await source();
  expect(screen.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  expect(f.client.previewStocktake.mock.calls[0][0].options.decisions).toEqual([]);
  expect(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  ).toBeDisabled();
  await resolve();
  expect(screen.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  const expected = plan(f.props.data.state, { sourceText, options: recordChoices });
  if (expected.kind !== 'ready') throw new Error('Expected record-only plan.');
  expect(expected.commands).toHaveLength(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  );
  await waitFor(() =>
    expect(f.apply).toHaveBeenCalledWith(sourceText, expected.options, expected.planDigest)
  );
  expect(f.props.onClose).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Stocktake source text'), {
    target: { value: sourceText + '\n' },
  });
  expect(screen.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'editing'
  );
  expect(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  ).toBeDisabled();
  f.controller.dispose();
});

it('shows a below-hold shortfall without blocking an explicitly applied measurement', async () => {
  const f = fixture();
  render(<InventoryStocktakeForm {...f.props} />);
  await source();
  await resolve('Apply observed correction');
  expect(screen.getByTestId('inventory-stocktake-shortfall')).toHaveTextContent(
    'holds remain active'
  );
  expect(screen.getByText('Before proposal').parentElement).toHaveTextContent('80 µL');
  expect(screen.getByText('After proposal').parentElement).toHaveTextContent('40 µL');
  expect(screen.getByText('After proposal').parentElement).toHaveTextContent('Held: 60 µL');
  expect(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  ).toBeEnabled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  );
  await waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
  expect(f.apply.mock.calls[0][1].decisions).toEqual([
    { observationId: '0001', choice: { kind: 'apply', reason: 'Apply measured quantity' } },
  ]);
  f.controller.dispose();
});

it('allows a recorded observation to be applied later and shows its pending application', async () => {
  const original = state();
  const first = plan(original, { sourceText, options: recordChoices });
  if (first.kind !== 'ready') throw new Error('Expected record-only plan.');
  const recorded = applyInventoryStocktake(
    original,
    {
      target: first.target,
      sourceText,
      options: first.options,
      expectedPlanDigest: first.planDigest,
    },
    context,
    17 * 1024 * 1024
  );
  if (!recorded.ok) throw new Error(recorded.message);
  const f = fixture(recorded.state);
  render(<InventoryStocktakeForm {...f.props} />);
  await source();
  expect(screen.getByText('Previously recorded · Correction not applied')).toBeVisible();
  await resolve('Apply observed correction');
  expect(screen.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  const last = f.client.previewStocktake.mock.calls.at(-1)![0];
  const result = plan(recorded.state, last);
  expect(result.commands).toMatchObject([{ kind: 'apply-inventory-observation' }]);
  f.controller.dispose();
});

it('marks a ready preview stale when the target changes and permits read-only preview only', async () => {
  const f = fixture();
  const rendered = render(<InventoryStocktakeForm {...f.props} />);
  await source();
  await resolve();
  const latest = data({ ...f.props.data.state, revision: f.props.data.state.revision + 1 });
  rendered.rerender(
    <InventoryStocktakeForm {...f.props} data={latest} status={{ kind: 'ready', data: latest }} />
  );
  expect(screen.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'stale'
  );
  expect(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  ).toBeDisabled();
  rendered.unmount();
  f.controller.dispose();
  const readOnly = fixture(state(), true);
  render(<InventoryStocktakeForm {...readOnly.props} />);
  await source();
  await resolve();
  expect(screen.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  expect(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  ).toBeDisabled();
  readOnly.controller.dispose();
});

it('requires a skip reason and removes mappings used only by skipped observations', async () => {
  const f = fixture();
  render(<InventoryStocktakeForm {...f.props} />);
  await source();
  choose('Subject for sample', /^Stock: Tube/);
  choose('Decision for 0001', 'Skip with reason');
  await inspect();
  expect(screen.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  fireEvent.change(screen.getByLabelText('Skip reason for observation 0001'), {
    target: { value: 'Not a current physical observation' },
  });
  await inspect();
  expect(screen.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  expect(f.client.previewStocktake.mock.calls.at(-1)![0].options.subjects).toEqual([]);
  expect(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  ).toBeDisabled();
  f.controller.dispose();
});

it('retains exact file source bytes and restores the same preview after picker cancellation', async () => {
  const f = fixture();
  const fileSource = sourceText.replaceAll('\n', '\r\n');
  native.dialog.open.mockResolvedValueOnce('/synthetic/stocktake.csv').mockResolvedValueOnce(null);
  native.fs.readFileBounded.mockResolvedValueOnce(new TextEncoder().encode(fileSource));
  render(<InventoryStocktakeForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Stocktake source namespace'), {
    target: { value: 'stocktake-register' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Choose stocktake file', exact: true }));
  await screen.findByText('Source file: /synthetic/stocktake.csv');
  expect(native.fs.readFileBounded).toHaveBeenCalledWith(
    '/synthetic/stocktake.csv',
    17 * 1024 * 1024
  );
  await inspect();
  await resolve();
  expect(f.client.previewStocktake.mock.calls.at(-1)![0].sourceText).toBe(fileSource);
  const digest = screen.getByTestId('inventory-stocktake-preview').getAttribute('data-plan-digest');
  fireEvent.click(screen.getByRole('button', { name: 'Choose stocktake file', exact: true }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-stocktake-import')).toHaveAttribute(
      'data-preview-state',
      'ready'
    )
  );
  expect(screen.getByTestId('inventory-stocktake-preview')).toHaveAttribute(
    'data-plan-digest',
    digest
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  );
  await waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
  expect(f.apply.mock.calls[0][0]).toBe(fileSource);
  f.controller.dispose();
});

it('ignores a late preview after unmount and refuses a response for another scope', async () => {
  const f = fixture();
  const pending = deferred<InventoryStocktakePreviewSnapshot>();
  f.client.previewStocktake.mockReturnValueOnce(pending.promise);
  const rendered = render(<InventoryStocktakeForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Stocktake source namespace'), {
    target: { value: 'stocktake-register' },
  });
  fireEvent.change(screen.getByLabelText('Stocktake source text'), {
    target: { value: sourceText },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview stocktake', exact: true }));
  rendered.unmount();
  await act(async () =>
    pending.resolve(plan(f.props.data.state, { sourceText, options: recordChoices }))
  );
  expect(f.apply).not.toHaveBeenCalled();
  f.client.previewStocktake.mockImplementationOnce(async (request) => {
    const preview = plan(f.props.data.state, request);
    return { ...preview, target: { ...preview.target, projectId: 'other-project' } };
  });
  render(<InventoryStocktakeForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Stocktake source text'), {
    target: { value: sourceText },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview stocktake', exact: true }));
  await screen.findByText('The stocktake preview belongs to another project or inventory.');
  expect(
    screen.getByRole('button', { name: 'Record stocktake observations', exact: true })
  ).toBeDisabled();
  f.controller.dispose();
});
