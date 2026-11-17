import { parseWorkspaceSyncSelectionMetadata } from './workspace-sync-membership';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { copyIndependentFileSync } from './workspace-git/copy-independent-file';

import type Database from 'better-sqlite3';
import {
  parseWorkspaceSyncScientificHistoryMetadata,
  workspaceSyncScientificContentSha256,
  type WorkspaceSyncScientificHistoryMetadata,
} from './workspace-sync-scientific-history';
import {
  decodeBundleFileContent,
  parseWorkspaceSyncManifest,
  validateWorkspaceSyncBundle,
  workspaceSyncBundleHashInput,
  workspaceSyncManifestHashInput,
  type WorkspaceSyncManifestV1,
  type WorkspaceSyncBundle,
} from '@waypoint/share-bundle';

import { toWorkspaceSyncStatusExcludedSummary } from './workspace-sync-exclusions';
import {
  parseWorkspaceSyncRecoveryCandidateReceipt,
  WORKSPACE_SYNC_RECOVERY_RETENTION_MS,
  type WorkspaceSyncRecoveryCandidateIntent,
  type WorkspaceSyncRecoveryCandidateReceipt,
  type WorkspaceSyncRecoveryOperationIdentity,
} from './workspace-sync-recovery-candidate';
import type {
  WorkspaceSyncSnapshot,
  WorkspaceSyncUploadCapture,
} from './workspace-sync-snapshotter';

const MAX_DURABLE_UPLOAD_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_STORAGE_VERSION = 1;
const MANIFEST_SNAPSHOT_STORAGE_VERSION = 2;
const SCIENTIFIC_SNAPSHOT_STORAGE_VERSION = 3;
const DIGEST = /^[0-9a-f]{64}$/u;
const recoveryOperationIdSchema = z.string().uuid().nullable().default(null);
const EXCLUDED_SUMMARY_KEYS = [
  'unsupported',
  'private-raw-data',
  'reference-pointer',
  'file-too-large',
  'bundle-too-large',
] as const;

interface DurableUploadSnapshotRow {
  content_sha256: string;
  bundle_json: string;
}

interface SnapshotFileDescriptor {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  encoding?: 'base64';
}

interface FileBackedSnapshotEnvelope extends Pick<
  WorkspaceSyncSnapshot,
  'selection' | 'excludedFiles'
> {
  storageVersion: typeof SNAPSHOT_STORAGE_VERSION;
  bundle: WorkspaceSyncBundle;
  files: SnapshotFileDescriptor[];
}

interface FileBackedManifestSnapshotEnvelope extends WorkspaceSyncScientificHistoryMetadata {
  storageVersion:
    | typeof MANIFEST_SNAPSHOT_STORAGE_VERSION
    | typeof SCIENTIFIC_SNAPSHOT_STORAGE_VERSION;
  workspaceUuid: string;
  manifest: WorkspaceSyncManifestV1;
  excludedSummary: WorkspaceSyncUploadCapture['excludedSummary'];
  files: SnapshotFileDescriptor[];
  recoveryOnly?: WorkspaceSyncUploadCapture['recoveryOnly'];
  selection?: WorkspaceSyncUploadCapture['selection'];
  excludedFiles?: WorkspaceSyncUploadCapture['excludedFiles'];
}

export function ensureWorkspaceSyncRecoveryCandidateIntent(
  db: Database.Database,
  input: {
    jobId: string;
    ownerAccountId: string;
    remoteWorkspaceId: string;
    localHeadSha: string;
    snapshotContentSha256: string;
    requestSha256: string;
    uploadIdempotencyKey: string;
    nowMs: number;
  }
): WorkspaceSyncRecoveryCandidateIntent {
  const row = selectRow(db, input.jobId);
  if (!row || row.content_sha256 !== input.snapshotContentSha256)
    throw new Error('Recovery intent has no matching durable captured bytes.');
  const envelope = JSON.parse(row.bundle_json) as unknown;
  if (!isRecord(envelope)) throw new Error('Recovery snapshot metadata is unreadable.');
  const existing = parseRecoveryIntent(envelope.recoveryCandidate);
  if (envelope.recoveryCandidate !== undefined && !existing)
    throw new Error('Recovery intent is corrupt.');
  if (
    existing &&
    (existing.ownerAccountId !== input.ownerAccountId ||
      existing.remoteWorkspaceId !== input.remoteWorkspaceId ||
      existing.localHeadSha !== input.localHeadSha ||
      existing.snapshotContentSha256 !== input.snapshotContentSha256 ||
      existing.requestSha256 !== input.requestSha256)
  )
    throw new Error('Recovery intent belongs to different bytes, account, or workspace.');
  const expired =
    existing &&
    (existing.receipt
      ? Date.parse(existing.receipt.expiresAt) <= input.nowMs
      : input.nowMs - existing.createdAtMs >= WORKSPACE_SYNC_RECOVERY_RETENTION_MS);
  if (existing && !expired) return existing;
  const intent: WorkspaceSyncRecoveryCandidateIntent = {
    schema: 'dnaforge.desktop-recovery-intent/v1',
    acceptedOperationId: randomUUID(),
    parentAcceptedOperationId: existing?.acceptedOperationId ?? null,
    idempotencyKey: `candidate:${sha256Bytes(
      Buffer.from(
        JSON.stringify([
          input.uploadIdempotencyKey,
          input.requestSha256,
          existing?.idempotencyKey ?? null,
        ])
      )
    )}`,
    ownerAccountId: input.ownerAccountId,
    remoteWorkspaceId: input.remoteWorkspaceId,
    localHeadSha: input.localHeadSha,
    snapshotContentSha256: input.snapshotContentSha256,
    requestSha256: input.requestSha256,
    createdAtMs: input.nowMs,
    retainedAtMs: null,
  };
  updateRecoveryEnvelope(db, input.jobId, row, { ...envelope, recoveryCandidate: intent });
  return intent;
}

