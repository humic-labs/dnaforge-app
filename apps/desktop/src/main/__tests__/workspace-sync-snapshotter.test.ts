import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import git from 'isomorphic-git';
import {
  decodeBundleFileContent,
  DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS,
  DEFAULT_WORKSPACE_SYNC_MANIFEST_LIMITS,
  validateWorkspaceSyncBundle,
  workspaceSyncBundleHashInput,
  workspaceSyncManifestHashInput,
} from '@waypoint/share-bundle';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

const TEST_STORAGE_POLICY = {
  schemaVersion: 1 as const,
  policyKey: 'test',
  revision: 1,
  maxFileBytes: 4 * 1024 * 1024,
  maxProjectBytes: 16 * 1024 * 1024,
  maxFiles: 2000,
  storageQuotaBytes: 32 * 1024 * 1024,
};

import { ensureSchema } from '../schema';
import { registerLimsEntityInDb } from '../lims';
import { materializeLimsGitReadableExportInDb } from '../lims-git-export';
import {
  buildSequencePackageDocument,
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { loadSequencePackageDocument } from '../../db/sequence-package-io';
import {
  buildNotebookPackageMetadata,
  serializeNotebookPackageMetadata,
} from '../../db/notebook-package';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import { MANAGED_WORKSPACE_MARKER } from '../../shared/workspace-git-types';
import { NATIVE_WORKSPACE_MANIFEST_PATH } from '../../shared/native-workspace-manifest';
import {
  WorkspaceSyncSnapshotError,
  assertWorkspaceSyncSnapshotMatchesCommit,
  assertWorkspaceSyncUploadCaptureMatchesCommit,
  buildWorkspaceSyncSnapshot,
  buildWorkspaceSyncUploadCapture,
  buildWorkspaceSyncRecoveryCapture,
  previewWorkspaceSyncUpload,
} from '../workspace-sync-snapshotter';
import {
  commitAllIfDirty,
  initManagedRepo,
  resolveHeadCommit,
  withManagedWorkspaceMutationLock,
} from '../workspace-git';
import { importIntoManagedWorkspaceRepo } from '../workspace-git/import';
import {
  acquireWorkspaceMutationShared,
  acquireWorkspaceSyncMutationLease,
} from '../workspace-sync-mutation-lease';
import { createTestDb } from './test-db';
import { writeWorkspaceTextFileAtomicInMain } from '../primer-artifact-files';
import { recordWorkspaceSyncReplicaFiles } from '../workspace-sync-replica-files';
import { workspaceSyncBlobPath, verifyWorkspaceSyncBlob } from '../workspace-sync-blob-cache';
import { setActiveFilesystemWorkGuard } from '../active-filesystem-work';
import * as blobIdentity from '../workspace-git/blob-content-identity';

describe('workspace sync snapshotter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
  });

  it('freezes allowed present bytes of an invalid package only as incomplete recovery, without weakening accepted capture', async () => {
    const root = await tempRoot();
    const staging = await tempRoot();
    await mkdir(join(root, 'sequences/invalid/.forge'), { recursive: true });
    const marker = JSON.stringify({
      schema: 'waypoint.sequence.v1',
      kind: 'sequence',
      formatVersion: 99,
      id: 'invalid-stable-id',
      product: { file: 'construct.gb' },
      members: [
        { id: 'missing', path: 'contents/missing.bin', role: 'data' },
        { id: 'private', path: 'contents/private.ab1', role: 'data' },
      ],
    });
    await writeFile(join(root, 'sequences/invalid/.forge/plasmid.json'), marker);
    await writeFile(
      join(root, 'sequences/invalid/construct.gb'),
      new Uint8Array([0xff, 0xfe, 0x00])
    );
    await mkdir(join(root, 'sequences/invalid/contents'));
    await writeFile(
      join(root, 'sequences/invalid/contents/private.ab1'),
      'must not leave this device'
    );
    await writeFile(join(root, 'notes.txt'), 'recover these exact notes');
    seedWorkspace(db, { id: 1, repoUuid: 'invalid-recovery', name: 'Recovery', path: root });
    await expect(
      buildWorkspaceSyncUploadCapture(db, {
        workspaceUuid: 'invalid-recovery',
        appVersion: '1.0.0',
        prepareProjection: false,
        captureSourceRoot: staging,
        storagePolicy: TEST_STORAGE_POLICY,
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_AUTHORITATIVE_STATE' });
    const frozen = await buildWorkspaceSyncRecoveryCapture(db, {
      workspaceUuid: 'invalid-recovery',
      appVersion: '1.0.0',
      prepareProjection: false,
      captureSourceRoot: staging,
      storagePolicy: TEST_STORAGE_POLICY,
    });
    try {
      expect(frozen.recoveryOnly).toEqual({
        reason: 'invalid-package',
        missingPaths: [
          'sequences/invalid/contents/missing.bin',
          'sequences/invalid/contents/private.ab1',
        ],
      });
      expect(frozen.manifest.files.map((file) => file.path)).toEqual([
        'notes.txt',
        'sequences/invalid/.forge/plasmid.json',
        'sequences/invalid/construct.gb',
      ]);
      expect(frozen.statusExcludedSummary.privateRawDataCount).toBe(1);
      const exact = await readFile(frozen.fileSources.get('sequences/invalid/construct.gb')!);
      expect([...exact]).toEqual([0xff, 0xfe, 0x00]);
      await writeFile(join(root, 'notes.txt'), 'later edit must not change recovery');
      expect(await readFile(frozen.fileSources.get('notes.txt')!, 'utf8')).toBe(
        'recover these exact notes'
      );
    } finally {
      await frozen.dispose?.();
    }
    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'invalid-recovery',
        appVersion: '1.0.0',
        prepareProjection: false,
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_AUTHORITATIVE_STATE' });
  });

  it('refuses an accepted capture when a required package member is excluded, even if unrelated notes remain admissible', async () => {
    const root = await tempRoot();
    const staging = await tempRoot();
    await mkdir(join(root, 'sequences/construct/.forge'), { recursive: true });
    await mkdir(join(root, 'sequences/construct/contents'));
    await writeFile(
      join(root, 'sequences/construct/.forge/plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'construct-stable-id',
          name: 'Construct',
          product: { file: 'construct.gb' },
          members: [
            {
              id: 'trace-stable-id',
              path: 'contents/private.ab1',
              role: 'data',
              replaceable: false,
              createdAt: '2026-10-05T00:00:00.000Z',
            },
          ],
          updatedAt: '2026-10-05T00:00:00.000Z',
        })
      )
    );
    await writeFile(join(root, 'sequences/construct/construct.gb'), genbank('construct'));
    await writeFile(join(root, 'sequences/construct/contents/private.ab1'), 'private trace');
    await writeFile(join(root, 'notes.txt'), 'unrelated admissible notes');
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'excluded-required-member',
      name: 'Required member',
      path: root,
    });
    await expect(
      buildWorkspaceSyncUploadCapture(db, {
        workspaceUuid: 'excluded-required-member',
        appVersion: '1.0.0',
        prepareProjection: false,
        captureSourceRoot: staging,
        storagePolicy: TEST_STORAGE_POLICY,
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_AUTHORITATIVE_STATE',
      message: expect.stringMatching(/required member.*private-raw-data/i),
    });
  });

  it.each(
    [
      { name: 'file size', maxFileBytes: 2048, maxProjectBytes: 16384, maxFiles: 2000 },
      { name: 'package bytes', maxFileBytes: 8192, maxProjectBytes: 8192, maxFiles: 2000 },
      { name: 'package file count', maxFileBytes: 16384, maxProjectBytes: 16384, maxFiles: 2 },
    ].flatMap((allowance) => ['manifest', 'bundle'].map((mode) => ({ ...allowance, mode })))
  )(
    'refuses to omit a managed package from accepted $mode capture after a $name limit',
    async (limits) => {
      const root = await tempRoot();
      const { app } = await import('electron');
      vi.mocked(app.getPath).mockReturnValue(root);
      const staging = await tempRoot();
      await mkdir(join(root, 'sequences/construct/.forge'), { recursive: true });
      await mkdir(join(root, 'sequences/construct/contents'));
      await writeFile(
        join(root, 'sequences/construct/.forge/plasmid.json'),
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'construct-stable-id',
            name: 'Construct',
            product: { file: 'construct.gb' },
            members: [
              {
                id: 'attachment-stable-id',
                path: 'contents/evidence.bin',
                role: 'data',
                replaceable: false,
                createdAt: '2026-10-05T00:00:00.000Z',
              },
            ],
            updatedAt: '2026-10-05T00:00:00.000Z',
          })
        )
      );
      await writeFile(join(root, 'sequences/construct/construct.gb'), genbank('construct'));
      await writeFile(
        join(root, 'sequences/construct/contents/evidence.bin'),
        new Uint8Array(8192)
      );
      await writeFile(join(root, 'notes.txt'), 'unrelated admissible notes');
      seedWorkspace(db, {
        id: 1,
        repoUuid: 'limited-required-package',
        name: 'Required package',
        path: root,
      });
      const { name: _name, mode, ...allowance } = limits;
      await expect(
        (mode === 'manifest' ? buildWorkspaceSyncUploadCapture : buildWorkspaceSyncSnapshot)(db, {
          workspaceUuid: 'limited-required-package',
          appVersion: '1.0.0',
          prepareProjection: false,
          directStorage: true,
          captureSourceRoot: staging,
          storagePolicy: { ...TEST_STORAGE_POLICY, ...allowance },
        })
      ).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
        message: expect.stringMatching(/required member|complete package/i),
      });
    }
  );

  it.each(
    [
      { name: 'file size', maxFileBytes: 4096, maxProjectBytes: 16384, maxFiles: 2000 },
      { name: 'project size', maxFileBytes: 6000, maxProjectBytes: 6000, maxFiles: 2000 },
      { name: 'file count', maxFileBytes: 6000, maxProjectBytes: 16384, maxFiles: 1 },
    ].flatMap((limits) => ['bundle', 'manifest'].map((mode) => ({ ...limits, mode })))
  )(
    'refuses to prune shared files in $mode capture after a $name downgrade, while allowing deliberate deletion and new exclusions',
    async (limits) => {
      const root = await tempRoot();
      const { app } = await import('electron');
      vi.mocked(app.getPath).mockReturnValue(root);
      seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Shared', path: root });
      await writeFile(join(root, 'a.gb'), genbank('a') + 'A'.repeat(3000));
      await writeFile(join(root, 'b.gb'), genbank('b') + 'B'.repeat(5000));
      await writeFile(join(root, MANAGED_WORKSPACE_MARKER), '{}');
      db.prepare(
        `INSERT INTO workspace_sync_bindings
      (workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
       remote_latest_version_id, created_at, updated_at)
      VALUES (1, 'workspace-a', 'account-a', 'remote-a', 1, 'version-a', 1, 1)`
      ).run();
      recordWorkspaceSyncReplicaFiles(db, {
        workspaceUuid: 'workspace-a',
        remoteWorkspaceId: 'remote-a',
        remoteVersionId: 'version-a',
        paths: ['a.gb', 'b.gb', MANAGED_WORKSPACE_MARKER],
        nowMs: 1,
      });
      const { name: _name, mode, ...allowance } = limits;
      const storagePolicy = { ...TEST_STORAGE_POLICY, ...allowance };
      const capture = () =>
        (mode === 'manifest' ? buildWorkspaceSyncUploadCapture : buildWorkspaceSyncSnapshot)(db, {
          workspaceUuid: 'workspace-a',
          appVersion: '0.4.0',
          directStorage: true,
          storagePolicy,
        });
      await expect(capture()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      await unlink(join(root, 'b.gb'));
      await writeFile(join(root, 'new.gb'), genbank('new') + 'N'.repeat(20000));
      const captured = await capture();
      expect(
        'manifest' in captured
          ? captured.manifest.files.map((file) => file.path)
          : captured.bundle.files.map((file) => file.relativePath)
      ).toEqual(['a.gb']);
      expect(captured.excludedSummary['file-too-large'].count).toBe(1);
      db.prepare("DELETE FROM settings WHERE key LIKE 'workspace_sync_replica_files:%'").run();
      await expect(capture()).rejects.toMatchObject({ code: 'SHARED_FILE_OWNERSHIP_REQUIRED' });
    }
  );

  it('keeps accepted private notes when a new oversized file is excluded, and refuses to prune oversized accepted notes', async () => {
    const root = await tempRoot();
    const { app } = await import('electron');
    vi.mocked(app.getPath).mockReturnValue(root);
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Shared', path: root });
    const notes = 'Private experiment notes\n';
    await writeFile(join(root, 'a.gb'), genbank('a'));
    await writeFile(join(root, 'notes.txt'), notes);
    await writeFile(join(root, 'new.gb'), genbank('new') + 'N'.repeat(20000));
    await writeFile(join(root, MANAGED_WORKSPACE_MARKER), '{}');
    db.prepare(
      `INSERT INTO workspace_sync_bindings
       (workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
        remote_latest_version_id, created_at, updated_at)
       VALUES (1, 'workspace-a', 'account-a', 'remote-a', 1, 'version-a', 1, 1)`
    ).run();
    recordWorkspaceSyncReplicaFiles(db, {
      workspaceUuid: 'workspace-a',
      remoteWorkspaceId: 'remote-a',
      remoteVersionId: 'version-a',
      paths: ['a.gb', 'notes.txt', MANAGED_WORKSPACE_MARKER],
      nowMs: 1,
    });
    const capture = () =>
      buildWorkspaceSyncUploadCapture(db, {
        workspaceUuid: 'workspace-a',
        appVersion: '0.4.0',
        storagePolicy: { ...TEST_STORAGE_POLICY, maxFileBytes: 4096, maxProjectBytes: 16384 },
      });
    const captured = await capture();
    expect(captured.manifest.files.map((file) => file.path)).toEqual(['a.gb', 'notes.txt']);
    expect(captured.manifest.files.find((file) => file.path === 'notes.txt')?.contentSha256).toBe(
      createHash('sha256').update(notes).digest('hex')
    );
    expect(captured.excludedSummary['file-too-large'].count).toBe(1);
    await writeFile(join(root, 'notes.txt'), notes + 'N'.repeat(5000));
    await expect(capture()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('builds a valid WorkspaceSyncBundleV2 from managed content with aggregate exclusions only', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sequences'), { recursive: true });
    await mkdir(join(root, 'raw'), { recursive: true });
    await mkdir(join(root, 'refs'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await mkdir(join(root, '.dnaforge', 'migration', 'external-sources'), { recursive: true });
    await mkdir(join(root, '.dnaforge'), { recursive: true });

    await writeFile(join(root, 'sequences', 'pUC19.gb'), genbank('pUC19'), 'utf8');
    await writeFile(join(root, 'sequences', 'chrIV.gbff'), genbank('chrIV'), 'utf8');
    await writeFile(join(root, 'notes.txt'), 'unsupported note', 'utf8');
    await writeFile(join(root, MANAGED_WORKSPACE_MARKER), '{"managed":true}\n', 'utf8');
    await writeFile(join(root, 'raw', 'reads.fastq'), '@r\nATGC\n+\n!!!!\n', 'utf8');
    await writeFile(join(root, 'refs', 'reference.gff3'), '##gff-version 3\n', 'utf8');
    await writeFile(
      join(root, 'large.gb'),
      'A'.repeat(DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS.maxFileBytes + 1),
      'utf8'
    );
    await writeFile(join(root, '.git', 'hidden.gb'), genbank('hidden'), 'utf8');
    await writeFile(join(root, 'node_modules', 'pkg', 'hidden.gb'), genbank('hidden'), 'utf8');
    await writeFile(join(root, 'dist', 'hidden.gb'), genbank('hidden'), 'utf8');
    await writeFile(join(root, 'tmp', 'hidden.gb'), genbank('hidden'), 'utf8');
    await writeFile(
      join(root, '.dnaforge', 'migration', 'external-sources', 'absolute-source.gb'),
      genbank('/Users/scientist/Downloads/private-export.zip'),
      'utf8'
    );
    await writeFile(join(root, '.dnaforge', 'native-workspace.json'), '{"schema":"v2"}\n');
    await writeFile(
      join(root, '.dnaforge', 'hosted-resource-bindings.json'),
      '{"schema":1,"derived":true}\n'
    );
    await writeFile(
      join(root, 'sequences', '.pUC19.gb.1234.dnaforge-migration.tmp'),
      genbank('temporary'),
      'utf8'
    );
    await symlink(join(root, 'sequences', 'pUC19.gb'), join(root, 'linked.gb'));
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Project A', path: root });

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-08T00:00:00.000Z'),
    });

    expect(validateWorkspaceSyncBundle(snapshot.bundle)).toMatchObject({ ok: true });
    expect(snapshot.bundle).not.toHaveProperty('excludedFiles');
    expect(snapshot.bundle.workspace).toEqual({ id: 'workspace-a', name: 'Project A' });
    expect(snapshot.bundle.files.map((file) => file.relativePath)).toEqual([
      '.dnaforge/native-workspace.json',
      'dist/hidden.gb',
      'node_modules/pkg/hidden.gb',
      'sequences/chrIV.gbff',
      'sequences/pUC19.gb',
      'tmp/hidden.gb',
    ]);
    expect(snapshot.bundle.files.map((file) => file.relativePath)).not.toContain(
      '.dnaforge/hosted-resource-bindings.json'
    );
    expect(
      snapshot.bundle.files.find((file) => file.relativePath === 'sequences/chrIV.gbff')
    ).toMatchObject({
      name: 'chrIV.gbff',
      kind: 'genbank',
      contentType: 'text/plain',
      content: genbank('chrIV'),
    });
    expect(
      snapshot.bundle.files.find((file) => file.relativePath === 'sequences/pUC19.gb')
    ).toMatchObject({
      name: 'pUC19.gb',
      kind: 'genbank',
      contentType: 'text/plain',
      content: genbank('pUC19'),
    });
    expect(snapshot.bundle.excludedSummary).toMatchObject({
      unsupported: { count: 2 },
      'private-raw-data': { count: 1 },
      'reference-pointer': { count: 1 },
      'file-too-large': { count: 1 },
      'bundle-too-large': { count: 0 },
    });
    expect(snapshot.statusExcludedSummary).toEqual({
      ignoredCount: 0,
      unsupportedCount: 2,
      privateRawDataCount: 1,
      referencePointerCount: 1,
      fileTooLargeCount: 1,
      bundleTooLargeCount: 0,
    });
    expect(snapshot.contentSha256).toBe(sha256Hex(workspaceSyncBundleHashInput(snapshot.bundle)));
    expect(snapshot.bundle.provenance.contentSha256).toBe(snapshot.contentSha256);
  });

  it('captures a manifest and source paths without embedding upload bytes', async () => {
    const root = await tempRoot();
    const sourcePath = join(root, 'large.gb');
    await writeFile(sourcePath, Buffer.alloc(8 * 1024 * 1024, 0x41));
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-upload-capture',
      name: 'Upload capture',
      path: root,
    });

    const capture = await buildWorkspaceSyncUploadCapture(db, {
      workspaceUuid: 'workspace-upload-capture',
      appVersion: '0.9.3',
      capturedAt: new Date('2026-09-29T00:00:00.000Z'),
    });

    expect(capture.manifest.files).toEqual([
      {
        path: 'large.gb',
        contentSha256: sha256Hex('A'.repeat(8 * 1024 * 1024)),
        sizeBytes: 8 * 1024 * 1024,
        contentType: 'text/plain',
      },
    ]);
    expect(capture.fileSources.get('large.gb')).toBe(sourcePath);
    expect(capture.contentSha256).toBe(sha256Hex(workspaceSyncManifestHashInput(capture.manifest)));
  });

  it('hashes frozen sources after a foreground change and leaves live attachment metadata untouched', async () => {
    const root = await tempRoot();
    const repo = join(root, 'repo');
    const uploads = join(root, 'uploads');
    await mkdir(repo);
    const source = join(repo, 'large.fasta');
    const bytes = Buffer.alloc(2 * 1024 * 1024, 'A');
    bytes.write('>large\n');
    bytes[bytes.length - 1] = 10;
    await writeFile(source, bytes);
    await writeFile(join(repo, 'notes.txt'), 'original notes\n');
    await initManagedRepo(repo);
    const originalHead = await commitAllIfDirty(repo, 'Original frozen capture');
    expect(originalHead).toBeTruthy();
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-frozen', name: 'Frozen', path: repo });
    const original = statSync(source);
    const release = await acquireWorkspaceSyncMutationLease(repo);
    const capture = await buildWorkspaceSyncUploadCapture(db, {
      workspaceUuid: 'workspace-frozen',
      appVersion: '1.0.0',
      prepareProjection: false,
      captureSourceRoot: uploads,
      onSourcesFrozen: async () => {
        release();
        const releaseSave = await acquireWorkspaceMutationShared(repo);
        try {
          await withManagedWorkspaceMutationLock(repo, async () => {
            writeFileSync(join(repo, 'notes.txt'), 'foreground notes\n');
            await commitAllIfDirty(repo, 'Foreground Save before capture hashing');
          });
        } finally {
          releaseSave();
        }
      },
    });
    try {
      expect(capture.manifest.files.find((file) => file.path === 'notes.txt')?.contentSha256).toBe(
        createHash('sha256').update('original notes\n').digest('hex')
      );
      expect(readFileSync(capture.fileSources.get('notes.txt')!, 'utf8')).toBe('original notes\n');
      expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('foreground notes\n');
      expect(statSync(capture.fileSources.get('large.fasta')!).ino).not.toBe(original.ino);
      expect(statSync(source).ctimeMs).toBe(original.ctimeMs);
      expect(await resolveHeadCommit(repo)).not.toBe(originalHead);
      await assertWorkspaceSyncUploadCaptureMatchesCommit(capture, originalHead!);
      const privateSource = capture.fileSources.get('large.fasta')!;
      await capture.dispose!();
      expect(existsSync(privateSource)).toBe(false);
      expect((await readFile(source)).equals(bytes)).toBe(true);
    } finally {
      release();
      await capture.dispose?.();
    }
  });

  it('cleans frozen sources when text validation fails after releasing the file lease', async () => {
    const root = await tempRoot();
    const repo = join(root, 'repo');
    const uploads = join(root, 'uploads');
    await mkdir(repo);
    await writeFile(join(repo, 'notes.txt'), Buffer.from([0xff]));
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-invalid-frozen', name: 'Invalid', path: repo });
    const release = await acquireWorkspaceSyncMutationLease(repo);
    let frozen = false;
    try {
      await expect(
        buildWorkspaceSyncUploadCapture(db, {
          workspaceUuid: 'workspace-invalid-frozen',
          appVersion: '1.0.0',
          prepareProjection: false,
          captureSourceRoot: uploads,
          onSourcesFrozen: () => {
            frozen = true;
            release();
          },
        })
      ).rejects.toMatchObject({ code: 'INVALID_TEXT_ENCODING' });
      expect(frozen).toBe(true);
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(uploads)).toEqual([]);
    } finally {
      release();
    }
  });

  it('captures private text and image files without broadening legacy design bundles', async () => {
    const root = await tempRoot();
    const notes = Buffer.from('Project notes: α-factor\n', 'utf8');
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    await writeFile(join(root, 'sample.gb'), genbank('mixed'));
    await writeFile(join(root, 'notes.txt'), notes);
    await writeFile(join(root, 'preview.png'), image);
    await writeFile(join(root, '.secrets.txt'), 'must stay excluded');
    await writeFile(join(root, 'reads.fastq'), '@r\nATGC\n+\n!!!!\n');
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-mixed-capture', name: 'Mixed', path: root });
    await initManagedRepo(root);
    const commitOid = await commitAllIfDirty(root, 'Capture real mixed-resource Git bytes');
    if (!commitOid) throw new Error('Mixed resource fixture was not committed.');

    const capture = await buildWorkspaceSyncUploadCapture(db, {
      workspaceUuid: 'workspace-mixed-capture',
      appVersion: '0.9.3',
      prepareProjection: false,
    });
    for (const [path, bytes, contentType] of [
      ['notes.txt', notes, 'text/plain'],
      ['preview.png', image, 'image/png'],
    ] as const) {
      expect(capture.manifest.files).toContainEqual({
        path,
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        contentType,
      });
      expect(capture.fileSources.get(path)).toBe(join(root, path));
    }
    expect(capture.includedFileCount).toBe(3);
    await expect(
      assertWorkspaceSyncUploadCaptureMatchesCommit(capture, commitOid)
    ).resolves.toBeUndefined();
    expect(capture.statusExcludedSummary).toMatchObject({
      unsupportedCount: 1,
      privateRawDataCount: 1,
    });
    expect(capture.fileSources.has('.secrets.txt')).toBe(false);
    expect(capture.fileSources.has('reads.fastq')).toBe(false);
    const { app } = await import('electron');
    vi.mocked(app.getPath).mockReturnValue(await tempRoot());
    const reconciliation = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-mixed-capture',
      appVersion: '1.0.0',
      prepareProjection: false,
      directStorage: true,
    });
    expect(reconciliation.bundle.files.map((file) => file.relativePath)).toEqual(
      capture.manifest.files.map((file) => file.path)
    );
    for (const [path, bytes] of [
      ['notes.txt', notes],
      ['preview.png', image],
    ] as const) {
      const file = reconciliation.bundle.files.find((entry) => entry.relativePath === path)!;
      expect(file).toMatchObject({ kind: 'workspace-resource', encoding: 'blob', content: '' });
      await verifyWorkspaceSyncBlob(file);
      expect(await readFile(await workspaceSyncBlobPath(file.sha256))).toEqual(bytes);
    }
    await assertWorkspaceSyncSnapshotMatchesCommit(reconciliation, commitOid);
    const preview = await previewWorkspaceSyncUpload(db, {
      workspaceUuid: 'workspace-mixed-capture',
    });
    expect(preview.includedFileCount).toBe(capture.includedFileCount);
    expect(preview.statusExcludedSummary).toEqual(capture.statusExcludedSummary);

    const legacy = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-mixed-capture',
      appVersion: '0.9.3',
      prepareProjection: false,
    });
    expect(legacy.bundle.files.map((file) => file.relativePath)).toEqual(['sample.gb']);
    expect(legacy.statusExcludedSummary).toMatchObject({
      unsupportedCount: 3,
      privateRawDataCount: 1,
    });
  });

  it('admits a resources-only manifest while enforcing the shared file-count limit', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'a-notes.txt'), 'UTF-8 notes: α\n');
    await writeFile(join(root, 'b-image.png'), Buffer.from([0x89, 0xff, 0x00]));
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-only-resources',
      name: 'Resources',
      path: root,
    });
    const input = {
      workspaceUuid: 'workspace-only-resources',
      appVersion: '0.9.3',
      prepareProjection: false,
    };
    expect((await buildWorkspaceSyncUploadCapture(db, input)).includedFileCount).toBe(2);
    const limitedInput = {
      ...input,
      storagePolicy: { ...TEST_STORAGE_POLICY, maxFiles: 1 },
    };
    const capture = await buildWorkspaceSyncUploadCapture(db, limitedInput);
    expect(capture.manifest.files.map((file) => file.path)).toEqual(['a-notes.txt']);
    expect(capture.statusExcludedSummary.bundleTooLargeCount).toBe(1);
    const preview = await previewWorkspaceSyncUpload(db, limitedInput);
    expect(preview.includedFileCount).toBe(1);
    expect(preview.statusExcludedSummary).toEqual(capture.statusExcludedSummary);
  });

  it('rejects invalid UTF-8 in an ordinary text resource before publication', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'notes.txt'), Buffer.from([0xff, 0xfe]));
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-invalid-text', name: 'Invalid', path: root });
    await expect(
      buildWorkspaceSyncUploadCapture(db, {
        workspaceUuid: 'workspace-invalid-text',
        appVersion: '0.9.3',
        prepareProjection: false,
      })
    ).rejects.toMatchObject({ code: 'INVALID_TEXT_ENCODING' });
  });

  it('captures a single 50 MiB admitted FASTA without embedding its bytes', async () => {
    const root = await tempRoot();
    const sourcePath = join(root, 'large.fasta');
    const bytes = Buffer.alloc(50 * 1024 * 1024, 0x41);
    bytes.write('>large\n', 0, 'utf8');
    bytes[bytes.length - 1] = 0x0a;
    await writeFile(sourcePath, bytes);
    await initManagedRepo(root);
    const commitOid = await commitAllIfDirty(root, 'single large streamed upload');
    if (!commitOid) throw new Error('Expected a managed commit for the large upload.');
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-single-large-upload',
      name: 'Single large upload',
      path: root,
    });

    const capture = await buildWorkspaceSyncUploadCapture(db, {
      workspaceUuid: 'workspace-single-large-upload',
      appVersion: '0.9.3',
      capturedAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    expect(capture.manifest.files).toEqual([
      {
        path: 'large.fasta',
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        contentType: 'text/plain',
      },
    ]);
    expect(capture.fileSources.get('large.fasta')).toBe(sourcePath);
    expect(Buffer.byteLength(JSON.stringify(capture.manifest), 'utf8')).toBeLessThan(1024);
    expect(capture.excludedSummary['file-too-large'].count).toBe(0);
    const readBlob = vi
      .spyOn(git, 'readBlob')
      .mockRejectedValue(
        new Error('Full Git blob reads are not allowed during streamed verification')
      );
    try {
      await expect(
        assertWorkspaceSyncUploadCaptureMatchesCommit(capture, commitOid)
      ).resolves.toBeUndefined();
      expect(readBlob).not.toHaveBeenCalled();
    } finally {
      readBlob.mockRestore();
    }
    const preview = await previewWorkspaceSyncUpload(db, {
      workspaceUuid: 'workspace-single-large-upload',
    });
    expect(preview.includedFiles).toEqual([
      expect.objectContaining({ relativePath: 'large.fasta', sizeBytes: bytes.length }),
    ]);
    expect(preview.excludedSummary['file-too-large'].count).toBe(0);
    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-single-large-upload',
        appVersion: '0.9.3',
      })
    ).rejects.toMatchObject({ code: 'NO_INCLUDED_FILES' });
  });

  it('keeps parsed workspace metadata bounded while admitting streamed payloads', async () => {
    const root = await tempRoot();
    const metadata = join(root, NATIVE_WORKSPACE_MANIFEST_PATH);
    await mkdir(dirname(metadata), { recursive: true });
    await writeFile(metadata, '');
    await truncate(metadata, DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS.maxFileBytes + 1);
    await writeFile(join(root, 'plasmid.gb'), genbank('pUC19'), 'utf8');
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-bounded-metadata',
      name: 'Bounded metadata',
      path: root,
    });
    await expect(
      buildWorkspaceSyncUploadCapture(db, {
        workspaceUuid: 'workspace-bounded-metadata',
        appVersion: '0.9.3',
        prepareProjection: false,
      })
    ).rejects.toThrow('Native workspace catalog is not a bounded regular file');
  });

  it('never includes unrelated workspace or global LIMS bytes in a project bundle', async () => {
    const projectRoot = await tempRoot();
    const otherRoot = await tempRoot();
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-private-a',
      name: 'Private A',
      path: projectRoot,
    });
    seedWorkspace(db, {
      id: 2,
      repoUuid: 'workspace-private-b',
      name: 'Private B',
      path: otherRoot,
    });
    await writeFile(join(projectRoot, 'project-a.gb'), genbank('project-a'), 'utf8');
    registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Workspace A primer',
      workspaceId: 1,
      fields: {
        sequence: { mode: 'inline', bases: 'ACACACACACACACACA', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Workspace B secret primer',
      workspaceId: 2,
      fields: {
        sequence: { mode: 'inline', bases: 'TGTGTGTGTGTGTGTGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    const historicalGlobal = registerLimsEntityInDb(db, {
      workspaceId: 2,
      kind: 'oligo',
      name: 'Global secret primer',
      fields: {
        sequence: { mode: 'inline', bases: 'GGGGAAAACCCCTTTTG', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    db.prepare('UPDATE lims_entity SET workspace_id = NULL WHERE id = ?').run(historicalGlobal.id);
    materializeLimsGitReadableExportInDb(db, { workspaceRoot: projectRoot });

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-private-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-08-26T00:00:00.000Z'),
    });
    const bundleBytes = JSON.stringify(snapshot.bundle);

    expect(
      snapshot.bundle.files.every((file) => !file.relativePath.startsWith('.waypoint/lims/'))
    ).toBe(true);
    expect(bundleBytes).not.toContain('Workspace A primer');
    expect(bundleBytes).not.toContain('ACACACACACACACACA');
    expect(bundleBytes).not.toContain('Workspace B secret primer');
    expect(bundleBytes).not.toContain('TGTGTGTGTGTGTGTGT');
    expect(bundleBytes).not.toContain('Global secret primer');
    expect(bundleBytes).not.toContain('GGGGAAAACCCCTTTTG');
    expect(snapshot.statusExcludedSummary).toEqual({
      ignoredCount: 0,
      unsupportedCount: 0,
      privateRawDataCount: 0,
      referencePointerCount: 0,
      fileTooLargeCount: 0,
      bundleTooLargeCount: 0,
    });
  });

  it('never captures package transaction scratch or quarantined recovery data', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'stable.gb'), genbank('stable'), 'utf8');
    for (const directory of [
      '.pUC19.staging-1700000000000-a1b2c3d4',
      '.pUC19.previous-1700000000000-a1b2c3d4',
      '.pUC19.recovery-1700000000001-e5f6a7b8',
    ]) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, 'only-copy.gb'), genbank('recovery'), 'utf8');
    }
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-package-recovery',
      name: 'Package recovery',
      path: root,
    });

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-package-recovery',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-08-25T00:00:00.000Z'),
    });

    const paths = snapshot.bundle.files.map((file) => file.relativePath);
    expect(paths).toContain('stable.gb');
    expect(paths.every((path) => !/\.(?:staging|previous|recovery)-/u.test(path))).toBe(true);
  });

  it('keeps a .gbff plasmid product and its hidden package record together', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'Chromosome IV');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await writeFile(join(packageRoot, 'Chromosome IV.gbff'), genbank('chrIV'), 'utf8');
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'plasmid-chriv',
          name: 'Chromosome IV',
          product: { file: 'Chromosome IV.gbff', topology: 'linear' },
          updatedAt: '2026-07-26T00:00:00.000Z',
        })
      ),
      'utf8'
    );
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-gbff', name: 'GBFF', path: root });

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-gbff',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-26T00:00:00.000Z'),
    });

    expect(snapshot.bundle.files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining([
        'Chromosome IV/.forge/plasmid.json',
        'Chromosome IV/Chromosome IV.gbff',
      ])
    );
  });

  it('backs up a sequence package produced by managed workspace import without exclusions', async () => {
    const sourceRoot = await tempRoot();
    const managedRoot = await tempRoot();
    await writeFile(join(sourceRoot, 'pUC19.gb'), genbank('pUC19'), 'utf8');

    const imported = await importIntoManagedWorkspaceRepo(sourceRoot, {
      db,
      managedRootDir: managedRoot,
    });
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: imported.workspaceUuid,
      appVersion: '0.8.2',
      capturedAt: new Date('2026-08-29T00:00:00.000Z'),
    });

    expect(snapshot.statusExcludedSummary).toEqual({
      ignoredCount: 0,
      unsupportedCount: 0,
      privateRawDataCount: 0,
      referencePointerCount: 0,
      fileTooLargeCount: 0,
      bundleTooLargeCount: 0,
    });
    expect(snapshot.bundle.files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining(['pUC19/.forge/plasmid.json', 'pUC19/pUC19.gb'])
    );
  });

  it('atomically includes every declared package member and preserves opaque binary bytes', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pRoundTrip');
    const binaryBytes = Buffer.from([0xff, 0x00, 0x80, 0x44]);
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await mkdir(join(packageRoot, 'contents'), { recursive: true });
    await writeFile(join(packageRoot, 'pRoundTrip.gb'), genbank('pRoundTrip'), 'utf8');
    await writeFile(join(packageRoot, 'contents', 'calibration.bin'), binaryBytes);
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'sequence-roundtrip-id',
          name: 'pRoundTrip',
          product: { file: 'pRoundTrip.gb', topology: 'circular' },
          members: [
            {
              id: 'member-binary',
              role: 'user',
              path: 'contents/calibration.bin',
              replaceable: false,
              createdAt: '2026-08-27T00:00:00.000Z',
              mediaType: 'application/octet-stream',
            },
          ],
          updatedAt: '2026-08-27T00:00:00.000Z',
        })
      ),
      'utf8'
    );
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-package-members',
      name: 'Package members',
      path: root,
    });

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-package-members',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-08-27T00:00:00.000Z'),
    });

    expect(snapshot.bundle.files.map((file) => file.relativePath)).toEqual([
      'pRoundTrip/.forge/plasmid.json',
      'pRoundTrip/contents/calibration.bin',
      'pRoundTrip/pRoundTrip.gb',
    ]);
    const binary = snapshot.bundle.files.find(
      (file) => file.relativePath === 'pRoundTrip/contents/calibration.bin'
    );
    expect(binary).toMatchObject({
      kind: 'assembly-sidecar',
      contentType: 'application/octet-stream',
      encoding: 'base64',
    });
    expect(binary && Buffer.from(decodeBundleFileContent(binary))).toEqual(binaryBytes);
  });

  it.each([
    ['v1-imported', 'fixture-v1-imported'],
    ['v2-finalized', 'fixture-v2-finalized'],
    ['v3-aligned', 'fixture-v3-aligned'],
  ])('captures and fresh-restores the historical %s sequence package', async (fixture, id) => {
    const root = await tempRoot();
    const packageRoot = join(root, 'Historical package');
    const fixtureRoot = join(
      process.cwd(),
      'src',
      'db',
      '__fixtures__',
      'sequence-packages',
      fixture
    );
    await cp(fixtureRoot, packageRoot, { recursive: true });
    seedWorkspace(db, {
      id: 1,
      repoUuid: `workspace-${fixture}`,
      name: `Historical ${fixture}`,
      path: root,
    });

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: `workspace-${fixture}`,
      appVersion: '0.4.0',
      capturedAt: new Date('2026-08-28T00:00:00.000Z'),
    });
    const marker = snapshot.bundle.files.find(
      (file) => file.relativePath === 'Historical package/.forge/plasmid.json'
    );
    expect(marker && Buffer.from(decodeBundleFileContent(marker))).toEqual(
      await readFile(join(fixtureRoot, '.forge', 'plasmid.json'))
    );

    const restoredRoot = await tempRoot();
    for (const file of snapshot.bundle.files) {
      const destination = join(restoredRoot, file.relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, decodeBundleFileContent(file));
    }
    const restored = await loadSequencePackageDocument(
      join(restoredRoot, 'Historical package'),
      nodeSequencePackageIoForTest()
    );
    expect(restored).toMatchObject({ id, formatVersion: SEQUENCE_PACKAGE_FORMAT_VERSION });
  });

  it('reports a missing declared package member instead of publishing a partial package', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pIncomplete');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await writeFile(join(packageRoot, 'pIncomplete.gb'), genbank('pIncomplete'), 'utf8');
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'sequence-incomplete-id',
          name: 'pIncomplete',
          product: { file: 'pIncomplete.gb' },
          members: [
            {
              id: 'missing-member',
              role: 'user',
              path: 'contents/missing.bin',
              replaceable: false,
              createdAt: '2026-08-27T00:00:00.000Z',
            },
          ],
        })
      ),
      'utf8'
    );
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-incomplete', name: 'Incomplete', path: root });

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-incomplete',
        appVersion: '0.4.0',
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_AUTHORITATIVE_STATE',
      message: expect.stringContaining('contents/missing.bin'),
    });
  });

  it('rejects a symlink-backed plasmid product instead of laundering it into portable authority', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'Linked construct');
    const backingRoot = join(root, 'backing');
    const productContent = genbank('linked');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await mkdir(backingRoot, { recursive: true });
    await writeFile(join(backingRoot, 'linked.source'), productContent, 'utf8');
    await symlink('../backing/linked.source', join(packageRoot, 'Linked construct.gb'));
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'plasmid-linked',
          name: 'Linked construct',
          product: { file: 'Linked construct.gb' },
          updatedAt: '2026-07-27T00:00:00.000Z',
        })
      ),
      'utf8'
    );
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-linked', name: 'Linked', path: root });

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-linked',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-07-27T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_AUTHORITATIVE_STATE',
      message: expect.stringContaining('symbolic link'),
    });
  });

  it('rejects a package member beneath a symlinked directory', async () => {
    const root = await tempRoot();
    const outsideRoot = await tempRoot();
    const packageRoot = join(root, 'Linked contents');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await writeFile(join(packageRoot, 'Linked contents.gb'), genbank('linked-contents'), 'utf8');
    await writeFile(join(outsideRoot, 'member.bin'), Buffer.from([0xff, 0x00, 0x80]));
    await symlink(outsideRoot, join(packageRoot, 'contents'));
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'plasmid-linked-contents',
          name: 'Linked contents',
          product: { file: 'Linked contents.gb' },
          members: [
            {
              id: 'linked-member',
              role: 'user',
              path: 'contents/member.bin',
              replaceable: false,
              createdAt: '2026-08-28T00:00:00.000Z',
            },
          ],
        })
      ),
      'utf8'
    );
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-linked-contents',
      name: 'Linked contents',
      path: root,
    });

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-linked-contents',
        appVersion: '0.4.0',
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_AUTHORITATIVE_STATE',
      message: expect.stringContaining('unsafe directory ancestor'),
    });
  });

  it('reports a future package format as unsupported authoritative state', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'Future construct');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await writeFile(join(packageRoot, 'Future construct.gb'), genbank('future'), 'utf8');
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      `${JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'sequence',
        formatVersion: 999,
        id: 'sequence-future-id',
        name: 'Future construct',
        updatedAt: '2026-08-27T00:00:00.000Z',
        product: { file: 'Future construct.gb' },
        members: [],
      })}\n`,
      'utf8'
    );
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-future', name: 'Future', path: root });

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-future',
        appVersion: '0.4.0',
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_AUTHORITATIVE_STATE',
      message: expect.stringContaining('formatVersion 999'),
    });
  });

  it('rejects duplicate stable sequence ids before publishing an ambiguous snapshot', async () => {
    const root = await tempRoot();
    for (const packageName of ['First construct', 'Renamed copy']) {
      const packageRoot = join(root, packageName);
      await mkdir(join(packageRoot, '.forge'), { recursive: true });
      await writeFile(join(packageRoot, `${packageName}.gb`), genbank(packageName), 'utf8');
      await writeFile(
        join(packageRoot, '.forge', 'plasmid.json'),
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'sequence-duplicate-id',
            name: packageName,
            product: { file: `${packageName}.gb` },
            updatedAt: '2026-08-27T00:00:00.000Z',
          })
        ),
        'utf8'
      );
    }
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-duplicate-sequence-id',
      name: 'Duplicate sequence id',
      path: root,
    });

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-duplicate-sequence-id',
        appVersion: '0.4.0',
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_AUTHORITATIVE_STATE',
      message: expect.stringContaining('duplicate stable id sequence-duplicate-id'),
    });
  });

  it('enforces the sync bundle file-count limit without emitting an invalid bundle', async () => {
    const previous = process.env.DNAFORGE_SYNC_MAX_FILES;
    process.env.DNAFORGE_SYNC_MAX_FILES = '3';
    try {
      const root = await tempRoot();
      seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Many Files', path: root });

      for (let i = 0; i < 4; i += 1) {
        await writeFile(join(root, `plasmid-${i}.gb`), genbank(`p${i}`), 'utf8');
      }

      const snapshot = await buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-a',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-07-08T00:00:00.000Z'),
      });

      expect(snapshot.bundle.files).toHaveLength(3);
      expect(snapshot.bundle.excludedSummary['bundle-too-large'].count).toBeGreaterThanOrEqual(1);
      expect(validateWorkspaceSyncBundle(snapshot.bundle)).toMatchObject({ ok: true });
    } finally {
      if (previous === undefined) delete process.env.DNAFORGE_SYNC_MAX_FILES;
      else process.env.DNAFORGE_SYNC_MAX_FILES = previous;
    }
  });

  it('rejects JSON expansion above a configured encoded upload cap during local capture', async () => {
    const previous = process.env.DNAFORGE_SYNC_MAX_ENCODED_BUNDLE_BYTES;
    process.env.DNAFORGE_SYNC_MAX_ENCODED_BUNDLE_BYTES = '40000000';
    try {
      const root = await tempRoot();
      seedWorkspace(db, { id: 1, repoUuid: 'workspace-escaped', name: 'Escaped', path: root });
      const rawBytes = Math.floor(DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS.maxFileBytes * 0.75);
      await writeFile(join(root, 'quoted.gb'), '"'.repeat(rawBytes), 'utf8');

      await expect(
        buildWorkspaceSyncSnapshot(db, {
          workspaceUuid: 'workspace-escaped',
          appVersion: '0.4.0',
          capturedAt: new Date('2026-07-08T00:00:00.000Z'),
        })
      ).rejects.toMatchObject({
        code: 'INVALID_BUNDLE',
        message: expect.stringContaining('encoded-bundle limit'),
      });
    } finally {
      if (previous === undefined) delete process.env.DNAFORGE_SYNC_MAX_ENCODED_BUNDLE_BYTES;
      else process.env.DNAFORGE_SYNC_MAX_ENCODED_BUNDLE_BYTES = previous;
    }
  });

  it('rejects invalid UTF-8 scientific bytes instead of replacing them', async () => {
    const root = await tempRoot();
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-bytes', name: 'Bytes', path: root });
    await writeFile(join(root, 'annotation.gb'), Buffer.from([0x4c, 0x4f, 0x43, 0x55, 0x53, 0xff]));

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-bytes',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-07-08T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({
      code: 'INVALID_TEXT_ENCODING',
      message: expect.stringContaining('annotation.gb'),
    });
  });

  it('keeps filesystem activity acquired while streaming committed snapshot bytes', async () => {
    const root = await tempRoot();
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-activity', name: 'Activity', path: root });
    await initManagedRepo(root);
    await writeFile(join(root, 'design.gb'), genbank('committed'), 'utf8');
    const commitOid = await commitAllIfDirty(root, 'initial managed state');
    if (!commitOid) throw new Error('Expected a managed commit for the activity test.');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-activity',
      appVersion: '0.4.0',
      prepareProjection: false,
    });
    let active = 0;
    const activeDuringReads: number[] = [];
    const readLoose = blobIdentity.readLooseBlobContentIdentity;
    const readSpy = vi
      .spyOn(blobIdentity, 'readLooseBlobContentIdentity')
      .mockImplementation(async (...args) => {
        activeDuringReads.push(active);
        return readLoose(...args);
      });
    setActiveFilesystemWorkGuard(() => {
      active += 1;
      return () => {
        active -= 1;
      };
    });
    try {
      await assertWorkspaceSyncSnapshotMatchesCommit(snapshot, commitOid);
      expect(activeDuringReads.length).toBeGreaterThan(0);
      expect(activeDuringReads.every((count) => count > 0)).toBe(true);
      expect(active).toBe(0);
    } finally {
      readSpy.mockRestore();
      setActiveFilesystemWorkGuard(undefined);
    }
  });

  it('rejects captured bytes that do not belong to the Git commit named by the upload', async () => {
    const root = await tempRoot();
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-commit', name: 'Commit', path: root });
    await initManagedRepo(root);
    await writeFile(join(root, 'design.gb'), genbank('committed'), 'utf8');
    await commitAllIfDirty(root, 'initial managed state');
    const commitOid = await resolveHeadCommit(root);
    if (!commitOid) throw new Error('Expected a managed commit for the snapshot test.');

    const committedSnapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-commit',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-08T00:00:00.000Z'),
      prepareProjection: false,
    });
    await expect(
      assertWorkspaceSyncSnapshotMatchesCommit(committedSnapshot, commitOid)
    ).resolves.toBeUndefined();

    await writeFile(join(root, 'design.gb'), genbank('uncommitted'), 'utf8');
    const dirtySnapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-commit',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-08T00:00:00.000Z'),
      prepareProjection: false,
    });
    await expect(
      assertWorkspaceSyncSnapshotMatchesCommit(dirtySnapshot, commitOid)
    ).rejects.toThrow('Workspace sync file changed outside commit');
  });

  it('checks the captured SHA-256 against actual bytes in the named commit', async () => {
    const root = await tempRoot();
    const source = join(root, 'design.gb');
    seedWorkspace(db, { id: 1, repoUuid: 'manifest-commit', name: 'Commit', path: root });
    await initManagedRepo(root);
    await writeFile(source, genbank('committed-A'));
    const original = await commitAllIfDirty(root, 'original');
    if (!original) throw new Error('Expected an original commit.');
    const captureInput = {
      workspaceUuid: 'manifest-commit',
      appVersion: '0.9.3',
      prepareProjection: false,
    };
    const captured = await buildWorkspaceSyncUploadCapture(db, captureInput);
    await expect(
      assertWorkspaceSyncUploadCaptureMatchesCommit(captured, original)
    ).resolves.toBeUndefined();

    await writeFile(source, genbank('committed-B'));
    const changedAt = new Date(Date.now() + 2000);
    await utimes(source, changedAt, changedAt);
    const dirty = await buildWorkspaceSyncUploadCapture(db, captureInput);
    await expect(assertWorkspaceSyncUploadCaptureMatchesCommit(dirty, original)).rejects.toThrow(
      'Workspace sync file changed outside commit'
    );

    await expect(
      assertWorkspaceSyncUploadCaptureMatchesCommit(captured, original)
    ).resolves.toBeUndefined();
    const current = await commitAllIfDirty(root, 'changed source');
    if (!current) throw new Error('Expected a changed commit.');

    await expect(assertWorkspaceSyncUploadCaptureMatchesCommit(captured, current)).rejects.toThrow(
      'Workspace sync file changed outside commit'
    );
    await expect(
      assertWorkspaceSyncUploadCaptureMatchesCommit(dirty, current)
    ).resolves.toBeUndefined();

    await writeFile(join(root, 'untracked.gb'), genbank('untracked'));
    const untracked = await buildWorkspaceSyncUploadCapture(db, captureInput);
    await expect(assertWorkspaceSyncUploadCaptureMatchesCommit(untracked, current)).rejects.toThrow(
      'Workspace sync file cannot be verified in commit'
    );
  });

  it('projects notebook packages but excludes installation-global LIMS from sync', async () => {
    const root = await tempRoot();
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Projected', path: root });
    await writeFile(join(root, 'plasmid.gb'), genbank('pUC19'), 'utf8');

    const pageId = 'page-notebook-1';
    const packageRoot = join(root, 'Lab notes');
    db.prepare(
      `INSERT INTO pages (id, title, content, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`
    ).run(
      pageId,
      'STALE SQLITE TITLE',
      JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'STALE SQLITE CONTENT' }] }],
      })
    );
    db.prepare(
      `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
       VALUES (?, 'notebook', 'Lab notes', ?, 'file', 'active', 1, NULL, 1, 1)`
    ).run(pageId, `notebook:${pageId}`);
    db.prepare(
      `INSERT INTO catalog_entity_files
       (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash, size_bytes,
        modified_at, status, last_seen_at, missing_since, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'Lab notes', 'waypoint-notebook', NULL, 0, 1, 'current', 1, NULL, 1, 1)`
    ).run(`file-${pageId}`, pageId, packageRoot);

    const canonical = serializeNotebookMarkdown({
      identity: { id: pageId, title: 'Lab notes', formatVersion: 2 },
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'CANONICAL MARKDOWN CONTENT' }] },
        ],
      },
    });
    await mkdir(join(packageRoot, '.forge', 'blocks'), { recursive: true });
    await mkdir(join(packageRoot, 'assets'), { recursive: true });
    await writeFile(join(packageRoot, 'Lab notes.md'), canonical.markdown, 'utf8');
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: pageId,
          title: 'Lab notes',
          markdownFileName: 'Lab notes.md',
          updatedAt: '2026-08-25T00:00:00.000Z',
        })
      ),
      'utf8'
    );
    for (const payload of canonical.payloads) {
      await writeFile(join(packageRoot, payload.relativePath), payload.content, 'utf8');
    }
    await writeFile(join(packageRoot, '.forge', 'blocks', 'stale-payload.json'), '{}', 'utf8');
    const binaryAsset = Buffer.from([0xff, 0x00, 0x80]);
    await writeFile(join(packageRoot, 'assets', 'model.bin'), binaryAsset);
    const oversizedAssetPath = join(packageRoot, 'assets', 'oversized.bin');
    await writeFile(oversizedAssetPath, '');
    await truncate(oversizedAssetPath, TEST_STORAGE_POLICY.maxFileBytes + 1);
    await initManagedRepo(root);
    await writeFile(join(root, '.gitignore'), '/Lab notes/assets/oversized.bin\n');
    await commitAllIfDirty(root, 'commit notebook package with binary assets');
    const commitOid = await resolveHeadCommit(root);
    if (!commitOid) throw new Error('Expected a managed commit for the notebook snapshot test.');

    const preview = await previewWorkspaceSyncUpload(db, {
      workspaceUuid: 'workspace-a',
      storagePolicy: TEST_STORAGE_POLICY,
    });
    expect(preview.includedFiles.map((file) => file.relativePath)).not.toContain(
      'Lab notes/assets/oversized.bin'
    );
    expect(preview.excludedSummary['file-too-large'].count).toBeGreaterThanOrEqual(1);

    await truncate(oversizedAssetPath, DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS.maxFileBytes + 1);

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-08T00:00:00.000Z'),
    });

    const paths = snapshot.bundle.files.map((file) => file.relativePath);
    expect(paths).toEqual(
      expect.arrayContaining([
        'plasmid.gb',
        'Lab notes/.forge/notebook.json',
        expect.stringMatching(/^Lab notes\/.forge\/blocks\/.+\.json$/),
        'Lab notes/Lab notes.md',
      ])
    );
    expect(paths.every((path) => !path.startsWith('.waypoint/lims/'))).toBe(true);
    expect(
      snapshot.bundle.files.find((file) => file.relativePath.endsWith('notebook.json'))
    ).toMatchObject({
      kind: 'notebook',
      contentType: 'application/json',
    });
    const markdown = snapshot.bundle.files.find(
      (file) => file.relativePath === 'Lab notes/Lab notes.md'
    );
    expect(markdown?.content).toContain('CANONICAL MARKDOWN CONTENT');
    expect(markdown?.content).not.toContain('STALE SQLITE CONTENT');
    expect(paths).not.toContain('Lab notes/.forge/blocks/stale-payload.json');
    const bundledAsset = snapshot.bundle.files.find(
      (file) => file.relativePath === 'Lab notes/assets/model.bin'
    );
    expect(bundledAsset).toMatchObject({
      encoding: 'base64',
      contentType: 'application/octet-stream',
      sizeBytes: binaryAsset.byteLength,
    });
    expect(Buffer.from(decodeBundleFileContent(bundledAsset!))).toEqual(binaryAsset);
    expect(paths).not.toContain('Lab notes/assets/oversized.bin');
    expect(validateWorkspaceSyncBundle(snapshot.bundle)).toMatchObject({ ok: true });
    await expect(
      assertWorkspaceSyncSnapshotMatchesCommit(snapshot, commitOid)
    ).resolves.toBeUndefined();
  });

  it('excludes a notebook package atomically when its migration archive exceeds limits', async () => {
    const root = await tempRoot();
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-oversized-notebook-archive',
      name: 'Oversized notebook archive',
      path: root,
    });
    const packageRoot = join(root, 'Lab notes');
    const archivePath = join(packageRoot, '.forge', 'migrations', 'legacy.json');
    const canonical = serializeNotebookMarkdown({
      identity: { id: 'page-archive', title: 'Lab notes', formatVersion: 2 },
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    await mkdir(join(packageRoot, '.forge', 'blocks'), { recursive: true });
    await mkdir(join(packageRoot, '.forge', 'migrations'), { recursive: true });
    await writeFile(join(packageRoot, 'Lab notes.md'), canonical.markdown, 'utf8');
    for (const payload of canonical.payloads) {
      await writeFile(join(packageRoot, payload.relativePath), payload.content, 'utf8');
    }
    await writeFile(archivePath, '', 'utf8');
    await truncate(archivePath, TEST_STORAGE_POLICY.maxFileBytes + 1);
    await writeFile(join(root, 'plasmid.gb'), genbank('pUC19'), 'utf8');
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'page-archive',
          title: 'Lab notes',
          markdownFileName: 'Lab notes.md',
          updatedAt: '2026-08-25T00:00:00.000Z',
          migration: {
            fromFormatVersion: 1,
            completedAt: '2026-08-25T00:00:00.000Z',
            archivePath: 'migrations/legacy.json',
            sourceShape: 'v1-package',
          },
        })
      ),
      'utf8'
    );

    const preview = await previewWorkspaceSyncUpload(db, {
      workspaceUuid: 'workspace-oversized-notebook-archive',
      storagePolicy: TEST_STORAGE_POLICY,
    });

    expect(preview.includedFiles.map((file) => file.relativePath)).toEqual(['plasmid.gb']);
    expect(preview.excludedSummary['file-too-large'].count).toBe(1);

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-oversized-notebook-archive',
      appVersion: '0.4.0',
      directStorage: true,
      storagePolicy: TEST_STORAGE_POLICY,
    });
    expect(snapshot.bundle.files.map((file) => file.relativePath)).toEqual(['plasmid.gb']);
    expect(snapshot.excludedSummary['file-too-large'].count).toBeGreaterThanOrEqual(1);
  });

  it('does not grant upload authority to an unrelated assets directory', async () => {
    const root = await tempRoot();
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-assets', name: 'Assets', path: root });
    await mkdir(join(root, 'unrelated', 'assets'), { recursive: true });
    await writeFile(join(root, 'plasmid.gb'), genbank('pUC19'), 'utf8');
    await writeFile(
      join(root, 'unrelated', 'assets', 'private-canary.bin'),
      Buffer.from([0x49, 0x4e, 0x45, 0x52, 0x54])
    );

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-assets',
      appVersion: '0.4.0',
    });

    expect(snapshot.bundle.files.map((file) => file.relativePath)).not.toContain(
      'unrelated/assets/private-canary.bin'
    );
  });

  it('snapshots the current portable catalog while excluding private migration state and unrelated markers', async () => {
    const root = await tempRoot();
    seedWorkspace(db, { id: 1, repoUuid: 'native-catalog', name: 'Native', path: root });
    await mkdir(join(root, '.forge'), { recursive: true });
    await mkdir(join(root, 'other/.forge'), { recursive: true });
    await mkdir(join(root, '.dnaforge/migration'), { recursive: true });
    const manifest = JSON.stringify({
      schema: 'dnaforge.native-workspace-manifest.v2',
      entities: [
        {
          id: 'native-sequence',
          type: 'sequence',
          name: 'YEN1',
          placement: { kind: 'file', relativePath: 'YEN1.gb', fileKind: 'genbank' },
        },
      ],
      links: [],
    });
    await writeFile(join(root, '.forge/catalog.json'), manifest);
    await writeFile(join(root, 'other/.forge/catalog.json'), manifest);
    await writeFile(
      join(root, '.dnaforge/migration/source.json'),
      JSON.stringify({ sourcePath: '/private/source.zip' })
    );
    const publicationRoot = join(root, '.dnaforge/migration/catalog-publications/test-operation');
    await mkdir(publicationRoot, { recursive: true });
    for (const filename of [
      'publication.json',
      'before.json',
      'after.json',
      'install.json',
      'complete',
      'after.json.interrupted.pending',
    ]) {
      await writeFile(
        join(publicationRoot, filename),
        JSON.stringify({ privateHistoricalRecord: 'retained-for-local-recovery' })
      );
    }
    await writeFile(join(root, 'YEN1.gb'), genbank('YEN1'));
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'native-catalog',
      appVersion: 'test',
    });
    expect(snapshot.bundle.files.map((file) => file.relativePath)).toEqual([
      '.forge/catalog.json',
      'YEN1.gb',
    ]);
    const catalog = snapshot.bundle.files.find(
      (file) => file.relativePath === '.forge/catalog.json'
    )!;
    expect(Buffer.from(decodeBundleFileContent(catalog)).toString('utf8')).toBe(manifest);
    expect(JSON.stringify(snapshot.bundle)).not.toContain('/private/source.zip');
    expect(JSON.stringify(snapshot.bundle)).not.toContain('retained-for-local-recovery');
    await writeFile(join(root, '.forge/catalog.json'), '{"schema":"invalid"}');
    await expect(
      buildWorkspaceSyncSnapshot(db, { workspaceUuid: 'native-catalog', appVersion: 'test' })
    ).rejects.toThrow(/manifest|catalog/i);
  });

  it.each(['assets', '.forge/blocks', '.forge/migrations'])(
    'rejects a notebook whose managed %s directory is a symlink outside the workspace',
    async (managedDirectory) => {
      const root = await tempRoot();
      const outside = await tempRoot();
      seedWorkspace(db, {
        id: 1,
        repoUuid: `workspace-symlink-${managedDirectory}`,
        name: 'Symlink notebook',
        path: root,
      });
      const packageRoot = join(root, 'Lab notes');
      const canonical = serializeNotebookMarkdown({
        identity: { id: 'page-symlink', title: 'Lab notes', formatVersion: 2 },
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
      });
      await mkdir(join(packageRoot, '.forge'), { recursive: true });
      await mkdir(join(packageRoot, managedDirectory, '..'), { recursive: true });
      await writeFile(join(outside, 'private-canary.txt'), 'private canary', 'utf8');
      await symlink(outside, join(packageRoot, managedDirectory), 'dir');
      await writeFile(join(packageRoot, 'Lab notes.md'), canonical.markdown, 'utf8');
      await writeFile(
        join(packageRoot, '.forge', 'notebook.json'),
        serializeNotebookPackageMetadata(
          buildNotebookPackageMetadata({
            id: 'page-symlink',
            title: 'Lab notes',
            markdownFileName: 'Lab notes.md',
            updatedAt: '2026-08-25T00:00:00.000Z',
          })
        ),
        'utf8'
      );

      await expect(
        buildWorkspaceSyncSnapshot(db, {
          workspaceUuid: `workspace-symlink-${managedDirectory}`,
          appVersion: '0.4.0',
        })
      ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    }
  );

  it('rejects the transitional state where legacy and v2 notebook authorities coexist', async () => {
    const root = await tempRoot();
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-dual-notebook',
      name: 'Dual notebook',
      path: root,
    });
    const packageRoot = join(root, 'Lab notes');
    const canonical = serializeNotebookMarkdown({
      identity: { id: 'page-dual', title: 'Lab notes', formatVersion: 2 },
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    await mkdir(join(packageRoot, '.forge', 'migrations'), { recursive: true });
    await writeFile(join(packageRoot, 'Lab notes.md'), canonical.markdown, 'utf8');
    await writeFile(join(packageRoot, '.forge', 'migrations', 'legacy.json'), '{}', 'utf8');
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'page-dual',
          title: 'Lab notes',
          markdownFileName: 'Lab notes.md',
          updatedAt: '2026-08-25T00:00:00.000Z',
          migration: {
            fromFormatVersion: 1,
            completedAt: '2026-08-25T00:00:00.000Z',
            archivePath: 'migrations/legacy.json',
            sourceShape: 'legacy-wpnote',
          },
        })
      ),
      'utf8'
    );
    await writeFile(
      join(root, 'old-copy.wpnote.json'),
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-dual',
        title: 'Old copy',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        storage: { type: 'database', table: 'pages', id: 'page-dual' },
        updatedAt: '2026-08-24T00:00:00.000Z',
      }),
      'utf8'
    );

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-dual-notebook',
        appVersion: '0.4.0',
      })
    ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
  });

  it('rejects duplicate portable notebook ids before creating an unrestorable upload', async () => {
    const root = await tempRoot();
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-duplicate-notebooks',
      name: 'Duplicate notebooks',
      path: root,
    });
    await writeV2NotebookPackageFixture(root, 'Notebook A', 'shared-portable-id');
    await writeV2NotebookPackageFixture(root, 'Notebook B', 'shared-portable-id');

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-duplicate-notebooks',
        appVersion: '0.4.0',
      })
    ).rejects.toMatchObject({
      code: 'INVALID_BUNDLE',
      message: expect.stringContaining('duplicate notebook id shared-portable-id'),
    });
  });

  it('rejects a portable notebook id shared by a v2 package and a loose legacy file', async () => {
    const root = await tempRoot();
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-mixed-duplicate-notebooks',
      name: 'Mixed duplicate notebooks',
      path: root,
    });
    await writeV2NotebookPackageFixture(root, 'Notebook package', 'shared-mixed-id');
    await mkdir(join(root, 'archive'), { recursive: true });
    await writeFile(
      join(root, 'archive', 'old.wpnote.json'),
      legacyNotebookFile('shared-mixed-id', 'Old loose notebook'),
      'utf8'
    );

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-mixed-duplicate-notebooks',
        appVersion: '0.4.0',
      })
    ).rejects.toMatchObject({
      code: 'INVALID_BUNDLE',
      message: expect.stringContaining('duplicate notebook id shared-mixed-id'),
    });
  });

  it('rejects marked notebook Markdown when the entire .forge directory is missing', async () => {
    const root = await tempRoot();
    seedWorkspace(db, {
      id: 1,
      repoUuid: 'workspace-orphan-notebook-markdown',
      name: 'Orphan notebook Markdown',
      path: root,
    });
    const packageRoot = join(root, 'Orphan notebook');
    const canonical = serializeNotebookMarkdown({
      identity: { id: 'orphan-page', title: 'Orphan notebook', formatVersion: 2 },
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'Orphan notebook.md'), canonical.markdown, 'utf8');

    await expect(
      previewWorkspaceSyncUpload(db, {
        workspaceUuid: 'workspace-orphan-notebook-markdown',
      })
    ).rejects.toMatchObject({
      code: 'INVALID_BUNDLE',
      message: expect.stringContaining('missing its package metadata'),
    });
    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-orphan-notebook-markdown',
        appVersion: '0.4.0',
      })
    ).rejects.toMatchObject({
      code: 'INVALID_BUNDLE',
      message: expect.stringContaining('missing its package metadata'),
    });

    const lateMarker = serializeNotebookMarkdown({
      identity: { id: 'orphan-page', title: 'Orphan notebook', formatVersion: 2 },
      preservedPreamble: 'A'.repeat(DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS.maxFileBytes + 128),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    await writeFile(join(packageRoot, 'Orphan notebook.md'), lateMarker.markdown, 'utf8');
    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-orphan-notebook-markdown',
        appVersion: '0.4.0',
      })
    ).rejects.toMatchObject({
      code: 'INVALID_BUNDLE',
      message: expect.stringContaining('missing its package metadata'),
    });
  });

  it.each(['nested-v2', 'nested-legacy-asset'] as const)(
    'refuses to produce a snapshot containing %s notebook authority',
    async (nestedShape) => {
      const root = await tempRoot();
      seedWorkspace(db, {
        id: 1,
        repoUuid: `workspace-${nestedShape}`,
        name: 'Nested authority',
        path: root,
      });
      await writeV2NotebookPackageFixture(root, 'Outer', 'outer-page');
      if (nestedShape === 'nested-v2') {
        await writeV2NotebookPackageFixture(join(root, 'Outer'), 'Inner', 'inner-page');
      } else {
        await mkdir(join(root, 'Outer', 'assets'), { recursive: true });
        await writeFile(
          join(root, 'Outer', 'assets', 'old.wpnote.json'),
          legacyNotebookFile('inner-page', 'Inner'),
          'utf8'
        );
      }

      await expect(
        buildWorkspaceSyncSnapshot(db, {
          workspaceUuid: `workspace-${nestedShape}`,
          appVersion: '0.4.0',
        })
      ).rejects.toMatchObject({
        code: 'INVALID_BUNDLE',
        message: expect.stringMatching(/nested notebook/i),
      });
    }
  );

  it.each(['missing-markdown', 'missing-payload', 'malformed-markdown'] as const)(
    'refuses an unrestorable v2 notebook package with %s',
    async (failure) => {
      const root = await tempRoot();
      seedWorkspace(db, {
        id: 1,
        repoUuid: `workspace-invalid-${failure}`,
        name: 'Invalid notebook',
        path: root,
      });
      const packageRoot = join(root, 'Lab notes');
      await mkdir(join(packageRoot, '.forge'), { recursive: true });
      await writeFile(
        join(packageRoot, '.forge', 'notebook.json'),
        serializeNotebookPackageMetadata(
          buildNotebookPackageMetadata({
            id: 'page-invalid',
            title: 'Lab notes',
            markdownFileName: 'Lab notes.md',
            updatedAt: '2026-08-25T00:00:00.000Z',
          })
        ),
        'utf8'
      );

      if (failure !== 'missing-markdown') {
        const canonical = serializeNotebookMarkdown({
          identity: { id: 'page-invalid', title: 'Lab notes', formatVersion: 2 },
          content:
            failure === 'missing-payload'
              ? {
                  type: 'doc',
                  content: [{ type: 'unsupported-inert-canary', attrs: { value: 1 } }],
                }
              : {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'safe text' }] }],
                },
        });
        if (failure === 'missing-payload') expect(canonical.payloads.length).toBeGreaterThan(0);
        await writeFile(
          join(packageRoot, 'Lab notes.md'),
          failure === 'malformed-markdown'
            ? canonical.markdown.replace('"codecVersion":1', '"codecVersion":999')
            : canonical.markdown,
          'utf8'
        );
      }

      await expect(
        buildWorkspaceSyncSnapshot(db, {
          workspaceUuid: `workspace-invalid-${failure}`,
          appVersion: '0.4.0',
        })
      ).rejects.toMatchObject({ code: 'INVALID_BUNDLE' });
    }
  );

  it('rejects missing, archived, and trashed workspaces', async () => {
    const archivedRoot = await tempRoot();
    const trashedRoot = await tempRoot();
    seedWorkspace(db, {
      id: 2,
      repoUuid: 'archived-a',
      name: 'Archived',
      path: archivedRoot,
      archivedAt: 10,
    });
    seedWorkspace(db, {
      id: 3,
      repoUuid: 'trashed-a',
      name: 'Trashed',
      path: trashedRoot,
      trashedAt: 10,
    });

    for (const workspaceUuid of ['missing-a', 'archived-a', 'trashed-a']) {
      await expect(
        buildWorkspaceSyncSnapshot(db, {
          workspaceUuid,
          appVersion: '0.4.0',
          capturedAt: new Date('2026-07-08T00:00:00.000Z'),
        })
      ).rejects.toBeInstanceOf(WorkspaceSyncSnapshotError);
    }
  });

  it('rejects unsupported-only workspaces instead of using global LIMS as filler', async () => {
    const activeRoot = await tempRoot();
    seedWorkspace(db, { id: 1, repoUuid: 'active-a', name: 'Active', path: activeRoot });
    await writeFile(join(activeRoot, 'only.txt'), 'unsupported', 'utf8');

    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'active-a',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-07-08T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'NO_INCLUDED_FILES' });
  });

  it('previewUpload included paths match a full snapshot of the same tree (A5)', async () => {
    const root = await tempRoot();
    seedWorkspace(db, { id: 1, repoUuid: 'preview-a', name: 'Preview', path: root });
    await writeFile(join(root, MANAGED_WORKSPACE_MARKER), '', 'utf8');
    await writeFile(join(root, 'plasmid.gb'), 'LOCUS pUC19\n', 'utf8');
    await writeFile(join(root, 'skip.fastq'), '@read\nATGC\n+\n!!!!\n', 'utf8');
    const packageRoot = join(root, 'Lab notes');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-preview-1',
        title: 'Lab notes',
        content: { type: 'doc', content: [] },
        updatedAt: new Date().toISOString(),
        storage: { type: 'database', table: 'pages', id: 'page-preview-1' },
      }),
      'utf8'
    );
    await writeFile(join(packageRoot, 'Lab notes.md'), '# Lab notes\n', 'utf8');

    const preview = await previewWorkspaceSyncUpload(db, { workspaceUuid: 'preview-a' });
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'preview-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-08T00:00:00.000Z'),
    });

    expect(preview.includedFiles.map((f) => f.relativePath).sort()).toEqual(
      snapshot.bundle.files.map((f) => f.relativePath).sort()
    );
    expect(preview.includedFileCount).toBe(snapshot.includedFileCount);
    expect(preview.includedBytes).toBe(snapshot.includedBytes);
    expect(
      preview.excludedSummary.unsupported.count + preview.excludedSummary['private-raw-data'].count
    ).toBeGreaterThanOrEqual(1);
    expect(preview.includedFiles.map((f) => f.relativePath)).toEqual(
      expect.arrayContaining([
        'plasmid.gb',
        'Lab notes/.forge/notebook.json',
        'Lab notes/Lab notes.md',
      ])
    );
    expect(preview.includedFiles.map((f) => f.relativePath)).not.toContain('skip.fastq');
  });

  it('queues preview while an exclusive replica mutation owns the workspace', async () => {
    const root = await tempRoot();
    seedWorkspace(db, { id: 1, repoUuid: 'preview-busy', name: 'Busy', path: root });
    const releaseReplica = await acquireWorkspaceSyncMutationLease(root);
    let previewSettled = false;
    const previewing = previewWorkspaceSyncUpload(db, {
      workspaceUuid: 'preview-busy',
    }).finally(() => {
      previewSettled = true;
    });

    await Promise.resolve();
    expect(previewSettled).toBe(false);
    await expect(access(join(root, '.waypoint', 'lims', 'manifest.json'))).rejects.toThrow();

    releaseReplica();
    await expect(previewing).resolves.toBeDefined();
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-snapshot-'));
    rootsForCleanup.push(root);
    await initManagedRepo(root);
    return root;
  }
});

