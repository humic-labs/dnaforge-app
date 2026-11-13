import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exec as execGit, resolveEmbeddedGitDir, resolveGitBinary } from 'dugite';
import { afterEach, describe, expect, it } from 'vitest';

import { createSterileGitReadRuntime, executeOwnedGitRead } from './git-read-executor';
import { createMutableSubprocessEnvironment } from './sterile-subprocess-environment';
import { executeManagedGit, hashManagedGitBlob } from '../workspace-git/native';

const temporaryRepositories: string[] = [];

function shellCommandPath(value: string): string {
  return value.replaceAll('\\', '/').replaceAll('"', '\\"');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('sterile Git read policy', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRepositories.splice(0).map((repo) => rm(repo, { recursive: true, force: true }))
    );
  });

  it('enables long Windows paths in the bundled process without changing repository configuration', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'dnaforge-git-long-path-policy-'));
    temporaryRepositories.push(repo);
    await execGit(['init', '--quiet'], repo);
    const result = await executeOwnedGitRead({
      args: ['config', '--bool', '--get', 'core.longpaths'],
      cwd: repo,
      maxBuffer: 1024,
      control: { signal: new AbortController().signal, bindProcess: () => undefined },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('true');
    const repositorySetting = await execGit(['config', '--local', '--get', 'core.longpaths'], repo);
    expect(repositorySetting.exitCode).toBe(1);
  });

  it('stages, commits and reads the original long Unicode notebook path through managed Git', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'dnaforge-long-notebook-'));
    temporaryRepositories.push(scratch);
    const repo = join(
      scratch,
      'managed-workspaces',
      ...Array(3).fill('retained-owner-project-and-imported-example')
    );
    const folder = 'notebooks/01 — Programme charter — burden-aware three-input logic in E. coli';
    const path = `${folder}/Programme charter — burden-aware three-input logic in E. coli.md`;
    const contents = '# Retained notebook\nExact authored bytes.\n';
    await mkdir(join(repo, folder), { recursive: true });
    expect(join(repo, path).length).toBeGreaterThan(260);
    await writeFile(join(repo, path), contents);
    await executeManagedGit(repo, ['init', '--quiet']);
    await executeManagedGit(repo, ['config', '--local', 'core.longpaths', 'false']);
    expect(
      (await executeManagedGit(repo, ['config', '--bool', '--get', 'core.longpaths'])).trim()
    ).toBe('true');
    await executeManagedGit(repo, ['add', '-A', '--', path]);
    await executeManagedGit(repo, [
      '-c',
      'user.name=DNAForge Fixture',
      '-c',
      'user.email=fixture@dnaforge.test',
      'commit',
      '--quiet',
      '-m',
      'Retain original notebook',
    ]);
    const head = (await executeManagedGit(repo, ['rev-parse', 'HEAD'])).trim();
    expect(await hashManagedGitBlob(repo, head, path)).toEqual({
      sha256: createHash('sha256').update(contents).digest('hex'),
      sizeBytes: Buffer.byteLength(contents),
    });
  });

  it('pins the embedded executable and excludes hostile ambient state', () => {
    const runtime = createSterileGitReadRuntime({
      LOCAL_GIT_DIRECTORY: '/attacker/git',
      GIT_EXEC_PATH: '/attacker/helpers',
      NODE_OPTIONS: '--require=/attacker/preload.cjs',
      NODE_PATH: '/attacker/node-modules',
      LD_PRELOAD: '/attacker/inject.so',
      DYLD_INSERT_LIBRARIES: '/attacker/inject.dylib',
      GIT_CONFIG_GLOBAL: '/attacker/gitconfig',
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_SYSTEM: '/attacker/system-gitconfig',
      DNAFORGE_SECRET_PROBE: 'secret-reached-child',
      SystemRoot: 'C:\\Windows',
    });

    expect(runtime.executable).toBe(resolveGitBinary(resolveEmbeddedGitDir()));
    expect(runtime.environment.LOCAL_GIT_DIRECTORY).toBe(resolveEmbeddedGitDir());
    for (const forbidden of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'DNAFORGE_SECRET_PROBE',
    ]) {
      expect(runtime.environment).not.toHaveProperty(forbidden);
    }
    expect(runtime.environment.GIT_CONFIG_GLOBAL).toBe(
      process.platform === 'win32' ? 'NUL' : '/dev/null'
    );
    expect(runtime.environment.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(runtime.environment.GIT_LITERAL_PATHSPECS).toBe('1');
    expect(runtime.environment.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(runtime.environment.GIT_CONFIG_SYSTEM).toBe(
      process.platform === 'win32' ? undefined : join(resolveEmbeddedGitDir(), 'etc', 'gitconfig')
    );
  });

  it('copies the sterile environment into an extensible child-process environment', () => {
    const sterileEnvironment = Object.freeze({
      GIT_CONFIG_NOSYSTEM: '1',
    });

    const childEnvironment = createMutableSubprocessEnvironment(sterileEnvironment, {
      ELECTRON_RUN_AS_NODE: '1',
    });

    expect(Object.isExtensible(childEnvironment)).toBe(true);
    childEnvironment.CRASHDUMP_SIGNAL_FD = '7';
    expect(childEnvironment).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      ELECTRON_RUN_AS_NODE: '1',
      CRASHDUMP_SIGNAL_FD: '7',
    });
    expect(sterileEnvironment).toEqual({ GIT_CONFIG_NOSYSTEM: '1' });
  });

  it('prevents a repository core.fsmonitor command from executing', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'dnaforge-git-read-policy-'));
    temporaryRepositories.push(repo);
    const trackedPath = join(repo, 'sequence.gb');
    const markerPath = join(repo, 'fsmonitor-ran');
    const helperPath = join(repo, 'fsmonitor-helper.cjs');
    await writeFile(trackedPath, 'LOCUS fixture\n');
    await writeFile(
      helperPath,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n` +
        `process.stdout.write('2\\n');\n`
    );
    await execGit(['init', '--quiet'], repo);
    await execGit(['add', '--', trackedPath], repo);
    const fsmonitorCommand =
      `"${shellCommandPath(process.execPath)}" ` + `"${shellCommandPath(helperPath)}"`;
    await execGit(['config', 'core.fsmonitor', fsmonitorCommand], repo);

    await execGit(['ls-files', '--full-name', '--', trackedPath], repo);
    expect(await exists(markerPath)).toBe(true);
    await rm(markerPath);

    let childCount = 0;
    const sterileResult = await executeOwnedGitRead({
      args: ['-C', repo, 'ls-files', '--full-name', '--', trackedPath],
      cwd: tmpdir(),
      maxBuffer: 1024 * 1024,
      control: {
        signal: new AbortController().signal,
        bindProcess: () => {
          childCount += 1;
        },
      },
    });
    expect(sterileResult.exitCode).toBe(0);
    expect(childCount).toBe(1);
    expect(await exists(markerPath)).toBe(false);
  });
});
