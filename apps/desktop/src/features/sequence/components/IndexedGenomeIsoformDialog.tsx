import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import { renderUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useState } from 'react';

import type { IndexedTranscriptIsoform } from './indexed-transcript-isoforms';

export type IndexedGenomeIsoformDialogState =
  | { kind: 'loading'; transcriptName: string }
  | { kind: 'error'; message: UserMessage }
  | {
      kind: 'ready';
      isoforms: ReadonlyArray<IndexedTranscriptIsoform>;
      selectedFeatureId: string;
    };

export function IndexedGenomeIsoformDialog({
  state,
  onSelect,
  onCopy,
  onCancel,
}: {
  state: IndexedGenomeIsoformDialogState | null;
  onSelect: (isoform: IndexedTranscriptIsoform) => void;
  onCopy: (isoform: IndexedTranscriptIsoform, molecule: 'dna' | 'rna') => void;
  onCancel: () => void;
}) {
  const presentationOverlay = usePresentationOverlay('modal');

  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedFeatureId(state?.kind === 'ready' ? state.selectedFeatureId : null);
  }, [state]);

  const selectedIsoform = useMemo(
    () =>
      state?.kind === 'ready'
        ? (state.isoforms.find((isoform) => isoform.featureId === selectedFeatureId) ??
          state.isoforms[0] ??
          null)
        : null,
    [selectedFeatureId, state]
  );

  if (!state) return null;
  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      data-testid="indexed-isoform-dialog-backdrop"
      onMouseDown={onCancel}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="indexed-isoform-dialog-title"
          data-testid="indexed-isoform-dialog"
          className="mx-4 w-full max-w-lg overflow-hidden rounded-lg border border-border bg-bg-subtle shadow-xl"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="border-b border-border px-4 py-3">
            <h3 id="indexed-isoform-dialog-title" className="text-sm font-semibold text-fg">
              Choose transcript isoform
            </h3>
            <div className="mt-0.5 text-xs text-fg-muted">
              Sequence is assembled from this isoform&apos;s exon intervals only.
            </div>
          </div>

          <div className="max-h-[55vh] overflow-y-auto px-4 py-4">
            {state.kind === 'loading' ? (
              <div className="text-sm text-fg-muted">
                Loading isoforms for {state.transcriptName}…
              </div>
            ) : state.kind === 'error' ? (
              <div
                role="alert"
                className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm"
              >
                {renderUserMessage(state.message)}
              </div>
            ) : (
              <>
                {state.isoforms.length === 1 ? (
                  <div className="mb-3 text-sm text-fg-muted">
                    No alternative isoforms were found in the bounded feature closure.
                  </div>
                ) : null}
                <div role="radiogroup" aria-label="Transcript isoforms" className="space-y-2">
                  {state.isoforms.map((isoform) => (
                    <label
                      key={isoform.featureId}
                      className="flex cursor-pointer items-start gap-3 rounded border border-border px-3 py-2 wp-interactive"
                    >
                      <input
                        type="radio"
                        name="indexed-transcript-isoform"
                        checked={selectedIsoform?.featureId === isoform.featureId}
                        onChange={() => {
                          setSelectedFeatureId(isoform.featureId);
                          onSelect(isoform);
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-fg">
                          {isoform.name}
                        </span>
                        <span className="block text-xs text-fg-muted">
                          {isoform.featureId} · {isoform.chrom}:{isoform.start0 + 1}-{isoform.end0}{' '}
                          · {isoform.strand}
                          {isoform.isSelected ? ' · clicked isoform' : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5 text-sm text-fg wp-interactive"
              onClick={onCancel}
            >
              Close
            </button>
            {state.kind === 'ready' && selectedIsoform ? (
              <>
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1.5 text-sm font-medium text-fg wp-interactive"
                  onClick={() => onCopy(selectedIsoform, 'dna')}
                >
                  Copy DNA
                </button>
                <button
                  type="button"
                  className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
                  onClick={() => onCopy(selectedIsoform, 'rna')}
                >
                  Copy RNA
                </button>
              </>
            ) : null}
          </div>
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}
