import { withUserMessage } from '@waypoint/user-messages';
export type SheetSyncValue =
  | null
  | boolean
  | number
  | string
  | SheetSyncValue[]
  | { [key: string]: SheetSyncValue };

export interface SheetSyncRecord {
  kind: string;
  name: string;
  fields: Record<string, SheetSyncValue>;
  oligoNotation?: string;
}

export interface SheetSyncSourceRow {
  key: string;
  record: SheetSyncRecord;
}

export interface SheetSyncCheckpoint {
  key: string;
  entityId: string;
  artifactRelativePath: string;
  source: SheetSyncRecord;
  applied: SheetSyncRecord;
}

export interface SheetSyncTarget {
  entityId: string;
  eventSeq: number | null;
  record: SheetSyncRecord;
  archived: boolean;
}

export type SheetSyncChange =
  | { kind: 'create'; key: string; source: SheetSyncRecord }
  | {
      kind: 'update';
      key: string;
      entityId: string;
      expectedEventSeq: number;
      source: SheetSyncRecord;
    }
  | {
      kind: 'adopt';
      key: string;
      entityId: string;
      expectedEventSeq: number;
      source: SheetSyncRecord;
    }
  | { kind: 'unchanged' | 'local-edit' | 'missing-source'; key: string; entityId: string }
  | {
      kind: 'conflict';
      key: string;
      entityId: string;
      reason:
        | 'both-edited'
        | 'missing-target'
        | 'archived-target'
        | 'entity-kind-changed'
        | 'missing-target-version';
    };

function canonicalValue(value: SheetSyncValue): string {
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('Sheet sync values must be finite.');
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sheetSyncRecordKey(record: SheetSyncRecord): string {
  return canonicalValue({
    kind: record.kind,
    name: record.name,
    fields: record.fields,
    ...(record.oligoNotation === undefined ? {} : { oligoNotation: record.oligoNotation }),
  });
}

export function planSheetSync(input: {
  sourceRows: readonly SheetSyncSourceRow[];
  checkpoints: readonly SheetSyncCheckpoint[];
  targets: readonly SheetSyncTarget[];
}): SheetSyncChange[] {
  const rows = new Map<string, SheetSyncSourceRow>();
  for (const row of input.sourceRows) {
    if (!row.key || row.key !== row.key.trim())
      throw new Error(
        'Every spreadsheet row needs a nonempty stable key without surrounding whitespace.'
      );
    if (rows.has(row.key))
      throw withUserMessage(
        new Error(`Spreadsheet row key is duplicated: ${row.key}`),
        'registry.duplicateRowKey'
      );
    sheetSyncRecordKey(row.record);
    rows.set(row.key, row);
  }
  const checkpoints = new Map(input.checkpoints.map((checkpoint) => [checkpoint.key, checkpoint]));
  if (checkpoints.size !== input.checkpoints.length)
    throw new Error('Spreadsheet checkpoint row keys are duplicated.');
  if (
    new Set(input.checkpoints.map((checkpoint) => checkpoint.entityId)).size !==
    input.checkpoints.length
  )
    throw new Error('Spreadsheet rows cannot share a target identity.');
  const targets = new Map(input.targets.map((target) => [target.entityId, target]));
  if (targets.size !== input.targets.length)
    throw new Error('Spreadsheet target identities are duplicated.');
  const changes: SheetSyncChange[] = [];
  for (const row of rows.values()) {
    const checkpoint = checkpoints.get(row.key);
    if (!checkpoint) {
      changes.push({ kind: 'create', key: row.key, source: row.record });
      continue;
    }
    const target = targets.get(checkpoint.entityId);
    const conflict = (
      reason: Extract<SheetSyncChange, { kind: 'conflict' }>['reason']
    ): SheetSyncChange => ({
      kind: 'conflict',
      key: row.key,
      entityId: checkpoint.entityId,
      reason,
    });
    if (!target) {
      changes.push(conflict('missing-target'));
      continue;
    }
    if (target.archived) {
      changes.push(conflict('archived-target'));
      continue;
    }
    if (
      row.record.kind !== checkpoint.source.kind ||
      target.record.kind !== checkpoint.applied.kind
    ) {
      changes.push(conflict('entity-kind-changed'));
      continue;
    }
    const sourceChanged = sheetSyncRecordKey(row.record) !== sheetSyncRecordKey(checkpoint.source);
    const targetChanged =
      sheetSyncRecordKey(target.record) !== sheetSyncRecordKey(checkpoint.applied);
    if (!sourceChanged) {
      changes.push({
        kind: targetChanged ? 'local-edit' : 'unchanged',
        key: row.key,
        entityId: target.entityId,
      });
    } else if (
      targetChanged &&
      sheetSyncRecordKey(row.record) !== sheetSyncRecordKey(target.record)
    ) {
      changes.push(conflict('both-edited'));
    } else {
      if (target.eventSeq === null) {
        changes.push(conflict('missing-target-version'));
        continue;
      }
      changes.push({
        kind: targetChanged ? 'adopt' : 'update',
        key: row.key,
        entityId: target.entityId,
        expectedEventSeq: target.eventSeq,
        source: row.record,
      });
    }
  }
  for (const checkpoint of input.checkpoints) {
    if (!rows.has(checkpoint.key))
      changes.push({ kind: 'missing-source', key: checkpoint.key, entityId: checkpoint.entityId });
  }
  return changes;
}

export function sheetSyncMappedTarget(
  source: SheetSyncRecord,
  target: SheetSyncRecord
): SheetSyncRecord {
  return {
    kind: target.kind,
    name: target.name,
    ...(source.oligoNotation === undefined || target.oligoNotation === undefined
      ? {}
      : { oligoNotation: target.oligoNotation }),
    fields: Object.fromEntries(
      Object.keys(source.fields)
        .filter((key) => Object.prototype.hasOwnProperty.call(target.fields, key))
        .map((key) => [key, target.fields[key]])
    ),
  };
}

export function sheetSyncMergedFields(
  source: SheetSyncRecord,
  priorSource: SheetSyncRecord,
  currentFields: Record<string, SheetSyncValue>
): Record<string, SheetSyncValue> {
  const fields = { ...currentFields };
  for (const key of Object.keys(priorSource.fields)) delete fields[key];
  return { ...fields, ...source.fields };
}
