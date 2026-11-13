import { create } from 'zustand';

export type RegistryPresentationResult =
  | { kind: 'record'; entityId: string }
  | { kind: 'search' | 'missing' | 'mismatch' | 'superseded' | 'cancelled' };

export interface RegistryPresentationRequest {
  requestId: number;
  entityId: string | null;
  fallbackSearch: string;
  organizationId?: string;
  action?: 'browse' | 'claim';
  onPresentation?: (result: RegistryPresentationResult) => void;
}

const settledRegistryRequests = new WeakSet<RegistryPresentationRequest>();
let registryRequestSequence = 0;
let pendingRegistryRequest: RegistryPresentationRequest | null = null;

export function observeRegistryPresentation(
  request: RegistryPresentationRequest,
  result: RegistryPresentationResult
): void {
  if (settledRegistryRequests.has(request)) return;
  if (result.kind === 'record' && result.entityId !== request.entityId) return;
  if (result.kind === 'search' && request.entityId !== null) return;
  settledRegistryRequests.add(request);
  if (pendingRegistryRequest === request) pendingRegistryRequest = null;
  const current = useLimsOverlayStore.getState().registryRequestResult;
  if (
    current?.requestId === request.requestId &&
    current.entityId === request.entityId &&
    current.status === 'pending'
  ) {
    const status =
      result.kind === 'record' || result.kind === 'search'
        ? 'presented'
        : result.kind === 'superseded' || result.kind === 'cancelled'
          ? 'superseded'
          : 'failed';
    useLimsOverlayStore.setState({ registryRequestResult: { ...current, status } });
  }
  try {
    request.onPresentation?.(result);
  } catch {
    return;
  }
}

export type RegistryRequestResult = Readonly<{
  requestId: number;
  entityId: string | null;
  status: 'pending' | 'presented' | 'failed' | 'superseded';
}>;

interface LimsOverlayState {
  active: boolean;
  registryRequest: RegistryPresentationRequest | null;
  registryRequestResult: RegistryRequestResult | null;
  setActive: (active: boolean) => void;
  requestRegistryEntity: (
    entityId: string | null,
    fallbackSearch: string,
    options?:
      | RegistryPresentationRequest['onPresentation']
      | Pick<RegistryPresentationRequest, 'organizationId' | 'action' | 'onPresentation'>
  ) => number;
  consumeRegistryRequest: (requestId: number) => void;
  completeRegistryRequest: (
    requestId: number,
    entityId: string,
    status: 'presented' | 'failed'
  ) => boolean;
  supersedeRegistryRequest: (requestId?: number) => void;
}

export const useLimsOverlayStore = create<LimsOverlayState>((set, get) => ({
  active: false,
  registryRequest: null,
  registryRequestResult: null,
  setActive: (active) => set((state) => (state.active === active ? state : { active })),
  requestRegistryEntity: (entityId, fallbackSearch, options) => {
    const previous = pendingRegistryRequest;
    const request = {
      requestId: ++registryRequestSequence,
      entityId,
      fallbackSearch,
      ...(typeof options === 'function' ? { onPresentation: options } : options),
    };
    pendingRegistryRequest = request;
    set({
      registryRequest: request,
      registryRequestResult: { requestId: request.requestId, entityId, status: 'pending' },
    });
    if (previous) observeRegistryPresentation(previous, { kind: 'superseded' });
    return request.requestId;
  },
  consumeRegistryRequest: (requestId) =>
    set((state) =>
      state.registryRequest?.requestId === requestId ? { registryRequest: null } : state
    ),
  completeRegistryRequest: (requestId, entityId, status) => {
    const current = get().registryRequestResult;
    const request = pendingRegistryRequest;
    if (
      !current ||
      !request ||
      request.requestId !== requestId ||
      current.requestId !== requestId ||
      current.entityId !== entityId ||
      current.status !== 'pending'
    )
      return false;
    observeRegistryPresentation(
      request,
      status === 'presented' ? { kind: 'record', entityId } : { kind: 'missing' }
    );
    return true;
  },
  supersedeRegistryRequest: (requestId) => {
    const current = get().registryRequestResult;
    const request = pendingRegistryRequest;
    if (
      !current ||
      !request ||
      request.requestId !== current.requestId ||
      current.status !== 'pending' ||
      (requestId !== undefined && requestId !== current.requestId)
    )
      return;
    observeRegistryPresentation(request, { kind: 'superseded' });
    set((state) =>
      state.registryRequest?.requestId === request.requestId ? { registryRequest: null } : state
    );
  },
}));
