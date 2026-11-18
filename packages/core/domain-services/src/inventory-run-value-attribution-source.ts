import { parseProtocolPackage } from './protocol-package';
import {
  readProtocolRunSlotDeclarations,
  type ProtocolRunSlotDeclarations,
  type ProtocolRunValueOrigin,
} from './protocol-value-edit';
import { inventoryProtocolRunSourceSha256 } from './inventory-scientific-source';
import { inventoryPlatePlanText } from './inventory-plate-plan-definition';
import {
  inventoryRunValueCollection,
  inventoryRunValueJson,
  inventoryRunValueRowSha256,
  parseInventoryRunValueSnapshot,
} from './inventory-run-value-attribution-value';
import type { InventoryProtocolRunSavedSource } from './inventory-scientific-types';
import type {
  InventoryRunValueAttributionComparison,
  InventoryRunValueAttributionEntry,
  InventoryRunValueAttributionSelected,
  InventoryRunValueCandidate,
  InventoryRunValueCandidates,
  InventoryRunValueCollection,
  InventoryRunValueRunHeader,
} from './inventory-run-value-attribution-types';

type Raw = Record<string, unknown>;
function record(value: unknown): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Run values require their complete saved JSON object.');
  return value as Raw;
}
function read(source: InventoryProtocolRunSavedSource) {
  if (source.schema !== 'dnaforge.protocol-run-saved-source.v1')
    throw new TypeError('Choose the existing saved Run1 source packet.');
  for (const value of [
    source.projectId,
    source.workspaceScope,
    source.runId,
    source.fileObjectUuid,
  ])
    inventoryPlatePlanText(value, 1024, 'saved Run identity');
  inventoryPlatePlanText(source.title, 17 * 1024 * 1024, 'saved Run title');
  const parsed = parseProtocolPackage(source.originalText);
  if (
    parsed.kind !== 'protocol_run' ||
    source.runId !== `${source.workspaceScope}::${parsed.id.split('::').at(-1)}` ||
    parsed.title !== source.title
  )
    throw new TypeError('The complete saved Run must match its scoped source identity and title.');
  const run: InventoryRunValueRunHeader = {
    entityId: source.runId,
    projectId: source.projectId,
    workspaceScope: source.workspaceScope,
    fileObjectUuid: source.fileObjectUuid,
    title: source.title,
    sourceSha256: inventoryProtocolRunSourceSha256(source),
  };
  return {
    run,
    raw: parsed.raw,
    declarations: readProtocolRunSlotDeclarations(source.originalText),
  };
}
function origin(
  row: Raw,
  collection: InventoryRunValueCollection,
  declarations: ProtocolRunSlotDeclarations
): ProtocolRunValueOrigin {
  if (collection === 'measurements' || declarations.kind === 'unavailable')
    return { kind: 'local-actual' };
  const declaration = declarations[collection].find(
    (value) => typeof value.key === 'string' && value.key.trim() === row.key
  );
  if (!declaration) return { kind: 'local-actual' };
  if (declaration.key !== row.key)
    throw new TypeError('The frozen declaration has a different legacy key spelling.');
  const kind = record(declaration.valueType).kind;
  if (kind !== 'text' && kind !== 'number' && kind !== 'boolean' && kind !== 'date')
    throw new TypeError('The frozen declaration kind is unsupported for attribution.');
  if (record(row.value).type !== kind)
    throw new TypeError('The saved value does not match its exact frozen declaration type.');
  return { kind: 'frozen-declaration', definitionSha256: declarations.definitionSha256 };
}
function candidate(
  row: Raw,
  collection: InventoryRunValueCollection,
  declarations: ProtocolRunSlotDeclarations
): InventoryRunValueCandidate {
  let derived: ProtocolRunValueOrigin | null = null;
  const copied = inventoryRunValueJson(row) as Raw,
    facts = {
      collection,
      key: String(row.key),
      rowSha256: inventoryRunValueRowSha256(collection, row),
      row: copied,
    };
  try {
    const snapshot = parseInventoryRunValueSnapshot(copied);
    derived = origin(snapshot, collection, declarations);
    return {
      ...facts,
      origin: derived,
      eligibility: { kind: 'eligible', valueKind: snapshot.value.type },
    };
  } catch (error) {
    return {
      ...facts,
      origin: derived,
      eligibility: {
        kind: 'unsupported',
        code: 'RUN_VALUE_UNSUPPORTED',
        message:
          error instanceof Error
            ? error.message
            : 'This saved value is unsupported for attribution.',
      },
    };
  }
}
export function inventoryRunValueCandidates(
  source: InventoryProtocolRunSavedSource
): InventoryRunValueCandidates {
  const captured = read(source),
    rows: InventoryRunValueCandidate[] = [];
  for (const collection of ['inputs', 'outputs', 'measurements'] as const)
    for (const row of captured.raw[collection] as Raw[])
      rows.push(candidate(row, collection, captured.declarations));
  return { run: captured.run, rows };
}
export function inventoryRunValueAttributionSelection(
  source: InventoryProtocolRunSavedSource,
  selection: { readonly collection: InventoryRunValueCollection; readonly key: string }
): InventoryRunValueAttributionSelected {
  inventoryRunValueCollection(selection.collection);
  const captured = read(source),
    row = (captured.raw[selection.collection] as Raw[]).find((row) => row.key === selection.key);
  if (!row) throw new TypeError('The exact saved Run slot is missing.');
  const valueSnapshot = parseInventoryRunValueSnapshot(row),
    derived = origin(valueSnapshot, selection.collection, captured.declarations);
  return {
    runValue: {
      entityId: captured.run.entityId,
      sourceSha256: captured.run.sourceSha256,
      collection: selection.collection,
      key: selection.key,
      rowSha256: inventoryRunValueRowSha256(selection.collection, row),
    },
    source: {
      kind: 'native-observed-saved-source',
      projectId: captured.run.projectId,
      workspaceScope: captured.run.workspaceScope,
      fileObjectUuid: captured.run.fileObjectUuid,
      title: captured.run.title,
    },
    valueSnapshot,
    origin: derived,
  };
}
export function inventoryRunValueAttributionComparison(
  entry: InventoryRunValueAttributionEntry,
  source: InventoryProtocolRunSavedSource | null
): InventoryRunValueAttributionComparison {
  const unavailable = (code: string, message: string): InventoryRunValueAttributionComparison => ({
    kind: 'unavailable',
    code,
    message,
    retryable: false,
  });
  if (!source)
    return unavailable('RUN_SOURCE_UNAVAILABLE', 'The current saved Run source is unavailable.');
  try {
    const captured = read(source),
      attribution = entry.attribution;
    if (
      captured.run.entityId !== attribution.runValue.entityId ||
      captured.run.projectId !== attribution.source.projectId ||
      captured.run.workspaceScope !== attribution.source.workspaceScope
    )
      return unavailable(
        'FOREIGN_RUN_CONTEXT',
        'The original Run context cannot be relocalized to this source.'
      );
    if (captured.run.fileObjectUuid !== attribution.source.fileObjectUuid)
      return { kind: 'replaced-binding', run: captured.run };
    const row = (captured.raw[attribution.runValue.collection] as Raw[]).find(
      (row) => row.key === attribution.runValue.key
    );
    const sameSource = captured.run.sourceSha256 === attribution.runValue.sourceSha256;
    if (!row)
      return sameSource
        ? unavailable(
            'INVENTORY_DATA_INVALID',
            'The unchanged Run source contradicts its recorded row membership.'
          )
        : { kind: 'missing-row', run: captured.run };
    const current = candidate(row, attribution.runValue.collection, captured.declarations),
      sameRow = current.rowSha256 === attribution.runValue.rowSha256;
    if (sameSource && !sameRow)
      return unavailable(
        'INVENTORY_DATA_INVALID',
        'The unchanged Run source contradicts its recorded row hash.'
      );
    return {
      kind: sameSource ? 'same-source' : sameRow ? 'changed-source-same-row' : 'changed-row',
      run: captured.run,
      row: { rowSha256: current.rowSha256, row: current.row, eligibility: current.eligibility },
    };
  } catch (error) {
    return unavailable(
      'RUN_SOURCE_INVALID',
      error instanceof Error ? error.message : 'The current Run source could not be verified.'
    );
  }
}
