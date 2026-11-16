import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  createInventoryState,
  emptyInventoryPhysicalConfiguration,
  inventoryStorageConditionsProjection,
  type InventoryHierarchyChoices,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryHierarchyPreviewSnapshot,
} from '../../shared/inventory-client';
import {
  InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryHierarchyForm } from './InventoryHierarchyForm';

const native = vi.hoisted(() => ({ dialog: { open: vi.fn() }, fs: { readFileBounded: vi.fn() } }));
vi.mock('../../platform', () => ({ platform: () => native }));
const digest = `sha256:${'a'.repeat(64)}` as const;
const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
const sourceText =
  'source_id,name,layout_kind,positions,rows,columns,capacity,parent_kind,parent_key,slot\nplate,Plate,fixed-well,,2,3,,existing,shelf,A\n';
const options: InventoryHierarchyChoices = {
  namespace: 'source-locations',
  delimiter: ',',
  parents: [{ key: 'shelf', storageId: 'shelf' }],
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
function ready(): InventoryHierarchyPreviewSnapshot {
  return {
    schema: 'dnaforge.inventory-hierarchy-preview.v1',
    kind: 'ready',
    target: { projectId: 'project', inventoryId: 'inventory', present: false, revision: 0 },
    sourceSha256: digest,
    parentKeys: ['shelf'],
    rows: [
      {
        index: 2,
        sourceId: 'plate',
        fields: {
          source_id: 'plate',
          name: 'Plate',
          layout_kind: 'fixed-well',
          positions: '',
          rows: '2',
          columns: '3',
          capacity: '',
          parent_kind: 'existing',
          parent_key: 'shelf',
          slot: 'A',
        },
        kind: 'create',
        storageId: 'imported-plate',
        layout: { kind: 'fixed-well', rows: 2, columns: 3 },
        destination: { kind: 'located', storageId: 'shelf', slotId: 'A' },
        reason: null,
        issues: [],
      },
    ],
    issues: [],
    commands: [
      {
        kind: 'create-layout-storage',
        id: 'imported-plate',
        name: 'Plate',
        layout: { kind: 'fixed-well', rows: 2, columns: 3 },
        placement: { kind: 'located', storageId: 'shelf', slotId: 'A' },
      },
    ],
    bindingAdditions: {},
    options,
    planDigest: digest,
    asOf: 100,
    principal,
  };
}
function blocked(rows = ready().rows): InventoryHierarchyPreviewSnapshot {
  return {
    ...ready(),
    kind: 'blocked',
    rows: rows.map((row) => ({ ...row, kind: 'blocked' })),
    issues: [
      {
        code: 'PARENT_MISSING',
        pointer: '/options/parents',
        message: 'Choose an explicit parent.',
      },
    ],
    commands: [],
    bindingAdditions: {},
    options: null,
    planDigest: null,
  };
}
function fixture(pinned = false) {
  const state = createInventoryState();
  const initial = data(
    {
      ...state,
      storage: {
        shelf: {
          id: 'shelf',
          name: 'Existing shelf',
          placement: { kind: 'root' },
          layout: { kind: 'named', slots: ['A'] },
          lifecycle: 'active',
          custody: { kind: 'available' },
          configuration: emptyInventoryPhysicalConfiguration(),
        },
      },
    },
    pinned
  );
  const client = { ...unavailableInventoryClient(), previewHierarchy: vi.fn(async () => ready()) };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const importHierarchy = vi.spyOn(controller, 'importHierarchy').mockResolvedValue(null);
  const props = {
    data: initial,
    client,
    controller,
    status: { kind: 'ready' as const, data: initial } as InventoryControllerState,
    onClose: vi.fn(),
  };
  return { props, client, controller, importHierarchy };
}
async function preview(text = sourceText) {
  fireEvent.change(screen.getByLabelText('Hierarchy source namespace'), {
    target: { value: options.namespace },
  });
  fireEvent.change(screen.getByLabelText('Hierarchy table text'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview hierarchy' }));
  await screen.findByTestId('inventory-hierarchy-preview');
}
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
}

it('requires explicit parent choice and submits the exact hierarchy plan with owned permanent wells', async () => {
  const f = fixture();
  f.client.previewHierarchy.mockResolvedValueOnce(blocked());
  render(<InventoryHierarchyForm {...f.props} />);
  await preview();
  expect(screen.getByRole('button', { name: 'Import hierarchy' })).toBeDisabled();
  choose('Parent for shelf', 'Existing shelf · shelf');
  expect(screen.queryByTestId('inventory-hierarchy-preview')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview hierarchy' }));
  await screen.findByText('Ready to import the complete hierarchy');
  expect(f.client.previewHierarchy).toHaveBeenLastCalledWith({
    project: 'project',
    inventoryId: 'inventory',
    format: 'hierarchy-v1',
    sourceText,
    options,
  });
  expect(screen.getByTestId('inventory-hierarchy-rows')).toHaveTextContent(
    'Permanent-well plate: 2 rows × 3 columns'
  );
  expect(screen.getByRole('list', { name: 'Hierarchy command order' })).toHaveTextContent(
    'Create Plate'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Import hierarchy' }));
  expect(f.importHierarchy).toHaveBeenCalledWith(sourceText, options, digest);
});

it('invalidates a ready preview when namespace, delimiter or source changes', async () => {
  const f = fixture();
  render(<InventoryHierarchyForm {...f.props} />);
  await preview();
  fireEvent.change(screen.getByLabelText('Hierarchy source namespace'), {
    target: { value: 'revised' },
  });
  expect(screen.queryByTestId('inventory-hierarchy-preview')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview hierarchy' }));
  await screen.findByText('Ready to import the complete hierarchy');
  choose('Hierarchy delimiter', 'TSV (tab)');
  expect(screen.queryByTestId('inventory-hierarchy-preview')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Hierarchy table text'), {
    target: { value: 'changed source' },
  });
  expect(screen.getByRole('button', { name: 'Import hierarchy' })).toBeDisabled();
  expect(f.importHierarchy).not.toHaveBeenCalled();
});

it('shows explicit push order instead of presenting input order as stack order', async () => {
  const f = fixture();
  const plan = ready();
  if (plan.kind !== 'ready') throw new Error('Expected ready fixture');
  f.client.previewHierarchy.mockResolvedValueOnce({
    ...plan,
    rows: [
      {
        ...plan.rows[0],
        sourceId: 'top',
        storageId: 'top',
        fields: { ...plan.rows[0].fields!, name: 'Top plate' },
      },
      {
        ...plan.rows[0],
        index: 3,
        sourceId: 'bottom',
        storageId: 'bottom',
        fields: { ...plan.rows[0].fields!, name: 'Bottom plate' },
      },
    ],
    commands: [
      { kind: 'push-stack', item: { kind: 'storage', id: 'bottom' }, stackId: 'stack' },
      { kind: 'push-stack', item: { kind: 'storage', id: 'top' }, stackId: 'stack' },
    ],
  });
  render(<InventoryHierarchyForm {...f.props} />);
  await preview();
  expect(screen.getByRole('list', { name: 'Hierarchy command order' }).textContent).toMatch(
    /Push Bottom plate[\s\S]*Push Top plate/
  );
  expect(screen.getByText(/No automatic splitting occurs/)).toBeInTheDocument();
});

it('preserves read-only comparison and marks a changed target stale', async () => {
  const f = fixture(true);
  const view = render(<InventoryHierarchyForm {...f.props} />);
  await preview();
  expect(screen.getByRole('button', { name: 'Import hierarchy' })).toBeDisabled();
  const next = data({ ...f.props.data.state, revision: 1 }, true);
  view.rerender(
    <InventoryHierarchyForm {...f.props} data={next} status={{ kind: 'ready', data: next }} />
  );
  expect(screen.getByTestId('inventory-hierarchy-import')).toHaveAttribute(
    'data-preview-state',
    'stale'
  );
  expect(f.importHierarchy).not.toHaveBeenCalled();
});

it('keeps invalid skip controls while clearing a prior create plan and unused parent mapping', async () => {
  const f = fixture();
  render(<InventoryHierarchyForm {...f.props} />);
  await preview();
  choose('Parent for shelf', 'Existing shelf · shelf');
  fireEvent.click(screen.getByLabelText('Skip hierarchy source plate'));
  f.client.previewHierarchy.mockResolvedValueOnce(blocked([]));
  fireEvent.click(screen.getByRole('button', { name: 'Preview hierarchy' }));
  await screen.findByText('Resolve the hierarchy before importing');
  expect(screen.getByLabelText('Skip reason for hierarchy source plate')).toBeVisible();
  expect(screen.queryByText('Permanent-well plate: 2 rows × 3 columns')).not.toBeInTheDocument();
  expect(screen.queryByText('Physical identity')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Skip reason for hierarchy source plate'), {
    target: { value: 'Excluded until layout is confirmed' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview hierarchy' }));
  await waitFor(() => expect(f.client.previewHierarchy).toHaveBeenCalledTimes(3));
  expect(f.client.previewHierarchy.mock.calls[2][0].options).toMatchObject({
    parents: [],
    skips: [{ sourceId: 'plate', reason: 'Excluded until layout is confirmed' }],
  });
});

it('restores canceled file selection and retains exact CRLF file text with strict decoding', async () => {
  const f = fixture();
  render(<InventoryHierarchyForm {...f.props} />);
  await preview();
  native.dialog.open.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: 'Choose hierarchy file' }));
  await screen.findByText('Ready to import the complete hierarchy');
  expect(screen.getByLabelText('Hierarchy table text')).toHaveValue(sourceText);
  const raw = sourceText.replaceAll('\n', '\r\n');
  native.dialog.open.mockResolvedValueOnce('/synthetic/tree.csv');
  native.fs.readFileBounded.mockResolvedValueOnce(new TextEncoder().encode(raw));
  fireEvent.click(screen.getByRole('button', { name: 'Choose hierarchy file' }));
  await screen.findByText('Source file: /synthetic/tree.csv');
  fireEvent.click(screen.getByRole('button', { name: 'Preview hierarchy' }));
  await waitFor(() => expect(f.client.previewHierarchy).toHaveBeenCalledTimes(2));
  expect(f.client.previewHierarchy.mock.calls[1][0].sourceText).toBe(raw);
  native.dialog.open.mockResolvedValueOnce('/synthetic/invalid.csv');
  native.fs.readFileBounded.mockResolvedValueOnce(Uint8Array.from([0xc3, 0x28]));
  fireEvent.click(screen.getByRole('button', { name: 'Choose hierarchy file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-hierarchy-import')).toHaveAttribute(
      'data-preview-state',
      'failed'
    )
  );
  expect(screen.getByLabelText('Hierarchy table text')).toHaveValue(sourceText);
});

it('fences late previews after unmount and rejects a response for another scope', async () => {
  const f = fixture();
  const pending = deferred<InventoryHierarchyPreviewSnapshot>();
  f.client.previewHierarchy.mockReturnValueOnce(pending.promise);
  const view = render(<InventoryHierarchyForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Hierarchy table text'), {
    target: { value: sourceText },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview hierarchy' }));
  view.unmount();
  await act(async () => pending.resolve(ready()));
  expect(f.importHierarchy).not.toHaveBeenCalled();
  f.client.previewHierarchy.mockResolvedValueOnce({
    ...ready(),
    target: { ...ready().target, inventoryId: 'other' },
  });
  render(<InventoryHierarchyForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Hierarchy table text'), {
    target: { value: sourceText },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview hierarchy' }));
  await screen.findByText('The hierarchy preview belongs to another project or inventory.');
  expect(screen.getByRole('button', { name: 'Import hierarchy' })).toBeDisabled();
});

it('locks retained hierarchy intent while the command outcome is unknown', async () => {
  const f = fixture();
  const status: InventoryControllerState = {
    kind: 'outcome-unknown',
    data: f.props.data,
    message: 'Outcome unknown',
    attempt: {
      summary: 'Import hierarchy',
      request: {
        kind: 'import-hierarchy',
        project: 'project',
        inventoryId: 'inventory',
        operationId: 'original',
        expectedRevision: 0,
        sourceText,
        options,
        expectedPlanDigest: digest,
      },
    },
  };
  render(<InventoryHierarchyForm {...f.props} status={status} />);
  expect(screen.getByLabelText('Hierarchy table text')).toHaveValue(sourceText);
  expect(screen.getByLabelText('Hierarchy table text')).toBeDisabled();
  expect(screen.getByLabelText('Hierarchy source namespace')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Preview hierarchy' })).toBeDisabled();
  expect(f.importHierarchy).not.toHaveBeenCalled();
});
