import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  createInventoryState,
  inspectInventoryBenchlingCapture,
  inventoryBenchlingCapturePreview,
  inventoryStorageConditionsProjection,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryBenchlingCaptureSnapshot,
} from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryBenchlingApplicationForm } from './InventoryBenchlingApplicationForm';
const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const sourceText = JSON.stringify({
  format: 'dnaforge.benchling-physical-capture.v1',
  apiVersion: 'v2',
  namespace: 'test:capture',
  capturedAt: '2026-11-16T00:00:00.000Z',
  scope: { kind: 'selected-records', description: 'One synthetic tube' },
  responses: [
    {
      id: 'tube-response',
      request: { method: 'GET', path: '/api/v2/containers/tube', query: {} },
      bodyText: '{"id":"tube","name":"Captured tube","parentStorageId":null}',
    },
  ],
});
const maxBytes = 17 * 1024 * 1024;
function fixture(pinned = false) {
  const state = createInventoryState();
  const data: InventoryData = {
    project: {
      projectId: 'project',
      defaultInventoryId: 'inventory',
      name: 'Destination',
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
      revision: 0,
      principal,
    },
  };
  const target = { projectId: 'project', inventoryId: 'inventory', present: false, revision: 0 };
  const inspection: InventoryBenchlingCaptureSnapshot = {
    ...inspectInventoryBenchlingCapture(sourceText, maxBytes),
    target,
    asOf: 100,
    principal,
  };
  const client = {
    ...unavailableInventoryClient(),
    materials: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })),
    previewBenchlingCapture: vi.fn(async (request) => ({
      ...inventoryBenchlingCapturePreview(null, {
        ...request,
        target,
        bindings: [],
        asOf: 100,
        principal,
        authority: { kind: 'local-profile', profileKey: principal.profileKey },
        maxBytes,
      }),
      asOf: 100,
      principal,
    })),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const apply = vi.spyOn(controller, 'importBenchlingCapture').mockResolvedValue(null);
  return {
    data,
    controller,
    client,
    apply,
    props: {
      data,
      controller,
      client,
      inspection,
      sourceText,
      status: { kind: 'ready' as const, data },
      onClose: vi.fn(),
    },
  };
}
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}
function fillDraft() {
  fireEvent.change(screen.getByLabelText('Selected-record scope reason'), {
    target: { value: 'Explicit selected-record capture' },
  });
  fireEvent.click(screen.getByText('container · tube · Choose disposition'));
  choose('Disposition for tube', 'Import physical record');
  fireEvent.click(screen.getByRole('button', { name: 'Copy unique captured facts for tube' }));
  choose('Physical target for tube', 'Movable container');
  choose('Placement for tube', 'Explicitly unplaced');
  fireEvent.change(screen.getByLabelText('Placement reason for tube'), {
    target: { value: 'No trusted physical location established' },
  });
  choose('Contents for tube', 'Contents not established');
  fireEvent.change(screen.getByLabelText('Contents reason for tube'), {
    target: { value: 'Contents omitted in capture' },
  });
}
async function preview() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview physical inventory' }));
  await waitFor(() =>
    expect(
      screen
        .getByTestId('inventory-benchling-application-preview')
        .getAttribute('data-preview-kind')
    ).toBe('ready')
  );
}
it('requires typed physical and contents decisions, then submits only the immutable ready proposal', async () => {
  const f = fixture();
  render(<InventoryBenchlingApplicationForm {...f.props} />);
  expect(
    screen.getByRole('button', { name: 'Import physical inventory' }).matches(':disabled')
  ).toBe(true);
  fillDraft();
  await preview();
  expect(f.client.previewBenchlingCapture).toHaveBeenCalledWith(
    expect.objectContaining({ project: 'project', inventoryId: 'inventory', sourceText })
  );
  expect(
    screen.getByRole('button', { name: 'Import physical inventory' }).matches(':disabled')
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Import physical inventory' }));
  expect(f.apply).toHaveBeenCalledWith(
    sourceText,
    expect.objectContaining({ resolvedTargets: expect.any(Array) }),
    expect.stringMatching(/^sha256:/)
  );
  fireEvent.change(screen.getByLabelText('Contents reason for tube'), {
    target: { value: 'Updated explicit interpretation' },
  });
  expect(screen.queryByTestId('inventory-benchling-application-preview')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Import physical inventory' }).matches(':disabled')
  ).toBe(true);
});
it('permits read-only preview while withholding application', async () => {
  const f = fixture(true);
  render(<InventoryBenchlingApplicationForm {...f.props} />);
  fillDraft();
  await preview();
  expect(
    screen.getByRole('button', { name: 'Import physical inventory' }).matches(':disabled')
  ).toBe(true);
  expect(f.apply).not.toHaveBeenCalled();
});
it('invalidates an old proposal when a different project or source scope arrives', async () => {
  const f = fixture();
  const view = render(<InventoryBenchlingApplicationForm {...f.props} />);
  fillDraft();
  await preview();
  const next = { ...f.data, project: { ...f.data.project, projectId: 'different' } };
  view.rerender(
    <InventoryBenchlingApplicationForm
      {...f.props}
      data={next}
      status={{ kind: 'ready', data: next }}
    />
  );
  expect(screen.queryByTestId('inventory-benchling-application-preview')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Import physical inventory' }).matches(':disabled')
  ).toBe(true);
});
it('locks the submitted request during uncertain acknowledgement and keeps the original recovery controller', async () => {
  const f = fixture();
  const view = render(<InventoryBenchlingApplicationForm {...f.props} />);
  fillDraft();
  await preview();
  view.rerender(
    <InventoryBenchlingApplicationForm
      {...f.props}
      status={{ ...f.props.status, kind: 'outcome-unknown', attempt: {} } as any}
    />
  );
  expect(
    screen.getByRole('button', { name: 'Preview physical inventory' }).matches(':disabled')
  ).toBe(true);
  expect(
    screen.getByRole('button', { name: 'Import physical inventory' }).matches(':disabled')
  ).toBe(true);
  expect(screen.getByLabelText('Contents reason for tube').matches(':disabled')).toBe(true);
});
