import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertInsideKnownWorkspace,
  assertSameKnownWorkspaceRoot,
  findKnownWorkspaceRoot,
  type KnownWorkspaceScopeDeps,
} from './known-workspace-scope';

describe('known-workspace scope', () => {
  let tmp: string;
  let managed: string;
  let known: string;
  let outside: string;
  let deps: KnownWorkspaceScopeDeps;

  const fakeDb = (paths: string[]): KnownWorkspaceScopeDeps['db'] => ({
    prepare: () => ({ all: () => paths.map((path) => ({ path })) }) as never,
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'wsscope-'));
    managed = join(tmp, 'managed');
    known = join(tmp, 'known-ws');
    outside = join(tmp, 'elsewhere');
    for (const dir of [managed, known, outside]) await mkdir(dir, { recursive: true });
    deps = { db: fakeDb([known]), managedRootDir: managed };
  });

  it('accepts a file directly inside a known workspace', async () => {
    const file = join(known, 'p.gb');
    await writeFile(file, 'x');
    expect(await findKnownWorkspaceRoot(file, deps)).toBe(known);
  });

  it('accepts a file NESTED inside a known workspace', async () => {
    await mkdir(join(known, 'a', 'b'), { recursive: true });
    const file = join(known, 'a', 'b', 'p.gb');
    await writeFile(file, 'x');
    expect(await findKnownWorkspaceRoot(file, deps)).toBe(known);
  });

  it('accepts a file inside the managed container', async () => {
    await mkdir(join(managed, 'repo'), { recursive: true });
    const file = join(managed, 'repo', 'p.gb');
    await writeFile(file, 'x');
    expect(await findKnownWorkspaceRoot(file, deps)).toBe(managed);
  });

  it('returns the exact nested workspace instead of collapsing managed repos to one container', async () => {
    const repoA = join(managed, 'repo-a');
    const repoB = join(managed, 'repo-b');
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    const fileA = join(repoA, 'source.gb');
    const fileB = join(repoB, 'package');
    await writeFile(fileA, 'x');
    await mkdir(fileB);
    const nestedDeps = {
      db: fakeDb([repoA, repoB]),
      managedRootDir: managed,
    };

    expect(await findKnownWorkspaceRoot(fileA, nestedDeps)).toBe(repoA);
    expect(await findKnownWorkspaceRoot(fileB, nestedDeps)).toBe(repoB);
  });

  it('refuses duplicate project identities for the same real root regardless of database order', async () => {
    const aliasA = join(tmp, 'alias-a');
    const aliasB = join(tmp, 'alias-b');
    await symlink(known, aliasA);
    await symlink(known, aliasB);
    const file = join(known, 'p.gb');
    await writeFile(file, 'x');

    await expect(
      findKnownWorkspaceRoot(file, { db: fakeDb([aliasA, aliasB]), managedRootDir: managed })
    ).resolves.toBeNull();
    await expect(
      findKnownWorkspaceRoot(file, { db: fakeDb([aliasB, aliasA]), managedRootDir: managed })
    ).resolves.toBeNull();
  });

  it('accepts a path whose LEAF does not exist yet', async () => {
    expect(await findKnownWorkspaceRoot(join(known, 'not-yet.gb'), deps)).toBe(known);
  });

  it('accepts the known workspace directory itself', async () => {
    expect(await findKnownWorkspaceRoot(known, deps)).toBe(known);
  });

  it('🟥 REFUSES a file outside every known workspace', async () => {
    const file = join(outside, 'precious.gb');
    await writeFile(file, 'x');
    expect(await findKnownWorkspaceRoot(file, deps)).toBeNull();
    await expect(assertInsideKnownWorkspace(file, deps)).rejects.toThrow(/OUTSIDE_WORKSPACE/);
  });

  it('🟥 REFUSES a path reached through a symlink that escapes the workspace', async () => {
    await writeFile(join(outside, 'precious.gb'), 'x');
    await symlink(outside, join(known, 'escape'));
    await expect(
      assertInsideKnownWorkspace(join(known, 'escape', 'precious.gb'), deps)
    ).rejects.toThrow(/OUTSIDE_WORKSPACE/);
  });

  it('🟥 REFUSES a traversal out of a known workspace', async () => {
    await writeFile(join(outside, 'precious.gb'), 'x');
    await expect(
      assertInsideKnownWorkspace(join(known, '..', 'elsewhere', 'precious.gb'), deps)
    ).rejects.toThrow(/OUTSIDE_WORKSPACE/);
  });

  it('🟥 REFUSES a SIBLING whose path merely shares the workspace name prefix', async () => {
    const sibling = `${known}-backup`;
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'p.gb'), 'x');
    expect(await findKnownWorkspaceRoot(join(sibling, 'p.gb'), deps)).toBeNull();
  });

  it('refuses everything when no workspace is known', async () => {
    const empty = { db: fakeDb([]), managedRootDir: join(tmp, 'no-such-managed') };
    await writeFile(join(known, 'p.gb'), 'x');
    expect(await findKnownWorkspaceRoot(join(known, 'p.gb'), empty)).toBeNull();
  });

  it('refuses destructive overwrite authority across two known workspace identities', () => {
    expect(() => assertSameKnownWorkspaceRoot('/workspace/a', '/workspace/b')).toThrow(
      /CROSS_WORKSPACE_PACKAGE_OVERWRITE/
    );
    expect(() => assertSameKnownWorkspaceRoot('/workspace/a', '/workspace/a')).not.toThrow();
  });
});
