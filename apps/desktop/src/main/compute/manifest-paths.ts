import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const COMPUTE_USER_MANIFESTS_DIRECTORY = 'compute-endpoints';

const REMOVAL_TOMBSTONE_PATTERN = /^\.([a-z][a-z0-9_-]{1,63})\.[0-9a-f-]{36}\.removed$/;

export interface ComputeManifestRemovalRecovery {
  finalized: string[];
  failures: Array<{ providerId: string; message: string }>;
}

export function computeUserManifestsDir(userDataPath: string): string {
  return join(userDataPath, COMPUTE_USER_MANIFESTS_DIRECTORY);
}

export async function finalizeInterruptedComputeManifestRemovals(
  userDataPath: string,
  deleteCredential: (providerId: string) => Promise<unknown>
): Promise<ComputeManifestRemovalRecovery> {
  const directory = computeUserManifestsDir(userDataPath);
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const result: ComputeManifestRemovalRecovery = { finalized: [], failures: [] };

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = REMOVAL_TOMBSTONE_PATTERN.exec(entry.name);
    if (!match) continue;
    const providerId = match[1];
    try {
      await deleteCredential(providerId);
      await unlink(join(directory, entry.name));
      result.finalized.push(providerId);
    } catch (error) {
      result.failures.push({
        providerId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export function computeManifestEnvironment(options: {
  isPackaged: boolean;
  userDataPath: string;
  resourcesPath?: string;
}): Record<string, string> {
  const environment: Record<string, string> = {
    DNAFORGE_COMPUTE_USER_MANIFESTS_DIR: computeUserManifestsDir(options.userDataPath),
  };
  if (options.isPackaged) {
    if (!options.resourcesPath) {
      throw new Error('resourcesPath is required for packaged compute manifests');
    }
    environment.DNAFORGE_COMPUTE_MANIFESTS_DIR = join(
      options.resourcesPath,
      'compute-endpoints',
      'manifests'
    );
  }
  return environment;
}
