import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type Database from 'better-sqlite3';
import {
  describeScientificCloudHistory,
  exportScientificHistory,
  scientificCloudVersionHashInput,
  serializeScientificHistory,
} from '@waypoint/scientific-objects';
import { createRevisionGraph, parseRefName, parseWorkspaceId } from '@waypoint/workspace-revisions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWorkspaceSyncBundleLimits,
  workspaceSyncBundleHashInput,
  workspaceSyncManifestHashInput,
  type WorkspaceSyncBundleV1,
  type WorkspaceSyncBundleV3,
  type WorkspaceSyncManifestV1,
} from '@waypoint/share-bundle';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { ensureSchema } from '../schema';
import {
  deleteWorkspaceSyncUploadSnapshot,
  deleteWorkspaceSyncUploadSnapshotsForWorkspace,
  readWorkspaceSyncUploadCapture,
  readWorkspaceSyncUploadSnapshot,
  recordWorkspaceSyncUploadCapture,
  recordWorkspaceSyncUploadSnapshot,
  ensureWorkspaceSyncRecoveryCandidateIntent,
  recordWorkspaceSyncRecoveryCandidateReceipt,
  readWorkspaceSyncRecoveryCandidateIntent,
} from '../workspace-sync-upload-snapshots';
import type {
  WorkspaceSyncSnapshot,
  WorkspaceSyncUploadCapture,
} from '../workspace-sync-snapshotter';
import { createTestDb } from './test-db';
import {
  WORKSPACE_SYNC_RECOVERY_RETENTION_MS,
  type WorkspaceSyncRecoveryCandidateReceipt,
} from '../workspace-sync-recovery-candidate';

