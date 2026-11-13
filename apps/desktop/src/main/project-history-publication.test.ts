// @vitest-environment node

import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectHistoryOwner } from './project-history-owner';
import { executeManagedGit } from './workspace-git/native';

const roots: string[] = [];
const allowed = () => {};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(tracked = true) {
  const root = await mkdtemp(join(tmpdir(), 'project-history-publication-'));
  roots.push(root);
  if (tracked) await executeManagedGit(root, ['init']);
  await writeFile(join(root, 'first.txt'), 'first');
  return root;
}

async function inspect(owner: ProjectHistoryOwner, workspaceRoot: string) {
  const result = await owner.run({ workspaceRoot, operation: { kind: 'inspect' } }, allowed);
  if (result.status !== 'ok') throw new Error(result.error);
  return result.inspection;
}

it('publishes no index when an outside writer changes a file during candidate staging', async () => {
  const workspaceRoot = await project();
  const owner = new ProjectHistoryOwner(async (root, args, options) => {
    if (args[0] === 'add' && options?.indexFile)
      await writeFile(join(root, 'first.txt'), 'outside writer');
    return executeManagedGit(root, args, options);
  });
  const state = await inspect(owner, workspaceRoot);
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
  expect(await readFile(join(workspaceRoot, 'first.txt'), 'utf8')).toBe('outside writer');
});

it('preserves an existing external index lock', async () => {
  const workspaceRoot = await project();
  const owner = new ProjectHistoryOwner();
  const state = await inspect(owner, workspaceRoot);
  const lock = join(workspaceRoot, '.git', 'index.lock');
  await writeFile(lock, 'external owner');
  const result = await owner.run(
    {
      workspaceRoot,
      operation: { kind: 'stage', expectedRevision: state.revision, paths: ['first.txt'] },
    },
    allowed
  );
  expect(result).toMatchObject({ status: 'failed', stateChanged: false });
  expect(await readFile(lock, 'utf8')).toBe('external owner');
  expect(await executeManagedGit(workspaceRoot, ['ls-files'])).toBe('');
});

it('never removes a replaced index lock owned by another process', async () => {
  const workspaceRoot = await project();
  const owner = new ProjectHistoryOwner(async (root, args, options) => {
    const output = await executeManagedGit(root, args, options);
    if (args[0] === 'add' && options?.indexFile) {
      await unlink(join(root, '.git', 'index.lock'));
      await writeFile(join(root, '.git', 'index.lock'), 'replacement owner');
    }
    return output;
  });
  const state = await inspect(owner, workspaceRoot);
  const result = await owner.run(
    {
      workspaceRoot,
      operation: { kind: 'stage', expectedRevision: state.revision, paths: ['first.txt'] },
    },
    allowed
  );
  expect(result).toMatchObject({
    status: 'failed',
    code: 'PROJECT_INDEX_LOCK_CHANGED',
    stateChanged: false,
  });
  expect(await readFile(join(workspaceRoot, '.git', 'index.lock'), 'utf8')).toBe(
    'replacement owner'
  );
  expect(await executeManagedGit(workspaceRoot, ['ls-files'])).toBe('');
});

it('stages and commits a whole native package but refuses a member-only selection', async () => {
  const workspaceRoot = await project();
  await mkdir(join(workspaceRoot, 'Package', '.forge'), { recursive: true });
  await writeFile(join(workspaceRoot, 'Package', '.forge', 'manifest.json'), '{"package":true}');
  await writeFile(join(workspaceRoot, 'Package', 'payload.txt'), 'package bytes');
  const owner = new ProjectHistoryOwner();
  let state = await inspect(owner, workspaceRoot);
  expect(state.entries.find((entry) => entry.path === 'Package')).toMatchObject({ package: true });
  const rejected = await owner.run(
    {
      workspaceRoot,
      operation: {
        kind: 'stage',
        expectedRevision: state.revision,
        paths: ['Package/payload.txt'],
      },
    },
    allowed
  );
  expect(rejected).toMatchObject({ status: 'failed', stateChanged: false });
  const staged = await owner.run(
    {
      workspaceRoot,
      operation: { kind: 'stage', expectedRevision: state.revision, paths: ['Package'] },
    },
    allowed
  );
  expect(staged.status).toBe('ok');
  state = await inspect(owner, workspaceRoot);
  const committed = await owner.run(
    {
      workspaceRoot,
      operation: {
        kind: 'commit',
        expectedRevision: state.revision,
        paths: ['Package'],
        message: 'Whole package',
      },
    },
    allowed
  );
  expect(committed.status).toBe('ok');
  expect(
    await executeManagedGit(workspaceRoot, ['show', 'HEAD:Package/.forge/manifest.json'])
  ).toBe('{"package":true}');
  expect(await executeManagedGit(workspaceRoot, ['show', 'HEAD:Package/payload.txt'])).toBe(
    'package bytes'
  );
});

it('preserves an existing ignore file when initializing and supports Save All', async () => {
  const workspaceRoot = await project(false);
  await writeFile(join(workspaceRoot, '.gitignore'), 'custom.keep\n');
  const owner = new ProjectHistoryOwner();
  let state = await inspect(owner, workspaceRoot);
  const initialized = await owner.run(
    { workspaceRoot, operation: { kind: 'initialize', expectedRevision: state.revision } },
    allowed
  );
  expect(initialized.status).toBe('ok');
  expect(await readFile(join(workspaceRoot, '.gitignore'), 'utf8')).toBe('custom.keep\n');
  await writeFile(join(workspaceRoot, 'first.txt'), 'new first');
  await writeFile(join(workspaceRoot, 'second.txt'), 'second');
  state = await inspect(owner, workspaceRoot);
  const saved = await owner.run(
    { workspaceRoot, operation: { kind: 'save-all', expectedRevision: state.revision } },
    allowed
  );
  expect(saved).toMatchObject({ status: 'ok', stateChanged: true });
  expect(await executeManagedGit(workspaceRoot, ['show', 'HEAD:first.txt'])).toBe('new first');
  expect(await executeManagedGit(workspaceRoot, ['show', 'HEAD:second.txt'])).toBe('second');
});

it('returns the actual commit identity when a later inspection fails', async () => {
  const workspaceRoot = await project();
  let published = false;
  const owner = new ProjectHistoryOwner(async (root, args, options) => {
    if (published && args[0] === 'status') throw new Error('Post-commit inspection unavailable');
    const output = await executeManagedGit(root, args, options);
    if (args[0] === 'update-ref') published = true;
    return output;
  });
  let state = await inspect(owner, workspaceRoot);
  await owner.run(
    {
      workspaceRoot,
      operation: { kind: 'stage', expectedRevision: state.revision, paths: ['first.txt'] },
    },
    allowed
  );
  state = await inspect(owner, workspaceRoot);
  const result = await owner.run(
    {
      workspaceRoot,
      operation: {
        kind: 'commit',
        expectedRevision: state.revision,
        paths: ['first.txt'],
        message: 'Known completed commit',
      },
    },
    allowed
  );
  expect(result).toMatchObject({ status: 'failed', stateChanged: true });
  expect(result.commitOid).toBe(
    (await executeManagedGit(workspaceRoot, ['rev-parse', 'HEAD'])).trim()
  );
  expect(await executeManagedGit(workspaceRoot, ['show', 'HEAD:first.txt'])).toBe('first');
});
