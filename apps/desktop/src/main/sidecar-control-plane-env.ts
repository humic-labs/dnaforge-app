import { createHash } from 'crypto';
import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';

interface SidecarControlPlaneEnvInput {
  isPackaged: boolean;
  userDataPath: string;
  apiDir?: string;
  env: NodeJS.ProcessEnv;
}

export function sidecarControlPlaneEnv(input: SidecarControlPlaneEnvInput): Record<string, string> {
  const configuredEnvironment =
    input.env.DNAFORGE_GRANT_ENVIRONMENT_ID ?? input.env.DNAFORGE_SIDECAR_ENVIRONMENT_ID;
  const apiDir = input.apiDir;
  if (!input.isPackaged && !apiDir) {
    throw new Error('Dev sidecar control-plane env requires apiDir');
  }

  const identityRoot = input.isPackaged ? input.userDataPath : dirname(dirname(apiDir as string));
  const identityHash = createHash('sha256').update(identityRoot).digest('hex').slice(0, 12);
  const environmentId =
    configuredEnvironment && configuredEnvironment.trim().length > 0
      ? configuredEnvironment.trim()
      : `${input.isPackaged ? 'packaged-profile' : 'dev'}-${identityHash}`;
  const safeEnvironmentId = environmentId.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const result: Record<string, string> = {
    DNAFORGE_GRANT_ENVIRONMENT_ID: environmentId,
    DNAFORGE_SIDECAR_ENVIRONMENT_ID: environmentId,
    DNAFORGE_GRANT_CREATED_BY:
      input.env.DNAFORGE_GRANT_CREATED_BY ??
      (input.isPackaged ? 'electron-packaged' : 'electron-dev'),
  };

  if (!input.isPackaged && !input.env.DNAFORGE_SIDECAR_DB_PATH) {
    result.DNAFORGE_SIDECAR_DB_PATH = join(
      input.userDataPath,
      'dev-control-planes',
      safeEnvironmentId,
      'sidecar-control-plane.sqlite3'
    );
  }

  return result;
}

export function runtimeOwnerLockPath(databasePath: string, runtimeScope: string): string {
  const resolved = resolveExistingAncestor(databasePath);
  const scopeHash = createHash('sha256').update(runtimeScope).digest('hex').slice(0, 20);
  return join(dirname(resolved), `.${basename(resolved)}.operation-owner-${scopeHash}.lock`);
}

export function sidecarProfileLockPath(input: SidecarControlPlaneEnvInput): string {
  const configured = input.env.DNAFORGE_SIDECAR_DB_PATH?.trim();
  const controlPlane = sidecarControlPlaneEnv(input);
  const databasePath =
    configured ||
    controlPlane.DNAFORGE_SIDECAR_DB_PATH ||
    join(homedir(), '.dnaforge', 'sidecar-control-plane.sqlite3');
  return runtimeOwnerLockPath(databasePath, controlPlane.DNAFORGE_SIDECAR_ENVIRONMENT_ID);
}

function resolveExistingAncestor(databasePath: string): string {
  const expanded = expandHome(databasePath);
  let current = resolve(expanded);
  const pending: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    pending.push(basename(current));
    current = parent;
  }
  const rooted = existsSync(current) ? realpathSync(current) : current;
  return join(rooted, ...pending.reverse());
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
  return path;
}
