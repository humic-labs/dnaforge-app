import { describe, expect, it } from 'vitest';
import {
  createGenomicLayerOperation,
  genomicLayerBindingValidity,
  recoverGenomicLayerOperation,
  reduceGenomicLayerOperation,
  type GenomicLayerAttempt,
  type GenomicLayerInputPins,
  type GenomicLayerOperationEvent,
  type GenomicLayerOperationState,
  type GenomicLayerPreparedCandidate,
  type GenomicLayerPublicationRequest,
  type GenomicLayerPublishedArtifact,
} from './genomic-layer-operation';

const inputs: GenomicLayerInputPins = {
  dataset: { id: 'fitness-table', fingerprint: 'dataset-v1' },
  target: {
    documentKey: 'sequence-package-1',
    sequenceFingerprint: 'sequence-v1',
    annotationFingerprint: 'annotations-v1',
  },
  mappingSpecFingerprint: 'annotation-id-join-reject-v1',
  unresolvedPolicy: 'reject',
  expectedPublicationRevision: null,
};
const attempt: GenomicLayerAttempt = { id: 'mapping-1', ownerGeneration: 'owner-1', inputs };
const candidate: GenomicLayerPreparedCandidate = {
  id: 'candidate-1',
  fingerprint: 'mapped-rows-v1',
  counts: { total: 4, mapped: 4, unmapped: 0, ambiguous: 0, rejected: 0 },
};
const request: GenomicLayerPublicationRequest = {
  id: 'publish-1',
  artifactId: 'binding-1',
  path: '/project/binding-1.json',
  candidateId: candidate.id,
  candidateFingerprint: candidate.fingerprint,
  inputs,
};
const artifact: GenomicLayerPublishedArtifact = {
  artifactId: request.artifactId,
  path: request.path,
  revision: 'binding-revision-1',
  request,
};

function step(state: GenomicLayerOperationState, event: GenomicLayerOperationEvent) {
  const result = reduceGenomicLayerOperation(state, event);
  expect(result.status).toBe('accepted');
  return result.state;
}

function preparing(
  nextAttempt = attempt,
  publication: GenomicLayerPublishedArtifact | null = null
) {
  return step(createGenomicLayerOperation(nextAttempt.ownerGeneration, publication), {
    kind: 'start',
    attempt: nextAttempt,
  });
}

function prepared(nextAttempt = attempt, publication: GenomicLayerPublishedArtifact | null = null) {
  return step(preparing(nextAttempt, publication), {
    kind: 'prepared',
    attempt: nextAttempt,
    candidate,
  });
}

function publishing() {
  return step(prepared(), { kind: 'publish', attempt, currentInputs: inputs, request });
}

