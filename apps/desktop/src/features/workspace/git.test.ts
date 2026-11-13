import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseGitStatus,
  GitCommandError,
  gitRepoRoot,
  gitFileLog,
  gitWorkspaceLog,
  gitRecentlyChangedFiles,
  gitRepoRootForDir,
  parseGitRecentlyChangedFiles,
  parseStructuredGitLog,
  gitShowCommit,
  gitRevertFile,
  gitCommitFile,
  gitCommitPaths,
  gitStatus,
  gitReadHeadForDiff,
} from './git';
import * as workspaceGit from './git';
import * as publicWorkspaceGit from './public/git';

const mockExecute = vi.fn();
const mockReadGitHead = vi.fn();
const mockCancelGitRead = vi.fn();
vi.mock('../../platform', () => ({
  platform: () => ({
    shell: {
      execute: mockExecute,
      readGitHead: mockReadGitHead,
      cancelGitRead: mockCancelGitRead,
    },
  }),
}));

describe('workspace Git public surface', () => {
  it('does not expose the retired rename-history helpers', () => {
    expect(workspaceGit).not.toHaveProperty('gitFindRename');
    expect(workspaceGit).not.toHaveProperty('parseDiffTreeRename');
    expect(publicWorkspaceGit).not.toHaveProperty('gitFindRename');
    expect(publicWorkspaceGit).not.toHaveProperty('parseDiffTreeRename');
    expect(publicWorkspaceGit.parseGitStatus).toBe(workspaceGit.parseGitStatus);
  });
});

describe('parseGitStatus', () => {
  it('parses porcelain output into file status map', () => {
    const porcelain = ` M src/main.ts\n?? new-file.ts\n D deleted.ts\nA  added.ts`;
    const result = parseGitStatus(porcelain);

    expect(result.get('src/main.ts')).toBe('modified');
    expect(result.get('new-file.ts')).toBe('untracked');
    expect(result.get('deleted.ts')).toBe('deleted');
    expect(result.get('added.ts')).toBe('added');
  });

  it('returns empty map for clean status', () => {
    const result = parseGitStatus('');
    expect(result.size).toBe(0);
  });

  it('parses renamed files with -> separator', () => {
    const result = parseGitStatus('R  old.ts -> new.ts');
    expect(result.get('new.ts')).toBe('renamed');
    expect(result.has('old.ts')).toBe(false);
  });

  it('parses quoted paths with spaces', () => {
    const result = parseGitStatus(' M "src/my file.ts"');
    expect(result.get('src/my file.ts')).toBe('modified');
  });

  it('parses quoted paths with escaped quotes', () => {
    const result = parseGitStatus(' M "src/my\\"file.ts"');
    expect(result.get('src/my"file.ts')).toBe('modified');
  });

  it('parses quoted paths with escaped backslashes', () => {
    const result = parseGitStatus(' M "src/my\\\\file.ts"');
    expect(result.get('src/my\\file.ts')).toBe('modified');
  });
});

describe('GitCommandError', () => {
  it('has code and stderr properties', () => {
    const err = new GitCommandError('git failed', 128, 'fatal: not a repo');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(128);
    expect(err.stderr).toBe('fatal: not a repo');
    expect(err.message).toBe('git failed');
  });
});

