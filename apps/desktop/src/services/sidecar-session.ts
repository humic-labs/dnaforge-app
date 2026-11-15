import { createApiClient, type ApiClient } from '@waypoint/api-client';
import { UserMessageError } from '@waypoint/user-messages';
import { requireHostedCapability } from '../hosted/capabilities';
import { isHostedBrowserRuntime } from '../utils/environment';

type ElectronApiShape = {
  config?: {
    getApiUrl?: () => Promise<string>;
    getSidecarStatus?: () => Promise<string>;
  };
};

export type RendererSidecarRequestAuthorityState = 'unavailable' | 'pending' | 'ready';

export function getSidecarBaseUrl(callerName: string): string {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  throw new UserMessageError('service.unavailable', {
    cause: new Error(`${callerName}: VITE_API_URL is not set.`),
  });
}

export async function resolveSidecarBaseUrl(callerName: string): Promise<string> {
  const getApiUrl = getElectronApi()?.config?.getApiUrl;
  if (typeof getApiUrl === 'function') {
    const url = await getApiUrl();
    if (typeof url === 'string' && url.trim().length > 0) return url.trim();
    throw new UserMessageError('service.unavailable', {
      cause: new Error(`${callerName}: main process returned an empty sidecar API URL.`),
    });
  }
  return getSidecarBaseUrl(callerName);
}

export function hostedExternalLookupBaseUrl(): string | null {
  if (!isHostedBrowserRuntime() || typeof window === 'undefined') return null;
  requireHostedCapability('external-lookups');
  return `${window.location.origin}/api`;
}

export async function resolveExternalLookupBaseUrl(callerName: string): Promise<string> {
  return hostedExternalLookupBaseUrl() ?? (await resolveSidecarBaseUrl(callerName));
}

export function createRendererSidecarApiClient(baseUrl: string): ApiClient {
  return createApiClient({ baseUrl });
}

export async function resolveSidecarApiClient(callerName: string): Promise<ApiClient> {
  const baseUrl = await resolveSidecarBaseUrl(callerName);
  return createRendererSidecarApiClient(baseUrl);
}

export function sidecarFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl?: typeof fetch
): Promise<Response> {
  if (fetchImpl) return fetchImpl(input, init);
  return fetch(input, init);
}

export function rendererHasSidecarRequestAuthority(): boolean {
  return typeof (globalThis as { electronAPI?: unknown }).electronAPI === 'object';
}

export async function rendererSidecarRequestAuthorityState(): Promise<RendererSidecarRequestAuthorityState> {
  if (!rendererHasSidecarRequestAuthority()) return 'unavailable';
  const getSidecarStatus = getElectronApi()?.config?.getSidecarStatus;
  if (typeof getSidecarStatus !== 'function') return 'unavailable';
  try {
    return (await getSidecarStatus()) === 'ready' ? 'ready' : 'pending';
  } catch {
    return 'pending';
  }
}

function getElectronApi(): ElectronApiShape | undefined {
  return (globalThis as typeof globalThis & { electronAPI?: ElectronApiShape }).electronAPI;
}