describe('genomic layer operation ownership', () => {
  it('publishes only the exact prepared candidate and confirmed native receipt', () => {
    const pending = publishing();
    expect(pending.publication).toBeNull();
    const complete = step(pending, { kind: 'publication-confirmed', request, artifact });
    expect(complete).toMatchObject({ kind: 'published', publication: artifact });
    expect(
      reduceGenomicLayerOperation(complete, {
        kind: 'publication-confirmed',
        request,
        artifact,
      })
    ).toMatchObject({ status: 'ignored', reason: 'duplicate-receipt', state: complete });
  });

  it('invalidates a cancelled attempt before its late successful preparation can publish', () => {
    const cancelled = step(preparing(), { kind: 'cancel', attempt });
    const late = reduceGenomicLayerOperation(cancelled, { kind: 'prepared', attempt, candidate });
    expect(late).toMatchObject({
      status: 'ignored',
      state: { kind: 'cancelled', publication: null },
    });
    expect(
      reduceGenomicLayerOperation(cancelled, {
        kind: 'publish',
        attempt,
        currentInputs: inputs,
        request,
      })
    ).toMatchObject({ status: 'rejected', reason: 'not-prepared' });
  });

  it('starts a retry with a new attempt identity and ignores the old reply', () => {
    const failed = step(preparing(), {
      kind: 'preparation-failed',
      attempt,
      reason: 'reader unavailable',
    });
    const retry = { ...attempt, id: 'mapping-2' };
    const next = step(failed, { kind: 'start', attempt: retry });
    expect(
      reduceGenomicLayerOperation(next, { kind: 'prepared', attempt, candidate })
    ).toMatchObject({ status: 'ignored', reason: 'obsolete-attempt', state: next });
    expect(step(next, { kind: 'prepared', attempt: retry, candidate }).kind).toBe('prepared');
  });

  it('rejects an attempt ID reused with different scientific inputs', () => {
    const changed = { ...attempt, inputs: { ...inputs, mappingSpecFingerprint: 'other-recipe' } };
    expect(
      reduceGenomicLayerOperation(preparing(), { kind: 'start', attempt: changed })
    ).toMatchObject({ status: 'rejected', reason: 'attempt-id-collision' });
  });

  it.each([
    { ...inputs, dataset: { ...inputs.dataset, id: 'other-dataset' } },
    { ...inputs, dataset: { ...inputs.dataset, fingerprint: 'dataset-v2' } },
    { ...inputs, target: { ...inputs.target, documentKey: 'another-sequence' } },
    { ...inputs, target: { ...inputs.target, sequenceFingerprint: 'sequence-v2' } },
    { ...inputs, target: { ...inputs.target, annotationFingerprint: 'annotations-v2' } },
    { ...inputs, mappingSpecFingerprint: 'other-recipe' },
    { ...inputs, unresolvedPolicy: 'exclude' as const },
    { ...inputs, expectedPublicationRevision: 'different-baseline' },
  ])('refuses publication after captured inputs change: %j', (currentInputs) => {
    const ready = prepared();
    expect(
      reduceGenomicLayerOperation(ready, { kind: 'publish', attempt, currentInputs, request })
    ).toMatchObject({ status: 'rejected', reason: 'inputs-changed', state: ready });
    const invalidated = step(ready, { kind: 'inputs-changed', attempt, currentInputs });
    expect(invalidated).toMatchObject({ kind: 'interrupted', reason: 'inputs-changed' });
    expect(
      reduceGenomicLayerOperation(invalidated, { kind: 'prepared', attempt, candidate }).status
    ).toBe('ignored');
  });

  it('does not accept a completion with a changed fingerprint under the same attempt ID', () => {
    const forged = {
      ...attempt,
      inputs: { ...inputs, dataset: { ...inputs.dataset, fingerprint: 'v2' } },
    };
    expect(
      reduceGenomicLayerOperation(preparing(), { kind: 'prepared', attempt: forged, candidate })
    ).toMatchObject({ status: 'ignored', reason: 'obsolete-attempt' });
  });

  it('retains mapping issues without making a needs-input result publishable', () => {
    const report = {
      counts: { total: 4, mapped: 2, unmapped: 1, ambiguous: 1, rejected: 0 },
      issues: ['Two annotations share the identifier.'],
    };
    const waiting = step(preparing(), { kind: 'needs-input', attempt, report });
    expect(waiting).toMatchObject({ kind: 'needs-input', report });
    expect(
      reduceGenomicLayerOperation(waiting, {
        kind: 'publish',
        attempt,
        currentInputs: inputs,
        request,
      })
    ).toMatchObject({ status: 'rejected', reason: 'not-prepared' });
  });

  it('requires explicit exclusion policy for partially mapped candidates and preserves their counts', () => {
    const partial = {
      ...candidate,
      counts: { total: 4, mapped: 1, unmapped: 1, ambiguous: 1, rejected: 1 },
    };
    expect(
      reduceGenomicLayerOperation(preparing(), { kind: 'prepared', attempt, candidate: partial })
    ).toMatchObject({ status: 'rejected', reason: 'unresolved-mapping' });
    const excluding = {
      ...attempt,
      inputs: {
        ...inputs,
        mappingSpecFingerprint: 'annotation-id-join-exclude-v1',
        unresolvedPolicy: 'exclude' as const,
      },
    };
    expect(
      step(preparing(excluding), { kind: 'prepared', attempt: excluding, candidate: partial })
    ).toMatchObject({ kind: 'prepared', candidate: partial });
  });

  it.each(['reject', 'exclude'] as const)(
    'never publishes an all-unmapped dataset under %s policy',
    (unresolvedPolicy) => {
      const unmapped = {
        ...candidate,
        counts: { total: 4, mapped: 0, unmapped: 4, ambiguous: 0, rejected: 0 },
      };
      const current = { ...attempt, inputs: { ...inputs, unresolvedPolicy } };
      expect(
        reduceGenomicLayerOperation(preparing(current), {
          kind: 'prepared',
          attempt: current,
          candidate: unmapped,
        })
      ).toMatchObject({ status: 'rejected', reason: 'unresolved-mapping' });
    }
  );

  it('rejects inconsistent mapping totals', () => {
    const inconsistent = { ...candidate, counts: { ...candidate.counts, total: 5 } };
    expect(
      reduceGenomicLayerOperation(preparing(), {
        kind: 'prepared',
        attempt,
        candidate: inconsistent,
      })
    ).toMatchObject({ status: 'rejected', reason: 'invalid-candidate' });
  });

  it('keeps a prior confirmed publication through remapping failure and cancellation', () => {
    const remap = {
      ...attempt,
      id: 'mapping-2',
      inputs: { ...inputs, expectedPublicationRevision: artifact.revision },
    };
    const pending = preparing(remap, artifact);
    const failed = step(pending, {
      kind: 'preparation-failed',
      attempt: remap,
      reason: 'bad input',
    });
    expect(failed.publication).toEqual(artifact);
    const retry = { ...remap, id: 'mapping-3' };
    const cancelled = step(step(failed, { kind: 'start', attempt: retry }), {
      kind: 'cancel',
      attempt: retry,
    });
    expect(cancelled.publication).toEqual(artifact);
  });

  it('blocks a replacement that did not inspect the last confirmed publication revision', () => {
    expect(
      reduceGenomicLayerOperation(createGenomicLayerOperation('owner-1', artifact), {
        kind: 'start',
        attempt,
      })
    ).toMatchObject({ status: 'rejected', reason: 'publication-revision-changed' });
  });
});

