import { parseUniqueJson } from '@waypoint/scientific-objects/unique-json';
import { inventoryScientificReferences } from './inventory-adoption';
import { parseInventoryState } from './inventory-validation';
import type { InventoryState } from './inventory-types';
import type {
  InventoryArchiveArtifact,
  InventoryArchiveCapture,
  InventoryArchiveContent,
  InventoryArchiveJournalEntry,
  InventoryArchiveRuntime,
  InventoryArchiveSha256,
  InventoryArchiveSource,
  InventoryImportBindingObservation,
  InventoryImportPreview,
  InventoryImportPreviewInput,
  InventoryImportRecordGroup,
  InventoryImportTarget,
  InventoryPortabilityIssue,
  InventoryResolvedImportBinding,
  InventoryScientificReference,
  InventoryValidatedArchive,
} from './inventory-archive-types';

export const INVENTORY_ARCHIVE_SCHEMA = 'dnaforge.inventory-export.v1' as const;
export const INVENTORY_ARCHIVE_PARSER = 'dnaforge.inventory-archive-parser.v1' as const;
export const MAX_INVENTORY_ARCHIVE_DEPTH = 8;
const JSON_DEPTH = 64;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const encoder = new TextEncoder();

export class InventoryArchiveError extends TypeError {
  readonly code = 'INVALID_INVENTORY_ARCHIVE';

  constructor(readonly issues: readonly InventoryPortabilityIssue[]) {
    super(issues[0]?.message ?? 'The inventory archive is invalid.');
    this.name = 'InventoryArchiveError';
  }
}

function fail(code: string, pointer: string, message: string): never {
  throw new InventoryArchiveError([{ code, pointer, message }]);
}

