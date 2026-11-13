import { execFile, execFileSync } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { SterileGitReadRuntime } from './git-read-executor';
import { readGitHeadFromAllowedRoots as readGitHeadFromAllowedRootsRaw } from './git-read-path-canonicalizer';
import {
  GitReadRequestOwner,
  type GitReadSender,
  type OwnedGitReadProcess,
} from './git-read-request-owner';

const execFileAsync = promisify(execFile);
const SAFE_CANARY = 'DNAFORGE_GIT_READ_SAFE_CANARY\n';
const OUTSIDE_CANARY = 'DNAFORGE_GIT_READ_OUTSIDE_CANARY\n';
const TRANSIENT_OUTSIDE_CANARY = 'DNAFORGE_GIT_READ_EVIL_CANARY\n';
const temporaryRoots: string[] = [];
const spawnedPids = new Set<number>();
let windowsGuardianExecutable: string | undefined;

beforeAll(async () => {
  if (process.platform !== 'win32') return;
  windowsGuardianExecutable = resolve(
    __dirname,
    '../../../resources/helpers/dna-process-guardian-x86_64-pc-windows-msvc.exe'
  );
  execFileSync(
    process.execPath,
    [resolve(__dirname, '../../../scripts/build-helpers.cjs'), 'dna-process-guardian'],
    {
      cwd: resolve(__dirname, '../../..'),
      env: {
        ...process.env,
        CARGO_TARGET_DIR:
          process.env.CARGO_TARGET_DIR ?? resolve(__dirname, '../../../out/cargo-target-test'),
      },
      stdio: 'inherit',
    }
  );
});

function readGitHeadFromAllowedRoots(
  input: Parameters<typeof readGitHeadFromAllowedRootsRaw>[0]
): ReturnType<typeof readGitHeadFromAllowedRootsRaw> {
  return readGitHeadFromAllowedRootsRaw({
    ...input,
    guardianExecutable: input.guardianExecutable ?? windowsGuardianExecutable,
  });
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-git-read-path-'));
  temporaryRoots.push(root);
  return root;
}

