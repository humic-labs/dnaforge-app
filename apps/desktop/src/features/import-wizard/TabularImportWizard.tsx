import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../presentation/PresentationSurface';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, UI_CARD_CLASS } from '../../components/ui';
import { safeFocus } from '../../shared/utils/safeFocus';
import {
  formatResolveHeadline,
  formatReviewHeadline,
  summarizeResolveWorklist,
  summarizeReviewReconciliation,
  type TabularImportEntry,
} from './tabular-import';

interface Props {
  entries: TabularImportEntry[];
  onConfirm: (entries: TabularImportEntry[]) => void;
  onCancel: () => void;
}

type Step = 'resolve' | 'review';

export function TabularImportWizard({ entries, onConfirm, onCancel }: Props) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const [step, setStep] = useState<Step>('resolve');
  const confirmRef = useRef<HTMLButtonElement>(null);

  const worklist = useMemo(() => summarizeResolveWorklist(entries), [entries]);
  const review = useMemo(() => summarizeReviewReconciliation(entries), [entries]);

  const canConfirm = review.register > 0;

  useEffect(() => {
    safeFocus(confirmRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    presentationEvents.add(document, 'keydown', onKey);
    return () => presentationEvents.remove(document, 'keydown', onKey);
  }, [onCancel, presentationEvents]);

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      data-testid="tabular-import-backdrop"
      onMouseDown={onCancel}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tabular-import-title"
          data-testid="tabular-import-wizard"
          data-step={step}
          className="mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-bg-subtle p-4 shadow-xl"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <h3 id="tabular-import-title" className="text-sm font-semibold text-fg">
              Import to registry
            </h3>
            <ol className="flex items-center gap-2 text-xs text-fg-muted" aria-label="steps">
              <li
                data-active={step === 'resolve'}
                className="data-[active=true]:font-semibold data-[active=true]:text-fg"
              >
                1 · Resolve
              </li>
              <li aria-hidden>→</li>
              <li
                data-active={step === 'review'}
                className="data-[active=true]:font-semibold data-[active=true]:text-fg"
              >
                2 · Review
              </li>
            </ol>
          </div>

          {step === 'resolve' ? (
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
              <p data-testid="tabular-resolve-headline" className="text-sm text-fg">
                {formatResolveHeadline(worklist)}
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {worklist.items.map((item) => (
                  <li
                    key={item.fileName}
                    data-testid="tabular-resolve-item"
                    data-status={item.status}
                    className={`${UI_CARD_CLASS} flex flex-col text-xs`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-fg">{item.fileName}</span>
                      <span className={item.status === 'ready' ? 'text-success' : 'text-warning'}>
                        {item.status === 'ready'
                          ? `${item.recordCount} ${item.detectedKind.replace(/_/g, ' ')} · ready`
                          : 'needs you'}
                      </span>
                    </div>
                    {item.reasons.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 text-fg-muted">
                        {item.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
              <p data-testid="tabular-review-headline" className="text-sm text-fg">
                {formatReviewHeadline(review)}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-fg-muted">
                <dt>Register</dt>
                <dd data-testid="review-register" className="text-right text-fg">
                  {review.register}
                </dd>
                <dt>Duplicate (skip)</dt>
                <dd data-testid="review-duplicate" className="text-right text-fg">
                  {review.duplicate}
                </dd>
                <dt>Flagged</dt>
                <dd data-testid="review-flagged" className="text-right text-fg">
                  {review.flagged}
                </dd>
                <dt>Cannot parse</dt>
                <dd data-testid="review-cannot-parse" className="text-right text-fg">
                  {review.cannotParse}
                </dd>
                <dt className="border-t border-border pt-1 font-medium text-fg">
                  Total input rows
                </dt>
                <dd
                  data-testid="review-total"
                  className="border-t border-border pt-1 text-right font-medium text-fg"
                >
                  {review.totalRows}
                </dd>
              </dl>
              <p className="mt-2 text-xs text-fg-muted">
                Every input row resolves to exactly one disposition; nothing is written until you
                confirm, and one Undo reverses the whole batch.
              </p>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button type="button" data-testid="tabular-import-cancel" onClick={onCancel}>
              Cancel
            </Button>
            {step === 'resolve' ? (
              <Button
                ref={confirmRef}
                type="button"
                data-testid="tabular-to-review"
                onClick={() => setStep('review')}
                disabled={!canConfirm}
                aria-disabled={!canConfirm}
                variant="primary"
              >
                Review {review.register} entit{review.register === 1 ? 'y' : 'ies'} →
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  data-testid="tabular-back-to-resolve"
                  onClick={() => setStep('resolve')}
                >
                  ← Back
                </Button>
                <Button
                  ref={confirmRef}
                  type="button"
                  data-testid="tabular-import-confirm"
                  onClick={() => canConfirm && onConfirm(entries)}
                  disabled={!canConfirm}
                  aria-disabled={!canConfirm}
                  variant="primary"
                >
                  Import {review.register} to registry
                </Button>
              </>
            )}
          </div>
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}
