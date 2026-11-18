import {
  assertProtocolRunStructure,
  normalizeProtocol,
  normalizeSlots,
  normalizeMeasurements,
  normalizeValue,
  normalizeTables,
  normalizeLinks,
  normalizeStatus,
  normalizeAmendmentPath,
  sanitizeHttpUrl,
  columnLabel,
  requiredTimestamp,
  optionalTimestamp,
  requireText,
  optionalText,
  requireRecord,
  assertNullableText,
  assertNullableTimestamp,
} from '@waypoint/domain-services/protocol-run-model';
import type {
  ProtocolRunAmendment,
  ProtocolRunDocument as ProtocolRunCoreDocument,
} from '@waypoint/domain-services/protocol-run-model';
export type {
  ProtocolRunStatus,
  ProtocolRunValue,
  ProtocolRunSlot,
  ProtocolRunMeasurement,
  ProtocolRunTableCell,
  ProtocolRunTable,
  ProtocolRunLink,
  ProtocolRunAmendment,
} from '@waypoint/domain-services/protocol-run-model';
import { createHash } from 'node:crypto';
import type { SourceObject } from '../../shared/benchling-migration';

export const PROTOCOL_RUN_DOCUMENT_SCHEMA = 'dnaforge.protocol-run.v1' as const;

export type ProtocolRunDocument = Omit<ProtocolRunCoreDocument, 'provenance'> & {
  provenance: {
    immutableSource: true;
    provider: 'benchling';
    sourceObjectId: string;
    stableSourceId: string;
    sourceUrl: string;
    sourceSchemaId: string | null;
    sourceCreatedAt: string | null;
    sourceModifiedAt: string | null;
    capturedAt: string;
  };
};
export type ProtocolRunProjection = {
  converterId: 'benchling-protocol-run-v1';
  converterVersion: string;
  destinationObjectId: string;
  destinationPath: string;
  document: ProtocolRunDocument;
  text: string;
  warnings: string[];
};

export type ProtocolRunProjectionOptions = {
  destinationEntityId?: string;
  capturedAt: string;
  converterVersion: string;
};

export function buildProtocolRunProjection(
  sourceObject: SourceObject,
  options: ProtocolRunProjectionOptions
): ProtocolRunProjection {
  if (!isProtocolRunSourceType(sourceObject.sourceType)) {
    throw new Error(`Source type "${sourceObject.sourceType}" is not a protocol execution.`);
  }
  const content = requireRecord(sourceObject.content, 'Protocol run content must be an object.');
  const status = normalizeStatus(content.status);
  const protocol = normalizeProtocol(content.protocol);
  const inputs = normalizeSlots(content.inputs, 'inputs');
  const outputs = normalizeSlots(content.outputs, 'outputs');
  const measurements = normalizeMeasurements(content.measurements);
  const tables = normalizeTables(content.tables);
  const links = normalizeLinks(content.links);
  const startedAt = optionalTimestamp(content.startedAt, 'startedAt');
  const completedAt = optionalTimestamp(content.completedAt, 'completedAt');

  if (status === 'completed' && !completedAt) {
    throw new Error('A completed protocol run requires completedAt.');
  }
  if (status === 'in_progress' && completedAt) {
    throw new Error('An in-progress protocol run cannot have completedAt.');
  }
  if (startedAt && completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error('Protocol run completedAt cannot precede startedAt.');
  }

  const destinationObjectId =
    options.destinationEntityId ?? `protocol-run-${sha256(sourceObject.stableId).slice(0, 24)}`;
  const stem = safeFileStem(`${sourceObject.name}__${sha256(sourceObject.stableId).slice(0, 16)}`);
  const document: ProtocolRunDocument = {
    schema: PROTOCOL_RUN_DOCUMENT_SCHEMA,
    kind: 'protocol_run',
    id: destinationObjectId,
    title: requireText(sourceObject.name, 'Protocol run name'),
    status,
    immutable: status === 'completed',
    protocol,
    inputs,
    outputs,
    measurements,
    tables,
    links,
    startedAt,
    completedAt,
    amendments: [],
    provenance: {
      immutableSource: true,
      provider: 'benchling',
      sourceObjectId: requireText(sourceObject.id, 'Source object ID'),
      stableSourceId: requireText(sourceObject.stableId, 'Stable source ID'),
      sourceUrl: sanitizeHttpUrl(sourceObject.sourceUrl, 'Source URL'),
      sourceSchemaId: optionalText(sourceObject.schemaId),
      sourceCreatedAt: optionalTimestamp(sourceObject.createdAt, 'source createdAt'),
      sourceModifiedAt: optionalTimestamp(sourceObject.modifiedAt, 'source modifiedAt'),
      capturedAt: requiredTimestamp(options.capturedAt, 'capturedAt'),
    },
  };
  const warnings = tables.flatMap((table) =>
    table.cells.flatMap((row, rowIndex) =>
      row.flatMap((cell, columnIndex) =>
        cell.type === 'formula' && cell.formulaCompatibility === 'unsupported'
          ? [
              `Table ${table.name} cell ${columnLabel(columnIndex)}${rowIndex + 1} preserves an unsupported formula${cell.stale ? ' and is stale' : ''}.`,
            ]
          : []
      )
    )
  );

  return {
    converterId: 'benchling-protocol-run-v1',
    converterVersion: requireText(options.converterVersion, 'Converter version'),
    destinationObjectId,
    destinationPath: `Benchling Imports/Protocol Runs/${stem}/.forge/protocol-run.json`,
    document,
    text: `${stableJson(document)}\n`,
    warnings,
  };
}

