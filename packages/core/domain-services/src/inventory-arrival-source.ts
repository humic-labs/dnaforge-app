import { defineBlob } from '@waypoint/workspace-revisions';
import {
  parseUniqueJson,
  parseUniqueJsonWithNumberLexemes,
} from '@waypoint/scientific-objects/unique-json';
import { normalizeInventoryQuantity } from './inventory-quantity';
import { inventoryTableCanonicalJson, inventoryTableSha256 } from './inventory-table-binding';
import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';
import type {
  InventoryArrivalChoices,
  InventoryArrivalComponentChoice,
  InventoryArrivalDocumentInput,
  InventoryArrivalDocumentMetadata,
  InventoryArrivalIdentity,
  InventoryArrivalRecordedSupplierClaim,
  InventoryArrivalSource,
  InventoryArrivalSupplierClaimInput,
  InventoryArrivalDocumentRead,
  InventoryArrivalDocumentReadInput,
  InventoryArrival,
} from './inventory-arrival-types';

export class InventoryArrivalInputError extends Error {
  constructor(
    readonly code: string,
    readonly pointer: string,
    message: string
  ) {
    super(message);
  }
}
export function arrivalFail(code: string, pointer: string, message: string): never {
  throw new InventoryArrivalInputError(code, pointer, message);
}
export function arrivalShape(
  value: unknown,
  keys: readonly string[],
  pointer: string
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    arrivalFail(
      'ARRIVAL_INPUT_INVALID',
      pointer,
      `Expected exactly these fields: ${keys.join(', ')}.`
    );
  return value as Record<string, unknown>;
}
export function arrivalText(value: unknown, pointer: string, max = 1024): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    arrivalFail(
      'ARRIVAL_INPUT_INVALID',
      pointer,
      `Expected nonempty text of at most ${max} characters without null characters.`
    );
}
function textOrNull(value: unknown, pointer: string) {
  if (value !== null) arrivalText(value, pointer);
}
function reason(value: unknown, pointer: string) {
  arrivalText(value, pointer, 2000);
}
function integer(value: unknown, pointer: string, min = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min)
    arrivalFail('ARRIVAL_INPUT_INVALID', pointer, 'Expected a safe nonnegative integer.');
}
function array(value: unknown, pointer: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > 10000)
    arrivalFail('ARRIVAL_INPUT_INVALID', pointer, 'Expected an array of at most10000 records.');
}
function unique(rows: readonly { readonly key: string }[], pointer: string) {
  if (new Set(rows.map((row) => row.key)).size !== rows.length)
    arrivalFail(
      'ARRIVAL_DUPLICATE_KEY',
      pointer,
      'Source keys must be distinct within each collection.'
    );
}
function sourceReference(value: unknown, pointer: string) {
  if (value === null) return;
  const row = arrivalShape(
    value,
    ['url', 'title', 'locator', 'readAt', 'documentRevision', 'sha256'],
    pointer
  );
  arrivalText(row.url, `${pointer}/url`, 4000);
  if (row.url.trim() !== row.url || !/^https?:\/\//u.test(row.url))
    arrivalFail(
      'ARRIVAL_SOURCE_REFERENCE_INVALID',
      pointer,
      'A source reference requires an exact HTTP or HTTPS URL.'
    );
  arrivalText(row.title, `${pointer}/title`, 512);
  arrivalText(row.locator, `${pointer}/locator`, 2000);
  arrivalText(row.readAt, `${pointer}/readAt`, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(row.readAt))
    arrivalFail(
      'ARRIVAL_SOURCE_REFERENCE_INVALID',
      pointer,
      'The source read date requires exact YYYY-MM-DD text.'
    );
  if (row.documentRevision !== null)
    arrivalText(row.documentRevision, `${pointer}/documentRevision`, 512);
  if (
    row.sha256 !== null &&
    (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256))
  )
    arrivalFail(
      'ARRIVAL_SOURCE_REFERENCE_INVALID',
      pointer,
      'An external source hash requires 64 lowercase hexadecimal characters.'
    );
}