export function recordWorkspaceSyncRecoveryCandidateReceipt(
  db: Database.Database,
  input: {
    jobId: string;
    intent: WorkspaceSyncRecoveryCandidateIntent;
    receipt: WorkspaceSyncRecoveryCandidateReceipt;
    nowMs: number;
  }
): void {
  const row = selectRow(db, input.jobId);
  if (!row || row.content_sha256 !== input.intent.snapshotContentSha256)
    throw new Error('Recovery receipt has no matching captured bytes.');
  const envelope = JSON.parse(row.bundle_json) as unknown;
  if (!isRecord(envelope)) throw new Error('Recovery snapshot metadata is unreadable.');
  const current = parseRecoveryIntent(envelope.recoveryCandidate);
  if (
    !current ||
    current.idempotencyKey !== input.intent.idempotencyKey ||
    current.acceptedOperationId !== input.intent.acceptedOperationId ||
    current.parentAcceptedOperationId !== input.intent.parentAcceptedOperationId ||
    current.createdAtMs !== input.intent.createdAtMs ||
    current.requestSha256 !== input.receipt.requestSha256 ||
    current.ownerAccountId !== input.receipt.accountId
  )
    throw new Error('Recovery receipt no longer owns this captured request.');
  const receipt = parseWorkspaceSyncRecoveryCandidateReceipt(input.receipt);
  if (!receipt) throw new Error('Recovery receipt is invalid.');
  if (current.receipt) {
    if (JSON.stringify(current.receipt) !== JSON.stringify(receipt))
      throw new Error('Recovery candidate was already retained with another receipt.');
    return;
  }
  updateRecoveryEnvelope(db, input.jobId, row, {
    ...envelope,
    recoveryCandidate: { ...current, retainedAtMs: input.nowMs, receipt },
  });
}

export function readWorkspaceSyncRecoveryCandidateIntent(
  db: Database.Database,
  jobId: string
): WorkspaceSyncRecoveryCandidateIntent | null {
  try {
    const row = selectRow(db, jobId);
    if (!row) return null;
    const envelope = JSON.parse(row.bundle_json) as unknown;
    if (!isRecord(envelope)) return null;
    const intent = parseRecoveryIntent(envelope.recoveryCandidate);
    return intent?.snapshotContentSha256 === row.content_sha256 ? intent : null;
  } catch {
    return null;
  }
}

function parseRecoveryIntent(value: unknown): WorkspaceSyncRecoveryCandidateIntent | null {
  if (
    !isRecord(value) ||
    value.schema !== 'dnaforge.desktop-recovery-intent/v1' ||
    typeof value.idempotencyKey !== 'string' ||
    !value.idempotencyKey.startsWith('candidate:') ||
    typeof value.ownerAccountId !== 'string' ||
    typeof value.remoteWorkspaceId !== 'string' ||
    typeof value.localHeadSha !== 'string' ||
    typeof value.snapshotContentSha256 !== 'string' ||
    !DIGEST.test(value.snapshotContentSha256) ||
    typeof value.requestSha256 !== 'string' ||
    !DIGEST.test(value.requestSha256) ||
    typeof value.createdAtMs !== 'number' ||
    !Number.isSafeInteger(value.createdAtMs)
  )
    return null;
  const receipt =
    value.receipt === undefined
      ? undefined
      : parseWorkspaceSyncRecoveryCandidateReceipt(value.receipt);
  if (receipt === null) return null;
  const accepted = recoveryOperationIdSchema.safeParse(value.acceptedOperationId);
  const parent = recoveryOperationIdSchema.safeParse(value.parentAcceptedOperationId);
  const retainedAt = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .default(null)
    .safeParse(value.retainedAtMs);
  if (
    !accepted.success ||
    !parent.success ||
    !retainedAt.success ||
    (retainedAt.data !== null && receipt === undefined) ||
    (accepted.data === null && parent.data !== null) ||
    (accepted.data !== null && accepted.data === parent.data)
  )
    return null;
  const operationIdentity: WorkspaceSyncRecoveryOperationIdentity =
    accepted.data === null
      ? { acceptedOperationId: null, parentAcceptedOperationId: null }
      : { acceptedOperationId: accepted.data, parentAcceptedOperationId: parent.data };
  return {
    schema: value.schema,
    ...operationIdentity,
    idempotencyKey: value.idempotencyKey,
    ownerAccountId: value.ownerAccountId,
    remoteWorkspaceId: value.remoteWorkspaceId,
    localHeadSha: value.localHeadSha,
    snapshotContentSha256: value.snapshotContentSha256,
    requestSha256: value.requestSha256,
    createdAtMs: value.createdAtMs,
    retainedAtMs: retainedAt.data,
    ...(receipt ? { receipt } : {}),
  };
}

function updateRecoveryEnvelope(
  db: Database.Database,
  jobId: string,
  row: DurableUploadSnapshotRow,
  envelope: Record<string, unknown>
): void {
  const bundleJson = JSON.stringify(envelope);
  if (Buffer.byteLength(bundleJson) > MAX_DURABLE_UPLOAD_SNAPSHOT_BYTES)
    throw new Error('Recovery receipt exceeds bounded snapshot metadata.');
  const changed = db
    .prepare(
      `UPDATE workspace_sync_upload_snapshots SET bundle_json = ?
    WHERE job_id = ? AND content_sha256 = ? AND bundle_json = ?`
    )
    .run(bundleJson, jobId, row.content_sha256, row.bundle_json);
  if (changed.changes !== 1)
    throw new Error('Captured recovery metadata changed before its atomic update.');
}