export function appendProtocolRunAmendment(
  document: ProtocolRunDocument,
  input: {
    at: string;
    actor?: string | null;
    reason: string;
    path: string;
    value: unknown;
  }
): ProtocolRunDocument {
  assertProtocolRunDocument(document);
  if (document.immutable || document.status === 'completed') {
    throw new Error('Completed protocol runs are immutable.');
  }
  const sequence = document.amendments.length + 1;
  const amendment: ProtocolRunAmendment = {
    id: `amendment-${sequence}-${sha256(`${document.id}:${sequence}:${input.at}`).slice(0, 16)}`,
    sequence,
    at: requiredTimestamp(input.at, 'Amendment timestamp'),
    actor: input.actor === undefined ? null : optionalText(input.actor),
    reason: requireText(input.reason, 'Amendment reason'),
    path: normalizeAmendmentPath(input.path),
    value: normalizeValue(input.value, 'amendment value'),
  };
  return {
    ...document,
    amendments: [...document.amendments, amendment],
  };
}

export function parseProtocolRunDocument(text: string): ProtocolRunDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Protocol run document is not valid JSON.');
  }
  assertProtocolRunDocument(value);
  return value;
}

export function assertProtocolRunDocument(value: unknown): asserts value is ProtocolRunDocument {
  assertProtocolRunStructure(value);
  const document = value as ProtocolRunDocument;
  if (document.status === 'completed' && document.amendments.length > 0)
    throw new Error('Completed imported protocol runs cannot contain local amendments.');
  normalizeProvenance(document.provenance);
}

function normalizeProvenance(value: unknown): void {
  const provenance = requireRecord(value, 'Protocol run provenance must be an object.');
  if (provenance.immutableSource !== true || provenance.provider !== 'benchling') {
    throw new Error('Protocol run provenance must identify an immutable Benchling source.');
  }
  requireText(provenance.sourceObjectId, 'Protocol run source object ID');
  requireText(provenance.stableSourceId, 'Protocol run stable source ID');
  const sourceUrl = requireText(provenance.sourceUrl, 'Protocol run source URL');
  if (sanitizeHttpUrl(sourceUrl, 'Protocol run source URL') !== sourceUrl) {
    throw new Error('Protocol run source URL must not retain query parameters or fragments.');
  }
  assertNullableText(provenance.sourceSchemaId, 'Protocol run source schema ID');
  assertNullableTimestamp(provenance.sourceCreatedAt, 'Protocol run source createdAt');
  assertNullableTimestamp(provenance.sourceModifiedAt, 'Protocol run source modifiedAt');
  requiredTimestamp(provenance.capturedAt, 'Protocol run capturedAt');
}

function isProtocolRunSourceType(value: string): boolean {
  return ['protocol_execution', 'protocol_run', 'execution'].includes(
    value.trim().toLowerCase().replace(/[ -]+/g, '_')
  );
}

function safeFileStem(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/_+/g, '_')
    .slice(0, 120);
  return normalized || `protocol_run_${sha256(value).slice(0, 12)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  }
  return value;
}
