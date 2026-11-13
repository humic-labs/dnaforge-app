import type {
  AnnotatedSequence,
  Annotation,
  AnnotationColorMode,
  Selection,
  WorkspaceEditorConfig,
} from '@waypoint/workspace-editor';
import type { ParsedPlasmid, PlasmidFeature } from '@waypoint/plasmid-viewer';

export type {
  AnnotatedSequence,
  Annotation,
  Selection,
  WorkspaceEditorConfig,
  ParsedPlasmid,
  PlasmidFeature,
};

export interface SequenceTabProps {
  filePath: string;
  initialHighlight?: HighlightRegion;
}

export interface AnnotationDraft {
  type: string;
  name: string;
  start: number;
  end: number;
  direction: 1 | -1 | 0;
  color?: string;
  qualifiers?: Record<string, string[]>;
}

export interface HighlightRegion {
  id: string;
  start: number;
  end: number;
  wraps?: boolean;
  color?: string;
  label?: string;
  source: 'ai' | 'search' | 'user';
}

export interface ViewerConfig {
  showAnnotations: boolean;
  showTranslation: boolean;
  showReverseComplement: boolean;
  showPrimers: boolean;
  showCutSites: boolean;
  showResidueNumbers: boolean;
  zoomLevel: number;
  annotationColorMode: AnnotationColorMode;
}

export const DEFAULT_VIEWER_CONFIG: ViewerConfig = {
  showAnnotations: true,
  showTranslation: true,
  showReverseComplement: true,
  showPrimers: true,
  showCutSites: false,
  showResidueNumbers: false,
  zoomLevel: 100,
  annotationColorMode: 'auto-type',
};

export interface AnnotationData {
  id: string;
  name: string;
  type: string;
  start: number;
  end: number;
  strand: 'forward' | 'reverse' | 'none';
  color?: string;
  qualifiers?: Record<string, string[]>;
  segments?: Array<{ start: number; end: number }>;
}

export interface SequenceTabHandle {
  highlightRegion: (region: Omit<HighlightRegion, 'id'>) => void;
  clearHighlights: () => void;
  scrollToPosition: (position: number) => void;
}

export * from './annotation-review-types';
