import type { GitFileStatus } from '../../shared/artifact-operation-ports';
export type { GitFileStatus } from '../../shared/artifact-operation-ports';

export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly stderr: string
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

function unquotePath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return p;
}

export function parseGitStatus(porcelain: string): Map<string, GitFileStatus> {
  const result = new Map<string, GitFileStatus>();
  if (!porcelain.trim()) return result;

  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let rawPath = line.slice(3).trim();

    if (code.includes('R') && rawPath.includes(' -> ')) {
      const arrowIdx = rawPath.indexOf(' -> ');
      rawPath = rawPath.slice(arrowIdx + 4);
    }

    const path = unquotePath(rawPath);

    if (code === '??') result.set(path, 'untracked');
    else if (code.includes('M')) result.set(path, 'modified');
    else if (code.includes('A')) result.set(path, 'added');
    else if (code.includes('D')) result.set(path, 'deleted');
    else if (code.includes('R')) result.set(path, 'renamed');
  }

  return result;
}

import { platform } from '../../platform';
import { isGitReadTabCloseAbortReason } from '../../shared/git-read-ipc';

async function runGit(
  args: string[],
  cwd: string,
  mutationToken?: string
): Promise<{ stdout: string; stderr: string }> {
  const output = mutationToken
    ? await platform().shell.execute('git', args, cwd, mutationToken)
    : await platform().shell.execute('git', args, cwd);
  const code = output.code ?? 0;
  if (code !== 0) {
    throw new GitCommandError(`git ${args[0]} failed with exit code ${code}`, code, output.stderr);
  }
  return { stdout: output.stdout, stderr: output.stderr };
}

export async function gitReadHeadForDiff(
  filePath: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) return null;
  const requestId = crypto.randomUUID();
  const cancel = (): void => {
    const closeGestureToken = isGitReadTabCloseAbortReason(signal?.reason)
      ? signal.reason.closeGestureToken
      : undefined;
    const cancellation = closeGestureToken
      ? platform().shell.cancelGitRead(requestId, closeGestureToken)
      : platform().shell.cancelGitRead(requestId);
    void cancellation.catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const content = await platform().shell.readGitHead(filePath, requestId);
    return signal?.aborted ? null : content;
  } catch (error) {
    if (signal?.aborted) return null;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

function isIndexLockContention(err: unknown): boolean {
  return (
    err instanceof GitCommandError &&
    err.code === 128 &&
    /index\.lock|another git process|unable to create/i.test(err.stderr)
  );
}

async function withIndexLockRetry<T>(op: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt >= attempts - 1 || !isIndexLockContention(err)) throw err;

      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

export async function isGitRepo(dirPath: string, mutationToken?: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--git-dir'], dirPath, mutationToken);
    return true;
  } catch {
    return false;
  }
}

export async function gitInit(dirPath: string): Promise<void> {
  await runGit(['init'], dirPath);

  const gitignore = [
    '# Large binary files',
    '*.bam',
    '*.sam',
    '*.bed',
    '*.vcf.gz',
    '',
    '# OS files',
    '.DS_Store',
    'Thumbs.db',
    '',
    '# DNAForge internal',
    '.waypoint-workspace',
    '',
  ].join('\n');
  await platform().fs.writeTextFile(`${dirPath}/.gitignore`, gitignore);

  await runGit(['add', '.'], dirPath);
  await runGit(['commit', '-m', 'Initial DNAForge tracking'], dirPath);
}

export async function gitStatus(
  dirPath: string,
  mutationToken?: string
): Promise<Map<string, GitFileStatus>> {
  const result = await runGit(
    ['status', '--porcelain', '--untracked-files=all'],
    dirPath,
    mutationToken
  );
  return parseGitStatus(result.stdout);
}

export async function gitAdd(dirPath: string, files: string[]): Promise<void> {
  await runGit(['add', '--', ...files], dirPath);
}

export async function gitAddAll(dirPath: string): Promise<void> {
  await runGit(['add', '-A'], dirPath);
}

export async function gitCommit(dirPath: string, message: string): Promise<void> {
  await runGit(['commit', '-m', message, '--'], dirPath);
}

export async function gitCommitPaths(
  dirPath: string,
  message: string,
  files: string[],
  mutationToken?: string
): Promise<void> {
  if (files.length === 0) throw new Error('gitCommitPaths requires at least one path.');
  await withIndexLockRetry(() => runGit(['add', '--', ...files], dirPath, mutationToken));
  await withIndexLockRetry(() =>
    runGit(['commit', '-m', message, '--', ...files], dirPath, mutationToken)
  );
}

export async function gitLog(dirPath: string, count: number = 10): Promise<string> {
  const safeCount = Math.max(1, Math.min(100, Math.floor(count)));
  const result = await runGit(['log', '--oneline', `-${safeCount}`], dirPath);
  return result.stdout;
}

