import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  createInventoryState,
  inventoryStorageConditionsProjection,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryBenchlingCaptureSnapshot,
} from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryBenchlingCaptureForm } from './InventoryBenchlingCaptureForm';

const files = vi.hoisted(() => ({
  dialog: { open: vi.fn() },
  fs: { readFileBounded: vi.fn() },
}));
vi.mock('../../platform', () => ({ platform: () => files }));

const sourceText = '{"raw":"capture"}\n';
const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
const digest = `sha256:${'a'.repeat(64)}` as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function data(projectId = 'project', revision = 0): InventoryData {
  const state = { ...createInventoryState(), revision };
  return {
    project: {
      projectId,
      defaultInventoryId: `inventory:${projectId}`,
      name: `Project ${projectId}`,
      path: '/synthetic',
      pinned: true,
    },
    state,
    history: [],
    availability: null,
    storageConditions: {
      ...inventoryStorageConditionsProjection(state, { asOf: 100, freshnessMaxAgeMs: null }),
      projectId,
      inventoryId: `inventory:${projectId}`,
      revision,
      principal,
    },
  };
}

function inspected(namespace = 'benchling:synthetic'): InventoryBenchlingCaptureSnapshot {
  return {
    schema: 'dnaforge.inventory-benchling-capture-inspection.v1',
    kind: 'inspected',
    sourceSha256: digest,
    target: { projectId: 'project', inventoryId: 'inventory:project', present: false, revision: 0 },
    asOf: 100,
    principal,
    capture: {
      format: 'dnaforge.benchling-physical-capture.v1',
      apiVersion: 'v2',
      namespace,
      capturedAt: '2026-11-16T00:00:00Z',
      scope: {
        kind: 'selected-records',
        description: 'One selected tube; other inventory unknown',
      },
      sourceText,
      responses: [
        {
          id: 'tube-response',
          request: { method: 'GET', path: '/api/v2/containers/con_exact', query: {} },
          bodyText: '{"id":"con_exact","quantity":{"value":9007199254740993,"other":1.2300}}',
          bodySha256: digest,
          numberLexemes: [
            { pointer: '/quantity/value', lexeme: '9007199254740993' },
            { pointer: '/quantity/other', lexeme: '1.2300' },
          ],
        },
      ],
    },
    records: [
      {
        kind: 'container',
        sourceId: 'con_exact',
        observations: [{ responseId: 'tube-response', pointer: '' }],
        fields: {
          name: {
            kind: 'omitted',
            observations: [{ kind: 'omitted', responseId: 'tube-response', pointer: '/name' }],
          },
          parentStorageId: {
            kind: 'null',
            observations: [
              { kind: 'null', responseId: 'tube-response', pointer: '/parentStorageId' },
            ],
          },
          quantity: {
            kind: 'present',
            jsonText: '{"value":9007199254740993,"other":1.2300}',
            observations: [
              {
                kind: 'present',
                jsonText: '{"value":9007199254740993,"other":1.2300}',
                responseId: 'tube-response',
                pointer: '/quantity',
              },
            ],
          },
          contents: {
            kind: 'conflict',
            alternatives: [{ kind: 'null' }, { kind: 'present', jsonText: '[]' }],
            observations: [
              { kind: 'null', responseId: 'tube-response', pointer: '/contents' },
              {
                kind: 'present',
                jsonText: '[]',
                responseId: 'other-response',
                pointer: '/contents',
              },
            ],
          },
        },
      },
    ],
    placements: [],
    pagination: [
      {
        path: '/api/v2/boxes/box_a/contents',
        query: {},
        kind: 'incomplete',
        pages: [],
        linkedResponseIds: [],
        issues: [],
      },
    ],
    issues: [
      {
        severity: 'needs-resolution',
        code: 'CONTENTS_CONFLICT',
        pointer: '/responses/1',
        responseId: 'other-response',
        bodyPointer: '/contents',
        message: 'Contents have contradictory captured observations.',
      },
    ],
  };
}

