import {
  canonicalProtocolJson,
  parseProtocolPackage,
  protocolExecutionDefinition,
} from './protocol-package';
import { parsePaperProtocolWorkflow } from './paper-protocol-model';

export type ProtocolSimpleValueKind = 'text' | 'number' | 'boolean' | 'date';
export type ProtocolSimpleRunValue =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'date'; readonly value: string };
export interface ProtocolSlotDeclarationUpsert {
  readonly direction: 'inputs' | 'outputs';
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly description: string | null;
  readonly valueType: { readonly kind: ProtocolSimpleValueKind };
}
export type ProtocolRunValueOrigin =
  | { readonly kind: 'local-actual' }
  | { readonly kind: 'frozen-declaration'; readonly definitionSha256: `sha256:${string}` };
export interface ProtocolRunValueUpsert {
  readonly collection: 'inputs' | 'outputs' | 'measurements';
  readonly key: string;
  readonly label: string;
  readonly value: ProtocolSimpleRunValue;
  readonly origin: ProtocolRunValueOrigin;
}
export interface ProtocolValueEditResult {
  readonly changed: boolean;
  readonly originalText: string;
}
export interface ProtocolValueEditContext {
  readonly recordedAt: string;
}
export type ProtocolRunSlotDeclarations =
  | {
      readonly kind: 'available';
      readonly definitionSha256: `sha256:${string}`;
      readonly inputs: readonly Readonly<Record<string, unknown>>[];
      readonly outputs: readonly Readonly<Record<string, unknown>>[];
    }
  | { readonly kind: 'unavailable'; readonly reason: string };
export type ProtocolValueEditErrorCode =
  | 'INVALID_EDIT'
  | 'UNSUPPORTED_TARGET'
  | 'ORIGIN_MISMATCH'
  | 'TYPE_MISMATCH'
  | 'IMMUTABLE_DOCUMENT';
export class ProtocolValueEditError extends Error {
  constructor(
    readonly code: ProtocolValueEditErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProtocolValueEditError';
  }
}
type Raw = Record<string, unknown>;
const fail = (code: ProtocolValueEditErrorCode, message: string): never => {
  throw new ProtocolValueEditError(code, message);
};
const supported = (value: unknown): value is ProtocolSimpleValueKind =>
  value === 'text' || value === 'number' || value === 'boolean' || value === 'date';
