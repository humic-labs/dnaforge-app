import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../../shared/canonical-json';
import type { ComputeImportDetails } from '../../shared/compute-jobs-ipc';
import { assertWorkspaceWriteAllowed } from '../workspace-write-admission';
import { rebindCatalogFilesInDb } from '../catalog-projection-commands';
import {
  computeNativeBindingRows,
  computeNativeIdentityWitness,
  computeNativeCatalogHead,
  type ComputeNativePlan,
} from './compute-native-result-members';

const RECEIPT_SCHEMA = 'dnaforge.compute-result-migration-receipt.v1';

export interface ComputeResultJobWitness {
  workspaceId: number;
  workspaceRoot: string;
  workspaceRepoUuid: string;
  jobId: string;
  provider: string;
  remoteId: string;
  sourceRelativePath: string;
  previousPathsJson: string;
  previousDetailsJson: string | null;
}

export interface ComputeResultPublication {
  operationId: string;
  planSha256: string;
  sourceTreeSha256: string;
  targetRelativePaths: string[];
  previews: ComputeImportDetails['outputs'];
  native?: ComputeNativePlan;
  nativeTargetRelativeRoot?: string;
}

export class ComputeResultPublicationConflict extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ComputeResultPublicationConflict';
  }
}

function conflict(code: string): never {
  throw new ComputeResultPublicationConflict(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function relativePath(value: string): void {
  if (
    !value ||
    value.startsWith('/') ||
    /[\\:*?"<>|\0]/u.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
  )
    conflict('COMPUTE_PUBLICATION_PATH_INVALID');
}

function details(content: string | null): ComputeImportDetails & Record<string, unknown> {
  if (content === null) return { receipt: {}, outputs: [] };
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    conflict('COMPUTE_PUBLICATION_DETAILS_INVALID');
  }
  if (!record(value) || !record(value.receipt) || !Array.isArray(value.outputs))
    conflict('COMPUTE_PUBLICATION_DETAILS_INVALID');
  const outputs = value.outputs.map((output: unknown) => {
    if (!record(output) || typeof output.name !== 'string' || typeof output.content !== 'string')
      conflict('COMPUTE_PUBLICATION_DETAILS_INVALID');
    return { ...output, name: output.name, content: output.content };
  });
  return { ...value, receipt: value.receipt, outputs };
}

function workspace(db: Database.Database, root: string) {
  assertWorkspaceWriteAllowed(db, [root]);
  const value: unknown = db
    .prepare('SELECT id,repo_uuid,path FROM workspaces WHERE path=?')
    .get(root);
  if (
    !record(value) ||
    typeof value.id !== 'number' ||
    typeof value.repo_uuid !== 'string' ||
    !value.repo_uuid ||
    value.path !== root
  )
    conflict('COMPUTE_PUBLICATION_WORKSPACE_UNAVAILABLE');
  return { id: value.id, repoUuid: value.repo_uuid };
}

function paths(content: unknown): string[] {
  if (typeof content !== 'string') conflict('COMPUTE_PUBLICATION_IMPORTED_PATHS_INVALID');
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    conflict('COMPUTE_PUBLICATION_IMPORTED_PATHS_INVALID');
  }
  if (!Array.isArray(value) || !value.every((path) => typeof path === 'string'))
    conflict('COMPUTE_PUBLICATION_IMPORTED_PATHS_INVALID');
  return value;
}

export function captureComputeResultJob(
  db: Database.Database,
  input: {
    workspaceRoot: string;
    provider: string;
    remoteId: string;
    sourceRelativePath: string;
  }
): ComputeResultJobWitness {
  relativePath(input.sourceRelativePath);
  if (!/^compute\/[^/]+\/[^/]+$/u.test(input.sourceRelativePath))
    conflict('COMPUTE_PUBLICATION_SOURCE_INVALID');
  const owner = workspace(db, input.workspaceRoot);
  const rows: unknown[] = db
    .prepare(
      `SELECT id,imported_paths_json,import_details_json FROM compute_jobs
       WHERE workspace_root=? AND provider=? AND provider_job_ref=? AND state='imported'`
    )
    .all(input.workspaceRoot, input.provider, input.remoteId);
  if (rows.length !== 1) conflict('COMPUTE_PUBLICATION_JOB_UNAVAILABLE');
  const row = rows[0];
  if (
    !record(row) ||
    typeof row.id !== 'string' ||
    typeof row.imported_paths_json !== 'string' ||
    !(row.import_details_json === null || typeof row.import_details_json === 'string')
  )
    conflict('COMPUTE_PUBLICATION_JOB_INVALID');
  const source = join(input.workspaceRoot, input.sourceRelativePath);
  if (!paths(row.imported_paths_json).some((path) => path.startsWith(`${source}${sep}`)))
    conflict('COMPUTE_PUBLICATION_JOB_SOURCE_MISMATCH');
  details(row.import_details_json);
  return {
    workspaceId: owner.id,
    workspaceRepoUuid: owner.repoUuid,
    workspaceRoot: input.workspaceRoot,
    jobId: row.id,
    provider: input.provider,
    remoteId: input.remoteId,
    sourceRelativePath: input.sourceRelativePath,
    previousPathsJson: row.imported_paths_json,
    previousDetailsJson: row.import_details_json,
  };
}

export function publishComputeResultJob(
  db: Database.Database,
  witness: ComputeResultJobWitness,
  publication: ComputeResultPublication,
  now: number
): { kind: 'committed' | 'already-committed'; receiptSha256: string } {
  if (db.inTransaction) conflict('COMPUTE_PUBLICATION_REQUIRES_OWN_TRANSACTION');
  if (
    !/^[A-Za-z0-9-]{1,200}$/u.test(publication.operationId) ||
    !/^[a-f0-9]{64}$/u.test(publication.planSha256) ||
    !/^[a-f0-9]{64}$/u.test(publication.sourceTreeSha256) ||
    publication.targetRelativePaths.length === 0
  )
    conflict('COMPUTE_PUBLICATION_IDENTITY_INVALID');
  const targets = [...new Set(publication.targetRelativePaths)];
  for (const target of targets) {
    relativePath(target);
    if (target.startsWith('.') || target.startsWith('compute/'))
      conflict('COMPUTE_PUBLICATION_TARGET_INVALID');
  }
  const source = join(witness.workspaceRoot, witness.sourceRelativePath);
  const preservedPaths = paths(witness.previousPathsJson).filter(
    (path) => path !== source && !path.startsWith(`${source}${sep}`)
  );
  const retainedNativePaths = (publication.native?.retainedImportedPaths ?? []).map((path) => {
    relativePath(path);
    return join(source, path);
  });
  const publishedPaths = JSON.stringify([
    ...new Set([
      ...preservedPaths,
      ...retainedNativePaths,
      ...targets.map((target) => join(witness.workspaceRoot, target)),
    ]),
  ]);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    operationId: publication.operationId,
    workspaceRepoUuid: witness.workspaceRepoUuid,
    planSha256: publication.planSha256,
    sourceTreeSha256: publication.sourceTreeSha256,
    sourceRelativePath: witness.sourceRelativePath,
    manifestRelativePath: `.dnaforge/compute-results/${publication.operationId}/manifest.json`,
    targetRelativePaths: targets,
  };
  const receiptJson = canonicalJson(receipt);
  const receiptSha256 = createHash('sha256').update(receiptJson).digest('hex');
  return db
    .transaction(() => {
      const owner = workspace(db, witness.workspaceRoot);
      if (owner.id !== witness.workspaceId || owner.repoUuid !== witness.workspaceRepoUuid)
        conflict('COMPUTE_PUBLICATION_WORKSPACE_CHANGED');
      const row: unknown = db
        .prepare(
          `SELECT workspace_root,provider,provider_job_ref,state,imported_paths_json,import_details_json
         FROM compute_jobs WHERE id=?`
        )
        .get(witness.jobId);
      if (
        !record(row) ||
        row.workspace_root !== witness.workspaceRoot ||
        row.provider !== witness.provider ||
        row.provider_job_ref !== witness.remoteId ||
        row.state !== 'imported' ||
        !(row.import_details_json === null || typeof row.import_details_json === 'string')
      )
        conflict('COMPUTE_PUBLICATION_JOB_CHANGED');
      const currentDetails = details(row.import_details_json);
      const priorReceipt = currentDetails.receipt.legacyResultMigration;
      if (record(priorReceipt)) {
        if (
          canonicalJson(priorReceipt) !== receiptJson ||
          row.imported_paths_json !== publishedPaths
        )
          conflict('COMPUTE_PUBLICATION_OPERATION_CONFLICT');
        return { kind: 'already-committed' as const, receiptSha256 };
      }
      if (
        row.imported_paths_json !== witness.previousPathsJson ||
        row.import_details_json !== witness.previousDetailsJson
      )
        conflict('COMPUTE_PUBLICATION_JOB_CHANGED');
      if (publication.native) {
        if (
          computeNativeCatalogHead(db, witness.workspaceRoot) !==
          publication.native.catalogHeadWitness
        )
          conflict('COMPUTE_PUBLICATION_NATIVE_HEAD_CHANGED');
        if (!publication.nativeTargetRelativeRoot)
          conflict('COMPUTE_PUBLICATION_NATIVE_TARGET_MISSING');
        relativePath(publication.nativeTargetRelativeRoot);
        for (const member of publication.native.members) {
          const oldPath = join(source, member.path);
          if (canonicalJson(computeNativeBindingRows(db, oldPath)) !== member.bindingWitness)
            conflict('COMPUTE_PUBLICATION_NATIVE_OWNER_CHANGED');
          if (
            computeNativeIdentityWitness(db, member.entityId, member.kind) !==
            member.identityWitness
          )
            conflict('COMPUTE_PUBLICATION_NATIVE_IDENTITY_CHANGED');
          if (member.disposition !== 'transfer') continue;
          const moved = rebindCatalogFilesInDb(db, {
            oldPath,
            newPath: join(witness.workspaceRoot, publication.nativeTargetRelativeRoot, member.path),
            workspaceRoot: witness.workspaceRoot,
            actor: 'compute-result-migration',
          });
          if (moved.missingOldPath || !moved.updated)
            conflict('COMPUTE_PUBLICATION_NATIVE_OWNER_CHANGED');
        }
      }
      const nextDetails = {
        ...currentDetails,
        receipt: { ...currentDetails.receipt, legacyResultMigration: receipt },
        outputs: [
          ...currentDetails.outputs,
          ...publication.previews.filter(
            (preview) =>
              !currentDetails.outputs.some(
                (previous) => previous.name === preview.name && previous.content === preview.content
              )
          ),
        ],
      };
      const updated = db
        .prepare(
          `UPDATE compute_jobs SET imported_paths_json=?,import_details_json=?,updated_at=?
         WHERE id=? AND workspace_root=? AND imported_paths_json IS ? AND import_details_json IS ?`
        )
        .run(
          publishedPaths,
          JSON.stringify(nextDetails),
          now,
          witness.jobId,
          witness.workspaceRoot,
          witness.previousPathsJson,
          witness.previousDetailsJson
        );
      if (updated.changes !== 1) conflict('COMPUTE_PUBLICATION_JOB_CHANGED');
      return { kind: 'committed' as const, receiptSha256 };
    })
    .immediate();
}
