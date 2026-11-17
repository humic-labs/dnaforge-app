import {
  inventoryArrivalDocumentBytes,
  inventoryArrivalDocumentMetadata,
  type InventoryAmountUnit,
  type InventoryArrivalChoices,
  type InventoryArrivalDocumentInput,
  type InventoryArrivalEvidenceLocator,
  type InventoryArrivalSelection,
  type InventoryArrivalSupplierClaimInput,
  type InventoryArrivalSource,
  type InventoryVesselPlacement,
} from '@waypoint/domain-services';
import type {
  InventoryArrivalPreviewSnapshot,
  InventoryClient,
} from '../../shared/inventory-client';

export interface InventoryArrivalComponentDraft {
  key: string;
  label: string;
  componentBatch: string;
  disposition:
    | 'identified'
    | 'unidentified-physical'
    | 'unobserved-physical'
    | 'observed-missing'
    | 'evidence-only';
  materialId: string;
  lotKind: 'new' | 'existing' | 'unattributed';
  lotReason: string;
  lotId: string;
  lotName: string;
  lotNumber: string;
  managementReason: string;
  quantityKind: 'known' | 'unknown';
  quantity: string;
  unit: InventoryAmountUnit;
  quantityReason: string;
  quantityBasis: 'measurement' | 'supplier-declared';
  quantityClaimKey: string;
  quality: '' | 'usable' | 'quarantined';
  qualityReason: string;
  vesselName: string;
  storageId: string;
  position: string;
  dispositionReason: string;
}
export interface InventoryArrivalDocumentDraft {
  key: string;
  mediaType: InventoryArrivalDocumentInput['mediaType'];
  body: InventoryArrivalDocumentInput['body'];
  coverage: '' | 'full' | 'excerpt';
  excerptReason: string;
  reference: InventoryArrivalDocumentInput['reference'];
  fileName: string | null;
}
export interface InventoryArrivalDraft {
  namespace: string;
  deliveryId: string;
  supplier: string;
  supplierKind: 'known' | 'unknown';
  observationReason: string;
  scopeKind: 'selected-components' | 'complete-listed-manifest';
  scopeReason: string;
  documents: readonly InventoryArrivalDocumentDraft[];
  claims: readonly InventoryArrivalSupplierClaimInput[];
  packageLabel: string;
  packagingBatch: string;
  components: readonly InventoryArrivalComponentDraft[];
}
export const newArrivalComponent = (key: string): InventoryArrivalComponentDraft => ({
  key,
  label: '',
  componentBatch: '',
  disposition: 'identified',
  materialId: '',
  lotKind: 'new',
  lotReason: '',
  lotId: '',
  lotName: '',
  lotNumber: '',
  managementReason: '',
  quantityKind: 'known',
  quantity: '',
  unit: 'mg',
  quantityReason: '',
  quantityBasis: 'measurement',
  quantityClaimKey: '',
  quality: '',
  qualityReason: '',
  vesselName: '',
  storageId: '',
  position: '',
  dispositionReason: '',
});
export const newArrivalDocument = (key: string): InventoryArrivalDocumentDraft => ({
  key,
  mediaType: 'text/plain',
  body: { encoding: 'utf8', value: '' },
  coverage: '',
  excerptReason: '',
  reference: null,
  fileName: null,
});
const initialDraft = (): InventoryArrivalDraft => ({
  namespace: 'local-deliveries',
  deliveryId: crypto.randomUUID(),
  supplier: '',
  supplierKind: 'known',
  observationReason: '',
  scopeKind: 'selected-components',
  scopeReason: '',
  documents: [newArrivalDocument('document-1')],
  claims: [],
  packageLabel: '',
  packagingBatch: '',
  components: [newArrivalComponent('component-1')],
});
const required = (value: string, label: string) => {
  if (!value.trim()) throw new Error(`Enter ${label}.`);
  return value.trim();
};
export function inventoryArrivalDraftInput(draft: InventoryArrivalDraft): {
  sourceText: string;
  options: InventoryArrivalChoices;
} {
  if (!draft.documents.length) throw new Error('Retain at least one original supplier document.');
  const supplier =
    draft.supplierKind === 'unknown' ? null : required(draft.supplier, 'the supplier');
  const source: InventoryArrivalSource = {
    schema: 'dnaforge.inventory-arrival-source.v1',
    identity: {
      namespace: required(draft.namespace, 'the delivery namespace'),
      arrivalId: required(draft.deliveryId, 'the actual delivery ID'),
    },
    supplier,
    observedAt: null,
    observationReason: required(draft.observationReason, 'the actual arrival observation reason'),
    scope: {
      kind: draft.scopeKind,
      reason: required(draft.scopeReason, 'the observed component scope'),
    },
    documents: draft.documents.map(inventoryArrivalDocumentInput),
    packages: draft.packageLabel.trim()
      ? [
          {
            key: 'package-1',
            label: draft.packageLabel.trim(),
            productCode: null,
            packagingBatch: draft.packagingBatch.trim() || null,
          },
        ]
      : [],
    components: draft.components.map((component) => ({
      key: component.key,
      packageKey: draft.packageLabel.trim() ? 'package-1' : null,
      label: required(component.label, 'each component label'),
      productCode: null,
      componentBatch: component.componentBatch.trim() || null,
    })),
    claims: structuredClone(draft.claims),
  };
  const options: InventoryArrivalChoices = {
    components: draft.components.map((component) => {
      const placement: InventoryVesselPlacement = component.storageId
        ? {
            kind: 'located',
            storageId: component.storageId,
            slotId: required(component.position, 'the exact destination position'),
          }
        : { kind: 'unplaced' };
      const vessel = {
        name: required(
          component.vesselName ||
            (component.disposition === 'observed-missing' ||
            component.disposition === 'evidence-only'
              ? component.label
              : ''),
          'each physical container name'
        ),
        placement,
      };
      if (component.disposition === 'observed-missing' || component.disposition === 'evidence-only')
        return {
          componentKey: component.key,
          kind: component.disposition,
          reason: required(component.dispositionReason, 'the component disposition reason'),
        };
      if (component.disposition !== 'identified')
        return {
          componentKey: component.key,
          kind: component.disposition,
          vessel,
          reason: required(component.dispositionReason, 'the physical contents observation reason'),
        };
      if (!component.quality) throw new Error('Choose each stock’s local quality explicitly.');
      const reason = required(component.quantityReason, 'the measurement or unknown amount reason');
      if (component.quantityKind === 'known' && component.quantityBasis === 'supplier-declared') {
        const claim = draft.claims.find((item) => item.key === component.quantityClaimKey);
        if (
          !claim ||
          claim.claim.kind !== 'quantity' ||
          claim.subject.kind !== 'component' ||
          claim.subject.componentKey !== component.key
        )
          throw new Error('Choose a supplier quantity claim for this exact component.');
      }
      return {
        componentKey: component.key,
        kind: 'identified',
        materialId: required(component.materialId, 'the current scientific material'),
        lot:
          component.lotKind === 'unattributed'
            ? {
                kind: 'unattributed',
                reason: required(component.lotReason, 'the unattributed lot reason'),
              }
            : component.lotKind === 'existing'
              ? {
                  kind: 'existing',
                  lotId: required(component.lotId, 'the existing lot'),
                  reason: required(component.lotReason, 'the existing lot mapping reason'),
                }
              : {
                  kind: 'new',
                  lotKey: component.key,
                  name: required(component.lotName, 'the new lot name'),
                  supplier: required(
                    supplier ?? '',
                    'the known supplier before creating a supplier lot'
                  ),
                  lotNumber: required(
                    component.componentBatch,
                    'the actual supplier component batch'
                  ),
                  managementReason: required(
                    component.managementReason,
                    'the local management reason'
                  ),
                },
        quantity:
          component.quantityKind === 'known'
            ? {
                kind: 'known',
                value: required(component.quantity, 'the known amount'),
                unit: component.unit,
              }
            : { kind: 'unknown', unit: component.unit },
        quantityBasis:
          component.quantityKind === 'known'
            ? component.quantityBasis === 'supplier-declared'
              ? { kind: 'supplier-declared', claimKey: component.quantityClaimKey, reason }
              : { kind: 'measurement', reason }
            : { kind: 'unknown', reason },
        stockQuality: {
          value: component.quality,
          reason: required(component.qualityReason, 'the local stock quality reason'),
        },
        vessel,
      };
    }),
  };
  return { sourceText: JSON.stringify(source), options };
}