export function canonicalInventoryArchiveValue(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => compare(a, b)))
      : entry
  );
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function object(value: unknown, keys: readonly string[], pointer: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('INVALID_ARCHIVE_SHAPE', pointer, 'An archive object is required.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    return fail('INVALID_ARCHIVE_SHAPE', pointer, `Expected exactly: ${keys.join(', ')}.`);
  return row;
}

function text(value: unknown, pointer: string, maxLength = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string' || !value.length || value.length > maxLength)
    return fail('INVALID_ARCHIVE_TEXT', pointer, 'A nonempty bounded text value is required.');
  return value;
}

function identity(value: unknown, pointer: string, maxLength: number): string {
  const result = text(value, pointer, maxLength);
  if (!result.trim() || result.includes('\0'))
    return fail('INVALID_ARCHIVE_IDENTITY', pointer, 'A nonempty exact identity is required.');
  return result;
}

function integer(value: unknown, pointer: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    return fail('INVALID_ARCHIVE_INTEGER', pointer, 'A bounded nonnegative integer is required.');
  return value;
}

function hash(value: unknown, pointer: string): InventoryArchiveSha256 {
  if (typeof value !== 'string' || !HASH.test(value))
    return fail('INVALID_ARCHIVE_HASH', pointer, 'A SHA-256 content digest is required.');
  return value as InventoryArchiveSha256;
}

function json(text: string, pointer: string): unknown {
  try {
    return parseUniqueJson(text, { maxDepth: JSON_DEPTH });
  } catch (error) {
    return fail(
      'INVALID_ARCHIVE_JSON',
      pointer,
      error instanceof Error ? error.message : 'The archive contains invalid JSON.'
    );
  }
}

function references(value: unknown): readonly InventoryScientificReference[] {
  if (!Array.isArray(value))
    return fail(
      'INVALID_REFERENCE_MANIFEST',
      '/content/scientificReferences',
      'Scientific references must be an array.'
    );
  return value.map((entry, index) => {
    const pointer = `/content/scientificReferences/${index}`;
    const row = object(entry, ['materialId', 'pointers'], pointer);
    if (!Array.isArray(row.pointers) || !row.pointers.length)
      return fail(
        'INVALID_REFERENCE_MANIFEST',
        `${pointer}/pointers`,
        'Reference locations are required.'
      );
    return {
      materialId: identity(row.materialId, `${pointer}/materialId`, 512),
      pointers: row.pointers.map((value, index) => text(value, `${pointer}/pointers/${index}`)),
    };
  });
}

function source(value: unknown): InventoryArchiveSource {
  const row = object(
    value,
    ['projectId', 'inventoryId', 'revision', 'storedSchema'],
    '/content/source'
  );
  return {
    projectId: identity(row.projectId, '/content/source/projectId', 4096),
    inventoryId: identity(row.inventoryId, '/content/source/inventoryId', 256),
    revision: integer(row.revision, '/content/source/revision'),
    storedSchema:
      row.storedSchema === null
        ? null
        : text(row.storedSchema, '/content/source/storedSchema', 128),
  };
}

function history(value: unknown): readonly InventoryArchiveJournalEntry[] {
  if (!Array.isArray(value))
    return fail(
      'INVALID_ARCHIVE_HISTORY',
      '/content/history',
      'The complete history array is required.'
    );
  const operationIds = new Set<string>();
  return value.map((entry, index) => {
    const pointer = `/content/history/${index}`;
    const row = object(
      entry,
      ['operationId', 'revision', 'requestJson', 'requestSha256', 'receiptJson', 'receiptSha256'],
      pointer
    );
    const operationId = identity(row.operationId, `${pointer}/operationId`, 256);
    if (operationIds.has(operationId))
      return fail(
        'DUPLICATE_OPERATION',
        `${pointer}/operationId`,
        'An operation identity occurs more than once.'
      );
    operationIds.add(operationId);
    const revision = integer(row.revision, `${pointer}/revision`, 1);
    if (revision !== index + 1)
      return fail(
        'HISTORY_GAP',
        `${pointer}/revision`,
        'History must cover each revision exactly once in order.'
      );
    return {
      operationId,
      revision,
      requestJson: text(row.requestJson, `${pointer}/requestJson`),
      requestSha256: hash(row.requestSha256, `${pointer}/requestSha256`),
      receiptJson: text(row.receiptJson, `${pointer}/receiptJson`),
      receiptSha256: hash(row.receiptSha256, `${pointer}/receiptSha256`),
    };
  });
}

export function parseInventoryArchive(
  sourceText: string,
  runtime: InventoryArchiveRuntime,
  options: { readonly depth?: number; readonly allowRunValueAttributions?: boolean } = {}
): InventoryValidatedArchive {
  const depth = options.depth ?? 0;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_INVENTORY_ARCHIVE_DEPTH)
    return fail('ARCHIVE_NESTING_LIMIT', '', 'The retained archive history is nested too deeply.');
  if (sourceText.length > runtime.maxBytes)
    return fail(
      'ARCHIVE_TOO_LARGE',
      '',
      'The archive exceeds the supported encoded transport size.'
    );
  const bytes = encoder.encode(sourceText);
  if (bytes.byteLength > runtime.maxBytes)
    return fail(
      'ARCHIVE_TOO_LARGE',
      '',
      'The archive exceeds the supported encoded transport size.'
    );
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== sourceText)
    return fail('INVALID_ARCHIVE_UTF8', '', 'The archive requires exact valid UTF-8 text.');
  const outer = object(json(sourceText, ''), ['schema', 'content', 'contentSha256'], '');
  if (outer.schema !== INVENTORY_ARCHIVE_SCHEMA)
    return fail(
      'UNSUPPORTED_ARCHIVE_SCHEMA',
      '/schema',
      'The inventory archive version is unsupported.'
    );
  const row = object(
    outer.content,
    ['source', 'state', 'history', 'scientificReferences'],
    '/content'
  );
  const scope = source(row.source);
  const journal = history(row.history);
  const scientificReferences = references(row.scientificReferences);
  const contentSha256 = hash(outer.contentSha256, '/contentSha256');
  if (runtime.sha256(canonicalInventoryArchiveValue(outer.content)) !== contentSha256)
    return fail(
      'ARCHIVE_HASH_MISMATCH',
      '/contentSha256',
      'The archive content hash does not match.'
    );
  let state: InventoryState | null;
  let snapshot: InventoryArchiveContent['state'];
  if (
    row.state &&
    typeof row.state === 'object' &&
    !Array.isArray(row.state) &&
    Reflect.get(row.state, 'kind') === 'absent'
  ) {
    object(row.state, ['kind'], '/content/state');
    if (
      scope.revision !== 0 ||
      scope.storedSchema !== null ||
      journal.length ||
      scientificReferences.length
    )
      return fail(
        'ABSENT_ARCHIVE_HAS_DATA',
        '/content',
        'An absent inventory cannot contain recorded state or history.'
      );
    state = null;
    snapshot = { kind: 'absent' };
  } else {
    const saved = object(row.state, ['kind', 'json', 'sha256'], '/content/state');
    if (saved.kind !== 'present')
      return fail(
        'INVALID_ARCHIVE_SNAPSHOT',
        '/content/state/kind',
        'An absent or present snapshot is required.'
      );
    const stateJson = text(saved.json, '/content/state/json');
    const stateSha256 = hash(saved.sha256, '/content/state/sha256');
    if (runtime.sha256(stateJson) !== stateSha256)
      return fail(
        'STATE_HASH_MISMATCH',
        '/content/state/sha256',
        'The saved state hash does not match.'
      );
    const decodedState = json(stateJson, '/content/state/json');
    try {
      state = parseInventoryState(decodedState);
    } catch (error) {
      return fail(
        'INVALID_ARCHIVE_STATE',
        '/content/state/json',
        error instanceof Error ? error.message : 'The saved state is invalid.'
      );
    }
    if (
      scope.revision < 1 ||
      state.revision !== scope.revision ||
      journal.length !== scope.revision ||
      scope.storedSchema !== Reflect.get(decodedState as object, 'schema')
    )
      return fail(
        'INCOMPLETE_ARCHIVE_HISTORY',
        '/content',
        'The snapshot and complete history must agree on schema and revision.'
      );
    const parsedJournal = journal.map((entry, index) => {
      const pointer = `/content/history/${index}`;
      if (runtime.sha256(entry.requestJson) !== entry.requestSha256)
        return fail(
          'REQUEST_HASH_MISMATCH',
          `${pointer}/requestSha256`,
          'The stored request hash does not match.'
        );
      if (runtime.sha256(entry.receiptJson) !== entry.receiptSha256)
        return fail(
          'RECEIPT_HASH_MISMATCH',
          `${pointer}/receiptSha256`,
          'The stored receipt hash does not match.'
        );
      return {
        ...entry,
        request: json(entry.requestJson, `${pointer}/requestJson`),
        receipt: json(entry.receiptJson, `${pointer}/receiptJson`),
      };
    });
    let replayed: InventoryState;
    try {
      replayed = runtime.replayJournal({
        source: scope,
        rows: parsedJournal,
        depth,
        ...(options.allowRunValueAttributions === undefined
          ? {}
          : { allowRunValueAttributions: options.allowRunValueAttributions }),
      });
    } catch (error) {
      if (error instanceof InventoryArchiveError) throw error;
      return fail(
        'INVALID_ARCHIVE_JOURNAL',
        '/content/history',
        error instanceof Error ? error.message : 'The native journal could not be verified.'
      );
    }
    if (canonicalInventoryArchiveValue(replayed) !== canonicalInventoryArchiveValue(state))
      return fail(
        'ARCHIVE_REPLAY_MISMATCH',
        '/content/state/json',
        'The saved snapshot differs from its complete accepted history.'
      );
    if (
      canonicalInventoryArchiveValue(inventoryScientificReferences(state)) !==
      canonicalInventoryArchiveValue(scientificReferences)
    )
      return fail(
        'REFERENCE_MANIFEST_MISMATCH',
        '/content/scientificReferences',
        'The scientific reference manifest does not match the recorded facts.'
      );
    snapshot = { kind: 'present', json: stateJson, sha256: stateSha256 };
  }
  return {
    sourceText,
    sourceSha256: runtime.sha256(sourceText),
    document: {
      schema: INVENTORY_ARCHIVE_SCHEMA,
      content: { source: scope, state: snapshot, history: journal, scientificReferences },
      contentSha256,
    },
    state,
  };
}

