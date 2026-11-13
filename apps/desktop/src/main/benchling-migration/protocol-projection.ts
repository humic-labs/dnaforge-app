import { createHash } from 'node:crypto';
import type { SourceObject } from '../../shared/benchling-migration';
import type {
  NotebookAttachmentBinding,
  NotebookAttachmentReference,
} from './notebook-html-projection';
import {
  assertProtocolDocument,
  type ProtocolDocument,
  protocolRunPin,
  serializeProtocolDocument,
} from './protocol-document';
import {
  mergeProtocolAttachmentReferences,
  projectProtocolHtmlFragment,
  projectProtocolSteps,
} from './protocol-html-fragments';
import {
  normalizeProtocolLinks,
  normalizeProtocolSlots,
  portableProtocolVersionLink,
  type ProtocolProjectionLinkInput,
} from './protocol-source-normalization';
import { isBenchlingLocalExportProvenanceUrn } from './source-identity';

export type { ProtocolProjectionLinkInput } from './protocol-source-normalization';

export type ProtocolProjectionOptions = {
  destinationEntityId?: string;
  capturedAt: string;
  converterVersion: string;
  links: ProtocolProjectionLinkInput[];
  attachments?: NotebookAttachmentBinding[];
  supportedFormulaNames?: readonly string[];
};

export type ProtocolProjection = {
  converterId: 'benchling-protocol-v1';
  converterVersion: string;
  destinationObjectId: string;
  destinationPath: string;
  document: ProtocolDocument;
  text: string;
  protocolRunPin: ReturnType<typeof protocolRunPin>;
  attachmentReferences: NotebookAttachmentReference[];
  warnings: string[];
};

export function buildProtocolProjection(
  sourceObject: SourceObject,
  options: ProtocolProjectionOptions
): ProtocolProjection {
  assertProtocolSourceType(sourceObject.sourceType);
  const capturedAt = requiredTimestamp(options.capturedAt, 'capturedAt');
  const converterVersion = requireText(options.converterVersion, 'converterVersion');
  const source = requireRecord(sourceObject.content, 'Protocol content must be an object.');
  const sourceVersionId = requireText(source.versionId, 'Protocol source version ID');
  const attachments = options.attachments ?? [];
  const supportedFormulaNames = options.supportedFormulaNames ?? [];
  const htmlOptions = { capturedAt, converterVersion, attachments, supportedFormulaNames };
  const overviewHtml = optionalHtml(source.overviewHtml) ?? '<p></p>';

  const overviewProjection = projectProtocolHtmlFragment(
    sourceObject,
    'overview',
    sourceObject.name,
    overviewHtml,
    htmlOptions
  );
  const stepsProjection = projectProtocolSteps(source.steps, sourceObject, htmlOptions);
  const steps = stepsProjection.steps;
  const inputs = normalizeProtocolSlots(source.inputs, 'inputs');
  const outputs = normalizeProtocolSlots(source.outputs, 'outputs');
  const links = normalizeProtocolLinks(options.links);

  const destinationObjectId =
    options.destinationEntityId ?? `protocol-${sha256(sourceObject.stableId).slice(0, 24)}`;
  const pinnedVersionHash = `sha256:${sha256(
    stableJson({
      title: requireText(sourceObject.name, 'Protocol name'),
      overviewHtml,
      steps: stepsProjection.sourceVersionSteps,
      inputs,
      outputs,
      links: links.map(portableProtocolVersionLink),
    })
  )}`;
  const document: ProtocolDocument = {
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: destinationObjectId,
    title: requireText(sourceObject.name, 'Protocol name'),
    editable: true,
    overview: overviewProjection.content,
    steps,
    inputs,
    outputs,
    links,
    version: {
      sourceVersionId,
      pinnedVersionHash,
      immutable: true,
      importedAt: capturedAt,
    },
    provenance: {
      immutableSource: true,
      provider: 'benchling',
      sourceObjectId: requireText(sourceObject.id, 'Source object ID'),
      stableSourceId: requireText(sourceObject.stableId, 'Stable source ID'),
      sourceUrl: sanitizeSourceUrl(sourceObject.sourceUrl),
      sourceSchemaId: optionalText(sourceObject.schemaId),
      sourceCreatedAt: optionalTimestamp(sourceObject.createdAt, 'source createdAt'),
      sourceModifiedAt: optionalTimestamp(sourceObject.modifiedAt, 'source modifiedAt'),
      capturedAt,
    },
  };
  assertProtocolDocument(document);

  const fragmentReferences = [
    ...overviewProjection.attachmentReferences,
    ...stepsProjection.attachmentReferences,
  ];
  const warnings = [...overviewProjection.warnings, ...stepsProjection.warnings];
  const packageStem = safeFileStem(
    `${sourceObject.name}__${sha256(sourceObject.stableId).slice(0, 16)}`
  );

  return {
    converterId: 'benchling-protocol-v1',
    converterVersion,
    destinationObjectId,
    destinationPath: `Benchling Imports/Protocols/${packageStem}/.forge/protocol.json`,
    document,
    text: serializeProtocolDocument(document),
    protocolRunPin: protocolRunPin(document),
    attachmentReferences: mergeProtocolAttachmentReferences(fragmentReferences),
    warnings: [...new Set(warnings)],
  };
}

function assertProtocolSourceType(value: string): void {
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, '_');
  if (!['protocol', 'protocol_template'].includes(normalized)) {
    throw new Error(`Source type "${value}" is not a protocol.`);
  }
}

function sanitizeSourceUrl(value: unknown): string {
  const text = requireText(value, 'Protocol source URL');
  if (isBenchlingLocalExportProvenanceUrn(text)) return text;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('Protocol source URL must be a valid URL.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Protocol source URL must use credential-free HTTPS.');
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function safeFileStem(value: string): string {
  const stem = value
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/_+/g, '_')
    .slice(0, 120);
  return stem || `protocol_${sha256(value).slice(0, 12)}`;
}

function optionalHtml(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireTextValue(value, 'Protocol overview HTML');
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, 'Optional text');
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredTimestamp(value, label);
}

function requiredTimestamp(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(text).toISOString();
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} must be single-line text.`);
  return value.trim();
}

function requireTextValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} requires non-empty text.`);
  }
  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)])
  );
}
