// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeManagedGit } from './workspace-git/native';
import { ProjectHistoryOwner } from './project-history-owner';

const roots: string[] = [];
const allowed = () => {};
const owner = new ProjectHistoryOwner();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'project-history-owner-'));
  roots.push(root);
  await executeManagedGit(root, ['init']);
  await writeFile(join(root, 'first.txt'), 'first\r\n');
  await writeFile(join(root, 'second.txt'), 'second\n');
  return root;
}

async function inspection(workspaceRoot: string) {
  const result = await owner.run({ workspaceRoot, operation: { kind: 'inspect' } }, allowed);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(result.error);
  return result.inspection;
}

describe('native project history', () => {
  it('shares actual stage and unborn unstage state without changing working bytes', async () => {
    const workspaceRoot = await repository();
    let state = await inspection(workspaceRoot);
    expect(state.head).toBeNull();
    let result = await owner.run(
      {
        workspaceRoot,
        operation: { kind: 'stage', expectedRevision: state.revision, paths: ['first.txt'] },
      },
      allowed
    );
    expect(result.status).toBe('ok');
    expect(await executeManagedGit(workspaceRoot, ['diff', '--cached', '--name-only'])).toBe(
      'first.txt\n'
    );
    state = await inspection(workspaceRoot);
    expect(state.entries.find((entry) => entry.path === 'first.txt')?.staged).toBe(true);
    expect(state.entries.find((entry) => entry.path === 'second.txt')?.staged).toBe(false);
    result = await owner.run(
      {
        workspaceRoot,
        operation: { kind: 'unstage', expectedRevision: state.revision, paths: ['first.txt'] },
      },
      allowed
    );
    expect(result.status).toBe('ok');
    expect(await executeManagedGit(workspaceRoot, ['ls-files'])).toBe('');
    expect(await readFile(join(workspaceRoot, 'first.txt'), 'utf8')).toBe('first\r\n');
  });

  it('refuses stale working-file revisions before touching the index', async () => {
    const workspaceRoot = await repository();
    const state = await inspection(workspaceRoot);
    await writeFile(join(workspaceRoot, 'first.txt'), 'external replacement');
    const result = await owner.run(
      {
        workspaceRoot,
        operation: { kind: 'stage', expectedRevision: state.revision, paths: ['first.txt'] },
      },
      allowed
    );
    expect(result).toMatchObject({
      status: 'failed',
      code: 'STALE_PROJECT_HISTORY',
      stateChanged: false,
    });
    expect(await executeManagedGit(workspaceRoot, ['ls-files'])).toBe('');
    expect(await readFile(join(workspaceRoot, 'first.txt'), 'utf8')).toBe('external replacement');
  });

  it('commits exactly the staged selection and preserves unrelated working changes', async () => {
    const workspaceRoot = await repository();
    let state = await inspection(workspaceRoot);
    await owner.run(
      {
        workspaceRoot,
        operation: { kind: 'stage', expectedRevision: state.revision, paths: ['first.txt'] },
      },
      allowed
    );
    state = await inspection(workspaceRoot);
    const result = await owner.run(
      {
        workspaceRoot,
        operation: {
          kind: 'commit',
          expectedRevision: state.revision,
          paths: ['first.txt'],
          message: 'Save selected first file',
        },
      },
      allowed
    );
    expect(result).toMatchObject({ status: 'ok', stateChanged: true });
    if (result.status !== 'ok') throw new Error(result.error);
    expect(result.commitOid).toMatch(/^[a-f0-9]{40}$/u);
    expect(await executeManagedGit(workspaceRoot, ['show', 'HEAD:first.txt'])).toBe('first\r\n');
    expect(await executeManagedGit(workspaceRoot, ['ls-tree', '--name-only', 'HEAD'])).toBe(
      'first.txt\n'
    );
    expect(await readFile(join(workspaceRoot, 'second.txt'), 'utf8')).toBe('second\n');
  });

  it('refuses a commit that would include an unselected staged entry', async () => {
    const workspaceRoot = await repository();
    await executeManagedGit(workspaceRoot, ['add', '--', 'first.txt', 'second.txt']);
    const state = await inspection(workspaceRoot);
    const result = await owner.run(
      {
        workspaceRoot,
        operation: {
          kind: 'commit',
          expectedRevision: state.revision,
          paths: ['first.txt'],
          message: 'Only first',
        },
      },
      allowed
    );
    expect(result).toMatchObject({
      status: 'failed',
      code: 'PROJECT_INDEX_SELECTION_MISMATCH',
      stateChanged: false,
    });
    expect((await inspection(workspaceRoot)).head).toBeNull();
    expect(await executeManagedGit(workspaceRoot, ['diff', '--cached', '--name-only'])).toBe(
      'first.txt\nsecond.txt\n'
    );
  });

  it.each(['../outside.txt', ':(top)*', '.git/config', '/absolute.txt'])(
    'refuses unsafe selected path %s',
    async (path) => {
      const workspaceRoot = await repository();
      const state = await inspection(workspaceRoot);
      const result = await owner.run(
        {
          workspaceRoot,
          operation: { kind: 'stage', expectedRevision: state.revision, paths: [path] },
        },
        allowed
      );
      expect(result).toMatchObject({ status: 'failed', stateChanged: false });
      expect(await executeManagedGit(workspaceRoot, ['ls-files'])).toBe('');
    }
  );

  it('rechecks native authority after asynchronous inspection before staging', async () => {
    const workspaceRoot = await repository();
    const state = await inspection(workspaceRoot);
    let calls = 0;
    const result = await owner.run(
      {
        workspaceRoot,
        operation: { kind: 'stage', expectedRevision: state.revision, paths: ['first.txt'] },
      },
      () => {
        if (++calls > 2) throw new Error('Project delegation was revoked');
      }
    );
    expect(result).toMatchObject({ status: 'failed', stateChanged: false });
    expect(await executeManagedGit(workspaceRoot, ['ls-files'])).toBe('');
  });
});
