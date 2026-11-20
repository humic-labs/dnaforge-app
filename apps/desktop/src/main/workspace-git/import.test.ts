import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  findLargeWorkspaceFiles,
  importContentIntoWorkspaceRoot,
  importFileIntoWorkspaceRoot,
  importQuickLookGenerationIntoWorkspaceRoot,
  importQuickLookPackageIntoWorkspaceRoot,
  importIntoManagedWorkspaceRepo,
  MANAGED_WORKSPACE_MARKER,
  recoverQuickLookPackagePromotions,
  type ImportProgressUpdate,
} from './import';
import {
  beginQuickLookPromotionWrite,
  commitAllIfDirty,
  hasActiveQuickLookPromotion,
  isQuickLookPromotionMutationBlocked,
  listFilesAtHead,
  resolveHeadCommit,
} from './index';
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('importIntoManagedWorkspaceRepo (S2)', () => {
  let db: Database.Database;
  let tmp: string;
  let source: string;
  let managedRoot: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wpimport-'));
    source = join(tmp, 'my-workspace');
    managedRoot = join(tmp, 'managed-workspaces');
    mkdirSync(join(source, 'sub'), { recursive: true });
    writeFileSync(join(source, 'pUC19.gb'), 'LOCUS pUC19 2686 bp\n');
    writeFileSync(join(source, 'sub', 'notes.txt'), 'hello\n');
    mkdirSync(join(source, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'pkg', 'index.js'), 'junk\n');
    mkdirSync(join(source, '.git'), { recursive: true });
    writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/foreign\n');
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies the folder into a fresh managed git repo, leaving the original untouched', async () => {
    const result = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
    });

    expect(result.reused).toBe(false);
    expect(result.workspaceUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.repoPath).toBe(join(managedRoot, result.workspaceUuid, 'repo'));

    expect(existsSync(join(result.repoPath, '.git'))).toBe(true);
    expect(existsSync(join(result.repoPath, 'pUC19', 'pUC19.gb'))).toBe(true);
    expect(existsSync(join(result.repoPath, 'sub', 'notes.txt'))).toBe(true);
    expect(existsSync(join(result.repoPath, MANAGED_WORKSPACE_MARKER))).toBe(true);
    expect(existsSync(join(result.repoPath, 'node_modules'))).toBe(false);

    const marker = JSON.parse(
      await readFile(join(result.repoPath, MANAGED_WORKSPACE_MARKER), 'utf8')
    ) as { workspaceUuid: string; originPath: string };
    expect(marker.workspaceUuid).toBe(result.workspaceUuid);
    expect(marker.originPath).toBe(result.originPath);

    expect(await resolveHeadCommit(result.repoPath)).toMatch(/^[0-9a-f]{40}$/);
    const headFiles = await listFilesAtHead(result.repoPath);
    expect(headFiles).toContain('pUC19/pUC19.gb');
    expect(headFiles).toContain('sub/notes.txt');
    expect(headFiles).toContain(MANAGED_WORKSPACE_MARKER);

    expect(existsSync(join(source, MANAGED_WORKSPACE_MARKER))).toBe(false);

    const row = db
      .prepare('SELECT path, origin_path, name FROM workspaces WHERE repo_uuid = ?')
      .get(result.workspaceUuid) as { path: string; origin_path: string; name: string } | undefined;
    expect(row?.path).toBe(result.repoPath);
    expect(row?.origin_path).toBe(result.originPath);
    expect(row?.name).toBe('my-workspace');
  });

  it('force-includes package products in a fresh managed import even when the source ignores *.gb', async () => {
    writeFileSync(join(source, '.gitignore'), '*.gb\n');

    const result = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
    });

    expect(await listFilesAtHead(result.repoPath)).toEqual(
      expect.arrayContaining(['pUC19/pUC19.gb', 'pUC19/.forge/plasmid.json'])
    );
  });

  it('COMMITS the package conversion when re-adding a managed workspace', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });

    const loose = 'legacy.gb';
    writeFileSync(
      join(first.repoPath, loose),
      [
        'LOCUS       legacy        12 bp    DNA     circular SYN 01-JAN-2020',
        'ORIGIN',
        '        1 acgtacgtacgt',
        '//',
        '',
      ].join('\n')
    );
    await commitAllIfDirty(first.repoPath, 'legacy loose sequence');
    expect(await listFilesAtHead(first.repoPath)).toContain(loose);

    await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });

    const headFiles = await listFilesAtHead(first.repoPath);
    expect(headFiles).toContain('legacy/legacy.gb');
    expect(headFiles).toContain('legacy/.forge/plasmid.json');
    expect(headFiles).not.toContain(loose);
    expect(existsSync(join(first.repoPath, loose))).toBe(false);
  });

  it('does not let a workspace *.gb ignore rule omit the converted product from HEAD', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });
    writeFileSync(join(first.repoPath, '.gitignore'), '*.gb\n');
    writeFileSync(join(first.repoPath, 'legacy.fna'), '>legacy\nACGTACGTACGT\n');
    await commitAllIfDirty(first.repoPath, 'legacy nucleotide FASTA');
    expect(await listFilesAtHead(first.repoPath)).toEqual(
      expect.arrayContaining(['.gitignore', 'legacy.fna'])
    );

    await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });

    const headFiles = await listFilesAtHead(first.repoPath);
    expect(headFiles).toContain('legacy/legacy.gb');
    expect(headFiles).toContain('legacy/.forge/plasmid.json');
    expect(headFiles).not.toContain('legacy.fna');
  });

  it('reopens without rewriting when a migration marker is malformed', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });
    const looseSequence = join(first.repoPath, 'Preserved.gb');
    mkdirSync(join(first.repoPath, '.dnaforge', 'migration'), { recursive: true });
    writeFileSync(
      looseSequence,
      [
        'LOCUS       Preserved     12 bp    DNA     circular SYN 01-JAN-2020',
        'ORIGIN',
        '        1 acgtacgtacgt',
        '//',
        '',
      ].join('\n')
    );
    writeFileSync(join(first.repoPath, '.dnaforge', 'migration', 'workspace.json'), '{broken');
    await commitAllIfDirty(first.repoPath, 'malformed migration marker');

    const reopened = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
    });

    expect(reopened.reused).toBe(true);
    expect(existsSync(looseSequence)).toBe(true);
    expect(existsSync(join(first.repoPath, 'Preserved', 'Preserved.gb'))).toBe(false);
  });

  it('does not open a workspace with a valid locked migration marker', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });
    mkdirSync(join(first.repoPath, '.dnaforge', 'migration'), { recursive: true });
    writeFileSync(
      join(first.repoPath, '.dnaforge', 'migration', 'workspace.json'),
      `${JSON.stringify({
        schema: 'dnaforge.benchling-migration-workspace.v1',
        workspaceId: first.workspaceUuid,
        runId: `migration-${first.workspaceUuid}`,
        status: 'locked',
      })}\n`
    );
    await commitAllIfDirty(first.repoPath, 'locked migration marker');

    await expect(
      importIntoManagedWorkspaceRepo(source, {
        db,
        managedRootDir: managedRoot,
      })
    ).rejects.toThrow('migration project is locked');
  });

  it('does not open a locked migration workspace with an unexpected run id', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });
    mkdirSync(join(first.repoPath, '.dnaforge', 'migration'), { recursive: true });
    writeFileSync(
      join(first.repoPath, '.dnaforge', 'migration', 'workspace.json'),
      `${JSON.stringify({
        schema: 'dnaforge.benchling-migration-workspace.v1',
        workspaceId: first.workspaceUuid,
        runId: 'future-run-id-convention',
        status: 'locked',
      })}\n`
    );
    await commitAllIfDirty(first.repoPath, 'locked migration marker with unexpected run id');

    await expect(
      importIntoManagedWorkspaceRepo(source, {
        db,
        managedRootDir: managedRoot,
      })
    ).rejects.toThrow('migration project is locked');
  });

  it('FAILS re-add when converted packages cannot be committed to HEAD', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });

    const loose = 'legacy.gb';
    writeFileSync(
      join(first.repoPath, loose),
      [
        'LOCUS       legacy        12 bp    DNA     circular SYN 01-JAN-2020',
        'ORIGIN',
        '        1 acgtacgtacgt',
        '//',
        '',
      ].join('\n')
    );
    await commitAllIfDirty(first.repoPath, 'legacy loose sequence');
    const archivedAt = Date.now();
    db.prepare(`UPDATE workspaces SET archived_at = ? WHERE repo_uuid = ?`).run(
      archivedAt,
      first.workspaceUuid
    );
    const forcedCommitFailure = vi.fn().mockRejectedValue(new Error('forced commit failure'));

    await expect(
      importIntoManagedWorkspaceRepo(source, {
        db,
        managedRootDir: managedRoot,
        commitAllIfDirty: forcedCommitFailure,
      })
    ).rejects.toThrow(/forced commit failure/);

    expect(forcedCommitFailure).toHaveBeenCalledWith(
      first.repoPath,
      'Convert sequences to plasmid packages',
      expect.objectContaining({
        forceInclude: expect.arrayContaining([
          join(first.repoPath, 'legacy', 'legacy.gb'),
          join(first.repoPath, 'legacy', '.forge', 'plasmid.json'),
        ]),
      })
    );
    expect(await listFilesAtHead(first.repoPath)).toContain(loose);
    expect(existsSync(join(first.repoPath, loose))).toBe(false);
    expect(existsSync(join(first.repoPath, 'legacy', 'legacy.gb'))).toBe(true);
    const row = db
      .prepare(`SELECT archived_at FROM workspaces WHERE repo_uuid = ?`)
      .get(first.workspaceUuid) as { archived_at: number | null };
    expect(row.archived_at).toBe(archivedAt);
  });

  it('commits an already-converted dirty tree before a managed re-add retry succeeds', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });
    const loose = 'retry.gb';
    writeFileSync(
      join(first.repoPath, loose),
      [
        'LOCUS       retry         12 bp    DNA     circular SYN 01-JAN-2020',
        'ORIGIN',
        '        1 acgtacgtacgt',
        '//',
        '',
      ].join('\n')
    );
    await commitAllIfDirty(first.repoPath, 'legacy loose sequence for retry');
    const archivedAt = Date.now();
    db.prepare(`UPDATE workspaces SET archived_at = ? WHERE repo_uuid = ?`).run(
      archivedAt,
      first.workspaceUuid
    );

    await expect(
      importIntoManagedWorkspaceRepo(source, {
        db,
        managedRootDir: managedRoot,
        commitAllIfDirty: vi.fn().mockRejectedValue(new Error('forced first commit failure')),
      })
    ).rejects.toThrow(/forced first commit failure/);

    expect(existsSync(join(first.repoPath, 'retry', 'retry.gb'))).toBe(true);
    expect(await listFilesAtHead(first.repoPath)).toContain(loose);

    const retried = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
    });

    expect(retried.reused).toBe(true);
    const headFiles = await listFilesAtHead(first.repoPath);
    expect(headFiles).toContain('retry/retry.gb');
    expect(headFiles).toContain('retry/.forge/plasmid.json');
    expect(headFiles).not.toContain(loose);
    const row = db
      .prepare(`SELECT archived_at FROM workspaces WHERE repo_uuid = ?`)
      .get(first.workspaceUuid) as { archived_at: number | null };
    expect(row.archived_at).toBeNull();
  });

  it('re-mounting the same origin reuses the existing managed copy (idempotent, no second row)', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });
    const second = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
    });

    expect(second.reused).toBe(true);
    expect(second.workspaceUuid).toBe(first.workspaceUuid);
    expect(second.repoPath).toBe(first.repoPath);

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM workspaces WHERE repo_uuid IS NOT NULL')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('re-importing an ARCHIVED origin restores it — clears archived_at (no half-state)', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });
    db.prepare(`UPDATE workspaces SET archived_at = ? WHERE repo_uuid = ?`).run(
      Date.now(),
      first.workspaceUuid
    );

    const second = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
    });
    expect(second.reused).toBe(true);
    expect(second.workspaceUuid).toBe(first.workspaceUuid);

    const row = db
      .prepare(`SELECT archived_at, trashed_at FROM workspaces WHERE repo_uuid = ?`)
      .get(first.workspaceUuid) as { archived_at: number | null; trashed_at: number | null };
    expect(row.archived_at).toBeNull();
    expect(row.trashed_at).toBeNull();
  });

  it('re-importing a TRASHED (not-yet-purged) origin restores it — clears trashed_at', async () => {
    const first = await importIntoManagedWorkspaceRepo(source, { db, managedRootDir: managedRoot });
    db.prepare(`UPDATE workspaces SET trashed_at = ? WHERE repo_uuid = ?`).run(
      Date.now(),
      first.workspaceUuid
    );

    const second = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
    });
    expect(second.reused).toBe(true);

    const row = db
      .prepare(`SELECT trashed_at FROM workspaces WHERE repo_uuid = ?`)
      .get(first.workspaceUuid) as { trashed_at: number | null };
    expect(row.trashed_at).toBeNull();
  });

  it('detects individual files over the managed-import large-file threshold', async () => {
    writeFileSync(join(source, 'sub', 'large.fastq'), '0123456789\n');

    const realSource = await realpath(source);
    const largeFiles = await findLargeWorkspaceFiles(source, 10);

    expect(largeFiles.map((file) => file.relPath).sort()).toEqual(['pUC19.gb', 'sub/large.fastq']);
    expect(largeFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relPath: 'pUC19.gb',
          sourcePath: join(realSource, 'pUC19.gb'),
          sizeBytes: 'LOCUS pUC19 2686 bp\n'.length,
        }),
        expect.objectContaining({
          relPath: 'sub/large.fastq',
          sourcePath: join(realSource, 'sub', 'large.fastq'),
          sizeBytes: '0123456789\n'.length,
        }),
      ])
    );
  });

  it('copies large files by default when the user does not choose symlink policy', async () => {
    writeFileSync(join(source, 'sub', 'large.fastq'), '0123456789\n');

    const result = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
      largeFileThresholdBytes: 10,
    });

    const copiedPath = join(result.repoPath, 'sub', 'large.fastq');
    await expect(lstat(copiedPath).then((stats) => stats.isFile())).resolves.toBe(true);
    await expect(lstat(copiedPath).then((stats) => stats.isSymbolicLink())).resolves.toBe(false);
    await expect(readFile(copiedPath, 'utf8')).resolves.toBe('0123456789\n');
    expect(result.largeFilePolicy).toBe('copy');
    expect(result.largeFiles.map((file) => file.relPath).sort()).toEqual([
      'pUC19.gb',
      'sub/large.fastq',
    ]);
    expect(result.symlinkedLargeFiles).toEqual([]);
  });

  it('imports independent large attachments without changing the original after a project edit', async () => {
    const original = join(source, 'sub', 'large.bin');
    const bytes = Buffer.alloc(2 * 1024 * 1024, 73);
    writeFileSync(original, bytes);
    const result = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
      largeFileThresholdBytes: 1024 * 1024,
      largeFilePolicy: 'copy',
    });
    const copied = join(result.repoPath, 'sub', 'large.bin');
    expect(sha256(await readFile(copied))).toBe(sha256(bytes));
    expect((await lstat(copied)).ino).not.toBe((await lstat(original)).ino);
    writeFileSync(copied, 'project edit');
    expect(sha256(await readFile(original))).toBe(sha256(bytes));
    expect(await listFilesAtHead(result.repoPath)).toContain('sub/large.bin');
  });

  it('can keep large files as symlinks inside the managed repo', async () => {
    writeFileSync(join(source, 'sub', 'large.fastq'), '0123456789\n');

    const result = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
      largeFileThresholdBytes: 10,
      largeFilePolicy: 'symlink',
    });

    const linkPath = join(result.repoPath, 'sub', 'large.fastq');
    await expect(lstat(linkPath).then((stats) => stats.isSymbolicLink())).resolves.toBe(true);
    await expect(readlink(linkPath)).resolves.toBe(
      await realpath(join(source, 'sub', 'large.fastq'))
    );
    expect(result.largeFilePolicy).toBe('symlink');
    expect(result.largeFiles.map((file) => file.relPath).sort()).toEqual([
      'pUC19.gb',
      'sub/large.fastq',
    ]);
    expect(result.symlinkedLargeFiles.map((file) => file.relPath).sort()).toEqual([
      'pUC19.gb',
      'sub/large.fastq',
    ]);

    const headFiles = await listFilesAtHead(result.repoPath);
    expect(headFiles).toContain('sub/large.fastq');
  });

  it('cancels before creating a managed workspace when the large-file resolver declines', async () => {
    const resolver = vi.fn().mockResolvedValue('cancel' as const);
    writeFileSync(join(source, 'sub', 'large.fastq'), '0123456789\n');

    await expect(
      importIntoManagedWorkspaceRepo(source, {
        db,
        managedRootDir: managedRoot,
        largeFileThresholdBytes: 4,
        resolveLargeFilePolicy: resolver,
      })
    ).rejects.toThrow('Project import canceled');

    expect(resolver).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ relPath: 'pUC19.gb' }),
        expect.objectContaining({ relPath: 'sub/large.fastq' }),
      ]),
      4
    );
    expect(existsSync(managedRoot)).toBe(false);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM workspaces WHERE repo_uuid IS NOT NULL')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('emits determinate progress with exact totals from the existing walk ', async () => {
    const updates: ImportProgressUpdate[] = [];
    await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: managedRoot,
      onProgress: (u) => updates.push(u),
    });

    const copying = updates.filter((u) => u.status === 'copying');
    expect(copying.length).toBeGreaterThan(0);
    const totalFiles = copying[0].totalFiles;
    expect(totalFiles).toBe(2);
    expect(copying.every((u) => u.totalFiles === totalFiles)).toBe(true);
    const counts = copying.map((u) => u.filesCopied);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(Math.max(...counts)).toBe(totalFiles);
    expect(copying[copying.length - 1]?.bytesCopied).toBeGreaterThan(0);
    const last = updates[updates.length - 1];
    expect(last?.status).toBe('finalizing');
    expect(last?.filesCopied).toBe(totalFiles);
  });
});

