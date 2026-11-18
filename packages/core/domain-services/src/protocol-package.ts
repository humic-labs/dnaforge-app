import { parseUniqueJson } from '@waypoint/scientific-objects/unique-json';
import { defineBlob } from '@waypoint/workspace-revisions';
import { assertProtocolDocumentStructure } from './protocol-document-structure';
import { assertProtocolRunStructure } from './protocol-run-model';
import {
  canonicalPaperProtocolReviewPayload,
  parsePaperProtocolWorkflow,
} from './paper-protocol-model';

export { assertProtocolDocumentStructure } from './protocol-document-structure';
export { assertProtocolRunStructure } from './protocol-run-model';

type JsonRecord = Record<string, unknown>;
type Sha256 = `sha256:${string}`;
export interface ParsedProtocolPackage {
  readonly kind: 'protocol' | 'protocol_run';
  readonly id: string;
  readonly title: string;
  readonly raw: JsonRecord;
}
export interface ProtocolSavedSource {
  readonly schema: 'dnaforge.protocol-saved-source.v1';
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly protocolId: string;
  readonly fileObjectUuid: string;
  readonly title: string;
  readonly originalText: string;
}
export interface ProtocolExecutionDefinition {
  readonly definition: JsonRecord;
  readonly definitionSha256: Sha256;
  readonly declaredVersion: unknown;
  readonly paperAcceptedVersion: null | {
    readonly acceptedVersionId: string;
    readonly contentHash: string;
  };
}
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be an object.`);
  return value as JsonRecord;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new TypeError(`${label} must be nonempty source text.`);
  return value;
}
function digest(value: unknown, label: string): Sha256 {
  if (typeof value !== 'string' || !SHA256.test(value))
    throw new TypeError(`${label} requires SHA-256.`);
  return value as Sha256;
}
function hash(text: string): Sha256 {
  return defineBlob(new TextEncoder().encode(text)).hash;
}
function numericMeaning(value: string): string {
  const matched = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (!matched) throw new TypeError('Protocol source contains an invalid numeric token.');
  const digits = (matched[2] + (matched[3] ?? '')).replace(/^0+/u, '');
  if (!digits) return '0';
  const exponent = Number(matched[4] ?? 0) - (matched[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent))
    throw new TypeError('Protocol numeric precision is unsupported.');
  const significant = digits.replace(/0+$/u, '');
  return `${matched[1]}${significant}e${exponent + digits.length - significant.length}`;
}
function sourceNumber(token: string): number {
  const value = Number(token);
  if (!Number.isFinite(value) || numericMeaning(token) !== numericMeaning(String(value)))
    throw new TypeError(
      'Protocol source numeric precision cannot be preserved; retain exact values as text.'
    );
  return value;
}
export function canonicalProtocolJson(value: unknown): string {
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(visit);
    if (
      value &&
      typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    )
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, visit((value as JsonRecord)[key])])
      );
    throw new TypeError('Protocol canonical values must be complete finite JSON.');
  };
  return JSON.stringify(visit(value));
}
export function protocolSavedSourceSha256(source: ProtocolSavedSource): Sha256 {
  return hash(canonicalProtocolJson(source));
}
function parseBase(
  textValue: string,
  purpose: 'saved-source' | 'display' = 'saved-source'
): ParsedProtocolPackage {
  if (
    typeof textValue !== 'string' ||
    !textValue.length ||
    new TextEncoder().encode(textValue).byteLength > 256 * 1024 * 1024
  )
    throw new TypeError('Protocol source exceeds the native scientific document read limit.');
  if (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(textValue)
    ) !== textValue
  )
    throw new TypeError('Protocol source must preserve exact UTF-8.');
  const raw = record(
    parseUniqueJson(textValue, { maxDepth: 64, numberReader: sourceNumber }),
    'Protocol package'
  );
  if (raw.kind === 'protocol' && raw.schema === 'dnaforge.protocol.v1') {
    if (purpose === 'saved-source') assertProtocolDocumentStructure(raw);
    if (raw.paperProtocol !== undefined && raw.paperProtocol !== null)
      parsePaperProtocolWorkflow(
        raw.paperProtocol,
        (raw.steps as JsonRecord[]).map((step) => String(step.id))
      );
  } else if (raw.kind === 'protocol_run' && raw.schema === 'dnaforge.protocol-run.v1') {
    if (purpose === 'saved-source') assertProtocolRunStructure(raw);
  } else throw new TypeError('Unsupported Protocol package schema.');
  if (purpose === 'saved-source' || (raw.provenance !== undefined && raw.provenance !== null))
    record(raw.provenance, 'Protocol provenance');
  return {
    kind: raw.kind,
    id: text(raw.id, 'Protocol package ID'),
    title: text(raw.title, 'Protocol title'),
    raw,
  };
}
export function protocolExecutionDefinition(originalText: string): ProtocolExecutionDefinition {
  const parsed = parseBase(originalText);
  if (parsed.kind !== 'protocol')
    throw new TypeError('Execution definitions require a Protocol source.');
  let definition = parsed.raw,
    paperAcceptedVersion: ProtocolExecutionDefinition['paperAcceptedVersion'] = null;
  if (definition.paperProtocol !== undefined && definition.paperProtocol !== null) {
    const workflow = parsePaperProtocolWorkflow(
      definition.paperProtocol,
      (definition.steps as JsonRecord[]).map((step) => String(step.id))
    );
    if (workflow.draft.state !== 'finalized')
      throw new TypeError('Finalize the paper Protocol before starting a run.');
    const accepted = workflow.acceptedVersions.at(-1);
    const canonical = canonicalPaperProtocolReviewPayload(definition);
    if (
      !accepted ||
      accepted.draftRevision !== workflow.draft.revision ||
      accepted.contentHash !== hash(canonical) ||
      canonicalProtocolJson(accepted.payload) !== canonical
    )
      throw new TypeError(
        'The finalized paper Protocol does not match its accepted execution payload.'
      );
    definition = record(
      parseUniqueJson(canonical, { maxDepth: 64, numberReader: sourceNumber }),
      'Accepted Protocol definition'
    );
    paperAcceptedVersion = {
      acceptedVersionId: accepted.acceptedVersionId,
      contentHash: accepted.contentHash,
    };
  }
  return {
    definition,
    definitionSha256: hash(canonicalProtocolJson(definition)),
    declaredVersion: structuredClone(parsed.raw.version),
    paperAcceptedVersion,
  };
}
export function protocolExecutionDefinitionSha256(originalText: string): Sha256 {
  return protocolExecutionDefinition(originalText).definitionSha256;
}
function validateNativeExtensions(parsed: ParsedProtocolPackage): void {
  const frozen = parsed.raw.frozenProtocol;
  if (frozen !== undefined) {
    if (parsed.kind !== 'protocol_run')
      throw new TypeError('Frozen execution belongs to a Protocol Run.');
    const snapshot = record(frozen, 'Frozen Protocol'),
      source = record(snapshot.source, 'Frozen Protocol source');
    if (
      snapshot.schema !== 'dnaforge.protocol-execution-snapshot.v1' ||
      source.kind !== 'native-observed-saved-source'
    )
      throw new TypeError('Unsupported frozen Protocol source.');
    const originalText = text(source.originalText, 'Original Protocol source'),
      protocol = parseBase(originalText);
    if (protocol.kind !== 'protocol')
      throw new TypeError('Frozen source must identify a Protocol.');
    const packet: ProtocolSavedSource = {
      schema: 'dnaforge.protocol-saved-source.v1',
      projectId: text(source.projectId, 'Protocol source project'),
      workspaceScope: text(source.workspaceScope, 'Protocol source scope'),
      protocolId: text(source.protocolId, 'Protocol source identity'),
      fileObjectUuid: text(source.fileObjectUuid, 'Protocol source file identity'),
      title: protocol.title,
      originalText,
    };
    const execution = protocolExecutionDefinition(originalText);
    if (
      digest(source.fileSha256, 'Protocol file digest') !== hash(originalText) ||
      digest(source.sourceSha256, 'Protocol source digest') !== protocolSavedSourceSha256(packet) ||
      digest(snapshot.definitionSha256, 'Protocol execution digest') !==
        execution.definitionSha256 ||
      canonicalProtocolJson(snapshot.declaredVersion) !==
        canonicalProtocolJson(execution.declaredVersion) ||
      canonicalProtocolJson(snapshot.paperAcceptedVersion) !==
        canonicalProtocolJson(execution.paperAcceptedVersion)
    )
      throw new TypeError('Frozen Protocol source or execution definition changed.');
    const pin = record(parsed.raw.protocol, 'Run protocol pin');
    if (
      pin.pinnedVersionHash !== execution.definitionSha256 ||
      pin.destinationId !== packet.protocolId ||
      pin.pinnedVersionId !== `saved-${execution.definitionSha256.slice(7)}`
    )
      throw new TypeError('Native Run protocol pin must identify its frozen execution definition.');
  }
  if (parsed.raw.creation !== undefined) {
    const creation = record(parsed.raw.creation, 'Native Protocol creation');
    const schema =
      parsed.kind === 'protocol'
        ? 'dnaforge.protocol-creation.v1'
        : 'dnaforge.protocol-run-creation.v1';
    if (
      creation.schema !== schema ||
      text(creation.portableId, 'Created portable identity') !== parsed.id ||
      !Number.isFinite(Date.parse(text(creation.createdAt, 'Creation time')))
    )
      throw new TypeError('Native Protocol creation identity is invalid.');
    text(creation.requestId, 'Creation request');
    text(creation.fileObjectUuid, 'Created file identity');
    digest(creation.intentSha256, 'Creation intent');
    if (
      parsed.kind === 'protocol_run' &&
      (frozen === undefined ||
        digest(creation.frozenProtocolSha256, 'Frozen creation digest') !==
          hash(canonicalProtocolJson(frozen)))
    )
      throw new TypeError('Native Run creation must retain its original frozen Protocol.');
  }
}
export function parseProtocolPackage(originalText: string): ParsedProtocolPackage {
  const parsed = parseBase(originalText);
  validateNativeExtensions(parsed);
  return parsed;
}
export function parseProtocolPackageForDisplay(originalText: string): ParsedProtocolPackage {
  const parsed = parseBase(originalText, 'display');
  validateNativeExtensions(parsed);
  return parsed;
}