describe('gitReadHeadForDiff', () => {
  beforeEach(() => {
    mockReadGitHead.mockReset();
    mockCancelGitRead.mockReset();
  });

  it('uses one request identity for the bounded main-process read', async () => {
    mockReadGitHead.mockResolvedValue('LOCUS baseline');

    await expect(gitReadHeadForDiff('/workspace/file.gb')).resolves.toBe('LOCUS baseline');
    expect(mockReadGitHead).toHaveBeenCalledWith(
      '/workspace/file.gb',
      expect.stringMatching(/^[0-9a-f-]{36}$/i)
    );
    expect(mockCancelGitRead).not.toHaveBeenCalled();
  });

  it('cancels the matching physical read and suppresses its retired result', async () => {
    let resolveRead: (value: string) => void = () => undefined;
    mockReadGitHead.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      })
    );
    mockCancelGitRead.mockResolvedValue(true);
    const controller = new AbortController();
    const read = gitReadHeadForDiff('/workspace/file.gb', controller.signal);
    const requestId = mockReadGitHead.mock.calls[0]?.[1];

    controller.abort();
    expect(mockCancelGitRead).toHaveBeenCalledWith(requestId);
    resolveRead('LOCUS retired');

    await expect(read).resolves.toBeNull();
  });

  it('forwards a validated close-gesture token only for a tab-close abort', async () => {
    let resolveRead: (value: string) => void = () => undefined;
    mockReadGitHead.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      })
    );
    mockCancelGitRead.mockResolvedValue(true);
    const controller = new AbortController();
    const read = gitReadHeadForDiff('/workspace/file.gb', controller.signal);
    const requestId = mockReadGitHead.mock.calls[0]?.[1];
    const closeGestureToken = '20000000-0000-4000-8000-000000000001';

    controller.abort({ kind: 'tab-close', closeGestureToken });
    expect(mockCancelGitRead).toHaveBeenCalledWith(requestId, closeGestureToken);
    resolveRead('LOCUS retired');

    await expect(read).resolves.toBeNull();
  });

  it('issues one IPC request and lets the bounded main-process FIFO own admission', async () => {
    let resolveRead: (value: string) => void = () => undefined;
    mockReadGitHead.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      })
    );

    const read = gitReadHeadForDiff('/workspace/file.gb');
    await Promise.resolve();
    expect(mockReadGitHead).toHaveBeenCalledTimes(1);

    resolveRead('LOCUS admitted');
    await expect(read).resolves.toBe('LOCUS admitted');
    expect(mockReadGitHead).toHaveBeenCalledTimes(1);
  });

  it('does not retry unrelated errors whose text happens to contain the old busy token', async () => {
    mockReadGitHead.mockRejectedValue(
      new Error('Path /workspace/GIT_READ_BUSY/sequence.gb is not allowed')
    );

    await expect(gitReadHeadForDiff('/workspace/GIT_READ_BUSY/sequence.gb')).rejects.toThrow(
      'not allowed'
    );
    expect(mockReadGitHead).toHaveBeenCalledTimes(1);
  });
});

describe('gitRepoRoot', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('returns repo root from git rev-parse --show-toplevel', async () => {
    mockExecute.mockResolvedValue({
      stdout: '/Users/user/projects/my-repo\n',
      stderr: '',
      code: 0,
    });

    const result = await gitRepoRoot('/Users/user/projects/my-repo/src/file.ts');

    expect(result).toBe('/Users/user/projects/my-repo');
    expect(mockExecute).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      '/Users/user/projects/my-repo/src'
    );
  });

  it('passes the workspace mutation token to Git when the caller already holds its lease', async () => {
    mockExecute.mockResolvedValue({ stdout: '/workspace\n', stderr: '', code: 0 });

    await expect(gitRepoRoot('/workspace/package/product.gb', 'owned-mutation')).resolves.toBe(
      '/workspace'
    );
    expect(mockExecute).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      '/workspace/package',
      'owned-mutation'
    );
  });

  it('returns null when not in a git repo', async () => {
    mockExecute.mockResolvedValue({
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });

    const result = await gitRepoRoot('/tmp/not-a-repo/file.txt');

    expect(result).toBeNull();
  });

  it.each([
    ['C:\\Users\\test\\project\\test.gb', 'C:/Users/test/project'],
    ['C:\\test.gb', 'C:/'],
    ['\\\\server\\share\\project\\test.gb', '//server/share/project'],
  ])('resolves the repository for a Windows file path %s', async (filePath, parentDir) => {
    mockExecute.mockImplementation(async (_program, _args, cwd) =>
      cwd === parentDir
        ? { stdout: `${parentDir}\n`, stderr: '', code: 0 }
        : { stdout: '', stderr: 'fatal: cannot change to file path', code: 128 }
    );

    expect(await gitRepoRoot(filePath)).toBe(parentDir);
    expect(mockExecute).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], parentDir);
  });
});

describe('gitRepoRootForDir', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('resolves the toplevel by running rev-parse directly IN the given directory (no stripping)', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '/Users/user/projects/monorepo\n',
      stderr: '',
      code: 0,
    });

    const result = await gitRepoRootForDir('/Users/user/projects/monorepo/test-fixtures');

    expect(result).toBe('/Users/user/projects/monorepo');
    expect(mockExecute).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      '/Users/user/projects/monorepo/test-fixtures'
    );
  });

  it('returns null when not in a git repo', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });

    await expect(gitRepoRootForDir('/tmp/not-a-repo')).resolves.toBeNull();
  });

  it('returns null on a successful call with blank stdout (not the thrown-error path)', async () => {
    mockExecute.mockResolvedValueOnce({ stdout: '   \n', stderr: '', code: 0 });

    await expect(gitRepoRootForDir('/some/dir')).resolves.toBeNull();
  });

  it('returns null when the shell layer itself throws, not just on a non-zero git exit', async () => {
    mockExecute.mockRejectedValueOnce(new Error('spawn git ENOENT'));

    await expect(gitRepoRootForDir('/some/dir')).resolves.toBeNull();
  });
});

