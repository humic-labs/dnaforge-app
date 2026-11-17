import { describe, expect, it } from 'vitest';
import {
  applyInventoryArrival,
  inventoryArrivalPreview,
  inventoryArrivalId,
  inventoryArrivalDocumentMetadata,
  parseInventoryArrivalSource,
  readInventoryArrivalDocument,
  parseInventoryArrivalChoices,
} from './inventory-arrivals';
import { applyInventoryCommandBatch } from './inventory-state';
import { adoptInventoryState } from './inventory-adoption';
import {
  createInventoryState,
  type InventoryCommand,
  type InventoryState,
} from './inventory-types';
import { inventoryStockEligibility } from './inventory-lot-controls';
import { inventoryVesselContents } from './inventory-contents';
import { inventoryTableSha256 } from './inventory-table-binding';
import type {
  InventoryArrivalChoices,
  InventoryArrivalComponentChoice,
  InventoryArrivalPreviewInput,
  InventoryArrivalSource,
} from './inventory-arrival-types';

type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };
const context = {
  at: 100,
  principal: { kind: 'local-profile' as const, profileKey: 'arrival-profile' },
  authority: { kind: 'local-profile' as const, profileKey: 'arrival-profile' },
};
const documentText = 'Supplier batch 0001\nAmount: 1 mg\nQC: pass\n';
function source(): Mutable<InventoryArrivalSource> {
  return {
    schema: 'dnaforge.inventory-arrival-source.v1',
    identity: { namespace: 'supplier.delivery', arrivalId: '0001' },
    supplier: 'Synthetic supplier',
    observedAt: 90,
    observationReason: 'Actual delivery observed',
    scope: { kind: 'complete-listed-manifest', reason: 'All listed components inspected' },
    documents: [
      {
        key: 'certificate',
        mediaType: 'text/plain',
        body: { encoding: 'utf8', value: documentText },
        reference: null,
        coverage: { kind: 'full' },
      },
    ],
    packages: [{ key: 'kit', label: 'Kit', productCode: 'SKU-0001', packagingBatch: 'PACK-0001' }],
    components: [
      {
        key: 'powder',
        packageKey: 'kit',
        label: 'Powder',
        productCode: 'P-01',
        componentBatch: '0001',
      },
      {
        key: 'unknown',
        packageKey: 'kit',
        label: 'Unresolved vial',
        productCode: null,
        componentBatch: null,
      },
    ],
    claims: [
      {
        key: 'amount',
        subject: { kind: 'component', componentKey: 'powder' },
        selection: {
          documentKey: 'certificate',
          expectedSha256: inventoryTableSha256(documentText),
          locator: {
            kind: 'utf8-byte-range',
            startByte: 0,
            endByte: new TextEncoder().encode(documentText).byteLength,
          },
          verbatim: documentText,
        },
        claim: { kind: 'quantity', valueLexeme: '1', unitText: 'mg' },
      },
    ],
  };
}
function identified(): Extract<InventoryArrivalComponentChoice, { kind: 'identified' }> {
  return {
    componentKey: 'powder',
    kind: 'identified',
    materialId: 'material',
    lot: {
      kind: 'new',
      lotKey: 'batch-0001',
      name: 'Supplier batch',
      supplier: 'Synthetic supplier',
      lotNumber: '0001',
      managementReason: 'Start local assessment',
    },
    quantity: { kind: 'known', value: '1', unit: 'mg' },
    quantityBasis: {
      kind: 'supplier-declared',
      claimKey: 'amount',
      reason: 'Explicit supplier content declaration',
    },
    stockQuality: { value: 'usable', reason: 'Stock specific assessment' },
    vessel: { name: 'Received powder', placement: { kind: 'unplaced' } },
  };
}
function choices(): Mutable<InventoryArrivalChoices> {
  return {
    components: [
      identified(),
      {
        componentKey: 'unknown',
        kind: 'unidentified-physical',
        vessel: { name: 'Unresolved vial', placement: { kind: 'unplaced' } },
        reason: 'Contents not identified',
      },
    ],
  };
}
function input(
  state: InventoryState | null,
  packet: InventoryArrivalSource = source(),
  options: InventoryArrivalChoices = choices()
): Omit<InventoryArrivalPreviewInput, 'target' | 'asOf'> & {
  target: Mutable<InventoryArrivalPreviewInput['target']>;
  asOf: number;
} {
  return {
    target: {
      projectId: 'project',
      inventoryId: 'inventory',
      present: state !== null,
      revision: state?.revision ?? 0,
    },
    sourceText: JSON.stringify(packet),
    options,
    bindings: options.components.flatMap((choice) =>
      choice.kind === 'identified'
        ? [
            {
              kind: 'admitted' as const,
              key: choice.componentKey,
              materialId: choice.materialId,
              fingerprint: inventoryTableSha256('current scientific record'),
            },
          ]
        : []
    ),
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes: 17 * 1024 * 1024,
  };
}
function receive(
  state: InventoryState | null = null,
  packet: InventoryArrivalSource = source(),
  options: InventoryArrivalChoices = choices()
) {
  const proposal = inventoryArrivalPreview(state, input(state, packet, options));
  if (proposal.kind !== 'ready') throw new Error(JSON.stringify(proposal));
  const applied = applyInventoryArrival(
    state,
    {
      target: proposal.target,
      sourceText: JSON.stringify(packet),
      options: proposal.options,
      expectedPlanDigest: proposal.planDigest,
    },
    context,
    17 * 1024 * 1024
  );
  if (!applied.ok) throw new Error(`${applied.code}:${applied.message}`);
  return { state: applied.state, proposal, arrival: applied.state.arrivals[proposal.arrival.id] };
}
function commands(state: InventoryState, values: readonly InventoryCommand[]) {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands: values },
    context
  );
  if (!result.ok) throw new Error(`${result.code}:${result.message}`);
  return result.state;
}

