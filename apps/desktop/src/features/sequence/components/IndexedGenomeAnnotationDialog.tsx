import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import type { Annotation } from '@waypoint/sequence-utils';

import type { IndexedGenomeUserAnnotation } from '../../../shared/indexed-genome';
import { AnnotationAddForm } from './annotations-drawer/AnnotationAddForm';
import { AnnotationEditForm } from './annotations-drawer/AnnotationEditForm';

export type IndexedGenomeAnnotationDialogState =
  | {
      kind: 'add';
      chrom: string;
      range: { start: number; end: number };
      sequenceLength: number;
    }
  | {
      kind: 'edit';
      value: IndexedGenomeUserAnnotation;
      sequenceLength: number;
    };

export function IndexedGenomeAnnotationDialog({
  state,
  allAnnotations,
  onSaveNew,
  onSaveEdit,
  onDelete,
  onCancel,
}: {
  state: IndexedGenomeAnnotationDialogState | null;
  allAnnotations: Annotation[];
  onSaveNew: (chrom: string, annotation: Annotation) => void;
  onSaveEdit: (value: IndexedGenomeUserAnnotation, annotation: Annotation) => void;
  onDelete: (value: IndexedGenomeUserAnnotation) => void;
  onCancel: () => void;
}) {
  const presentationOverlay = usePresentationOverlay('modal');

  if (!state) return null;
  const chrom = state.kind === 'add' ? state.chrom : state.value.chrom;
  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      data-testid="indexed-annotation-dialog-backdrop"
      onMouseDown={onCancel}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="indexed-annotation-dialog-title"
          data-testid="indexed-annotation-dialog"
          className="mx-4 w-full max-w-lg overflow-hidden rounded-lg border border-border bg-bg-subtle shadow-xl"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="border-b border-border px-4 py-3">
            <h3 id="indexed-annotation-dialog-title" className="text-sm font-semibold text-fg">
              {state.kind === 'add' ? 'Add annotation' : 'Edit annotation'}
            </h3>
            <div className="mt-0.5 text-xs text-fg-muted">User overlay on {chrom}</div>
          </div>
          {state.kind === 'add' ? (
            <AnnotationAddForm
              key={`add:${state.chrom}:${state.range.start}:${state.range.end}`}
              allAnnotations={allAnnotations}
              sequenceLength={state.sequenceLength}
              initialRange={state.range}
              highlightSelectionRange={state.range}
              onSave={(annotation) => onSaveNew(state.chrom, annotation)}
              onCancel={onCancel}
            />
          ) : (
            <AnnotationEditForm
              key={`edit:${state.value.id}`}
              annotation={state.value.annotation}
              allAnnotations={allAnnotations}
              sequenceLength={state.sequenceLength}
              onSave={(patch) =>
                onSaveEdit(state.value, {
                  ...state.value.annotation,
                  ...patch,
                })
              }
              onDelete={() => onDelete(state.value)}
              onCancel={onCancel}
            />
          )}
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}
