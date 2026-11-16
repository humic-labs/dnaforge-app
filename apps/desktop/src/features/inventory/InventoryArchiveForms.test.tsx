import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryStorageConditionsProjection,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryImportPreviewSnapshot,
} from '../../shared/inventory-client';
import type { InventoryApplyImportRequest } from '../../shared/inventory-command';
import {
  InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryArchiveExportForm, InventoryArchiveImportForm } from './InventoryArchiveForms';
import { inventoryReservationOwner } from './InventoryReservations';

const output = vi.hoisted(() => ({
  dialog: { save: vi.fn(), open: vi.fn() },
  fs: { writeTextFileAtomic: vi.fn(), readTextFile: vi.fn(), readFileBounded: vi.fn() },
}));
vi.mock('../../platform', () => ({ platform: () => output }));

const digest = `sha256:${'a'.repeat(64)}` as const;
const fingerprint = `sha256:${'b'.repeat(64)}` as const;
const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
const sourceText = '{"source":"native fixture"}\n';
const resolved = {
  bindings: [
    {
      sourceMaterialId: 'source-material',
      destinationMaterialId: 'destination-material',
      fingerprint,
    },
  ],
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

function ready(): InventoryImportPreviewSnapshot {
  return {
    schema: 'dnaforge.inventory-import-preview.v1',
    kind: 'ready',
    sourceSha256: digest,
    target: { projectId: 'project', inventoryId: 'inventory', present: false, revision: 0 },
    source: {
      projectId: 'source-project',
      inventoryId: 'source-inventory',
      revision: 5,
      storedSchema: 'dnaforge.inventory.v12',
    },
    sourceRecordedAt: 50,
    sourceHistoryEntries: 5,
    scientificReferences: [],
    bindings: [],
    records: [{ kind: 'storage', ids: ['source-location'] }],
    responsibilities: { activeReservationIds: [], unavailableItems: [] },
    issues: [],
    planDigest: digest,
    options: { bindings: [] },
    asOf: 100,
    principal,
  };
}

function missingBinding(): InventoryImportPreviewSnapshot {
  return {
    ...ready(),
    kind: 'blocked',
    scientificReferences: [
      { materialId: 'source-material', pointers: ['/stocks/stock/materialId'] },
    ],
    records: [{ kind: 'stocks', ids: ['stock'] }],
    issues: [
      {
        code: 'MATERIAL_BINDING_MISSING',
        pointer: '/content/scientificReferences/0/materialId',
        message: 'Choose an explicit destination scientific record.',
      },
    ],
    planDigest: null,
    options: null,
  };
}

function fixture(pinned = false) {
  const current = data(createInventoryState(), pinned);
  const client = {
    ...unavailableInventoryClient(),
    materials: vi.fn(async () => ({
      items: [
        {
          id: 'destination-material',
          name: 'Destination material',
          kind: 'sequence',
          registryId: null,
        },
        { id: 'other-material', name: 'Other material', kind: 'sequence', registryId: null },
      ],
      nextCursor: null,
    })),
    previewImport: vi.fn(async () => ready()),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const adopt = vi.spyOn(controller, 'adoptArchive').mockResolvedValue(null);
  const dismiss = vi.spyOn(controller, 'dismiss');
  const props = {
    data: current,
    controller,
    client,
    status: { kind: 'ready' as const, data: current },
    onClose: vi.fn(),
  };
  return { props, client, controller, adopt, dismiss };
}

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
}

async function preview(text = sourceText) {
  fireEvent.change(screen.getByLabelText('Native inventory archive text'), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview archive import' }));
  await screen.findByTestId('inventory-import-preview');
}

it('reads chosen archive bytes with strict UTF-8 without normalizing source line endings', async () => {
  const f = fixture();
  const raw = sourceText.replaceAll('\n', '\r\n');
  output.dialog.open.mockResolvedValue('/synthetic/archive.json');
  output.fs.readFileBounded.mockResolvedValue(new TextEncoder().encode(raw));
  render(<InventoryArchiveImportForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose archive file' }));
  await screen.findByTestId('inventory-import-source-path');
  fireEvent.click(screen.getByRole('button', { name: 'Preview archive import' }));
  await waitFor(() =>
    expect(f.client.previewImport).toHaveBeenCalledWith(
      expect.objectContaining({ sourceText: raw })
    )
  );
  expect(output.fs.readFileBounded).toHaveBeenCalledWith(
    '/synthetic/archive.json',
    17 * 1024 * 1024
  );
});

it('retains the prior reviewed source when file choice is canceled', async () => {
  const f = fixture();
  output.dialog.open.mockResolvedValue(null);
  render(<InventoryArchiveImportForm {...f.props} />);
  await preview();
  fireEvent.click(screen.getByRole('button', { name: 'Choose archive file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-archive-import')).toHaveAttribute(
      'data-preview-state',
      'ready'
    )
  );
  expect(screen.getByLabelText('Native inventory archive text')).toHaveValue(sourceText);
  expect(screen.getByRole('button', { name: 'Adopt archived inventory' })).toBeEnabled();
});

it('refuses malformed UTF-8 before sending any preview or adoption', async () => {
  const f = fixture();
  output.dialog.open.mockResolvedValue('/synthetic/invalid.json');
  output.fs.readFileBounded.mockResolvedValue(new Uint8Array([0xc3, 0x28]));
  render(<InventoryArchiveImportForm {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose archive file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-archive-import')).toHaveAttribute(
      'data-preview-state',
      'failed'
    )
  );
  expect(f.client.previewImport).not.toHaveBeenCalled();
  expect(f.adopt).not.toHaveBeenCalled();
});

it('lets a read-only project preview an archive while preventing adoption', async () => {
  const f = fixture(true);
  render(<InventoryArchiveImportForm {...f.props} />);
  await preview();
  expect(f.client.previewImport).toHaveBeenCalledWith({
    project: 'project',
    inventoryId: 'inventory',
    sourceText,
    options: { bindings: [] },
  });
  expect(screen.getByTestId('inventory-archive-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  const apply = screen.getByRole('button', { name: 'Adopt archived inventory' });
  expect(apply).toBeDisabled();
  fireEvent.submit(apply.closest('form')!);
  expect(f.adopt).not.toHaveBeenCalled();
});

it('invalidates previews on binding or source edits and sends only the resolved reviewed plan', async () => {
  const f = fixture();
  f.client.previewImport.mockResolvedValueOnce(missingBinding());
  render(<InventoryArchiveImportForm {...f.props} />);
  await preview();
  expect(screen.getByTestId('inventory-archive-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  expect(screen.getByTestId('inventory-import-issue')).toHaveTextContent(
    '/content/scientificReferences/0/materialId'
  );
  await waitFor(() => expect(f.client.materials).toHaveBeenCalled());
  choose(
    'Destination scientific record for source-material',
    'Destination material · destination-material'
  );
  expect(screen.queryByTestId('inventory-import-preview')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Adopt archived inventory' })).toBeDisabled();
  f.client.previewImport.mockResolvedValueOnce({
    ...ready(),
    scientificReferences: missingBinding().scientificReferences,
    options: resolved,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview archive import' }));
  await screen.findByText('Ready for explicit adoption');
  expect(f.client.previewImport).toHaveBeenLastCalledWith({
    project: 'project',
    inventoryId: 'inventory',
    sourceText,
    options: {
      bindings: [
        { sourceMaterialId: 'source-material', destinationMaterialId: 'destination-material' },
      ],
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Adopt archived inventory' }));
  expect(f.adopt).toHaveBeenCalledWith(sourceText, resolved, digest);
  choose('Destination scientific record for source-material', 'Other material · other-material');
  expect(screen.queryByTestId('inventory-import-preview')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Adopt archived inventory' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Native inventory archive text'), {
    target: { value: 'different source' },
  });
  expect(screen.queryByTestId('inventory-import-bindings')).not.toBeInTheDocument();
  expect(screen.getByTestId('inventory-archive-import')).toHaveAttribute(
    'data-preview-state',
    'editing'
  );
});

it('does not let a late preview replace a source edited while the read was pending', async () => {
  const f = fixture();
  const pending = deferred<InventoryImportPreviewSnapshot>();
  f.client.previewImport.mockReturnValueOnce(pending.promise);
  render(<InventoryArchiveImportForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Native inventory archive text'), {
    target: { value: 'first source' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview archive import' }));
  expect(screen.getByTestId('inventory-archive-import')).toHaveAttribute(
    'data-preview-state',
    'previewing'
  );
  fireEvent.change(screen.getByLabelText('Native inventory archive text'), {
    target: { value: 'second source' },
  });
  await act(async () => {
    pending.resolve(missingBinding());
    await pending.promise;
  });
  expect(screen.getByLabelText('Native inventory archive text')).toHaveValue('second source');
  expect(screen.queryByTestId('inventory-import-preview')).not.toBeInTheDocument();
  expect(screen.queryByTestId('inventory-import-bindings')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Adopt archived inventory' })).toBeDisabled();
});

it('marks a reviewed plan stale when the target revision changes', async () => {
  const f = fixture();
  const view = render(<InventoryArchiveImportForm {...f.props} />);
  await preview();
  expect(screen.getByRole('button', { name: 'Adopt archived inventory' })).toBeEnabled();
  const changed = applyInventoryCommandBatch(createInventoryState(), {
    expectedRevision: 0,
    commands: [
      {
        kind: 'create-vessel',
        id: 'new',
        name: 'New destination record',
        placement: { kind: 'unplaced' },
      },
    ],
  });
  if (!changed.ok) throw new Error(changed.message);
  const latest = data(changed.state);
  view.rerender(
    <InventoryArchiveImportForm
      {...f.props}
      data={latest}
      status={{ kind: 'ready', data: latest }}
    />
  );
  expect(screen.getByTestId('inventory-archive-import')).toHaveAttribute(
    'data-preview-state',
    'stale'
  );
  expect(screen.getByText('Stale preview')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Adopt archived inventory' })).toBeDisabled();
  expect(f.adopt).not.toHaveBeenCalled();
});

it('rejects a mismatched target response and shows a native refusal without enabling apply', async () => {
  const f = fixture();
  f.client.previewImport.mockResolvedValueOnce({
    ...ready(),
    target: { ...ready().target, projectId: 'other-project' },
  });
  render(<InventoryArchiveImportForm {...f.props} />);
  fireEvent.change(screen.getByLabelText('Native inventory archive text'), {
    target: { value: sourceText },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview archive import' }));
  await screen.findByText('The preview belongs to another project or inventory.');
  expect(screen.getByRole('button', { name: 'Adopt archived inventory' })).toBeDisabled();
  f.client.previewImport.mockRejectedValueOnce(
    new Error('Current project read authority was refused')
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview archive import' }));
  await screen.findByText('Current project read authority was refused');
  expect(f.adopt).not.toHaveBeenCalled();
});

it('keeps an uncertain adoption payload locked while the existing recovery controls remain visible', () => {
  const f = fixture();
  const request: InventoryApplyImportRequest = {
    kind: 'adopt-archive',
    project: 'project',
    inventoryId: 'inventory',
    operationId: 'original',
    expectedRevision: 0,
    sourceText,
    options: resolved,
    expectedPlanDigest: digest,
  };
  const status: InventoryControllerState = {
    kind: 'outcome-unknown',
    data: f.props.data,
    attempt: { request, summary: 'Adopt inventory archive' },
    message: 'Original adoption outcome remains unknown.',
  };
  render(<InventoryArchiveImportForm {...f.props} status={status} />);
  expect(screen.getByLabelText('Native inventory archive text')).toHaveValue(sourceText);
  expect(screen.getByLabelText('Native inventory archive text')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Preview archive import' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Adopt archived inventory' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Check status' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Retry same change' })).toBeEnabled();
  expect(f.client.previewImport).not.toHaveBeenCalled();
  expect(f.adopt).not.toHaveBeenCalled();
});

it('captures and saves exact archive text from a read-only export surface', async () => {
  const f = fixture(true);
  const artifact = {
    schema: 'dnaforge.inventory-export-artifact.v1' as const,
    source: ready().source!,
    sourceText,
    sourceSha256: digest,
    contentSha256: fingerprint,
    asOf: 100,
    principal,
  };
  const exportSnapshot = vi.fn(async () => ({
    ...artifact,
    source: { ...artifact.source, projectId: 'project', inventoryId: 'inventory', revision: 0 },
  }));
  const controller = new InventoryController(
    { ...f.client, exportSnapshot },
    { read: () => [], write: () => {} }
  );
  output.dialog.save.mockResolvedValueOnce('/synthetic/archive.json');
  output.fs.writeTextFileAtomic.mockResolvedValueOnce(undefined);
  output.fs.readFileBounded.mockResolvedValueOnce(new TextEncoder().encode(sourceText));
  render(<InventoryArchiveExportForm {...f.props} controller={controller} />);
  fireEvent.click(screen.getByRole('button', { name: 'Capture inventory archive' }));
  await screen.findByTestId('inventory-archive-captured');
  expect(exportSnapshot).toHaveBeenCalledWith({
    project: 'project',
    inventoryId: 'inventory',
    format: 'native-v1',
  });
  expect(output.dialog.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save archive file' }));
  await waitFor(() =>
    expect(screen.getByTestId('inventory-archive-export')).toHaveAttribute(
      'data-output-state',
      'exported'
    )
  );
  expect(output.fs.writeTextFileAtomic).toHaveBeenCalledWith({
    path: '/synthetic/archive.json',
    content: sourceText,
  });
  expect(output.fs.readFileBounded).toHaveBeenCalledWith(
    '/synthetic/archive.json',
    17 * 1024 * 1024
  );
  expect(screen.getByTestId('inventory-archive-output-status')).toHaveTextContent(
    'Saved bytes match this archive.'
  );
  expect(f.adopt).not.toHaveBeenCalled();
  controller.dispose();
});

it('labels an imported same-ID holder as source attribution rather than the current agent', () => {
  const actor = { kind: 'agent' as const, identityId: 'same-agent' };
  const source = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'tube',
          materialId: 'source-material',
          quantity: { kind: 'known', value: '100', unit: 'uL' },
          quality: 'usable',
        },
        {
          kind: 'reserve-quantity',
          id: 'hold',
          stockId: 'stock',
          quantity: { value: '25', unit: 'uL' },
          deadline: null,
          purpose: 'Source reservation',
        },
      ],
    },
    { at: 1, principal: actor, authority: principal }
  );
  if (!source.ok) throw new Error(source.message);
  const adopted = adoptInventoryState(
    null,
    source.state,
    {
      source: {
        archiveSha256: digest,
        projectId: 'source-project',
        inventoryId: 'source-inventory',
        revision: source.state.revision,
      },
      materialBindings: { 'source-material': 'destination-material' },
    },
    { at: 2, principal, authority: principal }
  );
  if (!adopted.ok) throw new Error(adopted.message);
  const view = inventoryAvailability(adopted.state, actor, 2).reservations.hold;
  expect(view.mine).toBe(false);
  expect(inventoryReservationOwner(view)).toBe(
    'Imported agent same-agent · source-project / source-inventory'
  );
});
