import type {
  AnnotationEvidenceClass,
  AssemblyIdentity,
  FeatureKind,
  TrackBindingId,
} from '@waypoint/genome-data/annotation-catalog';

import type { StrandHoverIndexes } from './record-hover-index';

export type AnnotationTrackDrawState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly recordCount: number; readonly totalBeforeFilter: number }
  | {
      readonly status: 'error';
      readonly message: string;
      readonly detail: string | null;
    };

export type AnnotationCatalogDrawingPhase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'map-circular' }
  | { readonly phase: 'view-transformed' }
  | { readonly phase: 'waiting-for-map' }
  | { readonly phase: 'active' }
  | { readonly phase: 'error'; readonly message: string; readonly detail: string | null };

export interface HoverableCatalogTrack {
  readonly trackId: string;
  readonly bindingId: TrackBindingId;
  readonly kind: FeatureKind;
  readonly sourceLabel: string;
  readonly evidence: AnnotationEvidenceClass;
  readonly licenseSpdx: string | null;
  readonly attribution: string;
  readonly indexByStrand: StrandHoverIndexes;
}

export interface AnnotationCatalogWiring {
  readonly assembly: AssemblyIdentity;
  readonly displayName: string;
  readonly drawing: AnnotationCatalogDrawingPhase;
  readonly tracks: ReadonlyMap<TrackBindingId, AnnotationTrackDrawState>;
  readonly hoverTracks: readonly HoverableCatalogTrack[];
}

const wiringByTab = new Map<string, AnnotationCatalogWiring>();
const listeners = new Set<() => void>();
let revision = 0;

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function publishAnnotationCatalogWiring(
  ownerTabId: string,
  wiring: AnnotationCatalogWiring
): void {
  wiringByTab.set(ownerTabId, wiring);
  notify();
}

export function clearAnnotationCatalogWiring(ownerTabId: string): void {
  if (wiringByTab.delete(ownerTabId)) notify();
}

export function readAnnotationCatalogWiring(ownerTabId: string): AnnotationCatalogWiring | null {
  return wiringByTab.get(ownerTabId) ?? null;
}

export function subscribeAnnotationCatalogWiring(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function annotationCatalogWiringRevision(): number {
  return revision;
}