afterEachCleanup();

function afterEachCleanup(): void {
  afterEach(async () => {
    const current = rootsForCleanup.splice(0);
    await Promise.all(current.map((root) => rm(root, { recursive: true, force: true })));
  });
}

const rootsForCleanup: string[] = [];

function seedWorkspace(
  db: Database.Database,
  input: {
    id: number;
    repoUuid: string;
    name: string;
    path: string;
    archivedAt?: number | null;
    trashedAt?: number | null;
  }
): void {
  db.prepare(
    `INSERT INTO workspaces (
      id, name, path, repo_uuid, created_at, last_opened_at, archived_at, trashed_at
    ) VALUES (?, ?, ?, ?, 1, 1, ?, ?)`
  ).run(
    input.id,
    input.name,
    input.path,
    input.repoUuid,
    input.archivedAt ?? null,
    input.trashedAt ?? null
  );
}

function nodeSequencePackageIoForTest() {
  return {
    exists: async (path: string) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    readTextFile: (path: string) => readFile(path, 'utf8'),
    writeTextFile: (path: string, content: string) => writeFile(path, content, 'utf8'),
    writeWorkspaceTextFileAtomic: writeWorkspaceTextFileAtomicInMain,
    mkdir: async (path: string, options?: { recursive?: boolean }) => {
      await mkdir(path, options);
    },
    move: async (sourcePath: string, destinationDir: string) => {
      const destPath = join(destinationDir, basename(sourcePath));
      await rename(sourcePath, destPath);
      return { destPath };
    },
    readFile: (path: string) => readFile(path),
    writeFile: (path: string, contents: Uint8Array) => writeFile(path, contents),
    unlink: (path: string) => unlink(path),
    rename: (from: string, to: string) => rename(from, to),
  };
}

