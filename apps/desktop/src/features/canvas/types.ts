import type { TableDocumentReference } from '../../shared/table-document-reference';
import type {
  IndexedGenomeInitialAnnotationMapperPolicy,
  IndexedGenomeTabState,
  IndexedGenomeViewRestoreCommand,
} from '../../shared/indexed-genome';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import type { StructureInspection } from '../structure-drawer/public/inspection-types';
import type { SourceFileView } from '../../shared/external-preview';
import type { QuickLookPackageReceipt } from '../../shared/file-association-ipc';
import type { SequenceDocumentRef } from '../../shared/managed-sequence-document';
import type { CutSiteDisplayRequest } from '@waypoint/workspace-editor';
import type { LegacyMigrationFastaRead } from '../../shared/legacy-migration-read';
import type { FastaKindReadAuthority } from '../../shared/fasta-kind';
import type { OligoOrderType } from '../primers/public/oligo-order-type';

export type EditableArtifactKind = 'primer' | 'protein' | 'assembly';

export interface ArtifactDocumentContext {
  kind: EditableArtifactKind;
  persistence: 'draft' | 'persisted';
  workspaceRoot: string;
  destinationPath: string;
  artifactPath?: string;
  orderType?: OligoOrderType;
}

import type { SavedTrackView } from '../../shared/track-view';
import type { SequenceDataLayerViewSelection } from '../../shared/sequence-data-layer';

import type { TabType } from '../../shared/tab-kind';
export type MetadataEditorTabType = Extract<TabType, 'sequence' | 'primer'>;
export {
  TAB_TYPES,
  QUIT_LABEL_BY_TAB_TYPE,
  isKnownTabType,
  quitWorkPhrase,
  type TabType,
} from '../../shared/tab-kind';

export type { SequenceDataLayerViewSelection } from '../../shared/sequence-data-layer';

export interface TabViewState {
  metadataEditRequestId?: string;
  entityDetailsOpen?: boolean;
  entityDetailsEntityId?: string;

  textCursor?: { line: number; column: number; requestId: string };
  cutSiteDisplayRequest?: CutSiteDisplayRequest | null;

  virtualDigestEnzyme?: string | null;
  virtualDigestEnzymes?: string[] | null;
  digestPanelExpanded?: boolean;

  sequenceRendererVisibility?: 'sequence' | 'both' | 'map';

  sequenceViewMode?: '2d' | '1d' | 'tracks';

  sequenceMapShape?: 'circular' | 'linear';

  sequenceMapLayout?: 'vertical' | 'horizontal';

  sequenceMapPlacement?: 'left' | 'right' | 'top' | 'bottom';

  sequenceMapPaneWidth?: number | null;

  sequenceOrientation?: 'forward' | 'reverse-complement';

  sequenceOriginOffset?: number;

  sequenceViewportCenterBp?: number | null;

  sequenceViewportZoomLevel?: number | null;

  sequenceWebglRenderer?: string;

  sequenceWebglPerformancePreference?: string;

  sequenceWebglScrollSynced?: boolean;

  sequenceWebglZoom?: number | null;

  sequenceWebglCenterBp?: number | null;

  sequenceWebglMorph?: number | null;

  sequenceMinimapHeight?: number | null;

  sequenceMinimapGeometryHeight?: number | null;
  sequenceShowAnnotations?: boolean;
  sequenceShowTranslation?: boolean;
  sequenceShowReverseComplement?: boolean;
  sequenceShowPrimers?: boolean;
  sequenceShowResidueNumbers?: boolean;

  sequenceAnnotationColorMode?: string;

  sequenceDataLayerSelection?: SequenceDataLayerViewSelection | null;

  scrollPosition?: number | null;

  highlightRange?: { start: number; end: number; wraps?: boolean } | null;

  indexedViewport?: { start0: number; end0: number } | null;

  indexedViewportCommand?: {
    id: number;
    chrom: string;
    start0: number;
    end0: number;
  } | null;

  indexedGenomeViewRestoreCommand?: IndexedGenomeViewRestoreCommand | null;
  indexedAnnotationDraft?: Pick<
    IndexedGenomeViewRestoreCommand,
    'id' | 'annotationPolicy' | 'visibleAnnotationTrackIds' | 'orderedAnnotationTrackIds'
  >;

  sequenceNavigationRequestId?: number | string | null;

  selection?: { start: number; end: number } | null;

  sequenceRanges?: { start: number; end: number }[] | null;

  [key: string]: unknown;
}

export type TabLoadStatus =
  | 'loaded'
  | 'pending'
  | 'deferred-oversized'
  | 'missing'
  | 'error'
  | 'indexed-pending'
  | 'indexed'
  | 'indexed-error';

export interface Tab {
  trackView?: SavedTrackView;

  openingTrackViewPath?: string;
  id: string;
  type: TabType;
  entityId: string;
  entityKind?: string;
  label: string;

  sourceFileName?: string;

  readOnly?: boolean;
  legacyMigrationRead?: LegacyMigrationFastaRead;
  legacyFasta?: Exclude<FastaKindReadAuthority, { status: 'declared' }>;
  quickLookSource?: QuickLookPackageReceipt;
  sourceFileView?: SourceFileView;

  sequenceDocument?: SequenceDocumentRef;

  tableDocument?: TableDocumentReference;

  assemblyEditDesignId?: string;
  isDirty?: boolean;
  viewState?: TabViewState;

  pendingViewState?: TabViewState;

  loadStatus?: TabLoadStatus;

  fileSizeBytes?: number;

  indexedGenome?: IndexedGenomeTabState;

  initialAnnotationMapperPolicy?: IndexedGenomeInitialAnnotationMapperPolicy;

  initialStructureAttrs?: Structure3dAttrs;
  structureRenderError?: string;
  molecularViewReferenceId?: string;

  structureInspection?: StructureInspection;
  predictionResult?: import('../compute/public/prediction-result-types').PredictionResultView;

  proteinRunPreview?: boolean;

  artifactDocument?: ArtifactDocumentContext;

  recoveredDraft?: Record<string, string>;
}

export type CanvasTabIdentity =
  | { type: 'sequence'; sequenceDocument: SequenceDocumentRef }
  | { type: Exclude<TabType, 'sequence'>; entityId: string };

export type TabUpdates = Partial<
  Omit<Tab, 'id' | 'type' | 'entityId' | 'sequenceDocument' | 'assemblyEditDesignId'>
>;

export interface PanelState {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
}

export interface RecentlyClosedTab {
  tab: Tab;

  panelId: string;

  index: number;
}

export type LayoutNode =
  | { type: 'panel'; panelId: string }
  | {
      type: 'split';
      direction: 'horizontal' | 'vertical';
      children: LayoutNode[];
      sizes: number[];
    };

export interface CanvasState {
  panels: Record<string, PanelState>;
  layout: LayoutNode;
  focusedPanelId: string | null;

  oversizeScanComplete: boolean;

  recentlyClosed: RecentlyClosedTab[];
}
