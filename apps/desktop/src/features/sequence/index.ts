export {
  WorkspaceViewer,
  SequenceToolbarSidebar,
  SequenceTab,
  SequenceErrorBoundary,
  SequenceSkeleton,
} from './components';

export {
  useSequence,
  useHighlight,
  requestHighlight,
  onHighlightRequest,
  createHighlight,
} from './hooks';

export { useSequenceStore } from './store';

export {
  useSequenceViewState,
  type SequenceViewStatePatchFn,
} from './view-state/useSequenceViewState';
export {
  DEFAULT_SEQUENCE_VIEW_STATE,
  type SequenceViewState,
  type SequenceViewStatePatch,
  type SequenceCanvasMode,
  type SequenceDisplayToggles,
} from './view-state/sequence-view-state';

export {
  annotatedSequenceToParsedPlasmid,
  primerDisplayToMinimapPrimer,
  withPrimerDisplaysForMinimap,
  annotationDataToAnnotation,
} from './adapters';

export type {
  SequenceTabProps,
  ViewerConfig,
  HighlightRegion,
  AnnotationData,
  SequenceTabHandle,
  AnnotatedSequence,
  Annotation,
  Selection,
  WorkspaceEditorConfig,
  ParsedPlasmid,
  PlasmidFeature,
} from './types';
export { DEFAULT_VIEWER_CONFIG } from './types';
