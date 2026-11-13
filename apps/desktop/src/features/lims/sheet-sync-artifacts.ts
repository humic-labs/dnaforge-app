import type { LimsEntity } from '../../shared/lims';
import { platform } from '../../platform';
import { resolveWorkspaceId } from '../../db/workspace-catalog';
import { isSafeWorkspaceRelativePath } from '../../shared/path-boundary';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { sha256Hex, createBuiltinPrimerSchemaSnapshot } from '../primers/public/primer-artifact';
import { PRIMER_MANAGED_SCHEMA_FIELD_KEYS } from '../primers/public/primer-schema-contract';
import { parseIdtOligoNotation } from '../primers/public/oligo-modifications';
import { recordPrimers } from '../primers/public/record-primers';
import {
  readPrimerArtifactAtPath,
  reconcilePrimerArtifact,
  updatePrimerArtifactContent,
} from '../primers/public/primer-artifact-service';
import { parsePrimerArtifact } from '../primers/public/primer-artifact';
import { recordProtein } from '../proteins/public/record-proteins';
import { recordEntityArtifact } from './record-entity-artifact';
import {
  ENTITY_ARTIFACT_SUFFIX,
  parseEntityArtifact,
  sanitizeEntityArtifactStem,
} from './entity-artifact';
import { queryLimsEntities } from './operations';
import { sheetSyncJsonValue } from './sheet-sync-import';
import {
  sheetSyncMappedTarget,
  sheetSyncRecordKey,
  type SheetSyncCheckpoint,
  type SheetSyncRecord,
} from './sheet-sync';
import {
  sheetSyncWorkspacePath,
  type SheetSyncConnection,
  type SheetSyncSnapshot,
} from './sheet-sync-connection';
import { reconcileWorkspaceAfterFilesChanged } from '../../services/workspace-operations';

type SnapshotRow = SheetSyncSnapshot['rows'][number];
type CreateOperation = Extract<
  NonNullable<SheetSyncConnection['pending']>['operation'],
  { kind: 'create' }
>;
export type SheetSyncCreateRow = CreateOperation['rows'][number];

export function sheetSyncEntityRecord(
  entity: Pick<LimsEntity, 'kind' | 'name' | 'fields'>,
  scope: SheetSyncRecord
): SheetSyncRecord {
  const fields = Object.fromEntries(
    Object.keys(scope.fields)
      .filter((key) => Object.prototype.hasOwnProperty.call(entity.fields, key))
      .map((key) => [key, sheetSyncJsonValue(entity.fields[key])])
  );
  const oligo = entity.fields.oligo;
  const sequence = entity.fields.sequence;
  const oligoNotation =
    oligo && typeof oligo === 'object' && 'notation' in oligo && typeof oligo.notation === 'string'
      ? oligo.notation
      : sequence &&
          typeof sequence === 'object' &&
          'bases' in sequence &&
          typeof sequence.bases === 'string'
        ? sequence.bases
        : undefined;
  return {
    kind: entity.kind,
    name: entity.name,
    fields,
    ...(scope.oligoNotation === undefined || oligoNotation === undefined ? {} : { oligoNotation }),
  };
}

function primerInput(row: SnapshotRow) {
  if (!row.record.oligoNotation) throw new Error('Spreadsheet oligo chemistry is missing.');
  const orderType = row.record.kind === 'rna_oligo' ? 'rna' : 'dna';
  const parsed = parseIdtOligoNotation(row.record.oligoNotation, { orderType });
  if (parsed.errors.length || !parsed.bases)
    throw new Error('Spreadsheet oligo chemistry needs review.');
  return {
    name: row.record.name,
    sequence: parsed.bases,
    ...(parsed.composition ? { oligo: parsed.composition } : {}),
    entitySchema: createBuiltinPrimerSchemaSnapshot(orderType),
    entityFields: Object.fromEntries(
      Object.entries(row.record.fields).filter(
        ([key]) => !PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(key)
      )
    ),
    notes: typeof row.record.fields.notes === 'string' ? row.record.fields.notes : null,
  };
}

export async function sheetSyncCreateIntent(
  connection: SheetSyncConnection,
  row: SnapshotRow
): Promise<SheetSyncCreateRow> {
  const entityId = crypto.randomUUID();
  if (row.record.kind === 'oligo' || row.record.kind === 'rna_oligo') {
    const keyHash = (await sha256Hex(row.key)).slice(0, 16);
    const prefix = connection.destinationRelativePath
      ? `${connection.destinationRelativePath}/`
      : '';
    return {
      owner: 'primer',
      key: row.key,
      entityId,
      artifactRelativePath: `${prefix}primers/sheet-${connection.id}-${keyHash}.primer.json`,
    };
  }
  return { owner: 'record', key: row.key, entityId };
}

