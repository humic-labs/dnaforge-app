export const ENTITY_PROJECTION_UPDATED_EVENT = 'waypoint:entity-projection-updated';

export interface EntityProjectionUpdatedDetail {
  kind: string;
  id: string;
}

export function announceProjectionUpdated(kind: string, id: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<EntityProjectionUpdatedDetail>(ENTITY_PROJECTION_UPDATED_EVENT, {
      detail: { kind, id },
    })
  );
}
