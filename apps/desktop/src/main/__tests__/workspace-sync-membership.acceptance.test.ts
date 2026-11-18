import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANAGED_WORKSPACE_MARKER } from '../../shared/workspace-git-types';
import { ensureSchema } from '../schema';
import { initManagedRepo } from '../workspace-git';
import { recordWorkspaceSyncReplicaFiles } from '../workspace-sync-replica-files';
import {
  assertWorkspaceSyncUploadCaptureMatchesCommit,
  buildWorkspaceSyncUploadCapture,
  previewWorkspaceSyncUpload,
} from '../workspace-sync-snapshotter';
import { createTestDb } from './test-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

const workspaceUuid = 'membership-project';
const storagePolicy = {
  schemaVersion: 1 as const,
  policyKey: 'membership-test',
  revision: 1,
  maxFileBytes: 1024 * 1024,
  maxProjectBytes: 4 * 1024 * 1024,
  maxFiles: 2000,
  storageQuotaBytes: 8 * 1024 * 1024,
};

describe('workspace sync membership acceptance', () => {
  let db: Database.Database;
  let fixtureRoot: string;
  let root: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dnaforge-sync-membership-'));
    root = join(fixtureRoot, 'project');
    await mkdir(root);
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Membership project', ?, ?, 1, 1)`
    ).run(root, workspaceUuid);
    await initManagedRepo(root);
    await writeFile(join(root, MANAGED_WORKSPACE_MARKER), '{}');
    const { app } = await import('electron');
    vi.mocked(app.getPath).mockReturnValue(fixtureRoot);
  });

  afterEach(async () => {
    db?.close();
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('includes supported files in ordinary build, nested vendor and temp folders with their exact bytes', async () => {
    const files = {
      'normal.txt': 'Ordinary project note.\n',
      'build/result.gb': 'LOCUS       build_result\nORIGIN\n        1 atgc\n//\n',
      'nested/vendor/notes.txt': 'Supplier observations.\n',
      'temp/notes.txt': 'Temperature experiment observations.\n',
    };
    await writeFiles(files);
    const preview = await previewWorkspaceSyncUpload(db, { workspaceUuid, storagePolicy });
    const capture = await buildWorkspaceSyncUploadCapture(db, {
      workspaceUuid,
      appVersion: '1.0.0',
      storagePolicy,
    });

    for (const [path, content] of Object.entries(files)) {
      expect(preview.includedFiles).toContainEqual(
        expect.objectContaining({ relativePath: path, sizeBytes: Buffer.byteLength(content) })
      );
      expect(capture.manifest.files).toContainEqual(
        expect.objectContaining({
          path,
          sizeBytes: Buffer.byteLength(content),
          contentSha256: createHash('sha256').update(content).digest('hex'),
        })
      );
    }
    expect(preview.includedFiles.map((file) => file.relativePath).sort()).toEqual(
      capture.manifest.files.map((file) => file.path).sort()
    );
    expect(capture.manifest.files.some((file) => file.path.startsWith('.git/'))).toBe(false);
  });

  it('uses project rules and nested negation for new files in both preview and captured bytes', async () => {
    await writeFiles({
      '.gitignore': '/local-only/\n',
      'normal.txt': 'Shared note.\n',
      'local-only/private.txt': 'Kept on this computer.\n',
      'nested/.gitignore': '*.txt\n!keep.txt\n',
      'nested/private.txt': 'Nested local note.\n',
      'nested/keep.txt': 'Explicitly selected note.\n',
    });
    const preview = await previewWorkspaceSyncUpload(db, { workspaceUuid, storagePolicy });
    const capture = await buildWorkspaceSyncUploadCapture(db, {
      workspaceUuid,
      appVersion: '1.0.0',
      storagePolicy,
    });
    const expectedIncluded = ['normal.txt', 'nested/keep.txt'];
    const expectedExcluded = ['local-only/private.txt', 'nested/private.txt'];
    for (const path of expectedIncluded) {
      expect(preview.includedFiles.map((file) => file.relativePath)).toContain(path);
      expect(capture.manifest.files.map((file) => file.path)).toContain(path);
    }
    for (const path of expectedExcluded) {
      expect(preview.includedFiles.map((file) => file.relativePath)).not.toContain(path);
      expect(capture.manifest.files.map((file) => file.path)).not.toContain(path);
    }
  });

  it('does not let private Git info or excludesFile configuration decide shared project membership', async () => {
    await writeFiles({
      '.gitignore': '/project-local.txt\n',
      'normal.txt': 'Shared note.\n',
      'project-local.txt': 'Explicit project exclusion.\n',
      'machine-local.txt': 'Included despite private Git configuration.\n',
      'repository-local.txt': 'Included despite private repository Git configuration.\n',
    });
    const machineRules = join(fixtureRoot, 'machine-ignore');
    await writeFile(machineRules, 'machine-local.txt\n');
    await writeFile(join(root, '.git', 'info', 'exclude'), 'repository-local.txt\n');
    runGit(['config', '--local', 'core.excludesFile', machineRules]);
    expect(runGit(['check-ignore', '--', 'machine-local.txt', 'repository-local.txt'])).toBe(
      'machine-local.txt\nrepository-local.txt\n'
    );

    const preview = await previewWorkspaceSyncUpload(db, { workspaceUuid, storagePolicy });
    expect(preview.includedFiles.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining(['normal.txt', 'machine-local.txt', 'repository-local.txt'])
    );
    expect(preview.includedFiles.map((file) => file.relativePath)).not.toContain(
      'project-local.txt'
    );
  });

  it('lets project rules exclude locally tracked files that were never shared without changing local history', async () => {
    await writeFiles({
      'normal.txt': 'Shared note.\n',
      'tracked-local.txt': 'Tracked for local history only.\n',
    });
    commitAll();
    const originalHead = runGit(['rev-parse', 'HEAD']).trim();
    const originalBlob = runGit(['rev-parse', 'HEAD:tracked-local.txt']).trim();
    await writeFiles({ '.gitignore': '/tracked-local.txt\n' });

    const preview = await previewWorkspaceSyncUpload(db, { workspaceUuid, storagePolicy });
    const capture = await buildWorkspaceSyncUploadCapture(db, {
      workspaceUuid,
      appVersion: '1.0.0',
      storagePolicy,
    });
    expect(preview.includedFiles.map((file) => file.relativePath)).not.toContain(
      'tracked-local.txt'
    );
    expect(capture.manifest.files.map((file) => file.path)).not.toContain('tracked-local.txt');
    expect(runGit(['rev-parse', 'HEAD']).trim()).toBe(originalHead);
    expect(runGit(['rev-parse', 'HEAD:tracked-local.txt']).trim()).toBe(originalBlob);
    expect(await readFile(join(root, 'tracked-local.txt'), 'utf8')).toBe(
      'Tracked for local history only.\n'
    );
  });

  it('keeps a remotely accepted file selected after a matching rule is added', async () => {
    const shared = 'Previously shared observations.\n';
    await writeFiles({ 'normal.txt': 'Shared note.\n', 'shared.txt': shared });
    commitAll();
    db.prepare(
      `INSERT INTO workspace_sync_bindings
       (workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
        remote_latest_version_id, created_at, updated_at)
       VALUES (1, ?, 'account-a', 'remote-a', 1, 'version-a', 1, 1)`
    ).run(workspaceUuid);
    recordWorkspaceSyncReplicaFiles(db, {
      workspaceUuid,
      remoteWorkspaceId: 'remote-a',
      remoteVersionId: 'version-a',
      paths: ['normal.txt', 'shared.txt', MANAGED_WORKSPACE_MARKER],
      nowMs: 1,
    });
    await writeFiles({ '.gitignore': '/shared.txt\n' });

    const preview = await previewWorkspaceSyncUpload(db, { workspaceUuid, storagePolicy });
    expect(preview.includedFiles).toContainEqual(
      expect.objectContaining({ relativePath: 'shared.txt', sizeBytes: Buffer.byteLength(shared) })
    );
    expect(await readFile(join(root, 'shared.txt'), 'utf8')).toBe(shared);
    expect(runGit(['show', 'HEAD:shared.txt'])).toBe(shared);
  });

  it('reports project-rule exclusions separately from unsupported raw data with exact paths and bytes', async () => {
    const ignored = 'Intentionally local note.\n';
    await writeFiles({
      '.gitignore': '/local-only.txt\n',
      'normal.txt': 'Shared note.\n',
      'local-only.txt': ignored,
      'reads.fastq': '@read\nATGC\n+\n!!!!\n',
    });
    const preview = await previewWorkspaceSyncUpload(db, { workspaceUuid, storagePolicy });

    expect(preview).toMatchObject({
      excludedFiles: expect.arrayContaining([
        {
          relativePath: 'local-only.txt',
          sizeBytes: Buffer.byteLength(ignored),
          reason: 'project-ignore',
        },
      ]),
      statusExcludedSummary: { ignoredCount: 1, privateRawDataCount: 1 },
    });
    expect(preview.includedFiles.map((file) => file.relativePath)).not.toContain('local-only.txt');
    expect(preview.includedFiles.map((file) => file.relativePath)).not.toContain('reads.fastq');
  });

  it('captures only committed selected bytes when a new ignored file remains untracked', async () => {
    await writeFiles({
      '.gitignore': '/local-only.txt\n',
      'normal.txt': 'Committed shared note.\n',
      'local-only.txt': 'Never committed or published.\n',
    });
    commitAll();
    const capture = await buildWorkspaceSyncUploadCapture(db, {
      workspaceUuid,
      appVersion: '1.0.0',
      storagePolicy,
    });
    commitAll();
    const head = runGit(['rev-parse', 'HEAD']).trim();

    expect(capture.manifest.files.map((file) => file.path)).not.toContain('local-only.txt');
    await expect(
      assertWorkspaceSyncUploadCaptureMatchesCommit(capture, head)
    ).resolves.toBeUndefined();
    expect(runGit(['ls-files', '--', 'local-only.txt'])).toBe('');
  });

  async function writeFiles(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }

  function runGit(args: string[]): string {
    return execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Membership fixture',
        '-c',
        'user.email=membership@example.invalid',
        ...args,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      }
    );
  }

  function commitAll(): void {
    runGit(['add', '--all']);
    runGit(['commit', '--allow-empty', '-m', 'Synthetic membership fixture']);
  }
});