function placement(value: unknown, pointer: string) {
  const row = value as Record<string, unknown>;
  if (row?.kind === 'unplaced') {
    arrivalShape(value, ['kind'], pointer);
    return;
  }
  arrivalShape(value, ['kind', 'storageId', 'slotId'], pointer);
  if (row.kind !== 'located')
    arrivalFail(
      'ARRIVAL_INPUT_INVALID',
      pointer,
      'A new vessel requires an explicit located or unplaced choice.'
    );
  arrivalText(row.storageId, `${pointer}/storageId`);
  arrivalText(row.slotId, `${pointer}/slotId`, 512);
}
export function inventoryArrivalId(identity: InventoryArrivalIdentity): string {
  arrivalShape(identity, ['namespace', 'arrivalId'], '/identity');
  arrivalText(identity.namespace, '/identity/namespace', 64);
  arrivalText(identity.arrivalId, '/identity/arrivalId');
  if (!/^[a-z][a-z0-9._:-]{0,63}$(?![\s\S])/u.test(identity.namespace))
    arrivalFail(
      'ARRIVAL_NAMESPACE_INVALID',
      '/identity/namespace',
      'The arrival namespace requires a lowercase technical identifier.'
    );
  return `arrival:${inventoryTableSha256(inventoryTableCanonicalJson(['dnaforge.inventory-arrival.v1', identity.namespace, identity.arrivalId])).slice(7)}`;
}
export function inventoryArrivalPhysicalIds(
  target: Pick<InventoryTableTarget, 'projectId' | 'inventoryId'>,
  identity: InventoryArrivalIdentity,
  kind: 'stock' | 'vessel' | 'lot',
  key: string
): string {
  return `arrival-${kind}:${inventoryTableSha256(inventoryTableCanonicalJson(['dnaforge.inventory-arrival-physical.v1', target.projectId, target.inventoryId, identity, kind, key])).slice(7)}`;
}
export function inventoryArrivalDocumentBytes(document: InventoryArrivalDocumentInput): Uint8Array {
  const { body } = document;
  if (body.encoding === 'utf8') {
    const bytes = new TextEncoder().encode(body.value);
    if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== body.value)
      arrivalFail(
        'ARRIVAL_DOCUMENT_INVALID',
        '/documents/body',
        'Text must round-trip exact UTF-8 without replacement.'
      );
    return bytes;
  }
  const value = body.value;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
    arrivalFail(
      'ARRIVAL_DOCUMENT_INVALID',
      '/documents/body',
      'Binary source bodies require canonical base64.'
    );
  const decoded = atob(value);
  if (btoa(decoded) !== value)
    arrivalFail(
      'ARRIVAL_DOCUMENT_INVALID',
      '/documents/body',
      'Binary source bodies require canonical base64.'
    );
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
export function inventoryArrivalDocumentMetadata(
  input: InventoryArrivalDocumentInput
): InventoryArrivalDocumentMetadata {
  const row = arrivalShape(
    input,
    ['key', 'mediaType', 'body', 'reference', 'coverage'],
    '/documents'
  );
  arrivalText(row.key, '/documents/key');
  if (
    !['text/plain', 'text/csv', 'application/json', 'application/pdf'].includes(
      String(row.mediaType)
    )
  )
    arrivalFail(
      'ARRIVAL_DOCUMENT_INVALID',
      '/documents/mediaType',
      'Unsupported source media type.'
    );
  const body = arrivalShape(row.body, ['encoding', 'value'], '/documents/body');
  if (
    !['utf8', 'base64'].includes(String(body.encoding)) ||
    typeof body.value !== 'string' ||
    !body.value.length
  )
    arrivalFail(
      'ARRIVAL_DOCUMENT_INVALID',
      '/documents/body',
      'A retained original source body is required.'
    );
  if (row.mediaType === 'application/pdf' && body.encoding !== 'base64')
    arrivalFail(
      'ARRIVAL_DOCUMENT_INVALID',
      '/documents/body',
      'PDF documents retain original binary bytes in canonical base64.'
    );
  const coverage = row.coverage as Record<string, unknown>;
  if (coverage?.kind === 'full') arrivalShape(coverage, ['kind'], '/documents/coverage');
  else {
    arrivalShape(coverage, ['kind', 'reason'], '/documents/coverage');
    if (coverage.kind !== 'excerpt')
      arrivalFail(
        'ARRIVAL_DOCUMENT_INVALID',
        '/documents/coverage',
        'Declare full document or excerpt coverage.'
      );
    reason(coverage.reason, '/documents/coverage/reason');
  }
  sourceReference(row.reference, '/documents/reference');
  const bytes = inventoryArrivalDocumentBytes(input);
  if (input.mediaType !== 'application/pdf') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      arrivalFail(
        'ARRIVAL_DOCUMENT_INVALID',
        '/documents/body',
        'Text source bytes must be valid UTF-8.'
      );
    }
  }
  return {
    key: input.key,
    mediaType: input.mediaType,
    reference: structuredClone(input.reference),
    coverage: structuredClone(input.coverage),
    sha256: defineBlob(bytes).hash,
    byteLength: bytes.byteLength,
  };
}
function selectedText(
  document: InventoryArrivalDocumentInput,
  claim: InventoryArrivalSupplierClaimInput
): string | null {
  const selection = claim.selection,
    locator = selection.locator,
    bytes = inventoryArrivalDocumentBytes(document);
  if (locator.kind === 'pdf-region') {
    arrivalShape(locator, ['kind', 'page1Based', 'description'], '/claims/selection/locator');
    integer(locator.page1Based, '/claims/selection/locator/page1Based', 1);
    reason(locator.description, '/claims/selection/locator/description');
    if (document.mediaType !== 'application/pdf')
      arrivalFail(
        'ARRIVAL_SELECTION_INVALID',
        '/claims/selection',
        'PDF region citations require retained PDF bytes.'
      );
    return null;
  }
  if (document.mediaType === 'application/pdf')
    arrivalFail(
      'ARRIVAL_SELECTION_INVALID',
      '/claims/selection',
      'PDF quotes are explicit operator citations, not verified text extraction.'
    );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (locator.kind === 'utf8-byte-range') {
    arrivalShape(locator, ['kind', 'startByte', 'endByte'], '/claims/selection/locator');
    integer(locator.startByte, '/claims/selection/locator/startByte');
    integer(locator.endByte, '/claims/selection/locator/endByte');
    if (locator.endByte <= locator.startByte || locator.endByte > bytes.byteLength)
      arrivalFail(
        'ARRIVAL_SELECTION_INVALID',
        '/claims/selection',
        'The selected byte range must exist and contain complete characters.'
      );
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.slice(locator.startByte, locator.endByte)
      );
    } catch {
      return arrivalFail(
        'ARRIVAL_SELECTION_INVALID',
        '/claims/selection',
        'The selected byte range splits a UTF-8 character.'
      );
    }
  }
  arrivalShape(locator, ['kind', 'pointer'], '/claims/selection/locator');
  if (
    locator.kind !== 'json-pointer' ||
    document.mediaType !== 'application/json' ||
    typeof locator.pointer !== 'string' ||
    (locator.pointer !== '' && !locator.pointer.startsWith('/')) ||
    /~(?![01])/u.test(locator.pointer)
  )
    arrivalFail(
      'ARRIVAL_SELECTION_INVALID',
      '/claims/selection',
      'A JSON selection requires an exact valid pointer into retained JSON.'
    );
  const parsed = parseUniqueJsonWithNumberLexemes(text, { maxDepth: 32, maxNumbers: 100000 });
  const numeric = parsed.numberLexemes.get(locator.pointer);
  if (numeric !== undefined) return numeric;
  let node: unknown = parsed.value;
  for (const key of locator.pointer === ''
    ? []
    : locator.pointer
        .slice(1)
        .split('/')
        .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key))
      arrivalFail(
        'ARRIVAL_SELECTION_INVALID',
        '/claims/selection',
        'The selected JSON pointer does not exist.'
      );
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node === 'string') return node;
  if (node === null || typeof node === 'boolean') return JSON.stringify(node);
  return arrivalFail(
    'ARRIVAL_SELECTION_INVALID',
    '/claims/selection',
    'Select a scalar JSON value; numeric lexemes remain exact.'
  );
}
export function inventoryArrivalRecordedClaims(
  source: InventoryArrivalSource
): readonly InventoryArrivalRecordedSupplierClaim[] {
  const documents = new Map(source.documents.map((document) => [document.key, document]));
  return source.claims.map((claim) => {
    arrivalShape(claim, ['key', 'subject', 'selection', 'claim'], '/claims');
    arrivalText(claim.key, '/claims/key');
    const subject = claim.subject;
    if (subject.kind === 'delivery') arrivalShape(subject, ['kind'], '/claims/subject');
    else if (subject.kind === 'package') {
      arrivalShape(subject, ['kind', 'packageKey'], '/claims/subject');
      if (!source.packages.some((row) => row.key === subject.packageKey))
        arrivalFail(
          'ARRIVAL_SUBJECT_INVALID',
          '/claims/subject',
          'The claim package must exist in this arrival.'
        );
    } else {
      arrivalShape(subject, ['kind', 'componentKey'], '/claims/subject');
      if (
        subject.kind !== 'component' ||
        !source.components.some((row) => row.key === subject.componentKey)
      )
        arrivalFail(
          'ARRIVAL_SUBJECT_INVALID',
          '/claims/subject',
          'The claim component must exist in this arrival.'
        );
    }
    arrivalShape(
      claim.selection,
      ['documentKey', 'expectedSha256', 'locator', 'verbatim'],
      '/claims/selection'
    );
    arrivalText(claim.selection.verbatim, '/claims/selection/verbatim', 65536);
    const document = documents.get(claim.selection.documentKey);
    if (
      !document ||
      inventoryArrivalDocumentMetadata(document).sha256 !== claim.selection.expectedSha256
    )
      arrivalFail(
        'ARRIVAL_SOURCE_MISSING',
        '/claims/selection',
        'The selected retained document and exact hash must match.'
      );
    const actual = selectedText(document, claim);
    if (actual !== null && actual !== claim.selection.verbatim)
      arrivalFail(
        'ARRIVAL_SELECTION_INVALID',
        '/claims/selection',
        'The quoted selection must exactly match retained source text.'
      );
    const value = claim.claim;
    if (value.kind === 'quantity') {
      arrivalShape(value, ['kind', 'valueLexeme', 'unitText'], '/claims/claim');
      arrivalText(value.valueLexeme, '/claims/claim/valueLexeme', 128);
      arrivalText(value.unitText, '/claims/claim/unitText', 128);
    } else if (value.kind === 'supplier-qc') {
      arrivalShape(value, ['kind', 'resultText'], '/claims/claim');
      reason(value.resultText, '/claims/claim/resultText');
    } else if (value.kind === 'identifier') {
      arrivalShape(value, ['kind', 'role', 'value'], '/claims/claim');
      if (!['product', 'packaging-batch', 'component-batch'].includes(value.role))
        arrivalFail(
          'ARRIVAL_CLAIM_INVALID',
          '/claims/claim/role',
          'Unsupported supplier identifier role.'
        );
      arrivalText(value.value, '/claims/claim/value');
    } else {
      arrivalShape(value, ['kind', 'text'], '/claims/claim');
      if (value.kind !== 'date-or-condition')
        arrivalFail('ARRIVAL_CLAIM_INVALID', '/claims/claim', 'Unsupported typed supplier claim.');
      reason(value.text, '/claims/claim/text');
    }
    return {
      ...structuredClone(claim),
      verification: actual === null ? 'operator-cited-pdf-region' : 'exact-text-selection',
    };
  });
}
export function parseInventoryArrivalSource(
  sourceText: string,
  maxBytes: number
): InventoryArrivalSource {
  if (
    typeof sourceText !== 'string' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    new TextEncoder().encode(sourceText).byteLength > maxBytes ||
    new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(sourceText)) !==
      sourceText
  )
    arrivalFail(
      'ARRIVAL_SOURCE_INVALID',
      '/sourceText',
      'The exact source packet must be lossless UTF-8 within the inline limit.'
    );
  const source = parseUniqueJson(sourceText, { maxDepth: 32 }) as InventoryArrivalSource;
  arrivalShape(
    source,
    [
      'schema',
      'identity',
      'supplier',
      'observedAt',
      'observationReason',
      'scope',
      'documents',
      'packages',
      'components',
      'claims',
    ],
    '/source'
  );
  if (source.schema !== 'dnaforge.inventory-arrival-source.v1')
    arrivalFail('ARRIVAL_SOURCE_INVALID', '/schema', 'Unsupported actual-arrival source schema.');
  inventoryArrivalId(source.identity);
  if (source.supplier !== null) arrivalText(source.supplier, '/supplier');
  if (source.observedAt !== null) integer(source.observedAt, '/observedAt');
  reason(source.observationReason, '/observationReason');
  arrivalShape(source.scope, ['kind', 'reason'], '/scope');
  if (!['selected-components', 'complete-listed-manifest'].includes(source.scope.kind))
    arrivalFail(
      'ARRIVAL_SCOPE_INVALID',
      '/scope',
      'Declare the selected component or complete listed-manifest scope.'
    );
  reason(source.scope.reason, '/scope/reason');
  for (const key of ['documents', 'packages', 'components', 'claims'] as const)
    array(source[key], `/${key}`);
  if (!source.components.length)
    arrivalFail(
      'ARRIVAL_COMPONENTS_REQUIRED',
      '/components',
      'Record an explicit disposition for at least one component.'
    );
  for (const document of source.documents) inventoryArrivalDocumentMetadata(document);
  for (const item of source.packages) {
    arrivalShape(item, ['key', 'label', 'productCode', 'packagingBatch'], '/packages');
    arrivalText(item.key, '/packages/key');
    arrivalText(item.label, '/packages/label');
    textOrNull(item.productCode, '/packages/productCode');
    textOrNull(item.packagingBatch, '/packages/packagingBatch');
  }
  for (const item of source.components) {
    arrivalShape(
      item,
      ['key', 'packageKey', 'label', 'productCode', 'componentBatch'],
      '/components'
    );
    arrivalText(item.key, '/components/key');
    arrivalText(item.label, '/components/label');
    textOrNull(item.packageKey, '/components/packageKey');
    textOrNull(item.productCode, '/components/productCode');
    textOrNull(item.componentBatch, '/components/componentBatch');
    if (item.packageKey !== null && !source.packages.some((row) => row.key === item.packageKey))
      arrivalFail(
        'ARRIVAL_PACKAGE_NOT_FOUND',
        '/components/packageKey',
        'The component package must exist in this arrival.'
      );
  }
  for (const key of ['documents', 'packages', 'components', 'claims'] as const)
    unique(source[key], `/${key}`);
  inventoryArrivalRecordedClaims(source);
  return source;
}
export function parseInventoryArrivalChoices(input: unknown): InventoryArrivalChoices {
  const row = arrivalShape(input, ['components'], '/options');
  array(row.components, '/options/components');
  const keys = new Set<string>();
  for (const raw of row.components) {
    const choice = raw as InventoryArrivalComponentChoice;
    arrivalText(choice?.componentKey, '/options/components/componentKey');
    if (keys.has(choice.componentKey))
      arrivalFail(
        'ARRIVAL_DUPLICATE_CHOICE',
        '/options/components',
        'Each component needs exactly one choice.'
      );
    keys.add(choice.componentKey);
    if (choice.kind === 'identified') {
      arrivalShape(
        choice,
        [
          'componentKey',
          'kind',
          'materialId',
          'lot',
          'quantity',
          'quantityBasis',
          'stockQuality',
          'vessel',
        ],
        '/options/components'
      );
      arrivalText(choice.materialId, '/options/components/materialId');
      if (choice.lot?.kind === 'existing') {
        arrivalShape(choice.lot, ['kind', 'lotId', 'reason'], '/options/components/lot');
        reason(choice.lot.reason, '/options/components/lot/reason');
        arrivalText(choice.lot.lotId, '/options/components/lot/lotId');
      } else if (choice.lot?.kind === 'unattributed') {
        arrivalShape(choice.lot, ['kind', 'reason'], '/options/components/lot');
        reason(choice.lot.reason, '/options/components/lot/reason');
      } else {
        arrivalShape(
          choice.lot,
          ['kind', 'lotKey', 'name', 'supplier', 'lotNumber', 'managementReason'],
          '/options/components/lot'
        );
        if (choice.lot.kind !== 'new')
          arrivalFail(
            'ARRIVAL_LOT_INVALID',
            '/options/components/lot',
            'Choose an existing or new received lot.'
          );
        for (const key of ['lotKey', 'name', 'supplier', 'lotNumber'])
          arrivalText(choice.lot[key as 'lotKey'], '/options/components/lot/' + key);
        reason(choice.lot.managementReason, '/options/components/lot/managementReason');
      }
      if (choice.quantity?.kind !== 'known' && choice.quantity?.kind !== 'unknown')
        arrivalFail(
          'ARRIVAL_QUANTITY_INVALID',
          '/options/components/quantity',
          'Declare known or unknown quantity explicitly.'
        );
      if (choice.quantity?.kind === 'known')
        arrivalShape(choice.quantity, ['kind', 'value', 'unit'], '/options/components/quantity');
      else arrivalShape(choice.quantity, ['kind', 'unit'], '/options/components/quantity');
      normalizeInventoryQuantity(choice.quantity);
      const basis = choice.quantityBasis;
      arrivalShape(
        basis,
        basis?.kind === 'supplier-declared' ? ['kind', 'claimKey', 'reason'] : ['kind', 'reason'],
        '/options/components/quantityBasis'
      );
      if (!['measurement', 'supplier-declared', 'unknown'].includes(basis.kind))
        arrivalFail(
          'ARRIVAL_QUANTITY_BASIS_INVALID',
          '/options/components/quantityBasis',
          'Declare a measurement, supplier quantity or explicit unknown amount.'
        );
      reason(basis.reason, '/options/components/quantityBasis/reason');
      if (basis.kind === 'supplier-declared')
        arrivalText(basis.claimKey, '/options/components/quantityBasis/claimKey');
      if ((choice.quantity.kind === 'unknown') !== (basis.kind === 'unknown'))
        arrivalFail(
          'ARRIVAL_QUANTITY_BASIS_INVALID',
          '/options/components/quantityBasis',
          'Unknown quantity requires an explicit unknown basis; a known amount requires a measurement or supplier claim.'
        );
      arrivalShape(choice.stockQuality, ['value', 'reason'], '/options/components/stockQuality');
      if (!['usable', 'quarantined'].includes(choice.stockQuality.value))
        arrivalFail(
          'ARRIVAL_QUALITY_INVALID',
          '/options/components/stockQuality',
          'Choose stock local quality explicitly.'
        );
      reason(choice.stockQuality.reason, '/options/components/stockQuality/reason');
    } else if (choice.kind === 'unidentified-physical' || choice.kind === 'unobserved-physical') {
      arrivalShape(choice, ['componentKey', 'kind', 'vessel', 'reason'], '/options/components');
      reason(choice.reason, '/options/components/reason');
    } else {
      arrivalShape(choice, ['componentKey', 'kind', 'reason'], '/options/components');
      if (choice.kind !== 'observed-missing' && choice.kind !== 'evidence-only')
        arrivalFail(
          'ARRIVAL_DISPOSITION_INVALID',
          '/options/components/kind',
          'Choose an explicit component disposition.'
        );
      reason(choice.reason, '/options/components/reason');
    }
    if ('vessel' in choice) {
      arrivalShape(choice.vessel, ['name', 'placement'], '/options/components/vessel');
      arrivalText(choice.vessel.name, '/options/components/vessel/name', 512);
      placement(choice.vessel.placement, '/options/components/vessel/placement');
    }
  }
  return structuredClone(input) as InventoryArrivalChoices;
}
export function inventoryArrivalMaterialChoices(options: InventoryArrivalChoices) {
  return options.components.flatMap((choice) =>
    choice.kind === 'identified'
      ? [{ key: choice.componentKey, materialId: choice.materialId }]
      : []
  );
}
export function readInventoryArrivalDocument(
  arrival: InventoryArrival,
  sourceText: string,
  input: InventoryArrivalDocumentReadInput
): InventoryArrivalDocumentRead {
  try {
    if (input.arrivalId !== arrival.id || inventoryTableSha256(sourceText) !== arrival.sourceSha256)
      arrivalFail(
        'ARRIVAL_SOURCE_UNAVAILABLE',
        '/arrivalId',
        'The retained source packet must match the exact arrival.'
      );
    const source = parseInventoryArrivalSource(
      sourceText,
      new TextEncoder().encode(sourceText).byteLength
    );
    if (inventoryArrivalId(source.identity) !== arrival.id)
      arrivalFail(
        'ARRIVAL_SOURCE_UNAVAILABLE',
        '/arrivalId',
        'The retained source identity differs from the arrival.'
      );
    const document = source.documents.find((value) => value.key === input.documentKey),
      metadata = arrival.documents.find((value) => value.key === input.documentKey);
    if (
      !document ||
      !metadata ||
      metadata.sha256 !== input.expectedSha256 ||
      inventoryArrivalDocumentMetadata(document).sha256 !== metadata.sha256
    )
      arrivalFail(
        'ARRIVAL_DOCUMENT_UNAVAILABLE',
        '/documentKey',
        'The original document and selected hash could not be verified.'
      );
    return {
      kind: 'available',
      arrivalId: arrival.id,
      document: structuredClone(metadata),
      body: structuredClone(document.body),
    };
  } catch (error) {
    return {
      kind: 'unavailable',
      code:
        error instanceof InventoryArrivalInputError ? error.code : 'ARRIVAL_DOCUMENT_UNAVAILABLE',
      message:
        error instanceof Error ? error.message : 'The original source document is unavailable.',
    };
  }
}
