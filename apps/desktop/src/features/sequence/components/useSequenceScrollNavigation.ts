import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  AnnotationStateIdentity,
  ScrollToBiologicalPositionOptions,
  SequenceScrollPresentation,
  WorkspaceEditorHandle,
} from '@waypoint/workspace-editor';
import type { Annotation } from '@waypoint/sequence-utils';
import type { SelectionRange } from '../selection-state';
import type { SequenceViewMode } from './SequenceViewerModeToggle';
import { findAnnotationIdentityForHighlight } from './annotation-navigation';

export type ScrollToPositionWithTimeout = (
  position: number,
  onComplete?: () => void,
  options?: {
    animate?: boolean;
    completion?: 'timer' | 'viewer';
    presentationMode?: SequenceViewMode;
    onPresented?: () => void;
    requestId?: number | string | null;
  }
) => () => void;

export interface SequenceNavigationSnapshot {
  position: number;
  mode: SequenceViewMode;
  usedImperative2d: boolean;
  hadSequenceViewerRef: boolean;
  continuousCircular: boolean;
}

interface CurrentRef<T> {
  current: T;
}

interface ScrollCommand {
  id: number;
  requestId: number | string | null;
  position: number;
  animate: boolean;
  completion: 'timer' | 'viewer';
}

interface UseSequenceScrollNavigationInput {
  sequenceViewModeRef: CurrentRef<SequenceViewMode>;
  sequenceViewerRef: CurrentRef<WorkspaceEditorHandle | null>;
  sequenceAnnotations: Annotation[];
  sequenceSurfaceVisible?: boolean;
  scrollToPositionProp?: number | null;
  sequenceNavigationRequestId?: number | string | null;
  highlightRangeProp?: SelectionRange | null;
  onScrollComplete?: () => void;
  onHighlightComplete?: () => void;
  setHighlightedRange: (range: SelectionRange | null) => void;
  setViewCursor: (position: number | null) => void;
  setSelectedAnnotation: (annotation: AnnotationStateIdentity | null) => void;

  navigateMapToPosition: (
    position: number,
    range: { start: number; end: number; wraps?: boolean } | null
  ) => void;
}

