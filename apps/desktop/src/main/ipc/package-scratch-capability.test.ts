import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readlink,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackageScratchCapabilityRegistry } from './package-scratch-capability';
import {
  acquireWorkspaceMutationShared,
  acquireWorkspaceSyncMutationLease,
} from '../workspace-sync-mutation-lease';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fixture-package-scratch-'));
  roots.push(root);
  return root;
}

describe('PackageScratchCapabilityRegistry', () => {
  it('reclaims unpublished scratch if the issuing page changes during directory creation', async () => {
    const root = await tempRoot();
    const registry = new PackageScratchCapabilityRegistry();
    const releaseMutation = vi.fn();
    let admissionChecks = 0;

    await expect(
      registry.issue(join(root, 'new-package'), 41, {
        mutationRelease: releaseMutation,
        assertOwnerCurrent: () => {
          if (admissionChecks++ > 0) throw new Error('WORKSPACE_MUTATION_RENDERER_GONE');
        },
      })
    ).rejects.toThrow('WORKSPACE_MUTATION_RENDERER_GONE');

    expect(await readdir(root)).toEqual([]);
    expect(releaseMutation).toHaveBeenCalledOnce();
    await registry.releaseOwner(41);
    expect(releaseMutation).toHaveBeenCalledOnce();
  });

  it('holds one shared mutation lease for the complete scratch transaction', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'new-package');
    const releaseMutation = await acquireWorkspaceMutationShared(packageRoot);
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, { mutationRelease: releaseMutation });
    let pullEntered = false;
    const pendingPull = acquireWorkspaceSyncMutationLease(packageRoot).then((release) => {
      pullEntered = true;
      return release;
    });

    await registry.remove(leases.staging.cleanupToken, 41);
    await Promise.resolve();
    expect(pullEntered).toBe(false);
    await registry.remove(leases.previous.cleanupToken, 41);

    const releasePull = await pendingPull;
    expect(pullEntered).toBe(true);
    releasePull();
  });

  it('restores displaced package members before owner-loss settlement releases sync', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    await mkdir(packageRoot);
    await writeFile(product, 'ORIGINAL PRODUCT');
    const releaseMutation = await acquireWorkspaceMutationShared(packageRoot);
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
      mutationRelease: releaseMutation,
    });
    const stagedProduct = join(leases.staging.path, 'pUC19.gb');
    const previousProduct = join(leases.previous.path, 'pUC19.gb');
    registry.validateGeneratedWrite(stagedProduct, 41);
    await writeFile(stagedProduct, 'REPLACEMENT PRODUCT');
    registry.recordGeneratedWrite(stagedProduct, 41);
    await registry.renameAuthorizedMember(
      leases.previous.cleanupToken,
      41,
      product,
      previousProduct
    );
    await registry.renameAuthorizedMember(leases.staging.cleanupToken, 41, stagedProduct, product);

    let pullEntered = false;
    const pendingPull = acquireWorkspaceSyncMutationLease(packageRoot).then((release) => {
      pullEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(pullEntered).toBe(false);

    await registry.releaseOwner(41);

    await expect(readFile(product, 'utf8')).resolves.toBe('ORIGINAL PRODUCT');
    await expect(lstat(leases.staging.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(leases.previous.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const releasePull = await pendingPull;
    expect(pullEntered).toBe(true);
    releasePull();
  });

  it('durably quarantines a failed rollback and releases sync instead of deadlocking it', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    await mkdir(packageRoot);
    await writeFile(product, 'ORIGINAL PRODUCT');
    const markRequired = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const releaseMutation = await acquireWorkspaceMutationShared(packageRoot);
    const registry = new PackageScratchCapabilityRegistry({
      now: () => Date.now(),
      randomHex: () => Math.random().toString(16).slice(2),
      mkdir: (path) => mkdir(path),
      lstat: (path) => lstat(path),
      readFile: (path) => readFile(path),
      link: async (existingPath, newPath) => {
        if (existingPath === product && newPath.includes('.staging-')) {
          throw new Error('injected rollback failure');
        }
        await link(existingPath, newPath);
      },
      readlink: (path) => readlink(path),
      readdir: (path) => readdir(path, { withFileTypes: true }),
      rename: (oldPath, newPath) => rename(oldPath, newPath),
      rm: (path, options) => rm(path, options),
      symlink: (target, path) => symlink(target, path),
      unlink: (path) => unlink(path),
    });
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
      mutationRelease: releaseMutation,
      recovery: { markRequired, clear },
    });
    const stagedProduct = join(leases.staging.path, 'pUC19.gb');
    const previousProduct = join(leases.previous.path, 'pUC19.gb');
    registry.validateGeneratedWrite(stagedProduct, 41);
    await writeFile(stagedProduct, 'REPLACEMENT PRODUCT');
    registry.recordGeneratedWrite(stagedProduct, 41);
    await registry.renameAuthorizedMember(
      leases.previous.cleanupToken,
      41,
      product,
      previousProduct
    );
    await registry.renameAuthorizedMember(leases.staging.cleanupToken, 41, stagedProduct, product);

    await expect(registry.releaseOwner(41)).rejects.toThrow('injected rollback failure');
    expect(markRequired).toHaveBeenCalledWith(expect.stringContaining(packageRoot));
    expect(clear).not.toHaveBeenCalled();

    const releasePull = await acquireWorkspaceSyncMutationLease(packageRoot);
    releasePull();
  });

  it('releases the workspace mutation even when settlement fails before recording recovery', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    await mkdir(packageRoot);
    await writeFile(product, 'ORIGINAL PRODUCT');
    const markRequired = vi.fn(async () => {
      throw new Error('injected recovery-record failure');
    });
    const clear = vi.fn(async () => undefined);
    const releaseMutation = await acquireWorkspaceMutationShared(packageRoot);
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
      mutationRelease: releaseMutation,
      recovery: { markRequired, clear },
    });
    expect(leases.staging.cleanupToken).toBeTruthy();

    await expect(registry.releaseOwner(41)).rejects.toThrow('injected recovery-record failure');

    const exclusive = acquireWorkspaceSyncMutationLease(packageRoot);
    const winner = await Promise.race([
      exclusive.then(() => 'released' as const),
      new Promise<'leaked'>((resolve) => setTimeout(() => resolve('leaked'), 1_000)),
    ]);
    expect(winner).toBe('released');
    (await exclusive)();
  });

  it('keeps a committed replacement and cleans recovery scratch after owner loss', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    await mkdir(packageRoot);
    await writeFile(product, 'ORIGINAL PRODUCT');
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
    });
    const stagedProduct = join(leases.staging.path, 'pUC19.gb');
    const previousProduct = join(leases.previous.path, 'pUC19.gb');
    registry.validateGeneratedWrite(stagedProduct, 41);
    await writeFile(stagedProduct, 'REPLACEMENT PRODUCT');
    registry.recordGeneratedWrite(stagedProduct, 41);
    await registry.renameAuthorizedMember(
      leases.previous.cleanupToken,
      41,
      product,
      previousProduct
    );
    await registry.renameAuthorizedMember(leases.staging.cleanupToken, 41, stagedProduct, product);

    await registry.remove(leases.staging.cleanupToken, 41);
    await registry.releaseOwner(41);

    await expect(readFile(product, 'utf8')).resolves.toBe('REPLACEMENT PRODUCT');
    await expect(lstat(leases.previous.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for an admitted scratch write before settling owner loss', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'new-package');
    const releaseMutation = await acquireWorkspaceMutationShared(packageRoot);
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, { mutationRelease: releaseMutation });
    const stagedProduct = join(leases.staging.path, 'new-package.gb');
    let continueWrite: (() => void) | undefined;
    let reportWriteEntered: (() => void) | undefined;
    const writeEntered = new Promise<void>((resolve) => {
      reportWriteEntered = resolve;
    });
    const writeCanFinish = new Promise<void>((resolve) => {
      continueWrite = resolve;
    });
    const write = registry.runTrackedMutation([stagedProduct], 41, async () => {
      registry.validateGeneratedWrite(stagedProduct, 41);
      await writeFile(stagedProduct, 'STAGED PRODUCT');
      reportWriteEntered?.();
      await writeCanFinish;
      registry.recordGeneratedWrite(stagedProduct, 41);
    });
    await writeEntered;

    let settlementFinished = false;
    const settlement = registry.releaseOwner(41).then(() => {
      settlementFinished = true;
    });
    await Promise.resolve();
    expect(settlementFinished).toBe(false);
    await expect(readFile(stagedProduct, 'utf8')).resolves.toBe('STAGED PRODUCT');

    continueWrite?.();
    await write;
    await settlement;

    expect(settlementFinished).toBe(true);
    await expect(lstat(leases.staging.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes an uncommitted brand-new package installed just before owner loss', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'new-package');
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41);
    const stagedProduct = join(leases.staging.path, 'new-package.gb');
    registry.validateGeneratedWrite(stagedProduct, 41);
    await writeFile(stagedProduct, 'NEW PRODUCT');
    registry.recordGeneratedWrite(stagedProduct, 41);
    await registry.renameAuthorizedMember(
      leases.staging.cleanupToken,
      41,
      leases.staging.path,
      packageRoot
    );
    await expect(readFile(join(packageRoot, 'new-package.gb'), 'utf8')).resolves.toBe(
      'NEW PRODUCT'
    );

    await registry.releaseOwner(41);

    await expect(lstat(packageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(leases.staging.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(leases.previous.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('actively expires an abandoned scratch lease without another registry call', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'abandoned-package');
    vi.useFakeTimers();
    try {
      const releaseMutation = await acquireWorkspaceMutationShared(packageRoot);
      const registry = new PackageScratchCapabilityRegistry();
      await registry.issue(packageRoot, 41, { mutationRelease: releaseMutation });
      let pullEntered = false;
      const pendingPull = acquireWorkspaceSyncMutationLease(packageRoot).then((release) => {
        pullEntered = true;
        return release;
      });

      await Promise.resolve();
      expect(pullEntered).toBe(false);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      const releasePull = await pendingPull;
      expect(pullEntered).toBe(true);
      releasePull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a pre-existing scratch-looking path because a path is not a capability', async () => {
    const root = await tempRoot();
    const lookalike = join(root, `.valuable.staging-${Date.now()}-deadbeef`);
    const sentinel = join(lookalike, 'keep.txt');
    await mkdir(lookalike);
    await writeFile(sentinel, 'USER DATA');
    const registry = new PackageScratchCapabilityRegistry();

    await expect(registry.remove(lookalike, 41)).rejects.toThrow(/capability/i);
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('USER DATA');
  });

  it('never removes a pre-existing lookalike encountered while reserving scratch', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const previousLookalike = join(root, '.pUC19.previous-1700000000000-deadbeef');
    const sentinel = join(previousLookalike, 'keep.txt');
    await mkdir(previousLookalike);
    await writeFile(sentinel, 'USER DATA');
    const registry = new PackageScratchCapabilityRegistry({
      now: () => 1_700_000_000_000,
      randomHex: () => 'deadbeef',
      mkdir: (path) => mkdir(path),
      lstat: (path) => lstat(path),
      readFile: (path) => readFile(path),
      link: (existingPath, newPath) => link(existingPath, newPath),
      readlink: (path) => readlink(path),
      readdir: (path) => readdir(path, { withFileTypes: true }),
      rename: (oldPath, newPath) => rename(oldPath, newPath),
      rm: (path, options) => rm(path, options),
      symlink: (target, path) => symlink(target, path),
      unlink: (path) => unlink(path),
    });

    await expect(registry.issue(packageRoot, 41)).rejects.toThrow(/collision/i);
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('USER DATA');
  });

  it('removes a main-created scratch exactly once for its owning renderer', async () => {
    const root = await tempRoot();
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(join(root, 'pUC19'), 41);
    expect(leases.staging.cleanupToken).not.toBe(leases.previous.cleanupToken);
    const generated = join(leases.staging.path, 'generated.gb');
    registry.validateGeneratedWrite(generated, 41);
    await writeFile(generated, 'LOCUS');
    registry.recordGeneratedWrite(generated, 41);

    await registry.remove(leases.staging.cleanupToken, 41);
    await expect(readFile(join(leases.staging.path, 'generated.gb'))).rejects.toThrow();
    await expect(registry.remove(leases.staging.cleanupToken, 41)).rejects.toThrow(
      /already-used|unknown/i
    );
  });

  it('allows generated primers under contents/ and installs that staging root', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41);
    const product = join(leases.staging.path, 'pUC19.gb');
    const meta = join(leases.staging.path, '.forge', 'plasmid.json');
    const primerCsv = join(leases.staging.path, 'contents', 'pUC19.primers.csv');
    const primerFasta = join(leases.staging.path, 'contents', 'pUC19.primers.fasta');
    await mkdir(join(leases.staging.path, '.forge'), { recursive: true });
    await mkdir(join(leases.staging.path, 'contents'), { recursive: true });
    for (const [path, body] of [
      [product, 'LOCUS pUC19\n//\n'],
      [meta, '{"schema":"waypoint.sequence.v1"}\n'],
      [primerCsv, 'name,seq\n'],
      [primerFasta, '>p\nACGT\n'],
    ] as const) {
      registry.validateGeneratedWrite(path, 41);
      await writeFile(path, body);
      registry.recordGeneratedWrite(path, 41);
    }
    await registry.renameAuthorizedMember(
      leases.staging.cleanupToken,
      41,
      leases.staging.path,
      packageRoot
    );
    expect(await readFile(join(packageRoot, 'contents', 'pUC19.primers.csv'), 'utf8')).toBe(
      'name,seq\n'
    );
    await registry.remove(leases.previous.cleanupToken, 41);
  });

  it('installs only a content-addressed sequence snapshot whose bytes match its name', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41);
    const content = 'LOCUS pUC19\n//\n';
    const digest = createHash('sha256').update(content).digest('hex');
    const snapshot = join(leases.staging.path, 'contents', `sequence-snapshot-${digest}.gb`);
    await mkdir(join(leases.staging.path, 'contents'));

    expect(() => registry.validateGeneratedWrite(snapshot, 41)).toThrow(/snapshot bytes/i);
    expect(() => registry.validateGeneratedWrite(snapshot, 41, { content: 'wrong' })).toThrow(
      /snapshot bytes/i
    );
    expect(() => registry.validateGeneratedWrite(snapshot, 41, { content, append: true })).toThrow(
      /snapshot bytes/i
    );

    registry.validateGeneratedWrite(snapshot, 41, { content });
    await writeFile(snapshot, content);
    registry.recordGeneratedWrite(snapshot, 41);
    await registry.renameAuthorizedMember(
      leases.staging.cleanupToken,
      41,
      leases.staging.path,
      packageRoot
    );
    await expect(
      readFile(join(packageRoot, 'contents', `sequence-snapshot-${digest}.gb`), 'utf8')
    ).resolves.toBe(content);
    await registry.remove(leases.previous.cleanupToken, 41);
  });

  it('refuses a sequence snapshot changed after its checked write', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41);
    const content = 'LOCUS pUC19\n//\n';
    const digest = createHash('sha256').update(content).digest('hex');
    const snapshot = join(leases.staging.path, 'contents', `sequence-snapshot-${digest}.gb`);
    await mkdir(join(leases.staging.path, 'contents'));
    registry.validateGeneratedWrite(snapshot, 41, { content });
    await writeFile(snapshot, content);
    registry.recordGeneratedWrite(snapshot, 41);
    await writeFile(snapshot, 'changed after validation');

    await expect(
      registry.renameAuthorizedMember(
        leases.staging.cleanupToken,
        41,
        leases.staging.path,
        packageRoot
      )
    ).rejects.toThrow(/UNSAFE_PACKAGE_SCRATCH|sequence-snapshot/i);
    await expect(registry.remove(leases.staging.cleanupToken, 41)).rejects.toThrow(
      /UNSAFE_PACKAGE_SCRATCH_CONTENT/i
    );
    await registry.remove(leases.previous.cleanupToken, 41);
  });

  it('does not let a different renderer spend the capability', async () => {
    const root = await tempRoot();
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(join(root, 'pUC19'), 41);
    const sentinel = join(leases.staging.path, 'recovery.gb');
    registry.validateGeneratedWrite(sentinel, 41);
    await writeFile(sentinel, 'RECOVERY');
    registry.recordGeneratedWrite(sentinel, 41);

    await expect(registry.remove(leases.staging.cleanupToken, 99)).rejects.toThrow(
      /another renderer/i
    );
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('RECOVERY');
    await registry.remove(leases.staging.cleanupToken, 41);
  });

  it('rejects the token if a user directory replaces the issued inode', async () => {
    const root = await tempRoot();
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(join(root, 'pUC19'), 41);
    const userDirectory = join(root, 'user-directory');
    await mkdir(userDirectory);
    await writeFile(join(userDirectory, 'keep.txt'), 'USER DATA');
    await rm(leases.staging.path, { recursive: true });
    await rename(userDirectory, leases.staging.path);

    await expect(registry.remove(leases.staging.cleanupToken, 41)).rejects.toThrow(
      /no longer names|replaced/i
    );
    await expect(readFile(join(leases.staging.path, 'keep.txt'), 'utf8')).resolves.toBe(
      'USER DATA'
    );
  });

  it('quarantines rather than deleting a directory injected beneath an issued root', async () => {
    const root = await tempRoot();
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(join(root, 'pUC19'), 41);
    const userDirectory = join(root, 'Important');
    await mkdir(userDirectory);
    await writeFile(join(userDirectory, 'keep.txt'), 'USER DATA');
    await rename(userDirectory, join(leases.staging.path, 'Important'));

    await expect(registry.remove(leases.staging.cleanupToken, 41)).rejects.toThrow(
      /unsafe|unexpected/i
    );

    const recoveryRoot = (await readdir(root)).find((name) => name.startsWith('.pUC19.recovery-'));
    expect(recoveryRoot).toBeDefined();
    expect(await readFile(join(root, recoveryRoot!, 'Important', 'keep.txt'), 'utf8')).toBe(
      'USER DATA'
    );
  });

  it('never deletes an allowed-looking user GenBank moved beneath an issued root', async () => {
    const root = await tempRoot();
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(join(root, 'pUC19'), 41);
    const userGenBank = join(root, 'only-copy.gb');
    await writeFile(
      userGenBank,
      'LOCUS       only-copy  8 bp    DNA\nORIGIN\n        1 acgtacgt\n//\n'
    );
    await rename(userGenBank, join(leases.staging.path, 'only-copy.gb'));

    await expect(registry.remove(leases.staging.cleanupToken, 41)).rejects.toThrow(
      /unsafe|unexpected|untrusted/i
    );

    const recoveryRoot = (await readdir(root)).find((name) => name.startsWith('.pUC19.recovery-'));
    expect(recoveryRoot).toBeDefined();
    expect(await readFile(join(root, recoveryRoot!, 'only-copy.gb'), 'utf8')).toContain(
      'LOCUS       only-copy'
    );
  });

  it('does not let an unverified scratch request move an ordinary GenBank into cleanup authority', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    await mkdir(packageRoot);
    await writeFile(product, 'OLD PRODUCT');
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41);
    const backup = join(leases.previous.path, 'pUC19.gb');

    expect(() => registry.assertGenericMutationAllowed(product, backup)).toThrow(
      /requires.capability/i
    );
    await expect(
      registry.renameAuthorizedMember(leases.previous.cleanupToken, 41, product, backup)
    ).rejects.toThrow(/unverified|unauthorized|package/i);
    await expect(readFile(product, 'utf8')).resolves.toBe('OLD PRODUCT');
    await registry.remove(leases.previous.cleanupToken, 41);
  });

  it('rejects an unrecorded generated-looking member even for a verified package lease', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const recordedProduct = join(packageRoot, 'pUC19.gb');
    const unrecordedProduct = join(packageRoot, 'backup.gb');
    await mkdir(packageRoot);
    await writeFile(recordedProduct, 'RECORDED PRODUCT');
    await writeFile(unrecordedProduct, 'USER BACKUP');
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
    });
    const scratchTarget = join(leases.previous.path, 'backup.gb');

    await expect(
      registry.renameAuthorizedMember(
        leases.previous.cleanupToken,
        41,
        unrecordedProduct,
        scratchTarget
      )
    ).rejects.toThrow(/recorded|authorized|untrusted/i);

    await expect(readFile(unrecordedProduct, 'utf8')).resolves.toBe('USER BACKUP');
    await registry.remove(leases.previous.cleanupToken, 41);
  });

  it('backs up and restores an exact marker-recorded member through the same lease', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    await mkdir(packageRoot);
    await writeFile(product, 'RECORDED PRODUCT');
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
    });
    const backup = join(leases.previous.path, 'pUC19.gb');

    await registry.renameAuthorizedMember(leases.previous.cleanupToken, 41, product, backup);
    await expect(readFile(backup, 'utf8')).resolves.toBe('RECORDED PRODUCT');
    await expect(readFile(product, 'utf8')).rejects.toThrow();

    await registry.renameAuthorizedMember(leases.previous.cleanupToken, 41, backup, product);
    await expect(readFile(product, 'utf8')).resolves.toBe('RECORDED PRODUCT');
    await registry.remove(leases.previous.cleanupToken, 41);
  });

  it('refuses to consume a recorded member atomically replaced after the lease was issued', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    await mkdir(packageRoot);
    await writeFile(product, 'ORIGINAL PRODUCT');
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
    });

    const concurrent = join(packageRoot, '.concurrent.gb');
    await writeFile(concurrent, 'CONCURRENT USER EDIT');
    await rename(concurrent, product);
    const backup = join(leases.previous.path, 'pUC19.gb');

    await expect(
      registry.renameAuthorizedMember(leases.previous.cleanupToken, 41, product, backup)
    ).rejects.toThrow(/replaced|changed|identity/i);
    await expect(readFile(product, 'utf8')).resolves.toBe('CONCURRENT USER EDIT');
    await expect(readFile(backup, 'utf8')).rejects.toThrow();
    await registry.remove(leases.previous.cleanupToken, 41);
  });

  it('retains a concurrent destination when source unlink fails during no-clobber restore', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    await mkdir(packageRoot);
    await writeFile(product, 'ORIGINAL PRODUCT');
    let backup = '';
    let injectedConcurrentEdit = false;
    const registry = new PackageScratchCapabilityRegistry({
      now: () => Date.now(),
      randomHex: () => Math.random().toString(16).slice(2),
      mkdir: (path) => mkdir(path),
      lstat: (path) => lstat(path),
      readFile: (path) => readFile(path),
      link: (existingPath, newPath) => link(existingPath, newPath),
      readlink: (path) => readlink(path),
      readdir: (path) => readdir(path, { withFileTypes: true }),
      rename: (oldPath, newPath) => rename(oldPath, newPath),
      rm: (path, options) => rm(path, options),
      symlink: (target, path) => symlink(target, path),
      unlink: async (path) => {
        if (!injectedConcurrentEdit && path === backup) {
          injectedConcurrentEdit = true;
          const concurrent = join(packageRoot, '.concurrent.gb');
          await writeFile(concurrent, 'CONCURRENT USER EDIT');
          await rename(concurrent, product);
          throw new Error('simulated source unlink failure');
        }
        await unlink(path);
      },
    });
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
    });
    backup = join(leases.previous.path, 'pUC19.gb');
    await registry.renameAuthorizedMember(leases.previous.cleanupToken, 41, product, backup);

    await expect(
      registry.renameAuthorizedMember(leases.previous.cleanupToken, 41, backup, product)
    ).rejects.toThrow(/unlink failure/i);

    expect(injectedConcurrentEdit).toBe(true);
    await expect(readFile(product, 'utf8')).resolves.toBe('CONCURRENT USER EDIT');
    await expect(readFile(backup, 'utf8')).resolves.toBe('ORIGINAL PRODUCT');
  });

  it('consumes a trusted symlink-backed product without deleting its backing file', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    const backing = join(root, 'large-source.gb');
    await mkdir(packageRoot);
    await writeFile(backing, 'BACKING PRODUCT');
    await symlink(backing, product);
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
    });
    const backup = join(leases.previous.path, 'pUC19.gb');

    await registry.renameAuthorizedMember(leases.previous.cleanupToken, 41, product, backup);
    expect((await lstat(backup)).isSymbolicLink()).toBe(true);
    await registry.remove(leases.previous.cleanupToken, 41);

    await expect(lstat(leases.previous.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(backing, 'utf8')).resolves.toBe('BACKING PRODUCT');
  });

  it('quarantines a trusted product symlink atomically replaced before cleanup', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const product = join(packageRoot, 'pUC19.gb');
    const originalBacking = join(root, 'original-source.gb');
    const concurrentBacking = join(root, 'concurrent-source.gb');
    await mkdir(packageRoot);
    await writeFile(originalBacking, 'ORIGINAL BACKING');
    await writeFile(concurrentBacking, 'CONCURRENT BACKING');
    await symlink(originalBacking, product);
    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['pUC19.gb'],
    });
    const backup = join(leases.previous.path, 'pUC19.gb');
    await registry.renameAuthorizedMember(leases.previous.cleanupToken, 41, product, backup);

    const replacementLink = join(leases.previous.path, '.replacement.gb');
    await symlink(concurrentBacking, replacementLink);
    await rename(replacementLink, backup);

    await expect(registry.remove(leases.previous.cleanupToken, 41)).rejects.toThrow(
      /unsafe|unexpected|replaced/i
    );

    const recoveryRoot = (await readdir(root)).find((name) => name.startsWith('.pUC19.recovery-'));
    expect(recoveryRoot).toBeDefined();
    const retainedLink = join(root, recoveryRoot!, 'pUC19.gb');
    expect((await lstat(retainedLink)).isSymbolicLink()).toBe(true);
    await expect(readlink(retainedLink)).resolves.toBe(concurrentBacking);
    await expect(readFile(originalBacking, 'utf8')).resolves.toBe('ORIGINAL BACKING');
    await expect(readFile(concurrentBacking, 'utf8')).resolves.toBe('CONCURRENT BACKING');
  });

  it('rejects a marker-recorded generated member whose parent resolves outside the package', async () => {
    const root = await tempRoot();
    const packageRoot = join(root, 'pUC19');
    const externalRoot = join(root, 'external-primers');
    const externalPrimer = join(externalRoot, 'pUC19.primers.csv');
    await mkdir(packageRoot);
    await mkdir(externalRoot);
    await writeFile(externalPrimer, 'IRREPLACEABLE EXTERNAL PRIMERS');
    await symlink(externalRoot, join(packageRoot, 'primers'), 'dir');

    const registry = new PackageScratchCapabilityRegistry();
    const leases = await registry.issue(packageRoot, 41, {
      authorizedExistingMembers: ['primers/pUC19.primers.csv'],
    });
    const lexicalPrimer = join(packageRoot, 'primers', 'pUC19.primers.csv');
    const backup = join(leases.previous.path, 'primers', 'pUC19.primers.csv');
    await mkdir(join(leases.previous.path, 'primers'));

    await expect(
      registry.renameAuthorizedMember(leases.previous.cleanupToken, 41, lexicalPrimer, backup)
    ).rejects.toThrow(/symlink|outside|contain/i);
    await expect(readFile(externalPrimer, 'utf8')).resolves.toBe('IRREPLACEABLE EXTERNAL PRIMERS');
    await registry.remove(leases.previous.cleanupToken, 41);
  });
});