export async function createSheetSyncArtifact(input: {
  workspaceRoot: string;
  connection: SheetSyncConnection;
  row: SnapshotRow;
  intent: SheetSyncCreateRow;
}): Promise<SheetSyncCheckpoint> {
  const { workspaceRoot, connection, row, intent } = input;
  const workspaceId = await resolveWorkspaceId(workspaceRoot);
  if (workspaceId == null) throw new Error('Spreadsheet project ownership is unavailable.');
  const [priorEntity] = await queryLimsEntities({
    id: intent.entityId,
    includeArchived: true,
    limit: 1,
  });
  if (priorEntity && priorEntity.workspaceId !== workspaceId)
    throw new Error('The pending spreadsheet identity belongs to another project.');
  const locator = priorEntity?.fields.artifact;
  const existingRelativePath =
    locator &&
    typeof locator === 'object' &&
    'relativePath' in locator &&
    typeof locator.relativePath === 'string' &&
    isSafeWorkspaceRelativePath(locator.relativePath)
      ? locator.relativePath
      : undefined;
  if (priorEntity && !existingRelativePath)
    throw new Error('The pending spreadsheet identity has no matching record file.');
  const sourceName =
    'provider' in connection.source
      ? `${connection.source.spreadsheetId}/${connection.source.sheetId}`
      : (connection.source.path.split(/[\\/]/).pop() ?? connection.source.path);
  if (intent.owner === 'primer')
    return withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
      const relativePath = existingRelativePath ?? intent.artifactRelativePath;
      const artifactPath = sheetSyncWorkspacePath(workspaceRoot, relativePath);
      if (await platform().fs.exists(artifactPath)) {
        const loaded = await readPrimerArtifactAtPath(artifactPath, workspaceRoot);
        if (loaded.artifact.id !== intent.entityId)
          throw new Error('A different oligo occupies the pending spreadsheet path.');
        const [existing] = await queryLimsEntities({
          id: intent.entityId,
          includeArchived: true,
          limit: 1,
        });
        if (!existing?.tombstone && existing?.archivedAt == null)
          await reconcilePrimerArtifact(artifactPath, workspaceRoot, { mutationToken });
        return {
          key: row.key,
          entityId: intent.entityId,
          artifactRelativePath: relativePath,
          source: row.record,
          applied: row.record,
        };
      }
      if (priorEntity) throw new Error('The pending spreadsheet oligo file is missing.');
      const result = await recordPrimers({
        workspaceRoot,
        origin: 'import',
        deferCommit: true,
        mutationToken,
        primers: [{ ...primerInput(row), artifactId: intent.entityId, artifactPath }],
      });
      if (result.failed.length) throw new Error(result.failed[0].message);
      const saved = result.recorded[0];
      if (!saved) throw new Error('Spreadsheet oligo was not recorded.');
      return {
        key: row.key,
        entityId: saved.artifact.id,
        artifactRelativePath: saved.artifact.file.workspaceRelativePath,
        source: row.record,
        applied: sheetSyncEntityRecord(saved.limsEntity, row.record),
      };
    });
  const destinationDir = connection.destinationRelativePath
    ? sheetSyncWorkspacePath(workspaceRoot, connection.destinationRelativePath)
    : workspaceRoot;
  const stem = sanitizeEntityArtifactStem(`sheet-${intent.entityId}`);
  const prefix = connection.destinationRelativePath ? `${connection.destinationRelativePath}/` : '';
  const relativePath = existingRelativePath ?? `${prefix}${stem}${ENTITY_ARTIFACT_SUFFIX}`;
  const path = sheetSyncWorkspacePath(workspaceRoot, relativePath);
  const recordId = `sheet-sync:${connection.id}:${row.key}`;
  if (await platform().fs.exists(path)) {
    const artifact = parseEntityArtifact(await platform().fs.readTextFile(path));
    if (
      artifact.id !== intent.entityId ||
      artifact.source.type === 'manual' ||
      artifact.source.recordId !== recordId
    )
      throw new Error('A different record occupies the pending spreadsheet path.');
    await reconcileWorkspaceAfterFilesChanged({ workspaceRoot, strict: true });
    return {
      key: row.key,
      entityId: intent.entityId,
      artifactRelativePath: relativePath,
      source: row.record,
      applied: row.record,
    };
  }
  if (priorEntity) throw new Error('The pending spreadsheet record file is missing.');
  const source = {
    type: 'file_import' as const,
    recordId,
    sourceName,
    sourceKind: 'xlsx' as const,
    sourceRow: row.sourceRow,
    values: row.values,
  };
  if (row.record.kind === 'protein') {
    const sequence = row.record.fields.sequence;
    if (
      !sequence ||
      typeof sequence !== 'object' ||
      !('aminoAcids' in sequence) ||
      typeof sequence.aminoAcids !== 'string'
    )
      throw new Error('Spreadsheet proteins need a complete sequence.');
    const saved = await recordProtein({
      id: intent.entityId,
      artifactStem: stem,
      name: row.record.name,
      sequence: sequence.aminoAcids,
      entityFields: row.record.fields,
      workspaceRoot,
      dir: destinationDir,
      source,
      deferCommit: true,
    });
    return {
      key: row.key,
      entityId: saved.artifact.id,
      artifactRelativePath: saved.artifactPath,
      source: row.record,
      applied: sheetSyncEntityRecord(saved.limsEntity, row.record),
    };
  }
  const saved = await recordEntityArtifact({
    id: intent.entityId,
    artifactStem: stem,
    kind: row.record.kind,
    name: row.record.name,
    fields: row.record.fields,
    workspaceRoot,
    destinationDir,
    source,
    deferCommit: true,
  });
  return {
    key: row.key,
    entityId: saved.artifact.id,
    artifactRelativePath: saved.relativePath,
    source: row.record,
    applied: sheetSyncEntityRecord(saved.artifact, row.record),
  };
}