export function createInventoryArchive(
  capture: InventoryArchiveCapture,
  runtime: InventoryArchiveRuntime
): InventoryArchiveArtifact {
  const decodedState = capture.state ? json(capture.state.json, '/content/state/json') : null;
  const state = decodedState === null ? null : parseInventoryState(decodedState);
  const content: InventoryArchiveContent = {
    source: {
      projectId: capture.projectId,
      inventoryId: capture.inventoryId,
      revision: capture.state?.revision ?? 0,
      storedSchema:
        decodedState === null ? null : (Reflect.get(decodedState as object, 'schema') as string),
    },
    state: capture.state
      ? { kind: 'present', json: capture.state.json, sha256: runtime.sha256(capture.state.json) }
      : { kind: 'absent' },
    history: capture.history.map((row) => ({
      ...row,
      requestSha256: runtime.sha256(row.requestJson),
      receiptSha256: runtime.sha256(row.receiptJson),
    })),
    scientificReferences: state ? inventoryScientificReferences(state) : [],
  };
  const contentSha256 = runtime.sha256(canonicalInventoryArchiveValue(content));
  const sourceText = canonicalInventoryArchiveValue({
    schema: INVENTORY_ARCHIVE_SCHEMA,
    content,
    contentSha256,
  });
  const parsed = parseInventoryArchive(sourceText, runtime);
  return {
    schema: 'dnaforge.inventory-export-artifact.v1',
    source: parsed.document.content.source,
    sourceText,
    sourceSha256: parsed.sourceSha256,
    contentSha256,
  };
}