describe('gitFileLog', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('parses log entries with null-byte separator', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout:
        'abc123\x00Fix bug\x002026-03-21T10:00:00Z\x002 hours ago\ndef456\x00Add feature\x002026-03-20T10:00:00Z\x00yesterday\n',
      stderr: '',
      code: 0,
    });

    const entries = await gitFileLog('/test/file.gb', '/test');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      hash: 'abc123',
      message: 'Fix bug',
      date: '2026-03-21T10:00:00Z',
      relativeDate: '2 hours ago',
    });
    expect(entries[1]).toEqual({
      hash: 'def456',
      message: 'Add feature',
      date: '2026-03-20T10:00:00Z',
      relativeDate: 'yesterday',
    });
  });

  it('returns empty array on error', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });

    const entries = await gitFileLog('/test/file.gb', '/test');
    expect(entries).toEqual([]);
  });

  it('clamps count to valid range', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      code: 0,
    });

    await gitFileLog('/test/file.gb', '/test', 200);
    expect(mockExecute).toHaveBeenCalledWith('git', expect.arrayContaining(['-100']), '/test');
  });
});

describe('gitWorkspaceLog', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('parses repo-wide log entries without passing a file path', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: 'abc123\x00Initial import\x002026-06-20T10:00:00Z\x002 days ago\n',
      stderr: '',
      code: 0,
    });

    const entries = await gitWorkspaceLog('/managed/a/repo', 50);

    expect(entries).toEqual([
      {
        hash: 'abc123',
        message: 'Initial import',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2 days ago',
      },
    ]);
    expect(mockExecute).toHaveBeenCalledWith(
      'git',
      ['log', '--format=%H%x00%s%x00%aI%x00%ar', '-50'],
      '/managed/a/repo'
    );
  });

  it('returns empty history when git is unavailable or the repo has no commits', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });

    await expect(gitWorkspaceLog('/managed/a/repo')).resolves.toEqual([]);
  });
});

describe('gitRecentlyChangedFiles', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('parses per-commit file lists into one flat, deduped, most-recent-first list', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout:
        '\x01abc123\x002026-06-20T10:00:00Z\x002 hours ago\nsrc/a.gb\nsrc/b.gb\n' +
        '\x01def456\x002026-06-19T10:00:00Z\x001 day ago\nsrc/b.gb\nsrc/c.gb\n',
      stderr: '',
      code: 0,
    });

    const entries = await gitRecentlyChangedFiles('/managed/a/repo', 20);

    expect(entries).toEqual([
      {
        path: 'src/a.gb',
        hash: 'abc123',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2 hours ago',
      },
      {
        path: 'src/b.gb',
        hash: 'abc123',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2 hours ago',
      },
      { path: 'src/c.gb', hash: 'def456', date: '2026-06-19T10:00:00Z', relativeDate: '1 day ago' },
    ]);
    expect(mockExecute).toHaveBeenCalledWith(
      'git',
      ['log', '--format=%x01%H%x00%aI%x00%ar', '--name-only', '-20', '--', '.'],
      '/managed/a/repo'
    );
  });

  it('returns empty list when git is unavailable or the repo has no commits', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });

    await expect(gitRecentlyChangedFiles('/managed/a/repo')).resolves.toEqual([]);
  });

  it('returns empty list on a successful call with empty stdout (not the error path)', async () => {
    mockExecute.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    await expect(gitRecentlyChangedFiles('/managed/a/repo')).resolves.toEqual([]);
  });

  it('returns empty list when the shell layer itself throws, not just on a non-zero git exit', async () => {
    mockExecute.mockRejectedValueOnce(new Error('spawn git ENOENT'));

    await expect(gitRecentlyChangedFiles('/managed/a/repo')).resolves.toEqual([]);
  });

  it('clamps count to the valid 1-100 range, including 0, negative, fractional, and non-finite values', async () => {
    mockExecute.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await gitRecentlyChangedFiles('/managed/a/repo', 500);
    expect(mockExecute).toHaveBeenNthCalledWith(
      1,
      'git',
      expect.arrayContaining(['-100']),
      '/managed/a/repo'
    );

    await gitRecentlyChangedFiles('/managed/a/repo', 0);
    expect(mockExecute).toHaveBeenNthCalledWith(
      2,
      'git',
      expect.arrayContaining(['-1']),
      '/managed/a/repo'
    );

    await gitRecentlyChangedFiles('/managed/a/repo', -7);
    expect(mockExecute).toHaveBeenNthCalledWith(
      3,
      'git',
      expect.arrayContaining(['-1']),
      '/managed/a/repo'
    );

    await gitRecentlyChangedFiles('/managed/a/repo', 4.9);
    expect(mockExecute).toHaveBeenNthCalledWith(
      4,
      'git',
      expect.arrayContaining(['-4']),
      '/managed/a/repo'
    );

    await gitRecentlyChangedFiles('/managed/a/repo', NaN);
    const nanCallArgs = mockExecute.mock.calls[4];
    expect(nanCallArgs[1].some((arg: string) => arg.includes('NaN'))).toBe(false);
  });
});

