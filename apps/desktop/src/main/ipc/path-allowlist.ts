import { app } from 'electron';
import { getAdmittedProjectRoots } from '../admitted-project-roots';
import { lstat, realpath } from 'fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { isPathInsideAnyBoundary } from '../../shared/path-boundary';
import type { AdmittedReadPathAdmission } from '../../shared/admitted-file-read';
import { QUICK_LOOK_PACKAGE_STORE_DIRECTORY } from '../../shared/file-associations';
import { resolveReferenceAssetCacheRoot } from '../reference-assets/reference-asset-cache-root';
import { assertReferenceAssetRuntimeWriteAllowed } from '../reference-assets/reference-asset-runtime-boundary';
import {
  acquireQuickLookRendererMutationLease,
  isQuickLookPromotionMutationBlocked,
} from '../workspace-git';

let allowedRoots: string[] | null = null;
let canonicalAllowedRoots: Promise<readonly string[]> | null = null;

function getDefaultAllowedRoots(): string[] {
  if (!allowedRoots) {
    allowedRoots = [app.getPath('userData'), app.getPath('home')];
    if (process.platform === 'darwin') {
      allowedRoots.push('/Volumes');
    } else if (process.platform === 'linux') {
      allowedRoots.push('/media', '/mnt', '/run/media');
    }
  }
  return allowedRoots;
}

export function getAllowedRoots(): string[] {
  return [...getDefaultAllowedRoots(), ...getAdmittedProjectRoots()];
}

export interface SafePathOptions {
  requireAbsolute?: boolean;
  errorPrefix?: string;
}

export async function resolveCanonicalPath(filePath: string): Promise<string> {
  let ancestor = resolve(filePath);
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

      try {
        await lstat(ancestor);
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code === 'ENOENT') {
          const parent = dirname(ancestor);
          if (parent === ancestor) throw error;
          missingSegments.unshift(basename(ancestor));
          ancestor = parent;
          continue;
        }
        throw lstatError;
      }
      return resolve(await realpath(ancestor), ...missingSegments);
    }
  }
}

async function getCanonicalAllowedRoots(): Promise<readonly string[]> {
  canonicalAllowedRoots ??= Promise.all(
    getDefaultAllowedRoots().map((root) => resolveCanonicalPath(root))
  );
  return [...(await canonicalAllowedRoots), ...getAdmittedProjectRoots()];
}

export async function assertSafePath(
  filePath: string,
  options: SafePathOptions = {}
): Promise<string> {
  if (options.requireAbsolute && !isAbsolute(filePath)) {
    const prefix = options.errorPrefix ? `[${options.errorPrefix}] ` : '';
    throw new Error(`${prefix}Path must be absolute: ${filePath}`);
  }

  const [candidatePath, roots] = await Promise.all([
    resolveCanonicalPath(filePath),
    getCanonicalAllowedRoots(),
  ]);
  assertInsideAllowedRoots(candidatePath, roots);
  return candidatePath;
}

function stringPaths(values: readonly string[]): string[] {
  return values.filter((value) => typeof value === 'string' && value.length > 0);
}

export async function assertAdmittedReadPath(
  filePath: string,
  admission: AdmittedReadPathAdmission
): Promise<string> {
  const candidatePath = await assertSafePath(filePath);
  const projectRoots = stringPaths(admission.projectRoots);
  const grantedFiles = stringPaths(admission.grantedFiles);
  const canonicalRoots = await Promise.all(projectRoots.map((root) => resolveCanonicalPath(root)));
  if (isPathInsideAnyBoundary(candidatePath, canonicalRoots)) return candidatePath;
  for (const grant of grantedFiles) {
    const canonicalGrant = await resolveCanonicalPath(grant);
    if (candidatePath === canonicalGrant) return candidatePath;
  }
  throw new Error(
    `Path access denied: ${candidatePath} is outside the trusted project and is not an explicitly granted file.`
  );
}

export async function assertSafeWritablePath(
  filePath: string,
  options: SafePathOptions = {}
): Promise<string> {
  const candidatePath = await assertSafePath(filePath, options);
  const referenceAssetCacheRoot = await resolveCanonicalPath(
    resolveReferenceAssetCacheRoot({
      appDataRoot: app.getPath('appData'),
      env: process.env,
    })
  );
  assertReferenceAssetRuntimeWriteAllowed({
    referenceAssetCacheRoot,
    candidatePath,
  });
  const retainedRoot = await resolveCanonicalPath(
    join(app.getPath('userData'), 'retained-file-blobs')
  );
  if (
    isPathInsideAnyBoundary(candidatePath, [retainedRoot]) ||
    isPathInsideAnyBoundary(retainedRoot, [candidatePath])
  )
    throw new Error('The saved entity source store is read-only.');
  const quickLookStoreRoot = await resolveCanonicalPath(
    join(app.getPath('userData'), QUICK_LOOK_PACKAGE_STORE_DIRECTORY)
  );
  if (
    isPathInsideAnyBoundary(candidatePath, [quickLookStoreRoot]) ||
    isPathInsideAnyBoundary(quickLookStoreRoot, [candidatePath])
  ) {
    throw new Error(
      `Renderer mutation of the main-owned Quick Look store is denied: ${candidatePath}`
    );
  }
  if (isQuickLookPromotionMutationBlocked(candidatePath)) {
    throw new Error(
      `Renderer mutation of an active Quick Look promotion is denied: ${candidatePath}`
    );
  }
  return candidatePath;
}

export interface SafeWritablePathRequest {
  readonly path: string;
  readonly options?: SafePathOptions;
}

export async function withSafeWritablePaths<T>(
  requests: readonly SafeWritablePathRequest[],
  operation: (paths: readonly string[]) => Promise<T>
): Promise<T> {
  const paths = await Promise.all(
    requests.map((request) => assertSafeWritablePath(request.path, request.options))
  );
  const release = acquireQuickLookRendererMutationLease(paths);
  try {
    return await operation(paths);
  } finally {
    release();
  }
}

export async function withSafeWritablePath<T>(
  filePath: string,
  operation: (path: string) => Promise<T>,
  options: SafePathOptions = {}
): Promise<T> {
  return withSafeWritablePaths([{ path: filePath, options }], ([path]) => operation(path));
}

function assertInsideAllowedRoots(candidatePath: string, roots: readonly string[]): void {
  if (!isPathInsideAnyBoundary(candidatePath, roots)) {
    throw new Error(`Path access denied: ${candidatePath}`);
  }
}
