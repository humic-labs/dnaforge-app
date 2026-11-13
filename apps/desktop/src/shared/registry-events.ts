export const REGISTRY_CHANGED_EVENT = 'waypoint:lims-registry-changed';
export const OPEN_REGISTRY_EVENT = 'waypoint:open-lims-registry';

export interface RegistryOpenRequest {
  entityId: string | null;
  fallbackSearch: string;
  organizationId?: string;
  action?: 'browse' | 'claim';
}

export function emitRegistryChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(REGISTRY_CHANGED_EVENT));
}

export function subscribeRegistryChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(REGISTRY_CHANGED_EVENT, listener);
  return () => window.removeEventListener(REGISTRY_CHANGED_EVENT, listener);
}

export function requestRegistryOpen(request?: RegistryOpenRequest): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_REGISTRY_EVENT, { detail: request ?? null }));
}

export function subscribeRegistryOpen(
  listener: (request: RegistryOpenRequest | null) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    listener((event as CustomEvent<RegistryOpenRequest | null>).detail ?? null);
  };
  window.addEventListener(OPEN_REGISTRY_EVENT, handler);
  return () => window.removeEventListener(OPEN_REGISTRY_EVENT, handler);
}
