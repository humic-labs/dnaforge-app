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
import { importFileAsNewManagedWorkspace } from './workspace-git/import';
import { registerWorkspaceGitHandlers } from './ipc/workspace-git';
import type { ImportFileRequest, ImportFileResult } from '../shared/workspace-git-types';
import { createTestDb } from './__tests__/test-db';
import { readProjectSourceDocumentPackage } from './source-document-package-store';
import { ensureSchema } from './schema';

const harness = vi.hoisted(() => ({
  db: null as ReturnType<typeof createTestDb> | null,
  profile: '',
  importFile: undefined as
    | undefined
    | ((event: unknown, request: ImportFileRequest) => Promise<ImportFileResult>),
}));
vi.mock('../shared/ipc-contract', async (original) => ({
  ...(await original<typeof import('../shared/ipc-contract')>()),
  handleGroup: (_: unknown, handlers: { importFile?: typeof harness.importFile }) => {
    if (handlers.importFile) harness.importFile = handlers.importFile;
  },
}));
vi.mock('./ipc/database', () => ({ getDb: () => harness.db }));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => harness.profile },
  dialog: {},
}));

it('previews and imports only the chosen file when its volume is outside the ordinary roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'external-preview-read-'));
  const sourcePath = join(directory, 'read.faa');
  const other = join(directory, 'other.faa');
  const selectedFolder = join(directory, 'folder.faa');
  const db = createTestDb();
  harness.db = db;
  harness.profile = join(directory, 'profile');
  registerWorkspaceGitHandlers();
  const outsideRoots = async () => {
    throw new Error('Outside ordinary roots');
  };
  try {
    ensureSchema(db, ':memory:');
    await mkdir(selectedFolder);
    await writeFile(sourcePath, '>selected\nPEPTIDE*\n');
    await writeFile(other, '>other\nMLKL\n');
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
    const deps = { db, managedRootDir: join(harness.profile, 'managed-workspaces') };
    const project = await importFileAsNewManagedWorkspace(request, deps);
    expect(
      Buffer.from(
        (await readProjectSourceDocumentPackage(project.repoPath, project.entryPath!)).bytes
      )
    ).toEqual(Buffer.from(bytes));
    const copy = await harness.importFile!(null, { ...request, targetRoot: project.repoPath });
    expect(
      Buffer.from((await readProjectSourceDocumentPackage(project.repoPath, copy.destPath)).bytes)
    ).toEqual(Buffer.from(bytes));
    expect(await readFile(sourcePath)).toEqual(Buffer.from(bytes));
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
