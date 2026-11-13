import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { STERILE_GIT_READ_RUNTIME } from '../ipc/git-read-executor';
import { GIT_READ_CONFIG_ARGS } from '../ipc/git-read-policy';
import { withActiveFilesystemWork } from '../active-filesystem-work';

const execute = promisify(execFile);
const RAW_BYTES_ATTRIBUTES = '* -text -ident -working-tree-encoding -filter -eol';
const MANAGED_GIT_CONFIG_ARGS = Object.freeze([
  ...GIT_READ_CONFIG_ARGS,
  '-c',
  'core.bigFileThreshold=1m',
  '-c',
  'commit.gpgsign=false',

  '-c',
  'pack.compression=0',
  '-c',
  'core.packedGitWindowSize=8m',
  '-c',
  'core.packedGitLimit=32m',
]);

async function ensureRawBytesAttributes(dir: string): Promise<void> {
  const { stdout } = await execute(
    STERILE_GIT_READ_RUNTIME.executable,
    [...GIT_READ_CONFIG_ARGS, 'rev-parse', '--git-path', 'info/attributes'],
    {
      cwd: dir,
      env: { ...STERILE_GIT_READ_RUNTIME.environment },
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }
  );
  const path = resolve(dir, stdout.trim());
  let before = '';
  try {
    const stat = await fs.promises.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error('MANAGED_GIT_ATTRIBUTES_NOT_BOUNDED_REGULAR_FILE');
    before = await fs.promises.readFile(path, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const lastRule = before
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .at(-1);
  if (lastRule === RAW_BYTES_ATTRIBUTES) return;
  await fs.promises.mkdir(dirname(path), { recursive: true });
  const handle = await fs.promises.open(
    path,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(
      `${before && !before.endsWith('\n') ? '\n' : ''}${RAW_BYTES_ATTRIBUTES}\n`
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export interface ManagedGitStatus {
  path: string;
  staged: boolean;
  ignored: boolean;
}

export async function executeManagedGitProcess(
  dir: string,
  args: readonly string[],
  options: { readonly indexFile?: string; readonly maxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return withActiveFilesystemWork(async () => {
    let commandIndex = 0;
    while (args[commandIndex]?.startsWith('-')) {
      commandIndex += args[commandIndex] === '-c' ? 2 : 1;
    }
    const command = args[commandIndex];
    if (['add', 'status', 'checkout', 'commit'].includes(command ?? '')) {
      await ensureRawBytesAttributes(dir);
    }
    const commandArgs = ['diff', 'log', 'show'].includes(command ?? '')
      ? [
          ...args.slice(0, commandIndex + 1),
          '--no-ext-diff',
          '--no-textconv',
          ...args.slice(commandIndex + 1),
        ]
      : args;
    return execute(
      STERILE_GIT_READ_RUNTIME.executable,
      [...MANAGED_GIT_CONFIG_ARGS, '--literal-pathspecs', ...commandArgs],
      {
        cwd: dir,
        env: {
          ...STERILE_GIT_READ_RUNTIME.environment,
          ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
        },
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      }
    );
  });
}

export async function executeManagedGit(
  dir: string,
  args: readonly string[],
  options: { readonly indexFile?: string } = {}
): Promise<string> {
  return (await executeManagedGitProcess(dir, args, options)).stdout;
}

export async function managedGitStatus(
  dir: string,
  paths: readonly string[] = [],
  ignored = false
): Promise<ManagedGitStatus[]> {
  const output = await executeManagedGit(dir, [
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all',
    ...(ignored ? ['--ignored=matching'] : []),
    ...(paths.length ? ['--', ...paths] : []),
  ]);
  return output
    .split('\0')
    .filter(Boolean)
    .map((row) => ({
      path: row.slice(3),
      ignored: row.startsWith('!!'),
      staged: row[0] !== ' ' && row[0] !== '?' && row[0] !== '!',
    }));
}

export async function managedGitBlobOid(
  dir: string,
  commitOid: string,
  path: string
): Promise<string> {
  if (!/^[0-9a-f]{40}$/iu.test(commitOid)) throw new Error('MANAGED_GIT_INVALID_COMMIT_OID');
  const entry = await executeManagedGit(dir, [
    'ls-tree',
    '--full-tree',
    '-z',
    commitOid,
    '--',
    path,
  ]);
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/u.exec(entry);
  if (!match || match[3] !== path) {
    throw new Error(`MANAGED_GIT_COMMIT_FILE_NOT_FOUND: ${path}`);
  }
  return match[2]!;
}

export async function hashManagedGitBlob(
  dir: string,
  commitOid: string,
  path: string,
  maxBytes = Number.MAX_SAFE_INTEGER
): Promise<{ sha256: string; sizeBytes: number }> {
  return withActiveFilesystemWork(async () => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error('MANAGED_GIT_INVALID_BLOB_LIMIT');
    }
    const oid = await managedGitBlobOid(dir, commitOid, path);
    const declaredSize = Number((await executeManagedGit(dir, ['cat-file', '-s', oid])).trim());
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new Error('MANAGED_GIT_INVALID_BLOB_HEADER');
    }
    if (declaredSize > maxBytes) throw new Error('MANAGED_GIT_BLOB_EXCEEDS_CAPTURE');
    const child = spawn(
      STERILE_GIT_READ_RUNTIME.executable,
      [...MANAGED_GIT_CONFIG_ARGS, 'cat-file', 'blob', oid],
      {
        cwd: dir,
        env: { ...STERILE_GIT_READ_RUNTIME.environment },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const completed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error('MANAGED_GIT_BLOB_READ_FAILED'))
      );
    });

    void completed.catch(() => undefined);
    try {
      const hash = createHash('sha256');
      const gitHash = createHash('sha1').update(`blob ${declaredSize}\0`);
      let sizeBytes = 0;
      for await (const chunk of child.stdout) {
        sizeBytes += chunk.length;
        if (sizeBytes > declaredSize || sizeBytes > maxBytes) {
          throw new Error('MANAGED_GIT_BLOB_EXCEEDS_CAPTURE');
        }
        hash.update(chunk);
        gitHash.update(chunk);
      }
      await completed;
      if (sizeBytes !== declaredSize || gitHash.digest('hex') !== oid) {
        throw new Error('MANAGED_GIT_BLOB_INTEGRITY_MISMATCH');
      }
      return { sha256: hash.digest('hex'), sizeBytes };
    } catch (error) {
      child.kill();
      await completed.catch(() => undefined);
      throw error;
    }
  });
}
