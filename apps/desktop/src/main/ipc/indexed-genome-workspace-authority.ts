import { isAbsolute } from 'node:path';

import { isPathInsideAnyBoundary } from '../../shared/path-boundary';
import { INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE } from '../../shared/indexed-genome';
import { resolveCanonicalPath } from './path-allowlist';

const MAX_WORKSPACE_ROOTS = 64;
const MANIFEST_PATH_KEYS = ['fastaPath', 'faiPath', 'gffPath', 'tbiPath'] as const;

interface WorkspaceScopedIndexedGenomeManifest {
  fastaPath: string;
  faiPath: string;
  gffPath?: string | null;
  tbiPath?: string | null;
  workspaceRootPaths?: unknown;
}

export async function assertIndexedGenomeWorkspaceAuthority(
  manifest: WorkspaceScopedIndexedGenomeManifest,
  canonicalize: (path: string) => Promise<string> = resolveCanonicalPath
): Promise<void> {
  if (manifest.workspaceRootPaths === undefined) return;
  if (
    !Array.isArray(manifest.workspaceRootPaths) ||
    manifest.workspaceRootPaths.length === 0 ||
    manifest.workspaceRootPaths.length > MAX_WORKSPACE_ROOTS ||
    manifest.workspaceRootPaths.some(
      (root) => typeof root !== 'string' || !root || !isAbsolute(root)
    )
  ) {
    throw new Error('[genome] Invalid indexed-genome workspace authority.');
  }

  const roots = [...new Set(manifest.workspaceRootPaths)];
  for (const key of MANIFEST_PATH_KEYS) {
    const sourcePath = manifest[key];
    if (!sourcePath) continue;
    let currentCanonicalPath: string;
    try {
      currentCanonicalPath = await canonicalize(sourcePath);
    } catch {
      throw indexedSourceUnavailable(`${key} could not be resolved inside its admitted workspace.`);
    }
    if (!isPathInsideAnyBoundary(currentCanonicalPath, roots)) {
      throw indexedSourceUnavailable(`${key} escaped its admitted workspace.`);
    }
  }
}

function indexedSourceUnavailable(message: string): Error {
  return new Error(`${INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE}: ${message}`);
}
