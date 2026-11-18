export interface GenomicLayerDatasetPin {
  readonly id: string;
  readonly fingerprint: string;
}

export interface GenomicLayerTargetPin {
  readonly documentKey: string;
  readonly sequenceFingerprint: string;
  readonly annotationFingerprint?: string;
}

export interface GenomicLayerInputPins {
  readonly dataset: GenomicLayerDatasetPin;
  readonly target: GenomicLayerTargetPin;
  readonly mappingSpecFingerprint: string;
  readonly unresolvedPolicy: 'reject' | 'exclude';
  readonly expectedPublicationRevision: string | null;
}

export interface GenomicLayerAttempt {
  readonly id: string;
  readonly ownerGeneration: string;
  readonly inputs: GenomicLayerInputPins;
}

export interface GenomicLayerMappingCounts {
  readonly total: number;
  readonly mapped: number;
  readonly unmapped: number;
  readonly ambiguous: number;
  readonly rejected: number;
}

export interface GenomicLayerMappingReport {
  readonly counts: GenomicLayerMappingCounts;
  readonly issues: readonly string[];
}

export interface GenomicLayerPreparedCandidate {
  readonly id: string;
  readonly fingerprint: string;
  readonly counts: GenomicLayerMappingCounts;
}

export interface GenomicLayerPublicationRequest {
  readonly id: string;
  readonly artifactId: string;
  readonly path: string;
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly inputs: GenomicLayerInputPins;
}

export interface GenomicLayerPublishedArtifact {
  readonly artifactId: string;
  readonly path: string;
  readonly revision: string;
  readonly request: GenomicLayerPublicationRequest;
}

interface OperationBase {
  readonly ownerGeneration: string;
  readonly publication: GenomicLayerPublishedArtifact | null;
}

interface PreparedState extends OperationBase {
  readonly kind: 'prepared';
  readonly attempt: GenomicLayerAttempt;
  readonly candidate: GenomicLayerPreparedCandidate;
  readonly retryRequest: GenomicLayerPublicationRequest | null;
  readonly publicationIssue?: string;
}

interface PublicationState extends OperationBase {
  readonly attempt: GenomicLayerAttempt;
  readonly candidate: GenomicLayerPreparedCandidate;
  readonly request: GenomicLayerPublicationRequest;
}

export type GenomicLayerOperationState =
  | (OperationBase & { readonly kind: 'idle' })
  | (OperationBase & { readonly kind: 'preparing'; readonly attempt: GenomicLayerAttempt })
  | (OperationBase & {
      readonly kind: 'needs-input';
      readonly attempt: GenomicLayerAttempt;
      readonly report: GenomicLayerMappingReport;
    })
  | PreparedState
  | (PublicationState & { readonly kind: 'publishing' })
  | (PublicationState & { readonly kind: 'publication-uncertain'; readonly reason: string })
  | (PublicationState & {
      readonly kind: 'published';
      readonly publication: GenomicLayerPublishedArtifact;
    })
  | (OperationBase & {
      readonly kind: 'failed';
      readonly attempt: GenomicLayerAttempt;
      readonly stage: 'preparation' | 'publication';
      readonly reason: string;
      readonly currentPublicationRevision?: string | null;
    })
  | (OperationBase & { readonly kind: 'cancelled'; readonly attempt: GenomicLayerAttempt })
  | (OperationBase & {
      readonly kind: 'interrupted';
      readonly attempt: GenomicLayerAttempt;
      readonly reason: 'inputs-changed' | 'owner-restarted';
    });

export type GenomicLayerReconciliation =
  | { readonly kind: 'committed'; readonly artifact: GenomicLayerPublishedArtifact }
  | { readonly kind: 'not-committed'; readonly reason: string }
  | { readonly kind: 'conflict'; readonly currentRevision: string | null; readonly reason: string };

