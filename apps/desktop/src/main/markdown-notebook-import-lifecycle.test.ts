// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { MarkdownNotebookImporter } from './markdown-notebook-import';
import { notebookPackagePaths } from '../db/notebook-package';
let fixture: ReturnType<typeof createFileTestDb>;
let root: string;
let importer: MarkdownNotebookImporter;
vi.mock('./ipc/database', () => ({ getDb: () => fixture.db }));
const createImporter = () =>
  new MarkdownNotebookImporter({
    db: () => fixture.db,
    roots: () => [root],
    captureWorkspace: () => () => {},
    withCleanPaths: async (_paths, operation) => operation(),
    settleMs: 0,
  });
beforeEach(async () => {
  fixture = createFileTestDb('markdown-lifecycle');
  ensureSchema(fixture.db, fixture.dbPath);
  root = await realpath(fixture.tmpDir);
  fixture.db
    .prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,?,?,?,1)')
    .run('Markdown lifecycle', root, 'markdown-lifecycle');
  importer = createImporter();
});
afterEach(async () => {
  await importer.close();
  fixture.cleanup();
});

describe('Markdown adoption recovery and continued external editing', () => {
  it('coordinates independent native owners through the same source claim', async () => {
    const path = join(root, 'Report.md');
    await writeFile(path, '# Report\n\nOne shared document.');
    const other = createImporter();
    try {
      const [first, second] = await Promise.all([
        importer.adopt({ workspaceRoot: root, path }),
        other.adopt({ workspaceRoot: root, path }),
      ]);
      expect(first?.pageId).toBe(second?.pageId);
      expect((await readdir(root)).filter((name) => name.startsWith('Report'))).toEqual(['Report']);
    } finally {
      await other.close();
    }
  });
  it('retains writes through a file handle opened before packaging', async () => {
    const path = join(root, 'Report.md');
    await writeFile(path, '# Report\n\nFirst revision.\n');
    const handle = await open(path, 'a');
    try {
      const first = await importer.adopt({ workspaceRoot: root, path });
      await handle.write('\nAdded through the original handle.\n');
      const updated = await importer.adopt({ workspaceRoot: root, path });
      expect(updated?.pageId).toBe(first?.pageId);
      expect(await readFile(notebookPackagePaths(first!.path).markdownPath, 'utf8')).toContain(
        'Added through the original handle.'
      );
    } finally {
      await handle.close();
    }
  });

  it('accepts a repeated identical source without another notebook or an archive collision', async () => {
    const path = join(root, 'Report.md');
    const markdown = '# Report\n\nSame content.\n';
    await writeFile(path, markdown);
    const first = await importer.adopt({ workspaceRoot: root, path });
    await writeFile(path, markdown);
    expect(await importer.adopt({ workspaceRoot: root, path })).toMatchObject({
      pageId: first!.pageId,
    });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM pages').get()).toEqual({ count: 1 });
  });

  it('resumes publication from the preserved source with its original identity', async () => {
    const path = join(root, 'Report.md');
    await writeFile(path, '# Report\n\nRecover this source.\n');
    const first = await importer.adopt({ workspaceRoot: root, path });
    await importer.close();
    const directory = join(root, '.forge', 'markdown-imports');
    const receiptPath = join(directory, (await readdir(directory))[0]);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    delete receipt.canonicalFingerprint;
    await writeFile(receiptPath, JSON.stringify(receipt));
    const paths = notebookPackagePaths(first!.path);
    await unlink(paths.markdownPath);
    await unlink(paths.metaPath);
    importer = createImporter();
    expect(await importer.adopt({ workspaceRoot: root, path })).toMatchObject({
      pageId: first!.pageId,
    });
    expect(await readFile(paths.markdownPath, 'utf8')).toContain('Recover this source.');
  });

  it('keeps two images with the same filename and different bytes', async () => {
    for (const [folder, text] of [
      ['a', 'first-image'],
      ['b', 'second-image'],
    ]) {
      await mkdir(join(root, folder));
      await writeFile(join(root, folder, 'gel image.png'), text);
    }
    const path = join(root, 'Report.md');
    await writeFile(
      path,
      '# Report\n\n![First](<a/gel image.png>)\n\n![Second](<b/gel image.png>)\n'
    );
    const imported = await importer.adopt({ workspaceRoot: root, path });
    const directory = notebookPackagePaths(imported!.path).assetsDir;
    const bodies = await Promise.all(
      (await readdir(directory)).map((name) => readFile(join(directory, name), 'utf8'))
    );
    expect(bodies.sort()).toEqual(['first-image', 'second-image']);
  });

  it('refuses a linked source and preserves the target', async () => {
    const target = join(root, 'original.txt');
    await writeFile(target, '# Keep original');
    const path = join(root, 'Linked.md');
    await symlink(target, path);
    await expect(importer.adopt({ workspaceRoot: root, path })).rejects.toThrow(
      /physical|symbolic/i
    );
    expect(await readFile(target, 'utf8')).toBe('# Keep original');
  });

  it('does not mutate a read-only owning project', async () => {
    const path = join(root, 'Report.md');
    await writeFile(path, '# Read-only report');
    fixture.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    await expect(importer.adopt({ workspaceRoot: root, path })).rejects.toThrow(
      /writable|read.only/i
    );
    expect(await readFile(path, 'utf8')).toBe('# Read-only report');
  });
});