describe('importFileIntoWorkspaceRoot ', () => {
  let db: Database.Database;
  let tmp: string;
  let managedRoot: string;
  let sourceFile: string;

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wpimportfile-'));
    managedRoot = join(tmp, 'managed-workspaces');
    mkdirSync(join(tmp, 'src'), { recursive: true });
    sourceFile = join(tmp, 'src', 'pUC19.gb');
    writeFileSync(sourceFile, 'LOCUS pUC19 2686 bp\n');
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function makeManagedRepo(): Promise<string> {
    const origin = join(tmp, 'existing-ws');
    mkdirSync(origin, { recursive: true });
    writeFileSync(join(origin, 'seed.gb'), 'LOCUS seed 10 bp\n');
    const result = await importIntoManagedWorkspaceRepo(origin, {
      db,
      managedRootDir: managedRoot,
    });
    return result.repoPath;
  }

  function makeQuickLookSnapshot(stem: string): {
    recordId: string;
    packageRoot: string;
    productRelativePath: string;
    files: Array<{ relativePath: string; sha256: string }>;
  } {
    const packageRoot = join(tmp, 'quick-look', stem);
    const productRelativePath = `${stem}.gb`;
    const productBytes =
      `LOCUS       ${stem.padEnd(12)} 4 bp    DNA     linear SYN 01-JAN-2000\n` +
      'ORIGIN\n        1 acgt\n//\n';
    const marker = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: `quick-look-${stem}`,
        name: stem,
        product: { file: productRelativePath },
      })
    );
    mkdirSync(join(packageRoot, '.forge'), { recursive: true });
    writeFileSync(join(packageRoot, productRelativePath), productBytes);
    writeFileSync(join(packageRoot, '.forge', 'plasmid.json'), marker);
    return {
      recordId: sha256(`record:${stem}`),
      packageRoot,
      productRelativePath,
      files: [
        { relativePath: '.forge/plasmid.json', sha256: sha256(marker) },
        { relativePath: productRelativePath, sha256: sha256(productBytes) },
      ],
    };
  }

  it('gives each saved copy its own sequence identity while keeping exact source products and reusing a verified retry', async () => {
    const repoPath = await makeManagedRepo();
    const other = join(repoPath, 'second');
    mkdirSync(other);
    const records = [makeQuickLookSnapshot('first'), makeQuickLookSnapshot('duplicate')];
    const snapshot = { sourceFileName: 'collection.gb', records };
    const deps = {
      db,
      managedRootDir: managedRoot,
      promotionJournalRoot: join(tmp, 'promotions'),
      independentCopies: true,
    };
    const readMarker = (root: string) =>
      JSON.parse(readFileSync(join(root, '.forge', 'plasmid.json'), 'utf8'));
    const opened = await importQuickLookGenerationIntoWorkspaceRoot(snapshot, repoPath, deps);
    const duplicate = await importQuickLookGenerationIntoWorkspaceRoot(snapshot, other, deps);
    const saved = await importQuickLookGenerationIntoWorkspaceRoot(snapshot, repoPath, deps);
    expect(saved.records).toEqual(opened.records);
    for (const [i, record] of records.entries()) {
      const sourceMarker = readMarker(record.packageRoot);
      const first = readMarker(dirname(opened.records[i].destPath));
      const second = readMarker(dirname(duplicate.records[i].destPath));
      expect(new Set([sourceMarker.id, first.id, second.id]).size).toBe(3);
      expect({ ...first, id: sourceMarker.id }).toEqual(sourceMarker);
      expect({ ...second, id: sourceMarker.id }).toEqual(sourceMarker);
      expect(readFileSync(opened.records[i].destPath)).toEqual(
        readFileSync(join(record.packageRoot, record.productRelativePath))
      );
    }
  });

  it('publishes every record in one collision-safe group and reuses it on retry', async () => {
    const repoPath = await makeManagedRepo();
    const first = makeQuickLookSnapshot('chromosome-one');
    const second = makeQuickLookSnapshot('chromosome-two');
    const deps = {
      db,
      managedRootDir: managedRoot,
      promotionJournalRoot: join(tmp, 'quick-look-promotions'),
    };

    const promoted = await importQuickLookGenerationIntoWorkspaceRoot(
      { sourceFileName: 'assembly.gbk', records: [first, second] },
      repoPath,
      deps
    );

    expect(promoted.records).toHaveLength(2);
    expect(promoted.records.map((record) => record.recordId)).toEqual([
      first.recordId,
      second.recordId,
    ]);
    expect(promoted.records.map((record) => record.relPath)).toEqual([
      join('assembly', 'chromosome-one', 'chromosome-one.gb'),
      join('assembly', 'chromosome-two', 'chromosome-two.gb'),
    ]);
    expect(await readFile(promoted.records[0].destPath, 'utf8')).toContain('chromosome-one');
    expect(await readFile(promoted.records[1].destPath, 'utf8')).toContain('chromosome-two');
    expect(await listFilesAtHead(repoPath)).toEqual(
      expect.arrayContaining([
        'assembly/chromosome-one/chromosome-one.gb',
        'assembly/chromosome-two/chromosome-two.gb',
      ])
    );

    const retried = await importQuickLookGenerationIntoWorkspaceRoot(
      { sourceFileName: 'assembly.gbk', records: [first, second] },
      repoPath,
      deps
    );
    expect(retried.records).toEqual(promoted.records);
    expect((await readdir(repoPath)).filter((entry) => entry.startsWith('assembly'))).toEqual([
      'assembly',
    ]);
  });

  it('queues publication while workspace sync owns the destination', async () => {
    const repoPath = await makeManagedRepo();
    const first = makeQuickLookSnapshot('sync-blocked-first');
    const second = makeQuickLookSnapshot('sync-blocked-second');
    const releaseSync = await acquireWorkspaceSyncMutationLease(repoPath);
    let released = false;
    try {
      const promotion = importQuickLookGenerationIntoWorkspaceRoot(
        { sourceFileName: 'sync-blocked.gbk', records: [first, second] },
        repoPath,
        {
          db,
          managedRootDir: managedRoot,
          promotionJournalRoot: join(tmp, 'quick-look-promotions'),
        }
      );
      await new Promise<void>((resolvePending) => setImmediate(resolvePending));
      expect(existsSync(join(repoPath, 'sync-blocked'))).toBe(false);

      releaseSync();
      released = true;
      const promoted = await promotion;
      expect(promoted.records.map((record) => record.recordId)).toEqual([
        first.recordId,
        second.recordId,
      ]);
      expect(existsSync(join(repoPath, 'sync-blocked'))).toBe(true);
    } finally {
      if (!released) releaseSync();
    }
  });

  it('refuses a completed set journal whose package root escaped the destination', async () => {
    const repoPath = await makeManagedRepo();
    const first = makeQuickLookSnapshot('escaped-first');
    const second = makeQuickLookSnapshot('escaped-second');
    const journalRoot = join(tmp, 'quick-look-promotions');
    const snapshot = { sourceFileName: 'escaped.gbk', records: [first, second] };
    await importQuickLookGenerationIntoWorkspaceRoot(snapshot, repoPath, {
      db,
      managedRootDir: managedRoot,
      promotionJournalRoot: journalRoot,
    });
    const journalName = (await readdir(journalRoot)).find((entry) => entry.startsWith('set-'));
    if (!journalName) throw new Error('Multi-record promotion journal was not created.');
    const journalPath = join(journalRoot, journalName);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      stagingRoot: string;
      finalRoot: string;
    };
    const escapedRoot = join(tmp, 'escaped-package-set');
    await rename(journal.finalRoot, escapedRoot);
    writeFileSync(
      journalPath,
      `${JSON.stringify({ ...journal, stagingRoot: escapedRoot, finalRoot: escapedRoot })}\n`
    );

    await expect(
      importQuickLookGenerationIntoWorkspaceRoot(snapshot, repoPath, {
        db,
        managedRootDir: managedRoot,
        promotionJournalRoot: journalRoot,
      })
    ).rejects.toThrow('retained unresolved Quick Look recovery state');
    expect(existsSync(escapedRoot)).toBe(true);
  });

  it('preserves every destination type while choosing a multi-record group name', async () => {
    const repoPath = await makeManagedRepo();
    mkdirSync(join(repoPath, 'assembly'));
    writeFileSync(join(repoPath, 'assembly (1)'), 'regular file must survive');
    const symlinkTarget = join(tmp, 'assembly-link-target');
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, join(repoPath, 'assembly (2)'));
    mkdirSync(join(repoPath, 'assembly (3)'));
    writeFileSync(join(repoPath, 'assembly (3)', 'user-data.txt'), 'directory must survive');
    const first = makeQuickLookSnapshot('collision-first');
    const second = makeQuickLookSnapshot('collision-second');

    const promoted = await importQuickLookGenerationIntoWorkspaceRoot(
      { sourceFileName: 'assembly.gbk', records: [first, second] },
      repoPath,
      {
        db,
        managedRootDir: managedRoot,
        promotionJournalRoot: join(tmp, 'quick-look-promotions'),
      }
    );

    expect(promoted.records[0].relPath).toBe(
      join('assembly (4)', 'collision-first', 'collision-first.gb')
    );
    expect((await readdir(join(repoPath, 'assembly'))).length).toBe(0);
    expect(await readFile(join(repoPath, 'assembly (1)'), 'utf8')).toBe(
      'regular file must survive'
    );
    expect(await realpath(join(repoPath, 'assembly (2)'))).toBe(await realpath(symlinkTarget));
    expect(await readFile(join(repoPath, 'assembly (3)', 'user-data.txt'), 'utf8')).toBe(
      'directory must survive'
    );
  });

  it('recovers an empty reserved multi-record group journaled before its owner marker', async () => {
    const root = join(tmp, 'plain-root');
    const journalRoot = join(tmp, 'quick-look-promotions');
    const reservedRoot = join(root, 'reserved-assembly');
    const recordKey = 'e'.repeat(64);
    mkdirSync(reservedRoot, { recursive: true });
    mkdirSync(journalRoot, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    const canonicalRoot = await realpath(root);
    const canonicalReservedRoot = await realpath(reservedRoot);
    const identity = await lstat(canonicalReservedRoot, { bigint: true });
    const journalPath = join(journalRoot, `set-${recordKey}.json`);
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schema: 'dnaforge.quick-look-set-promotion.v1',
        state: 'active',
        recordKey,
        token: 'owner-marker-not-written-yet',
        realTarget: canonicalRoot,
        stagingRoot: canonicalReservedRoot,
        finalRoot: canonicalReservedRoot,
        device: identity.dev.toString(),
        inode: identity.ino.toString(),
        sourceFileName: 'reserved-assembly.gbk',
        records: [],
        committed: false,
      })}\n`
    );

    await recoverQuickLookPackagePromotions(journalRoot, { db, managedRootDir: managedRoot });

    expect(existsSync(reservedRoot)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('recovers a crash before the first package in a multi-record set is complete', async () => {
    const root = join(tmp, 'plain-root');
    const journalRoot = join(tmp, 'quick-look-promotions');
    const stagingRoot = join(root, '.dnaforge-quick-look-set-interrupted');
    const token = 'interrupted-set-owner';
    const recordKey = 'd'.repeat(64);
    mkdirSync(stagingRoot, { recursive: true });
    mkdirSync(journalRoot, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    writeFileSync(
      join(stagingRoot, '.dnaforge-quick-look-promotion.json'),
      `${JSON.stringify({ token })}\n`
    );
    const canonicalRoot = await realpath(root);
    const canonicalStagingRoot = await realpath(stagingRoot);
    const finalRoot = join(canonicalRoot, 'interrupted-assembly');
    const identity = await lstat(canonicalStagingRoot, { bigint: true });
    const journalPath = join(journalRoot, `set-${recordKey}.json`);
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schema: 'dnaforge.quick-look-set-promotion.v1',
        state: 'active',
        recordKey,
        token,
        realTarget: canonicalRoot,
        stagingRoot: canonicalStagingRoot,
        finalRoot,
        device: identity.dev.toString(),
        inode: identity.ino.toString(),
        sourceFileName: 'interrupted.gbk',
        records: [],
        committed: false,
      })}\n`
    );

    await recoverQuickLookPackagePromotions(journalRoot, { db, managedRootDir: managedRoot });

    expect(existsSync(stagingRoot)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('retires a multi-record ownership marker left after durable completion', async () => {
    const root = join(tmp, 'plain-root');
    const journalRoot = join(tmp, 'quick-look-promotions');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    const first = makeQuickLookSnapshot('first-record');
    const second = makeQuickLookSnapshot('second-record');
    await importQuickLookGenerationIntoWorkspaceRoot(
      { sourceFileName: 'completed.gbk', records: [first, second] },
      root,
      { db, managedRootDir: managedRoot, promotionJournalRoot: journalRoot }
    );
    const journalName = (await readdir(journalRoot)).find((entry) => entry.startsWith('set-'));
    if (!journalName) throw new Error('Multi-record promotion journal was not created.');
    const journal = JSON.parse(await readFile(join(journalRoot, journalName), 'utf8')) as {
      token: string;
      finalRoot: string;
    };
    const ownerPath = join(journal.finalRoot, '.dnaforge-quick-look-promotion.json');
    writeFileSync(ownerPath, `${JSON.stringify({ token: journal.token })}\n`);

    await recoverQuickLookPackagePromotions(journalRoot, { db, managedRootDir: managedRoot });

    expect(existsSync(ownerPath)).toBe(false);
  });

  it('completes recovery after a multi-record set became app-visible', async () => {
    const root = join(tmp, 'plain-root');
    const journalRoot = join(tmp, 'quick-look-promotions');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    const first = makeQuickLookSnapshot('published-first');
    const second = makeQuickLookSnapshot('published-second');
    const promoted = await importQuickLookGenerationIntoWorkspaceRoot(
      { sourceFileName: 'published.gbk', records: [first, second] },
      root,
      { db, managedRootDir: managedRoot, promotionJournalRoot: journalRoot }
    );
    const journalName = (await readdir(journalRoot)).find((entry) => entry.startsWith('set-'));
    if (!journalName) throw new Error('Multi-record promotion journal was not created.');
    const journalPath = join(journalRoot, journalName);
    const completed = JSON.parse(await readFile(journalPath, 'utf8')) as {
      state: 'active' | 'completed';
      token: string;
      finalRoot: string;
    };
    writeFileSync(journalPath, `${JSON.stringify({ ...completed, state: 'active' })}\n`);
    const ownerPath = join(completed.finalRoot, '.dnaforge-quick-look-promotion.json');
    writeFileSync(ownerPath, `${JSON.stringify({ token: completed.token })}\n`);

    await recoverQuickLookPackagePromotions(journalRoot, { db, managedRootDir: managedRoot });

    expect(promoted.records).toHaveLength(2);
    for (const record of promoted.records) {
      expect(existsSync(record.destPath)).toBe(true);
    }
    expect((JSON.parse(await readFile(journalPath, 'utf8')) as { state: string }).state).toBe(
      'completed'
    );
    expect(existsSync(ownerPath)).toBe(false);
  });

  it('copies the file into a managed repo and commits it', async () => {
    const repoPath = await makeManagedRepo();
    const headBefore = await resolveHeadCommit(repoPath);

    const result = await importFileIntoWorkspaceRoot(
      { targetRoot: repoPath, sourcePath: sourceFile },
      {
        db,
        managedRootDir: managedRoot,
      }
    );

    expect(result.relPath).toBe(join('pUC19', 'pUC19.gb'));
    expect(result.committed).toBe(true);
    expect(existsSync(join(repoPath, 'pUC19', 'pUC19.gb'))).toBe(true);
    expect(await readFile(join(repoPath, 'pUC19', 'pUC19.gb'), 'utf8')).toBe(
      'LOCUS pUC19 2686 bp\n'
    );
    expect(await resolveHeadCommit(repoPath)).not.toBe(headBefore);
    const tracked = await listFilesAtHead(repoPath);
    expect(tracked).toContain('pUC19/pUC19.gb');
    expect(tracked).toContain('pUC19/.forge/plasmid.json');
  });

  it('rejects changed post-preview bytes without leaving a loose file or package', async () => {
    const root = join(tmp, 'preview-bound-root');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'preview-bound-root',
      root,
      Date.now()
    );
    const confirmed = 'LOCUS       confirmed       8 bp    DNA\nORIGIN\n        1 acgtacgt\n//\n';
    writeFileSync(sourceFile, confirmed);
    const expectedSourceSha256 = createHash('sha256').update(confirmed).digest('hex');
    writeFileSync(
      sourceFile,
      'LOCUS       changed         8 bp    DNA\nORIGIN\n        1 ttttcccc\n//\n'
    );

    await expect(
      importFileIntoWorkspaceRoot(
        { targetRoot: root, sourcePath: sourceFile, expectedSourceSha256 },
        { db, managedRootDir: managedRoot }
      )
    ).rejects.toThrow(/changed after preview/i);

    expect(await readdir(root)).toEqual([]);
  });

  it('rejects changed post-preview bytes during loose-file replace without touching the target', async () => {
    const root = join(tmp, 'preview-replace-root');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'preview-replace-root',
      root,
      Date.now()
    );
    const existing = 'LOCUS       existing        8 bp    DNA\nORIGIN\n        1 acgtacgt\n//\n';
    const confirmed = 'LOCUS       confirmed       8 bp    DNA\nORIGIN\n        1 ggggaaaa\n//\n';
    const changed = 'LOCUS       changed         8 bp    DNA\nORIGIN\n        1 ttttcccc\n//\n';
    writeFileSync(join(root, 'legacy.gb'), existing);
    writeFileSync(sourceFile, changed);

    await expect(
      importFileIntoWorkspaceRoot(
        {
          targetRoot: root,
          sourcePath: sourceFile,
          expectedSourceSha256: createHash('sha256').update(confirmed).digest('hex'),
          dedup: { mode: 'replace', expectedRelPath: 'legacy.gb' },
        },
        { db, managedRootDir: managedRoot }
      )
    ).rejects.toThrow(/changed after preview/i);

    expect(await readFile(join(root, 'legacy.gb'), 'utf8')).toBe(existing);
    expect((await readdir(root)).filter((name) => name.includes('.import-'))).toEqual([]);
  });

  it('rejects changed post-preview bytes during package replace without leaving staging files', async () => {
    const root = join(tmp, 'preview-package-replace-root');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'preview-package-replace-root',
      root,
      Date.now()
    );
    const existing = 'LOCUS       existing        8 bp    DNA\nORIGIN\n        1 acgtacgt\n//\n';
    writeFileSync(sourceFile, existing);
    const first = await importFileIntoWorkspaceRoot(
      { targetRoot: root, sourcePath: sourceFile },
      { db, managedRootDir: managedRoot }
    );
    const confirmed = 'LOCUS       confirmed       8 bp    DNA\nORIGIN\n        1 ggggaaaa\n//\n';
    writeFileSync(
      sourceFile,
      'LOCUS       changed         8 bp    DNA\nORIGIN\n        1 ttttcccc\n//\n'
    );

    await expect(
      importFileIntoWorkspaceRoot(
        {
          targetRoot: root,
          sourcePath: sourceFile,
          expectedSourceSha256: createHash('sha256').update(confirmed).digest('hex'),
          dedup: { mode: 'replace', expectedRelPath: first.relPath },
        },
        { db, managedRootDir: managedRoot }
      )
    ).rejects.toThrow(/changed after preview/i);

    expect(await readFile(join(root, first.relPath), 'utf8')).toBe(existing);
    expect((await readdir(root)).filter((name) => name.includes('.import-'))).toEqual([]);
  });

  it('renames on collision instead of overwriting (name (1).gb)', async () => {
    const repoPath = await makeManagedRepo();
    const first = await importFileIntoWorkspaceRoot(
      { targetRoot: repoPath, sourcePath: sourceFile },
      { db, managedRootDir: managedRoot }
    );
    const second = await importFileIntoWorkspaceRoot(
      { targetRoot: repoPath, sourcePath: sourceFile },
      { db, managedRootDir: managedRoot }
    );
    expect(first.relPath).toBe(join('pUC19', 'pUC19.gb'));
    expect(second.relPath).toBe(join('pUC19 (1)', 'pUC19.gb'));
    expect(existsSync(join(repoPath, 'pUC19', 'pUC19.gb'))).toBe(true);
    expect(existsSync(join(repoPath, 'pUC19 (1)', 'pUC19.gb'))).toBe(true);
  });

  it('replaces an existing package through the package transaction, not direct file overwrite', async () => {
    const root = join(tmp, 'plain-root');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );

    const packageRoot = join(root, 'Curated');
    const productPath = join(packageRoot, 'Curated.gb');
    const markerPath = join(packageRoot, '.forge', 'plasmid.json');
    const oldCsv = join(packageRoot, 'primers', 'Curated.primers.csv');
    const oldFasta = join(packageRoot, 'primers', 'Curated.primers.fasta');
    const userAsset = join(packageRoot, 'assets', 'gel.txt');
    mkdirSync(join(packageRoot, '.forge'), { recursive: true });
    mkdirSync(join(packageRoot, 'primers'), { recursive: true });
    mkdirSync(join(packageRoot, 'assets'), { recursive: true });
    writeFileSync(
      productPath,
      'LOCUS       old            4 bp    DNA\nORIGIN\n        1 aaaa\n//\n'
    );
    writeFileSync(oldCsv, 'stale csv');
    writeFileSync(oldFasta, '>stale\nAAAA\n');
    writeFileSync(userAsset, 'IRREPLACEABLE GEL');
    writeFileSync(
      markerPath,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'stable-package-id',
          name: 'Curated plasmid',
          product: {
            file: 'Curated.gb',
            sequenceChecksum: 'sha256:old-sequence',
            genBankChecksum: 'sha256:old-genbank',
          },
          assembly: {
            accepted: { designId: 'stale-design' },
            primers: {
              csv: 'primers/Curated.primers.csv',
              fasta: 'primers/Curated.primers.fasta',
            },
          },
        })
      )
    );
    writeFileSync(
      sourceFile,
      'LOCUS       replacement    8 bp    DNA\nORIGIN\n        1 acgtacgt\n//\n'
    );

    const result = await importFileIntoWorkspaceRoot(
      {
        targetRoot: root,
        sourcePath: sourceFile,
        dedup: { mode: 'replace', expectedRelPath: join('Curated', 'Curated.gb') },
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result.destPath).toBe(productPath);
    expect(result.replaced).toBe(true);
    expect(await readFile(productPath, 'utf8')).toContain('replacement');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      id: string;
      product: Record<string, unknown>;
      assembly?: unknown;
    };
    expect(marker.id).toBe('stable-package-id');
    expect(marker.assembly).toBeUndefined();
    expect(marker.product).toEqual({ file: 'Curated.gb' });
    expect(existsSync(oldCsv)).toBe(false);
    expect(existsSync(oldFasta)).toBe(false);
    expect(await readFile(userAsset, 'utf8')).toBe('IRREPLACEABLE GEL');
    expect(existsSync(join(root, 'Curated (1)'))).toBe(false);
  });

  it('copies into a non-managed known root WITHOUT committing', async () => {
    const root = join(tmp, 'plain-root');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );

    const result = await importFileIntoWorkspaceRoot(
      { targetRoot: root, sourcePath: sourceFile },
      { db, managedRootDir: managedRoot }
    );

    expect(result.committed).toBe(false);
    expect(existsSync(join(root, 'pUC19', 'pUC19.gb'))).toBe(true);
    expect(existsSync(join(root, '.git'))).toBe(false);
  });

  it('copies into a selected subfolder of a non-managed known root', async () => {
    const root = join(tmp, 'plain-root');
    const selectedFolder = join(root, 'sequences');
    mkdirSync(selectedFolder, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );

    const result = await importFileIntoWorkspaceRoot(
      { targetRoot: selectedFolder, sourcePath: sourceFile },
      { db, managedRootDir: managedRoot }
    );

    expect(result.committed).toBe(false);
    expect(result.destPath).toBe(join(selectedFolder, 'pUC19', 'pUC19.gb'));
    expect(existsSync(result.destPath)).toBe(true);
  });

  it('creates a sequence package inside a nested folder of an in-place workspace', async () => {
    const root = join(tmp, 'plain-content-root');
    const sequences = join(root, 'sequences');
    mkdirSync(sequences, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-content-root',
      root,
      Date.now()
    );

    const result = await importContentIntoWorkspaceRoot(
      {
        targetRoot: sequences,
        fileName: 'test.gb',
        content: 'LOCUS       test            0 bp    DNA     linear\nORIGIN\n//\n',
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result.committed).toBe(false);
    expect(result.destPath).toBe(join(sequences, 'test', 'test.gb'));
    expect(existsSync(join(sequences, 'test', '.forge', 'plasmid.json'))).toBe(true);
    expect(existsSync(join(root, 'test.gb'))).toBe(false);
  });

  it('rejects a target that is neither under the managed container nor a known root', async () => {
    const stranger = join(tmp, 'not-a-workspace');
    mkdirSync(stranger, { recursive: true });
    await expect(
      importFileIntoWorkspaceRoot(
        { targetRoot: stranger, sourcePath: sourceFile },
        {
          db,
          managedRootDir: managedRoot,
        }
      )
    ).rejects.toThrow(/unknown project root/i);
    expect(existsSync(join(stranger, 'pUC19.gb'))).toBe(false);
  });

  it('rejects a non-file source', async () => {
    const repoPath = await makeManagedRepo();
    const dir = join(tmp, 'a-directory');
    mkdirSync(dir, { recursive: true });
    await expect(
      importFileIntoWorkspaceRoot(
        { targetRoot: repoPath, sourcePath: dir },
        { db, managedRootDir: managedRoot }
      )
    ).rejects.toThrow(/non-file/i);
  });

  it('publishes the complete verified Quick Look package, including original members', async () => {
    const root = join(tmp, 'plain-root');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    const packageRoot = join(tmp, 'quick-look', 'package');
    const product = 'sample-f.gb';
    const original = 'contents/sample-f.dna';
    const productBytes =
      'LOCUS       sample-f       4 bp    DNA     linear SYN 01-JAN-2000\nORIGIN\n        1 acgt\n//\n';
    const originalBytes = Buffer.from([0x09, 0x00, 0xff, 0x44]);
    const marker = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'quick-look-package',
        name: 'sample-f',
        product: { file: product },
        members: [
          {
            id: 'original-snapgene',
            role: 'user',
            path: original,
            replaceable: false,
            createdAt: '2026-08-27T00:00:00.000Z',
          },
        ],
      })
    );
    mkdirSync(join(packageRoot, '.forge'), { recursive: true });
    mkdirSync(join(packageRoot, 'contents'), { recursive: true });
    writeFileSync(join(packageRoot, product), productBytes);
    writeFileSync(join(packageRoot, original), originalBytes);
    writeFileSync(join(packageRoot, '.forge', 'plasmid.json'), marker);

    const result = await importQuickLookPackageIntoWorkspaceRoot(
      {
        recordId: sha256('record:sample-f'),
        packageRoot,
        productRelativePath: product,
        files: [
          { relativePath: '.forge/plasmid.json', sha256: sha256(marker) },
          { relativePath: original, sha256: sha256(originalBytes) },
          { relativePath: product, sha256: sha256(productBytes) },
        ],
      },
      root,
      {
        db,
        managedRootDir: managedRoot,
        promotionJournalRoot: join(tmp, 'quick-look-promotions'),
      }
    );

    expect(result.destPath).toBe(join(root, 'sample-f', product));
    expect(await readFile(result.destPath, 'utf8')).toBe(productBytes);
    expect(await readFile(join(root, 'sample-f', original))).toEqual(originalBytes);
    expect(
      parseSequencePackageDocument(
        await readFile(join(root, 'sample-f', '.forge', 'plasmid.json'), 'utf8')
      ).members
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: original })]));
  });

  it('preserves empty-directory, regular-file, and symlink collisions', async () => {
    const root = join(tmp, 'plain-root');
    const symlinkTarget = join(tmp, 'symlink-target');
    mkdirSync(root, { recursive: true });
    mkdirSync(symlinkTarget, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    mkdirSync(join(root, 'reserved'));
    writeFileSync(join(root, 'reserved (1)'), 'keep this file');
    symlinkSync(
      symlinkTarget,
      join(root, 'reserved (2)'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const result = await importQuickLookPackageIntoWorkspaceRoot(
      makeQuickLookSnapshot('reserved'),
      root,
      {
        db,
        managedRootDir: managedRoot,
        promotionJournalRoot: join(tmp, 'quick-look-promotions'),
      }
    );

    expect(result.destPath).toBe(join(root, 'reserved (3)', 'reserved.gb'));
    expect((await readdir(join(root, 'reserved'))).length).toBe(0);
    expect(await readFile(join(root, 'reserved (1)'), 'utf8')).toBe('keep this file');
    expect(await realpath(join(root, 'reserved (2)'))).toBe(await realpath(symlinkTarget));
  });

  it('reuses the same verified destination after a completed promotion retry', async () => {
    const root = join(tmp, 'plain-root');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    const snapshot = makeQuickLookSnapshot('retry-safe');
    const deps = {
      db,
      managedRootDir: managedRoot,
      promotionJournalRoot: join(tmp, 'quick-look-promotions'),
    };

    const first = await importQuickLookPackageIntoWorkspaceRoot(snapshot, root, deps);
    const second = await importQuickLookPackageIntoWorkspaceRoot(snapshot, root, deps);

    expect(second.destPath).toBe(first.destPath);
    expect((await readdir(root)).filter((entry) => entry.startsWith('retry-safe'))).toEqual([
      'retry-safe',
    ]);
  });

  it('never deletes a completed package after the user edits its published product', async () => {
    const root = join(tmp, 'plain-root');
    const journalRoot = join(tmp, 'quick-look-promotions');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    const snapshot = makeQuickLookSnapshot('editable');
    const deps = { db, managedRootDir: managedRoot, promotionJournalRoot: journalRoot };
    const result = await importQuickLookPackageIntoWorkspaceRoot(snapshot, root, deps);
    const editedBytes = 'LOCUS edited-after-import 99 bp\n';
    writeFileSync(result.destPath, editedBytes);

    await recoverQuickLookPackagePromotions(journalRoot, deps);

    expect(existsSync(result.destPath)).toBe(true);
    expect(await readFile(result.destPath, 'utf8')).toBe(editedBytes);
    expect((await readdir(journalRoot)).filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
  });

  it('recovers an owned incomplete promotion before another workspace write can stage it', async () => {
    const root = join(tmp, 'plain-root');
    const journalRoot = join(tmp, 'quick-look-promotions');
    const candidateRoot = join(root, 'crash-recovery');
    const token = 'synthetic-quick-look-recovery-token';
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(journalRoot, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    writeFileSync(
      join(candidateRoot, '.dnaforge-quick-look-promotion.json'),
      `${JSON.stringify({ token })}\n`
    );
    writeFileSync(join(candidateRoot, 'partial.gb'), 'partial');
    const canonicalRoot = await realpath(root);
    const canonicalCandidateRoot = await realpath(candidateRoot);
    const candidateIdentity = await lstat(canonicalCandidateRoot, { bigint: true });
    const recordKey = 'a'.repeat(64);
    writeFileSync(
      join(journalRoot, `${recordKey}.json`),
      `${JSON.stringify({
        schema: 'dnaforge.quick-look-promotion.v2',
        state: 'active',
        recordKey,
        token,
        realTarget: canonicalRoot,
        candidateRoot: canonicalCandidateRoot,
        candidateName: 'crash-recovery',
        candidateDevice: candidateIdentity.dev.toString(),
        candidateInode: candidateIdentity.ino.toString(),
        productRelativePath: 'crash-recovery.gb',
        files: [{ relativePath: 'crash-recovery.gb', sha256: '0'.repeat(64) }],
        committed: false,
      })}\n`
    );

    await recoverQuickLookPackagePromotions(journalRoot, { db, managedRootDir: managedRoot });

    expect(existsSync(candidateRoot)).toBe(false);
    expect(existsSync(join(journalRoot, `${recordKey}.json`))).toBe(false);
  });

  it('does not sweep another workspace recovery journal during a live import', async () => {
    const firstRoot = join(tmp, 'workspace-a');
    const secondRoot = join(tmp, 'workspace-b');
    const journalRoot = join(tmp, 'quick-look-promotions');
    const candidateRoot = join(secondRoot, 'interrupted-b');
    const token = 'workspace-b-owner';
    const recordKey = '9'.repeat(64);
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(journalRoot, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'workspace-a',
      firstRoot,
      Date.now()
    );
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'workspace-b',
      secondRoot,
      Date.now()
    );
    writeFileSync(
      join(candidateRoot, '.dnaforge-quick-look-promotion.json'),
      `${JSON.stringify({ token })}\n`
    );
    writeFileSync(join(candidateRoot, 'partial.gb'), 'partial');
    const canonicalSecondRoot = await realpath(secondRoot);
    const canonicalCandidateRoot = await realpath(candidateRoot);
    const identity = await lstat(canonicalCandidateRoot, { bigint: true });
    const journalPath = join(journalRoot, `${recordKey}.json`);
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schema: 'dnaforge.quick-look-promotion.v2',
        state: 'active',
        recordKey,
        token,
        realTarget: canonicalSecondRoot,
        candidateRoot: canonicalCandidateRoot,
        candidateName: 'interrupted-b',
        candidateDevice: identity.dev.toString(),
        candidateInode: identity.ino.toString(),
        productRelativePath: 'partial.gb',
        files: [{ relativePath: 'partial.gb', sha256: '0'.repeat(64) }],
        committed: false,
      })}\n`
    );

    await importQuickLookPackageIntoWorkspaceRoot(
      makeQuickLookSnapshot('workspace-a-sequence'),
      firstRoot,
      { db, managedRootDir: managedRoot, promotionJournalRoot: journalRoot }
    );

    expect(existsSync(candidateRoot)).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it('never recursively removes an unmarked crash reservation after content appears', async () => {
    const root = join(tmp, 'plain-root');
    const journalRoot = join(tmp, 'quick-look-promotions');
    const candidateRoot = join(root, 'unmarked-reservation');
    const recordKey = 'c'.repeat(64);
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(journalRoot, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    writeFileSync(join(candidateRoot, 'user-data.txt'), 'must survive');
    const canonicalRoot = await realpath(root);
    const canonicalCandidateRoot = await realpath(candidateRoot);
    const candidateIdentity = await lstat(canonicalCandidateRoot, { bigint: true });
    writeFileSync(
      join(journalRoot, `${recordKey}.json`),
      `${JSON.stringify({
        schema: 'dnaforge.quick-look-promotion.v2',
        state: 'active',
        recordKey,
        token: 'marker-was-never-written',
        realTarget: canonicalRoot,
        candidateRoot: canonicalCandidateRoot,
        candidateName: 'unmarked-reservation',
        candidateDevice: candidateIdentity.dev.toString(),
        candidateInode: candidateIdentity.ino.toString(),
        productRelativePath: 'unmarked.gb',
        files: [{ relativePath: 'unmarked.gb', sha256: '0'.repeat(64) }],
        committed: false,
      })}\n`
    );

    await recoverQuickLookPackagePromotions(journalRoot, { db, managedRootDir: managedRoot });

    expect(await readFile(join(candidateRoot, 'user-data.txt'), 'utf8')).toBe('must survive');
    expect(existsSync(join(journalRoot, `${recordKey}.json`))).toBe(true);
  });

  it('does not stage an active Quick Look promotion in an unrelated managed commit', async () => {
    const repoPath = await makeManagedRepo();
    const candidateRoot = join(repoPath, 'partial-promotion');
    mkdirSync(candidateRoot, { recursive: true });
    writeFileSync(
      join(candidateRoot, '.dnaforge-quick-look-promotion.json'),
      `${JSON.stringify({ token: 'active' })}\n`
    );
    writeFileSync(join(candidateRoot, 'partial.gb'), 'partial package bytes');
    writeFileSync(join(repoPath, 'ordinary-note.txt'), 'commit me');

    const activeWriteLease = await beginQuickLookPromotionWrite(candidateRoot);
    try {
      await commitAllIfDirty(repoPath, 'Unrelated workspace change', {
        forceInclude: [
          join(candidateRoot, 'partial.gb'),
          join(candidateRoot, '.dnaforge-quick-look-promotion.json'),
        ],
      });
    } finally {
      activeWriteLease.release();
    }

    const tracked = await listFilesAtHead(repoPath);
    expect(tracked).toContain('ordinary-note.txt');
    expect(tracked).not.toContain('partial-promotion/partial.gb');
    expect(tracked).not.toContain('partial-promotion/.dnaforge-quick-look-promotion.json');
  });

  it('retains recovery state and user data when the candidate identity does not match', async () => {
    const root = join(tmp, 'plain-root');
    const journalRoot = join(tmp, 'quick-look-promotions');
    const candidateRoot = join(root, 'replacement');
    const token = 'replacement-token';
    const recordKey = 'b'.repeat(64);
    mkdirSync(candidateRoot, { recursive: true });
    mkdirSync(journalRoot, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    writeFileSync(
      join(candidateRoot, '.dnaforge-quick-look-promotion.json'),
      `${JSON.stringify({ token })}\n`
    );
    writeFileSync(join(candidateRoot, 'user-data.txt'), 'must survive');
    const canonicalRoot = await realpath(root);
    const canonicalCandidateRoot = await realpath(candidateRoot);
    writeFileSync(
      join(journalRoot, `${recordKey}.json`),
      `${JSON.stringify({
        schema: 'dnaforge.quick-look-promotion.v2',
        state: 'active',
        recordKey,
        token,
        realTarget: canonicalRoot,
        candidateRoot: canonicalCandidateRoot,
        candidateName: 'replacement',
        candidateDevice: '999999999999',
        candidateInode: '999999999999',
        productRelativePath: 'replacement.gb',
        files: [{ relativePath: 'replacement.gb', sha256: '0'.repeat(64) }],
        committed: false,
      })}\n`
    );

    await recoverQuickLookPackagePromotions(journalRoot, { db, managedRootDir: managedRoot });

    expect(await readFile(join(candidateRoot, 'user-data.txt'), 'utf8')).toBe('must survive');
    expect(existsSync(join(journalRoot, `${recordKey}.json`))).toBe(true);
  });

  it('retains recovery state while an external destination is unavailable', async () => {
    const journalRoot = join(tmp, 'quick-look-promotions');
    const unavailableTarget = join(tmp, 'external-volume', 'workspace');
    const recordKey = 'c'.repeat(64);
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(
      join(journalRoot, `${recordKey}.json`),
      `${JSON.stringify({
        schema: 'dnaforge.quick-look-promotion.v2',
        state: 'completed',
        recordKey,
        token: 'unavailable-token',
        realTarget: unavailableTarget,
        candidateRoot: join(unavailableTarget, 'sequence'),
        candidateName: 'sequence',
        candidateDevice: '1',
        candidateInode: '1',
        productRelativePath: 'sequence.gb',
        files: [{ relativePath: 'sequence.gb', sha256: '0'.repeat(64) }],
        committed: false,
      })}\n`
    );

    await recoverQuickLookPackagePromotions(journalRoot, { db, managedRootDir: managedRoot });

    expect(existsSync(join(journalRoot, `${recordKey}.json`))).toBe(true);
  });

  it('removes its reserved destination and publishes nothing when a package hash is wrong', async () => {
    const root = join(tmp, 'plain-root');
    mkdirSync(root, { recursive: true });
    db.prepare('INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)').run(
      'plain-root',
      root,
      Date.now()
    );
    const packageRoot = join(tmp, 'quick-look', 'package');
    const product = 'tampered.gb';
    const marker = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'quick-look-tampered',
        name: 'tampered',
        product: { file: product },
      })
    );
    mkdirSync(join(packageRoot, '.forge'), { recursive: true });
    writeFileSync(join(packageRoot, product), 'LOCUS tampered 4 bp\n');
    writeFileSync(join(packageRoot, '.forge', 'plasmid.json'), marker);

    await expect(
      importQuickLookPackageIntoWorkspaceRoot(
        {
          recordId: sha256('record:tampered'),
          packageRoot,
          productRelativePath: product,
          files: [
            { relativePath: '.forge/plasmid.json', sha256: sha256(marker) },
            { relativePath: product, sha256: '0'.repeat(64) },
          ],
        },
        root,
        {
          db,
          managedRootDir: managedRoot,
          promotionJournalRoot: join(tmp, 'quick-look-promotions'),
        }
      )
    ).rejects.toThrow('changed while copying');
    expect(existsSync(join(root, 'tampered'))).toBe(false);
    expect((await readdir(root)).filter((entry) => entry.includes('.quick-look-'))).toEqual([]);
    expect(hasActiveQuickLookPromotion(root)).toBe(false);
    expect(isQuickLookPromotionMutationBlocked(root)).toBe(false);
  });
});
