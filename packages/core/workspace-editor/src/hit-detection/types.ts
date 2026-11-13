import type { Annotation } from '@waypoint/sequence-utils';
import type { SelectionRange } from '../selection-model';
import type { Layout2DRow, PrimerDisplay } from '../types';

export interface AlignmentModeHitOptions {
  alignedRef: string;
  alignedQuery: string;
}

export type HitTargetType =
  | 'cut-site'
  | 'gg-label'
  | 'handle'
  | 'annotation'
  | 'codon'
  | 'primer'
  | 'nucleotide'
  | 'empty';

export interface HitTargetCutSite {
  type: 'cut-site';
  cutSite: unknown;
}

export interface HitTargetGGLabel {
  type: 'gg-label';
  label: unknown;
}

export interface HitTargetHandle {
  type: 'handle';
  edge: 'start' | 'end';
  selection: SelectionRange;
}

export interface HitTargetAnnotation {
  type: 'annotation';
  annotation: Annotation;
  start: number;
  end: number;
}

export interface HitTargetCodon {
  type: 'codon';
  start: number;
  end: number;
  strand: 1 | -1;
  isOverlayClick: boolean;
  residueIndex?: number;
}

export interface HitTargetPrimer {
  type: 'primer';
  primer: PrimerDisplay;
}

export interface HitTargetNucleotide {
  type: 'nucleotide';
  position: number;
}

export interface HitTargetEmpty {
  type: 'empty';
}

export type HitTarget =
  | HitTargetCutSite
  | HitTargetGGLabel
  | HitTargetHandle
  | HitTargetAnnotation
  | HitTargetCodon
  | HitTargetPrimer
  | HitTargetNucleotide
  | HitTargetEmpty;

export interface HitDetectionConfig {
  showAnnotations: boolean;
  showTranslation: boolean;
  showPrimers: boolean;
  marginLeft: number;
  charWidth: number;
  rowHeight: number;
  showResidueNumbers?: boolean;
  cdsDetailProgress?: number;
  cdsZoomPresentation?: import('@waypoint/platform').CdsZoomPresentation;
  lodLevel?: 'detail' | 'feature' | 'density';
}

export interface HitDetectionContext {
  config: HitDetectionConfig;
  sequenceLength: number;
  currentSelection: SelectionRange | null;
  scrollTop: number;
}

export interface LineTrackBounds {
  annotationY: number;
  annotationHeight: number;
  translationY: number;
  translationHeight: number;
  forwardPrimerY: number;
  forwardPrimerHeight: number;
  sequenceY: number;
  sequenceHeight: number;
  complementY: number;
  complementHeight: number;
  reversePrimerY: number;
  reversePrimerHeight: number;
  rulerY: number;
  rulerHeight: number;
}

export interface LineAndPosition {
  line: Layout2DRow;
  lineIndex: number;
  position: number;
  mouseX: number;
  contentY: number;
}

export interface LabelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedLabel<T> {
  labelBounds: LabelBounds;
  data: T;
}
