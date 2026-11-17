import { expect, it, vi } from 'vitest';
import {
  createInventoryState,
  inventoryArrivalDocumentBytes,
  inventoryArrivalPreview,
  type InventoryArrivalSupplierClaimInput,
} from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import {
  InventoryArrivalSession,
  inventoryArrivalDocumentSelection,
  inventoryArrivalDraftInput,
  inventoryArrivalTextSelection,
  newArrivalComponent,
  newArrivalDocument,
  type InventoryArrivalDraft,
} from './inventory-arrival-session';

const scope = { project: 'project', inventoryId: 'inventory' };
const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const storageKey = `dnaforge.inventory.arrival-draft.v1:${JSON.stringify(scope)}`;
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
}
function draft(): InventoryArrivalDraft {
  return {
    namespace: 'arrivals',
    deliveryId: 'delivery-1',
    supplier: 'Supplier',
    supplierKind: 'known',
    observationReason: 'Actual vial observed',
    scopeKind: 'selected-components',
    scopeReason: 'One observed vial',
    documents: [
      {
        ...newArrivalDocument('document-1'),
        body: { encoding: 'utf8', value: 'β\r\n1 mg then 1 mg 🧬' },
        coverage: 'full',
      },
    ],
    claims: [],
    packageLabel: '',
    packagingBatch: '',
    components: [
      {
        ...newArrivalComponent('component-1'),
        label: 'Reagent',
        componentBatch: 'batch-1',
        materialId: 'material',
        lotName: 'Supplier lot',
        managementReason: 'Begin local assessment',
        quantity: '1',
        quantityReason: 'Measured mass',
        quality: 'usable',
        qualityReason: 'Local stock decision',
        vesselName: 'Vial',
      },
    ],
  };
}
function claim(value = draft()): InventoryArrivalSupplierClaimInput {
  return {
    key: 'quantity-1',
    subject: { kind: 'component', componentKey: 'component-1' },
    selection: inventoryArrivalTextSelection(value.documents[0], 12, 16),
    claim: { kind: 'quantity', valueLexeme: '1', unitText: 'mg' },
  };
}
function preview(value: InventoryArrivalDraft) {
  const input = inventoryArrivalDraftInput(value);
  return inventoryArrivalPreview(createInventoryState(), {
    ...input,
    target: {
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      present: true,
      revision: 0,
    },
    bindings: [
      {
        kind: 'admitted',
        key: 'component-1',
        materialId: 'material',
        fingerprint: `sha256:${'a'.repeat(64)}`,
      },
    ],
    asOf: 100,
    principal,
    authority: principal,
    maxBytes: 17 * 1024 * 1024,
  });
}
function deferredFile(name: string) {
  let resolve!: (buffer: ArrayBuffer) => void;
  const pending = new Promise<ArrayBuffer>((accept) => {
    resolve = accept;
  });
  return { file: { name, type: 'application/pdf', arrayBuffer: () => pending }, resolve };
}

it('migrates the saved v1 draft without changing identity, text, quality or source storage', () => {
  const saved = storage(),
    current = draft(),
    { documents, claims, ...fields } = current,
    { quantityBasis, quantityClaimKey, ...component } = current.components[0],
    old = {
      ...fields,
      documentText: documents[0].body.value,
      documentCoverage: documents[0].coverage,
      excerptReason: '',
      components: [component],
    },
    raw = JSON.stringify({ version: 1, draft: old });
  saved.values.set(storageKey, raw);
  const session = new InventoryArrivalSession(unavailableInventoryClient(), scope, saved);
  expect(session.getSnapshot().draft).toEqual(current);
  expect(saved.values.get(storageKey)).toBe(raw);
  session.edit(session.getSnapshot().draft);
  expect(JSON.parse(saved.values.get(storageKey)!).version).toBe(2);
  const reopened = new InventoryArrivalSession(unavailableInventoryClient(), scope, saved);
  expect(reopened.getSnapshot().draft).toEqual(current);
});

