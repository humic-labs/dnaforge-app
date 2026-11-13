import {
  managedOperations,
  type ManagedOperationsSnapshot,
} from '../../../services/managed-operations';
import { refreshAnnotationCatalogs } from './annotation-catalog-registry';

export const TRACK_REGISTRATION_KIND = 'track-registration';

interface OperationsSource {
  getSnapshot(): ManagedOperationsSnapshot;
  subscribe(listener: () => void): () => void;
}

function succeededRegistrations(snapshot: ManagedOperationsSnapshot): string[] {
  return snapshot.records
    .filter(
      (record) =>
        record.snapshot.kind === TRACK_REGISTRATION_KIND && record.snapshot.state === 'succeeded'
    )
    .map((record) => record.snapshot.id);
}

export function watchTrackRegistrations(
  source: OperationsSource,
  refresh: () => Promise<unknown>
): () => void {
  const seen = new Set(succeededRegistrations(source.getSnapshot()));
  return source.subscribe(() => {
    let fresh = false;
    for (const id of succeededRegistrations(source.getSnapshot())) {
      if (!seen.has(id)) {
        seen.add(id);
        fresh = true;
      }
    }
    if (fresh) {
      void refresh().catch((error: unknown) => {
        console.warn('[AnnotationCatalog] refresh after track registration failed', error);
      });
    }
  });
}

let stop: (() => void) | null = null;

export function startTrackRegistrationRefresh(): void {
  if (stop) return;
  stop = watchTrackRegistrations(managedOperations, () => refreshAnnotationCatalogs());
}

export function stopTrackRegistrationRefreshForTests(): void {
  stop?.();
  stop = null;
}