describe('parseGitRecentlyChangedFiles', () => {
  it('unquotes git-quoted paths in the --name-only file list', () => {
    const stdout = '\x01abc123\x002026-06-20T10:00:00Z\x002 hours ago\n"src/my\\"file.gb"\n';
    const entries = parseGitRecentlyChangedFiles(stdout);

    expect(entries).toEqual([
      {
        path: 'src/my"file.gb',
        hash: 'abc123',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2 hours ago',
      },
    ]);
  });

  it('drops a commit block with a malformed (short) header line', () => {
    const stdout =
      '\x01abc123\x002026-06-20T10:00:00Z\nsrc/bad.gb\n' +
      '\x01def456\x002026-06-19T10:00:00Z\x001 day ago\nsrc/good.gb\n';

    const entries = parseGitRecentlyChangedFiles(stdout);

    expect(entries).toEqual([
      {
        path: 'src/good.gb',
        hash: 'def456',
        date: '2026-06-19T10:00:00Z',
        relativeDate: '1 day ago',
      },
    ]);
  });
});

describe('parseStructuredGitLog', () => {
  it('drops malformed lines instead of rendering partial history rows', () => {
    expect(
      parseStructuredGitLog('abc123\x00Initial import\x002026-06-20T10:00:00Z\x002d ago\nbad\n')
    ).toEqual([
      {
        hash: 'abc123',
        message: 'Initial import',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2d ago',
      },
    ]);
  });
});

describe('gitShowCommit', () => {
  it('reuses a held mutation lease for both history verification commands', async () => {
    mockExecute.mockImplementation(
      async (_program: string, args: string[], _cwd: string, token?: string) => {
        if (token !== 'held-project-lease')
          throw new Error('Unleased command cannot enter the held project');
        return {
          code: 0,
          stdout: args[0] === 'ls-files' ? 'record.json\n' : 'committed content',
          stderr: '',
        };
      }
    );
    expect(
      await gitShowCommit('record.json', 'exact-commit', '/project', 'held-project-lease')
    ).toBe('committed content');
    expect(mockExecute).toHaveBeenCalledWith(
      'git',
      ['ls-files', '--full-name', '--', 'record.json'],
      '/project',
      'held-project-lease'
    );
    expect(mockExecute).toHaveBeenCalledWith(
      'git',
      ['show', 'exact-commit:record.json'],
      '/project',
      'held-project-lease'
    );
  });
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('returns file content at a specific commit', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: 'src/file.gb\n',
      stderr: '',
      code: 0,
    });
    mockExecute.mockResolvedValueOnce({
      stdout: 'LOCUS old_content',
      stderr: '',
      code: 0,
    });

    const content = await gitShowCommit('/test/src/file.gb', 'abc123', '/test');
    expect(content).toBe('LOCUS old_content');
    expect(mockExecute).toHaveBeenCalledWith('git', ['show', 'abc123:src/file.gb'], '/test');
  });

  it('returns null when file is not tracked', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      code: 0,
    });

    const content = await gitShowCommit('/test/untracked.gb', 'abc123', '/test');
    expect(content).toBeNull();
  });

  it('returns null on error', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });

    const content = await gitShowCommit('/test/file.gb', 'abc123', '/test');
    expect(content).toBeNull();
  });
});