export type GenomicLayerOperationEvent =
  | { readonly kind: 'start'; readonly attempt: GenomicLayerAttempt }
  | {
      readonly kind: 'needs-input';
      readonly attempt: GenomicLayerAttempt;
      readonly report: GenomicLayerMappingReport;
    }
  | {
      readonly kind: 'prepared';
      readonly attempt: GenomicLayerAttempt;
      readonly candidate: GenomicLayerPreparedCandidate;
    }
  | {
      readonly kind: 'preparation-failed';
      readonly attempt: GenomicLayerAttempt;
      readonly reason: string;
    }
  | { readonly kind: 'cancel'; readonly attempt: GenomicLayerAttempt }
  | {
      readonly kind: 'inputs-changed';
      readonly attempt: GenomicLayerAttempt;
      readonly currentInputs: GenomicLayerInputPins;
    }
  | {
      readonly kind: 'publish';
      readonly attempt: GenomicLayerAttempt;
      readonly currentInputs: GenomicLayerInputPins;
      readonly request: GenomicLayerPublicationRequest;
    }
  | {
      readonly kind: 'publication-confirmed';
      readonly request: GenomicLayerPublicationRequest;
      readonly artifact: GenomicLayerPublishedArtifact;
    }
  | {
      readonly kind: 'publication-uncertain';
      readonly request: GenomicLayerPublicationRequest;
      readonly reason: string;
    }
  | {
      readonly kind: 'publication-reconciled';
      readonly request: GenomicLayerPublicationRequest;
      readonly outcome: GenomicLayerReconciliation;
    };

export type GenomicLayerTransition =
  | { readonly status: 'accepted'; readonly state: GenomicLayerOperationState }
  | {
      readonly status: 'ignored';
      readonly state: GenomicLayerOperationState;
      readonly reason: string;
    }
  | {
      readonly status: 'rejected';
      readonly state: GenomicLayerOperationState;
      readonly reason: string;
    };

export function createGenomicLayerOperation(
  ownerGeneration: string,
  publication: GenomicLayerPublishedArtifact | null = null
): GenomicLayerOperationState {
  if (!ownerGeneration.trim()) throw new Error('A layer operation needs an owner generation.');
  return { kind: 'idle', ownerGeneration, publication };
}

export function sameGenomicLayerInputPins(
  a: GenomicLayerInputPins,
  b: GenomicLayerInputPins
): boolean {
  return (
    a.dataset.id === b.dataset.id &&
    a.dataset.fingerprint === b.dataset.fingerprint &&
    a.target.documentKey === b.target.documentKey &&
    a.target.sequenceFingerprint === b.target.sequenceFingerprint &&
    a.target.annotationFingerprint === b.target.annotationFingerprint &&
    a.mappingSpecFingerprint === b.mappingSpecFingerprint &&
    a.unresolvedPolicy === b.unresolvedPolicy &&
    a.expectedPublicationRevision === b.expectedPublicationRevision
  );
}

export function sameGenomicLayerPublicationRequest(
  a: GenomicLayerPublicationRequest,
  b: GenomicLayerPublicationRequest
): boolean {
  return (
    a.id === b.id &&
    a.artifactId === b.artifactId &&
    a.path === b.path &&
    a.candidateId === b.candidateId &&
    a.candidateFingerprint === b.candidateFingerprint &&
    sameGenomicLayerInputPins(a.inputs, b.inputs)
  );
}

function sameAttempt(a: GenomicLayerAttempt, b: GenomicLayerAttempt): boolean {
  return (
    a.id === b.id &&
    a.ownerGeneration === b.ownerGeneration &&
    sameGenomicLayerInputPins(a.inputs, b.inputs)
  );
}

function validCounts(counts: GenomicLayerMappingCounts): boolean {
  return (
    [counts.total, counts.mapped, counts.unmapped, counts.ambiguous, counts.rejected].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) && counts.total === counts.mapped + counts.unmapped + counts.ambiguous + counts.rejected
  );
}

function publicationPending(
  state: GenomicLayerOperationState
): state is Extract<GenomicLayerOperationState, { kind: 'publishing' | 'publication-uncertain' }> {
  return state.kind === 'publishing' || state.kind === 'publication-uncertain';
}

function acceptsArtifact(
  request: GenomicLayerPublicationRequest,
  artifact: GenomicLayerPublishedArtifact
): boolean {
  return (
    artifact.artifactId === request.artifactId &&
    artifact.path === request.path &&
    Boolean(artifact.revision.trim()) &&
    sameGenomicLayerPublicationRequest(request, artifact.request)
  );
}