async function createRepository(root: string, content = SAFE_CANARY): Promise<string> {
  const repository = join(root, 'repo');
  await mkdir(repository);
  await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.email', 'test@dnaforge.invalid'], {
    cwd: repository,
  });
  await execFileAsync('git', ['config', 'user.name', 'DNAForge Test'], { cwd: repository });
  await writeFile(join(repository, 'sequence.gb'), content);
  await execFileAsync('git', ['add', 'sequence.gb'], { cwd: repository });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository });
  return repository;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessesToExit(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return;
    await delay(20);
  }
  const survivors = pids.filter(processExists);
  throw new Error(`Timed out waiting for process exit: ${survivors.join(', ')}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function control(input?: {
  readonly controller?: AbortController;
  readonly children?: OwnedGitReadProcess[];
  readonly onBind?: () => void;
}) {
  const controller = input?.controller ?? new AbortController();
  return {
    signal: controller.signal,
    bindProcess: (child: OwnedGitReadProcess): void => {
      input?.children?.push(child);
      input?.onBind?.();
    },
  };
}

describe('readGitHeadFromAllowedRoots', () => {
  afterEach(async () => {
    for (const pid of spawnedPids) {
      if (!processExists(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    spawnedPids.clear();
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it('reads a committed baseline through one physically owned helper', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const children: OwnedGitReadProcess[] = [];

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control({ children }),
      })
    ).resolves.toBe(SAFE_CANARY);
    expect(children).toHaveLength(1);
  });

  it('reads a committed baseline through the installed Electron Node runtime without a window', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string')
      throw new Error('The installed Electron executable is unavailable.');
    const previousExecutable = process.execPath;
    const controller = new AbortController();
    const children: OwnedGitReadProcess[] = [];
    const deadline = setTimeout(() => controller.abort(), 5_000);
    try {
      process.execPath = executable;
      await expect(
        readGitHeadFromAllowedRoots({
          filePath: join(repository, 'sequence.gb'),
          allowedRoots: [root],
          errorPrefix: 'installed-electron-runtime',
          control: control({ controller, children }),
        })
      ).resolves.toBe(SAFE_CANARY);
      expect(children).toHaveLength(1);
      expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
        true
      );
    } finally {
      controller.abort();
      clearTimeout(deadline);
      process.execPath = previousExecutable;
    }
  });

  it('reads the staged index when the path has no HEAD object', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const stagedPath = join(repository, 'staged.gb');
    await writeFile(stagedPath, SAFE_CANARY);
    await execFileAsync('git', ['add', 'staged.gb'], { cwd: repository });

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: stagedPath,
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);
  });

  it.skipIf(process.platform === 'win32')(
    'treats Git path syntax in a tracked filename as literal text',
    async () => {
      const root = await createTemporaryRoot();
      const repository = await createRepository(root);
      const literalName = ':(glob)sequence.gb';
      const literalPath = join(repository, literalName);
      await writeFile(literalPath, SAFE_CANARY);
      await execFileAsync('git', ['--literal-pathspecs', 'add', '--', literalName], {
        cwd: repository,
      });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'literal path fixture'], {
        cwd: repository,
      });

      await expect(
        readGitHeadFromAllowedRoots({
          filePath: literalPath,
          allowedRoots: [root],
          errorPrefix: 'test',
          control: control(),
        })
      ).resolves.toBe(SAFE_CANARY);
    }
  );

  it('rejects a symlink whose canonical target escapes the admitted roots', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outside)]);
    await writeFile(join(outside, 'sequence.gb'), OUTSIDE_CANARY);
    await symlink(outside, join(allowed, 'redirect'), 'dir');

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(allowed, 'redirect', 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow('Path access denied');
  });

  it('does not inherit ambient Node loaders or secrets', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const markerPath = join(root, 'ambient-loader-ran');
    const loaderPath = join(root, 'ambient-loader.cjs');
    await writeFile(
      loaderPath,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.env.DNAFORGE_SECRET_PROBE ?? 'missing')\n`
    );
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousSecret = process.env.DNAFORGE_SECRET_PROBE;
    process.env.NODE_OPTIONS = `--require=${loaderPath}`;
    process.env.DNAFORGE_SECRET_PROBE = 'secret-reached-child';

    try {
      await expect(
        readGitHeadFromAllowedRoots({
          filePath: join(repository, 'sequence.gb'),
          allowedRoots: [root],
          errorPrefix: 'test',
          control: control(),
        })
      ).resolves.toBe(SAFE_CANARY);
      await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      if (previousSecret === undefined) delete process.env.DNAFORGE_SECRET_PROBE;
      else process.env.DNAFORGE_SECRET_PROBE = previousSecret;
    }
  });

  it('rejects streamed content when the admitted repository path is swapped during object read', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const safeRepository = join(allowed, 'repo');
    const parkedRepository = join(allowed, 'parked-repo');
    const outsideRepository = join(root, 'outside-repo');
    const fakeGitPath = join(root, 'fake-git.cjs');
    await Promise.all([
      mkdir(join(safeRepository, '.git', 'objects', 'info'), { recursive: true }),
      mkdir(join(outsideRepository, '.git', 'objects', 'info'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(safeRepository, 'sequence.gb'), SAFE_CANARY),
      writeFile(join(outsideRepository, 'sequence.gb'), OUTSIDE_CANARY),
    ]);
    await writeFile(
      fakeGitPath,
      String.raw`
const { readFileSync, renameSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const safeRepository = process.env.DNAFORGE_SAFE_REPOSITORY;
if (args.includes('--show-toplevel')) {
  process.stdout.write(safeRepository + '\n');
} else if (args.includes('--absolute-git-dir')) {
  process.stdout.write(join(safeRepository, '.git') + '\n');
} else if (args.includes('ls-files')) {
  process.stdout.write('sequence.gb\0');
} else if (args.includes('rev-parse')) {
  process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
} else if (args.includes('cat-file')) {
  renameSync(safeRepository, process.env.DNAFORGE_PARKED_REPOSITORY);
  symlinkSync(process.env.DNAFORGE_OUTSIDE_REPOSITORY, safeRepository, 'dir');
  process.stdout.write(readFileSync('../sequence.gb'));
} else {
  process.exitCode = 2;
}
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_SAFE_REPOSITORY: safeRepository,
        DNAFORGE_PARKED_REPOSITORY: parkedRepository,
        DNAFORGE_OUTSIDE_REPOSITORY: outsideRepository,
      },
    };

    let rejection: Error | null = null;
    try {
      await readGitHeadFromAllowedRoots({
        filePath: join(safeRepository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
        runtime,
      });
    } catch (error) {
      rejection = error as Error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection?.message).toMatch(
      /Path access denied|metadata authority|object size resolution|ENOENT/
    );
    expect(rejection?.message).not.toContain(OUTSIDE_CANARY.trim());
    expect(rejection?.message).not.toContain(SAFE_CANARY.trim());
  });

  it('rejects same-length outside bytes from a transient object-store swap that is restored', async () => {
    expect(TRANSIENT_OUTSIDE_CANARY).toHaveLength(SAFE_CANARY.length);
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const outsideObjectStore = join(root, 'outside-object-store');
    const outsidePayload = join(outsideObjectStore, 'payload.gb');
    const fakeGitPath = join(root, 'transient-object-store-git.cjs');
    await mkdir(outsideObjectStore);
    await writeFile(outsidePayload, TRANSIENT_OUTSIDE_CANARY);
    await writeFile(
      fakeGitPath,
      String.raw`
const {
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('cat-file') && args.includes('blob')) {
  const infoDirectory = join(process.env.DNAFORGE_TEST_REPOSITORY, '.git', 'objects', 'info');
  const directoryBefore = statSync(infoDirectory);
  const alternatesPath = join(infoDirectory, 'alternates');
  writeFileSync(alternatesPath, process.env.DNAFORGE_TEST_OUTSIDE_OBJECT_STORE + '\n');
  process.stdout.write(readFileSync(process.env.DNAFORGE_TEST_OUTSIDE_PAYLOAD));
  rmSync(alternatesPath);
  utimesSync(
    infoDirectory,
    directoryBefore.atimeMs / 1000,
    directoryBefore.mtimeMs / 1000
  );
  process.exit(0);
}
const result = spawnSync(process.env.DNAFORGE_REAL_GIT, args, {
  cwd: process.cwd(),
  env: process.env,
  encoding: null,
});
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 128;
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_REAL_GIT: 'git',
        DNAFORGE_TEST_REPOSITORY: repository,
        DNAFORGE_TEST_OUTSIDE_OBJECT_STORE: outsideObjectStore,
        DNAFORGE_TEST_OUTSIDE_PAYLOAD: outsidePayload,
      },
    };

    let rejection: Error | null = null;
    try {
      await readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
        runtime,
      });
    } catch (error) {
      rejection = error as Error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection?.message).toMatch(/content did not match.*object id/i);
    expect(rejection?.message).not.toContain(TRANSIENT_OUTSIDE_CANARY.trim());
    await expect(
      access(join(repository, '.git', 'objects', 'info', 'alternates'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads the captured ref snapshot when the original ref changes only during object selection', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const safeCommit = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    await writeFile(join(repository, 'sequence.gb'), TRANSIENT_OUTSIDE_CANARY);
    await execFileAsync('git', ['add', 'sequence.gb'], { cwd: repository });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'alternate fixture'], {
      cwd: repository,
    });
    const alternateCommit = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    await execFileAsync('git', ['reset', '--quiet', '--hard', safeCommit], { cwd: repository });

    const branch = (
      await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    const refPath = join(repository, '.git', 'refs', 'heads', branch);
    const markerPath = join(root, 'ref-changed-during-object-selection');
    const fakeGitPath = join(root, 'ref-change-git.cjs');
    await writeFile(
      fakeGitPath,
      String.raw`
const { readFileSync, statSync, utimesSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const selectsHeadObject =
  args.includes('rev-parse') &&
  args.includes('--verify') &&
  args.some((argument) => argument === 'HEAD:sequence.gb');
let refBefore;
let refMetadata;
if (selectsHeadObject) {
  refBefore = readFileSync(process.env.DNAFORGE_TEST_REF_PATH, 'utf8');
  refMetadata = statSync(process.env.DNAFORGE_TEST_REF_PATH);
  writeFileSync(
    process.env.DNAFORGE_TEST_REF_PATH,
    process.env.DNAFORGE_TEST_ALTERNATE_COMMIT + '\n'
  );
  writeFileSync(process.env.DNAFORGE_TEST_SWAP_MARKER, process.cwd() + '\n');
}
const result = spawnSync(process.env.DNAFORGE_REAL_GIT, args, {
  cwd: process.cwd(),
  env: process.env,
  encoding: null,
});
if (selectsHeadObject) {
  writeFileSync(process.env.DNAFORGE_TEST_REF_PATH, refBefore);
  utimesSync(
    process.env.DNAFORGE_TEST_REF_PATH,
    refMetadata.atimeMs / 1000,
    refMetadata.mtimeMs / 1000
  );
}
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 128;
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_REAL_GIT: 'git',
        DNAFORGE_TEST_REF_PATH: refPath,
        DNAFORGE_TEST_ALTERNATE_COMMIT: alternateCommit,
        DNAFORGE_TEST_SWAP_MARKER: markerPath,
      },
    };

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
        runtime,
      })
    ).resolves.toBe(SAFE_CANARY);
    const selectionDirectory = (await readFile(markerPath, 'utf8')).trim();
    expect(selectionDirectory).not.toBe(join(repository, '.git'));
    await expect(access(dirname(selectionDirectory))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(refPath, 'utf8')).resolves.toBe(`${safeCommit}\n`);
  });

  it('reads the captured index snapshot when the original index changes only during object selection', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const stagedPath = join(repository, 'staged.gb');
    const indexPath = join(repository, '.git', 'index');
    const safeIndexPath = join(root, 'safe-index');
    const alternateIndexPath = join(root, 'alternate-index');
    const markerPath = join(root, 'index-changed-during-object-selection');
    const fakeGitPath = join(root, 'index-change-git.cjs');

    await writeFile(stagedPath, SAFE_CANARY);
    await execFileAsync('git', ['add', 'staged.gb'], { cwd: repository });
    await copyFile(indexPath, safeIndexPath);
    await writeFile(stagedPath, TRANSIENT_OUTSIDE_CANARY);
    await execFileAsync('git', ['add', 'staged.gb'], { cwd: repository });
    await copyFile(indexPath, alternateIndexPath);
    await copyFile(safeIndexPath, indexPath);

    await writeFile(
      fakeGitPath,
      String.raw`
const { readFileSync, statSync, utimesSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const selectsIndexObject =
  args.includes('rev-parse') &&
  args.includes('--verify') &&
  args.some((argument) => argument === ':0:staged.gb');
let indexBefore;
let indexMetadata;
if (selectsIndexObject) {
  indexBefore = readFileSync(process.env.DNAFORGE_TEST_INDEX_PATH);
  indexMetadata = statSync(process.env.DNAFORGE_TEST_INDEX_PATH);
  writeFileSync(
    process.env.DNAFORGE_TEST_INDEX_PATH,
    readFileSync(process.env.DNAFORGE_TEST_ALTERNATE_INDEX_PATH)
  );
  writeFileSync(process.env.DNAFORGE_TEST_SWAP_MARKER, process.cwd() + '\n');
}
const result = spawnSync(process.env.DNAFORGE_REAL_GIT, args, {
  cwd: process.cwd(),
  env: process.env,
  encoding: null,
});
if (selectsIndexObject) {
  writeFileSync(process.env.DNAFORGE_TEST_INDEX_PATH, indexBefore);
  utimesSync(
    process.env.DNAFORGE_TEST_INDEX_PATH,
    indexMetadata.atimeMs / 1000,
    indexMetadata.mtimeMs / 1000
  );
}
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 128;
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_REAL_GIT: 'git',
        DNAFORGE_TEST_INDEX_PATH: indexPath,
        DNAFORGE_TEST_ALTERNATE_INDEX_PATH: alternateIndexPath,
        DNAFORGE_TEST_SWAP_MARKER: markerPath,
      },
    };

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: stagedPath,
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
        runtime,
      })
    ).resolves.toBe(SAFE_CANARY);
    const selectionDirectory = (await readFile(markerPath, 'utf8')).trim();
    expect(selectionDirectory).not.toBe(join(repository, '.git'));
    await expect(access(dirname(selectionDirectory))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(indexPath)).resolves.toEqual(await readFile(safeIndexPath));
  });

  it('rejects a linked-worktree common directory outside the admitted roots', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const repository = join(allowed, 'repo');
    const metadata = join(allowed, 'metadata');
    const outsideRepository = await createRepository(root, OUTSIDE_CANARY);
    await Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(metadata, { recursive: true }),
    ]);
    await writeFile(join(repository, 'sequence.gb'), SAFE_CANARY);
    await Promise.all([
      writeFile(join(repository, '.git'), `gitdir: ${metadata}\n`),
      copyFile(join(outsideRepository, '.git', 'HEAD'), join(metadata, 'HEAD')),
      copyFile(join(outsideRepository, '.git', 'index'), join(metadata, 'index')),
      writeFile(join(metadata, 'commondir'), `${join(outsideRepository, '.git')}\n`),
      writeFile(join(metadata, 'gitdir'), `${join(repository, '.git')}\n`),
    ]);

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow('Git common directory');
  });

  it('reads a linked worktree when its common directory remains admitted', async () => {
    const root = await createTemporaryRoot();
    const sourceParent = join(root, 'source-parent');
    await mkdir(sourceParent);
    const sourceRepository = await createRepository(sourceParent);
    const linkedWorktree = join(root, 'linked-worktree');
    await execFileAsync('git', ['worktree', 'add', '--quiet', '--detach', linkedWorktree, 'HEAD'], {
      cwd: sourceRepository,
    });

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(linkedWorktree, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);
  });

  it('receipts linked-worktree refs and rejects a symlinked per-worktree namespace', async () => {
    const root = await createTemporaryRoot();
    const sourceParent = join(root, 'source-parent');
    await mkdir(sourceParent);
    const sourceRepository = await createRepository(sourceParent);
    const linkedWorktree = join(root, 'linked-worktree');
    await execFileAsync('git', ['worktree', 'add', '--quiet', '--detach', linkedWorktree, 'HEAD'], {
      cwd: sourceRepository,
    });
    const commit = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: linkedWorktree })
    ).stdout.trim();
    await execFileAsync('git', ['update-ref', 'refs/worktree/fixture', commit], {
      cwd: linkedWorktree,
    });
    await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/worktree/fixture'], {
      cwd: linkedWorktree,
    });

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(linkedWorktree, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);

    const gitDirectory = (
      await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: linkedWorktree })
    ).stdout.trim();
    const admittedWorktreeRefs = join(gitDirectory, 'refs', 'worktree');
    const parkedWorktreeRefs = join(root, 'parked-worktree-refs');
    await rename(admittedWorktreeRefs, parkedWorktreeRefs);
    await symlink(parkedWorktreeRefs, admittedWorktreeRefs, 'dir');

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(linkedWorktree, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git per-worktree refs\/worktree.*non-symlink/i);
  });

  it('receipts the linked-worktree reftable backend and rejects a symlinked stack', async () => {
    const root = await createTemporaryRoot();
    const sourceRepository = join(root, 'source');
    await mkdir(sourceRepository);
    await execFileAsync('git', ['init', '--quiet', '--ref-format=reftable'], {
      cwd: sourceRepository,
    });
    await execFileAsync('git', ['config', 'user.email', 'test@dnaforge.invalid'], {
      cwd: sourceRepository,
    });
    await execFileAsync('git', ['config', 'user.name', 'DNAForge Test'], {
      cwd: sourceRepository,
    });
    await writeFile(join(sourceRepository, 'sequence.gb'), SAFE_CANARY);
    await execFileAsync('git', ['add', 'sequence.gb'], { cwd: sourceRepository });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], {
      cwd: sourceRepository,
    });
    const linkedWorktree = join(root, 'linked-worktree');
    await execFileAsync('git', ['worktree', 'add', '--quiet', '--detach', linkedWorktree, 'HEAD'], {
      cwd: sourceRepository,
    });
    const commit = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: linkedWorktree })
    ).stdout.trim();
    await execFileAsync('git', ['update-ref', 'refs/worktree/fixture', commit], {
      cwd: linkedWorktree,
    });
    await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/worktree/fixture'], {
      cwd: linkedWorktree,
    });

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(linkedWorktree, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);

    const gitDirectory = (
      await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: linkedWorktree })
    ).stdout.trim();
    const admittedReftable = join(gitDirectory, 'reftable');
    const parkedReftable = join(root, 'parked-worktree-reftable');
    await rename(admittedReftable, parkedReftable);
    await symlink(parkedReftable, admittedReftable, 'dir');
    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(linkedWorktree, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git worktree reftable directory.*non-symlink/i);
  });

  it('accepts a legacy HEAD symlink only when it targets admitted ref storage', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const branch = (
      await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    const headPath = join(repository, '.git', 'HEAD');
    await rm(headPath);
    await symlink(join('refs', 'heads', branch), headPath);

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);
  });

  it('rejects a legacy HEAD symlink whose target escapes admitted ref storage', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outside)]);
    const repository = await createRepository(allowed);
    const commit = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    const outsideRef = join(outside, 'outside-head');
    await writeFile(outsideRef, `${commit}\n`);
    const headPath = join(repository, '.git', 'HEAD');
    await rm(headPath);
    await symlink(outsideRef, headPath);
    const fakeGitPath = join(root, 'head-discovery-git.cjs');
    await writeFile(
      fakeGitPath,
      String.raw`
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--show-toplevel')) {
  process.stdout.write(process.env.DNAFORGE_TEST_REPOSITORY + '\n');
} else if (args.includes('--absolute-git-dir')) {
  process.stdout.write(join(process.env.DNAFORGE_TEST_REPOSITORY, '.git') + '\n');
} else {
  process.exitCode = 2;
}
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_TEST_REPOSITORY: repository,
      },
    };

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
        runtime,
      })
    ).rejects.toThrow(/Path access denied: Git HEAD target/i);
  });

  it('rejects repository config includes before content-resolution Git commands', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outside)]);
    const repository = await createRepository(allowed);
    const outsideConfig = join(outside, 'included.config');
    await writeFile(outsideConfig, '[core]\n\tfsmonitor = false\n');
    await execFileAsync('git', ['config', '--add', 'include.path', outsideConfig], {
      cwd: repository,
    });

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git repository config may not include another config file/i);
  });

  it('receipts worktree config and rejects a symlinked config authority', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    await execFileAsync('git', ['config', 'extensions.worktreeConfig', 'true'], {
      cwd: repository,
    });
    await execFileAsync('git', ['config', '--worktree', 'core.fsmonitor', 'false'], {
      cwd: repository,
    });

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);

    const worktreeConfig = join(repository, '.git', 'config.worktree');
    const parkedConfig = join(root, 'parked-worktree.config');
    await rename(worktreeConfig, parkedConfig);
    await symlink(parkedConfig, worktreeConfig);
    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git worktree config.*non-symlink/i);
  });

  it('rejects a same-size repository config mutation during the read transaction', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    await execFileAsync('git', ['config', 'dnaforge.marker', 'safe'], { cwd: repository });
    const configPath = join(repository, '.git', 'config');
    const fakeGitPath = join(root, 'mutating-git.cjs');
    await writeFile(
      fakeGitPath,
      String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('ls-files')) {
  const configPath = process.env.DNAFORGE_TEST_CONFIG;
  const before = readFileSync(configPath, 'utf8');
  const after = before.replace('marker = safe', 'marker = evil');
  if (after.length !== before.length || after === before) {
    throw new Error('same-size config mutation fixture did not apply');
  }
  writeFileSync(configPath, after);
}
const result = spawnSync(process.env.DNAFORGE_REAL_GIT, args, {
  cwd: process.cwd(),
  env: process.env,
  encoding: null,
});
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 128;
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_REAL_GIT: 'git',
        DNAFORGE_TEST_CONFIG: configPath,
      },
    };

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
        runtime,
      })
    ).rejects.toThrow(/metadata authority changed.*repositoryConfigs/i);
  });

  it('rejects a loose-ref rewrite that preserves inode, size, and modification time', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const branch = (
      await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    const refPath = join(repository, '.git', 'refs', 'heads', branch);
    const safeRef = await readFile(refPath);
    await writeFile(join(repository, 'sequence.gb'), OUTSIDE_CANARY);
    await execFileAsync('git', ['add', 'sequence.gb'], { cwd: repository });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'outside fixture'], {
      cwd: repository,
    });
    const mutatedRef = await readFile(refPath);
    expect(mutatedRef.byteLength).toBe(safeRef.byteLength);
    await writeFile(refPath, safeRef);

    const fakeGitPath = join(root, 'same-metadata-ref-git.cjs');
    const mutatedRefSnapshot = join(root, 'mutated-ref');
    await writeFile(mutatedRefSnapshot, mutatedRef);
    await writeFile(
      fakeGitPath,
      String.raw`
const { readFileSync, statSync, utimesSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('ls-files')) {
  const refPath = process.env.DNAFORGE_TEST_REF;
  const before = statSync(refPath);
  const replacement = readFileSync(process.env.DNAFORGE_TEST_MUTATED_REF);
  if (replacement.byteLength !== before.size) {
    throw new Error('same-size loose-ref mutation fixture did not apply');
  }
  writeFileSync(refPath, replacement);
  utimesSync(refPath, before.atimeMs / 1000, before.mtimeMs / 1000);
}
const result = spawnSync(process.env.DNAFORGE_REAL_GIT, args, {
  cwd: process.cwd(),
  env: process.env,
  encoding: null,
});
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 128;
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_REAL_GIT: 'git',
        DNAFORGE_TEST_REF: refPath,
        DNAFORGE_TEST_MUTATED_REF: mutatedRefSnapshot,
      },
    };

    let rejection: Error | null = null;
    try {
      await readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
        runtime,
      });
    } catch (error) {
      rejection = error as Error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection?.message).toMatch(/metadata authority changed.*refs/i);
    expect(rejection?.message).not.toContain(OUTSIDE_CANARY.trim());
  });

  it('rejects an index rewrite that preserves inode, size, and modification time', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const stagedPath = join(repository, 'staged.gb');
    const indexPath = join(repository, '.git', 'index');
    await writeFile(stagedPath, SAFE_CANARY);
    await execFileAsync('git', ['add', 'staged.gb'], { cwd: repository });
    const safeIndex = await readFile(indexPath);
    await writeFile(stagedPath, OUTSIDE_CANARY);
    await execFileAsync('git', ['add', 'staged.gb'], { cwd: repository });
    const mutatedIndex = await readFile(indexPath);
    expect(mutatedIndex.byteLength).toBe(safeIndex.byteLength);
    await writeFile(indexPath, safeIndex);
    await writeFile(stagedPath, SAFE_CANARY);

    const fakeGitPath = join(root, 'same-metadata-index-git.cjs');
    const mutatedIndexSnapshot = join(root, 'mutated-index');
    await writeFile(mutatedIndexSnapshot, mutatedIndex);
    await writeFile(
      fakeGitPath,
      String.raw`
const { readFileSync, statSync, utimesSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('ls-files')) {
  const indexPath = process.env.DNAFORGE_TEST_INDEX;
  const before = statSync(indexPath);
  const replacement = readFileSync(process.env.DNAFORGE_TEST_MUTATED_INDEX);
  if (replacement.byteLength !== before.size) {
    throw new Error('same-size index mutation fixture did not apply');
  }
  writeFileSync(indexPath, replacement);
  utimesSync(indexPath, before.atimeMs / 1000, before.mtimeMs / 1000);
}
const result = spawnSync(process.env.DNAFORGE_REAL_GIT, args, {
  cwd: process.cwd(),
  env: process.env,
  encoding: null,
});
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 128;
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_REAL_GIT: 'git',
        DNAFORGE_TEST_INDEX: indexPath,
        DNAFORGE_TEST_MUTATED_INDEX: mutatedIndexSnapshot,
      },
    };

    let rejection: Error | null = null;
    try {
      await readGitHeadFromAllowedRoots({
        filePath: stagedPath,
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
        runtime,
      });
    } catch (error) {
      rejection = error as Error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection?.message).toMatch(/metadata authority changed.*index/i);
    expect(rejection?.message).not.toContain(OUTSIDE_CANARY.trim());
  });

  it('rejects an oversized linked-worktree gitfile before reading its contents', async () => {
    const root = await createTemporaryRoot();
    const repository = join(root, 'repo');
    const metadata = join(root, 'metadata');
    const fakeGitPath = join(root, 'fake-git.cjs');
    await Promise.all([mkdir(repository), mkdir(metadata)]);
    await writeFile(join(repository, 'sequence.gb'), SAFE_CANARY);
    const prefix = Buffer.from(`gitdir: ${metadata}\n`, 'utf8');
    await writeFile(
      join(repository, '.git'),
      Buffer.concat([prefix, Buffer.alloc(1024 * 1024, 120)])
    );
    await writeFile(
      fakeGitPath,
      String.raw`
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--show-toplevel')) {
  process.stdout.write(process.env.DNAFORGE_TEST_REPOSITORY + '\n');
} else if (args.includes('--absolute-git-dir')) {
  process.stdout.write(process.env.DNAFORGE_TEST_METADATA + '\n');
} else {
  process.exitCode = 2;
}
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_TEST_REPOSITORY: repository,
        DNAFORGE_TEST_METADATA: metadata,
      },
    };

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
        runtime,
      })
    ).rejects.toThrow(/metadata pointer.*bounded regular file/i);
  });

  it('rejects a Git object alternate outside the admitted roots', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outsideParent = join(root, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outsideParent)]);
    const repository = await createRepository(allowed);
    const outsideRepository = await createRepository(outsideParent, OUTSIDE_CANARY);
    const objectInfo = join(repository, '.git', 'objects', 'info');
    await mkdir(objectInfo, { recursive: true });
    await writeFile(
      join(objectInfo, 'alternates'),
      `${join(outsideRepository, '.git', 'objects')}\n`
    );

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow('Git object directory');
  });

  it('allows a Git object alternate that remains inside the admitted roots', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const secondaryParent = join(allowed, 'secondary');
    await mkdir(secondaryParent, { recursive: true });
    const repository = await createRepository(allowed);
    const secondaryRepository = await createRepository(secondaryParent, OUTSIDE_CANARY);
    const objectInfo = join(repository, '.git', 'objects', 'info');
    await mkdir(objectInfo, { recursive: true });
    await writeFile(
      join(objectInfo, 'alternates'),
      `${join(secondaryRepository, '.git', 'objects')}\n`
    );

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);
  });

  it('rejects a ref symlink before Git may resolve its outside target', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outside)]);
    const repository = await createRepository(allowed);
    const outsideRepository = await createRepository(outside, OUTSIDE_CANARY);
    const branch = (
      await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    const outsideHead = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: outsideRepository })
    ).stdout.trim();
    const outsideRef = join(outsideRepository, 'outside-head-ref');
    await writeFile(outsideRef, `${outsideHead}\n`);
    const admittedRef = join(repository, '.git', 'refs', 'heads', branch);
    await rm(admittedRef);
    await symlink(outsideRef, admittedRef);
    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git refs directory.*symbolic links/i);
  });

  it('rejects a reftable directory symlink before Git may resolve its outside target', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    const repository = join(allowed, 'repo');
    await Promise.all([mkdir(repository, { recursive: true }), mkdir(outside)]);
    await execFileAsync('git', ['init', '--quiet', '--ref-format=reftable'], {
      cwd: repository,
    });
    await execFileAsync('git', ['config', 'user.email', 'test@dnaforge.invalid'], {
      cwd: repository,
    });
    await execFileAsync('git', ['config', 'user.name', 'DNAForge Test'], {
      cwd: repository,
    });
    await writeFile(join(repository, 'sequence.gb'), SAFE_CANARY);
    await execFileAsync('git', ['add', 'sequence.gb'], { cwd: repository });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repository });

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);

    const admittedReftable = join(repository, '.git', 'reftable');
    const outsideReftable = join(outside, 'reftable');
    await rename(admittedReftable, outsideReftable);
    await symlink(outsideReftable, admittedReftable, 'dir');

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git reftable directory.*non-symlink/i);
  });

  it('receipts a valid split index and rejects an outside shared-index symlink', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outside)]);
    const repository = await createRepository(allowed);
    await execFileAsync('git', ['update-index', '--split-index'], { cwd: repository });

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);

    const gitDirectory = join(repository, '.git');
    const sharedIndexName = (await readdir(gitDirectory)).find((name) =>
      /^sharedindex\.[0-9a-f]{40,64}$/.test(name)
    );
    expect(sharedIndexName).toBeDefined();
    const admittedSharedIndex = join(gitDirectory, sharedIndexName!);
    const outsideSharedIndex = join(outside, sharedIndexName!);
    await rename(admittedSharedIndex, outsideSharedIndex);
    await symlink(outsideSharedIndex, admittedSharedIndex);

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git shared index.*non-symlink/i);
  });

  it('rejects a symlinked pack directory beneath an admitted object store', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outside)]);
    const repository = await createRepository(allowed);
    await execFileAsync('git', ['gc', '--quiet', '--prune=now'], { cwd: repository });
    const admittedPack = join(repository, '.git', 'objects', 'pack');
    const outsidePack = join(outside, 'pack');
    await rename(admittedPack, outsidePack);
    await symlink(outsidePack, admittedPack, 'dir');

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git object store.*symbolic links/i);
  });

  it('reads committed content from a valid packed object store', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    await execFileAsync('git', ['gc', '--quiet', '--prune=now'], { cwd: repository });

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBe(SAFE_CANARY);
  });

  it('rejects a symlinked loose object selected for the read', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outside)]);
    const repository = await createRepository(allowed);
    const objectId = (
      await execFileAsync('git', ['rev-parse', 'HEAD:sequence.gb'], { cwd: repository })
    ).stdout.trim();
    const looseObject = join(
      repository,
      '.git',
      'objects',
      objectId.slice(0, 2),
      objectId.slice(2)
    );
    const outsideObject = join(outside, 'object');
    await rename(looseObject, outsideObject);
    await symlink(outsideObject, looseObject);

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git loose object store.*symbolic links/i);
  });

  it('rejects a symlinked loose commit before Git traverses it to resolve the blob', async () => {
    const root = await createTemporaryRoot();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(allowed), mkdir(outside)]);
    const repository = await createRepository(allowed);
    const commitId = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    const looseCommit = join(
      repository,
      '.git',
      'objects',
      commitId.slice(0, 2),
      commitId.slice(2)
    );
    const outsideCommit = join(outside, 'commit-object');
    await rename(looseCommit, outsideCommit);
    await symlink(outsideCommit, looseCommit);

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [allowed],
        errorPrefix: 'test',
        control: control(),
      })
    ).rejects.toThrow(/Git loose object store.*symbolic links/i);
  });

  it('aborts and retains the helper as its one bound physical child', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const controller = new AbortController();
    const children: OwnedGitReadProcess[] = [];

    const result = readGitHeadFromAllowedRoots({
      filePath: join(repository, 'sequence.gb'),
      allowedRoots: [root],
      errorPrefix: 'test',
      control: control({ controller, children, onBind: () => controller.abort() }),
    });

    await expect(result).rejects.toThrow(/abort|exited|terminated/i);
    expect(children).toHaveLength(1);
  });

  it('removes the parent-owned metadata snapshot after cancellation', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const workerPath = join(root, 'snapshot-cleanup-worker.cjs');
    const markerPath = join(root, 'snapshot-cleanup-marker');
    await writeFile(
      workerPath,
      String.raw`
const { writeFileSync } = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const terminator = input.indexOf('\n');
  if (terminator < 0) return;
  const request = JSON.parse(input.slice(0, terminator));
  writeFileSync(process.env.DNAFORGE_TEST_SNAPSHOT_MARKER, request.snapshotRoot + '\n');
  setInterval(() => {}, 1000);
});
`
    );
    const controller = new AbortController();
    const result = readGitHeadFromAllowedRoots({
      filePath: join(repository, 'sequence.gb'),
      allowedRoots: [root],
      errorPrefix: 'test',
      control: control({ controller }),
      workerScriptPath: workerPath,
      runtime: {
        executable: process.execPath,
        argumentPrefix: [],
        environment: {
          DNAFORGE_TEST_SNAPSHOT_MARKER: markerPath,
        },
      },
    });
    const rejection = expect(result).rejects.toThrow(/exited|terminated/i);
    await waitForFile(markerPath);
    const snapshotRoot = (await readFile(markerPath, 'utf8')).trim();

    controller.abort();
    await rejection;
    await expect(access(snapshotRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')(
    'terminates the detached helper process group when its Electron owner exits',
    async () => {
      const root = await createTemporaryRoot();
      const repository = await createRepository(root);
      const workerPath = resolve(__dirname, '../../../resources/git-read-worker.cjs');
      const fakeGitPath = join(root, 'owner-loss-git.cjs');
      const ownerFixturePath = join(root, 'owner-loss-fixture.cjs');
      const nestedMarker = join(root, 'owner-loss-nested.json');
      const helperMarker = join(root, 'owner-loss-helper.json');
      await writeFile(
        fakeGitPath,
        String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const repository = process.env.DNAFORGE_TEST_REPOSITORY;
if (args.includes('--show-toplevel')) {
  process.stdout.write(repository + '\n');
} else if (args.includes('--absolute-git-dir')) {
  process.stdout.write(join(repository, '.git') + '\n');
} else if (args.includes('ls-files')) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
  });
  writeFileSync(
    process.env.DNAFORGE_TEST_NESTED_MARKER,
    JSON.stringify({ git: process.pid, grandchild: grandchild.pid })
  );
  setInterval(() => {}, 1000);
} else {
  process.exitCode = 2;
}
`
      );
      await writeFile(
        ownerFixturePath,
        String.raw`
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const snapshotRoot = mkdtempSync(join(process.env.DNAFORGE_TEST_ROOT, 'dnaforge-git-read-'));
const worker = spawn(process.execPath, [process.env.DNAFORGE_TEST_WORKER], {
  detached: true,
  env: process.env,
  stdio: ['pipe', 'ignore', 'ignore'],
});
worker.stdin.write(
  JSON.stringify({
    filePath: process.env.DNAFORGE_TEST_FILE,
    allowedRoots: [process.env.DNAFORGE_TEST_ROOT],
    gitExecutable: process.execPath,
    gitArgumentPrefix: [process.env.DNAFORGE_TEST_FAKE_GIT],
    gitConfigArgs: [],
    metadataMaxBuffer: 1024 * 1024,
    contentMaxBuffer: 1024 * 1024,
    snapshotRoot,
  }) + '\n'
);
const deadline = Date.now() + 5000;
const wait = () => {
  if (existsSync(process.env.DNAFORGE_TEST_NESTED_MARKER)) {
    writeFileSync(process.env.DNAFORGE_TEST_HELPER_MARKER, JSON.stringify({ helper: worker.pid }));
    process.exit(0);
  }
  if (Date.now() >= deadline) process.exit(2);
  setTimeout(wait, 20);
};
wait();
`
      );

      const ownerResult = await execFileAsync(process.execPath, [ownerFixturePath], {
        env: {
          ...process.env,
          DNAFORGE_TEST_WORKER: workerPath,
          DNAFORGE_TEST_FAKE_GIT: fakeGitPath,
          DNAFORGE_TEST_REPOSITORY: repository,
          DNAFORGE_TEST_ROOT: root,
          DNAFORGE_TEST_FILE: join(repository, 'sequence.gb'),
          DNAFORGE_TEST_NESTED_MARKER: nestedMarker,
          DNAFORGE_TEST_HELPER_MARKER: helperMarker,
        },
      });
      expect(ownerResult.stderr).toBe('');
      const helper = JSON.parse(await readFile(helperMarker, 'utf8')) as { helper: number };
      const nested = JSON.parse(await readFile(nestedMarker, 'utf8')) as {
        git: number;
        grandchild: number;
      };
      const pids = [helper.helper, nested.git, nested.grandchild];
      for (const pid of pids) {
        expect(Number.isSafeInteger(pid)).toBe(true);
        spawnedPids.add(pid);
      }
      await waitForProcessesToExit(pids);
      for (const pid of pids) spawnedPids.delete(pid);
    }
  );

  it('does not settle cancellation until the nested Git process tree exits', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const markerPath = join(root, 'nested-git.pid');
    const fakeGitPath = join(root, 'blocking-git.cjs');
    await writeFile(
      fakeGitPath,
      String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const repository = process.env.DNAFORGE_TEST_REPOSITORY;
if (args.includes('--show-toplevel')) {
  process.stdout.write(repository + '\n');
} else if (args.includes('--absolute-git-dir')) {
  process.stdout.write(join(repository, '.git') + '\n');
} else if (args.includes('ls-files')) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
  });
  writeFileSync(
    process.env.DNAFORGE_TEST_PID_MARKER,
    JSON.stringify({ git: process.pid, grandchild: grandchild.pid })
  );
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else {
  process.exitCode = 2;
}
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_TEST_REPOSITORY: repository,
        DNAFORGE_TEST_PID_MARKER: markerPath,
      },
    };
    const controller = new AbortController();
    const children: OwnedGitReadProcess[] = [];
    const result = readGitHeadFromAllowedRoots({
      filePath: join(repository, 'sequence.gb'),
      allowedRoots: [root],
      errorPrefix: 'test',
      control: control({ controller, children }),
      runtime,
    });
    await waitForFile(markerPath);
    const pids = JSON.parse(await readFile(markerPath, 'utf8')) as {
      git: number;
      grandchild: number;
    };
    expect(Number.isSafeInteger(pids.git)).toBe(true);
    expect(Number.isSafeInteger(pids.grandchild)).toBe(true);
    spawnedPids.add(pids.git);
    spawnedPids.add(pids.grandchild);

    controller.abort();
    await expect(result).rejects.toThrow(/cancel|exited|terminated/i);
    expect(processExists(pids.git)).toBe(false);
    expect(processExists(pids.grandchild)).toBe(false);
    spawnedPids.delete(pids.git);
    spawnedPids.delete(pids.grandchild);
    expect(children).toHaveLength(1);
  });

  it('does not settle a bounded-output failure until the nested Git process exits', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const markerPath = join(root, 'overflowing-git.pid');
    const fakeGitPath = join(root, 'overflowing-git.cjs');
    await writeFile(
      fakeGitPath,
      String.raw`
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const repository = process.env.DNAFORGE_TEST_REPOSITORY;
if (args.includes('--show-toplevel')) {
  process.stdout.write(repository + '\n');
} else if (args.includes('--absolute-git-dir')) {
  process.stdout.write(join(repository, '.git') + '\n');
} else if (args.includes('ls-files')) {
  writeFileSync(process.env.DNAFORGE_TEST_PID_MARKER, String(process.pid));
  process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 120));
  setInterval(() => {}, 1_000);
} else {
  process.exitCode = 2;
}
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_TEST_REPOSITORY: repository,
        DNAFORGE_TEST_PID_MARKER: markerPath,
      },
    };
    const result = readGitHeadFromAllowedRoots({
      filePath: join(repository, 'sequence.gb'),
      allowedRoots: [root],
      errorPrefix: 'test',
      control: control(),
      runtime,
    });
    const rejection = expect(result).rejects.toThrow(/stderr exceeded its byte limit/i);
    await waitForFile(markerPath);
    const nestedGitPid = Number((await readFile(markerPath, 'utf8')).trim());
    expect(Number.isSafeInteger(nestedGitPid)).toBe(true);
    spawnedPids.add(nestedGitPid);

    await rejection;
    expect(processExists(nestedGitPid)).toBe(false);
    spawnedPids.delete(nestedGitPid);
  });

  it('drains the Git process tree when the helper crashes immediately after Git starts', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const markerPath = join(root, 'crashed-helper-descendants.json');
    const fakeGitPath = join(root, 'crash-helper-git.cjs');
    await writeFile(
      fakeGitPath,
      String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const repository = process.env.DNAFORGE_TEST_REPOSITORY;
if (args.includes('--show-toplevel')) {
  process.stdout.write(repository + '\n');
} else if (args.includes('--absolute-git-dir')) {
  process.stdout.write(join(repository, '.git') + '\n');
} else if (args.includes('ls-files')) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
  });
  writeFileSync(
    process.env.DNAFORGE_TEST_PID_MARKER,
    JSON.stringify({ git: process.pid, grandchild: grandchild.pid })
  );
  const helperPid = Number(process.env.DNAFORGE_GIT_READ_HELPER_PID);
  if (!Number.isSafeInteger(helperPid)) throw new Error('Missing Git read helper PID.');
  setTimeout(() => process.kill(helperPid, 'SIGKILL'), 0);
  setInterval(() => {}, 1_000);
} else {
  process.exitCode = 2;
}
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_TEST_REPOSITORY: repository,
        DNAFORGE_TEST_PID_MARKER: markerPath,
      },
    };
    const result = readGitHeadFromAllowedRoots({
      filePath: join(repository, 'sequence.gb'),
      allowedRoots: [root],
      errorPrefix: 'test',
      control: control(),
      runtime,
    });
    const rejection = expect(result).rejects.toThrow(/helper exited|terminated/i);
    await waitForFile(markerPath);
    const pids = JSON.parse(await readFile(markerPath, 'utf8')) as {
      git: number;
      grandchild: number;
    };
    expect(Number.isSafeInteger(pids.git)).toBe(true);
    expect(Number.isSafeInteger(pids.grandchild)).toBe(true);
    spawnedPids.add(pids.git);
    spawnedPids.add(pids.grandchild);

    await rejection;
    expect(processExists(pids.git)).toBe(false);
    expect(processExists(pids.grandchild)).toBe(false);
    spawnedPids.delete(pids.git);
    spawnedPids.delete(pids.grandchild);
  });

  it('does not admit the next queued read until the cancelled process group is absent', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const markerPath = join(root, 'queued-tree.json');
    const fakeGitPath = join(root, 'queued-tree-git.cjs');
    await writeFile(
      fakeGitPath,
      String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const repository = process.env.DNAFORGE_TEST_REPOSITORY;
if (args.includes('--show-toplevel')) {
  process.stdout.write(repository + '\n');
} else if (args.includes('--absolute-git-dir')) {
  process.stdout.write(join(repository, '.git') + '\n');
} else if (args.includes('ls-files')) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: false,
    stdio: 'ignore',
  });
  writeFileSync(
    process.env.DNAFORGE_TEST_PID_MARKER,
    JSON.stringify({ git: process.pid, grandchild: grandchild.pid })
  );
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else {
  process.exitCode = 2;
}
`
    );
    const runtime: SterileGitReadRuntime = {
      executable: process.execPath,
      argumentPrefix: [fakeGitPath],
      environment: {
        PATH: process.env.PATH,
        DNAFORGE_TEST_REPOSITORY: repository,
        DNAFORGE_TEST_PID_MARKER: markerPath,
      },
    };
    const emitter = new EventEmitter();
    const sender: GitReadSender = {
      id: 9,
      isDestroyed: () => false,
      once: emitter.once.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
    };
    const owner = new GitReadRequestOwner({
      maxActive: 1,
      maxQueued: 1,
      timeoutMs: 10_000,
      hardKillGraceMs: 100,
    });
    const firstRequestId = '11111111-1111-4111-8111-111111111111';
    const first = owner.run({
      sender,
      requestId: firstRequestId,
      execute: (executionControl) =>
        readGitHeadFromAllowedRoots({
          filePath: join(repository, 'sequence.gb'),
          allowedRoots: [root],
          errorPrefix: 'test',
          control: executionControl,
          runtime,
        }),
    });
    await waitForFile(markerPath);
    const pids = JSON.parse(await readFile(markerPath, 'utf8')) as {
      git: number;
      grandchild: number;
    };
    spawnedPids.add(pids.git);
    spawnedPids.add(pids.grandchild);

    let firstTreeAliveWhenSecondStarted: boolean | null = null;
    const second = owner.run({
      sender,
      requestId: '22222222-2222-4222-8222-222222222222',
      execute: async () => {
        firstTreeAliveWhenSecondStarted = processExists(pids.git) || processExists(pids.grandchild);
        return null;
      },
    });
    expect(owner.cancel(sender.id, firstRequestId)).toBe(true);
    await expect(first).rejects.toThrow(/cancel|exited|terminated/i);
    await expect(second).resolves.toBeNull();
    expect(firstTreeAliveWhenSecondStarted).toBe(false);
    expect(processExists(pids.git)).toBe(false);
    expect(processExists(pids.grandchild)).toBe(false);
    spawnedPids.delete(pids.git);
    spawnedPids.delete(pids.grandchild);
  });

  it('fails closed if the admitted repository moves before metadata anchoring', async () => {
    const root = await createTemporaryRoot();
    const repository = await createRepository(root);
    const movedRepository = join(root, 'moved-repo');
    await rename(repository, movedRepository);

    await expect(
      readGitHeadFromAllowedRoots({
        filePath: join(repository, 'sequence.gb'),
        allowedRoots: [root],
        errorPrefix: 'test',
        control: control(),
      })
    ).resolves.toBeNull();
  });
});