export function useSequenceScrollNavigation({
  sequenceViewModeRef,
  sequenceViewerRef,
  sequenceAnnotations,
  sequenceSurfaceVisible = false,
  scrollToPositionProp,
  sequenceNavigationRequestId,
  highlightRangeProp,
  onScrollComplete,
  onHighlightComplete,
  setHighlightedRange,
  setViewCursor,
  setSelectedAnnotation,
  navigateMapToPosition,
}: UseSequenceScrollNavigationInput) {
  const [scrollCommand, setScrollCommand] = useState<ScrollCommand | null>(null);
  const pendingScrollCommandRef = useRef<ScrollCommand | null>(null);
  const [scrollPresentation, setScrollPresentation] = useState<SequenceScrollPresentation | null>(
    null
  );
  const pendingPresentationRef = useRef<SequenceScrollPresentation | null>(null);
  const nextScrollCommandIdRef = useRef(0);
  const mountedRef = useRef(false);
  const [scrollAnimate, setScrollAnimate] = useState<boolean>(true);
  const viewerCompletionRef = useRef<(() => void) | null>(null);
  const scrollToPositionWithTimeoutRef = useRef<ScrollToPositionWithTimeout | null>(null);
  const lastSequenceNavigationRef = useRef<SequenceNavigationSnapshot | null>(null);
  const lastExternalScrollCommandRef = useRef<{
    position: number;
    requestId: number | string | null;
  } | null>(null);
  const lastExternalHighlightCommandRef = useRef<{
    range: SelectionRange;
    requestId: number | string | null;
  } | null>(null);

  const scrollToPositionWithTimeout = useCallback<ScrollToPositionWithTimeout>(
    (position, onComplete, options) => {
      const animate = options?.animate !== false;
      const completion = options?.completion ?? (sequenceSurfaceVisible ? 'viewer' : 'timer');
      const requestId = options?.requestId ?? null;
      const previous = pendingScrollCommandRef.current;
      const sameRequest =
        previous?.position === position &&
        previous.animate === animate &&
        previous.completion === completion &&
        previous.requestId === requestId;

      const command: ScrollCommand = {
        id: sameRequest ? previous.id : ++nextScrollCommandIdRef.current,
        position,
        requestId,
        animate,
        completion,
      };
      const onPresented = options?.onPresented;
      const presentationMode = options?.presentationMode ?? '2d';
      let presentation: SequenceScrollPresentation | null = null;
      if (
        onPresented &&
        sequenceSurfaceVisible &&
        sequenceViewModeRef.current === presentationMode
      ) {
        const admitted: SequenceScrollPresentation = {
          position,
          presented: () => {
            if (!mountedRef.current || pendingPresentationRef.current !== admitted) return;
            if (sequenceViewModeRef.current !== presentationMode) {
              pendingPresentationRef.current = null;
              setScrollPresentation(null);
              return;
            }
            pendingPresentationRef.current = null;
            setScrollPresentation(null);
            onPresented();
          },
        };
        presentation = admitted;
      }
      pendingPresentationRef.current = presentation;
      setScrollPresentation(presentation);
      pendingScrollCommandRef.current = command;
      viewerCompletionRef.current = onComplete ?? null;
      setScrollAnimate(animate);
      setScrollCommand(command);
      return () => {
        if (presentation && pendingPresentationRef.current === presentation) {
          pendingPresentationRef.current = null;
          setScrollPresentation(null);
        }
        if (pendingScrollCommandRef.current !== command) return;
        pendingScrollCommandRef.current = null;
        viewerCompletionRef.current = null;
        setScrollCommand(null);
      };
    },
    [sequenceSurfaceVisible, sequenceViewModeRef]
  );

  const completeScrollCommand = useCallback((commandId: number) => {
    if (!mountedRef.current || pendingScrollCommandRef.current?.id !== commandId) return;
    pendingScrollCommandRef.current = null;
    const onComplete = viewerCompletionRef.current;
    viewerCompletionRef.current = null;
    setScrollCommand(null);
    onComplete?.();
  }, []);

  const scrollCommandId = scrollCommand?.id ?? null;
  const scrollCompletion = scrollCommand?.completion;
  const onScrollToPositionComplete = useCallback(() => {
    if (scrollCommandId !== null && scrollCompletion === 'viewer') {
      completeScrollCommand(scrollCommandId);
    }
  }, [completeScrollCommand, scrollCommandId, scrollCompletion]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingPresentationRef.current = null;
    };
  }, []);

  const presentationSurfaceVisible = sequenceSurfaceVisible && sequenceViewModeRef.current === '2d';
  useLayoutEffect(() => {
    if (presentationSurfaceVisible) return;
    pendingPresentationRef.current = null;
    setScrollPresentation(null);
  }, [presentationSurfaceVisible]);

  useEffect(() => {
    if (scrollCommand?.completion !== 'timer') return;
    const timeout = setTimeout(
      () => completeScrollCommand(scrollCommand.id),
      scrollCommand.animate ? 200 : 0
    );
    return () => clearTimeout(timeout);
  }, [completeScrollCommand, scrollCommand]);

  const scrollActiveSequenceViewerToBiologicalPosition = useCallback(
    (position: number, options?: ScrollToBiologicalPositionOptions) => {
      const mode = sequenceViewModeRef.current;
      const sequenceViewer = sequenceViewerRef.current;
      lastSequenceNavigationRef.current = {
        position,
        mode,
        usedImperative2d: mode === '2d' && !!sequenceViewer,
        hadSequenceViewerRef: !!sequenceViewer,
        continuousCircular: options?.continuousCircular === true,
      };
      if (mode === '2d' && sequenceViewer) {
        sequenceViewer.scrollToBiologicalPosition(position, options);
        return;
      }
      scrollToPositionWithTimeout(
        position,
        undefined,
        options?.animate === undefined ? undefined : { animate: options.animate }
      );
    },
    [scrollToPositionWithTimeout, sequenceViewModeRef, sequenceViewerRef]
  );

  scrollToPositionWithTimeoutRef.current = scrollToPositionWithTimeout;

  useLayoutEffect(() => {
    if (scrollToPositionProp == null) {
      lastExternalScrollCommandRef.current = null;
      return;
    }

    const requestId = sequenceNavigationRequestId ?? null;
    const previous = lastExternalScrollCommandRef.current;
    const alreadyHandled =
      requestId != null
        ? previous?.requestId === requestId
        : previous?.requestId == null && previous?.position === scrollToPositionProp;
    if (alreadyHandled) return;

    lastExternalScrollCommandRef.current = { position: scrollToPositionProp, requestId };
    scrollToPositionWithTimeout(scrollToPositionProp, onScrollComplete, {
      completion: sequenceSurfaceVisible ? 'viewer' : 'timer',
      requestId,
    });
    navigateMapToPosition(scrollToPositionProp, highlightRangeProp ?? null);
  }, [
    highlightRangeProp,
    navigateMapToPosition,
    onScrollComplete,
    scrollToPositionProp,
    scrollToPositionWithTimeout,
    sequenceSurfaceVisible,
    sequenceNavigationRequestId,
  ]);

  useLayoutEffect(() => {
    if (highlightRangeProp == null) {
      lastExternalHighlightCommandRef.current = null;
      return;
    }
    const requestId = sequenceNavigationRequestId ?? null;
    const previous = lastExternalHighlightCommandRef.current;
    const alreadyHandled =
      previous?.requestId === requestId && previous?.range === highlightRangeProp;
    if (alreadyHandled) return;

    lastExternalHighlightCommandRef.current = { range: highlightRangeProp, requestId };
    setHighlightedRange({
      start: highlightRangeProp.start,
      end: highlightRangeProp.end,
      wraps: highlightRangeProp.wraps,
    });
    setViewCursor(null);
    setSelectedAnnotation(
      findAnnotationIdentityForHighlight(sequenceAnnotations, highlightRangeProp)
    );

    if (scrollToPositionProp == null) {
      navigateMapToPosition(0, highlightRangeProp);
    }
    onHighlightComplete?.();
  }, [
    highlightRangeProp,
    navigateMapToPosition,
    onHighlightComplete,
    scrollToPositionProp,
    sequenceAnnotations,
    sequenceNavigationRequestId,
    setHighlightedRange,
    setSelectedAnnotation,
    setViewCursor,
  ]);

  return {
    scrollToPosition: scrollCommand?.position ?? null,
    scrollCommandId,
    scrollCommandRequestId: scrollCommand?.requestId ?? null,
    scrollAnimate,
    scrollPresentation,
    scrollToPositionWithTimeout,
    scrollToPositionWithTimeoutRef,
    onScrollToPositionComplete,
    scrollActiveSequenceViewerToBiologicalPosition,
    lastSequenceNavigationRef,
  };
}
