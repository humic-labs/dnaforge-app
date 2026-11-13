import {
  publicEntitySchemaFields,
  PUBLIC_METADATA_HISTORY_VALUE_TYPES,
} from '../shared/public-entity-metadata';
import { geneticCodeLabel, type GeneticCodeSpec } from '@waypoint/sequence-utils';
import { isEntityRecordBookkeepingField } from '../shared/entity-record';
import {
  MANAGED_SEQUENCE_CONTENT_FIELD,
  readManagedSequenceContentSummary,
} from '../shared/managed-sequence-document';
import { registrySchemaSnapshotForEntity } from './lims-registry-projection';
import type Database from 'better-sqlite3';
import {
  type LimsEntity,
  type LimsEntityHistoryInput,
  type LimsEntityHistoryEntry,
  type LimsFieldChange,
  type LimsEntityStateEventType,
  LIMS_ENTITY_STATE_EVENT_TYPES,
} from '../shared/lims';
const LIMS_HISTORY_LABELS: Record<LimsEntityStateEventType, string> = {
  entity_registered: 'Registered',
  entity_updated: 'Edited',
  entity_reverted: 'Reverted',
  entity_archived: 'Archived',
  entity_restored: 'Restored',
  entity_tombstoned: 'Deleted',
  entity_registry_id_assigned: 'Registry ID assigned',
};
const LIMS_STATE_EVENT_SET = new Set<string>(LIMS_ENTITY_STATE_EVENT_TYPES);
function summarizeLimsFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'string' ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item))
    )
  )
    return value.map(String).join(', ');
  return 'Updated';
}
function diffLimsEntitySnapshots(
  before: LimsEntity | null,
  after: LimsEntity | null,
  schemaFields: ReadonlyMap<
    string,
    {
      label: string;
      type: string;
    }
  >
): {
  changes: LimsFieldChange[];
  hasChanges: boolean;
} {
  if (!after) return { changes: [], hasChanges: false };
  if (!before)
    return {
      changes: [{ field: 'name', label: 'Name', kind: 'added', after: after.name }],
      hasChanges: true,
    };
  const changes: Omit<LimsFieldChange, 'label'>[] = [];
  let savedContentChanged = false;
  const pushScalar = (field: string, b: unknown, a: unknown) => {
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) return;
    changes.push({
      field,
      kind: b == null ? 'added' : a == null ? 'removed' : 'changed',
      before: b == null ? undefined : summarizeLimsFieldValue(b),
      after: a == null ? undefined : summarizeLimsFieldValue(a),
    });
  };
  pushScalar('name', before.name, after.name);
  pushScalar('registrationStatus', before.registrationStatus, after.registrationStatus);
  pushScalar('domainStatus', before.domainStatus, after.domainStatus);
  pushScalar('registryId', before.registryId, after.registryId);
  if (before.kind !== after.kind || before.schemaRevisionId !== after.schemaRevisionId) {
    changes.push({ field: 'schema', kind: 'changed', description: 'Schema changed' });
  }
  const beforeFields = before.fields ?? {};
  const afterFields = after.fields ?? {};
  for (const key of new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])) {
    const b = beforeFields[key];
    const a = afterFields[key];
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    if (key === MANAGED_SEQUENCE_CONTENT_FIELD) {
      const previous = readManagedSequenceContentSummary(b);
      const next = readManagedSequenceContentSummary(a);
      const comparableFileHashes = previous?.fileContentHash && next?.fileContentHash;
      const fileChanged = comparableFileHashes && previous.fileContentHash !== next.fileContentHash;
      const normalizedChanged =
        previous?.normalizedSequenceHash &&
        next?.normalizedSequenceHash &&
        previous.normalizedSequenceHash !== next.normalizedSequenceHash;
      savedContentChanged = Boolean(fileChanged || (!comparableFileHashes && normalizedChanged));
      if (normalizedChanged && (!comparableFileHashes || fileChanged)) {
        changes.push({
          field: 'sequence',
          kind: 'changed',
          description: 'Sequence changed',
        });
      }
      const pushEstablishedContentValue = (
        field: string,
        oldValue: unknown,
        newValue: unknown,
        format: (value: unknown) => string = summarizeLimsFieldValue
      ) => {
        if (
          oldValue === undefined ||
          newValue === undefined ||
          JSON.stringify(oldValue) === JSON.stringify(newValue)
        ) {
          return;
        }
        changes.push({
          field: `fields.${field}`,
          kind: 'changed',
          before: format(oldValue),
          after: format(newValue),
        });
      };
      pushEstablishedContentValue('size', previous?.length, next?.length);
      pushEstablishedContentValue('topology', previous?.topology, next?.topology);
      pushEstablishedContentValue(
        'geneticCode',
        previous?.geneticCode,
        next?.geneticCode,
        (value) => {
          try {
            return geneticCodeLabel(value as GeneticCodeSpec);
          } catch {
            return summarizeLimsFieldValue(value);
          }
        }
      );
      continue;
    }
    if (key === 'sourceMetadata') {
      changes.push({
        field: 'fields.sourceMetadata',
        kind: 'changed',
        description: 'Imported metadata updated',
      });
      continue;
    }
    if (key === 'sequence') {
      const summarize = (value: unknown) => {
        if (!value || typeof value !== 'object') return undefined;
        const sequence = value as Record<string, unknown>;
        if (sequence.mode === 'unresolved') return 'Sequence unavailable';
        const length =
          typeof sequence.length === 'number' && Number.isFinite(sequence.length)
            ? sequence.length
            : undefined;
        const topology = sequence.topology === 'circular' ? 'circular' : 'linear';
        return length === undefined
          ? 'Sequence'
          : `${length.toLocaleString()} ${after.kind === 'protein' ? 'aa' : 'nt'}, ${topology}`;
      };
      const before = summarize(b);
      const afterText = summarize(a);
      changes.push({
        field: 'sequence',
        kind: 'changed',
        ...(before !== afterText
          ? { before, after: afterText }
          : { description: 'Sequence changed' }),
      });
      continue;
    }
    if (after.kind === 'molecular-document' && key === 'currentReferenceId') {
      changes.push({
        field: 'molecularResult',
        kind: 'changed',
        description: 'Saved molecular result changed',
      });
      continue;
    }
    if (isEntityRecordBookkeepingField(key) || !schemaFields.has(key)) continue;
    const scalar = (value: unknown): boolean =>
      value == null ||
      ['string', 'number', 'boolean'].includes(typeof value) ||
      (Array.isArray(value) &&
        value.every(
          (item) => item == null || ['string', 'number', 'boolean'].includes(typeof item)
        ));
    if (
      !PUBLIC_METADATA_HISTORY_VALUE_TYPES.has(schemaFields.get(key)?.type ?? '') ||
      !scalar(b) ||
      !scalar(a)
    ) {
      changes.push({
        field: `fields.${key}`,
        kind: 'changed',
        description: 'Metadata value updated',
      });
      continue;
    }
    changes.push({
      field: `fields.${key}`,
      kind: b === undefined ? 'added' : a === undefined ? 'removed' : 'changed',
      before: b === undefined ? undefined : summarizeLimsFieldValue(b),
      after: a === undefined ? undefined : summarizeLimsFieldValue(a),
    });
  }
  const labels: Record<string, string> = {
    molecularResult: 'Molecular result',
    name: 'Name',
    schema: 'Schema',
    registrationStatus: 'Registration status',
    domainStatus: 'Status',
    registryId: 'ID',
    sequence: 'Sequence',
    'fields.size': 'Length',
    'fields.topology': 'Topology',
    'fields.geneticCode': 'Genetic code',
    'fields.sourceMetadata': 'Imported metadata',
  };
  const publicChanges = changes.flatMap((change) => {
    const label =
      labels[change.field] ?? schemaFields.get(change.field.slice('fields.'.length))?.label;
    return label ? [{ ...change, label }] : [];
  });
  return { changes: publicChanges, hasChanges: savedContentChanged || publicChanges.length > 0 };
}
export function getLimsEntityHistoryInDb(
  db: Database.Database,
  input: LimsEntityHistoryInput
): LimsEntityHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT event_seq, event_type, actor, created_at, before, after
       FROM lims_audit
       WHERE subject_table = 'lims_entity' AND subject_id = ?
       ORDER BY event_seq ASC`
    )
    .all(input.entityId) as Array<{
    event_seq: number;
    event_type: string;
    actor: string | null;
    created_at: number;
    before: string | null;
    after: string | null;
  }>;
  const entries: LimsEntityHistoryEntry[] = [];
  for (const row of rows) {
    if (!LIMS_STATE_EVENT_SET.has(row.event_type)) continue;
    const eventType = row.event_type as LimsEntityStateEventType;
    let before: LimsEntity | null;
    let after: LimsEntity | null;
    try {
      before = row.before ? (JSON.parse(row.before) as LimsEntity) : null;
      after = row.after ? (JSON.parse(row.after) as LimsEntity) : null;
    } catch {
      continue;
    }
    const fields = new Map<
      string,
      {
        label: string;
        type: string;
      }
    >();
    for (const snapshot of [before, after]) {
      if (!snapshot) continue;
      try {
        for (const field of publicEntitySchemaFields(
          registrySchemaSnapshotForEntity(db, snapshot),
          snapshot.kind
        ))
          if (!isEntityRecordBookkeepingField(field.key))
            fields.set(field.key, { label: field.label, type: field.type });
      } catch {
        continue;
      }
    }
    const { changes, hasChanges } = diffLimsEntitySnapshots(before, after, fields);
    if (eventType === 'entity_updated' && !hasChanges) {
      continue;
    }
    entries.push({
      eventSeq: row.event_seq,
      eventType,
      label: LIMS_HISTORY_LABELS[eventType],
      actor: row.actor,
      at: row.created_at,
      changes,
    });
  }
  entries.reverse();
  return entries;
}
