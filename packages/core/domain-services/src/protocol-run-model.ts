export const PROTOCOL_RUN_DOCUMENT_SCHEMA = 'dnaforge.protocol-run.v1' as const;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
export type ProtocolRunStatus = 'in_progress' | 'completed';

export type ProtocolRunValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'date'; value: string }
  | {
      type: 'quantity';
      lexical: string;
      value: number | null;
      unit: string;
      unitCompatibility: 'recognized' | 'unrecognized';
    }
  | {
      type: 'record';
      sourceId: string;
      destinationId: string;
      label: string;
    }
  | {
      type: 'attachment';
      hash: string;
      fileName: string;
      mediaType?: string;
    };

export type ProtocolRunSlot = {
  key: string;
  label: string;
  value: ProtocolRunValue;
};

export type ProtocolRunMeasurement = ProtocolRunSlot & {
  recordedAt?: string;
};

export type ProtocolRunTableCell = {
  type: 'text' | 'number' | 'formula';
  value: string;
  computed?: string | number;
  formulaCompatibility?: 'supported' | 'unsupported';
  stale?: boolean;
};

export type ProtocolRunTable = {
  id: string;
  name: string;
  rows: number;
  cols: number;
  cells: ProtocolRunTableCell[][];
};

export type ProtocolRunLink =
  | {
      relation: string;
      state: 'exact';
      sourceTargetId: string;
      destinationTargetId: string;
      label?: string;
    }
  | {
      relation: string;
      state: 'external';
      url: string;
      label?: string;
    }
  | {
      relation: string;
      state: 'source_broken';
      sourceTargetId?: string;
      label?: string;
    };

export type ProtocolRunAmendment = {
  id: string;
  sequence: number;
  at: string;
  actor: string | null;
  reason: string;
  path: string;
  value: ProtocolRunValue;
};

export type ProtocolRunDocument = {
  schema: typeof PROTOCOL_RUN_DOCUMENT_SCHEMA;
  kind: 'protocol_run';
  id: string;
  title: string;
  status: ProtocolRunStatus;
  immutable: boolean;
  protocol: {
    sourceId: string;
    destinationId: string | null;
    name: string;
    pinnedVersionId: string;
    pinnedVersionHash: string;
  };
  inputs: ProtocolRunSlot[];
  outputs: ProtocolRunSlot[];
  measurements: ProtocolRunMeasurement[];
  tables: ProtocolRunTable[];
  links: ProtocolRunLink[];
  startedAt: string | null;
  completedAt: string | null;
  amendments: ProtocolRunAmendment[];
  provenance: Record<string, unknown>;
};

export function assertProtocolRunStructure(value: unknown): void {
  const document = requireRecord(value, 'Protocol run document must be an object.');
  if (document.schema !== PROTOCOL_RUN_DOCUMENT_SCHEMA || document.kind !== 'protocol_run') {
    throw new Error('Unsupported protocol run document schema.');
  }
  requireText(document.id, 'Protocol run ID');
  requireText(document.title, 'Protocol run title');
  if (document.status !== 'completed' && document.status !== 'in_progress') {
    throw new Error('Durable protocol run status must be completed or in_progress.');
  }
  const status = document.status;
  if (document.immutable !== (status === 'completed')) {
    throw new Error('Protocol run immutable flag must match completion status.');
  }
  assertDurableProtocolPin(document.protocol);
  requireArray(document.inputs, 'Protocol run inputs must be an array.');
  requireArray(document.outputs, 'Protocol run outputs must be an array.');
  requireArray(document.measurements, 'Protocol run measurements must be an array.');
  requireArray(document.tables, 'Protocol run tables must be an array.');
  requireArray(document.links, 'Protocol run links must be an array.');
  normalizeSlots(document.inputs, 'inputs');
  normalizeSlots(document.outputs, 'outputs');
  normalizeMeasurements(document.measurements);
  normalizeTables(document.tables);
  normalizeLinks(document.links);
  if (document.startedAt !== null && typeof document.startedAt !== 'string') {
    throw new Error('Protocol run startedAt must be a timestamp or null.');
  }
  if (document.completedAt !== null && typeof document.completedAt !== 'string') {
    throw new Error('Protocol run completedAt must be a timestamp or null.');
  }
  optionalTimestamp(document.startedAt, 'startedAt');
  const completedAt = optionalTimestamp(document.completedAt, 'completedAt');
  if (status === 'completed' && !completedAt) {
    throw new Error('A completed protocol run requires completedAt.');
  }
  if (!Array.isArray(document.amendments)) {
    throw new Error('Protocol run amendments must be an array.');
  }
  document.amendments.forEach((entry, index) => normalizeAmendment(entry, index));
}

