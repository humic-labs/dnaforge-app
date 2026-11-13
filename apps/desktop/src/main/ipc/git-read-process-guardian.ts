import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { resolveProcessGuardianPath } from '../process-guardian';

export function resolveGitReadWorkerPath(appPath: string): string {
  const direct = join(appPath, 'resources', 'git-read-worker.cjs');
  if (existsSync(direct)) return direct;
  return resolve(appPath, '..', '..', 'resources', 'git-read-worker.cjs');
}

export function resolveGitReadProcessGuardian(input: {
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly explicitPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): string | undefined {
  return resolveProcessGuardianPath(input);
}