export function inventoryArrivalDocumentInput(
  document: InventoryArrivalDocumentDraft
): InventoryArrivalDocumentInput {
  if (!document.coverage) throw new Error('Choose full document or an explicitly labeled excerpt.');
  if (!document.body.value) throw new Error('Retain the original supplier document bytes.');
  const input: InventoryArrivalDocumentInput = {
    key: document.key,
    mediaType: document.mediaType,
    body: { ...document.body },
    reference: structuredClone(document.reference),
    coverage:
      document.coverage === 'full'
        ? { kind: 'full' }
        : { kind: 'excerpt', reason: required(document.excerptReason, 'the excerpt scope reason') },
  };
  inventoryArrivalDocumentMetadata(input);
  return input;
}
export function inventoryArrivalDocumentText(
  document: InventoryArrivalDocumentDraft
): string | null {
  if (document.mediaType === 'application/pdf') return null;
  const bytes = inventoryArrivalDocumentBytes({ ...document, coverage: { kind: 'full' } });
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function inventoryArrivalDocumentSelection(
  document: InventoryArrivalDocumentDraft,
  locator: InventoryArrivalEvidenceLocator,
  verbatim: string
): InventoryArrivalSelection {
  const metadata = inventoryArrivalDocumentMetadata(inventoryArrivalDocumentInput(document));
  return {
    documentKey: document.key,
    expectedSha256: metadata.sha256,
    locator: structuredClone(locator),
    verbatim,
  };
}
export function inventoryArrivalTextSelection(
  document: InventoryArrivalDocumentDraft,
  startDOM: number,
  endDOM: number
): InventoryArrivalSelection {
  const text = inventoryArrivalDocumentText(document);
  if (
    text === null ||
    !Number.isSafeInteger(startDOM) ||
    !Number.isSafeInteger(endDOM) ||
    startDOM < 0 ||
    endDOM <= startDOM ||
    endDOM > text.replace(/\r\n?/gu, '\n').length
  )
    throw new Error('Select an exact nonempty range in the retained source text.');
  const sourceOffset = (target: number) => {
    let source = 0,
      dom = 0;
    while (dom < target) {
      source += text[source] === '\r' && text[source + 1] === '\n' ? 2 : 1;
      ++dom;
    }
    return source;
  };
  const startUTF16 = sourceOffset(startDOM),
    endUTF16 = sourceOffset(endDOM);
  const prefix = text.slice(0, startUTF16),
    selected = text.slice(startUTF16, endUTF16),
    encoder = new TextEncoder(),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  if (
    decoder.decode(encoder.encode(prefix)) !== prefix ||
    decoder.decode(encoder.encode(selected)) !== selected
  )
    throw new Error('Select complete source characters without splitting a character.');
  return inventoryArrivalDocumentSelection(
    document,
    {
      kind: 'utf8-byte-range',
      startByte: encoder.encode(prefix).byteLength,
      endByte: encoder.encode(text.slice(0, endUTF16)).byteLength,
    },
    selected
  );
}
export type InventoryArrivalDocumentReadState =
  | { kind: 'idle' }
  | { kind: 'reading'; documentKey: string; generation: number; fileName: string }
  | { kind: 'failed'; documentKey: string; message: string };
type Snapshot = {
  draft: InventoryArrivalDraft;
  documentRead: InventoryArrivalDocumentReadState;
} & (
  | { phase: 'editing' | 'previewing' }
  | {
      phase: 'previewed';
      input: ReturnType<typeof inventoryArrivalDraftInput>;
      preview: InventoryArrivalPreviewSnapshot;
    }
  | { phase: 'failed'; message: string }
);
function savedClaim(value: unknown): InventoryArrivalSupplierClaimInput {
  const record = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Invalid saved delivery supplier statement.');
    return input as Record<string, unknown>;
  };
  const row = record(value),
    subject = record(row.subject),
    selection = record(row.selection),
    locator = record(selection.locator),
    claim = record(row.claim);
  if (
    typeof row.key !== 'string' ||
    typeof selection.documentKey !== 'string' ||
    typeof selection.expectedSha256 !== 'string' ||
    typeof selection.verbatim !== 'string'
  )
    throw new Error('Invalid saved delivery supplier statement fields.');
  if (
    subject.kind !== 'delivery' &&
    !(subject.kind === 'package' && typeof subject.packageKey === 'string') &&
    !(subject.kind === 'component' && typeof subject.componentKey === 'string')
  )
    throw new Error('Invalid saved delivery supplier statement subject.');
  if (
    !(
      (locator.kind === 'utf8-byte-range' &&
        Number.isSafeInteger(locator.startByte) &&
        Number.isSafeInteger(locator.endByte)) ||
      (locator.kind === 'json-pointer' && typeof locator.pointer === 'string') ||
      (locator.kind === 'pdf-region' &&
        Number.isSafeInteger(locator.page1Based) &&
        typeof locator.description === 'string')
    )
  )
    throw new Error('Invalid saved delivery supplier statement locator.');
  if (
    !(
      (claim.kind === 'quantity' &&
        typeof claim.valueLexeme === 'string' &&
        typeof claim.unitText === 'string') ||
      (claim.kind === 'supplier-qc' && typeof claim.resultText === 'string') ||
      (claim.kind === 'identifier' &&
        ['product', 'packaging-batch', 'component-batch'].includes(String(claim.role)) &&
        typeof claim.value === 'string') ||
      (claim.kind === 'date-or-condition' && typeof claim.text === 'string')
    )
  )
    throw new Error('Invalid saved delivery supplier statement value.');
  return value as InventoryArrivalSupplierClaimInput;
}
function savedDraft(version: unknown, value: unknown): InventoryArrivalDraft {
  if ((version !== 1 && version !== 2) || !value || typeof value !== 'object')
    throw new Error('Invalid saved delivery draft.');
  const row = value as Record<string, unknown>,
    baseline = initialDraft();
  for (const key of Object.keys(baseline)) {
    if (key === 'documents' || key === 'claims' || key === 'components') continue;
    if (typeof row[key] !== typeof baseline[key as keyof InventoryArrivalDraft])
      throw new Error('Invalid saved delivery draft fields.');
  }
  if (!Array.isArray(row.components) || !row.components.length)
    throw new Error('Invalid saved delivery draft components.');
  const components = row.components.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid saved delivery component.');
    const component = value as Record<string, unknown>;
    for (const key of Object.keys(newArrivalComponent(''))) {
      if (version === 1 && (key === 'quantityBasis' || key === 'quantityClaimKey')) continue;
      if (typeof component[key] !== 'string') throw new Error('Invalid saved delivery component.');
    }
    if (
      version === 2 &&
      !['measurement', 'supplier-declared'].includes(String(component.quantityBasis))
    )
      throw new Error('Invalid saved delivery component amount basis.');
    return version === 1
      ? { ...component, quantityBasis: 'measurement', quantityClaimKey: '' }
      : component;
  });
  let documents: InventoryArrivalDocumentDraft[];
  if (version === 1) {
    if (
      ['documentText', 'documentCoverage', 'excerptReason'].some(
        (key) => typeof row[key] !== 'string'
      )
    )
      throw new Error('Invalid saved delivery document.');
    if (!['', 'full', 'excerpt'].includes(String(row.documentCoverage)))
      throw new Error('Invalid saved delivery document coverage.');
    documents = [
      {
        ...newArrivalDocument('document-1'),
        body: { encoding: 'utf8', value: row.documentText as string },
        coverage: row.documentCoverage as InventoryArrivalDocumentDraft['coverage'],
        excerptReason: row.excerptReason as string,
      },
    ];
  } else {
    if (!Array.isArray(row.documents) || !Array.isArray(row.claims))
      throw new Error('Invalid saved delivery evidence.');
    documents = row.documents.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid saved delivery document.');
      const document = value as InventoryArrivalDocumentDraft;
      if (
        typeof document.key !== 'string' ||
        !['text/plain', 'text/csv', 'application/json', 'application/pdf'].includes(
          document.mediaType
        ) ||
        !document.body ||
        !['utf8', 'base64'].includes(document.body.encoding) ||
        typeof document.body.value !== 'string' ||
        !['', 'full', 'excerpt'].includes(document.coverage) ||
        typeof document.excerptReason !== 'string' ||
        (document.fileName !== null && typeof document.fileName !== 'string') ||
        (document.reference !== null && typeof document.reference !== 'object')
      )
        throw new Error('Invalid saved delivery document fields.');
      if (document.body.value) {
        if (document.mediaType === 'application/pdf' && document.body.encoding !== 'base64')
          throw new Error('Invalid saved binary delivery document.');
        const bytes = inventoryArrivalDocumentBytes({ ...document, coverage: { kind: 'full' } });
        if (document.mediaType !== 'application/pdf')
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      }
      return document;
    });
    row.claims = row.claims.map(savedClaim);
  }
  const { documentText, documentCoverage, excerptReason, ...fields } = row;
  return {
    ...fields,
    documents,
    claims: version === 1 ? [] : row.claims,
    components,
  } as unknown as InventoryArrivalDraft;
}
function removeStaleClaims(
  previous: InventoryArrivalDraft,
  next: InventoryArrivalDraft
): InventoryArrivalDraft {
  const changedDocuments = new Set(
    previous.documents
      .filter(
        (document) =>
          JSON.stringify(document) !==
          JSON.stringify(next.documents.find((item) => item.key === document.key))
      )
      .map((document) => document.key)
  );
  const previousClaims = new Set(previous.claims.map((claim) => claim.key)),
    documentKeys = new Set(next.documents.map((document) => document.key)),
    componentKeys = new Set(next.components.map((component) => component.key));
  const claims = next.claims.filter(
    (claim) =>
      documentKeys.has(claim.selection.documentKey) &&
      !(previousClaims.has(claim.key) && changedDocuments.has(claim.selection.documentKey)) &&
      (claim.subject.kind !== 'component' || componentKeys.has(claim.subject.componentKey)) &&
      (claim.subject.kind !== 'package' || Boolean(next.packageLabel.trim()))
  );
  const claimKeys = new Set(claims.map((claim) => claim.key));
  return {
    ...next,
    claims,
    components: next.components.map((component) =>
      component.quantityClaimKey && !claimKeys.has(component.quantityClaimKey)
        ? { ...component, quantityClaimKey: '' }
        : component
    ),
  };
}
export class InventoryArrivalSession {
  private current: Snapshot;
  private generation = 0;
  private documentGeneration = 0;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly client: InventoryClient,
    private readonly scope: { project: string; inventoryId: string },
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
  ) {
    let draft = initialDraft();
    try {
      const saved = storage?.getItem(this.storageKey());
      if (saved) {
        const parsed = JSON.parse(saved) as { version?: unknown; draft?: unknown };
        draft = savedDraft(parsed.version, parsed.draft);
      }
      this.current = { phase: 'editing', draft, documentRead: { kind: 'idle' } };
    } catch (cause) {
      this.current = {
        phase: 'failed',
        draft,
        documentRead: { kind: 'idle' },
        message:
          cause instanceof Error ? cause.message : 'The saved delivery draft could not be read.',
      };
    }
  }
  private storageKey() {
    return `dnaforge.inventory.arrival-draft.v1:${JSON.stringify(this.scope)}`;
  }
  private save(draft: InventoryArrivalDraft) {
    if (!this.storage) throw new Error('Delivery recovery storage is unavailable.');
    this.storage.setItem(this.storageKey(), JSON.stringify({ version: 2, draft }));
  }
  getSnapshot = (): Snapshot => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(snapshot: Snapshot) {
    this.current = snapshot;
    for (const listener of this.listeners) listener();
  }
  edit(input: InventoryArrivalDraft) {
    ++this.generation;
    ++this.documentGeneration;
    const draft = structuredClone(removeStaleClaims(this.current.draft, input));
    try {
      this.save(draft);
      this.publish({ phase: 'editing', draft, documentRead: { kind: 'idle' } });
    } catch {
      this.publish({
        phase: 'failed',
        draft,
        documentRead: { kind: 'idle' },
        message: 'The delivery recovery draft could not be saved. Check storage before receiving.',
      });
    }
  }
  newDelivery() {
    this.edit(initialDraft());
  }
  cancelDocumentRead() {
    ++this.generation;
    ++this.documentGeneration;
    if (this.current.documentRead.kind !== 'idle' || this.current.phase === 'previewing')
      this.publish({ phase: 'editing', draft: this.current.draft, documentRead: { kind: 'idle' } });
  }
  async readDocumentFile(
    key: string,
    file: { name: string; type: string; arrayBuffer(): Promise<ArrayBuffer> },
    mediaType: InventoryArrivalDocumentInput['mediaType']
  ) {
    const generation = ++this.documentGeneration;
    ++this.generation;
    if (!this.current.draft.documents.some((document) => document.key === key)) return;
    this.publish({
      phase: 'editing',
      draft: this.current.draft,
      documentRead: { kind: 'reading', documentKey: key, generation, fileName: file.name },
    });
    try {
      if (!['text/plain', 'text/csv', 'application/json', 'application/pdf'].includes(mediaType))
        throw new Error('Choose a supported retained document format.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (generation !== this.documentGeneration) return;
      if (!bytes.byteLength) throw new Error('The selected source file is empty.');
      if (bytes.byteLength > 17 * 1024 * 1024)
        throw new Error(
          'The source file exceeds the native whole-request byte limit before encoding.'
        );
      if (mediaType !== 'application/pdf') new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      const body = { encoding: 'base64' as const, value: btoa(binary) };
      this.edit({
        ...this.current.draft,
        documents: this.current.draft.documents.map((document) =>
          document.key === key ? { ...document, mediaType, body, fileName: file.name } : document
        ),
      });
    } catch (cause) {
      if (generation !== this.documentGeneration) return;
      const message =
        cause instanceof Error ? cause.message : 'The source file could not be retained.';
      this.publish({
        phase: 'editing',
        draft: this.current.draft,
        documentRead: { kind: 'failed', documentKey: key, message },
      });
    }
  }
  async preview() {
    if (this.current.documentRead.kind !== 'idle') return;
    const generation = ++this.generation,
      draft = this.current.draft;
    try {
      this.save(draft);
      const input = inventoryArrivalDraftInput(draft);
      this.publish({ phase: 'previewing', draft, documentRead: { kind: 'idle' } });
      const preview = await this.client.previewArrival({ ...this.scope, ...input });
      if (generation !== this.generation) return;
      if (
        preview.target.projectId !== this.scope.project ||
        preview.target.inventoryId !== this.scope.inventoryId
      )
        throw new Error('The delivery preview belongs to another project or inventory.');
      this.publish({ phase: 'previewed', draft, input, preview, documentRead: { kind: 'idle' } });
    } catch (cause) {
      if (generation === this.generation)
        this.publish({
          phase: 'failed',
          draft,
          documentRead: { kind: 'idle' },
          message: cause instanceof Error ? cause.message : 'The delivery could not be previewed.',
        });
    }
  }
}
