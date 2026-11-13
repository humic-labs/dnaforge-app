import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useState } from 'react';
import { platform } from '../../../../platform';
import { LIMS_OLIGO_USES } from '../../../../shared/lims';
import type {
  ApplyOligoClassificationRequest,
  AppliedOligoClassification,
  OligoClassificationReview,
} from '../../../../shared/oligo-classification';

type Review = Extract<OligoClassificationReview, { status: 'review' }>;
type State =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'load_error'; message: string }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'review';
      review: Review;
      selection: 'keep_generic' | 'classify' | null;
      use: (typeof LIMS_OLIGO_USES)[number] | null;
      note: string | null;
    }
  | { kind: 'saving'; request: ApplyOligoClassificationRequest }
  | { kind: 'save_error'; request: ApplyOligoClassificationRequest; message: string }
  | { kind: 'saved'; result: AppliedOligoClassification; refreshError: boolean };

export function RegistryClassificationReview({
  entityId,
  eligible = true,
  disabled,
  onApplied,
}: {
  entityId: string;
  eligible?: boolean;
  disabled: boolean;
  onApplied: () => void | Promise<void>;
}) {
  const [state, setState] = useState<State>({ kind: 'closed' });
  const [visibleEvidence, setVisibleEvidence] = useState(20);
  const showReview = (review: OligoClassificationReview, note: string | null = null) => {
    setVisibleEvidence(20);
    setState(
      review.status === 'unavailable'
        ? { kind: 'unavailable', reason: review.reason }
        : {
            kind: 'review',
            review,
            selection: null,
            use: review.assessment.status === 'suggested' ? review.assessment.use : null,
            note,
          }
    );
  };
  const load = async () => {
    setState({ kind: 'loading' });
    try {
      showReview(await platform().lims.reviewClassification(entityId));
    } catch (error) {
      setState({ kind: 'load_error', message: toUserMessage(message(error), 'operation.failed') });
    }
  };
  const apply = async (request: ApplyOligoClassificationRequest) => {
    setState({ kind: 'saving', request });
    let result;
    try {
      result = await platform().lims.applyClassification(request);
    } catch (error) {
      setState({
        kind: 'save_error',
        request,
        message: toUserMessage(message(error), 'operation.failed'),
      });
      return;
    }
    if (result.status === 'stale') {
      showReview(
        result.review,
        'The record or evidence changed. Review the current information and choose again.'
      );
      return;
    }
    setState({ kind: 'saved', result, refreshError: false });
    try {
      await onApplied();
    } catch {
      setState({ kind: 'saved', result, refreshError: true });
    }
  };
  const save = () => {
    if (state.kind !== 'review' || !state.selection) return;
    void apply({
      entityId,
      reviewToken: state.review.reviewToken,
      requestId: crypto.randomUUID(),
      choice:
        state.selection === 'keep_generic'
          ? { kind: 'keep_generic' }
          : { kind: 'classify', use: state.use },
    });
  };
  const button =
    'rounded border border-border px-2.5 py-1.5 text-xs font-medium text-fg hover:bg-bg-subtle disabled:opacity-50';
  if (!eligible && (state.kind === 'closed' || (state.kind === 'saved' && !state.refreshError)))
    return null;
  if (state.kind === 'closed')
    return (
      <button type="button" className={button} disabled={disabled} onClick={() => void load()}>
        Review classification
      </button>
    );
  return (
    <section
      className="space-y-3 rounded border border-border bg-bg-subtle p-3 text-xs"
      aria-label="Sequence classification"
      data-testid="registry-classification-review"
    >
      <h3 className="font-semibold text-fg">Sequence classification</h3>
      {state.kind === 'loading' && <p role="status">Reading sequence and source evidence…</p>}
      {state.kind === 'load_error' && (
        <>
          <p role="alert">{toUserMessage(state.message, 'account.failed')}</p>
          <button type="button" className={button} onClick={() => void load()} disabled={disabled}>
            Try review again
          </button>
        </>
      )}
      {state.kind === 'unavailable' && (
        <>
          <p>{unavailableReason(state.reason)}</p>
          <button type="button" className={button} onClick={() => void load()} disabled={disabled}>
            Refresh review
          </button>
        </>
      )}
      {state.kind === 'saving' && <p role="status">Saving your choice…</p>}
      {state.kind === 'save_error' && (
        <>
          <p role="alert">
            Could not confirm the save. Retry the same choice to check or finish it.
          </p>
          <p className="text-fg-muted">{toUserMessage(state.message, 'account.failed')}</p>
          <button
            type="button"
            className={button}
            onClick={() => void apply(state.request)}
            disabled={disabled}
          >
            Retry saved choice
          </button>
        </>
      )}
      {state.kind === 'saved' && (
        <p role="status">
          Choice saved.{state.refreshError ? ' Close and reopen Registry to refresh the view.' : ''}
        </p>
      )}
      {state.kind === 'review' && (
        <>
          {state.note && (
            <p role="status" className="text-warning">
              {state.note}
            </p>
          )}
          <p className="text-fg">
            {state.review.assessment.status === 'suggested'
              ? userMessageWithValues('notice.source-suggests-value-oligo-used-as-value', {
                  value0: userMessageValue(
                    state.review.sequence.molecule === 'rna' ? 'RNA' : 'DNA'
                  ),
                  value1: userMessageValue(state.review.assessment.use),
                })
              : toUserMessage(reviewReason(state.review.assessment.reason), 'operation.failed')}
          </p>
          <p className="text-fg-muted">
            {state.review.sequence.length} bases, linear{' '}
            {state.review.sequence.molecule.toUpperCase()}. This choice keeps the same sequence file
            and registry ID.
          </p>
          <details className="text-fg-muted">
            <summary className="cursor-pointer">
              Original export evidence ({state.review.evidence.length})
            </summary>
            <p className="my-2">
              These are statements from the original Benchling export, not biological verification.
            </p>
            <ul className="space-y-2">
              {state.review.evidence.slice(0, visibleEvidence).map((fact, index) => (
                <li
                  key={`${fact.sourceObjectId}:${fact.occurrence}:${fact.channel}:${index}`}
                  className="break-words border-l-2 border-border pl-2"
                >
                  <p>
                    {fact.channel === 'provider_display_type'
                      ? `Benchling display type: ${fact.value}`
                      : fact.channel === 'authored_role'
                        ? `Source role: ${fact.excerpt}`
                        : `Disputed role: ${fact.excerpt}`}
                  </p>
                  <p className="text-[11px]">{fact.sourceEntryPath}</p>
                </li>
              ))}
            </ul>
            {state.review.evidence.length > visibleEvidence && (
              <button
                type="button"
                className={`${button} mt-2`}
                onClick={() => setVisibleEvidence((count) => count + 20)}
              >
                Show more evidence
              </button>
            )}
            {state.review.evidenceLimited && (
              <p className="mt-2">Some evidence could not be fully assessed.</p>
            )}
          </details>
          <fieldset disabled={disabled} className="space-y-2">
            <legend className="mb-2 font-medium text-fg">Choose the type</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`classification-${entityId}`}
                checked={state.selection === 'keep_generic'}
                onChange={() => setState({ ...state, selection: 'keep_generic' })}
              />
              Keep as {state.review.sequence.molecule.toUpperCase()} sequence
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`classification-${entityId}`}
                checked={state.selection === 'classify'}
                onChange={() => setState({ ...state, selection: 'classify' })}
              />
              Classify as {state.review.sequence.molecule.toUpperCase()} oligo
            </label>
            {state.selection === 'classify' && (
              <label className="flex items-center gap-2 pl-5">
                Use
                <select
                  aria-label="Oligo use"
                  className="rounded border border-border bg-bg px-2 py-1"
                  value={state.use ?? ''}
                  onChange={(event) => {
                    const selected = event.target.value;
                    setState({
                      ...state,
                      use: LIMS_OLIGO_USES.find((use) => use === selected) ?? null,
                    });
                  }}
                >
                  <option value="">Not specified</option>
                  {LIMS_OLIGO_USES.map((use) => (
                    <option key={use} value={use}>
                      {use}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
          <div className="flex gap-2">
            <button
              type="button"
              className={button}
              disabled={disabled || !state.selection}
              onClick={save}
            >
              Save choice
            </button>
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={() => setState({ kind: 'closed' })}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function reviewReason(
  reason: Extract<Review['assessment'], { status: 'needs_review' }>['reason']
): string {
  switch (reason) {
    case 'disputed_role':
      return 'Source statements question or contradict the role.';
    case 'conflicting_roles':
      return 'Source statements describe different uses. Choose the type and use yourself.';
    case 'conflicting_types':
      return 'The export contains conflicting type labels.';
    case 'incomplete_evidence':
      return 'Some source evidence could not be assessed. No classification is suggested.';
    case 'mixed_targets':
      return 'Source references do not agree on the target. No classification is suggested.';
    case 'insufficient_evidence':
      return 'There is not enough source evidence to suggest an oligo. Choose only if you know what this sequence represents.';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
function unavailableReason(reason: string): string {
  switch (reason) {
    case 'circular_sequence':
      return 'This sequence is circular. Oligo classification requires a linear sequence.';
    case 'missing_sequence':
      return 'The sequence file is missing, empty, or unreadable. Restore it and refresh the review.';
    case 'multiple_sequences':
      return 'This file contains several sequences. Review a single sequence file instead.';
    case 'sequence_projection_outdated':
    case 'sequence_binding_changed':
      return 'The sequence file changed. Reopen the project, then refresh this review.';
    case 'conflicting_molecule':
      return 'The file disagrees with the DNA/RNA record type. Resolve that mismatch before classification.';
    case 'archived_sequence':
      return 'Restore the archived sequence before reviewing its classification.';
    case 'not_generic_sequence':
      return 'This record is already a specialized type.';
    case 'ambiguous_source_identity':
      return 'The export does not identify one exact Benchling sequence for this record.';
    case 'desktop_required':
      return 'Open this project in the desktop app to review classification.';
    default:
      return 'Classification requires an active sequence in a native imported project.';
  }
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The classification request could not be completed.';
}
