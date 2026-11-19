import { it, expect } from 'vitest';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { notebookPackagePaths } from '../db/notebook-package';
import { publishNotebookPackageV2InMain } from './notebook-package-authority';
import { restoreSavedFileSource } from './saved-file-sources';

it('can reopen the first and edited notebook packages after loss of the working directory', async () => {
  const { db, dbPath, tmpDir, cleanup } = createFileTestDb('saved-notebook-versions');
  const workspaceRoot = join(tmpDir, 'Project');
  const packageRoot = join(workspaceRoot, 'Notebook');
  const input = { workspaceRoot, packageRoot, id: 'book', title: 'Notebook' };
  const document = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  try {
    ensureSchema(db, dbPath);
    await mkdir(packageRoot, { recursive: true });
    db.prepare(
      "INSERT INTO workspaces(id,repo_uuid,name,path,created_at) VALUES(1,'test-project','Project',?,1)"
    ).run(workspaceRoot);
    const paths = notebookPackagePaths(packageRoot);
    await mkdir(paths.assetsDir, { recursive: true });
    const attachment = new Uint8Array([0, 3, 168, 255]);
    await writeFile(join(paths.assetsDir, 'raw.bin'), attachment);
    await publishNotebookPackageV2InMain(
      { ...input, content: document('original text'), sourceShape: 'new-package' },
      undefined,
      db
    );
    const original = await readFile(paths.markdownPath);
    await publishNotebookPackageV2InMain(
      {
        ...input,
        content: document('changed text'),
        sourceShape: 'v2-package',
        existingMetadataRaw: await readFile(paths.metaPath, 'utf8'),
      },
      undefined,
      db
    );
    const edited = await readFile(paths.markdownPath);
    expect(edited.equals(original)).toBe(false);
    await rename(packageRoot, join(tmpDir, 'unavailable-source'));
    const owner = { workspaceId: 1, entityId: 'test-project::book' };
    const receipts = db
      .prepare(
        "SELECT id FROM retained_file_source_revisions WHERE workspace_id=1 AND entity_id=? AND status='committed' ORDER BY rowid"
      )
      .all(owner.entityId) as { id: string }[];
    expect(receipts).toHaveLength(2);
    for (const [index, bytes] of [original, edited].entries()) {
      const destination = join(tmpDir, String(index), 'Notebook');
      await mkdir(dirname(destination));
      await restoreSavedFileSource(db, { ...owner, revisionId: receipts[index].id, destination });
      const restored = notebookPackagePaths(destination);
      expect(await readFile(restored.markdownPath)).toEqual(bytes);
      expect(new Uint8Array(await readFile(join(restored.assetsDir, 'raw.bin')))).toEqual(
        attachment
      );
    }
  } finally {
    cleanup();
  }
});