describe('atomic actual arrivals', () => {
  it('receives exact mass plus a real unresolved vial, retaining package and component batches independently', () => {
    const { state, arrival, proposal } = receive();
    const powder = arrival.components.find((item) => item.key === 'powder')!;
    expect(proposal.commands.map((command) => command.kind)).toEqual([
      'create-lot',
      'manage-lot',
      'create-vessel',
      'receive-lot-stock',
      'create-vessel',
      'record-vessel-contents',
    ]);
    expect(state.revision).toBe(1);
    expect(powder.receivedQuantity).toEqual({ kind: 'known', value: '1000000', unit: 'ng' });
    expect(state.stocks[powder.target.stockId!].quantity).toEqual(powder.receivedQuantity);
    expect(arrival.packages[0].packagingBatch).toBe('PACK-0001');
    expect(powder.componentBatch).toBe('0001');
    expect(state.lots[powder.target.lotId!].controls).toMatchObject({
      kind: 'managed',
      assessment: { value: 'unassessed' },
    });
    expect(inventoryStockEligibility(state, powder.target.stockId!, 100)?.blockers).toContainEqual({
      code: 'LOT_NOT_RELEASED',
      lotId: powder.target.lotId!,
      assessment: 'unassessed',
    });
    const unknown = arrival.components.find((item) => item.key === 'unknown')!;
    expect(inventoryVesselContents(state, unknown.target.vesselId!)?.kind).toBe('unidentified');
    expect(unknown.receivedQuantity).toBeNull();
    expect(Object.values(state.stocks)).toHaveLength(1);
    expect(arrival.documents[0].sha256).toBe(inventoryTableSha256(documentText));
  });
  it('keeps original admission immutable and duplicate no-change after use, move and disposal', () => {
    const received = receive(),
      component = received.arrival.components[0],
      original = JSON.stringify(received.arrival);
    let state = commands(received.state, [
      {
        kind: 'assess-lot',
        lotId: component.target.lotId!,
        assessment: 'released',
        reason: 'Local release',
      },
      {
        kind: 'consume',
        stockId: component.target.stockId!,
        quantity: { value: '0.25', unit: 'mg' },
        reason: 'Actual use',
      },
      {
        kind: 'create-storage',
        id: 'shelf',
        name: 'Shelf',
        slots: ['A'],
        placement: { kind: 'root' },
      },
      {
        kind: 'move-vessel',
        id: component.target.vesselId!,
        placement: { kind: 'located', storageId: 'shelf', slotId: 'A' },
      },
    ]);
    expect(state.stocks[component.target.stockId!].quantity).toEqual({
      kind: 'known',
      value: '750000',
      unit: 'ng',
    });
    expect(inventoryArrivalPreview(state, input(state)).kind).toBe('no-change');
    state = commands(state, [
      { kind: 'dispose-vessel', id: component.target.vesselId!, reason: 'Disposed actual vessel' },
    ]);
    const before = JSON.stringify(state);
    const preview = inventoryArrivalPreview(state, input(state));
    expect(preview.kind).toBe('no-change');
    expect(preview.arrival).toEqual(received.arrival);
    expect(JSON.stringify(state)).toBe(before);
    expect(JSON.stringify(state.arrivals[received.arrival.id])).toBe(original);
    const again = applyInventoryArrival(
      state,
      {
        target: { ...received.proposal.target, present: true, revision: state.revision },
        sourceText: JSON.stringify(source()),
        options: received.proposal.options,
        expectedPlanDigest: received.proposal.planDigest,
      },
      context,
      17 * 1024 * 1024
    );
    expect(again.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });
  it('blocks changed original source or admission rather than replenishing the arrival', () => {
    const { state } = receive();
    const packet = source();
    packet.documents[0] = {
      ...packet.documents[0],
      body: { encoding: 'utf8', value: documentText + 'new evidence' },
    };
    packet.claims = [];
    expect(inventoryArrivalPreview(state, input(state, packet)).kind).toBe('blocked');
    const options = choices();
    options.components[0] = {
      ...identified(),
      quantity: { kind: 'known', value: '2', unit: 'mg' },
      quantityBasis: { kind: 'measurement', reason: 'Changed measurement' },
    };
    const preview = inventoryArrivalPreview(state, input(state, source(), options));
    expect(preview.kind).toBe('blocked');
    expect(preview.issues[0].code).toBe('ARRIVAL_NEEDS_RECONCILIATION');
  });
  it('detects a late occupied placement without partially creating lots or physical records', () => {
    const state = commands(createInventoryState(), [
      {
        kind: 'create-storage',
        id: 'shelf',
        name: 'Shelf',
        slots: ['A'],
        placement: { kind: 'root' },
      },
      {
        kind: 'create-vessel',
        id: 'occupant',
        name: 'Existing',
        placement: { kind: 'located', storageId: 'shelf', slotId: 'A' },
      },
    ]);
    const options = choices();
    options.components[1] = {
      componentKey: 'unknown',
      kind: 'unidentified-physical',
      vessel: {
        name: 'Late collision',
        placement: { kind: 'located', storageId: 'shelf', slotId: 'A' },
      },
      reason: 'Physical vial',
    };
    const before = JSON.stringify(state),
      preview = inventoryArrivalPreview(state, input(state, source(), options));
    expect(preview.kind).toBe('blocked');
    expect(preview.issues[0].code).toBe('SLOT_OCCUPIED');
    expect(JSON.stringify(state)).toBe(before);
    expect(state.arrivals).toEqual({});
    expect(state.lots).toEqual({});
  });
  it('requires supplier amounts to exactly match a supported same-dimension claim', () => {
    const options = choices();
    options.components[0] = {
      ...identified(),
      quantity: { kind: 'known', value: '2', unit: 'mg' },
    };
    expect(inventoryArrivalPreview(null, input(null, source(), options)).issues[0].code).toBe(
      'ARRIVAL_QUANTITY_CLAIM_MISMATCH'
    );
    const packet = source();
    packet.claims[0] = {
      ...packet.claims[0],
      claim: { kind: 'quantity', valueLexeme: '1000', unitText: 'U' },
    };
    expect(inventoryArrivalPreview(null, input(null, packet)).issues[0].code).toBe(
      'ARRIVAL_QUANTITY_CLAIM_UNSUPPORTED'
    );
    options.components[0] = {
      ...identified(),
      quantity: { kind: 'unknown', unit: 'mg' },
      quantityBasis: { kind: 'unknown', reason: 'Activity cannot establish mass' },
    };
    const received = receive(null, packet, options);
    expect(received.arrival.components[0].receivedQuantity).toEqual({
      kind: 'unknown',
      unit: 'ng',
    });
  });
  it('requires exact complete component choices and one current scientific observation per identified component', () => {
    const missing = choices();
    missing.components = missing.components.slice(0, 1);
    expect(inventoryArrivalPreview(null, input(null, source(), missing)).issues[0].code).toBe(
      'ARRIVAL_CHOICES_INCOMPLETE'
    );
    const current = input(null);
    expect(inventoryArrivalPreview(null, { ...current, bindings: [] }).issues[0].code).toBe(
      'ARRIVAL_MATERIALS_INCOMPLETE'
    );
    expect(
      inventoryArrivalPreview(null, {
        ...current,
        bindings: [
          {
            kind: 'unavailable',
            key: 'powder',
            materialId: 'material',
            reason: 'Deleted scientific record',
          },
        ],
      }).issues[0].code
    ).toBe('ARRIVAL_MATERIAL_UNAVAILABLE');
  });
  it('records an evidence-only component in one real metadata revision without dummy commands', () => {
    const packet = source();
    packet.components = packet.components.slice(0, 1);
    packet.claims = [];
    const options: InventoryArrivalChoices = {
      components: [
        {
          componentKey: 'powder',
          kind: 'evidence-only',
          reason: 'Label listed but no physical vial admitted',
        },
      ],
    };
    const received = receive(null, packet, options);
    expect(received.proposal.commands).toEqual([]);
    expect(received.state.revision).toBe(1);
    expect(Object.values(received.state.vessels)).toEqual([]);
    expect(Object.values(received.state.stocks)).toEqual([]);
    expect(
      inventoryArrivalPreview(received.state, input(received.state, packet, options)).kind
    ).toBe('no-change');
  });
  it('records an explicitly unknown supplier and unattributed stock without fabricating a lot', () => {
    const packet = source();
    packet.supplier = null;
    packet.components[0] = { ...packet.components[0], componentBatch: null };
    const options = choices();
    options.components[0] = {
      ...identified(),
      lot: { kind: 'unattributed', reason: 'Supplier and batch were not observed' },
    };
    const received = receive(null, packet, options);
    const component = received.arrival.components[0];
    expect(received.arrival.supplier).toBeNull();
    expect(component.target.lotId).toBeNull();
    expect(Object.values(received.state.lots)).toEqual([]);
    expect(received.state.stocks[component.target.stockId!].source).toEqual({
      kind: 'unattributed',
      rootStockId: component.target.stockId,
    });
    const stock = received.state.stocks[component.target.stockId!];
    expect(stock.quantity).toEqual(component.receivedQuantity);
    expect(inventoryArrivalPreview(null, input(null, packet, choices())).issues[0].code).toBe(
      'ARRIVAL_SUPPLIER_LOT_MISMATCH'
    );
  });

  it('requires exact known supplier batches and reasoned existing lot choices', () => {
    const packet = source();
    packet.components[0] = { ...packet.components[0], componentBatch: '001' };
    expect(inventoryArrivalPreview(null, input(null, packet)).issues[0].code).toBe(
      'ARRIVAL_SUPPLIER_LOT_MISMATCH'
    );
    const state = commands(createInventoryState(), [
      {
        kind: 'create-lot',
        id: 'existing',
        materialId: 'material',
        name: 'Existingbatch',
        origin: { kind: 'received', supplier: 'Observedelsewhere', lotNumber: 'recorded' },
      },
    ]);
    const options = choices();
    options.components[0] = {
      ...identified(),
      lot: { kind: 'existing', lotId: 'existing', reason: 'Explicit record mapping confirmed' },
    };
    const received = receive(state, source(), options);
    expect(received.arrival.components[0].target.lotId).toBe('existing');
    expect(Object.values(received.state.lots)).toHaveLength(1);
    const missing = choices() as unknown as { components: unknown[] };
    missing.components[0] = { ...identified(), lot: { kind: 'existing', lotId: 'existing' } };
    expect(() => parseInventoryArrivalChoices(missing)).toThrow();
  });

  it('requires exact resolved options on apply and does not silently split oversized plans', () => {
    const current = input(null),
      preview = inventoryArrivalPreview(null, current);
    if (preview.kind !== 'ready') throw new Error('Ready preview required');
    expect(
      applyInventoryArrival(
        null,
        {
          target: current.target,
          sourceText: current.sourceText,
          options: { ...preview.options, targets: [] },
          expectedPlanDigest: preview.planDigest,
        },
        context,
        current.maxBytes
      ).ok
    ).toBe(false);
    const packet = source();
    packet.claims = [];
    packet.components = Array.from({ length: 129 }, (_, index) => ({
      key: `vial-${index}`,
      packageKey: null,
      label: 'Vial',
      productCode: null,
      componentBatch: null,
    }));
    const options: InventoryArrivalChoices = {
      components: packet.components.map((item) => ({
        componentKey: item.key,
        kind: 'unobserved-physical',
        vessel: { name: 'Vial', placement: { kind: 'unplaced' } },
        reason: 'Physical vial not opened',
      })),
    };
    expect(inventoryArrivalPreview(null, input(null, packet, options)).issues[0].code).toBe(
      'ARRIVAL_BATCH_TOO_LARGE'
    );
  });
  it('retains stable source identity and decoded original documents through adoption', () => {
    const received = receive();
    const adopted = adoptInventoryState(
      null,
      received.state,
      {
        source: {
          archiveSha256: inventoryTableSha256('archive'),
          projectId: 'project',
          inventoryId: 'inventory',
          revision: received.state.revision,
        },
        materialBindings: { material: 'remapped' },
      },
      { ...context, at: 200 }
    );
    if (!adopted.ok) throw new Error(adopted.message);
    const options = choices();
    options.components[0] = { ...identified(), materialId: 'remapped' };
    const nextInput = input(adopted.state, source(), options);
    nextInput.asOf = 200;
    nextInput.target = {
      ...nextInput.target,
      projectId: 'other-project',
      inventoryId: 'other-inventory',
    };
    const duplicate = inventoryArrivalPreview(adopted.state, nextInput);
    expect(duplicate.issues).toEqual([]);
    expect(duplicate.kind).toBe('no-change');
    expect(duplicate.arrival?.id).toBe(received.arrival.id);
    expect(duplicate.arrival?.sourceSha256).toBe(received.arrival.sourceSha256);
    expect(duplicate.arrival?.admissionSha256).toBe(received.arrival.admissionSha256);
    expect(duplicate.arrival?.by.kind).toBe('imported');
    expect(
      readInventoryArrivalDocument(
        adopted.state.arrivals[received.arrival.id],
        JSON.stringify(source()),
        {
          arrivalId: received.arrival.id,
          documentKey: 'certificate',
          expectedSha256: received.arrival.documents[0].sha256,
        }
      )
    ).toMatchObject({ kind: 'available', body: { encoding: 'utf8', value: documentText } });
  });
});

describe('exact retained arrival evidence', () => {
  it('rejects duplicate source keys, malformed base64, invalid UTF8 and split-character selections', () => {
    expect(() =>
      parseInventoryArrivalSource(
        JSON.stringify(source()).replace('"supplier":', '"supplier":"first","supplier":'),
        17 * 1024 * 1024
      )
    ).toThrow(/duplicated/);
    const document = source().documents[0];
    for (const value of ['Zg=', 'Zh==', 'Zg==\n'])
      expect(() =>
        inventoryArrivalDocumentMetadata({ ...document, body: { encoding: 'base64', value } })
      ).toThrow(/base64/);
    expect(() =>
      inventoryArrivalDocumentMetadata({ ...document, body: { encoding: 'utf8', value: '\ud800' } })
    ).toThrow(/UTF-8/);
    const packet = source();
    packet.documents[0] = { ...document, body: { encoding: 'utf8', value: 'é1 mg' } };
    packet.claims[0] = {
      ...packet.claims[0],
      selection: {
        ...packet.claims[0].selection,
        expectedSha256: inventoryTableSha256('é1 mg'),
        locator: { kind: 'utf8-byte-range', startByte: 1, endByte: 2 },
        verbatim: 'é',
      },
    };
    expect(() => parseInventoryArrivalSource(JSON.stringify(packet), 17 * 1024 * 1024)).toThrow(
      /UTF-8/
    );
  });
  it('preserves original JSON numeric lexemes and refuses wrong quotes or changed document hashes', () => {
    const packet = source(),
      body = '{"amount":900719925474099312345678901,"unit":"item"}';
    packet.documents[0] = {
      ...packet.documents[0],
      mediaType: 'application/json',
      body: { encoding: 'utf8', value: body },
    };
    packet.claims[0] = {
      ...packet.claims[0],
      selection: {
        documentKey: 'certificate',
        expectedSha256: inventoryTableSha256(body),
        locator: { kind: 'json-pointer', pointer: '/amount' },
        verbatim: '900719925474099312345678901',
      },
      claim: { kind: 'quantity', valueLexeme: '900719925474099312345678901', unitText: 'item' },
    };
    expect(
      parseInventoryArrivalSource(JSON.stringify(packet), 17 * 1024 * 1024).claims[0].selection
        .verbatim
    ).toBe('900719925474099312345678901');
    packet.claims[0] = {
      ...packet.claims[0],
      selection: { ...packet.claims[0].selection, verbatim: '9007199254740993' },
    };
    expect(() => parseInventoryArrivalSource(JSON.stringify(packet), 17 * 1024 * 1024)).toThrow(
      /exactly match/
    );
  });
  it('labels PDF citations as operator statements and keeps binary bytes exact', () => {
    const packet = source();
    packet.documents[0] = {
      ...packet.documents[0],
      mediaType: 'application/pdf',
      body: { encoding: 'base64', value: btoa('%PDF-1.7\nsynthetic') },
    };
    const metadata = inventoryArrivalDocumentMetadata(packet.documents[0]);
    packet.claims[0] = {
      ...packet.claims[0],
      selection: {
        documentKey: 'certificate',
        expectedSha256: metadata.sha256,
        locator: { kind: 'pdf-region', page1Based: 1, description: 'Supplier amount label' },
        verbatim: '1 mg',
      },
    };
    const received = receive(null, packet);
    expect(received.arrival.claims[0].verification).toBe('operator-cited-pdf-region');
    expect(
      readInventoryArrivalDocument(received.arrival, JSON.stringify(packet), {
        arrivalId: received.arrival.id,
        documentKey: 'certificate',
        expectedSha256: metadata.sha256,
      })
    ).toMatchObject({ kind: 'available', body: packet.documents[0].body });
    expect(
      readInventoryArrivalDocument(received.arrival, '{}', {
        arrivalId: received.arrival.id,
        documentKey: 'certificate',
        expectedSha256: metadata.sha256,
      }).kind
    ).toBe('unavailable');
  });
  it('requires explicit unknown units, bounded original source and exact technical namespace', () => {
    const options = choices();
    options.components[0] = {
      ...identified(),
      quantity: { kind: 'unknown' },
      quantityBasis: { kind: 'unknown', reason: 'No amount' },
    };
    expect(() => parseInventoryArrivalChoices(options)).toThrow();
    expect(() => parseInventoryArrivalSource(JSON.stringify(source()), 10)).toThrow(/inline limit/);
    expect(() => inventoryArrivalId({ namespace: 'Supplier', arrivalId: '1' })).toThrow(
      /lowercase/
    );
    const invalid = choices() as unknown as { components: unknown[] };
    invalid.components[0] = {
      ...identified(),
      quantity: { kind: 'not-known', unit: 'ng' },
      quantityBasis: { kind: 'unknown', reason: 'No amount' },
    };
    expect(() => parseInventoryArrivalChoices(invalid)).toThrow(/known or unknown/);
  });
});