export interface WorkspaceSyncUploadSnapshotStorageOptions {
  root?: string;
}

export function removeAbandonedWorkspaceSyncUploadCaptures(root: string | undefined): void {
  if (!root) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const match = /^\.capture-([1-9]\d*)-[A-Za-z0-9]+$/u.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
    }
    const directory = join(root, entry.name);
    const stat = lstatSync(directory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

export function recordWorkspaceSyncUploadSnapshot(
  db: Database.Database,
  input: {
    jobId: string;
    snapshot: WorkspaceSyncSnapshot;
    nowMs: number;
  } & WorkspaceSyncUploadSnapshotStorageOptions
): WorkspaceSyncSnapshot {
  assertSnapshotBundle(input.snapshot.bundle);
  assertBundleContentHash(input.snapshot.bundle, input.snapshot.contentSha256);

  const existing = selectRow(db, input.jobId);
  if (existing) {
    if (existing.content_sha256 !== input.snapshot.contentSha256) {
      throw new Error(`Workspace sync job ${input.jobId} already names different upload bytes.`);
    }
    return snapshotWithStoredSources(input.snapshot, existing.bundle_json, input.root, input.jobId);
  }

  const staged =
    input.root && input.snapshot.bundle.schemaVersion !== 3
      ? stageSnapshotFiles(
          input.root,
          input.jobId,
          input.snapshot.bundle,
          input.snapshot.captureFileSources,
          input.snapshot
        )
      : {
          bundleJson: JSON.stringify({
            ...input.snapshot.bundle,
            selection: input.snapshot.selection,
            excludedFiles: input.snapshot.excludedFiles,
          }),
          fileSources: undefined,
        };
  if (Buffer.byteLength(staged.bundleJson, 'utf8') > MAX_DURABLE_UPLOAD_SNAPSHOT_BYTES) {
    removeSnapshotDirectory(input.root, input.jobId);
    throw new Error('Durable workspace sync upload snapshot metadata exceeds its size limit.');
  }

  try {
    db.prepare(
      `INSERT INTO workspace_sync_upload_snapshots (
         job_id, content_sha256, bundle_json, created_at
       ) VALUES (@jobId, @contentSha256, @bundleJson, @nowMs)
       ON CONFLICT(job_id) DO NOTHING`
    ).run({
      jobId: input.jobId,
      contentSha256: input.snapshot.contentSha256,
      bundleJson: staged.bundleJson,
      nowMs: input.nowMs,
    });
  } catch (error) {
    removeSnapshotDirectory(input.root, input.jobId);
    throw error;
  }

  const stored = selectRow(db, input.jobId);
  if (
    !stored ||
    stored.content_sha256 !== input.snapshot.contentSha256 ||
    stored.bundle_json !== staged.bundleJson
  ) {
    throw new Error(`Workspace sync job ${input.jobId} already names different upload bytes.`);
  }
  return {
    ...input.snapshot,
    fileSources: staged.fileSources,
  };
}

export function readWorkspaceSyncUploadSnapshot(
  db: Database.Database,
  input: {
    jobId: string;
    workspaceId: number;
    workspaceUuid: string;
    repoPath: string;
  } & WorkspaceSyncUploadSnapshotStorageOptions
): WorkspaceSyncSnapshot | null {
  const row = selectRow(db, input.jobId);
  if (!row) return null;
  if (Buffer.byteLength(row.bundle_json, 'utf8') > MAX_DURABLE_UPLOAD_SNAPSHOT_BYTES) {
    throw new Error('Durable workspace sync upload snapshot metadata exceeds its size limit.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.bundle_json);
  } catch {
    throw new Error(`Workspace sync job ${input.jobId} has an unreadable upload snapshot.`);
  }

  const stored = hydrateStoredBundle(parsed, input.root, input.jobId);
  const validated = validateWorkspaceSyncBundle(stored.bundle);
  if (!validated.ok) {
    throw new Error(
      `Workspace sync job ${input.jobId} has an invalid upload snapshot: ${validated.errors.join('; ')}`
    );
  }
  const bundle = validated.bundle;
  assertBundleContentHash(bundle, row.content_sha256);
  if (bundle.workspace.id !== input.workspaceUuid) {
    throw new Error(`Workspace sync job ${input.jobId} snapshot belongs to another workspace.`);
  }
  const selectionMetadata = parseWorkspaceSyncSelectionMetadata(isRecord(parsed) ? parsed : {});
  return {
    ...snapshotFromBundle(
      input,
      bundle,
      JSON.stringify(bundle),
      row.content_sha256,
      stored.fileSources
    ),
    ...selectionMetadata,
    statusExcludedSummary: {
      ...toWorkspaceSyncStatusExcludedSummary(bundle.excludedSummary),
      ...(selectionMetadata.excludedFiles
        ? {
            ignoredCount: selectionMetadata.excludedFiles.filter(
              (file) => file.reason === 'project-ignore'
            ).length,
          }
        : {}),
    },
  };
}

export function recordWorkspaceSyncUploadCapture(
  db: Database.Database,
  input: {
    jobId: string;
    snapshot: WorkspaceSyncUploadCapture;
    nowMs: number;
  } & WorkspaceSyncUploadSnapshotStorageOptions
): WorkspaceSyncUploadCapture {
  if (!input.root) {
    throw new Error('Manifest workspace sync captures require a durable staging root.');
  }
  assertManifestCapture(input.snapshot);

  const existing = selectRow(db, input.jobId);
  if (existing) {
    if (existing.content_sha256 !== input.snapshot.contentSha256) {
      throw new Error(`Workspace sync job ${input.jobId} already names different upload bytes.`);
    }
    const restored = hydrateManifestCapture(
      existing.bundle_json,
      input.root,
      input.jobId,
      input.snapshot.workspaceId,
      input.snapshot.workspaceUuid,
      input.snapshot.repoPath,
      existing.content_sha256
    );
    if (!restored) {
      throw new Error(`Workspace sync job ${input.jobId} already stores a legacy upload snapshot.`);
    }
    return restored;
  }

  const staged = stageManifestCapture(input.root, input.jobId, input.snapshot);
  if (Buffer.byteLength(staged.bundleJson, 'utf8') > MAX_DURABLE_UPLOAD_SNAPSHOT_BYTES) {
    removeSnapshotDirectory(input.root, input.jobId);
    throw new Error('Durable workspace sync upload snapshot metadata exceeds its size limit.');
  }

  try {
    db.prepare(
      `INSERT INTO workspace_sync_upload_snapshots (
         job_id, content_sha256, bundle_json, created_at
       ) VALUES (@jobId, @contentSha256, @bundleJson, @nowMs)
       ON CONFLICT(job_id) DO NOTHING`
    ).run({
      jobId: input.jobId,
      contentSha256: input.snapshot.contentSha256,
      bundleJson: staged.bundleJson,
      nowMs: input.nowMs,
    });
  } catch (error) {
    removeSnapshotDirectory(input.root, input.jobId);
    throw error;
  }

  const stored = selectRow(db, input.jobId);
  if (
    !stored ||
    stored.content_sha256 !== input.snapshot.contentSha256 ||
    stored.bundle_json !== staged.bundleJson
  ) {
    throw new Error(`Workspace sync job ${input.jobId} already names different upload bytes.`);
  }
  return {
    ...input.snapshot,
    fileSources: staged.fileSources,
    ...(staged.scientificBlobSources
      ? { scientificBlobSources: staged.scientificBlobSources }
      : {}),
  };
}

export function readWorkspaceSyncUploadCapture(
  db: Database.Database,
  input: {
    jobId: string;
    workspaceId: number;
    workspaceUuid: string;
    repoPath: string;
  } & WorkspaceSyncUploadSnapshotStorageOptions
): WorkspaceSyncUploadCapture | null {
  const row = selectRow(db, input.jobId);
  if (!row) return null;
  if (Buffer.byteLength(row.bundle_json, 'utf8') > MAX_DURABLE_UPLOAD_SNAPSHOT_BYTES) {
    throw new Error('Durable workspace sync upload snapshot metadata exceeds its size limit.');
  }
  const restored = hydrateManifestCapture(
    row.bundle_json,
    input.root,
    input.jobId,
    input.workspaceId,
    input.workspaceUuid,
    input.repoPath,
    row.content_sha256
  );
  return restored;
}

export function deleteWorkspaceSyncUploadSnapshot(
  db: Database.Database,
  jobId: string,
  options: WorkspaceSyncUploadSnapshotStorageOptions = {}
): void {
  db.prepare(`DELETE FROM workspace_sync_upload_snapshots WHERE job_id = ?`).run(jobId);
  removeSnapshotDirectory(options.root, jobId);
}

export function deleteWorkspaceSyncUploadSnapshotsForWorkspace(
  db: Database.Database,
  input: {
    workspaceId: number;
    excludeJobId: string;
  } & WorkspaceSyncUploadSnapshotStorageOptions
): void {
  const rows = db
    .prepare(
      `SELECT snapshots.job_id AS jobId
       FROM workspace_sync_upload_snapshots AS snapshots
       JOIN workspace_sync_queue AS queue ON queue.id = snapshots.job_id
       WHERE queue.workspace_id = @workspaceId
         AND queue.operation = 'upload'
         AND queue.id <> @excludeJobId
         AND (
           queue.status = 'failed'
           OR (queue.status = 'canceled' AND queue.error_code = 'SYNC_DISABLED')
         )`
    )
    .all(input) as Array<{ jobId: string }>;
  for (const row of rows) {
    deleteWorkspaceSyncUploadSnapshot(db, row.jobId, { root: input.root });
  }
}

function selectRow(db: Database.Database, jobId: string): DurableUploadSnapshotRow | null {
  return (
    (db
      .prepare(
        `SELECT content_sha256, bundle_json
         FROM workspace_sync_upload_snapshots
         WHERE job_id = ?
         LIMIT 1`
      )
      .get(jobId) as DurableUploadSnapshotRow | undefined) ?? null
  );
}

function stageSnapshotFiles(
  root: string,
  jobId: string,
  bundle: WorkspaceSyncBundle,
  captureFileSources?: ReadonlyMap<string, string>,
  metadata?: Pick<WorkspaceSyncSnapshot, 'selection' | 'excludedFiles'>
): { bundleJson: string; fileSources: ReadonlyMap<string, string> } {
  const directory = workspaceSyncUploadSnapshotDirectory(root, jobId);
  removeSnapshotDirectory(root, jobId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(join(root, `.${snapshotDirectoryName(jobId)}-`));
  const filesDirectory = join(temporaryDirectory, 'files');
  mkdirSync(filesDirectory, { recursive: true, mode: 0o700 });
  const descriptors: SnapshotFileDescriptor[] = [];
  const fileSources = new Map<string, string>();
  const seenDigests = new Set<string>();

  try {
    for (const file of bundle.files) {
      if (file.encoding === 'blob') {
        throw new Error(
          'Blob-cache snapshots must retain their immutable metadata representation.'
        );
      }
      const digest = file.sha256.toLowerCase();
      if (!DIGEST.test(digest)) {
        throw new Error(`Workspace sync file bytes do not match ${file.relativePath}.`);
      }
      const fileName = digest;
      const stagedPath = join(filesDirectory, fileName);
      if (!seenDigests.has(fileName)) {
        const capturedPath = captureFileSources?.get(file.relativePath);
        if (capturedPath) {
          const sourceStat = lstatSync(capturedPath);
          if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
            throw new Error(
              `Workspace sync capture source is not a regular file: ${file.relativePath}`
            );
          }
          if (sourceStat.size !== file.sizeBytes) {
            throw new Error(`Workspace sync capture source size changed: ${file.relativePath}`);
          }
          copyIndependentFileSync(capturedPath, stagedPath);
        } else {
          const bytes = Buffer.from(decodeBundleFileContent(file));
          const actualDigest = sha256Bytes(bytes);
          if (actualDigest !== digest || bytes.byteLength !== file.sizeBytes) {
            throw new Error(`Workspace sync file bytes do not match ${file.relativePath}.`);
          }
          writeFileSync(stagedPath, bytes, { mode: 0o600 });
        }
        seenDigests.add(fileName);
      }
      const sourcePath = join(directory, 'files', fileName);
      fileSources.set(file.relativePath, sourcePath);
      descriptors.push({
        relativePath: file.relativePath,
        sha256: fileName,
        sizeBytes: file.sizeBytes,
        fileName,
        ...(file.encoding ? { encoding: file.encoding } : {}),
      });
    }

    const skeleton: WorkspaceSyncBundle = {
      ...bundle,
      files: bundle.files.map((file) => ({ ...file, content: '' })),
    };
    const envelope: FileBackedSnapshotEnvelope = {
      storageVersion: SNAPSHOT_STORAGE_VERSION,
      selection: metadata?.selection,
      excludedFiles: metadata?.excludedFiles,
      bundle: skeleton,
      files: descriptors,
    };
    const bundleJson = JSON.stringify(envelope);
    renameSync(temporaryDirectory, directory);
    return { bundleJson, fileSources };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function hydrateStoredBundle(
  value: unknown,
  root: string | undefined,
  jobId: string
): { bundle: unknown; fileSources?: ReadonlyMap<string, string> } {
  if (!isRecord(value) || value.storageVersion !== SNAPSHOT_STORAGE_VERSION) {
    if (!isRecord(value)) {
      throw new Error(`Workspace sync job ${jobId} has an invalid upload snapshot envelope.`);
    }
    const {
      recoveryCandidate: _observationalReceipt,
      selection: _selection,
      excludedFiles: _excludedFiles,
      ...bundle
    } = value;
    return { bundle };
  }
  if (!root || !isRecord(value.bundle) || !Array.isArray(value.files)) {
    throw new Error(
      `Workspace sync job ${jobId} is file-backed but its staging root is unavailable.`
    );
  }
  if (!Array.isArray(value.bundle.files)) {
    throw new Error(`Workspace sync job ${jobId} has invalid staged-file metadata.`);
  }
  const skeleton = value.bundle;
  const skeletonFiles = skeleton.files as unknown[];
  const descriptors = value.files.map((entry) => parseDescriptor(entry, jobId));
  const descriptorByPath = new Map(descriptors.map((entry) => [entry.relativePath, entry]));
  const directory = workspaceSyncUploadSnapshotDirectory(root, jobId);
  const filesDirectory = join(directory, 'files');
  const sources = new Map<string, string>();
  const files = skeletonFiles.map((fileValue) => {
    if (!isRecord(fileValue)) {
      throw new Error(`Workspace sync job ${jobId} has invalid staged-file metadata.`);
    }
    const relativePath = fileValue.relativePath;
    const sha256 = fileValue.sha256;
    const sizeBytes = fileValue.sizeBytes;
    const encoding = fileValue.encoding;
    if (
      typeof relativePath !== 'string' ||
      typeof sha256 !== 'string' ||
      typeof sizeBytes !== 'number' ||
      (encoding !== undefined && encoding !== 'base64')
    ) {
      throw new Error(`Workspace sync job ${jobId} has invalid staged-file metadata.`);
    }
    const descriptor = descriptorByPath.get(relativePath);
    if (
      !descriptor ||
      descriptor.sha256 !== sha256.toLowerCase() ||
      descriptor.sizeBytes !== sizeBytes ||
      descriptor.encoding !== encoding
    ) {
      throw new Error(`Workspace sync job ${jobId} has inconsistent staged-file metadata.`);
    }
    const sourcePath = join(filesDirectory, descriptor.fileName);
    if (!existsSync(sourcePath)) {
      throw new Error(`Workspace sync job ${jobId} is missing staged file ${relativePath}.`);
    }
    const bytes = readFileSync(sourcePath);
    if (bytes.byteLength !== descriptor.sizeBytes || sha256Bytes(bytes) !== descriptor.sha256) {
      throw new Error(`Workspace sync job ${jobId} has corrupt staged file ${relativePath}.`);
    }
    sources.set(relativePath, sourcePath);
    return {
      ...fileValue,
      content: descriptor.encoding === 'base64' ? bytes.toString('base64') : bytes.toString('utf8'),
    };
  });
  return { bundle: { ...skeleton, files }, fileSources: sources };
}

function parseDescriptor(value: unknown, jobId: string): SnapshotFileDescriptor {
  if (!isRecord(value)) {
    throw new Error(`Workspace sync job ${jobId} has invalid staged-file metadata.`);
  }
  const relativePath = value.relativePath;
  const sha256 = value.sha256;
  const sizeBytes = value.sizeBytes;
  const fileName = value.fileName;
  const encoding = value.encoding;
  if (
    typeof relativePath !== 'string' ||
    typeof sha256 !== 'string' ||
    !DIGEST.test(sha256) ||
    typeof sizeBytes !== 'number' ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    typeof fileName !== 'string' ||
    fileName !== sha256 ||
    (encoding !== undefined && encoding !== 'base64')
  ) {
    throw new Error(`Workspace sync job ${jobId} has invalid staged-file metadata.`);
  }
  return {
    relativePath,
    sha256,
    sizeBytes,
    fileName,
    ...(encoding ? { encoding } : {}),
  };
}

function snapshotWithStoredSources(
  snapshot: WorkspaceSyncSnapshot,
  bundleJson: string,
  root: string | undefined,
  jobId: string
): WorkspaceSyncSnapshot {
  const parsed: unknown = JSON.parse(bundleJson);
  const stored = hydrateStoredBundle(parsed, root, jobId);
  const { selection: _selection, excludedFiles: _excludedFiles, ...base } = snapshot;
  const metadata = parseWorkspaceSyncSelectionMetadata(isRecord(parsed) ? parsed : {});
  return {
    ...base,
    ...metadata,
    fileSources: stored.fileSources,
    statusExcludedSummary: {
      ...toWorkspaceSyncStatusExcludedSummary(snapshot.excludedSummary),
      ...(metadata.excludedFiles
        ? {
            ignoredCount: metadata.excludedFiles.filter((file) => file.reason === 'project-ignore')
              .length,
          }
        : {}),
    },
  };
}

function snapshotFromBundle(
  input: { workspaceId: number; workspaceUuid: string; repoPath: string },
  bundle: WorkspaceSyncBundle,
  bundleJson: string,
  contentSha256: string,
  fileSources?: ReadonlyMap<string, string>
): WorkspaceSyncSnapshot {
  return {
    workspaceId: input.workspaceId,
    workspaceUuid: input.workspaceUuid,
    repoPath: input.repoPath,
    bundle,
    fileSources,
    contentSha256,
    bundleSizeBytes:
      bundle.schemaVersion === 3
        ? bundle.files.reduce((total, file) => total + file.sizeBytes, 0)
        : Buffer.byteLength(bundleJson, 'utf8'),
    includedFileCount: bundle.files.length,
    includedBytes: bundle.files.reduce((total, file) => total + file.sizeBytes, 0),
    excludedSummary: bundle.excludedSummary,
    statusExcludedSummary: toWorkspaceSyncStatusExcludedSummary(bundle.excludedSummary),
  };
}

function assertSnapshotBundle(bundle: WorkspaceSyncBundle): void {
  const validated = validateWorkspaceSyncBundle(bundle);
  if (!validated.ok) {
    throw new Error(`Workspace sync upload snapshot is invalid: ${validated.errors.join('; ')}`);
  }
}

function assertBundleContentHash(bundle: WorkspaceSyncBundle, expected: string): void {
  const actual = createHash('sha256')
    .update(workspaceSyncBundleHashInput(bundle), 'utf8')
    .digest('hex');
  if (
    actual !== expected.toLowerCase() ||
    bundle.provenance.contentSha256.toLowerCase() !== expected.toLowerCase()
  ) {
    throw new Error('Durable workspace sync upload snapshot content hash does not match.');
  }
}

function assertManifestCapture(snapshot: WorkspaceSyncUploadCapture): void {
  const parsed = parseWorkspaceSyncManifest(snapshot.manifest);
  if (!parsed.ok) {
    throw new Error(`Workspace sync upload manifest is invalid: ${parsed.errors.join('; ')}`);
  }
  const manifestSha256 = createHash('sha256')
    .update(workspaceSyncManifestHashInput(parsed.manifest), 'utf8')
    .digest('hex');
  const scientific = parseWorkspaceSyncScientificHistoryMetadata(snapshot, manifestSha256);
  const actual = scientific
    ? workspaceSyncScientificContentSha256(manifestSha256, scientific.scientificHistory)
    : manifestSha256;
  if (actual !== snapshot.contentSha256.toLowerCase()) {
    throw new Error('Workspace sync upload manifest content hash does not match.');
  }
  if (
    parsed.manifest.files.length !== snapshot.includedFileCount ||
    parsed.manifest.files.reduce((total, file) => total + file.sizeBytes, 0) !==
      snapshot.includedBytes
  ) {
    throw new Error('Workspace sync upload manifest metadata does not match its capture.');
  }
  if (scientific && (!snapshot.scientificBlobSources || snapshot.recoveryOnly))
    throw new Error(
      'Scientific upload has no complete durable authority or is a file-only recovery.'
    );
}

function stageManifestCapture(
  root: string,
  jobId: string,
  snapshot: WorkspaceSyncUploadCapture
): {
  bundleJson: string;
  fileSources: ReadonlyMap<string, string>;
  scientificBlobSources?: ReadonlyMap<string, string>;
} {
  const directory = workspaceSyncUploadSnapshotDirectory(root, jobId);
  removeSnapshotDirectory(root, jobId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporaryDirectory = mkdtempSync(join(root, `.${snapshotDirectoryName(jobId)}-`));
  const filesDirectory = join(temporaryDirectory, 'files');
  mkdirSync(filesDirectory, { recursive: true, mode: 0o700 });
  const descriptors: SnapshotFileDescriptor[] = [];
  const fileSources = new Map<string, string>();
  const seenDigests = new Set<string>();
  const scientific = parseWorkspaceSyncScientificHistoryMetadata(
    snapshot,
    createHash('sha256')
      .update(workspaceSyncManifestHashInput(snapshot.manifest), 'utf8')
      .digest('hex')
  );
  const scientificBlobSources = new Map<string, string>();
  const lengths = new Map(
    snapshot.manifest.files.map((file) => [file.contentSha256, file.sizeBytes])
  );

  try {
    for (const file of snapshot.manifest.files) {
      const sourcePath = snapshot.fileSources.get(file.path);
      if (!sourcePath) {
        throw new Error(`Workspace sync capture source is missing: ${file.path}`);
      }
      const fileName = file.contentSha256.toLowerCase();
      if (!seenDigests.has(fileName)) {
        const sourceStat = lstatSync(sourcePath);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
          throw new Error(`Workspace sync capture source is not a regular file: ${file.path}`);
        }
        if (sourceStat.size !== file.sizeBytes) {
          throw new Error(`Workspace sync capture source size changed: ${file.path}`);
        }
        copyIndependentFileSync(sourcePath, join(filesDirectory, fileName));
        seenDigests.add(fileName);
      }
      const stagedPath = join(directory, 'files', fileName);
      fileSources.set(file.path, stagedPath);
      descriptors.push({
        relativePath: file.path,
        sha256: fileName,
        sizeBytes: file.sizeBytes,
        fileName,
      });
    }

    if (scientific) {
      for (const blob of [scientific.scientificHistory.archive, ...scientific.scientificBlobRefs]) {
        const digest = blob.hash.slice('sha256:'.length);
        const previousLength = lengths.get(digest);
        if (previousLength !== undefined && previousLength !== blob.byteLength)
          throw new Error('Scientific upload repeats a digest with inconsistent lengths.');
        lengths.set(digest, blob.byteLength);
        if (!seenDigests.has(digest)) {
          const sourcePath = snapshot.scientificBlobSources?.get(blob.hash);
          if (!sourcePath)
            throw new Error('Scientific upload archive or historical blob is missing.');
          const stat = lstatSync(sourcePath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== blob.byteLength)
            throw new Error('Scientific upload has an invalid historical blob source.');
          copyIndependentFileSync(sourcePath, join(filesDirectory, digest));
          seenDigests.add(digest);
        }
        scientificBlobSources.set(blob.hash, join(directory, 'files', digest));
      }
    }
    const envelope: FileBackedManifestSnapshotEnvelope = {
      storageVersion: scientific
        ? SCIENTIFIC_SNAPSHOT_STORAGE_VERSION
        : MANIFEST_SNAPSHOT_STORAGE_VERSION,
      workspaceUuid: snapshot.workspaceUuid,
      manifest: snapshot.manifest,
      selection: snapshot.selection,
      excludedFiles: snapshot.excludedFiles,
      excludedSummary: snapshot.excludedSummary,
      files: descriptors,
      ...(scientific ?? {}),
      ...(snapshot.recoveryOnly ? { recoveryOnly: snapshot.recoveryOnly } : {}),
    };
    const bundleJson = JSON.stringify(envelope);
    renameSync(temporaryDirectory, directory);
    return { bundleJson, fileSources, ...(scientific ? { scientificBlobSources } : {}) };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function hydrateManifestCapture(
  bundleJson: string,
  root: string | undefined,
  jobId: string,
  workspaceId: number,
  workspaceUuid: string,
  repoPath: string,
  expectedContentSha256: string
): WorkspaceSyncUploadCapture | null {
  let value: unknown;
  try {
    value = JSON.parse(bundleJson);
  } catch {
    throw new Error(`Workspace sync job ${jobId} has an unreadable upload snapshot.`);
  }
  if (
    !isRecord(value) ||
    ![MANIFEST_SNAPSHOT_STORAGE_VERSION, SCIENTIFIC_SNAPSHOT_STORAGE_VERSION].includes(
      value.storageVersion as number
    )
  )
    return null;
  if (!root || typeof value.workspaceUuid !== 'string' || value.workspaceUuid !== workspaceUuid) {
    throw new Error(
      `Workspace sync job ${jobId} is file-backed but its staging root is unavailable.`
    );
  }
  const parsedManifest = parseWorkspaceSyncManifest(value.manifest);
  if (!parsedManifest.ok) {
    throw new Error(
      `Workspace sync job ${jobId} has an invalid upload manifest: ${parsedManifest.errors.join('; ')}`
    );
  }
  const manifest = parsedManifest.manifest;
  const manifestSha256 = createHash('sha256')
    .update(workspaceSyncManifestHashInput(manifest), 'utf8')
    .digest('hex');
  const scientific = parseWorkspaceSyncScientificHistoryMetadata(value, manifestSha256);
  if ((value.storageVersion === SCIENTIFIC_SNAPSHOT_STORAGE_VERSION) !== Boolean(scientific))
    throw new Error(`Workspace sync job ${jobId} has an unsupported scientific storage version.`);
  const actualContentSha256 = scientific
    ? workspaceSyncScientificContentSha256(manifestSha256, scientific.scientificHistory)
    : manifestSha256;
  if (actualContentSha256 !== expectedContentSha256.toLowerCase()) {
    throw new Error(`Workspace sync job ${jobId} manifest content hash does not match.`);
  }
  if (!isExcludedSummary(value.excludedSummary)) {
    throw new Error(`Workspace sync job ${jobId} has invalid exclusion metadata.`);
  }
  if (!Array.isArray(value.files)) {
    throw new Error(`Workspace sync job ${jobId} has invalid staged-file metadata.`);
  }
  const descriptors = value.files.map((entry) => parseDescriptor(entry, jobId));
  if (descriptors.length !== manifest.files.length) {
    throw new Error(`Workspace sync job ${jobId} has inconsistent staged-file metadata.`);
  }
  const descriptorByPath = new Map(descriptors.map((entry) => [entry.relativePath, entry]));
  if (descriptorByPath.size !== descriptors.length) {
    throw new Error(`Workspace sync job ${jobId} has duplicate staged-file metadata.`);
  }
  const directory = workspaceSyncUploadSnapshotDirectory(root, jobId);
  const filesDirectory = join(directory, 'files');
  const fileSources = new Map<string, string>();
  const scientificBlobSources = new Map<string, string>();
  for (const file of manifest.files) {
    const descriptor = descriptorByPath.get(file.path);
    if (
      !descriptor ||
      descriptor.sha256 !== file.contentSha256 ||
      descriptor.sizeBytes !== file.sizeBytes ||
      descriptor.encoding !== undefined
    ) {
      throw new Error(`Workspace sync job ${jobId} has inconsistent staged-file metadata.`);
    }
    const sourcePath = join(filesDirectory, descriptor.fileName);
    if (!existsSync(sourcePath)) {
      throw new Error(`Workspace sync job ${jobId} is missing staged file ${file.path}.`);
    }
    const sourceStat = lstatSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== file.sizeBytes) {
      throw new Error(`Workspace sync job ${jobId} has an invalid staged file ${file.path}.`);
    }
    fileSources.set(file.path, sourcePath);
  }
  if (scientific) {
    const lengths = new Map(manifest.files.map((file) => [file.contentSha256, file.sizeBytes]));
    for (const blob of [scientific.scientificHistory.archive, ...scientific.scientificBlobRefs]) {
      const digest = blob.hash.slice('sha256:'.length);
      const previousLength = lengths.get(digest);
      if (previousLength !== undefined && previousLength !== blob.byteLength)
        throw new Error(`Workspace sync job ${jobId} has inconsistent scientific blob lengths.`);
      lengths.set(digest, blob.byteLength);
      const sourcePath = join(filesDirectory, digest);
      if (!existsSync(sourcePath))
        throw new Error(`Workspace sync job ${jobId} is missing a staged scientific blob.`);
      const stat = lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== blob.byteLength)
        throw new Error(`Workspace sync job ${jobId} has an invalid staged scientific blob.`);
      scientificBlobSources.set(blob.hash, sourcePath);
    }
  }
  const excludedSummary = value.excludedSummary;
  const selectionMetadata = parseWorkspaceSyncSelectionMetadata(value);
  let recoveryOnly: WorkspaceSyncUploadCapture['recoveryOnly'];
  if (value.recoveryOnly !== undefined) {
    const metadata = value.recoveryOnly;
    if (
      !isRecord(metadata) ||
      metadata.reason !== 'invalid-package' ||
      !Array.isArray(metadata.missingPaths) ||
      !metadata.missingPaths.every((path) => typeof path === 'string')
    ) {
      throw new Error(`Workspace sync job ${jobId} has invalid recovery-only metadata.`);
    }
    recoveryOnly = { reason: metadata.reason, missingPaths: metadata.missingPaths };
  }
  return {
    workspaceId,
    workspaceUuid,
    repoPath,
    manifest,
    fileSources,
    contentSha256: expectedContentSha256.toLowerCase(),
    bundleSizeBytes: Buffer.byteLength(JSON.stringify(manifest), 'utf8'),
    includedFileCount: manifest.files.length,
    includedBytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
    excludedSummary,
    ...selectionMetadata,
    statusExcludedSummary: {
      ...toWorkspaceSyncStatusExcludedSummary(excludedSummary),
      ...(selectionMetadata.excludedFiles
        ? {
            ignoredCount: selectionMetadata.excludedFiles.filter(
              (file) => file.reason === 'project-ignore'
            ).length,
          }
        : {}),
    },
    ...(scientific ? { ...scientific, scientificBlobSources } : {}),
    ...(recoveryOnly ? { recoveryOnly } : {}),
  };
}

function isExcludedSummary(value: unknown): value is WorkspaceSyncUploadCapture['excludedSummary'] {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== EXCLUDED_SUMMARY_KEYS.length) return false;
  if (keys.some((key, index) => key !== [...EXCLUDED_SUMMARY_KEYS].sort()[index])) return false;
  return Object.values(value).every((entry) => {
    if (!isRecord(entry)) return false;
    return (
      Number.isSafeInteger(entry.count) &&
      Number(entry.count) >= 0 &&
      (entry.bytesApprox === null ||
        (Number.isSafeInteger(entry.bytesApprox) && Number(entry.bytesApprox) >= 0))
    );
  });
}

export function workspaceSyncUploadSnapshotDirectory(root: string, jobId: string): string {
  return join(root, snapshotDirectoryName(jobId));
}

function snapshotDirectoryName(jobId: string): string {
  return `job-${createHash('sha256').update(jobId, 'utf8').digest('hex').slice(0, 32)}`;
}

function removeSnapshotDirectory(root: string | undefined, jobId: string): void {
  if (!root) return;
  rmSync(workspaceSyncUploadSnapshotDirectory(root, jobId), { recursive: true, force: true });
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