export function reduceGenomicLayerOperation(
  state: GenomicLayerOperationState,
  event: GenomicLayerOperationEvent
): GenomicLayerTransition {
  const accepted = (next: GenomicLayerOperationState): GenomicLayerTransition => ({
    status: 'accepted',
    state: next,
  });
  const rejected = (reason: string): GenomicLayerTransition => ({
    status: 'rejected',
    state,
    reason,
  });
  const ignored = (reason: string): GenomicLayerTransition => ({
    status: 'ignored',
    state,
    reason,
  });
  const base: OperationBase = {
    ownerGeneration: state.ownerGeneration,
    publication: state.publication,
  };

  if (event.kind === 'start') {
    if (publicationPending(state)) return rejected('publication-pending');
    if (event.attempt.ownerGeneration !== state.ownerGeneration) return rejected('obsolete-owner');
    if ('attempt' in state && state.attempt.id === event.attempt.id) {
      return sameAttempt(state.attempt, event.attempt)
        ? ignored('duplicate-attempt')
        : rejected('attempt-id-collision');
    }
    if (
      event.attempt.inputs.expectedPublicationRevision !== (state.publication?.revision ?? null)
    ) {
      return rejected('publication-revision-changed');
    }
    return accepted({ ...base, kind: 'preparing', attempt: event.attempt });
  }

  if ('attempt' in event) {
    if (
      !('attempt' in state) ||
      !sameAttempt(state.attempt, event.attempt) ||
      event.attempt.ownerGeneration !== state.ownerGeneration
    )
      return ignored('obsolete-attempt');
    if (event.kind === 'cancel' || event.kind === 'inputs-changed') {
      if (publicationPending(state)) return rejected('publication-pending');
      if (!['preparing', 'prepared', 'needs-input'].includes(state.kind))
        return rejected('not-preparing');
      if (event.kind === 'cancel')
        return accepted({ ...base, kind: 'cancelled', attempt: state.attempt });
      if (sameGenomicLayerInputPins(state.attempt.inputs, event.currentInputs))
        return ignored('unchanged-inputs');
      return accepted({
        ...base,
        kind: 'interrupted',
        attempt: state.attempt,
        reason: 'inputs-changed',
      });
    }
    if (event.kind === 'publish') {
      if (state.kind !== 'prepared') return rejected('not-prepared');
      if (!sameGenomicLayerInputPins(state.attempt.inputs, event.currentInputs))
        return rejected('inputs-changed');
      const request = event.request;
      if (
        !sameGenomicLayerInputPins(request.inputs, state.attempt.inputs) ||
        request.candidateId !== state.candidate.id ||
        request.candidateFingerprint !== state.candidate.fingerprint ||
        !request.id.trim() ||
        !request.artifactId.trim() ||
        !request.path.trim()
      )
        return rejected('invalid-publication-request');
      if (state.retryRequest && !sameGenomicLayerPublicationRequest(state.retryRequest, request))
        return rejected('retry-request-changed');
      if (state.publication?.request.id === request.id)
        return rejected('publication-request-id-collision');
      return accepted({
        ...base,
        kind: 'publishing',
        attempt: state.attempt,
        candidate: state.candidate,
        request,
      });
    }
    if (state.kind !== 'preparing') return ignored('preparation-already-settled');
    if (event.kind === 'preparation-failed')
      return accepted({
        ...base,
        kind: 'failed',
        stage: 'preparation',
        attempt: state.attempt,
        reason: event.reason,
      });
    if (event.kind === 'needs-input') {
      if (!validCounts(event.report.counts) || event.report.issues.length === 0)
        return rejected('invalid-mapping-report');
      return accepted({
        ...base,
        kind: 'needs-input',
        attempt: state.attempt,
        report: event.report,
      });
    }
    const counts = event.candidate.counts;
    if (!event.candidate.id.trim() || !event.candidate.fingerprint.trim() || !validCounts(counts))
      return rejected('invalid-candidate');
    if (
      counts.mapped === 0 ||
      (state.attempt.inputs.unresolvedPolicy === 'reject' &&
        counts.unmapped + counts.ambiguous + counts.rejected !== 0)
    )
      return rejected('unresolved-mapping');
    return accepted({
      ...base,
      kind: 'prepared',
      attempt: state.attempt,
      candidate: event.candidate,
      retryRequest: null,
    });
  }

  if (!publicationPending(state)) {
    if (
      event.kind === 'publication-confirmed' &&
      state.publication?.request.id === event.request.id
    ) {
      return sameGenomicLayerPublicationRequest(state.publication.request, event.request) &&
        acceptsArtifact(event.request, event.artifact) &&
        event.artifact.revision === state.publication.revision
        ? ignored('duplicate-receipt')
        : rejected('publication-request-id-collision');
    }
    return ignored('no-pending-publication');
  }
  if (!sameGenomicLayerPublicationRequest(state.request, event.request)) {
    return state.request.id === event.request.id
      ? rejected('publication-request-id-collision')
      : ignored('obsolete-publication');
  }
  if (event.kind === 'publication-uncertain')
    return accepted({ ...state, kind: 'publication-uncertain', reason: event.reason });
  const outcome =
    event.kind === 'publication-confirmed'
      ? { kind: 'committed' as const, artifact: event.artifact }
      : event.outcome;
  if (outcome.kind === 'committed') {
    if (!acceptsArtifact(state.request, outcome.artifact))
      return rejected('invalid-publication-receipt');
    return accepted({ ...state, kind: 'published', publication: outcome.artifact });
  }
  if (outcome.kind === 'conflict')
    return accepted({
      ...base,
      kind: 'failed',
      attempt: state.attempt,
      stage: 'publication',
      reason: outcome.reason,
      currentPublicationRevision: outcome.currentRevision,
    });
  return accepted({
    ...base,
    kind: 'prepared',
    attempt: { ...state.attempt, ownerGeneration: state.ownerGeneration },
    candidate: state.candidate,
    retryRequest: state.request,
    publicationIssue: outcome.reason,
  });
}