function fixture() {
  const current = data();
  const client = {
    ...unavailableInventoryClient(),
    inspectBenchlingCapture: vi.fn(async () => inspected()),
    execute: vi.fn(),
    applyTable: vi.fn(),
    applyHierarchy: vi.fn(),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const props = {
    data: current,
    controller,
    status: { kind: 'ready' as const, data: current },
    client,
    onClose: vi.fn(),
  };
  return { props, client };
}

async function inspect(text = sourceText) {
  fireEvent.change(screen.getByLabelText('Benchling capture text'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Inspect capture', exact: true }));
  await screen.findByTestId('inventory-benchling-inspection');
}

it('inspects exact raw source with read access and distinguishes omitted, null, conflict and numeric tokens without mutation', async () => {
  const f = fixture();
  render(<InventoryBenchlingCaptureForm {...f.props} />);
  await inspect();
  expect(f.client.inspectBenchlingCapture).toHaveBeenCalledWith({
    project: 'project',
    inventoryId: 'inventory:project',
    sourceText,
  });
  expect(screen.getByTestId('inventory-benchling-source-scope')).toHaveTextContent('Benchling v2');
  expect(screen.getByTestId('inventory-benchling-source-scope')).toHaveTextContent(
    'selected-records'
  );
  expect(screen.getByTestId('inventory-benchling-records')).toHaveTextContent('con_exact');
  expect(
    screen
      .getByTestId('inventory-benchling-records')
      .querySelector('[data-source-field="name"] [data-field-state="omitted"]')
  ).toBeInTheDocument();
  expect(
    screen
      .getByTestId('inventory-benchling-records')
      .querySelector('[data-source-field="parentStorageId"] [data-field-state="null"]')
  ).toBeInTheDocument();
  expect(
    screen
      .getByTestId('inventory-benchling-records')
      .querySelector('[data-source-field="contents"] [data-field-state="conflict"]')
  ).toBeInTheDocument();
  expect(screen.getByTestId('inventory-benchling-records')).toHaveTextContent('9007199254740993');
  expect(screen.getByTestId('inventory-benchling-number-tokens')).toHaveTextContent(
    '/quantity/other = 1.2300'
  );
  expect(screen.getByTestId('inventory-benchling-pagination')).toHaveTextContent('incomplete');
  expect(screen.getByTestId('inventory-benchling-issue')).toHaveTextContent('other-response');
  expect(screen.getByText(/do not change local custody/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /apply|import|receive/i })).not.toBeInTheDocument();
  expect(f.client.execute).not.toHaveBeenCalled();
  expect(f.client.applyTable).not.toHaveBeenCalled();
  expect(f.client.applyHierarchy).not.toHaveBeenCalled();
});

it('invalidates prior inspection immediately on source edits and ignores an older response arriving after the new response', async () => {
  const f = fixture();
  const old = deferred<InventoryBenchlingCaptureSnapshot>();
  f.client.inspectBenchlingCapture.mockImplementationOnce(() => old.promise);
  render(<InventoryBenchlingCaptureForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Benchling capture text'), { target: { value: 'old' } });
  fireEvent.click(screen.getByRole('button', { name: 'Inspect capture', exact: true }));
  await inspect('new');
  expect(screen.getByTestId('inventory-benchling-source-scope')).toHaveTextContent(
    'benchling:synthetic'
  );
  await act(async () => old.resolve(inspected('benchling:obsolete')));
  expect(screen.getByTestId('inventory-benchling-source-scope')).not.toHaveTextContent(
    'benchling:obsolete'
  );
  fireEvent.change(screen.getByLabelText('Benchling capture text'), {
    target: { value: 'edited' },
  });
  expect(screen.queryByTestId('inventory-benchling-inspection')).not.toBeInTheDocument();
  expect(screen.getByTestId('inventory-benchling-capture')).toHaveAttribute(
    'data-inspection-state',
    'editing'
  );
});

it('drops pending results and previous source when the project scope changes', async () => {
  const f = fixture();
  const pending = deferred<InventoryBenchlingCaptureSnapshot>();
  f.client.inspectBenchlingCapture.mockImplementationOnce(() => pending.promise);
  const view = render(<InventoryBenchlingCaptureForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Benchling capture text'), {
    target: { value: sourceText },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Inspect capture', exact: true }));
  const next = data('other-project');
  view.rerender(
    <InventoryBenchlingCaptureForm
      {...f.props}
      data={next}
      status={{ kind: 'ready', data: next }}
    />
  );
  expect(screen.getByLabelText('Benchling capture text')).toHaveValue('');
  await act(async () => pending.resolve(inspected()));
  expect(screen.queryByTestId('inventory-benchling-inspection')).not.toBeInTheDocument();
});

it('discards a pending result on unmount rather than restoring it in a new dialog', async () => {
  const f = fixture();
  const pending = deferred<InventoryBenchlingCaptureSnapshot>();
  f.client.inspectBenchlingCapture.mockImplementationOnce(() => pending.promise);
  const first = render(<InventoryBenchlingCaptureForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect capture', exact: true }));
  first.unmount();
  render(<InventoryBenchlingCaptureForm {...f.props} />);
  await act(async () => pending.resolve(inspected()));
  expect(screen.queryByTestId('inventory-benchling-inspection')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Benchling capture text')).toHaveValue('');
});

it('discloses a changed inventory revision while retaining read-only source observations', async () => {
  const f = fixture();
  const view = render(<InventoryBenchlingCaptureForm {...f.props} />);
  await inspect();
  const next = data('project', 1);
  view.rerender(
    <InventoryBenchlingCaptureForm
      {...f.props}
      data={next}
      status={{ kind: 'ready', data: next }}
    />
  );
  expect(screen.getByTestId('inventory-benchling-revision-notice')).toHaveTextContent(
    'Inventory changed since this inspection'
  );
  expect(screen.getByTestId('inventory-benchling-records')).toHaveTextContent('con_exact');
  expect(f.client.inspectBenchlingCapture).toHaveBeenCalledTimes(1);
  expect(f.client.execute).not.toHaveBeenCalled();
});

it('shows source refusal and transport errors without presenting successful import', async () => {
  const f = fixture();
  f.client.inspectBenchlingCapture.mockResolvedValueOnce({
    ...inspected(),
    kind: 'blocked',
    capture: null,
    records: [],
    pagination: [],
    issues: [
      {
        severity: 'invalid',
        code: 'INVALID_CAPTURE_JSON',
        pointer: '/sourceText',
        responseId: null,
        bodyPointer: null,
        message: 'Duplicate response key is invalid.',
      },
    ],
  });
  render(<InventoryBenchlingCaptureForm {...f.props} />);
  await inspect('invalid');
  expect(screen.getByText('Capture could not be interpreted')).toBeInTheDocument();
  expect(screen.getByTestId('inventory-benchling-issue')).toHaveTextContent(
    'Duplicate response key'
  );
  f.client.inspectBenchlingCapture.mockRejectedValueOnce(
    new Error('Native inspection unavailable')
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect capture', exact: true }));
  await screen.findByText('Native inspection unavailable');
  expect(screen.queryByTestId('inventory-benchling-inspection')).not.toBeInTheDocument();
  expect(screen.queryByText(/import succeeded/i)).not.toBeInTheDocument();
});

it('refuses a response belonging to a different inventory', async () => {
  const f = fixture();
  f.client.inspectBenchlingCapture.mockResolvedValueOnce({
    ...inspected(),
    target: { ...inspected().target, inventoryId: 'other' },
  });
  render(<InventoryBenchlingCaptureForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect capture', exact: true }));
  await screen.findByText('The capture inspection belongs to another project or inventory.');
  expect(screen.queryByTestId('inventory-benchling-inspection')).not.toBeInTheDocument();
});

it('reads bounded exact UTF-8 bytes and preserves the inspected source when file choice is canceled', async () => {
  const f = fixture();
  const raw = sourceText.replaceAll('\n', '\r\n');
  files.dialog.open.mockResolvedValueOnce('/synthetic/capture.json').mockResolvedValueOnce(null);
  files.fs.readFileBounded.mockResolvedValueOnce(new TextEncoder().encode(raw));
  render(<InventoryBenchlingCaptureForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose capture file' }));
  await screen.findByTestId('inventory-benchling-source-path');
  expect(screen.getByLabelText('Benchling capture text')).toHaveValue(sourceText);
  expect(files.fs.readFileBounded).toHaveBeenCalledWith(
    '/synthetic/capture.json',
    17 * 1024 * 1024
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect capture', exact: true }));
  await screen.findByTestId('inventory-benchling-inspection');
  expect(f.client.inspectBenchlingCapture).toHaveBeenCalledWith(
    expect.objectContaining({ sourceText: raw })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose capture file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-benchling-capture')).toHaveAttribute(
      'data-inspection-state',
      'inspected'
    )
  );
  expect(screen.getByLabelText('Benchling capture text')).toHaveValue(sourceText);
});

it('rejects malformed file UTF-8 and ignores a file read superseded by a source edit', async () => {
  const f = fixture();
  files.dialog.open.mockResolvedValue('/synthetic/capture.json');
  files.fs.readFileBounded.mockResolvedValueOnce(new Uint8Array([0xc3, 0x28]));
  render(<InventoryBenchlingCaptureForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose capture file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-benchling-capture')).toHaveAttribute(
      'data-inspection-state',
      'failed'
    )
  );
  expect(f.client.inspectBenchlingCapture).not.toHaveBeenCalled();
  const pending = deferred<Uint8Array>();
  files.fs.readFileBounded.mockImplementationOnce(() => pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Choose capture file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-benchling-capture')).toHaveAttribute(
      'data-inspection-state',
      'reading-source'
    )
  );
  fireEvent.change(screen.getByLabelText('Benchling capture text'), {
    target: { value: 'new source' },
  });
  await act(async () => pending.resolve(new TextEncoder().encode('obsolete file')));
  expect(screen.getByLabelText('Benchling capture text')).toHaveValue('new source');
  expect(screen.queryByTestId('inventory-benchling-source-path')).not.toBeInTheDocument();
});