function genbank(name: string): string {
  return `LOCUS       ${name}\nORIGIN\n        1 atgc\n//\n`;
}

async function writeV2NotebookPackageFixture(
  workspaceRoot: string,
  title: string,
  id: string
): Promise<void> {
  const packageRoot = join(workspaceRoot, title);
  const canonical = serializeNotebookMarkdown({
    identity: { id, title, formatVersion: 2 },
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }],
    },
  });
  await mkdir(join(packageRoot, '.forge', 'blocks'), { recursive: true });
  await writeFile(join(packageRoot, `${title}.md`), canonical.markdown, 'utf8');
  for (const payload of canonical.payloads) {
    await writeFile(join(packageRoot, payload.relativePath), payload.content, 'utf8');
  }
  await writeFile(
    join(packageRoot, '.forge', 'notebook.json'),
    serializeNotebookPackageMetadata(
      buildNotebookPackageMetadata({
        id,
        title,
        markdownFileName: `${title}.md`,
        updatedAt: '2026-08-25T00:00:00.000Z',
      })
    ),
    'utf8'
  );
}

function legacyNotebookFile(id: string, title: string): string {
  return `${JSON.stringify({
    schema: 'waypoint.notebook.v1',
    kind: 'notebook',
    id,
    title,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    storage: { type: 'database', table: 'pages', id },
    updatedAt: '2026-08-24T00:00:00.000Z',
  })}\n`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