describe('genomic layer publication reconciliation', () => {
  it('blocks new attempts and cancellation while a write is in flight or uncertain', () => {
    const pending = publishing();
    const uncertain = step(pending, {
      kind: 'publication-uncertain',
      request,
      reason: 'response lost',
    });
    for (const state of [pending, uncertain]) {
      expect(
        reduceGenomicLayerOperation(state, {
          kind: 'start',
          attempt: { ...attempt, id: 'mapping-2' },
        })
      ).toMatchObject({ status: 'rejected', reason: 'publication-pending' });
      expect(reduceGenomicLayerOperation(state, { kind: 'cancel', attempt })).toMatchObject({
        status: 'rejected',
        reason: 'publication-pending',
      });
    }
    expect(uncertain.publication).toBeNull();
    expect(
      step(uncertain, {
        kind: 'publication-reconciled',
        request,
        outcome: { kind: 'committed', artifact },
      })
    ).toMatchObject({ kind: 'published', publication: artifact });
  });

  it('retries a confirmed no-write failure with the original immutable request', () => {
    const ready = step(publishing(), {
      kind: 'publication-reconciled',
      request,
      outcome: { kind: 'not-committed', reason: 'destination unavailable' },
    });
    expect(ready).toMatchObject({ kind: 'prepared', retryRequest: request });
    expect(
      reduceGenomicLayerOperation(ready, {
        kind: 'publish',
        attempt,
        currentInputs: inputs,
        request: { ...request, id: 'publish-2' },
      })
    ).toMatchObject({ status: 'rejected', reason: 'retry-request-changed' });
    expect(step(ready, { kind: 'publish', attempt, currentInputs: inputs, request }).kind).toBe(
      'publishing'
    );
  });

  it('refuses collisions in the active request ID or confirmed receipt', () => {
    const collision = { ...request, candidateFingerprint: 'other-rows' };
    expect(
      reduceGenomicLayerOperation(publishing(), {
        kind: 'publication-confirmed',
        request: collision,
        artifact: { ...artifact, request: collision },
      })
    ).toMatchObject({ status: 'rejected', reason: 'publication-request-id-collision' });
    const complete = step(publishing(), { kind: 'publication-confirmed', request, artifact });
    expect(
      reduceGenomicLayerOperation(complete, {
        kind: 'publication-confirmed',
        request,
        artifact: { ...artifact, revision: 'unexpected-revision' },
      })
    ).toMatchObject({ status: 'rejected', reason: 'publication-request-id-collision' });
  });

  it.each([
    { ...artifact, artifactId: 'other-binding' },
    { ...artifact, path: '/outside/other-binding.json' },
    {
      ...artifact,
      request: { ...request, inputs: { ...inputs, mappingSpecFingerprint: 'other-recipe' } },
    },
  ])('refuses a receipt from a different artifact or input snapshot', (wrongArtifact) => {
    expect(
      reduceGenomicLayerOperation(publishing(), {
        kind: 'publication-confirmed',
        request,
        artifact: wrongArtifact,
      })
    ).toMatchObject({ status: 'rejected', reason: 'invalid-publication-receipt' });
  });

  it('ignores an unrelated older publication response', () => {
    expect(
      reduceGenomicLayerOperation(publishing(), {
        kind: 'publication-confirmed',
        request: { ...request, id: 'old-request' },
        artifact,
      })
    ).toMatchObject({ status: 'ignored', reason: 'obsolete-publication' });
  });

  it('requires fresh inspection after a publication conflict', () => {
    const failed = step(publishing(), {
      kind: 'publication-reconciled',
      request,
      outcome: {
        kind: 'conflict',
        currentRevision: 'external-revision',
        reason: 'binding was externally changed',
      },
    });
    expect(failed).toMatchObject({
      kind: 'failed',
      stage: 'publication',
      currentPublicationRevision: 'external-revision',
    });
    expect(
      reduceGenomicLayerOperation(failed, {
        kind: 'publish',
        attempt,
        currentInputs: inputs,
        request,
      })
    ).toMatchObject({ status: 'rejected', reason: 'not-prepared' });
  });

  it('interrupts preparation across owner replacement and ignores the disposed owner response', () => {
    const recovered = recoverGenomicLayerOperation(preparing(), 'owner-2');
    expect(recovered).toMatchObject({ kind: 'interrupted', reason: 'owner-restarted' });
    expect(
      reduceGenomicLayerOperation(recovered, { kind: 'prepared', attempt, candidate })
    ).toMatchObject({ status: 'ignored', reason: 'obsolete-attempt' });
    const replacement = { ...attempt, id: 'mapping-2', ownerGeneration: 'owner-2' };
    expect(step(recovered, { kind: 'start', attempt: replacement }).kind).toBe('preparing');
  });

  it('reconciles the original publication after owner replacement without a view or fresh request', () => {
    const recovered = recoverGenomicLayerOperation(publishing(), 'owner-2');
    expect(recovered).toMatchObject({
      kind: 'publication-uncertain',
      request,
      ownerGeneration: 'owner-2',
    });
    expect(step(recovered, { kind: 'publication-confirmed', request, artifact })).toMatchObject({
      kind: 'published',
      publication: artifact,
    });
    const ready = step(recovered, {
      kind: 'publication-reconciled',
      request,
      outcome: { kind: 'not-committed', reason: 'native owner confirms no write' },
    });
    const adopted = { ...attempt, ownerGeneration: 'owner-2' };
    expect(
      step(ready, { kind: 'publish', attempt: adopted, currentInputs: inputs, request }).kind
    ).toBe('publishing');
  });
});

