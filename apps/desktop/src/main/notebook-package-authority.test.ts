import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { notebookPackagePaths } from '../db/notebook-package';
import { publishNotebookPackageV2InMain } from './__tests__/publish-notebook-fixture';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function content(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

const TABLE_CONTENT = {
  type: 'doc',
  content: [
    {
      type: 'embed',
      attrs: {
        type: 'table',
        refId: 'table-1',
        data: { rows: 1, cols: 1, cells: { A1: { value: 'result' } } },
      },
    },
  ],
};

describe('main-process notebook package authority', () => {
  it.each(['.forge', '.forge/blocks', '.forge/migrations'])(
    'rejects a symlinked managed directory at %s without touching its target',
    async (relativeManagedPath) => {
      const workspaceRoot = await temporaryRoot('dnaforge-notebook-workspace-');
      const outsideRoot = await temporaryRoot('dnaforge-notebook-outside-');
      const packageRoot = join(workspaceRoot, 'Notebook');
      const managedPath = join(packageRoot, relativeManagedPath);
      await mkdir(join(managedPath, '..'), { recursive: true });
      await writeFile(join(outsideRoot, 'canary.txt'), 'outside bytes');
      await symlink(outsideRoot, managedPath, 'dir');

      await expect(
        publishNotebookPackageV2InMain({
          packageRoot,
          workspaceRoot,
          id: 'notebook-1',
          title: 'Notebook',
          content: content('body'),
          sourceShape: 'new-package',
        })
      ).rejects.toThrow(/symbolic links|escaped|package/i);

      expect(await readFile(join(outsideRoot, 'canary.txt'), 'utf8')).toBe('outside bytes');
      expect(await readdir(outsideRoot)).toEqual(['canary.txt']);
    }
  );

  it('removes successful-save stages but retains immutable published payload history', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-workspace-');
    const packageRoot = join(workspaceRoot, 'Notebook');
    await mkdir(packageRoot, { recursive: true });

    await publishNotebookPackageV2InMain({
      packageRoot,
      workspaceRoot,
      id: 'notebook-1',
      title: 'Notebook',
      content: TABLE_CONTENT,
      sourceShape: 'new-package',
    });
    const paths = notebookPackagePaths(packageRoot);
    const oldPayloads = await readdir(paths.blocksDir);
    expect(oldPayloads).toHaveLength(1);
    expect((await readdir(paths.metaDir)).some((name) => name.includes('dnaforge-stage'))).toBe(
      false
    );

    await publishNotebookPackageV2InMain({
      packageRoot,
      workspaceRoot,
      id: 'notebook-1',
      title: 'Notebook',
      content: content('plain replacement'),
      sourceShape: 'v2-package',
      existingMetadataRaw: await readFile(paths.metaPath, 'utf8'),
      formerAuthorityRaw: null,
    });

    expect(await readdir(paths.blocksDir)).toEqual(expect.arrayContaining(oldPayloads));
    expect((await readdir(paths.metaDir)).some((name) => name.includes('dnaforge-stage'))).toBe(
      false
    );
  });
});
