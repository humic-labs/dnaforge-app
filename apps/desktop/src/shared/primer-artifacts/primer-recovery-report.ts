import { readRetainedPrimerSource, type PrimerRestoreSelection } from './primer-source-history';
import { userMessage } from '@waypoint/user-messages';
import {
  parsePrimerArtifact,
  validatePrimerArtifactPath,
  PRIMER_ARTIFACT_SCHEMA,
} from './primer-artifact';
import { parseEntityArtifact } from '../entity-artifact';
import { isEntityRecordArtifactProjection } from '../registry-file-types';
import type { OriginalDefaultProjectResolution } from '../first-project';
import type { PrimerRecoveryDependencies } from './primer-recovery-port';
type FileLocationReason = 'primer.recoveryFileMissing' | 'primer.recoveryFileOutside';
type RecoveryReason = FileLocationReason | 'recovery-failed';

export class PrimerRecoveryFileError extends Error {
  constructor(
    readonly reason: FileLocationReason,
    message: string = userMessage(reason)
  ) {
    super(message);
  }
}

export function primerRecoveryDiagnostic(error: unknown): {
  reason: RecoveryReason;
  message: string;
} {
  return {
    reason: error instanceof PrimerRecoveryFileError ? error.reason : 'recovery-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

const legacyFileLocationMessages = new Set([
  'The saved primer document is outside its recorded project.',
  'The saved primer file is missing. Restore it from project history or a backup.',
  'The primer already had an authoritative document; restore that document before recovery.',
]);

export interface PrimerRecordRecoveryResult {
  recovered: number;
  errors: Array<{ path: string; message: string; primerName?: string }>;
  pendingArtifactPaths: string[];
  project?: { workspaceId: number; repoUuid: string | null };
  records: Array<{
    id: string;
    name: string;
    source: 'registry' | 'legacy';
    status: 'document-backed' | 'recovered' | 'unresolved' | 'trashed';
    artifactPath?: string;
    reason?: RecoveryReason;
    message?: string;
  }>;
}
export const PRIMER_RECOVERY_PROJECT_REPORT_PREFIX = 'primer_recovery_project_v1:';
export const PRIMER_RECOVERY_INVENTORY_SETTING = 'primer_recovery_inventory_v1';
export interface PrimerRecoveryInventory {
  schema: 'dnaforge.primer-recovery-inventory/v1';
  recordedAt: number;
  originalProject?: OriginalDefaultProjectResolution;
  entries: Array<{
    id: string;
    name: string;
    source: 'registry' | 'legacy';
    workspaceId: number | null;
    projectUuid: string | null;
    status: 'legacy-library' | 'document-backed' | 'pending-recovery' | 'needs-review' | 'trashed';
    restore?: PrimerRestoreSelection;
    message?: string;
  }>;
}
interface ProjectRow {
  id: number;
  repo_uuid: string | null;
  path: string;
  name: string;
  archived_at: number | null;
  trashed_at: number | null;
  access_mode: string;
}
interface SourceRow {
  id: string;
  name: string;
  workspace_id: number | null;
  fields: string | null;
  origin_details: string | null;
  source: 'registry' | 'legacy';
  has_document_history: number;
}
export function createPrimerRecoveryReportOwner(dependencies: PrimerRecoveryDependencies) {
  const platform = dependencies.io;
  const { setSetting, getLimsRegistryPreview, findTrashedPrimerDocument } = dependencies;
  async function readPrimerRecoveryDocument(
    path: string,
    workspaceRoot: string
  ): Promise<{
    id: string;
    recoveredSource?: 'registry' | 'legacy';
  }> {
    const fs = platform().fs;
    if (!(await fs.validateWorkspacePath({ workspaceRoot, path }))) {
      if (!(await fs.exists(workspaceRoot)))
        throw new Error(userMessage('primer.recoveryProjectUnavailable'));
      if (
        (await fs.validateWorkspacePath({ workspaceRoot, path, allowMissing: true })) &&
        !(await fs.exists(path))
      )
        throw new PrimerRecoveryFileError('primer.recoveryFileMissing');
      throw new PrimerRecoveryFileError('primer.recoveryFileOutside');
    }
    const content = await platform().fs.readTextFile(path);
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== 'object' || !('schema' in raw))
      throw new Error('The saved primer document format is invalid.');
    if (raw.schema === PRIMER_ARTIFACT_SCHEMA) {
      const artifact = parsePrimerArtifact(content);
      const location = validatePrimerArtifactPath(path, workspaceRoot);
      if (!location.valid || artifact.file.workspaceRelativePath !== location.relativePath)
        throw new Error('The saved primer document path does not match its manifest.');
      return { id: artifact.id, recoveredSource: artifact.recovery?.source };
    }
    if (isEntityRecordArtifactProjection({ artifact: { schema: raw.schema } }))
      return { id: parseEntityArtifact(content).id };
    throw new Error('The saved document does not use a supported Registry record format.');
  }
  let latestInventory: PrimerRecoveryInventory | null = null;
  let inventoryQueue: Promise<void> = Promise.resolve();
  function getLatestPrimerRecoveryInventory(): PrimerRecoveryInventory | null {
    return latestInventory;
  }
  function refreshPrimerRecoveryInventory(): Promise<PrimerRecoveryInventory> {
    const next = inventoryQueue.then(buildPrimerRecoveryInventory);
    inventoryQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
  async function buildPrimerRecoveryInventory(): Promise<PrimerRecoveryInventory> {
    const [rows, projects, savedReports, files] = await Promise.all([
      platform().db.select<SourceRow[]>(`SELECT e.id, e.name, e.workspace_id, e.fields,
      NULL AS origin_details, 'registry' AS source, 0 AS has_document_history FROM lims_entity e
      JOIN lims_schema_revision r ON r.id = e.schema_revision_id
      WHERE e.kind IN ('oligo', 'rna_oligo')
        OR CASE WHEN json_valid(e.fields) THEN json_extract(e.fields, '$.use') END = 'primer'
        OR CASE WHEN json_valid(r.fields) THEN json_extract(r.fields, '$.baseKind') END = 'primer'
      UNION ALL SELECT p.id, p.name, p.workspace_id, NULL AS fields, p.origin_details,
      'legacy' AS source,
      EXISTS(SELECT 1 FROM catalog_entity_files f WHERE f.entity_id = p.id) AS has_document_history
      FROM primers p
      WHERE NOT EXISTS (SELECT 1 FROM lims_entity e WHERE e.id = p.id) ORDER BY id`),
      platform().db.select<ProjectRow[]>(
        'SELECT id, repo_uuid, path, name, archived_at, trashed_at, access_mode FROM workspaces'
      ),
      platform().db.select<Array<{ value: string }>>(
        'SELECT value FROM settings WHERE key LIKE ?',
        [`${PRIMER_RECOVERY_PROJECT_REPORT_PREFIX}%`]
      ),
      platform().db.select<Array<{ entity_id: string; path: string }>>(
        "SELECT entity_id, path FROM catalog_entity_files WHERE status = 'current'"
      ),
    ]);
    const owners = new Map(projects.map((project) => [project.id, project]));
    const issues = new Map<string, Array<{ message: string; fileLocation: boolean }>>();
    for (const report of savedReports) {
      const parsed: unknown = JSON.parse(report.value);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('records' in parsed) ||
        !Array.isArray(parsed.records)
      )
        continue;
      for (const record of parsed.records) {
        if (
          record?.status === 'unresolved' &&
          typeof record.id === 'string' &&
          typeof record.message === 'string'
        ) {
          const fileLocation =
            record.reason === 'primer.recoveryFileMissing' ||
            record.reason === 'primer.recoveryFileOutside' ||
            (record.reason === undefined &&
              'schema' in parsed &&
              parsed.schema === 'dnaforge.primer-recovery-report/v1' &&
              legacyFileLocationMessages.has(record.message));
          const issue = { message: record.message, fileLocation };
          const existing = issues.get(record.id);
          if (existing) existing.push(issue);
          else issues.set(record.id, [issue]);
        }
      }
    }
    const legacyLibrary = new Set(
      rows
        .filter((row) => {
          if (
            row.source !== 'legacy' ||
            row.workspace_id != null ||
            row.has_document_history ||
            issues.has(row.id)
          )
            return false;
          if (!row.origin_details) return true;
          try {
            const details: unknown = JSON.parse(row.origin_details);
            return (
              details === null ||
              (typeof details === 'object' &&
                !Array.isArray(details) &&
                !('limsEntityId' in details) &&
                (!('authority' in details) || details.authority !== 'primer_artifact'))
            );
          } catch {
            return false;
          }
        })
        .map((row) => row.id)
    );
    const defaultProject = rows.some(
      (row) => row.workspace_id == null && !legacyLibrary.has(row.id)
    )
      ? await platform().workspace.getOriginalDefaultProject()
      : null;
    const report: PrimerRecoveryInventory = {
      schema: 'dnaforge.primer-recovery-inventory/v1',
      recordedAt: Date.now(),
      ...(defaultProject ? { originalProject: defaultProject } : {}),
      entries: [],
    };
    for (const row of rows) {
      if (legacyLibrary.has(row.id)) {
        report.entries.push({
          id: row.id,
          name: row.name,
          source: 'legacy',
          workspaceId: null,
          projectUuid: null,
          status: 'legacy-library',
        });
        continue;
      }
      const owner =
        row.workspace_id == null && defaultProject?.status === 'ready'
          ? owners.get(defaultProject.project.workspaceId)
          : owners.get(row.workspace_id ?? -1);
      const entry: PrimerRecoveryInventory['entries'][number] = {
        id: row.id,
        name: row.name,
        source: row.source,
        workspaceId: owner?.id ?? row.workspace_id,
        projectUuid: owner?.repo_uuid ?? null,
        status: 'pending-recovery',
      };
      try {
        const fields = row.fields ? (JSON.parse(row.fields) as Record<string, unknown>) : null;
        if (fields && fields.use !== 'primer') {
          if (
            fields.use !== undefined ||
            (await getLimsRegistryPreview({ entityId: row.id })).schemaSnapshot.baseKind !==
              'primer'
          )
            continue;
        }
        if (!owner)
          throw new Error(
            row.workspace_id != null
              ? "The primer's original project is no longer registered."
              : defaultProject?.status === 'unresolved'
                ? defaultProject.message
                : 'The original My Project has not been identified.'
          );
        const reference = fields?.artifact;
        const relative =
          reference && typeof reference === 'object' && 'relativePath' in reference
            ? reference.relativePath
            : null;
        const paths =
          typeof relative === 'string'
            ? [`${owner.path.replace(/[\\/]+$/, '')}/${relative}`]
            : files.filter((file) => file.entity_id === row.id).map((file) => file.path);
        if (
          (row.source === 'legacy' ||
            (reference &&
              typeof reference === 'object' &&
              'schema' in reference &&
              reference.schema === PRIMER_ARTIFACT_SCHEMA)) &&
          (await findTrashedPrimerDocument(row.id, paths[0]))
        ) {
          entry.status = 'trashed';
          report.entries.push(entry);
          continue;
        }
        if (paths.length > 1)
          throw new Error(
            'This primer has more than one current document; preserve them for review.'
          );
        let verifiedDocument = false;
        if (paths.length === 1) {
          const path = paths[0];
          const artifact = await readPrimerRecoveryDocument(path, owner.path);
          if (artifact.id !== row.id)
            throw new Error('The saved primer document belongs to a different record.');
          verifiedDocument = true;
          if (row.source === 'registry') entry.status = 'document-backed';
        } else if (reference !== undefined && reference !== null) {
          throw new Error('The saved primer document reference is invalid.');
        }
        if (entry.status !== 'document-backed') {
          if (owner.trashed_at != null)
            throw new Error("Restore the primer's project from Trash before recovery.");
          if (owner.archived_at != null)
            throw new Error("Restore the primer's archived project before recovery.");
          if (owner.access_mode !== 'writable')
            throw new Error("The primer's project must be writable before recovery.");
          if (!(await platform().fs.exists(owner.path)))
            throw new Error("The primer's project is unavailable on this device.");
        }
        const issue = issues.get(row.id)?.find((issue) => !issue.fileLocation || !verifiedDocument);
        if (issue) throw new Error(issue.message);
      } catch (error) {
        entry.status = 'needs-review';
        entry.message = error instanceof Error ? error.message : String(error);
        if (
          error instanceof PrimerRecoveryFileError &&
          error.reason === 'primer.recoveryFileMissing'
        ) {
          try {
            const source = await readRetainedPrimerSource(platform(), row.id);
            if (source) {
              entry.restore = {
                id: row.id,
                root: source.root,
                relativePath: source.relativePath,
                sha256: source.sha256,
              };
              entry.message = userMessage('primer.recoverySavedCopyAvailable');
            }
          } catch (sourceError) {
            entry.message =
              sourceError instanceof Error ? sourceError.message : String(sourceError);
          }
        }
      }
      report.entries.push(entry);
    }
    await setSetting(PRIMER_RECOVERY_INVENTORY_SETTING, JSON.stringify(report));
    latestInventory = report;
    return report;
  }
  async function persistPrimerRecoveryReport(
    workspaceRoot: string,
    recovery: PrimerRecordRecoveryResult,
    errors: readonly { path: string; message: string }[]
  ): Promise<void> {
    if (!recovery.project) return;
    const identity = recovery.project.repoUuid ?? `workspace:${recovery.project.workspaceId}`;
    await setSetting(
      `${PRIMER_RECOVERY_PROJECT_REPORT_PREFIX}${identity}`,
      JSON.stringify({
        schema: 'dnaforge.primer-recovery-report/v1',
        recordedAt: Date.now(),
        project: recovery.project,
        workspaceRoot,
        records: recovery.records,
        errors,
      })
    );
    await refreshPrimerRecoveryInventory();
  }
  return {
    readPrimerRecoveryDocument,
    getLatestPrimerRecoveryInventory,
    refreshPrimerRecoveryInventory,
    persistPrimerRecoveryReport,
  };
}
