import { defineBlob } from '@waypoint/workspace-revisions';

export function inventoryObservationKey(
  namespace: string,
  observationId: string
): `sha256:${string}` {
  return defineBlob(new TextEncoder().encode(JSON.stringify([namespace, observationId]))).hash;
}