export function normalizeProtocol(value: unknown): ProtocolRunDocument['protocol'] {
  const protocol = requireRecord(value, 'Protocol run requires a pinned protocol.');
  const versionHash = requireText(
    protocol.versionHash ?? protocol.pinnedVersionHash,
    'Protocol version hash'
  );
  if (!SHA256.test(versionHash)) {
    throw new Error('Protocol version hash must be a sha256 digest.');
  }
  return {
    sourceId: requireText(protocol.sourceId, 'Protocol source ID'),
    destinationId: optionalText(protocol.destinationId),
    name: requireText(protocol.name, 'Protocol name'),
    pinnedVersionId: requireText(
      protocol.versionId ?? protocol.pinnedVersionId,
      'Pinned protocol version ID'
    ),
    pinnedVersionHash: versionHash,
  };
}

export function assertDurableProtocolPin(value: unknown): void {
  const protocol = requireRecord(value, 'Protocol run requires a pinned protocol.');
  requireText(protocol.sourceId, 'Protocol source ID');
  if (protocol.destinationId !== null && typeof protocol.destinationId !== 'string') {
    throw new Error('Protocol destination ID must be text or null.');
  }
  if (typeof protocol.destinationId === 'string') {
    requireText(protocol.destinationId, 'Protocol destination ID');
  }
  requireText(protocol.name, 'Protocol name');
  requireText(protocol.pinnedVersionId, 'Pinned protocol version ID');
  const versionHash = requireText(protocol.pinnedVersionHash, 'Protocol version hash');
  if (!SHA256.test(versionHash)) {
    throw new Error('Protocol version hash must be a sha256 digest.');
  }
}

