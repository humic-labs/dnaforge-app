import type { LimsRegistrationChangedDetail } from '../../shared/registry-change';
export type { LimsRegistrationChangedDetail } from '../../shared/registry-change';
export const LIMS_REGISTRATION_CHANGED_EVENT = 'waypoint:lims-registration-changed';
export {
  REGISTRY_CHANGED_EVENT as LIMS_REGISTRY_CHANGED_EVENT,
  emitRegistryChanged as emitLimsRegistryChanged,
  subscribeRegistryChanged as subscribeLimsRegistryChanged,
} from '../../shared/registry-events';

export function emitLimsRegistrationChanged(detail: LimsRegistrationChangedDetail = {}): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(LIMS_REGISTRATION_CHANGED_EVENT, { detail }));
}

export function subscribeLimsRegistrationChanged(
  listener: (detail: LimsRegistrationChangedDetail) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    listener((event as CustomEvent<LimsRegistrationChangedDetail>).detail ?? {});
  };
  window.addEventListener(LIMS_REGISTRATION_CHANGED_EVENT, handler);
  return () => window.removeEventListener(LIMS_REGISTRATION_CHANGED_EVENT, handler);
}
