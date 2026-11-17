import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createInventoryState,
  inventoryArrivalPreview,
  inventoryAvailability,
  inventoryStorageConditionsProjection,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryArrivalPreviewSnapshot,
  type InventoryPreviewArrivalRequest,
} from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryArrivalForm } from './InventoryArrivalForm';
import {
  InventoryArrivalSession,
  inventoryArrivalDraftInput,
  newArrivalComponent,
  newArrivalDocument,
  type InventoryArrivalDraft,
} from './inventory-arrival-session';

const scope = { project: 'project', inventoryId: 'inventory' };
const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const text = 'Original quantity: 1 mg\r\nSupplier QC: pass\r\n';
function draft(): InventoryArrivalDraft {
  return {
    namespace: 'test-arrivals',
    deliveryId: 'delivery-once',
    supplier: 'Supplier',
    supplierKind: 'known',
    observationReason: 'Physical delivery observed',
    scopeKind: 'selected-components',
    scopeReason: 'One observed component',
    documents: [
      {
        ...newArrivalDocument('document-1'),
        body: { encoding: 'utf8', value: text },
        coverage: 'excerpt',
        excerptReason: 'Exact certificate excerpt only',
      },
    ],
    claims: [],
    packageLabel: '',
    packagingBatch: '',
    components: [
      {
        ...newArrivalComponent('component-1'),
        label: 'Reagent',
        componentBatch: 'component-batch',
        materialId: 'material',
        lotName: 'Supplier lot',
        lotNumber: 'component-batch',
        managementReason: 'Begin local quality assessment',
        quantity: '1',
        quality: 'usable',
        quantityReason: 'Actual measurement',
        qualityReason: 'Local stock hold decision',
        vesselName: 'Delivery vial',
      },
    ],
  };
}
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}
function client() {
  const value = unavailableInventoryClient();
  value.materials = vi.fn(async () => ({
    items: [{ id: 'material', name: 'Material', kind: 'reagent', registryId: null }],
    nextCursor: null,
  }));
  value.previewArrival = vi.fn(async (input: InventoryPreviewArrivalRequest) => {
    const preview = inventoryArrivalPreview(createInventoryState(), {
      target: {
        projectId: scope.project,
        inventoryId: scope.inventoryId,
        present: true,
        revision: 0,
      },
      sourceText: input.sourceText,
      options: input.options,
      bindings: input.options.components
        .filter((c) => c.kind === 'identified')
        .map((c) => ({
          kind: 'admitted' as const,
          key: c.componentKey,
          materialId: c.kind === 'identified' ? c.materialId : '',
          fingerprint: `sha256:${'a'.repeat(64)}` as const,
        })),
      asOf: 100,
      principal,
      authority: principal,
      maxBytes: 17 * 1024 * 1024,
    });
    return { ...preview, asOf: 100, principal };
  });
  return value;
}
function data(): InventoryData {
  const state = createInventoryState();
  return {
    project: {
      projectId: scope.project,
      defaultInventoryId: scope.inventoryId,
      name: 'Project',
      path: '/synthetic',
      pinned: false,
    },
    state,
    history: [],
    availability: {
      ...inventoryAvailability(state, principal, 100),
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      revision: 0,
      asOf: 100,
      principal,
    },
    storageConditions: {
      ...inventoryStorageConditionsProjection(state, { asOf: 100, freshnessMaxAgeMs: null }),
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      revision: 0,
      principal,
    },
  };
}
function choose(label: string, option: string | RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it('retains exact document bytes and stable actual arrival identity across session reopen', async () => {
  const saved = storage(),
    native = client();
  const first = new InventoryArrivalSession(native, scope, saved);
  first.edit(draft());
  await first.preview();
  const snapshot = first.getSnapshot();
  expect(snapshot.phase).toBe('previewed');
  if (snapshot.phase !== 'previewed') throw Error('Preview required');
  expect(snapshot.preview.kind).toBe('ready');
  const source = JSON.parse(snapshot.input.sourceText);
  expect(source.documents[0].body.value).toBe(text);
  expect(source.claims).toEqual([]);
  expect(snapshot.input.options.components[0]).toMatchObject({
    kind: 'identified',
    quantity: { kind: 'known', value: '1', unit: 'mg' },
    quantityBasis: { kind: 'measurement', reason: 'Actual measurement' },
    stockQuality: { value: 'usable', reason: 'Local stock hold decision' },
    lot: { kind: 'new', managementReason: 'Begin local quality assessment' },
  });
  const reopened = new InventoryArrivalSession(native, scope, saved);
  expect(reopened.getSnapshot().draft).toEqual(draft());
  expect(reopened.getSnapshot().phase).toBe('editing');
});
it('keeps unsupported source activity as evidence and unknown stock in its explicit basis', () => {
  const source = draft();
  source.documents = [
    {
      ...source.documents[0],
      body: { encoding: 'utf8', value: '1000 U of assay-specific enzyme activity' },
    },
  ];
  source.components = [
    {
      ...source.components[0],
      quantityKind: 'unknown',
      unit: 'mg',
      quantityReason: 'Activity cannot establish mass',
    },
  ];
  const input = inventoryArrivalDraftInput(source);
  expect(input.options.components[0]).toMatchObject({
    quantity: { kind: 'unknown', unit: 'mg' },
    quantityBasis: { kind: 'unknown', reason: 'Activity cannot establish mass' },
  });
  expect(JSON.parse(input.sourceText).documents[0].body.value).toBe(source.documents[0].body.value);
});
it('requires explicit quality and physical evidence, with missing components creating no vessel choice', () => {
  const source = draft();
  source.components = [{ ...source.components[0], quality: '' }];
  expect(() => inventoryArrivalDraftInput(source)).toThrow(/quality explicitly/);
  source.components = [
    {
      ...source.components[0],
      disposition: 'observed-missing',
      vesselName: '',
      materialId: '',
      lotName: '',
      quantity: '',
      dispositionReason: 'Listed but physically missing',
    },
  ];
  expect(inventoryArrivalDraftInput(source).options.components[0]).toEqual({
    componentKey: 'component-1',
    kind: 'observed-missing',
    reason: 'Listed but physically missing',
  });
});
it('refuses a foreign preview and ignores a response after draft changes', async () => {
  const native = client();
  let resolve!: (result: InventoryArrivalPreviewSnapshot) => void;
  const pending = new Promise<InventoryArrivalPreviewSnapshot>((accept) => {
    resolve = accept;
  });
  const normal = native.previewArrival;
  native.previewArrival = vi.fn(() => pending);
  const session = new InventoryArrivalSession(native, scope, storage());
  session.edit(draft());
  const waiting = session.preview();
  const input = inventoryArrivalDraftInput(draft());
  const ready = await normal({ ...scope, ...input });
  session.edit({ ...draft(), supplier: 'Changed supplier' });
  resolve(ready);
  await waiting;
  expect(session.getSnapshot().phase).toBe('editing');
  native.previewArrival = vi.fn(async () => ({
    ...ready,
    target: { ...ready.target, projectId: 'foreign' },
  }));
  await session.preview();
  expect(session.getSnapshot()).toMatchObject({
    phase: 'failed',
    message: expect.stringMatching(/another project/),
  });
});
it('does not preview when the recovery draft cannot be persisted', async () => {
  const native = client();
  const session = new InventoryArrivalSession(native, scope, {
    getItem: () => null,
    setItem: () => {
      throw Error('storage failure');
    },
  });
  session.edit(draft());
  await session.preview();
  expect(native.previewArrival).not.toHaveBeenCalled();
  expect(session.getSnapshot().phase).toBe('failed');
});
it('submits only the frozen ready preview and disables it immediately after an edit', async () => {
  const native = client(),
    controller = new InventoryController(native, { read: () => [], write: () => {} }),
    current = data();
  const session = controller.arrivalSession(scope);
  session.edit(draft());
  const receive = vi.spyOn(controller, 'receiveArrival').mockResolvedValue(null);
  render(
    <InventoryArrivalForm
      data={current}
      status={{ kind: 'ready', data: current }}
      controller={controller}
      client={native}
      onClose={() => {}}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview complete delivery' }));
  await screen.findByText(/Ready to receive every listed disposition atomically/);
  fireEvent.click(screen.getByRole('button', { name: 'Receive delivery atomically' }));
  await waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
  const snapshot = session.getSnapshot();
  if (snapshot.phase !== 'previewed' || snapshot.preview.kind !== 'ready')
    throw Error('Ready preview');
  expect(receive).toHaveBeenCalledWith(
    snapshot.input.sourceText,
    snapshot.preview.options,
    snapshot.preview.planDigest
  );
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Edited supplier' } });
  expect(
    (screen.getByRole('button', { name: 'Receive delivery atomically' }) as HTMLButtonElement)
      .disabled
  ).toBe(true);
});

it('retains selected PDF bytes and an explicitly component-scoped supplier quantity without releasing its lot', async () => {
  const native = client(),
    controller = new InventoryController(native, { read: () => [], write: () => {} }),
    current = data(),
    session = controller.arrivalSession(scope);
  session.edit(draft());
  render(
    <InventoryArrivalForm
      data={current}
      status={{ kind: 'ready', data: current }}
      controller={controller}
      client={native}
      onClose={() => {}}
    />
  );
  choose('Document format', 'PDF original');
  const bytes = new TextEncoder().encode(
    '%PDF-1.4\r\nSynthetic certificate\nQuantity 2 mg\n%%EOF\n'
  );
  fireEvent.change(screen.getByLabelText('Original supplier document file'), {
    target: {
      files: [
        { name: 'original.pdf', type: 'application/pdf', arrayBuffer: async () => bytes.buffer },
      ],
    },
  });
  await screen.findByText('original.pdf · Original file bytes retained');
  choose('Document coverage', 'Full original document');
  fireEvent.click(screen.getByRole('button', { name: 'Add supplier statement' }));
  choose('Statement subject', 'Component 1: Reagent');
  choose('Statement document', 'Document 1: original.pdf');
  choose('Statement kind', 'Quantity');
  fireEvent.change(screen.getByLabelText('PDF page'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('PDF region'), { target: { value: 'Quantity row' } });
  fireEvent.change(screen.getByLabelText('Exact supplier quotation'), {
    target: { value: 'Quantity 2 mg' },
  });
  fireEvent.change(screen.getByLabelText('Supplier quantity'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Supplier unit'), { target: { value: 'mg' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add statement' }));
  choose('Component 1 amount basis', 'Supplier-declared quantity');
  choose('Component 1 supplier quantity statement', /^2 mg/);
  fireEvent.change(screen.getByLabelText('Component 1 measured amount'), {
    target: { value: '2' },
  });
  fireEvent.change(screen.getByLabelText('Component 1 amount reason'), {
    target: { value: 'Use this component certificate quantity' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Preview complete delivery' }));
  await screen.findByText(/Ready to receive every listed disposition atomically/);
  const snapshot = session.getSnapshot();
  if (snapshot.phase !== 'previewed' || snapshot.preview.kind !== 'ready')
    throw Error('Ready PDF preview required');
  const source = JSON.parse(snapshot.input.sourceText);
  expect(source.documents[0].body).toEqual({
    encoding: 'base64',
    value: btoa(String.fromCharCode(...bytes)),
  });
  expect(snapshot.preview.arrival.claims[0]).toMatchObject({
    subject: { kind: 'component', componentKey: 'component-1' },
    claim: { kind: 'quantity', valueLexeme: '2', unitText: 'mg' },
    verification: 'operator-cited-pdf-region',
  });
  expect(snapshot.input.options.components[0]).toMatchObject({
    quantity: { kind: 'known', value: '2', unit: 'mg' },
    quantityBasis: { kind: 'supplier-declared', claimKey: source.claims[0].key },
    lot: { kind: 'new' },
  });
  expect(snapshot.preview.commands.find((command) => command.kind === 'manage-lot')).toMatchObject({
    reason: 'Begin local quality assessment',
  });
  expect(
    snapshot.preview.commands.some(
      (command) => command.kind === 'assess-lot' || command.kind === 'record-validity-decision'
    )
  ).toBe(false);
});

it('invalidates a ready preview while composing a statement and selects the second repeated quotation after original CRLF', async () => {
  const native = client(),
    controller = new InventoryController(native, { read: () => [], write: () => {} }),
    current = data(),
    session = controller.arrivalSession(scope),
    input = draft();
  input.documents = [
    { ...input.documents[0], body: { encoding: 'utf8', value: 'α: 2 mg\r\nβ: 2 mg\r\n' } },
  ];
  session.edit(input);
  render(
    <InventoryArrivalForm
      data={current}
      status={{ kind: 'ready', data: current }}
      controller={controller}
      client={native}
      onClose={() => {}}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview complete delivery' }));
  await screen.findByText(/Ready to receive every listed disposition atomically/);
  fireEvent.click(screen.getByRole('button', { name: 'Add supplier statement' }));
  expect(
    (screen.getByRole('button', { name: 'Receive delivery atomically' }) as HTMLButtonElement)
      .disabled
  ).toBe(true);
  choose('Statement subject', 'Component 1: Reagent');
  choose('Statement document', 'Document 1');
  choose('Statement kind', 'Quantity');
  const selection = screen.getByLabelText('Select exact original text') as HTMLTextAreaElement;
  selection.setSelectionRange(11, 15);
  fireEvent.select(selection);
  fireEvent.change(screen.getByLabelText('Supplier quantity'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Supplier unit'), { target: { value: 'mg' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add statement' }));
  expect(session.getSnapshot().draft.claims[0].selection).toMatchObject({
    locator: { kind: 'utf8-byte-range', startByte: 14, endByte: 18 },
    verbatim: '2 mg',
  });
  fireEvent.change(screen.getByLabelText('Original supplier document text'), {
    target: { value: 'Changed original text' },
  });
  expect(session.getSnapshot().draft.claims).toEqual([]);
});