export function recoverGenomicLayerOperation(
  state: GenomicLayerOperationState,
  ownerGeneration: string
): GenomicLayerOperationState {
  if (!ownerGeneration.trim()) throw new Error('A layer operation needs an owner generation.');
  if (publicationPending(state))
    return { ...state, ownerGeneration, kind: 'publication-uncertain', reason: 'owner-restarted' };
  if (state.kind === 'preparing')
    return { ...state, ownerGeneration, kind: 'interrupted', reason: 'owner-restarted' };
  if (state.kind === 'prepared' || state.kind === 'needs-input') {
    return { ...state, ownerGeneration, attempt: { ...state.attempt, ownerGeneration } };
  }
  return { ...state, ownerGeneration };
}

export type GenomicLayerBindingValidity =
  | { readonly kind: 'current' }
  | { readonly kind: 'unavailable' | 'stale'; readonly reasons: readonly string[] };

export function genomicLayerBindingValidity(
  publication: GenomicLayerPublishedArtifact,
  current: {
    readonly dataset: GenomicLayerDatasetPin | null;
    readonly target: GenomicLayerTargetPin | null;
  }
): GenomicLayerBindingValidity {
  const bound = publication.request.inputs;
  const unavailable = [
    ...(!current.dataset ? ['dataset-unavailable'] : []),
    ...(!current.target ? ['target-unavailable'] : []),
    ...(bound.target.annotationFingerprint !== undefined &&
    current.target &&
    current.target.annotationFingerprint === undefined
      ? ['annotations-unavailable']
      : []),
  ];
  if (unavailable.length) return { kind: 'unavailable', reasons: unavailable };
  const reasons = [
    ...(current.dataset!.id !== bound.dataset.id ||
    current.dataset!.fingerprint !== bound.dataset.fingerprint
      ? ['dataset-changed']
      : []),
    ...(current.target!.documentKey !== bound.target.documentKey ? ['target-changed'] : []),
    ...(current.target!.sequenceFingerprint !== bound.target.sequenceFingerprint
      ? ['sequence-changed']
      : []),
    ...(bound.target.annotationFingerprint !== undefined &&
    current.target!.annotationFingerprint !== bound.target.annotationFingerprint
      ? ['annotations-changed']
      : []),
  ];
  return reasons.length ? { kind: 'stale', reasons } : { kind: 'current' };
}