const RECORD_KINDS: readonly InventoryImportRecordGroup['kind'][] = [
  'storage',
  'vessels',
  'stocks',
  'lots',
  'reservations',
  'typeVersions',
  'recipeVersions',
  'fitEvidence',
  'itemCodes',
  'temperatureClaims',
  'equipmentSetpoints',
  'storageRequirements',
  'thermalContexts',
  'tableBindings',
  'observations',
  'hierarchyBindings',
  'vesselBindings',
];

function previewFacts(archive: InventoryValidatedArchive, input: InventoryImportPreviewInput) {
  const state = archive.state;
  return {
    schema: 'dnaforge.inventory-import-preview.v1' as const,
    sourceSha256: archive.sourceSha256,
    target: { ...input.target },
    source: archive.document.content.source,
    sourceRecordedAt: state?.lastRecordedAt ?? null,
    sourceHistoryEntries: archive.document.content.history.length,
    scientificReferences: archive.document.content.scientificReferences,
    bindings: [...input.bindings].sort(
      (a, b) =>
        compare(a.sourceMaterialId, b.sourceMaterialId) ||
        compare(a.destinationMaterialId, b.destinationMaterialId)
    ),
    records: state
      ? RECORD_KINDS.map((kind) => ({ kind, ids: Object.keys(state[kind]).sort(compare) }))
      : [],
    responsibilities: {
      activeReservationIds: state
        ? Object.values(state.reservations)
            .filter((row) => row.lifecycle.kind === 'active')
            .map((row) => row.id)
            .sort(compare)
        : [],
      unavailableItems: state
        ? [
            ...Object.values(state.storage)
              .filter((row) => row.custody.kind !== 'available')
              .map((row) => ({ kind: 'storage' as const, id: row.id })),
            ...Object.values(state.vessels)
              .filter((row) => row.kind === 'movable' && row.custody.kind !== 'available')
              .map((row) => ({ kind: 'vessel' as const, id: row.id })),
          ].sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`))
        : [],
    },
  };
}

export function inventoryImportFailurePreview(
  sourceText: string,
  target: InventoryImportTarget,
  issues: readonly InventoryPortabilityIssue[],
  runtime: Pick<InventoryArchiveRuntime, 'sha256'>
): InventoryImportPreview {
  return {
    schema: 'dnaforge.inventory-import-preview.v1',
    kind: 'blocked',
    sourceSha256: runtime.sha256(sourceText),
    target: { ...target },
    source: null,
    sourceRecordedAt: null,
    sourceHistoryEntries: 0,
    scientificReferences: [],
    bindings: [],
    records: [],
    responsibilities: { activeReservationIds: [], unavailableItems: [] },
    issues: structuredClone(issues),
    planDigest: null,
    options: null,
  };
}

export function inventoryImportPreview(
  archive: InventoryValidatedArchive,
  input: InventoryImportPreviewInput,
  runtime: Pick<InventoryArchiveRuntime, 'sha256'>
): InventoryImportPreview {
  const facts = previewFacts(archive, input);
  if (!archive.state)
    return { ...facts, kind: 'no-change', issues: [], planDigest: null, options: null };
  const issues: InventoryPortabilityIssue[] = [];
  const issue = (code: string, pointer: string, message: string) =>
    issues.push({ code, pointer, message });
  const references = new Set(facts.scientificReferences.map((entry) => entry.materialId));
  const referencePointers = new Map(
    facts.scientificReferences.map((entry, index) => [
      entry.materialId,
      `/content/scientificReferences/${index}/materialId`,
    ])
  );
  const choices = new Map<string, { destinationMaterialId: string; pointer: string }>();
  const destinations = new Set<string>();
  for (const [index, binding] of input.options.bindings.entries()) {
    const pointer = `/options/bindings/${index}`;
    if (choices.has(binding.sourceMaterialId))
      issue(
        'DUPLICATE_SCIENTIFIC_BINDING',
        pointer,
        'Each source scientific identity requires one binding.'
      );
    else
      choices.set(binding.sourceMaterialId, {
        destinationMaterialId: binding.destinationMaterialId,
        pointer,
      });
    if (!references.has(binding.sourceMaterialId))
      issue(
        'EXTRANEOUS_SCIENTIFIC_BINDING',
        pointer,
        'The source scientific identity is not referenced by this archive.'
      );
    if (destinations.has(binding.destinationMaterialId))
      issue(
        'NONINJECTIVE_SCIENTIFIC_BINDINGS',
        pointer,
        'Distinct source identities require distinct destination identities.'
      );
    destinations.add(binding.destinationMaterialId);
  }
  const observed = new Map<string, InventoryImportBindingObservation>();
  for (const binding of input.bindings) {
    if (observed.has(binding.sourceMaterialId))
      issue(
        'DUPLICATE_BINDING_OBSERVATION',
        '/bindings',
        'A scientific binding was observed more than once.'
      );
    observed.set(binding.sourceMaterialId, binding);
  }
  const resolved: InventoryResolvedImportBinding[] = [];
  for (const materialId of [...references].sort(compare)) {
    const choice = choices.get(materialId);
    const observation = observed.get(materialId);
    const pointer = referencePointers.get(materialId)!;
    if (!choice) {
      issue(
        'UNRESOLVED_SCIENTIFIC_REFERENCE',
        pointer,
        'Choose an explicit destination for this scientific identity.'
      );
      continue;
    }
    if (
      !observation ||
      observation.destinationMaterialId !== choice.destinationMaterialId ||
      observation.kind !== 'admitted'
    ) {
      issue(
        'SCIENTIFIC_BINDING_UNAVAILABLE',
        choice.pointer,
        observation?.kind === 'unavailable'
          ? observation.reason
          : 'The destination scientific identity is not currently admitted.'
      );
      continue;
    }
    resolved.push({
      sourceMaterialId: materialId,
      destinationMaterialId: choice.destinationMaterialId,
      fingerprint: observation.fingerprint,
    });
  }
  for (const id of observed.keys())
    if (!references.has(id) || !choices.has(id))
      issue(
        'EXTRANEOUS_BINDING_OBSERVATION',
        '/bindings',
        'A scientific observation does not belong to the selected source bindings.'
      );
  if (input.target.present)
    issue(
      'IMPORT_TARGET_POPULATED',
      '/target',
      'Native archive adoption requires an absent inventory.'
    );
  if (!input.target.present && input.target.revision !== 0)
    issue(
      'INVALID_IMPORT_TARGET',
      '/target/revision',
      'An absent inventory must have revision zero.'
    );
  if (!Number.isSafeInteger(input.asOf) || input.asOf < 0)
    issue('NATIVE_CLOCK_UNAVAILABLE', '/asOf', 'The native acceptance clock is unavailable.');
  else if (archive.state && archive.state.lastRecordedAt > input.asOf)
    issue(
      'SOURCE_CLOCK_IN_FUTURE',
      '/content/state/json#/lastRecordedAt',
      'The source recorded clock is later than native acceptance time.'
    );
  if (issues.length) return { ...facts, kind: 'blocked', issues, planDigest: null, options: null };
  const options = { bindings: resolved };
  const planDigest = runtime.sha256(
    canonicalInventoryArchiveValue({
      schema: 'dnaforge.inventory-import-plan.v1',
      parser: INVENTORY_ARCHIVE_PARSER,
      sourceSha256: archive.sourceSha256,
      target: facts.target,
      options,
    })
  );
  return { ...facts, kind: 'ready', issues: [], planDigest, options };
}