describe('canonical Markdown scenario Git baseline', () => {
  it('commits both real primer guides after native adoption and remains clean on the next scan', async () => {
    const {
      primerFileAuthorityWorkspace,
      PRIMER_FILE_AUTHORITY_GUIDE_PATH,
      PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT,
    } = await import('../test/scenarios/primer-file-authority');
    root = join(root, 'repo');
    await mkdir(root);
    fixture.db.prepare('UPDATE workspaces SET path=? WHERE id=7').run(root);
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init']);
    git(['config', 'user.name', 'DNAForge fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    const scenario = primerFileAuthorityWorkspace();
    const guide = scenario.files?.[PRIMER_FILE_AUTHORITY_GUIDE_PATH];
    const readme = scenario.files?.[`${PRIMER_FILE_AUTHORITY_WORKSPACE_ROOT}/primers/README.md`];
    if (typeof guide !== 'string' || typeof readme !== 'string')
      throw new Error('The real primer guides are missing.');
    await mkdir(join(root, 'primers'));
    const originals = new Map([
      ['PROOF.md', guide],
      ['primers/README.md', readme],
    ]);
    const identities: Array<string | undefined> = [];
    for (const [relative, content] of originals) {
      const path = join(root, relative);
      await writeFile(path, content);
      const adopted = await importer.adopt({ workspaceRoot: root, path });
      identities.push(adopted?.pageId);
      expect(adopted).not.toBeNull();
      expect(await readFile(notebookPackagePaths(adopted!.path).markdownPath, 'utf8')).toContain(
        relative === 'PROOF.md' ? '## What success looks like' : '# Primer artifacts'
      );
    }
    expect(fixture.db.prepare('SELECT count(*) AS count FROM pages').get()).toEqual({ count: 2 });
    const receipts = join(root, '.forge', 'markdown-imports');
    for (const name of await readdir(receipts)) {
      const receipt = JSON.parse(await readFile(join(receipts, name), 'utf8'));
      const archived = await readFile(
        join(root, receipt.destination, receipt.archives[0].path),
        'utf8'
      );
      expect(archived).toBe(originals.get(receipt.source));
    }
    git(['add', '--all']);
    git([
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Initialize primer file authority proof workspace',
    ]);
    expect(git(['status', '--porcelain'])).toBe('');
    await importer.scan(root);
    expect(git(['status', '--porcelain'])).toBe('');
    const repeated = await Promise.all(
      [...originals.keys()].map((relative) =>
        importer.adopt({ workspaceRoot: root, path: join(root, relative) })
      )
    );
    expect(repeated.map((entry) => entry?.pageId)).toEqual(identities);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM pages').get()).toEqual({ count: 2 });
  });
});