it('fails closed on malformed saved claim shapes, source bytes and legacy coverage before exposing them', () => {
  const current = draft(),
    malformed = [
      { version: 2, draft: { ...current, claims: [{}] } },
      { version: 2, draft: { ...current, claims: [{ ...claim(current), selection: null }] } },
      {
        version: 2,
        draft: {
          ...current,
          documents: [
            { ...current.documents[0], body: { encoding: 'base64', value: 'invalid==' } },
          ],
        },
      },
      {
        version: 2,
        draft: {
          ...current,
          documents: [{ ...current.documents[0], body: { encoding: 'base64', value: '/w==' } }],
        },
      },
      {
        version: 1,
        draft: {
          ...current,
          documentText: 'Original',
          documentCoverage: 'invented',
          excerptReason: '',
        },
      },
    ];
  for (const value of malformed) {
    const saved = storage(),
      raw = JSON.stringify(value);
    saved.values.set(storageKey, raw);
    const session = new InventoryArrivalSession(unavailableInventoryClient(), scope, saved);
    expect(session.getSnapshot().phase).toBe('failed');
    expect(session.getSnapshot().draft.claims).toEqual([]);
    expect(session.getSnapshot().draft.documents[0].body.value).toBe('');
    expect(saved.values.get(storageKey)).toBe(raw);
  }
});

it('anchors the selected repeated multibyte text by exact UTF8 offsets and preserves supplier provenance', () => {
  const value = draft();
  value.claims = [claim(value)];
  value.components = [
    { ...value.components[0], quantityBasis: 'supplier-declared', quantityClaimKey: 'quantity-1' },
  ];
  const selected = value.claims[0].selection;
  expect(selected.verbatim).toBe('1 mg');
  expect(selected.locator).toEqual({ kind: 'utf8-byte-range', startByte: 14, endByte: 18 });
  const result = preview(value);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw Error('Ready supplier receipt required');
  expect(result.arrival.claims[0].verification).toBe('exact-text-selection');
  expect(result.arrival.components[0].choice).toMatchObject({
    quantityBasis: { kind: 'supplier-declared', claimKey: 'quantity-1' },
    stockQuality: { value: 'usable' },
    lot: { kind: 'new' },
  });
  expect(inventoryArrivalTextSelection(value.documents[0], 0, 4)).toMatchObject({
    verbatim: 'β\r\n1 ',
    locator: { kind: 'utf8-byte-range', startByte: 0, endByte: 6 },
  });
  expect(() => inventoryArrivalTextSelection(value.documents[0], 18, 19)).toThrow(
    /complete source characters/
  );
});

it('drops stale document claims and quantity links instead of reanchoring them after replacement', () => {
  const value = draft();
  value.claims = [claim(value)];
  value.components = [
    { ...value.components[0], quantityBasis: 'supplier-declared', quantityClaimKey: 'quantity-1' },
  ];
  const session = new InventoryArrivalSession(unavailableInventoryClient(), scope, storage());
  session.edit(value);
  session.edit({
    ...session.getSnapshot().draft,
    documents: [{ ...value.documents[0], body: { encoding: 'utf8', value: 'Different 1 mg' } }],
  });
  const changed = session.getSnapshot().draft;
  expect(changed.claims).toEqual([]);
  expect(changed.components[0]).toMatchObject({
    quantityBasis: 'supplier-declared',
    quantityClaimKey: '',
  });
  expect(() => inventoryArrivalDraftInput(changed)).toThrow(/exact component/);
});

it('fences superseded file reads, cancellation, ordinary edits and a new delivery', async () => {
  const session = new InventoryArrivalSession(unavailableInventoryClient(), scope, storage());
  session.edit(draft());
  const first = deferredFile('first.pdf'),
    second = deferredFile('second.pdf'),
    firstRead = session.readDocumentFile('document-1', first.file, 'application/pdf'),
    secondRead = session.readDocumentFile('document-1', second.file, 'application/pdf');
  second.resolve(new Uint8Array([37, 80, 68, 70, 2]).buffer);
  await secondRead;
  first.resolve(new Uint8Array([37, 80, 68, 70, 1]).buffer);
  await firstRead;
  const retained = session.getSnapshot().draft;
  expect(retained.documents[0].fileName).toBe('second.pdf');
  expect([
    ...inventoryArrivalDocumentBytes({ ...retained.documents[0], coverage: { kind: 'full' } }),
  ]).toEqual([37, 80, 68, 70, 2]);
  const cancelled = deferredFile('cancelled.pdf'),
    cancelledRead = session.readDocumentFile('document-1', cancelled.file, 'application/pdf');
  session.cancelDocumentRead();
  cancelled.resolve(new Uint8Array([1]).buffer);
  await cancelledRead;
  expect(session.getSnapshot().draft).toEqual(retained);
  const edited = deferredFile('edited.pdf'),
    editedRead = session.readDocumentFile('document-1', edited.file, 'application/pdf');
  session.edit({ ...retained, supplier: 'New supplier' });
  edited.resolve(new Uint8Array([2]).buffer);
  await editedRead;
  expect(session.getSnapshot().draft.supplier).toBe('New supplier');
  expect(session.getSnapshot().draft.documents[0].fileName).toBe('second.pdf');
  const next = deferredFile('old-delivery.pdf'),
    nextRead = session.readDocumentFile('document-1', next.file, 'application/pdf');
  session.newDelivery();
  const nextIdentity = session.getSnapshot().draft.deliveryId;
  next.resolve(new Uint8Array([3]).buffer);
  await nextRead;
  expect(session.getSnapshot().draft.deliveryId).toBe(nextIdentity);
  expect(session.getSnapshot().draft.documents[0].body.value).toBe('');
});

