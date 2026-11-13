import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { AnnotationStateIdentity } from '@waypoint/workspace-editor';
import {
  NONE as SELECTION_NONE,
  selectionReducer,
  type SelectionRange,
  type SelectionState,
} from '../selection-state';
import { viewerSelectionForAnnotationBoundaryState } from '../annotation-boundaries';
import { observeWorkflowAction } from '../../../lib/workflow-telemetry';
import { createSequenceSelectionPreviewStore } from './sequence-selection-preview';

interface SequenceSelectionProjector {
  position(position: number | null): number | null;
  selection(selection: SelectionRange): SelectionRange;
}

interface SelectionPreviewTarget {
  setSelection?: (start: number | null, end: number | null, wraps?: boolean) => void;
}

interface UseSequenceSelectionStateInput {
  entityId?: string;
  selectionSourceIdentity?: string;
  sequenceViewToSource: SequenceSelectionProjector;
  minimapRef: RefObject<SelectionPreviewTarget | null>;
  onSelectionChange?: (range: SelectionRange | null) => void;
  onCursorChange?: (position: number | null) => void;
  onSelectionStateChange?: (state: SelectionState) => void;
}

export function useSequenceSelectionState({
  entityId,
  selectionSourceIdentity,
  sequenceViewToSource,
  minimapRef,
  onSelectionChange,
  onCursorChange,
  onSelectionStateChange,
}: UseSequenceSelectionStateInput) {
  const [selectionPreviewStore] = useState(createSequenceSelectionPreviewStore);
  const [selectionSource, setSelectionSource] = useState<'before' | 'after'>('after');
  useEffect(() => {
    selectionPreviewStore.set(undefined);
    setSelectionSource('after');
    dispatchSelection({ type: 'clear' });
  }, [selectionSourceIdentity, selectionPreviewStore]);
  const [selection, dispatchSelection] = useReducer(selectionReducer, SELECTION_NONE);
  const selectionRef = useRef<SelectionState>(selection);
  const [selectedAnnotation, setSelectedAnnotation] = useState<AnnotationStateIdentity | null>(
    null
  );
  const selectedAnnotationRef = useRef<AnnotationStateIdentity | null>(selectedAnnotation);

  const viewCursor = selection.kind === 'cursor' ? selection.position : null;
  const highlightedRange = useMemo(
    (): SelectionRange | null =>
      selection.kind === 'range'
        ? { start: selection.start, end: selection.end, wraps: selection.wraps }
        : null,
    [selection]
  );

  const setViewCursor = useCallback(
    (position: number | null) => {
      if (position == null) {
        dispatchSelection({ type: 'clearCursor' });
      } else {
        selectionPreviewStore.set(undefined);
        dispatchSelection({ type: 'setCursor', position });
      }
    },
    [selectionPreviewStore]
  );

  const setHighlightedRange = useCallback(
    (range: SelectionRange | null) => {
      selectionPreviewStore.set(undefined);
      if (range == null) {
        dispatchSelection({ type: 'clearRange' });
      } else {
        dispatchSelection({ type: 'setRange', range });
      }
    },
    [selectionPreviewStore]
  );

  const clearSequenceSelection = useCallback(() => {
    selectionPreviewStore.set(undefined);
    dispatchSelection({ type: 'clear' });
  }, [selectionPreviewStore]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    selectedAnnotationRef.current = selectedAnnotation;
  }, [selectedAnnotation]);

  useEffect(() => {
    if (!entityId) return;
    const w = window as Window & {
      __test?: {
        sequenceSelection?: Record<
          string,
          {
            getSelection: () => SelectionState;
            setSelection: (selection: SelectionState) => void;
            getSelectedAnnotation: () => AnnotationStateIdentity | null;
          }
        >;
      };
    };
    if (!w.__test) return;

    if (!w.__test.sequenceSelection) w.__test.sequenceSelection = {};
    w.__test.sequenceSelection[entityId] = {
      getSelection: () => selectionRef.current,
      getSelectedAnnotation: () => selectedAnnotationRef.current,
      setSelection: (nextSelection: SelectionState) => {
        selectionPreviewStore.set(undefined);
        if (nextSelection.kind === 'none') {
          dispatchSelection({ type: 'clear' });
        } else if (nextSelection.kind === 'cursor') {
          dispatchSelection({ type: 'setCursor', position: nextSelection.position });
        } else {
          dispatchSelection({
            type: 'setRange',
            range: {
              start: nextSelection.start,
              end: nextSelection.end,
              wraps: nextSelection.wraps,
            },
          });
        }
        setSelectedAnnotation(null);
      },
    };

    return () => {
      delete w.__test?.sequenceSelection?.[entityId];
    };
  }, [entityId, selectionPreviewStore]);

  const handleSequenceHighlightedRangeChange = useCallback(
    (range: SelectionRange | null) => {
      setHighlightedRange(range);
      if (range) {
        setViewCursor(null);
        setSelectedAnnotation(null);

        observeWorkflowAction({
          workflow: 'selection',
          action: 'select',
          status: 'selected',
          selectedCount: 1,
        });
      }
    },
    [setHighlightedRange, setViewCursor]
  );

  const handleSequenceHighlightedRangePreview = useCallback(
    (range: SelectionRange | null) => {
      selectionPreviewStore.set(range);
      const minimap = minimapRef.current;
      if (!minimap?.setSelection) return;
      minimap.setSelection(range?.start ?? null, range?.end ?? null, range?.wraps);
    },
    [minimapRef, selectionPreviewStore]
  );

  useEffect(() => {
    const selectionForParent = viewerSelectionForAnnotationBoundaryState(highlightedRange);
    onSelectionChange?.(
      selectionForParent ? sequenceViewToSource.selection(selectionForParent) : null
    );
  }, [highlightedRange, onSelectionChange, sequenceViewToSource]);

  useEffect(() => {
    onCursorChange?.(sequenceViewToSource.position(viewCursor));
  }, [viewCursor, onCursorChange, sequenceViewToSource]);

  useEffect(() => {
    onSelectionStateChange?.(selection);
  }, [selection, onSelectionStateChange]);

  return {
    selection,
    selectionPreviewStore,
    selectionSource,
    setSelectionSource,
    dispatchSelection,
    viewCursor,
    highlightedRange,
    selectedAnnotation,
    setSelectedAnnotation,
    setViewCursor,
    setHighlightedRange,
    clearSequenceSelection,
    handleSequenceHighlightedRangeChange,
    handleSequenceHighlightedRangePreview,
  };
}
