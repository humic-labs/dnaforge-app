import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec as git } from 'dugite';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false, on: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: { showItemInFolder: vi.fn(), trashItem: vi.fn() },
}));
vi.mock('./database', () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) }) }));
vi.mock('../features/native-documents', () => ({ nativeDocuments: {} }));
vi.mock('./path-allowlist', () => ({
  assertSafePath: async (path: string) => path,
  getAllowedRoots: () => ['/tmp'],
}));

import { ipcMain } from 'electron';
import { registerShellHandlers } from './shell';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('real shell status never runs repository fsmonitor while returning changed files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'untrusted-shell-repository-')));
  roots.push(root);
  const marker = join(root, 'executed');
  const helper = join(root, 'monitor.cjs');
  await writeFile(
    helper,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`
  );
  await writeFile(join(root, 'notes.txt'), 'before');
  expect((await git(['-c', 'init.templateDir=', 'init'], root)).exitCode).toBe(0);
  expect((await git(['add', '--', 'notes.txt'], root)).exitCode).toBe(0);
  await writeFile(join(root, 'notes.txt'), 'after');
  expect(
    (await git(['config', 'core.fsmonitor', `"${process.execPath}" "${helper}"`], root)).exitCode
  ).toBe(0);
  registerShellHandlers();
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get('shell:execute');
  if (!handler) throw new Error('Missing shell:execute');
  const result = await handler(
    { sender: { id: 7 } } as never,
    'git',
    ['status', '--porcelain'],
    root
  );
  expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('notes.txt') });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('after');
});