export async function updateSheetSyncPrimer(input: {
  workspaceRoot: string;
  row: SnapshotRow;
  checkpoint: SheetSyncCheckpoint;
  pending: Extract<
    NonNullable<SheetSyncConnection['pending']>['operation'],
    { kind: 'update-primer' }
  >;
}): Promise<SheetSyncCheckpoint> {
  const { workspaceRoot, row, checkpoint, pending } = input;
  return withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
    const workspaceId = await resolveWorkspaceId(workspaceRoot);
    if (workspaceId == null) throw new Error('Spreadsheet project ownership is unavailable.');
    const [current] = await queryLimsEntities({
      id: pending.entityId,
      workspaceId,
      includeArchived: true,
      limit: 1,
    });
    if (!current || current.tombstone || current.archivedAt != null)
      throw new Error('The spreadsheet target is missing or archived.');
    const path = sheetSyncWorkspacePath(workspaceRoot, pending.artifactRelativePath);
    const loaded = await readPrimerArtifactAtPath(path, workspaceRoot);
    const before = parsePrimerArtifact(pending.priorContent);
    if (loaded.artifact.id !== pending.entityId || before.id !== pending.entityId)
      throw new Error('Spreadsheet oligo identity changed.');
    if (loaded.artifact.artifactRevision !== before.artifactRevision) {
      await reconcilePrimerArtifact(path, workspaceRoot, { mutationToken });
      const [entity] = await queryLimsEntities({
        id: pending.entityId,
        includeArchived: true,
        limit: 1,
      });
      if (
        entity &&
        sheetSyncRecordKey(
          sheetSyncMappedTarget(row.record, sheetSyncEntityRecord(entity, row.record))
        ) === sheetSyncRecordKey(row.record)
      )
        return { ...checkpoint, source: row.record, applied: row.record };
      throw new Error(
        'The oligo changed during synchronization. Recheck changes before continuing.'
      );
    }
    const desired = primerInput(row);
    const fields = { ...before.entity?.fields };
    for (const key of Object.keys(checkpoint.source.fields))
      if (!PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(key)) delete fields[key];
    Object.assign(fields, desired.entityFields);
    const ownsNotes =
      Object.prototype.hasOwnProperty.call(checkpoint.source.fields, 'notes') ||
      Object.prototype.hasOwnProperty.call(row.record.fields, 'notes');
    const notes = ownsNotes
      ? typeof fields.notes === 'string'
        ? fields.notes
        : null
      : before.metadata.notes;
    const saved = await updatePrimerArtifactContent({
      artifactPath: path,
      workspaceRoot,
      expectedArtifactRevision: before.artifactRevision,
      mutationToken,
      name: desired.name,
      sequence: desired.sequence,
      oligo: desired.oligo ?? null,
      notes,
      entitySchema: before.entity?.schema ?? desired.entitySchema,
      entityFields: fields,
    });
    return {
      ...checkpoint,
      source: row.record,
      applied: sheetSyncEntityRecord(saved.limsEntity, row.record),
    };
  });
}
