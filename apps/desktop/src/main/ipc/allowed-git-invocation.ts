import { isAbsolute, relative, resolve, sep } from 'node:path';

const SHORT_LOG_COUNT = /^-\d{1,3}$/;
const HEX_SHA40 = /^[0-9a-f]{40}$/i;
const IDENTITY_CONFIG_KEYS = new Set(['user.name', 'user.email']);
const REV_PARSE_OPERANDS = new Set(['--git-dir', '--show-toplevel', 'HEAD']);
const ADD_WHOLE_TREE = new Set(['.', '-A', '--all']);

type GitRestGuard = (rest: readonly string[], cwd: string) => boolean;

export function assertScopedGitPath(path: string, cwd: string): void {
  if (!path || path.startsWith(':') || path.includes('\0')) {
    throw new Error('shell:execute: disallowed git path operand');
  }
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const child = relative(resolve(cwd), absolutePath);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('shell:execute: git path operand escapes cwd');
  }
}

function isShortLogCount(token: string | undefined): boolean {
  return token !== undefined && SHORT_LOG_COUNT.test(token);
}

function assertTrailingScopedPath(
  rest: readonly string[],
  dashIndex: number,
  cwd: string
): boolean {
  const path = rest[dashIndex + 1];
  if (rest[dashIndex] !== '--' || rest.length !== dashIndex + 2 || path === undefined) {
    return false;
  }
  assertScopedGitPath(path, cwd);
  return true;
}

function matchesGitLog(rest: readonly string[], cwd: string): boolean {
  if (
    rest.length === 2 &&
    (rest[0] === '--oneline' || Boolean(rest[0]?.startsWith('--format='))) &&
    isShortLogCount(rest[1])
  ) {
    return true;
  }
  if (
    rest.length === 7 &&
    rest[0] === '--format=%H%x00%s%x00%aI%x00%ar' &&
    rest[1] === '--follow' &&
    rest[2] === '--name-only' &&
    rest[3] === '-z' &&
    isShortLogCount(rest[4])
  ) {
    return assertTrailingScopedPath(rest, 5, cwd);
  }
  if (
    rest.length === 5 &&
    Boolean(rest[0]?.startsWith('--format=')) &&
    rest[1] === '--follow' &&
    isShortLogCount(rest[2])
  ) {
    return assertTrailingScopedPath(rest, 3, cwd);
  }
  if (
    rest.length === 5 &&
    Boolean(rest[0]?.startsWith('--format=')) &&
    rest[1] === '--name-only' &&
    isShortLogCount(rest[2])
  ) {
    return assertTrailingScopedPath(rest, 3, cwd);
  }
  if (
    rest.length === 7 &&
    rest[0] === '--all' &&
    rest[1] === '--follow' &&
    rest[2] === '--diff-filter=R' &&
    rest[3] === '--format=%H' &&
    rest[4] === '-1'
  ) {
    return assertTrailingScopedPath(rest, 5, cwd);
  }
  return false;
}

function matchesGitAdd(rest: readonly string[], cwd: string): boolean {
  if (rest.length === 1 && rest[0] !== undefined && ADD_WHOLE_TREE.has(rest[0])) return true;
  if (rest[0] === '--' && rest.length > 1) {
    rest.slice(1).forEach((path) => assertScopedGitPath(path, cwd));
    return true;
  }
  return false;
}

function matchesGitCommit(rest: readonly string[], cwd: string): boolean {
  if (rest.length < 2 || rest[0] !== '-m') return false;
  if (rest.length === 2) return true;
  if (rest[2] === '--') {
    rest.slice(3).forEach((path) => assertScopedGitPath(path, cwd));
    return true;
  }
  return false;
}

type GitAccess = 'read' | 'write';
interface GitCommandGuard {
  readonly access: GitAccess;
  readonly accepts: GitRestGuard;
}

const GIT_COMMAND_GUARDS: Record<string, GitCommandGuard> = {
  init: { access: 'write', accepts: (rest) => rest.length === 0 },
  config: {
    access: 'write',
    accepts: (rest) =>
      rest.length === 2 && rest[0] !== undefined && IDENTITY_CONFIG_KEYS.has(rest[0]),
  },
  'rev-parse': {
    access: 'read',
    accepts: (rest) =>
      rest.length === 1 && rest[0] !== undefined && REV_PARSE_OPERANDS.has(rest[0]),
  },
  status: {
    access: 'read',
    accepts: (rest) =>
      rest.length === 0 ||
      (rest.length === 1 && rest[0] === '--porcelain') ||
      (rest.length === 2 && rest[0] === '--porcelain' && rest[1] === '--untracked-files=all'),
  },
  diff: { access: 'read', accepts: (rest) => rest.length === 1 && rest[0] === '--stat' },
  log: { access: 'read', accepts: matchesGitLog },
  'diff-tree': {
    access: 'read',
    accepts: (rest) =>
      rest.length === 5 &&
      rest[0] === '--no-commit-id' &&
      rest[1] === '-r' &&
      rest[2] === '--diff-filter=R' &&
      rest[3] === '-M' &&
      Boolean(rest[4] && HEX_SHA40.test(rest[4])),
  },
  show: {
    access: 'read',
    accepts: (rest) => rest.length === 1 && Boolean(rest[0] && !rest[0].startsWith('-')),
  },
  'ls-files': {
    access: 'read',
    accepts: (rest, cwd) =>
      rest.length === 3 && rest[0] === '--full-name' && assertTrailingScopedPath(rest, 1, cwd),
  },
  checkout: {
    access: 'write',
    accepts: (rest, cwd) => rest.length === 2 && assertTrailingScopedPath(rest, 0, cwd),
  },
  add: { access: 'write', accepts: matchesGitAdd },
  commit: { access: 'write', accepts: matchesGitCommit },
};

export function assertAllowedGitInvocation(args: readonly string[], cwd: string): GitAccess {
  if (args.length === 1 && args[0] === '--version') return 'read';
  const command = args[0];
  const rest = args.slice(1);
  const guard = command === undefined ? undefined : GIT_COMMAND_GUARDS[command];
  if (guard?.accepts(rest, cwd)) return guard.access;
  throw new Error('shell:execute: git invocation is outside the workspace command contract');
}
