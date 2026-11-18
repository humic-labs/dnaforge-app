import { describe, expect, it } from 'vitest';
import { assertAllowedGitInvocation } from './allowed-git-invocation';

const CWD = '/tmp/repo';

function allows(args: readonly string[], cwd = CWD): void {
  expect(() => assertAllowedGitInvocation(args, cwd)).not.toThrow();
}

function rejects(args: readonly string[], cwd = CWD, message?: RegExp): void {
  expect(() => assertAllowedGitInvocation(args, cwd)).toThrow(
    message ?? /outside the workspace command contract|escapes cwd|disallowed git path/
  );
}

describe('assertAllowedGitInvocation', () => {
  it('allows the workspace git command contract', () => {
    allows(['--version']);
    allows(['init']);
    allows(['config', 'user.name', 'DNAForge']);
    allows(['config', 'user.email', 'dev@example.com']);
    allows(['rev-parse', '--git-dir']);
    allows(['rev-parse', '--show-toplevel']);
    allows(['rev-parse', 'HEAD']);
    allows(['status']);
    allows(['status', '--porcelain']);
    allows(['status', '--porcelain', '--untracked-files=all']);
    allows(['diff', '--stat']);
    allows(['log', '--oneline', '-10']);
    allows(['log', '--format=%H', '-3']);
    allows(['log', '--format=%H', '--follow', '-20', '--', 'pUC19.gb']);
    allows(['log', '--format=%x01%H', '--name-only', '-30', '--', '.']);
    allows([
      'log',
      '--format=%H%x00%s%x00%aI%x00%ar',
      '--follow',
      '--name-only',
      '-z',
      '-20',
      '--',
      'pUC19.gb',
    ]);
    allows(['log', '--all', '--follow', '--diff-filter=R', '--format=%H', '-1', '--', 'pUC19.gb']);
    allows(['diff-tree', '--no-commit-id', '-r', '--diff-filter=R', '-M', 'a'.repeat(40)]);
    allows(['show', 'abc123']);
    allows(['ls-files', '--full-name', '--', 'pUC19.gb']);
    allows(['checkout', '--', 'pUC19.gb']);
    allows(['add', '.']);
    allows(['add', '-A']);
    allows(['add', '--all']);
    allows(['add', '--', 'pUC19.gb', 'notes.md']);
    allows(['commit', '-m', 'x']);
    allows(['commit', '-m', 'x', '--', 'pUC19.gb']);
  });

  it('rejects commands and operands outside the contract', () => {
    rejects([]);
    rejects(['clone', 'https://example.invalid/repo.git']);
    rejects(['init', '/tmp/other']);
    rejects(['config', 'core.worktree', '/tmp/other']);
    rejects(['status', '--short']);
    rejects(['log', '--oneline']);
    rejects(['log', '--oneline', '-1000']);
    rejects(['show', '--stat']);
    rejects(['add']);
    rejects(['add', 'pUC19.gb']);
    rejects(['commit', '-m']);
    rejects(['commit', '-m', 'x', 'pUC19.gb']);
    rejects(['add', '--', '../outside.txt'], CWD, /escapes cwd/);
    rejects(['log', '--format=%H', '--follow', '-20', '--', '../outside.gb'], CWD, /escapes cwd/);
  });
});
