import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TerminalFileSearch } from './file-search';
import { NativeDocumentWorkspaces } from '../native-document-workspaces';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function workspace() {
  const path = await mkdtemp(join(tmpdir(), 'terminal-file-search-'));
  directories.push(path);
  return realpath(path);
}
async function file(root: string, name: string) {
  const path = join(root, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'FIRST\nSECOND\nTHIRD\n');
  return path;
}

describe('native terminal project filename lookup', () => {
  it('refuses results after the native project enrollment is removed', async () => {
    const root = await workspace();
    await file(root, 'nested/notes.txt');
    const access = new NativeDocumentWorkspaces({ resolveRoot: realpath });
    await access.replaceRoots([root]);
    let release!: (path: string) => void;
    const search = new TerminalFileSearch({
      admitRoot: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      captureRoot: (path) => access.capture(path),
    });
    const pending = search.find(1, 'owned', {
      requestId: randomUUID(),
      roots: [root],
      query: 'notes.txt',
    });
    await access.replaceRoots([]);
    release(root);
    await expect(pending).rejects.toThrow(/workspace|enrollment/i);
  });
  it('finds ordinary files, preserves ambiguity and treats glob syntax literally', async () => {
    const root = await workspace();
    const a = await file(root, 'alpha/notes.txt');
    const b = await file(root, 'beta/notes.txt');
    const literal = await file(root, 'nested/report[1].txt');
    const brace = await file(root, 'nested/report{x,y}.txt');
    await file(root, 'nested/reportx.txt');
    await file(root, 'nested/report1.txt');
    const search = new TerminalFileSearch({ admitRoot: realpath });
    const first = await search.find(1, 'owned', {
      requestId: randomUUID(),
      roots: [root],
      query: 'notes.txt',
    });
    expect(first.paths.sort()).toEqual([a, b]);
    expect(first.incomplete).toBe(false);
    expect(
      (
        await search.find(1, 'owned', {
          requestId: randomUUID(),
          roots: [root],
          query: 'report[1].txt',
        })
      ).paths
    ).toEqual([literal]);
    expect(
      (
        await search.find(1, 'owned', {
          requestId: randomUUID(),
          roots: [root],
          query: 'report{x,y}.txt',
        })
      ).paths
    ).toEqual([brace]);
    expect(
      (
        await search.find(1, 'owned', {
          requestId: randomUUID(),
          roots: [root],
          query: 'alpha/notes.txt',
        })
      ).paths
    ).toEqual([a]);
  });
  it('excludes dependency/Git trees and refuses symlink results outside an admitted project', async () => {
    const root = await workspace();
    const outside = await workspace();
    await file(root, '.git/private.txt');
    await file(root, 'node_modules/dependency/private.txt');
    const external = await file(outside, 'external.txt');
    await symlink(external, join(root, 'external.txt'));
    const search = new TerminalFileSearch({ admitRoot: realpath });
    expect(
      (
        await search.find(1, 'owned', {
          requestId: randomUUID(),
          roots: [root],
          query: 'private.txt',
        })
      ).paths
    ).toEqual([]);
    expect(
      (
        await search.find(1, 'owned', {
          requestId: randomUUID(),
          roots: [root],
          query: 'external.txt',
        })
      ).paths
    ).toEqual([]);
  });
  it('labels bounded results incomplete and does not expand traversal expressions', async () => {
    const root = await workspace();
    for (const name of ['one', 'two', 'three']) await file(root, `${name}/match.txt`);
    const search = new TerminalFileSearch({ admitRoot: realpath, maxResults: 2 });
    const result = await search.find(1, 'owned', {
      requestId: randomUUID(),
      roots: [root],
      query: 'match.txt',
    });
    expect(result.paths).toHaveLength(2);
    expect(result.incomplete).toBe(true);
    expect(
      (await search.find(1, 'owned', { requestId: randomUUID(), roots: [root], query: '*' })).paths
    ).toEqual([]);
    expect(
      (
        await search.find(1, 'owned', {
          requestId: randomUUID(),
          roots: [root],
          query: '/etc/passwd',
        })
      ).paths
    ).toEqual([]);
  });
  it('fences replacement and wrong-window cancellation before native iteration starts', async () => {
    const root = await workspace();
    const match = await file(root, 'nested/notes.txt');
    let release!: (path: string) => void;
    let calls = 0;
    const search = new TerminalFileSearch({
      admitRoot: async (path) =>
        ++calls === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : realpath(path),
    });
    const older = randomUUID();
    const newer = randomUUID();
    const first = search.find(1, 'owned', { requestId: older, roots: [root], query: 'notes.txt' });
    const second = search.find(1, 'owned', { requestId: newer, roots: [root], query: 'notes.txt' });
    search.cancel(2, newer);
    search.cancel(1, older);
    release(root);
    expect((await first).cancelled).toBe(true);
    expect((await second).paths).toEqual([match]);
  });
});