it('blocks preview during file loading or failed reading until the prior document is deliberately retained', async () => {
  const native = unavailableInventoryClient();
  native.previewArrival = vi.fn(async () => {
    throw Error('native preview observed');
  });
  const session = new InventoryArrivalSession(native, scope, storage());
  session.edit(draft());
  const pending = deferredFile('invalid.txt'),
    read = session.readDocumentFile('document-1', pending.file, 'text/plain');
  await session.preview();
  expect(native.previewArrival).not.toHaveBeenCalled();
  pending.resolve(new Uint8Array([255]).buffer);
  await read;
  expect(session.getSnapshot().documentRead.kind).toBe('failed');
  await session.preview();
  expect(native.previewArrival).not.toHaveBeenCalled();
  session.cancelDocumentRead();
  await session.preview();
  expect(native.previewArrival).toHaveBeenCalledTimes(1);
});

it('cannot preview a retained binary when recovery storage rejects it or is unavailable', async () => {
  const saved = storage(),
    native = unavailableInventoryClient();
  native.previewArrival = vi.fn();
  const session = new InventoryArrivalSession(native, scope, saved);
  session.edit(draft());
  saved.setItem.mockImplementation(() => {
    throw Error('quota exceeded');
  });
  await session.readDocumentFile(
    'document-1',
    {
      name: 'certificate.pdf',
      type: 'application/pdf',
      arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
    },
    'application/pdf'
  );
  expect(session.getSnapshot().phase).toBe('failed');
  await session.preview();
  expect(native.previewArrival).not.toHaveBeenCalled();
  const unavailable = new InventoryArrivalSession(native, scope, null);
  unavailable.edit(draft());
  await unavailable.preview();
  expect(unavailable.getSnapshot().phase).toBe('failed');
  expect(native.previewArrival).not.toHaveBeenCalled();
});

it('keeps operator-cited PDF evidence and unsupported activity separate from physical quantity and local assessment', () => {
  const value = draft();
  value.documents = [
    {
      ...value.documents[0],
      mediaType: 'application/pdf',
      body: { encoding: 'base64', value: 'JVBERi0xLjcK' },
    },
  ];
  value.claims = [
    {
      key: 'quantity-U',
      subject: { kind: 'component', componentKey: 'component-1' },
      selection: inventoryArrivalDocumentSelection(
        value.documents[0],
        { kind: 'pdf-region', page1Based: 1, description: 'Quantity row' },
        '1000 U'
      ),
      claim: { kind: 'quantity', valueLexeme: '1000', unitText: 'U' },
    },
  ];
  value.components = [
    {
      ...value.components[0],
      quantityKind: 'unknown',
      quantityReason: 'Activity does not establish mass',
    },
  ];
  const result = preview(value);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw Error('Ready evidence receipt required');
  expect(result.arrival.claims[0].verification).toBe('operator-cited-pdf-region');
  expect(result.arrival.components[0].receivedQuantity).toEqual({ kind: 'unknown', unit: 'ng' });
  value.components = [
    {
      ...value.components[0],
      quantityKind: 'known',
      quantityBasis: 'supplier-declared',
      quantityClaimKey: 'quantity-U',
    },
  ];
  expect(preview(value).kind).toBe('blocked');
  value.claims = [{ ...value.claims[0], subject: { kind: 'delivery' } }];
  expect(() => inventoryArrivalDraftInput(value)).toThrow(/exact component/);
});