describe('genomic layer binding validity', () => {
  it('derives current or stale status without changing the historical publication', () => {
    const original = structuredClone(artifact);
    expect(
      genomicLayerBindingValidity(artifact, { dataset: inputs.dataset, target: inputs.target })
    ).toEqual({ kind: 'current' });
    expect(
      genomicLayerBindingValidity(artifact, {
        dataset: { ...inputs.dataset, fingerprint: 'dataset-v2' },
        target: {
          ...inputs.target,
          sequenceFingerprint: 'sequence-v2',
          annotationFingerprint: 'annotations-v2',
        },
      })
    ).toEqual({
      kind: 'stale',
      reasons: ['dataset-changed', 'sequence-changed', 'annotations-changed'],
    });
    expect(artifact).toEqual(original);
  });

  it('does not invalidate position-only mappings when unrelated annotations change', () => {
    const positional = {
      ...artifact,
      request: {
        ...request,
        inputs: {
          ...inputs,
          target: {
            documentKey: inputs.target.documentKey,
            sequenceFingerprint: inputs.target.sequenceFingerprint,
          },
        },
      },
    };
    expect(
      genomicLayerBindingValidity(positional, {
        dataset: inputs.dataset,
        target: { ...inputs.target, annotationFingerprint: 'annotations-v2' },
      })
    ).toEqual({ kind: 'current' });
  });

  it('distinguishes unavailable inputs from known changed inputs', () => {
    expect(genomicLayerBindingValidity(artifact, { dataset: null, target: null })).toEqual({
      kind: 'unavailable',
      reasons: ['dataset-unavailable', 'target-unavailable'],
    });
    expect(
      genomicLayerBindingValidity(artifact, {
        dataset: inputs.dataset,
        target: {
          documentKey: inputs.target.documentKey,
          sequenceFingerprint: inputs.target.sequenceFingerprint,
        },
      })
    ).toEqual({ kind: 'unavailable', reasons: ['annotations-unavailable'] });
  });
});
