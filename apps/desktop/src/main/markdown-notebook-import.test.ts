// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile, access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
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
beforeEach(async () => {
  fixture = createFileTestDb('markdown-adoption');
  ensureSchema(fixture.db, fixture.dbPath);
  root = await realpath(fixture.tmpDir);
  fixture.db
    .prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,?,?,?,1)')
    .run('Markdown project', root, 'markdown-project');
  importer = new MarkdownNotebookImporter({
    db: () => fixture.db,
    roots: () => [root],
    captureWorkspace: () => () => {},
    withCleanPaths: async (_paths, operation) => operation(),
    settleMs: 0,
  });
});
afterEach(async () => {
  await importer.close();
  fixture.cleanup();
});

describe('native Markdown notebook adoption', () => {
  it('retains literal percent filenames and packages images with URL query strings', async () => {
    const source = join(root, 'URLs.md');
    await mkdir(join(root, 'figures'));
    const bytes = Buffer.from([0, 1, 2, 3]);
    await writeFile(join(root, 'figures', 'gel.png'), bytes);
    await writeFile(
      source,
      '# URLs\n\n[Data](100%yield.csv)\n\n[Spaced](spaced%20name.csv?download=1#row)\n\n![Gel](figures/gel.png?raw=1#preview)\n'
    );
    const adopted = await importer.adopt({ workspaceRoot: root, path: source });
    const markdown = await readFile(notebookPackagePaths(adopted!.path).markdownPath, 'utf8');
    expect(markdown).toContain('../100%25yield.csv');
    expect(markdown).toContain('../spaced%20name.csv?download=1#row');
    expect(await readFile(join(adopted!.path, 'assets', 'gel.png'))).toEqual(bytes);
  });
  it('publishes a normal package, portable image, native projection and stable repeated-open identity', async () => {
    const source = join(root, 'Report.md');
    await mkdir(join(root, 'figures'));
    const bytes = Buffer.from([0, 1, 2, 3]);
    await writeFile(join(root, 'figures', 'gel.png'), bytes);
    await writeFile(
      source,
      '# Report\n\n**Result**\n\n![Gel](figures/gel.png)\n\n[Data](data.csv)\n'
    );
    const adopted = await importer.adopt({ workspaceRoot: root, path: source });
    expect(adopted?.path).toBe(join(root, 'Report'));
    const paths = notebookPackagePaths(adopted!.path);
    const markdown = await readFile(paths.markdownPath, 'utf8');
    expect(markdown).toContain('**Result**');
    expect(markdown).toContain('../data.csv');
    expect(await readFile(join(adopted!.path, 'assets', 'gel.png'))).toEqual(bytes);
    expect(JSON.parse(await readFile(paths.metaPath, 'utf8')).formatVersion).toBe(2);
    expect(await importer.adopt({ workspaceRoot: root, path: source })).toMatchObject({
      pageId: adopted!.pageId,
    });
    expect(fixture.db.prepare('SELECT id FROM pages').all()).toEqual([{ id: adopted!.pageId }]);
    await expect(access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not convert instructions, existing package members, or overwrite a colliding destination', async () => {
    const instruction = join(root, 'AGENTS.md');
    await writeFile(instruction, '# Instructions');
    expect(await importer.adopt({ workspaceRoot: root, path: instruction })).toBeNull();
    await mkdir(join(root, 'Report'));
    await writeFile(join(root, 'Report', 'keep.txt'), 'keep');
    const source = join(root, 'Report.markdown');
    await writeFile(source, '# Report\n\nOriginal');
    const adopted = await importer.adopt({ workspaceRoot: root, path: source });
    expect(adopted?.path).toBe(join(root, 'Report (2)'));
    expect(await readFile(join(root, 'Report', 'keep.txt'), 'utf8')).toBe('keep');
    expect(
      await importer.adopt({
        workspaceRoot: root,
        path: notebookPackagePaths(adopted!.path).markdownPath,
      })
    ).toMatchObject({ pageId: adopted!.pageId });
  });
  it('continues an external agent write at the original source path without creating another notebook', async () => {
    const path = join(root, 'Report.md');
    await writeFile(path, '# Report\n\nFirst');
    const first = await importer.adopt({ workspaceRoot: root, path });
    await writeFile(path, '# Report\n\nSecond **revision**');
    const second = await importer.adopt({ workspaceRoot: root, path });
    expect(second?.pageId).toBe(first?.pageId);
    expect(await readFile(notebookPackagePaths(first!.path).markdownPath, 'utf8')).toContain(
      'Second **revision**'
    );
    expect(fixture.db.prepare('SELECT count(*) AS count FROM pages').get()).toEqual({ count: 1 });
  });
  it('preserves a competing notebook revision and the newly written source', async () => {
    const path = join(root, 'Report.md');
    await writeFile(path, '# Report\n\nOriginal');
    const first = await importer.adopt({ workspaceRoot: root, path });
    await writeFile(notebookPackagePaths(first!.path).markdownPath, '# Report\n\nHuman revision');
    await writeFile(path, '# Report\n\nAgent revision');
    await expect(importer.adopt({ workspaceRoot: root, path })).rejects.toThrow(
      /changed|conflict/i
    );
    expect(await readFile(path, 'utf8')).toContain('Agent revision');
    expect(await readFile(notebookPackagePaths(first!.path).markdownPath, 'utf8')).toContain(
      'Human revision'
    );
  });
  it('serializes competing discovery requests and recovers the same identity after restart', async () => {
    const path = join(root, 'Report.MD');
    await writeFile(path, '# Report\n\nConcurrent');
    const results = await Promise.all([
      importer.adopt({ workspaceRoot: root, path }),
      importer.adopt({ workspaceRoot: root, path }),
    ]);
    expect(results[0]?.pageId).toBe(results[1]?.pageId);
    await importer.close();
    importer = new MarkdownNotebookImporter({
      db: () => fixture.db,
      roots: () => [root],
      captureWorkspace: () => () => {},
      withCleanPaths: async (_paths, operation) => operation(),
      settleMs: 0,
    });
    expect(await importer.adopt({ workspaceRoot: root, path })).toMatchObject({
      pageId: results[0]!.pageId,
    });
  });
});
