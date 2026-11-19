import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import {
  admitFileImportSource,
  rememberSelectedPreviewFile,
  resolvePreviewSource,
} from './selected-preview-files';
import {
  importFileAsNewManagedWorkspace,
  importFileIntoWorkspaceRoot,
} from './workspace-git/import';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => tmpdir() },
  dialog: {},
}));

it('previews and imports only the chosen file when its volume is outside the ordinary roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'external-preview-read-'));
  const sourcePath = join(directory, 'read.ab1');
  const other = join(directory, 'other.ab1');
  const selectedFolder = join(directory, 'folder.ab1');
  const db = createTestDb();
  const outsideRoots = async () => {
    throw new Error('Outside ordinary roots');
  };
  try {
    ensureSchema(db, ':memory:');
    await mkdir(selectedFolder);
    await writeFile(sourcePath, 'selected trace bytes');
    await writeFile(other, 'other trace bytes');
    await expect(resolvePreviewSource(sourcePath, outsideRoots)).rejects.toThrow(
      'Outside ordinary roots'
    );
    rememberSelectedPreviewFile(sourcePath);
    rememberSelectedPreviewFile(selectedFolder);
    await expect(resolvePreviewSource(other, outsideRoots)).rejects.toThrow(
      'Outside ordinary roots'
    );
    await expect(resolvePreviewSource(selectedFolder, outsideRoots)).rejects.toThrow(
      'Outside ordinary roots'
    );
    await expect(admitFileImportSource({ sourcePath }, outsideRoots)).rejects.toThrow(
      'Outside ordinary roots'
    );
    const admitted = await resolvePreviewSource(sourcePath, outsideRoots);
    expect(admitted).toBe(await realpath(sourcePath));
    const bytes = await readFileBoundedFromHandle(admitted, 1024);
    await expect(readFileBoundedFromHandle(admitted, 4)).rejects.toThrow('bounded read limit');
    const expectedSourceSha256 = createHash('sha256').update(bytes).digest('hex');
    const request = await admitFileImportSource(
      { sourcePath, preserveOriginal: true, expectedSourceSha256 },
      outsideRoots
    );
    const deps = { db, managedRootDir: join(directory, 'managed') };
    const project = await importFileAsNewManagedWorkspace(request, deps);
    expect(await readFile(project.entryPath!)).toEqual(Buffer.from(bytes));
    const copy = await importFileIntoWorkspaceRoot(
      { ...request, targetRoot: project.repoPath },
      deps
    );
    expect(await readFile(copy.destPath)).toEqual(Buffer.from(bytes));
    expect(await readFile(sourcePath)).toEqual(Buffer.from(bytes));
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
