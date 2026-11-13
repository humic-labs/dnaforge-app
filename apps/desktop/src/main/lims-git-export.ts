import {
  appendFileSync,
  closeSync,
  constants,
  fsyncSync,
  openSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import type Database from 'better-sqlite3';
import {
  limsEntityFromRow,
  type DnaSequenceRef,
  type LimsAuditRow,
  type LimsEntityRow,
} from '../shared/lims';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';

const EXPORT_SCHEMA = 'waypoint.lims.event.v1';
const EXPORT_VERSION = 1;

export interface MaterializeLimsGitExportInput {
  workspaceRoot?: string;
  workspaceId?: number | null;
  exportRoot?: string;
  outputRoot?: string;
  durable?: boolean;
}

export interface MaterializeLimsGitExportResult {
  workspaceRoot: string;
  appendedEvents: number;
  exportedThroughEventSeq: number;
  logFiles: string[];
  oligosCsvPath: string;
}

interface LimsExportManifest {
  version: number;
  exportedThroughEventSeq: number;
  updatedAt: string;
}

interface ResolvedLimsExportWorkspace {
  workspaceRoot: string;
  workspaceId: number | null;
}

interface LimsAuditExportEvent {
  schema: typeof EXPORT_SCHEMA;
  eventId: string;
  eventSeq: number;
  schemaVersion: number;
  idempotencyKey: string;
  operationId: string | null;
  eventType: string;
  actor: {
    clientId: string | null;
    userId: string | null;
    legacy: string | null;
  };
  createdAt: string;
  createdAtMs: number;
  subjectType: string | null;
  subjectId: string | null;
  batchId: string | null;
  workspaceId: number | null;
  before: unknown;
  after: unknown;
  payload: unknown;
  prevHash: string | null;
  hash: string | null;
}

export function materializeLimsGitReadableExportInDb(
  db: Database.Database,
  input: MaterializeLimsGitExportInput
): MaterializeLimsGitExportResult {
  const { workspaceRoot, workspaceId } = resolveWorkspace(db, input);
  const outputRoot = input.outputRoot ?? workspaceRoot;
  assertWorkspaceWriteAllowed(db, [outputRoot]);
  const paths = exportPaths(outputRoot);
  assertLimsProjectionPathsSafe(outputRoot, paths);
  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(paths.sheetsDir, { recursive: true });
  assertLimsProjectionPathsSafe(outputRoot, paths);

  const manifest = readManifest(paths.manifestPath);
  const exportedHighWater = reconcileExportLogWithAudit(db, paths.logDir, manifest);
  const rows = db
    .prepare(`SELECT * FROM lims_audit WHERE event_seq > ? ORDER BY event_seq ASC`)
    .all(exportedHighWater) as LimsAuditRow[];
  const appendedLogFiles = appendAuditRows(paths.logDir, rows);
  const exportedThroughEventSeq =
    rows.length > 0 ? rows[rows.length - 1].event_seq : exportedHighWater;

  writeFileIfChanged(paths.oligosCsvPath, buildOligosCsv(db, workspaceId));
  const updatedAt =
    exportedThroughEventSeq === manifest.exportedThroughEventSeq && manifest.updatedAt
      ? manifest.updatedAt
      : new Date().toISOString();
  writeFileIfChanged(
    paths.manifestPath,
    `${JSON.stringify(
      {
        version: EXPORT_VERSION,
        exportedThroughEventSeq,
        updatedAt,
      } satisfies LimsExportManifest,
      null,
      2
    )}\n`
  );

  if (input.durable) {
    const flush = (path: string, directory = false) => {
      if (directory && process.platform === 'win32') return;
      assertWorkspaceProjectionPathSafe(outputRoot, path);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    for (const name of readdirSync(paths.logDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort())
      flush(join(paths.logDir, name));
    flush(paths.oligosCsvPath);
    flush(paths.logDir, true);
    flush(paths.sheetsDir, true);
    flush(paths.manifestPath);
    flush(paths.limsDir, true);
    flush(join(outputRoot, '.waypoint'), true);
    flush(outputRoot, true);
  }

  return {
    workspaceRoot,
    appendedEvents: rows.length,
    exportedThroughEventSeq,
    logFiles: appendedLogFiles,
    oligosCsvPath: paths.oligosCsvPath,
  };
}

export function materializeLimsGlobalRegistryExportInDb(
  db: Database.Database,
  exportRoot: string
): MaterializeLimsGitExportResult {
  return materializeLimsGitReadableExportInDb(db, { exportRoot });
}

export function readLimsAuditExportRowsFromWorkspace(workspaceRoot: string): LimsAuditRow[] {
  const resolvedRoot = resolve(workspaceRoot);
  const paths = exportPaths(resolvedRoot);
  const { logDir } = paths;
  if (!existsSync(logDir)) return [];
  assertLimsProjectionPathsSafe(resolvedRoot, paths);
  const rows: LimsAuditRow[] = [];
  for (const name of readdirSync(logDir)
    .filter((entry) => entry.endsWith('.jsonl'))
    .sort()) {
    const text = readFileSync(join(logDir, name), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      rows.push(auditRowFromExportEvent(JSON.parse(line) as LimsAuditExportEvent));
    }
  }
  return rows.sort((a, b) => a.event_seq - b.event_seq);
}

function resolveWorkspace(
  db: Database.Database,
  input: MaterializeLimsGitExportInput
): ResolvedLimsExportWorkspace {
  if (input.exportRoot) {
    return { workspaceRoot: resolve(input.exportRoot), workspaceId: null };
  }
  if (input.workspaceRoot) {
    const workspaceRoot = resolve(input.workspaceRoot);
    const row = db.prepare(`SELECT id FROM workspaces WHERE path = ?`).get(workspaceRoot) as
      | { id: number }
      | undefined;
    if (!row) {
      throw new Error(`LIMS git export workspaceRoot is not a known workspace: ${workspaceRoot}`);
    }
    if (input.workspaceId != null && input.workspaceId !== row.id) {
      throw new Error(
        `LIMS git export workspaceRoot ${workspaceRoot} belongs to workspace ${row.id}, not ${input.workspaceId}`
      );
    }
    return { workspaceRoot, workspaceId: row.id };
  }
  if (input.workspaceId != null) {
    const row = db.prepare(`SELECT path FROM workspaces WHERE id = ?`).get(input.workspaceId) as
      | { path: string }
      | undefined;
    if (row) return { workspaceRoot: resolve(row.path), workspaceId: input.workspaceId };
    throw new Error(`LIMS git export workspaceId is not known: ${input.workspaceId}`);
  }
  throw new Error('LIMS git export requires a workspaceRoot or known workspaceId');
}

function exportPaths(workspaceRoot: string): {
  limsDir: string;
  logDir: string;
  sheetsDir: string;
  manifestPath: string;
  oligosCsvPath: string;
} {
  const limsDir = join(workspaceRoot, '.waypoint', 'lims');
  const logDir = join(limsDir, 'log');
  const sheetsDir = join(limsDir, 'sheets');
  return {
    limsDir,
    logDir,
    sheetsDir,
    manifestPath: join(limsDir, 'manifest.json'),
    oligosCsvPath: join(sheetsDir, 'oligos.csv'),
  };
}

function assertLimsProjectionPathsSafe(
  workspaceRoot: string,
  paths: ReturnType<typeof exportPaths>
): void {
  for (const path of [
    paths.limsDir,
    paths.logDir,
    paths.sheetsDir,
    paths.manifestPath,
    paths.oligosCsvPath,
  ]) {
    assertWorkspaceProjectionPathSafe(workspaceRoot, path);
  }
  if (!existsSync(paths.logDir)) return;
  for (const name of readdirSync(paths.logDir)) {
    assertWorkspaceProjectionPathSafe(workspaceRoot, join(paths.logDir, name));
  }
}

function readManifest(path: string): LimsExportManifest {
  if (!existsSync(path)) {
    return { version: EXPORT_VERSION, exportedThroughEventSeq: 0, updatedAt: '' };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LimsExportManifest>;
    return {
      version: parsed.version ?? EXPORT_VERSION,
      exportedThroughEventSeq: parsed.exportedThroughEventSeq ?? 0,
      updatedAt: parsed.updatedAt ?? '',
    };
  } catch {
    return { version: EXPORT_VERSION, exportedThroughEventSeq: 0, updatedAt: '' };
  }
}

function reconcileExportLogWithAudit(
  db: Database.Database,
  logDir: string,
  manifest: LimsExportManifest
): number {
  const logRows = tryReadAuditExportRowsFromLogDir(logDir);
  if (!logRows) {
    rewriteAuditRows(logDir, auditRowsThrough(db, Number.MAX_SAFE_INTEGER));
    return maxEventSeq(tryReadAuditExportRowsFromLogDir(logDir) ?? []);
  }
  const logHighWater = maxEventSeq(logRows);
  const manifestHighWater = manifest.exportedThroughEventSeq;
  if (logHighWater < manifestHighWater || !exportLogRowsMatchAudit(db, logRows, logHighWater)) {
    rewriteAuditRows(logDir, auditRowsThrough(db, Number.MAX_SAFE_INTEGER));
    return maxEventSeq(tryReadAuditExportRowsFromLogDir(logDir) ?? []);
  }
  return Math.max(logHighWater, manifestHighWater);
}

function tryReadAuditExportRowsFromLogDir(logDir: string): LimsAuditRow[] | null {
  try {
    if (!existsSync(logDir)) return [];
    const rows: LimsAuditRow[] = [];
    for (const name of readdirSync(logDir)
      .filter((entry) => entry.endsWith('.jsonl'))
      .sort()) {
      const text = readFileSync(join(logDir, name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        rows.push(auditRowFromExportEvent(JSON.parse(line) as LimsAuditExportEvent));
      }
    }
    return rows.sort((a, b) => a.event_seq - b.event_seq);
  } catch {
    return null;
  }
}

function maxEventSeq(rows: readonly LimsAuditRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.event_seq), 0);
}

function auditRowsThrough(db: Database.Database, eventSeq: number): LimsAuditRow[] {
  return db
    .prepare(`SELECT * FROM lims_audit WHERE event_seq <= ? ORDER BY event_seq ASC`)
    .all(eventSeq) as LimsAuditRow[];
}

function exportLogRowsMatchAudit(
  db: Database.Database,
  logRows: readonly LimsAuditRow[],
  highWater: number
): boolean {
  const auditRows = auditRowsThrough(db, highWater);
  if (auditRows.length !== logRows.length) return false;
  for (let i = 0; i < auditRows.length; i++) {
    const auditRow = auditRows[i];
    const logRow = logRows[i];
    if (
      auditRow.id !== logRow.id ||
      auditRow.event_seq !== logRow.event_seq ||
      (auditRow.idempotency_key ?? `lims:v0:${auditRow.id}`) !==
        (logRow.idempotency_key ?? `lims:v0:${logRow.id}`) ||
      (auditRow.hash ?? null) !== (logRow.hash ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function rewriteAuditRows(logDir: string, rows: readonly LimsAuditRow[]): void {
  mkdirSync(logDir, { recursive: true });
  for (const name of readdirSync(logDir).filter((entry) => entry.endsWith('.jsonl'))) {
    unlinkSync(join(logDir, name));
  }
  appendAuditRows(logDir, rows);
}

function appendAuditRows(logDir: string, rows: readonly LimsAuditRow[]): string[] {
  const byShard = new Map<string, string[]>();
  for (const row of rows) {
    const shard = join(logDir, `${monthShard(row.created_at)}.jsonl`);
    const lines = byShard.get(shard) ?? [];
    lines.push(JSON.stringify(exportEventFromAuditRow(row)));
    byShard.set(shard, lines);
  }
  for (const [path, lines] of byShard) {
    appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  }
  return [...byShard.keys()].sort();
}

function monthShard(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function exportEventFromAuditRow(row: LimsAuditRow): LimsAuditExportEvent {
  return {
    schema: EXPORT_SCHEMA,
    eventId: row.id,
    eventSeq: row.event_seq,
    schemaVersion: row.schema_version ?? 0,
    idempotencyKey: row.idempotency_key ?? `lims:v0:${row.id}`,
    operationId: row.operation_id,
    eventType: row.event_type,
    actor: {
      clientId: row.actor_client_id,
      userId: row.actor_user_id,
      legacy: row.actor,
    },
    createdAt: new Date(row.created_at).toISOString(),
    createdAtMs: row.created_at,
    subjectType: row.subject_table,
    subjectId: row.subject_id,
    batchId: row.batch_id,
    workspaceId: row.workspace_id,
    before: parseJson(row.before),
    after: parseJson(row.after),
    payload: parseJson(row.payload),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

function auditRowFromExportEvent(event: LimsAuditExportEvent): LimsAuditRow {
  const createdAt =
    typeof event.createdAtMs === 'number' ? event.createdAtMs : Date.parse(event.createdAt);
  return {
    id: event.eventId,
    event_seq: event.eventSeq,
    schema_version: event.schemaVersion,
    idempotency_key: event.idempotencyKey,
    operation_id: event.operationId,
    event_type: event.eventType,
    subject_table: event.subjectType,
    subject_id: event.subjectId,
    batch_id: event.batchId,
    actor: event.actor?.legacy ?? event.actor?.userId ?? null,
    actor_client_id: event.actor?.clientId ?? null,
    actor_user_id: event.actor?.userId ?? null,
    workspace_id: event.workspaceId,
    before: event.before == null ? null : JSON.stringify(event.before),
    after: event.after == null ? null : JSON.stringify(event.after),
    payload: event.payload == null ? null : JSON.stringify(event.payload),
    prev_hash: event.prevHash,
    hash: event.hash,
    tombstone: 0,
    created_at: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

function buildOligosCsv(db: Database.Database, workspaceId: number | null): string {
  const rows = db
    .prepare(
      `SELECT * FROM lims_entity
       WHERE kind = 'oligo' AND tombstone = 0
         AND (? IS NULL OR workspace_id = ? OR workspace_id IS NULL)
       ORDER BY registry_id IS NULL, registry_id, name, id`
    )
    .all(workspaceId, workspaceId) as LimsEntityRow[];
  const header = [
    'entity_id',
    'registry_id',
    'name',
    'sequence',
    'sequence_mode',
    'length',
    'topology',
    'use',
    'updated_at',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    const entity = limsEntityFromRow(row);
    const sequence = sequenceRefFromFields(entity.fields);
    lines.push(
      [
        entity.id,
        entity.registryId ?? '',
        entity.name,
        sequenceValue(sequence),
        sequence?.mode ?? '',
        sequence && 'length' in sequence ? String(sequence.length) : '',
        sequence && 'topology' in sequence ? sequence.topology : '',
        typeof entity.fields.use === 'string' ? entity.fields.use : '',
        new Date(entity.updatedAt).toISOString(),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

function sequenceRefFromFields(fields: Record<string, unknown>): DnaSequenceRef | null {
  const value = fields.sequence;
  return value && typeof value === 'object' ? (value as DnaSequenceRef) : null;
}

function sequenceValue(ref: DnaSequenceRef | null): string {
  if (!ref) return '';
  if (ref.mode === 'inline') return ref.bases;
  if (ref.mode === 'file') return ref.relPath;
  return '';
}

function parseJson(value: string | null | undefined): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function writeFileIfChanged(path: string, contents: string): void {
  try {
    if (readFileSync(path, 'utf8') === contents) return;
  } catch {}
  writeFileSync(path, contents, 'utf8');
}
