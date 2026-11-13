import type { ReferenceAssetsBridge } from '../../shared/reference-assets-bridge';
import type { BrowserPreparedReferencesV1 } from './browser-prepared-references';

export const HOSTED_REFERENCE_CACHE_ROOT = '/hosted/reference-cache';
export const HOSTED_REFERENCE_PUBLICATION_ROOT = '/hosted/reference-publication';
const DIRECT_HOSTED_REFERENCE_BASE_URL = 'https://references.dnaforge.com/reference-genomes/v1/';
const DIRECT_HOSTED_REFERENCE_HOSTS = new Set([
  'www.dnaforge.com',
  'dnaforge.com',
  'staging.dnaforge.com',
]);

export function hostedReferenceBaseUrl(): string {
  const configured = import.meta.env.VITE_DNAFORGE_HOSTED_REFERENCE_BASE_URL?.trim();
  if (configured) return new URL(configured, window.location.origin).toString();
  return DIRECT_HOSTED_REFERENCE_HOSTS.has(window.location.hostname)
    ? DIRECT_HOSTED_REFERENCE_BASE_URL
    : new URL('/reference-genomes/v1/', window.location.origin).toString();
}

let runtime: Promise<BrowserPreparedReferencesV1> | null = null;

export function hostedPreparedReferences(): Promise<BrowserPreparedReferencesV1> {
  runtime ??= (async () => {
    const [
      { BrowserPreparedReferencesV1 },
      { PreparedReferenceObjectStoreV1, hostedReferenceObjectLocatorV1 },
      { HOSTED_REFERENCE_BROWSER_CATALOG_V1 },
      { brotliDecompressV1 },
    ] = await Promise.all([
      import('./browser-prepared-references'),
      import('./object-store'),
      import('../../shared/hosted-reference-browser-catalog'),
      import('./brotli'),
    ]);
    return new BrowserPreparedReferencesV1({
      store: new PreparedReferenceObjectStoreV1({
        locate: hostedReferenceObjectLocatorV1(hostedReferenceBaseUrl()),
      }),
      definitions: HOSTED_REFERENCE_BROWSER_CATALOG_V1.definitions,
      cacheRoot: HOSTED_REFERENCE_CACHE_ROOT,
      publicationRoot: HOSTED_REFERENCE_PUBLICATION_ROOT,
      brotliDecompress: brotliDecompressV1,
    });
  })();
  return runtime;
}

export function isHostedReferencePath(path: string): boolean {
  return (
    path.startsWith(`${HOSTED_REFERENCE_CACHE_ROOT}/`) ||
    path.startsWith(`${HOSTED_REFERENCE_PUBLICATION_ROOT}/`)
  );
}

export function createHostedReferenceAssets(): ReferenceAssetsBridge {
  const unsupported = (capability: string) => async (): Promise<never> => {
    throw new Error(`referenceAssets.${capability} requires the desktop app.`);
  };
  return {
    importLocal: async (request) =>
      (await import('./user-genomes')).importUserGenome(hostedPreparedReferences, request),
    importHubGenome: unsupported('importHubGenome'),
    listLocal: async () =>
      (await import('./user-genomes')).listUserGenomes(await hostedPreparedReferences()),
    getLocalPreparationStatus: async () => null,
    retryLocal: unsupported('retryLocal'),
    setOpenVersions: async () => undefined,
    listHosted: async () => (await hostedPreparedReferences()).listHosted(),
    getHostedPreparationStatus: async (request) =>
      (await hostedPreparedReferences()).getHostedPreparationStatus(request),
    installHosted: async (request) => (await hostedPreparedReferences()).installHosted(request),
    onPreparationProgress: (callback) => {
      let unsubscribe: (() => void) | null = null;
      let stopped = false;
      void import('./user-genomes').then(({ onUserGenomePreparationProgress }) => {
        if (!stopped) unsubscribe = onUserGenomePreparationProgress(callback);
      });
      return () => {
        stopped = true;
        unsubscribe?.();
      };
    },
    onHostedInstallProgress: () => () => undefined,
  };
}

export interface HostedReferenceMountableFs {
  readFile(path: string, maxBytes?: number): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export function withHostedReferenceMount<T extends HostedReferenceMountableFs>(fs: T): T {
  return {
    ...fs,
    readFile: async (path: string, maxBytes?: number) =>
      isHostedReferencePath(path)
        ? (await hostedPreparedReferences()).readFile(path)
        : fs.readFile(path, maxBytes),
    readTextFile: async (path: string) =>
      isHostedReferencePath(path)
        ? new TextDecoder().decode(await (await hostedPreparedReferences()).readFile(path))
        : fs.readTextFile(path),
    exists: async (path: string) =>
      isHostedReferencePath(path)
        ? (await hostedPreparedReferences()).exists(path)
        : fs.exists(path),
  };
}
