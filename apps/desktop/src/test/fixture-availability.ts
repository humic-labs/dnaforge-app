import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const GIT_LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const MAX_POINTER_BYTES = 256;

export function isMaterializedFixtureFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) return false;
    if (stat.size > MAX_POINTER_BYTES) return true;
    return !readFileSync(path, 'utf8').startsWith(GIT_LFS_POINTER_PREFIX);
  } catch {
    return false;
  }
}

export function isMissingOrGitLfsPointerFixture(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_POINTER_BYTES) return false;

    try {
      return readFileSync(path, 'utf8').startsWith(GIT_LFS_POINTER_PREFIX);
    } catch {
      return false;
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function areMaterializedFixtureFiles(paths: ReadonlyArray<string | null>): boolean {
  return paths.every((path): path is string => path !== null && isMaterializedFixtureFile(path));
}

export function isCommandAvailable(command: string): boolean {
  try {
    const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
    return probe.error == null && probe.status === 0;
  } catch {
    return false;
  }
}
