import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveCanonicalPath } from './path-allowlist';
import { assertIndexedGenomeWorkspaceAuthority } from './indexed-genome-workspace-authority';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('indexed genome workspace authority', () => {
  it('rejects a source replaced by an outside-workspace symlink after renderer admission', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dnaforge-indexed-authority-'));
    cleanupPaths.push(fixtureRoot);
    const workspaceRoot = join(fixtureRoot, 'workspace');
    const outsideRoot = join(fixtureRoot, 'outside');
    await Promise.all([mkdir(workspaceRoot), mkdir(outsideRoot)]);
    const sourcePath = join(workspaceRoot, 'reference.fa');
    const faiPath = join(workspaceRoot, 'reference.fa.fai');
    const outsidePath = join(outsideRoot, 'private.fa');
    await Promise.all([
      writeFile(sourcePath, '>chr1\nACGT\n'),
      writeFile(faiPath, 'chr1\t4\t6\t4\t5\n'),
      writeFile(outsidePath, '>secret\nTTTT\n'),
    ]);
    const canonicalWorkspaceRoot = await resolveCanonicalPath(workspaceRoot);
    const manifest = {
      fastaPath: await resolveCanonicalPath(sourcePath),
      faiPath: await resolveCanonicalPath(faiPath),
      workspaceRootPaths: [canonicalWorkspaceRoot],
    };

    await expect(assertIndexedGenomeWorkspaceAuthority(manifest)).resolves.toBeUndefined();

    await unlink(sourcePath);
    await symlink(outsidePath, sourcePath);

    await expect(assertIndexedGenomeWorkspaceAuthority(manifest)).rejects.toThrow(
      /escaped its admitted workspace/
    );
  });

  it('rejects malformed renderer-supplied workspace authority', async () => {
    await expect(
      assertIndexedGenomeWorkspaceAuthority({
        fastaPath: '/tmp/reference.fa',
        faiPath: '/tmp/reference.fa.fai',
        workspaceRootPaths: [],
      })
    ).rejects.toThrow(/Invalid indexed-genome workspace authority/);
  });

  it('is wired before indexed source cache reuse in the main-process read boundary', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    const manifestGuard = source.match(
      /async function assertManifestSafe[\s\S]*?\n}\n\nasync function assertManifestFilesPresent/
    )?.[0];
    const sourceLookup = source.match(
      /async function withSource[\s\S]*?\n}\n\nfunction debugBudgets/
    )?.[0];

    expect(manifestGuard).toContain('await assertIndexedGenomeWorkspaceAuthority(manifest)');
    expect(sourceLookup).toBeDefined();
    expect(sourceLookup?.indexOf('await assertManifestSafe(manifest)')).toBeLessThan(
      sourceLookup?.indexOf('return sourceLifecycle.withSource') ?? -1
    );
  });
});