function object(value: unknown, fields?: readonly string[]): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('INVALID_EDIT', 'An edit must contain an explicit object.');
  if (
    fields &&
    (Object.keys(value).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(value, key)))
  )
    return fail('INVALID_EDIT', 'The edit contains missing or unsupported fields.');
  return value as Raw;
}
function text(
  value: unknown,
  label: string,
  singleLine = true,
  nonblank = true
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (nonblank && !value.trim()) ||
    value.includes('\0') ||
    (singleLine && /[\r\n]/u.test(value)) ||
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(value)
    ) !== value
  )
    fail('INVALID_EDIT', `${label} must preserve valid exact text.`);
}
function date(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    fail('INVALID_EDIT', 'Choose an exact canonical UTC ISO timestamp.');
}
function rows(raw: Raw, collection: string): Raw[] {
  const value = raw[collection];
  if (!Array.isArray(value))
    return fail('INVALID_EDIT', 'The saved document requires its original slot collection.');
  return value.map((row) => object(row));
}
function targetIndex(source: readonly Raw[], key: string): number {
  const index = source.findIndex((row) => typeof row.key === 'string' && row.key.trim() === key);
  if (index !== -1 && source[index].key !== key)
    fail(
      'UNSUPPORTED_TARGET',
      'This legacy key has a different saved spelling and cannot be retargeted here.'
    );
  return index;
}
function targets(upserts: readonly unknown[], collectionField: 'direction' | 'collection') {
  if (!Array.isArray(upserts) || upserts.length < 1 || upserts.length > 100)
    fail('INVALID_EDIT', 'Supply between one and 100 explicit upserts.');
  const seen = new Set<string>();
  for (const upsert of upserts) {
    const row = object(upsert);
    if (typeof row.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(row.key))
      fail('INVALID_EDIT', 'A slot key must retain its exact portable identity.');
    const collection = row[collectionField];
    if (
      collection !== 'inputs' &&
      collection !== 'outputs' &&
      !(collectionField === 'collection' && collection === 'measurements')
    )
      fail('INVALID_EDIT', 'Choose an explicit supported slot collection.');
    const target = `${collection}/${row.key}`;
    if (seen.has(target))
      fail('INVALID_EDIT', 'A request cannot target the same slot more than once.');
    seen.add(target);
  }
}
function simpleValue(value: ProtocolSimpleRunValue): void {
  const row = object(value, ['type', 'value']);
  if (!supported(row.type))
    fail('INVALID_EDIT', 'This editor supports Text, Number, Yes or no, and Date only.');
  if (row.type === 'text') text(row.value, 'Text value', false, false);
  else if (row.type === 'number') {
    if (
      typeof row.value !== 'number' ||
      !Number.isFinite(row.value) ||
      (Number.isInteger(row.value) && !Number.isSafeInteger(row.value))
    )
      fail(
        'INVALID_EDIT',
        'A new numeric value must be finite and preserve safe integer precision.'
      );
  } else if (row.type === 'boolean') {
    if (typeof row.value !== 'boolean') fail('INVALID_EDIT', 'Choose an actual Yes or No value.');
  } else date(row.value);
}
function finish(originalText: string, raw: Raw, changed: boolean): ProtocolValueEditResult {
  if (!changed) return { changed: false, originalText };
  const result = `${canonicalProtocolJson(raw)}\n`;
  parseProtocolPackage(result);
  return { changed: true, originalText: result };
}
export function readProtocolRunSlotDeclarations(originalText: string): ProtocolRunSlotDeclarations {
  const parsed = parseProtocolPackage(originalText);
  if (parsed.kind !== 'protocol_run')
    return fail('INVALID_EDIT', 'Declared Run values require a saved Protocol Run.');
  if (!parsed.raw.frozenProtocol)
    return { kind: 'unavailable', reason: 'This Run has no retained frozen Protocol definition.' };
  const frozen = object(parsed.raw.frozenProtocol),
    source = object(frozen.source),
    execution = protocolExecutionDefinition(String(source.originalText));
  return {
    kind: 'available',
    definitionSha256: execution.definitionSha256,
    inputs: structuredClone(rows(execution.definition, 'inputs')),
    outputs: structuredClone(rows(execution.definition, 'outputs')),
  };
}
export function editProtocolSlotDeclarations(
  originalText: string,
  upserts: readonly ProtocolSlotDeclarationUpsert[]
): ProtocolValueEditResult {
  targets(upserts, 'direction');
  const parsed = parseProtocolPackage(originalText);
  if (parsed.kind !== 'protocol')
    return fail('INVALID_EDIT', 'Edit declarations on a saved Protocol.');
  if (parsed.raw.editable !== true)
    return fail('IMMUTABLE_DOCUMENT', 'This Protocol is not editable.');
  const raw = structuredClone(parsed.raw);
  const workflow = raw.paperProtocol
    ? parsePaperProtocolWorkflow(
        raw.paperProtocol,
        (raw.steps as Raw[]).map((row) => String(row.id))
      )
    : null;
  if (workflow?.draft.state === 'finalized')
    return fail(
      'IMMUTABLE_DOCUMENT',
      'Reopen the finalized paper Protocol before changing declarations.'
    );
  let changed = false;
  for (const upsert of upserts) {
    object(upsert, ['direction', 'key', 'label', 'required', 'description', 'valueType']);
    text(upsert.label, 'Declaration label');
    if (upsert.description !== null) text(upsert.description, 'Declaration description');
    if (typeof upsert.required !== 'boolean')
      fail('INVALID_EDIT', 'Required must be an explicit boolean.');
    object(upsert.valueType, ['kind']);
    if (!supported(upsert.valueType.kind))
      fail('INVALID_EDIT', 'Choose a supported declaration type.');
    const list = rows(raw, upsert.direction),
      index = targetIndex(list, upsert.key),
      previous = index === -1 ? null : list[index];
    if (previous) {
      const kind = object(previous.valueType).kind;
      if (!supported(kind))
        fail('UNSUPPORTED_TARGET', 'This saved declaration type is read only here.');
      if (kind !== upsert.valueType.kind)
        fail('TYPE_MISMATCH', 'A saved declaration type cannot be changed here.');
    }
    const next = {
      ...previous,
      key: upsert.key,
      label: upsert.label,
      required: upsert.required,
      description: upsert.description,
      valueType: { ...(previous ? object(previous.valueType) : {}), kind: upsert.valueType.kind },
    };
    if (!previous || canonicalProtocolJson(previous) !== canonicalProtocolJson(next)) {
      changed = true;
      if (index === -1) list.push(next);
      else list[index] = next;
      raw[upsert.direction] = list;
    }
  }
  if (changed && workflow) {
    if (!Number.isSafeInteger(workflow.draft.revision + 1))
      fail('INVALID_EDIT', 'The paper draft revision cannot advance safely.');
    const paper = object(raw.paperProtocol),
      draft = object(paper.draft);
    paper.draft = { ...draft, state: 'draft', revision: workflow.draft.revision + 1 };
  }
  return finish(originalText, raw, changed);
}
export function editProtocolRunValues(
  originalText: string,
  upserts: readonly ProtocolRunValueUpsert[],
  context?: ProtocolValueEditContext
): ProtocolValueEditResult {
  targets(upserts, 'collection');
  if (context) {
    object(context, ['recordedAt']);
    date(context.recordedAt);
  }
  const parsed = parseProtocolPackage(originalText);
  if (parsed.kind !== 'protocol_run')
    return fail('INVALID_EDIT', 'Record actual values on a saved Protocol Run.');
  if (parsed.raw.status !== 'in_progress' || parsed.raw.immutable !== false)
    return fail('IMMUTABLE_DOCUMENT', 'Completed Protocol Runs cannot be edited.');
  const declarations = readProtocolRunSlotDeclarations(originalText),
    raw = structuredClone(parsed.raw);
  let changed = false;
  for (const upsert of upserts) {
    object(upsert, ['collection', 'key', 'label', 'value', 'origin']);
    text(upsert.label, 'Actual-value label');
    simpleValue(upsert.value);
    const origin = object(upsert.origin);
    if (origin.kind === 'local-actual') object(origin, ['kind']);
    else if (origin.kind === 'frozen-declaration') object(origin, ['kind', 'definitionSha256']);
    else fail('ORIGIN_MISMATCH', 'Choose an explicit local or frozen-declaration origin.');
    const declaredRows =
      declarations.kind === 'available' && upsert.collection !== 'measurements'
        ? declarations[upsert.collection]
        : [];
    const declarationIndex = targetIndex(declaredRows, upsert.key),
      declaration = declarationIndex === -1 ? null : declaredRows[declarationIndex];
    if (origin.kind === 'frozen-declaration') {
      if (
        upsert.collection === 'measurements' ||
        declarations.kind !== 'available' ||
        origin.definitionSha256 !== declarations.definitionSha256
      )
        fail('ORIGIN_MISMATCH', 'Choose the exact frozen declaration and definition pin.');
      if (!declaration) return fail('ORIGIN_MISMATCH', 'Choose the exact frozen declaration key.');
      const kind = object(declaration.valueType).kind;
      if (!supported(kind))
        fail('UNSUPPORTED_TARGET', 'This frozen declaration type is read only here.');
      if (kind !== upsert.value.type)
        fail('TYPE_MISMATCH', 'The actual value must match the frozen declaration type.');
    } else if (declaration)
      fail('ORIGIN_MISMATCH', 'A local actual cannot shadow a frozen declaration key.');
    const list = rows(raw, upsert.collection),
      index = targetIndex(list, upsert.key),
      previous = index === -1 ? null : list[index];
    if (previous) {
      const kind = object(previous.value).type;
      if (!supported(kind))
        fail('UNSUPPORTED_TARGET', 'This saved actual-value type is read only here.');
      if (kind !== upsert.value.type)
        fail('TYPE_MISMATCH', 'A saved actual-value type cannot be changed here.');
    }
    const next: Raw = {
      ...previous,
      key: upsert.key,
      label: upsert.label,
      value: { ...(previous ? object(previous.value) : {}), ...upsert.value },
    };
    if (!previous || canonicalProtocolJson(previous) !== canonicalProtocolJson(next)) {
      if (upsert.collection === 'measurements' && context) next.recordedAt = context.recordedAt;
      changed = true;
      if (index === -1) list.push(next);
      else list[index] = next;
      raw[upsert.collection] = list;
    }
  }
  return finish(originalText, raw, changed);
}
