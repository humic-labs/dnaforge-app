import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DNAFORGE_REFERENCE_ASSET_ROOT_ENV = 'DNAFORGE_REFERENCE_ASSET_ROOT';
export const DNAFORGE_REFERENCE_ASSET_CACHE_ROOT_ENV = 'DNAFORGE_REFERENCE_ASSET_CACHE_ROOT';

export interface ResolveReferenceAssetCacheRootInput {
  readonly appDataRoot: string;
  readonly userDataRoot?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

export function resolveReferenceAssetCacheRoot(input: ResolveReferenceAssetCacheRootInput): string {
  const override =
    input.env?.[DNAFORGE_REFERENCE_ASSET_ROOT_ENV]?.trim() ||
    input.env?.[DNAFORGE_REFERENCE_ASSET_CACHE_ROOT_ENV]?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      const variable = input.env?.[DNAFORGE_REFERENCE_ASSET_ROOT_ENV]?.trim()
        ? DNAFORGE_REFERENCE_ASSET_ROOT_ENV
        : DNAFORGE_REFERENCE_ASSET_CACHE_ROOT_ENV;
      throw new Error(`${variable} must be an absolute path.`);
    }
    return resolve(override);
  }
  return resolve(input.appDataRoot, 'DNAForge', 'reference-assets');
}

export function resolveReferenceAssetPublicationRoot(
  input: ResolveReferenceAssetCacheRootInput
): string {
  const sharedRoot = resolveReferenceAssetCacheRoot(input);
  if (input.env?.[DNAFORGE_REFERENCE_ASSET_ROOT_ENV]?.trim()) return sharedRoot;
  const packagedUserDataRoot = resolve(input.appDataRoot, 'DNAForge');
  const userDataRoot = resolve(input.userDataRoot ?? packagedUserDataRoot);
  return userDataRoot === packagedUserDataRoot
    ? sharedRoot
    : resolve(userDataRoot, 'reference-asset-publications');
}

export interface ReferenceAssetRootLayout {
  readonly cacheRoot: string;
  readonly publicationRoot: string;
  readonly fallbackPublicationRoot: string | null;
}

export function resolveReferenceAssetRootLayout(
  input: ResolveReferenceAssetCacheRootInput
): ReferenceAssetRootLayout {
  const cacheRoot = resolveReferenceAssetCacheRoot(input);
  const publicationRoot = resolveReferenceAssetPublicationRoot(input);
  return {
    cacheRoot,
    publicationRoot,
    fallbackPublicationRoot: publicationRoot === cacheRoot ? null : cacheRoot,
  };
}

export function defaultNodeAppDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  home: string = homedir()
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || join(home, '.config');
}