describe('gitRevertFile', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('calls git checkout (index) for the file, without HEAD', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      code: 0,
    });

    await gitRevertFile('/test/file.gb', '/test');
    expect(mockExecute).toHaveBeenCalledWith('git', ['checkout', '--', '/test/file.gb'], '/test');
  });

  it('throws on error', async () => {
    mockExecute.mockResolvedValueOnce({
      stdout: '',
      stderr: 'error: pathspec',
      code: 1,
    });

    await expect(gitRevertFile('/test/file.gb', '/test')).rejects.toThrow(GitCommandError);
  });
});

describe('gitCommitFile', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('stages and commits a single file', async () => {
    mockExecute.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });
    mockExecute.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    await gitCommitFile('/test/file.gb', 'Save sequence edits', '/test');

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute).toHaveBeenNthCalledWith(1, 'git', ['add', '--', '/test/file.gb'], '/test');
    expect(mockExecute).toHaveBeenNthCalledWith(
      2,
      'git',
      ['commit', '-m', 'Save sequence edits', '--', '/test/file.gb'],
      '/test'
    );
  });

  it('throws if add fails', async () => {
    mockExecute.mockResolvedValueOnce({ stdout: '', stderr: 'fatal', code: 128 });

    await expect(gitCommitFile('/test/file.gb', 'msg', '/test')).rejects.toThrow(GitCommandError);
  });

  const LOCK = {
    stdout: '',
    stderr: "fatal: Unable to create '/test/.git/index.lock': File exists.",
    code: 128,
  };
  const OK = { stdout: '', stderr: '', code: 0 };

  it('retries an index-lock-contended `git add`, then succeeds', async () => {
    mockExecute
      .mockResolvedValueOnce(LOCK)
      .mockResolvedValueOnce(LOCK)
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce(OK);

    await expect(gitCommitFile('/test/file.gb', 'msg', '/test')).resolves.toBeUndefined();
    expect(mockExecute).toHaveBeenCalledTimes(4);
  });

  it('retries an index-lock-contended `git commit`, then succeeds', async () => {
    mockExecute.mockResolvedValueOnce(OK).mockResolvedValueOnce(LOCK).mockResolvedValueOnce(OK);

    await expect(gitCommitFile('/test/file.gb', 'msg', '/test')).resolves.toBeUndefined();
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-lock failure — real errors surface immediately', async () => {
    mockExecute.mockResolvedValue({ stdout: '', stderr: 'fatal: not a git repository', code: 128 });

    await expect(gitCommitFile('/test/file.gb', 'msg', '/test')).rejects.toThrow(GitCommandError);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

describe('gitCommitPaths', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('limits both staging and commit to the supplied paths', async () => {
    mockExecute.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await gitCommitPaths('/test', 'Add primer PRIMER_F1', [
      'primers/PRIMER_F1.primer.json',
      '.waypoint/lims',
    ]);

    expect(mockExecute).toHaveBeenNthCalledWith(
      1,
      'git',
      ['add', '--', 'primers/PRIMER_F1.primer.json', '.waypoint/lims'],
      '/test'
    );
    expect(mockExecute).toHaveBeenNthCalledWith(
      2,
      'git',
      [
        'commit',
        '-m',
        'Add primer PRIMER_F1',
        '--',
        'primers/PRIMER_F1.primer.json',
        '.waypoint/lims',
      ],
      '/test'
    );
  });

  it('keeps one renderer mutation token across staging and commit', async () => {
    mockExecute.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await gitCommitPaths(
      '/test',
      'Add primer PRIMER_F1',
      ['primers/PRIMER_F1.primer.json'],
      'primer-mutation-token'
    );

    expect(mockExecute).toHaveBeenNthCalledWith(
      1,
      'git',
      ['add', '--', 'primers/PRIMER_F1.primer.json'],
      '/test',
      'primer-mutation-token'
    );
    expect(mockExecute).toHaveBeenNthCalledWith(
      2,
      'git',
      ['commit', '-m', 'Add primer PRIMER_F1', '--', 'primers/PRIMER_F1.primer.json'],
      '/test',
      'primer-mutation-token'
    );
  });
});

describe('gitStatus', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it('expands untracked directories so selective commits see each new LIMS file', async () => {
    mockExecute.mockResolvedValue({
      stdout: '?? .waypoint/lims/entities/primer-1.json\n?? primers/primer-1.primer.json\n',
      stderr: '',
      code: 0,
    });

    const status = await gitStatus('/test');

    expect(mockExecute).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      '/test'
    );
    expect([...status.keys()]).toEqual([
      '.waypoint/lims/entities/primer-1.json',
      'primers/primer-1.primer.json',
    ]);
  });
});
