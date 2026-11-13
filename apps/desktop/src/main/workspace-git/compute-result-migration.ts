import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const LEGACY_COMPUTE_MIGRATION_DEFERRED =
  'Legacy compute results remain in their original folder until recoverable migration is available.';

export async function migrateComputeResultFolders(
  repoPath: string,
  _options: {
    removeSource: (path: string) => Promise<unknown>;
    relocate: (relocation: unknown) => unknown;
    now?: () => number;
  }
): Promise<{ migrated: number; skipped: Array<{ path: string; reason: string }> }> {
  const computeRoot = join(repoPath, 'compute');
  const entry = await lstat(computeRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry?.isDirectory()) return { migrated: 0, skipped: [] };
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const provider of await readdir(computeRoot, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    const providerPath = join(computeRoot, provider.name);
    for (const job of await readdir(providerPath, { withFileTypes: true })) {
      if (job.isDirectory())
        skipped.push({
          path: join(providerPath, job.name),
          reason: LEGACY_COMPUTE_MIGRATION_DEFERRED,
        });
    }
  }
  return { migrated: 0, skipped };
}
