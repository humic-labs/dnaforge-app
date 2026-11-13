import { useLayoutEffect, useReducer } from 'react';

import type {
  AnnotationFlatPresentationSnapshot,
  AnnotationPresentationPage,
  AnnotationResidentPagePublication,
  Feature,
} from '@waypoint/genome-renderer';

export interface AnnotationPresentationSnapshotCandidate {
  semanticIdentity: object;
  sourceIdentity: string;
  genomeLengthBp: number;
  policyKey: string;
  features: ReadonlyArray<Feature>;
  requestedLayerTypes: ReadonlyArray<string>;
  layout: Readonly<{ maxAnnotationLane: number; maxCdsLane: number }>;
  exactCoverage: ReadonlyArray<Readonly<{ startBp: number; endBp: number }>>;
}

interface SnapshotEntry {
  semanticIdentity: object;
  snapshot: AnnotationFlatPresentationSnapshot;
}

const MAX_RETAINED_ANNOTATION_PRESENTATION_STREAMS = 2;

export interface AnnotationPresentationSnapshotState {
  entries: ReadonlyMap<string, SnapshotEntry>;
  current: AnnotationFlatPresentationSnapshot | undefined;
}

type AnnotationPresentationSnapshotAction = {
  type: 'publish-committed';
  candidate: AnnotationPresentationSnapshotCandidate;
};

export const INITIAL_ANNOTATION_PRESENTATION_SNAPSHOT_STATE: AnnotationPresentationSnapshotState = {
  entries: new Map(),
  current: undefined,
};

export function annotationPresentationSnapshotReducer(
  state: AnnotationPresentationSnapshotState,
  action: AnnotationPresentationSnapshotAction
): AnnotationPresentationSnapshotState {
  const candidate = action.candidate;
  const cacheKey = `${candidate.sourceIdentity}\u0000${candidate.policyKey}`;
  const previous = state.entries.get(cacheKey);
  if (previous?.semanticIdentity === candidate.semanticIdentity) {
    if (state.current === previous.snapshot) return state;
    return { ...state, current: previous.snapshot };
  }

  const generation = previous ? previous.snapshot.generation + 1 : 0;
  const snapshot = Object.freeze({
    contract: 'annotation-presentation-snapshot.v1' as const,
    sourceIdentity: candidate.sourceIdentity,
    genomeLengthBp: candidate.genomeLengthBp,
    policyKey: candidate.policyKey,
    generation,
    features: Object.freeze([...candidate.features]),
    requestedLayerTypes: Object.freeze([...candidate.requestedLayerTypes]),
    layout: Object.freeze({ ...candidate.layout }),
    exactCoverage: Object.freeze(
      candidate.exactCoverage.map((range) => Object.freeze({ ...range }))
    ),
  }) satisfies AnnotationFlatPresentationSnapshot;
  const entries = new Map(state.entries);
  entries.set(cacheKey, { semanticIdentity: candidate.semanticIdentity, snapshot });
  while (entries.size > MAX_RETAINED_ANNOTATION_PRESENTATION_STREAMS) {
    const obsolete = [...entries.keys()].find((key) => key !== cacheKey);
    if (obsolete === undefined) break;
    entries.delete(obsolete);
  }
  return { entries, current: snapshot };
}

export function useAnnotationPresentationSnapshot(
  candidate: AnnotationPresentationSnapshotCandidate | null | undefined
): AnnotationFlatPresentationSnapshot | undefined {
  const [state, dispatch] = useReducer(
    annotationPresentationSnapshotReducer,
    INITIAL_ANNOTATION_PRESENTATION_SNAPSHOT_STATE
  );
  useLayoutEffect(() => {
    if (!candidate) return;
    dispatch({ type: 'publish-committed', candidate });
  }, [candidate]);
  return state.current;
}

export interface AnnotationResidentPagePublicationCandidate {
  semanticIdentity: object;
  contract?: AnnotationResidentPagePublication['contract'];
  sourceIdentity: string;
  genomeLengthBp: number;
  policyKey: string;
  requestedLayerTypes: ReadonlyArray<string>;
  exactCoverage: ReadonlyArray<Readonly<{ startBp: number; endBp: number }>>;
  pages: ReadonlyArray<AnnotationPresentationPage>;
}

interface ResidentPagePublicationEntry {
  semanticIdentity: object;
  publication: AnnotationResidentPagePublication;
}

export interface AnnotationResidentPagePublicationState {
  entries: ReadonlyMap<string, ResidentPagePublicationEntry>;
  current: AnnotationResidentPagePublication | undefined;
}

type AnnotationResidentPagePublicationAction = {
  type: 'publish-committed';
  candidate: AnnotationResidentPagePublicationCandidate;
};

export const INITIAL_ANNOTATION_RESIDENT_PAGE_PUBLICATION_STATE: AnnotationResidentPagePublicationState =
  {
    entries: new Map(),
    current: undefined,
  };

export function annotationResidentPagePublicationReducer(
  state: AnnotationResidentPagePublicationState,
  action: AnnotationResidentPagePublicationAction
): AnnotationResidentPagePublicationState {
  const candidate = action.candidate;
  const cacheKey = `${candidate.sourceIdentity}\u0000${candidate.policyKey}`;
  const previous = state.entries.get(cacheKey);
  if (previous?.semanticIdentity === candidate.semanticIdentity) {
    if (state.current === previous.publication) return state;
    return { ...state, current: previous.publication };
  }

  const generation = previous ? previous.publication.generation + 1 : 0;
  const publication = Object.freeze({
    contract: candidate.contract ?? ('annotation-resident-page-publication.v1' as const),
    sourceIdentity: candidate.sourceIdentity,
    genomeLengthBp: candidate.genomeLengthBp,
    policyKey: candidate.policyKey,
    generation,
    requestedLayerTypes: Object.freeze([...candidate.requestedLayerTypes]),
    exactCoverage: Object.freeze(
      candidate.exactCoverage.map((range) => Object.freeze({ ...range }))
    ),
    pages: Object.freeze([...candidate.pages]),
  }) satisfies AnnotationResidentPagePublication;
  const entries = new Map(state.entries);
  entries.set(cacheKey, { semanticIdentity: candidate.semanticIdentity, publication });
  while (entries.size > MAX_RETAINED_ANNOTATION_PRESENTATION_STREAMS) {
    const obsolete = [...entries.keys()].find((key) => key !== cacheKey);
    if (obsolete === undefined) break;
    entries.delete(obsolete);
  }
  return { entries, current: publication };
}

export function useAnnotationResidentPagePublication(
  candidate: AnnotationResidentPagePublicationCandidate | null | undefined
): AnnotationResidentPagePublication | undefined {
  const [state, dispatch] = useReducer(
    annotationResidentPagePublicationReducer,
    INITIAL_ANNOTATION_RESIDENT_PAGE_PUBLICATION_STATE
  );
  useLayoutEffect(() => {
    if (!candidate) return;
    dispatch({ type: 'publish-committed', candidate });
  }, [candidate]);
  return state.current;
}