describe('durable workspace sync upload snapshots', () => {
  let db: Database.Database;
  let stagingRoot: string;
  let authoritativeRoot: string | undefined;

  beforeEach(() => {
    stagingRoot = mkdtempSync(join(tmpdir(), 'dnaforge-workspace-sync-snapshot-'));
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Project A', '/managed/workspace-a/repo', 'workspace-a', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO workspace_sync_queue (
         id, workspace_id, operation, status, attempt_count, created_at, updated_at
       ) VALUES ('job-a', 1, 'upload', 'pending', 0, 1, 1)`
    ).run();
  });

  afterEach(() => {
    rmSync(stagingRoot, { recursive: true, force: true });
    if (authoritativeRoot) rmSync(authoritativeRoot, { recursive: true, force: true });
    authoritativeRoot = undefined;
  });

  it('round-trips the exact validated bundle and deletes it on settlement', () => {
    const snapshot = testSnapshot('LOCUS       A\nORIGIN\n        1 a\n//\n');

    recordWorkspaceSyncUploadSnapshot(db, { jobId: 'job-a', snapshot, nowMs: 10 });
    expect(readSnapshot()).toEqual(snapshot);

    deleteWorkspaceSyncUploadSnapshot(db, 'job-a');
    expect(readSnapshot()).toBeNull();
  });

  it('persists recovery intent and receipt outside exact bytes, renews expired retention, and refuses cross-account reuse', () => {
    const snapshot = testSnapshot('LOCUS       A\nORIGIN\n        1 a\n//\n');
    recordWorkspaceSyncUploadSnapshot(db, { jobId: 'job-a', snapshot, nowMs: 10 });
    const input = {
      jobId: 'job-a',
      ownerAccountId: 'account-a',
      remoteWorkspaceId: 'remote-a',
      localHeadSha: 'saved-head',
      snapshotContentSha256: snapshot.contentSha256,
      requestSha256: 'a'.repeat(64),
      uploadIdempotencyKey: 'same-upload-key',
      nowMs: 10,
    };
    const first = ensureWorkspaceSyncRecoveryCandidateIntent(db, input);
    expect(ensureWorkspaceSyncRecoveryCandidateIntent(db, input)).toEqual(first);
    recordWorkspaceSyncRecoveryCandidateReceipt(db, {
      jobId: 'job-a',
      intent: first,
      nowMs: 20,
      receipt: {
        id: '33333333-3333-4333-8333-333333333333',
        accountId: 'account-a',
        baseVersionId: null,
        contentSha256: snapshot.contentSha256,
        requestSha256: first.requestSha256,
        reason: 'dirty',
        coverage: 'captured-bytes',
        createdAt: '2026-10-05T00:00:00.000Z',
        expiresAt: '2026-10-12T00:00:00.000Z',
      },
    });
    expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')?.receipt?.id).toBe(
      '33333333-3333-4333-8333-333333333333'
    );
    expect(readSnapshot()).toEqual(snapshot);
    expect(() =>
      ensureWorkspaceSyncRecoveryCandidateIntent(db, { ...input, ownerAccountId: 'account-b' })
    ).toThrow(/different bytes, account/);
    expect(() =>
      ensureWorkspaceSyncRecoveryCandidateIntent(db, { ...input, localHeadSha: 'new-head' })
    ).toThrow(/different bytes, account/);
    const refreshed = ensureWorkspaceSyncRecoveryCandidateIntent(db, {
      ...input,
      nowMs: Date.parse('2026-10-12T00:00:00.001Z'),
    });
    expect(refreshed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(refreshed.receipt).toBeUndefined();
    expect(
      ensureWorkspaceSyncRecoveryCandidateIntent(db, {
        ...input,
        nowMs: Date.parse('2026-10-12T00:00:00.001Z'),
      })
    ).toEqual(refreshed);
    expect(readSnapshot()).toEqual(snapshot);
  });

  it('retains native recovery acceptance identity and clock across reread and renews them only after expiry', () => {
    const snapshot = testSnapshot('LOCUS       A\nORIGIN\n        1 a\n//\n');
    recordWorkspaceSyncUploadSnapshot(db, { jobId: 'job-a', snapshot, nowMs: 10 });
    const input = {
      jobId: 'job-a',
      ownerAccountId: 'account-a',
      remoteWorkspaceId: 'remote-a',
      localHeadSha: 'saved-head',
      snapshotContentSha256: snapshot.contentSha256,
      requestSha256: 'a'.repeat(64),
      uploadIdempotencyKey: 'same-upload-key',
      nowMs: 100,
    };
    const first = ensureWorkspaceSyncRecoveryCandidateIntent(db, input);
    expect(first.acceptedOperationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(first.parentAcceptedOperationId).toBeNull();
    expect(first.createdAtMs).toBe(100);
    expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')).toEqual(first);
    expect(ensureWorkspaceSyncRecoveryCandidateIntent(db, { ...input, nowMs: 200 })).toEqual(first);
    const renewed = ensureWorkspaceSyncRecoveryCandidateIntent(db, {
      ...input,
      nowMs: 100 + WORKSPACE_SYNC_RECOVERY_RETENTION_MS,
    });
    expect(renewed.acceptedOperationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(renewed.acceptedOperationId).not.toBe(first.acceptedOperationId);
    expect(renewed.parentAcceptedOperationId).toBe(first.acceptedOperationId);
    expect(renewed.createdAtMs).toBe(100 + WORKSPACE_SYNC_RECOVERY_RETENTION_MS);
    expect(renewed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')).toEqual(renewed);
    expect(readSnapshot()).toEqual(snapshot);
  });

  it('keeps legacy recovery acceptance unqualified without rewriting its original intent', () => {
    const snapshot = testSnapshot('LOCUS       A\nORIGIN\n        1 a\n//\n');
    recordWorkspaceSyncUploadSnapshot(db, { jobId: 'job-a', snapshot, nowMs: 10 });
    const input = {
      jobId: 'job-a',
      ownerAccountId: 'account-a',
      remoteWorkspaceId: 'remote-a',
      localHeadSha: 'saved-head',
      snapshotContentSha256: snapshot.contentSha256,
      requestSha256: 'a'.repeat(64),
      uploadIdempotencyKey: 'same-upload-key',
      nowMs: 100,
    };
    ensureWorkspaceSyncRecoveryCandidateIntent(db, input);
    db.prepare(
      `UPDATE workspace_sync_upload_snapshots
      SET bundle_json = json_remove(bundle_json, '$.recoveryCandidate.acceptedOperationId', '$.recoveryCandidate.parentAcceptedOperationId')
      WHERE job_id = 'job-a'`
    ).run();
    const before = db
      .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
      .get('job-a');
    const legacy = ensureWorkspaceSyncRecoveryCandidateIntent(db, { ...input, nowMs: 200 });
    expect(legacy).toMatchObject({
      acceptedOperationId: null,
      parentAcceptedOperationId: null,
      createdAtMs: 100,
    });
    expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')).toEqual(legacy);
    expect(
      db
        .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
        .get('job-a')
    ).toEqual(before);
    expect(readSnapshot()).toEqual(snapshot);
  });

  it.each([
    { id: 'private/path', parent: null },
    { id: null, parent: '11111111-1111-4111-8111-111111111111' },
    { id: '11111111-1111-4111-8111-111111111111', parent: '11111111-1111-4111-8111-111111111111' },
  ])(
    'refuses corrupt native recovery operation identity without rewriting captured bytes: $id/$parent',
    ({ id, parent }) => {
      const snapshot = testSnapshot('LOCUS       A\nORIGIN\n        1 a\n//\n');
      recordWorkspaceSyncUploadSnapshot(db, { jobId: 'job-a', snapshot, nowMs: 10 });
      const input = {
        jobId: 'job-a',
        ownerAccountId: 'account-a',
        remoteWorkspaceId: 'remote-a',
        localHeadSha: 'saved-head',
        snapshotContentSha256: snapshot.contentSha256,
        requestSha256: 'a'.repeat(64),
        uploadIdempotencyKey: 'same-upload-key',
        nowMs: 100,
      };
      ensureWorkspaceSyncRecoveryCandidateIntent(db, input);
      db.prepare(
        `UPDATE workspace_sync_upload_snapshots
      SET bundle_json = json_set(bundle_json, '$.recoveryCandidate.acceptedOperationId', ?, '$.recoveryCandidate.parentAcceptedOperationId', ?)
      WHERE job_id = 'job-a'`
      ).run(id, parent);
      const before = db
        .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
        .get('job-a');
      expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')).toBeNull();
      expect(() => ensureWorkspaceSyncRecoveryCandidateIntent(db, input)).toThrow(/corrupt/);
      expect(
        db
          .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
          .get('job-a')
      ).toEqual(before);
      expect(readSnapshot()).toEqual(snapshot);
    }
  );

  it('preserves the first native recovery acknowledgement and both original clocks on replay', () => {
    const { snapshot, intent, receipt } = recoveryFixture();
    recordWorkspaceSyncRecoveryCandidateReceipt(db, {
      jobId: 'job-a',
      intent,
      receipt,
      nowMs: 200,
    });
    expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')).toMatchObject({
      acceptedOperationId: intent.acceptedOperationId,
      createdAtMs: 100,
      retainedAtMs: 200,
      receipt,
    });
    const first = db
      .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
      .get('job-a');
    recordWorkspaceSyncRecoveryCandidateReceipt(db, {
      jobId: 'job-a',
      intent,
      receipt,
      nowMs: 300,
    });
    expect(
      db
        .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
        .get('job-a')
    ).toEqual(first);
    expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')?.retainedAtMs).toBe(200);
    expect(readSnapshot()).toEqual(snapshot);
  });

  it.each(['identity', 'clock'])(
    'rejects a stale native recovery acknowledgement with another accepted $0',
    (change) => {
      const { snapshot, intent, receipt } = recoveryFixture();
      const stale =
        change === 'identity'
          ? {
              ...intent,
              acceptedOperationId:
                intent.acceptedOperationId === '11111111-1111-4111-8111-111111111111'
                  ? '22222222-2222-4222-8222-222222222222'
                  : '11111111-1111-4111-8111-111111111111',
            }
          : { ...intent, createdAtMs: 101 };
      const before = db
        .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
        .get('job-a');
      expect(() =>
        recordWorkspaceSyncRecoveryCandidateReceipt(db, {
          jobId: 'job-a',
          intent: stale,
          receipt,
          nowMs: 200,
        })
      ).toThrow(/no longer owns/);
      expect(
        db
          .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
          .get('job-a')
      ).toEqual(before);
      expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')?.receipt).toBeUndefined();
      expect(readSnapshot()).toEqual(snapshot);
    }
  );

  it('does not invent a native recovery acknowledgement clock for a previously retained legacy intent', () => {
    const { snapshot, intent, receipt } = recoveryFixture();
    recordWorkspaceSyncRecoveryCandidateReceipt(db, {
      jobId: 'job-a',
      intent,
      receipt,
      nowMs: 200,
    });
    db.prepare(
      `UPDATE workspace_sync_upload_snapshots
      SET bundle_json = json_remove(bundle_json, '$.recoveryCandidate.acceptedOperationId', '$.recoveryCandidate.parentAcceptedOperationId', '$.recoveryCandidate.retainedAtMs')
      WHERE job_id = 'job-a'`
    ).run();
    const legacy = readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a');
    if (!legacy) throw new Error('Expected the original legacy recovery intent.');
    const before = db
      .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
      .get('job-a');
    recordWorkspaceSyncRecoveryCandidateReceipt(db, {
      jobId: 'job-a',
      intent: legacy,
      receipt,
      nowMs: 300,
    });
    expect(
      db
        .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
        .get('job-a')
    ).toEqual(before);
    expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')).toMatchObject({
      acceptedOperationId: null,
      retainedAtMs: null,
      createdAtMs: 100,
    });
    expect(readSnapshot()).toEqual(snapshot);
  });

  it('refuses to replace a settled native recovery receipt with another candidate', () => {
    const { snapshot, intent, receipt } = recoveryFixture();
    recordWorkspaceSyncRecoveryCandidateReceipt(db, {
      jobId: 'job-a',
      intent,
      receipt,
      nowMs: 200,
    });
    const before = db
      .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
      .get('job-a');
    expect(() =>
      recordWorkspaceSyncRecoveryCandidateReceipt(db, {
        jobId: 'job-a',
        intent,
        receipt: { ...receipt, id: '44444444-4444-4444-8444-444444444444' },
        nowMs: 300,
      })
    ).toThrow(/already retained/);
    expect(
      db
        .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
        .get('job-a')
    ).toEqual(before);
    expect(readSnapshot()).toEqual(snapshot);
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1])(
    'refuses a recovery acknowledgement clock outside the native safe range: %s',
    (clock) => {
      const { snapshot, intent, receipt } = recoveryFixture();
      recordWorkspaceSyncRecoveryCandidateReceipt(db, {
        jobId: 'job-a',
        intent,
        receipt,
        nowMs: 200,
      });
      db.prepare(
        `UPDATE workspace_sync_upload_snapshots SET bundle_json = json_set(bundle_json, '$.recoveryCandidate.retainedAtMs', ?) WHERE job_id = 'job-a'`
      ).run(clock);
      const before = db
        .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
        .get('job-a');
      expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')).toBeNull();
      expect(
        db
          .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
          .get('job-a')
      ).toEqual(before);
      expect(readSnapshot()).toEqual(snapshot);
    }
  );

  it('refuses an unvalidated receipt in durable recovery metadata without changing captured bytes', () => {
    const snapshot = testSnapshot('LOCUS       A\nORIGIN\n        1 a\n//\n');
    recordWorkspaceSyncUploadSnapshot(db, { jobId: 'job-a', snapshot, nowMs: 10 });
    const input = {
      jobId: 'job-a',
      ownerAccountId: 'account-a',
      remoteWorkspaceId: 'remote-a',
      localHeadSha: 'saved-head',
      snapshotContentSha256: snapshot.contentSha256,
      requestSha256: 'a'.repeat(64),
      uploadIdempotencyKey: 'same-upload-key',
      nowMs: 10,
    };
    const intent = ensureWorkspaceSyncRecoveryCandidateIntent(db, input);
    const row = db
      .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?')
      .get('job-a') as { bundle_json: string };
    const envelope = JSON.parse(row.bundle_json);
    envelope.recoveryCandidate = { ...intent, receipt: { id: 'unvalidated-receipt' } };
    db.prepare('UPDATE workspace_sync_upload_snapshots SET bundle_json = ? WHERE job_id = ?').run(
      JSON.stringify(envelope),
      'job-a'
    );

    expect(readWorkspaceSyncRecoveryCandidateIntent(db, 'job-a')).toBeNull();
    expect(() => ensureWorkspaceSyncRecoveryCandidateIntent(db, input)).toThrow(/corrupt/);
    expect(readSnapshot()).toEqual(snapshot);
  });

  it('keeps cache-backed queued blobs as metadata when a staging root is configured', () => {
    const base = testSnapshot('LOCUS       CACHED\nORIGIN\n        1 a\n//\n');
    const bundle: WorkspaceSyncBundleV3 = {
      ...base.bundle,
      schemaVersion: 3,
      files: base.bundle.files.map((file) => ({ ...file, encoding: 'blob', content: '' })),
    };
    bundle.provenance = {
      ...bundle.provenance,
      contentSha256: sha256(workspaceSyncBundleHashInput(bundle)),
    };
    const snapshot = {
      ...base,
      bundle,
      contentSha256: bundle.provenance.contentSha256,
      bundleSizeBytes: Buffer.byteLength(JSON.stringify(bundle)),
    };
    recordWorkspaceSyncUploadSnapshot(db, {
      jobId: 'job-a',
      snapshot,
      nowMs: 10,
      root: stagingRoot,
    });
    const restored = readWorkspaceSyncUploadSnapshot(db, {
      jobId: 'job-a',
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath: '/managed/workspace-a/repo',
      root: stagingRoot,
    });
    expect(restored?.bundle).toEqual(bundle);
    expect(restored?.fileSources).toBeUndefined();
    expect(readdirSync(stagingRoot)).toEqual([]);
    deleteWorkspaceSyncUploadSnapshot(db, 'job-a', { root: stagingRoot });
    expect(readSnapshot()).toBeNull();
  });

  it('refuses to replace one job id with different request bytes', () => {
    recordWorkspaceSyncUploadSnapshot(db, {
      jobId: 'job-a',
      snapshot: testSnapshot('LOCUS       A\nORIGIN\n        1 a\n//\n'),
      nowMs: 10,
    });

    expect(() =>
      recordWorkspaceSyncUploadSnapshot(db, {
        jobId: 'job-a',
        snapshot: testSnapshot('LOCUS       B\nORIGIN\n        1 t\n//\n'),
        nowMs: 20,
      })
    ).toThrow('already names different upload bytes');
  });

  it('fails closed when the durable JSON is unreadable', () => {
    recordWorkspaceSyncUploadSnapshot(db, {
      jobId: 'job-a',
      snapshot: testSnapshot('LOCUS       A\nORIGIN\n        1 a\n//\n'),
      nowMs: 10,
    });
    db.prepare(
      `UPDATE workspace_sync_upload_snapshots SET bundle_json = 'not-json' WHERE job_id = 'job-a'`
    ).run();

    expect(() => readSnapshot()).toThrow('unreadable upload snapshot');
  });

  it('stores file-backed bytes outside SQLite and rehydrates their source paths', () => {
    const snapshot = testSnapshot('LOCUS       FILE\nORIGIN\n        1 a\n//\n');
    authoritativeRoot = mkdtempSync(join(tmpdir(), 'dnaforge-authoritative-'));
    const authoritativePath = join(authoritativeRoot, 'authoritative.gb');
    writeFileSync(authoritativePath, 'LOCUS       FILE\nORIGIN\n        1 a\n//\n', 'utf8');
    const persisted = recordWorkspaceSyncUploadSnapshot(db, {
      jobId: 'job-a',
      snapshot: {
        ...snapshot,
        captureFileSources: new Map([['design.gb', authoritativePath]]),
      },
      nowMs: 10,
      root: stagingRoot,
    });

    const row = db
      .prepare(`SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?`)
      .get('job-a') as { bundle_json: string };
    expect(JSON.parse(row.bundle_json)).toMatchObject({ storageVersion: 1 });
    expect(row.bundle_json).not.toContain('LOCUS       FILE');
    expect(persisted.fileSources?.get('design.gb')).toEqual(expect.any(String));
    expect(readFileSync(persisted.fileSources?.get('design.gb')!, 'utf8')).toContain(
      'LOCUS       FILE'
    );

    const restored = readWorkspaceSyncUploadSnapshot(db, {
      jobId: 'job-a',
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath: '/managed/workspace-a/repo',
      root: stagingRoot,
    });
    expect(restored?.bundle).toEqual(snapshot.bundle);
    expect(restored?.fileSources?.get('design.gb')).toEqual(
      persisted.fileSources?.get('design.gb')
    );

    deleteWorkspaceSyncUploadSnapshot(db, 'job-a', { root: stagingRoot });
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  it('rejects a corrupted staged file before it can be retried', () => {
    const snapshot = testSnapshot('LOCUS       CORRUPT\nORIGIN\n        1 c\n//\n');
    const persisted = recordWorkspaceSyncUploadSnapshot(db, {
      jobId: 'job-a',
      snapshot,
      nowMs: 10,
      root: stagingRoot,
    });
    const sourcePath = persisted.fileSources?.get('design.gb');
    expect(sourcePath).toEqual(expect.any(String));
    writeFileSync(sourcePath!, 'tampered', 'utf8');

    expect(() =>
      readWorkspaceSyncUploadSnapshot(db, {
        jobId: 'job-a',
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath: '/managed/workspace-a/repo',
        root: stagingRoot,
      })
    ).toThrow('corrupt staged file');
  });

  it('stores a manifest capture without embedding large file bytes', () => {
    authoritativeRoot = mkdtempSync(join(tmpdir(), 'dnaforge-authoritative-manifest-'));
    const content = 'A'.repeat(1024 * 1024);
    const authoritativePath = join(authoritativeRoot, 'large.gb');
    writeFileSync(authoritativePath, content, 'utf8');
    const manifest: WorkspaceSyncManifestV1 = {
      schemaVersion: 1,
      files: [
        {
          path: 'large.gb',
          contentSha256: sha256(content),
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          contentType: 'text/plain',
        },
      ],
    };
    const excludedSummary = testSnapshot('small').excludedSummary;
    const snapshot: WorkspaceSyncUploadCapture = {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath: '/managed/workspace-a/repo',
      manifest,
      fileSources: new Map([['large.gb', authoritativePath]]),
      contentSha256: sha256(workspaceSyncManifestHashInput(manifest)),
      bundleSizeBytes: Buffer.byteLength(JSON.stringify(manifest), 'utf8'),
      includedFileCount: 1,
      includedBytes: content.length,
      excludedSummary,
      statusExcludedSummary: {
        unsupportedCount: 0,
        privateRawDataCount: 0,
        referencePointerCount: 0,
        fileTooLargeCount: 0,
        bundleTooLargeCount: 0,
      },
      recoveryOnly: { reason: 'invalid-package', missingPaths: ['contents/missing.bin'] },
      selection: {
        version: 1,
        revision: 'a'.repeat(64),
        state: 'active',
        ruleFiles: [{ relativePath: '.gitignore', content: 'temp/\n' }],
        newlyIncludedPaths: ['large.gb'],
      },
      excludedFiles: [
        { relativePath: 'temp/local.fasta', sizeBytes: 12, reason: 'project-ignore' },
      ],
    };

    const persisted = recordWorkspaceSyncUploadCapture(db, {
      jobId: 'job-a',
      snapshot,
      nowMs: 10,
      root: stagingRoot,
    });
    const row = db
      .prepare(`SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id = ?`)
      .get('job-a') as { bundle_json: string };
    expect(JSON.parse(row.bundle_json)).toMatchObject({ storageVersion: 2 });
    expect(row.bundle_json).not.toContain(content);
    expect(readFileSync(persisted.fileSources.get('large.gb')!, 'utf8')).toBe(content);

    const restored = readWorkspaceSyncUploadCapture(db, {
      jobId: 'job-a',
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath: '/managed/workspace-a/repo',
      root: stagingRoot,
    });
    expect(restored?.manifest).toEqual(manifest);
    expect(restored?.contentSha256).toBe(snapshot.contentSha256);
    expect(restored?.fileSources.get('large.gb')).toEqual(persisted.fileSources.get('large.gb'));
    expect(restored?.recoveryOnly).toEqual(snapshot.recoveryOnly);
    expect(restored?.selection).toEqual(snapshot.selection);
    expect(restored?.excludedFiles).toEqual(snapshot.excludedFiles);
    expect(restored?.statusExcludedSummary).toEqual({
      ...snapshot.statusExcludedSummary,
      ignoredCount: 1,
    });
    const retried = recordWorkspaceSyncUploadCapture(db, {
      jobId: 'job-a',
      snapshot: {
        ...snapshot,
        selection: { ...snapshot.selection!, revision: 'b'.repeat(64) },
        excludedFiles: [],
      },
      nowMs: 20,
      root: stagingRoot,
    });
    expect(retried.selection).toEqual(snapshot.selection);
    expect(retried.excludedFiles).toEqual(snapshot.excludedFiles);
    expect(readFileSync(retried.fileSources.get('large.gb')!, 'utf8')).toBe(content);
    db.prepare(
      `UPDATE workspace_sync_upload_snapshots SET bundle_json=json_set(bundle_json,'$.selection.version',2) WHERE job_id='job-a'`
    ).run();
    expect(() =>
      readWorkspaceSyncUploadCapture(db, {
        jobId: 'job-a',
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath: '/managed/workspace-a/repo',
        root: stagingRoot,
      })
    ).toThrow(/queued file selection is invalid/);
  });

  it('retains the exact scientific archive across retry without recapturing or downgrading to files', () => {
    authoritativeRoot = mkdtempSync(join(tmpdir(), 'dnaforge-scientific-capture-'));
    const identity = parseWorkspaceId('portable-project');
    const accepted = parseRefName('accepted');
    if (!identity.ok || !accepted.ok) throw new Error('Invalid fixture identity.');
    const graph = createRevisionGraph({ workspaceId: identity.value, acceptedRef: accepted.value });
    const history = exportScientificHistory(graph, { readBlob: () => null });
    const archive = serializeScientificHistory(history);
    const descriptor = describeScientificCloudHistory(history);
    const archivePath = join(authoritativeRoot, 'history');
    const notePath = join(authoritativeRoot, 'notes');
    writeFileSync(archivePath, archive);
    writeFileSync(notePath, 'accepted notes');
    const manifest: WorkspaceSyncManifestV1 = {
      schemaVersion: 1,
      files: [
        {
          path: 'notes.txt',
          contentSha256: sha256('accepted notes'),
          sizeBytes: 14,
          contentType: 'text/plain',
        },
      ],
    };
    const fileManifestSha256 = sha256(workspaceSyncManifestHashInput(manifest));
    const snapshot: WorkspaceSyncUploadCapture = {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath: '/managed/workspace-a/repo',
      manifest,
      fileSources: new Map([['notes.txt', notePath]]),
      contentSha256: sha256(scientificCloudVersionHashInput(fileManifestSha256, descriptor)),
      fileManifestSha256,
      scientificHistory: descriptor,
      scientificBlobRefs: history.blobs,
      scientificBlobSources: new Map([[descriptor.archive.hash, archivePath]]),
      bundleSizeBytes: Buffer.byteLength(JSON.stringify(manifest)),
      includedFileCount: 1,
      includedBytes: 14,
      excludedSummary: testSnapshot('small').excludedSummary,
      statusExcludedSummary: {
        unsupportedCount: 0,
        privateRawDataCount: 0,
        referencePointerCount: 0,
        fileTooLargeCount: 0,
        bundleTooLargeCount: 0,
      },
    };
    const persisted = recordWorkspaceSyncUploadCapture(db, {
      jobId: 'job-a',
      snapshot,
      nowMs: 10,
      root: stagingRoot,
    });
    const read = () =>
      readWorkspaceSyncUploadCapture(db, {
        jobId: 'job-a',
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath: snapshot.repoPath,
        root: stagingRoot,
      });
    const staged = persisted.scientificBlobSources!.get(descriptor.archive.hash)!;
    expect(staged).not.toBe(archivePath);
    writeFileSync(archivePath, 'later source edit');
    expect(readFileSync(staged)).toEqual(Buffer.from(archive));
    expect(read()?.scientificHistory).toEqual(descriptor);
    expect(read()?.scientificBlobSources?.get(descriptor.archive.hash)).toBe(staged);
    const metadata = db
      .prepare('SELECT bundle_json FROM workspace_sync_upload_snapshots WHERE job_id=?')
      .get('job-a') as { bundle_json: string };
    expect(JSON.parse(metadata.bundle_json).storageVersion).toBe(3);
    const entries = readdirSync(stagingRoot);
    recordWorkspaceSyncUploadCapture(db, {
      jobId: 'job-a',
      snapshot,
      nowMs: 20,
      root: stagingRoot,
    });
    expect(readdirSync(stagingRoot)).toEqual(entries);
    writeFileSync(staged, 'incomplete interrupted archive');
    expect(read).toThrow(/scientific|staged/i);
    expect(
      db.prepare('SELECT count(*) AS count FROM workspace_sync_upload_snapshots').get()
    ).toEqual({ count: 1 });
  });

  it('removes superseded queue snapshots and their staged files together', () => {
    db.prepare(
      `INSERT INTO workspace_sync_queue (
         id, workspace_id, operation, status, attempt_count, error_code, created_at, updated_at
       ) VALUES ('job-b', 1, 'upload', 'failed', 1, 'NETWORK', 1, 1)`
    ).run();
    const snapshot = testSnapshot('LOCUS       B\nORIGIN\n        1 t\n//\n');
    recordWorkspaceSyncUploadSnapshot(db, {
      jobId: 'job-b',
      snapshot,
      nowMs: 10,
      root: stagingRoot,
    });

    deleteWorkspaceSyncUploadSnapshotsForWorkspace(db, {
      workspaceId: 1,
      excludeJobId: 'job-a',
      root: stagingRoot,
    });

    expect(
      readWorkspaceSyncUploadSnapshot(db, {
        jobId: 'job-b',
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath: '/managed/workspace-a/repo',
        root: stagingRoot,
      })
    ).toBeNull();
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  function recoveryFixture() {
    const snapshot = testSnapshot('LOCUS       A\nORIGIN\n        1 a\n//\n');
    recordWorkspaceSyncUploadSnapshot(db, { jobId: 'job-a', snapshot, nowMs: 10 });
    const intent = ensureWorkspaceSyncRecoveryCandidateIntent(db, {
      jobId: 'job-a',
      ownerAccountId: 'account-a',
      remoteWorkspaceId: 'remote-a',
      localHeadSha: 'saved-head',
      snapshotContentSha256: snapshot.contentSha256,
      requestSha256: 'a'.repeat(64),
      uploadIdempotencyKey: 'same-upload-key',
      nowMs: 100,
    });
    const receipt = {
      id: '33333333-3333-4333-8333-333333333333',
      accountId: 'account-a',
      baseVersionId: null,
      contentSha256: snapshot.contentSha256,
      requestSha256: intent.requestSha256,
      reason: 'dirty',
      coverage: 'captured-bytes',
      createdAt: '2026-11-02T00:00:00.000Z',
      expiresAt: '2026-11-09T00:00:00.000Z',
    } satisfies WorkspaceSyncRecoveryCandidateReceipt;
    return { snapshot, intent, receipt };
  }

  function readSnapshot(): WorkspaceSyncSnapshot | null {
    return readWorkspaceSyncUploadSnapshot(db, {
      jobId: 'job-a',
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath: '/managed/workspace-a/repo',
    });
  }
});

function testSnapshot(content: string): WorkspaceSyncSnapshot {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const bundle: WorkspaceSyncBundleV1 = {
    schemaVersion: 1,
    capturedAt: '2026-08-25T00:00:00.000Z',
    workspace: { id: 'workspace-a', name: 'Project A' },
    files: [
      {
        id: 'file-a',
        relativePath: 'design.gb',
        name: 'design.gb',
        kind: 'genbank',
        contentType: 'text/plain',
        sizeBytes,
        sha256: sha256(content),
        content,
      },
    ],
    excludedSummary: {
      unsupported: { count: 0, bytesApprox: 0 },
      'private-raw-data': { count: 0, bytesApprox: 0 },
      'reference-pointer': { count: 0, bytesApprox: 0 },
      'file-too-large': { count: 0, bytesApprox: 0 },
      'bundle-too-large': { count: 0, bytesApprox: 0 },
    },
    limits: resolveWorkspaceSyncBundleLimits(),
    provenance: {
      source: 'dnaforge-desktop',
      appVersion: '0.8.1',
      contentSha256: '0'.repeat(64),
    },
  };
  const contentSha256 = sha256(workspaceSyncBundleHashInput(bundle));
  bundle.provenance.contentSha256 = contentSha256;
  return {
    workspaceId: 1,
    workspaceUuid: 'workspace-a',
    repoPath: '/managed/workspace-a/repo',
    bundle,
    contentSha256,
    bundleSizeBytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
    includedFileCount: 1,
    includedBytes: sizeBytes,
    excludedSummary: bundle.excludedSummary,
    statusExcludedSummary: {
      unsupportedCount: 0,
      privateRawDataCount: 0,
      referencePointerCount: 0,
      fileTooLargeCount: 0,
      bundleTooLargeCount: 0,
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