export function normalizeSlots(value: unknown, label: string): ProtocolRunSlot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Protocol run ${label} must be an array.`);
  const keys = new Set<string>();
  return value.map((entry, index) => {
    const slot = requireRecord(entry, `${label} ${index + 1} must be an object.`);
    const key = requireText(slot.key, `${label} ${index + 1} key`);
    if (!SAFE_KEY.test(key)) throw new Error(`${label} ${index + 1} key is not portable.`);
    if (keys.has(key)) throw new Error(`Duplicate protocol run ${label} key: ${key}.`);
    keys.add(key);
    return {
      key,
      label: requireText(slot.label, `${label} ${index + 1} label`),
      value: normalizeValue(slot.value, `${label} ${index + 1} value`),
    };
  });
}

export function normalizeMeasurements(value: unknown): ProtocolRunMeasurement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Protocol run measurements must be an array.');
  const slots = normalizeSlots(value, 'measurements');
  return slots.map((slot, index) => {
    const raw = requireRecord(value[index], `measurement ${index + 1} must be an object.`);
    return {
      ...slot,
      ...(raw.recordedAt === undefined
        ? {}
        : { recordedAt: requiredTimestamp(raw.recordedAt, `measurement ${index + 1} recordedAt`) }),
    };
  });
}

export function normalizeValue(value: unknown, label: string): ProtocolRunValue {
  const input = requireRecord(value, `${label} must be a typed object.`);
  switch (input.type) {
    case 'text':
      return { type: 'text', value: requireTextValue(input.value, `${label} text`) };
    case 'number':
      return { type: 'number', value: requireFiniteNumber(input.value, `${label} number`) };
    case 'boolean':
      if (typeof input.value !== 'boolean')
        throw new Error(`${label} boolean must be true or false.`);
      return { type: 'boolean', value: input.value };
    case 'date':
      return { type: 'date', value: requiredTimestamp(input.value, `${label} date`) };
    case 'quantity': {
      const unitCompatibility = input.unitCompatibility;
      if (unitCompatibility !== 'recognized' && unitCompatibility !== 'unrecognized') {
        throw new Error(`${label} quantity requires unitCompatibility.`);
      }
      return {
        type: 'quantity',
        lexical: requireText(input.lexical, `${label} lexical quantity`),
        value:
          input.value === null
            ? null
            : requireFiniteNumber(input.value, `${label} normalized quantity`),
        unit: requireText(input.unit, `${label} quantity unit`),
        unitCompatibility,
      };
    }
    case 'record':
      return {
        type: 'record',
        sourceId: requireText(input.sourceId, `${label} record source ID`),
        destinationId: requireText(input.destinationId, `${label} record destination ID`),
        label: requireText(input.label, `${label} record label`),
      };
    case 'attachment': {
      const hash = requireText(input.hash, `${label} attachment hash`);
      if (!SHA256.test(hash)) throw new Error(`${label} attachment hash must be sha256.`);
      return {
        type: 'attachment',
        hash,
        fileName: safeLogicalFileName(input.fileName, `${label} attachment filename`),
        ...(input.mediaType === undefined
          ? {}
          : { mediaType: requireText(input.mediaType, `${label} attachment media type`) }),
      };
    }
    default:
      throw new Error(`${label} has unsupported type "${String(input.type)}".`);
  }
}

export function normalizeTables(value: unknown): ProtocolRunTable[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Protocol run tables must be an array.');
  const ids = new Set<string>();
  return value.map((entry, tableIndex) => {
    const table = requireRecord(entry, `Table ${tableIndex + 1} must be an object.`);
    const id = requireText(table.id, `Table ${tableIndex + 1} ID`);
    if (!SAFE_KEY.test(id)) throw new Error(`Table ${tableIndex + 1} ID is not portable.`);
    if (ids.has(id)) throw new Error(`Duplicate protocol run table ID: ${id}.`);
    ids.add(id);
    if (!Array.isArray(table.cells) || table.cells.length === 0) {
      throw new Error(`Table ${tableIndex + 1} requires at least one row.`);
    }
    const cells = table.cells.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length === 0) {
        throw new Error(`Table ${tableIndex + 1} row ${rowIndex + 1} must contain cells.`);
      }
      return row.map((cell, columnIndex) =>
        normalizeTableCell(cell, tableIndex, rowIndex, columnIndex)
      );
    });
    const cols = cells[0].length;
    if (cells.some((row) => row.length !== cols)) {
      throw new Error(`Table ${tableIndex + 1} must be rectangular.`);
    }
    return {
      id,
      name: requireText(table.name, `Table ${tableIndex + 1} name`),
      rows: cells.length,
      cols,
      cells,
    };
  });
}

export function normalizeTableCell(
  value: unknown,
  tableIndex: number,
  rowIndex: number,
  columnIndex: number
): ProtocolRunTableCell {
  const label = `Table ${tableIndex + 1} cell ${columnLabel(columnIndex)}${rowIndex + 1}`;
  const cell = requireRecord(value, `${label} must be an object.`);
  if (cell.type !== 'text' && cell.type !== 'number' && cell.type !== 'formula') {
    throw new Error(`${label} has unsupported cell type.`);
  }
  const normalized: ProtocolRunTableCell = {
    type: cell.type,
    value: requireTextValue(cell.value, `${label} value`),
  };
  if (cell.type === 'number' && !Number.isFinite(Number(cell.value))) {
    throw new Error(`${label} number is invalid.`);
  }
  if (cell.type === 'formula') {
    if (!normalized.value.startsWith('=')) throw new Error(`${label} formula must begin with =.`);
    if (cell.formulaCompatibility !== 'supported' && cell.formulaCompatibility !== 'unsupported') {
      throw new Error(`${label} formula requires compatibility classification.`);
    }
    normalized.formulaCompatibility = cell.formulaCompatibility;
    if (cell.computed !== undefined) {
      if (typeof cell.computed !== 'string' && !Number.isFinite(cell.computed)) {
        throw new Error(`${label} computed value must be text or a finite number.`);
      }
      normalized.computed = cell.computed as string | number;
    }
    if (cell.stale !== undefined) {
      if (typeof cell.stale !== 'boolean') throw new Error(`${label} stale flag must be boolean.`);
      normalized.stale = cell.stale;
    }
    if (cell.formulaCompatibility === 'supported' && cell.stale === true) {
      throw new Error(`${label} supported formula cannot be marked stale.`);
    }
  } else if (
    cell.formulaCompatibility !== undefined ||
    cell.computed !== undefined ||
    cell.stale !== undefined
  ) {
    throw new Error(`${label} formula metadata is only valid on formula cells.`);
  }
  return normalized;
}

export function normalizeLinks(value: unknown): ProtocolRunLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Protocol run links must be an array.');
  return value.map((entry, index) => {
    const link = requireRecord(entry, `Protocol run link ${index + 1} must be an object.`);
    const relation = requireText(link.relation, `Protocol run link ${index + 1} relation`);
    const label = optionalText(link.label);
    if (link.state === 'exact') {
      return {
        relation,
        state: 'exact',
        sourceTargetId: requireText(
          link.sourceTargetId,
          `Protocol run link ${index + 1} source ID`
        ),
        destinationTargetId: requireText(
          link.destinationTargetId,
          `Protocol run link ${index + 1} destination ID`
        ),
        ...(label ? { label } : {}),
      };
    }
    if (link.state === 'external') {
      return {
        relation,
        state: 'external',
        url: sanitizeHttpUrl(link.url, `Protocol run link ${index + 1} URL`),
        ...(label ? { label } : {}),
      };
    }
    if (link.state === 'source_broken') {
      return {
        relation,
        state: 'source_broken',
        ...(optionalText(link.sourceTargetId)
          ? { sourceTargetId: optionalText(link.sourceTargetId) as string }
          : {}),
        ...(label ? { label } : {}),
      };
    }
    throw new Error(
      `Protocol run link ${index + 1} must already be exact, external, or source-broken.`
    );
  });
}

export function normalizeAmendment(value: unknown, index: number): ProtocolRunAmendment {
  const amendment = requireRecord(value, `Amendment ${index + 1} must be an object.`);
  if (amendment.sequence !== index + 1) {
    throw new Error('Protocol run amendment sequence must be contiguous.');
  }
  return {
    id: requireText(amendment.id, `Amendment ${index + 1} ID`),
    sequence: index + 1,
    at: requiredTimestamp(amendment.at, `Amendment ${index + 1} timestamp`),
    actor: optionalText(amendment.actor),
    reason: requireText(amendment.reason, `Amendment ${index + 1} reason`),
    path: normalizeAmendmentPath(amendment.path),
    value: normalizeValue(amendment.value, `Amendment ${index + 1} value`),
  };
}

export function normalizeStatus(value: unknown): ProtocolRunStatus {
  if (typeof value !== 'string') throw new Error('Protocol run status must be text.');
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, '_');
  if (['completed', 'complete'].includes(normalized)) return 'completed';
  if (['in_progress', 'running', 'active'].includes(normalized)) return 'in_progress';
  throw new Error(`Unsupported protocol run status "${value}".`);
}

export function normalizeAmendmentPath(value: unknown): string {
  const path = requireText(value, 'Amendment path');
  if (!/^\/(inputs|outputs|measurements|tables)\/[A-Za-z0-9_/-]+$/.test(path)) {
    throw new Error('Amendment path must target run inputs, outputs, measurements, or tables.');
  }
  return path;
}

export function sanitizeHttpUrl(value: unknown, label: string): string {
  const text = requireText(value, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} must use http or https.`);
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function safeLogicalFileName(value: unknown, label: string): string {
  const fileName = requireText(value, label);
  if (
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    /[\0\r\n]/.test(fileName)
  ) {
    throw new Error(`${label} must be a logical filename without a path.`);
  }
  return fileName;
}

export function columnLabel(index: number): string {
  let label = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return label;
}

export function requiredTimestamp(value: unknown, label: string): string {
  const text = requireText(value, label);
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(epoch).toISOString();
}

export function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredTimestamp(value, label);
}

export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be non-empty text.`);
  }
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} must be single-line text.`);
  return value.trim();
}

export function requireTextValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(`${label} must be text.`);
  }
  return value;
}

export function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, 'Optional text');
}

export function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

export function requireArray(value: unknown, message: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
}

export function assertNullableText(value: unknown, label: string): void {
  if (value === null) return;
  requireText(value, label);
}

export function assertNullableTimestamp(value: unknown, label: string): void {
  if (value === null) return;
  requiredTimestamp(value, label);
}