export async function gitHead(dirPath: string, mutationToken?: string): Promise<string | null> {
  try {
    const result = await runGit(['rev-parse', 'HEAD'], dirPath, mutationToken);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function gitDiffStat(dirPath: string): Promise<string> {
  const result = await runGit(['diff', '--stat'], dirPath);
  return result.stdout;
}

export async function gitShowHead(filePath: string, cwd: string): Promise<string | null> {
  try {
    const relResult = await runGit(['ls-files', '--full-name', '--', filePath], cwd);
    const relativePath = relResult.stdout.trim();
    if (!relativePath) return null;

    try {
      const result = await runGit(['show', `HEAD:${relativePath}`], cwd);
      return result.stdout;
    } catch {
      const indexResult = await runGit(['show', `:0:${relativePath}`], cwd);
      return indexResult.stdout;
    }
  } catch {
    return null;
  }
}

export async function isGitInstalled(): Promise<boolean> {
  try {
    const cwd = await platform().path.appDataDir();
    await platform().shell.execute('git', ['--version'], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function hasCommits(dirPath: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', 'HEAD'], dirPath);
    return true;
  } catch {
    return false;
  }
}

export async function gitRepoRoot(
  filePath: string,
  mutationToken?: string
): Promise<string | null> {
  try {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const parentPath = normalizedPath.replace(/\/[^/]+$/, '') || '/';
    const parentDir = /^[A-Za-z]:$/.test(parentPath) ? `${parentPath}/` : parentPath;
    const result = await runGit(['rev-parse', '--show-toplevel'], parentDir, mutationToken);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function gitRepoRootForDir(dirPath: string): Promise<string | null> {
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], dirPath);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface GitLogEntry {
  hash: string;
  message: string;
  date: string;
  relativeDate: string;
  pathAtCommit?: string;
}

export async function gitFileLog(
  filePath: string,
  cwd: string,
  count: number = 20
): Promise<GitLogEntry[]> {
  try {
    const safeCount = Math.max(1, Math.min(100, Math.floor(count)));
    const format = '%H%x00%s%x00%aI%x00%ar';
    const result = await runGit(
      [
        'log',
        `--format=${format}`,
        '--follow',
        '--name-only',
        '-z',
        `-${safeCount}`,
        '--',
        filePath,
      ],
      cwd
    );
    const fields = result.stdout.split('\0');
    const entries: GitLogEntry[] = [];
    for (let i = 0; i + 4 < fields.length; i += 5) {
      const [hash, message, date, relativeDate, path] = fields.slice(i, i + 5);
      if (!hash || !path.startsWith('\n')) continue;
      entries.push({ hash, message, date, relativeDate, pathAtCommit: path.slice(1) });
    }
    return entries;
  } catch {
    return [];
  }
}

export function parseStructuredGitLog(stdout: string): GitLogEntry[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, message, date, relativeDate] = line.split('\0');
      return { hash, message, date, relativeDate };
    })
    .filter((entry) => entry.hash && entry.message && entry.date && entry.relativeDate);
}

export async function gitWorkspaceLog(cwd: string, count: number = 50): Promise<GitLogEntry[]> {
  try {
    const safeCount = Math.max(1, Math.min(100, Math.floor(count)));
    const format = '%H%x00%s%x00%aI%x00%ar';
    const result = await runGit(['log', `--format=${format}`, `-${safeCount}`], cwd);
    return parseStructuredGitLog(result.stdout);
  } catch {
    return [];
  }
}

export interface GitChangedFileEntry {
  path: string;
  hash: string;
  date: string;
  relativeDate: string;
}

export async function gitRecentlyChangedFiles(
  cwd: string,
  count: number = 20
): Promise<GitChangedFileEntry[]> {
  try {
    const safeCount = Number.isFinite(count) ? Math.max(1, Math.min(100, Math.floor(count))) : 20;
    const format = '%x01%H%x00%aI%x00%ar';
    const result = await runGit(
      ['log', `--format=${format}`, '--name-only', `-${safeCount}`, '--', '.'],
      cwd
    );
    return parseGitRecentlyChangedFiles(result.stdout);
  } catch {
    return [];
  }
}

export function parseGitRecentlyChangedFiles(stdout: string): GitChangedFileEntry[] {
  const seen = new Map<string, GitChangedFileEntry>();
  for (const block of stdout.split('\x01')) {
    const lines = block.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const [hash, date, relativeDate] = lines[0].split('\0');
    if (!hash || !date || !relativeDate) continue;
    for (const rawPath of lines.slice(1)) {
      const path = unquotePath(rawPath);
      if (!seen.has(path)) {
        seen.set(path, { path, hash, date, relativeDate });
      }
    }
  }
  return [...seen.values()];
}

export async function gitShowCommit(
  filePath: string | { readonly pathAtCommit: string },
  commitHash: string,
  cwd: string,
  mutationToken?: string
): Promise<string | null> {
  try {
    const relativePath =
      typeof filePath === 'string'
        ? (
            await runGit(['ls-files', '--full-name', '--', filePath], cwd, mutationToken)
          ).stdout.trim()
        : filePath.pathAtCommit;
    if (!relativePath) return null;

    const result = await runGit(['show', `${commitHash}:${relativePath}`], cwd, mutationToken);
    return result.stdout;
  } catch {
    return null;
  }
}

export async function gitRevertFile(filePath: string, cwd: string): Promise<void> {
  await runGit(['checkout', '--', filePath], cwd);
}

export async function gitCommitFile(filePath: string, message: string, cwd: string): Promise<void> {
  await withIndexLockRetry(() => runGit(['add', '--', filePath], cwd));
  await withIndexLockRetry(() => runGit(['commit', '-m', message, '--', filePath], cwd));
}
