import './diagnostics';
export { diag } from './diagnostics';
export type { DiagEvent, DiagEventType, DiagSubscriber } from './diagnostics';

export {
  HoveredEnzymeProvider,
  useMainViewerHoveredEnzyme,
  useHoveredEnzymeStore,
  useCreateHoveredEnzymeStore,
  useEffectiveHoveredEnzyme,
  createHoveredEnzymeStore,
} from './hovered-enzyme-store';
export type { HoveredEnzymeStore } from './hovered-enzyme-store';

export {
  HoveredAnnotationProvider,
  useHoveredAnnotation,
  useHoveredAnnotationStore,
  useCreateHoveredAnnotationStore,
  useEffectiveHoveredAnnotation,
  createHoveredAnnotationStore,
} from './hovered-annotation-store';
export type { HoveredAnnotationStore, HoveredAnnotationKey } from './hovered-annotation-store';

export {
  HoveredCodonProvider,
  useHoveredCodon,
  useHoveredCodonStore,
  useCreateHoveredCodonStore,
  useEffectiveHoveredCodon,
  createHoveredCodonStore,
} from './hovered-codon-store';
export type { HoveredCodonStore, HoveredCodonKey } from './hovered-codon-store';

export {
  ResidueSelectionsProvider,
  useResidueSelections,
  useResidueSelectionsStore,
  useCreateResidueSelectionsStore,
  createResidueSelectionsStore,
  applyResidueSelectionCommand,
  sameResidueSelection,
  sameResidueSelections,
  sameCodingDnaSelectionRanges,
  residueSelectionsToCodingDnaRanges,
  replaceResidueSelectionForMolecule,
} from './residue-selection-store';
export {
  SAVED_RESIDUE_SELECTION_SCHEMA,
  appendSavedResidueSelectionRevision,
  classifySavedResidueSelectionCompatibility,
  createSavedResidueSelectionDocument,
  parseSavedResidueSelectionDocument,
  serializeSavedResidueSelectionDocument,
  type AppendSavedResidueSelectionRevisionInput,
  type CreateSavedResidueSelectionDocumentInput,
  type SavedResidueSelectionCompatibility,
  type SavedResidueSelectionCompatibilityContext,
  type SavedResidueSelectionDocument,
  type SavedResidueSelectionMember,
  type SavedResidueSelectionRevision,
  type SavedSelectionActor,
  type SavedSelectionChainInstance,
  type SavedSelectionPolymerRevision,
  type SavedSelectionScope,
  type SavedSelectionSourceArtifactPin,
  type SavedSelectionStructureRevision,
  type SavedSelectionTranslationPin,
} from './saved-residue-selection';
export {
  buildDirectProteinRef,
  buildTranslatedCdsProteinRef,
  buildTranslatedCdsProteinRefFromParts,
  serializeBiomoleculeRef,
  standaloneProteinMoleculeIdFromEntity,
  translatedCdsFeatureKey,
  translatedCdsMoleculeIdFromParts,
} from './residue-biomolecule';
export {
  projectionLocationsForResidueIndex,
  residueIndexForProjectionLocation,
  residueIndicesForProjectionSelection,
  residueMoleculeKindsCompatible,
  residueSelectionHasForeignProjectionMolecule,
  residueSelectionProjectsIntoContract,
  residueSelectionTargetsProjectionMolecule,
  selectionMappingsForProjectionResidueIndex,
} from './residue-projection-contract';
export {
  buildResidueSelectionForCdsCodonRange,
  buildResidueSelectionForCdsCodon,
  residueIndexForCdsCodon,
  toggleResidueSelection,
  translatedCdsMoleculeId,
  type BuildResidueSelectionForCdsCodonRangeArgs,
  type BuildResidueSelectionForCdsCodonArgs,
  type CdsCodonSelectionHit,
} from './residue-selection-from-cds';
export type {
  CodingDnaSelectionRange,
  ResidueInterval,
  ResidueMoleculeKind,
  ResidueSelection,
  ResidueSelectionCodingDnaInterval,
  ResidueSelectionCodingDnaMapping,
  ResidueSelectionMapping,
  ResidueSelectionProteinMsaMapping,
  ResidueSelectionSource,
  ResidueSelectionStructureMapping,
  ResidueSelectionStructureTarget,
  ResidueSelectionTarget,
  ResidueSelectionClearScope,
  ResidueSelectionCommand,
  ResidueSelectionsStore,
} from './residue-selection-store';
export type {
  BiomoleculeAlias,
  BiomoleculeRef,
  DirectProteinRef,
  ProteinMsaRowRef,
  TranslatedCdsProteinRef,
} from './residue-biomolecule';
export type {
  ResidueProjectionContract,
  ResidueProjectionMolecule,
  ResidueProjectionMoleculeAlias,
  ResidueProjectionRule,
  ResidueProjectionRuleContext,
} from './residue-projection-contract';
export {
  SelectedCodonsProvider,
  useSelectedCodons,
  useSelectedCodonsStore,
  useCreateSelectedCodonsStore,
  createSelectedCodonsStore,
  selectedCodonsToResidueSelections,
} from './selected-codons-store';
export type { SelectedCodonsStore, SelectedCodonKey } from './selected-codons-store';

export { SequenceViewer, WorkspaceEditor } from './SequenceViewer';
export {
  INITIAL_PORTAL_WIDTH_STABILITY,
  PORTAL_REATTACH_STABLE_WIDTH_SAMPLES,
  samplePortalReattachWidth,
} from './portal-reattach-width-stability';
export type {
  PortalWidthStability,
  PortalWidthStabilityResult,
} from './portal-reattach-width-stability';

export { SequenceScrollbar } from './SequenceScrollbar';
export type { SequenceScrollbarProps, SequenceScrollbarHandle } from './SequenceScrollbar';

export { WorkspaceEditorWithEnzymes } from './WorkspaceEditorWithEnzymes';
export type { WorkspaceEditorWithEnzymesProps } from './WorkspaceEditorWithEnzymes';

export { SequenceCanvas } from './SequenceCanvas';

export { ViewerPalette, ZoomControlStandalone } from './ViewerPalette';
export type { ViewerPaletteOptions } from './ViewerPalette';

export { useSequenceLayout, getPositionFromCoordinates } from './useSequenceLayout';
export type { UseSequenceLayoutResult } from './useSequenceLayout';

export { create2DLayoutAdapter } from './layout-interface';
export type { SequenceLayout, Segment, HitResult, Tick } from './layout-interface';
export { pickTickStep } from './ruler-ticks';

export { SequenceViewer1D } from './SequenceViewer1D';
export type {
  SequenceViewer1DProps,
  SequenceViewer1DHandle,
  SequenceExtraLane,
  SequenceExtraLanePaintInfo,
} from './SequenceViewer1D';

export type { ReferenceColumnOverlay, BuiltinOverlayTarget } from './lanes/overlay-types';
export { BUILTIN_OVERLAY_TARGETS } from './lanes/overlay-types';
export type { BpHighlight } from './types';
export { SequenceScrollbar1D } from './SequenceScrollbar1D';
export type { SequenceScrollbar1DProps } from './SequenceScrollbar1D';
export {
  compute1DLayout,
  create1DLayoutAdapter,
  pack1D,
  MAX_LANES_1D,
  MIN_PX_PER_BASE_1D,
  MAX_PX_PER_BASE_1D,
  HORIZONTAL_PADDING_1D,
} from './layout-1d';
export type { Layout1D, Layout1DInput } from './layout-1d';
export { render1DPrimers } from './primer-1d-render';
export type { Primer1DRenderInput } from './primer-1d-render';
export {
  computeMultiLaneLayout,
  createFixedHeightLane,
  getLaneLodTier,
  LANE_LOD_CLOSE_MIN_PX_PER_COLUMN,
  LANE_LOD_WIDE_MAX_PX_PER_COLUMN,
  renderMultiLane,
  hitTestMultiLane,
  solidLane,
  lodAwareLane,
} from './lanes';
export type {
  ColumnRange,
  LaneDrawState,
  LaneHeaderState,
  LaneHeightState,
  LaneHitState,
  LaneLodTier,
  LanePlugin,
  MeasuredLane,
  MultiLaneLayout,
  MultiLaneLayoutInput,
  RenderMultiLaneOptions,
  MultiLaneHitResult,
  SolidLaneOptions,
  LodAwareLaneOptions,
} from './lanes';
export { MultiLaneCanvas } from './MultiLaneCanvas';
export type { MultiLaneCanvasProps, MultiLaneCanvasHandle } from './MultiLaneCanvas';

export {
  runExtraLaneContractTests,
  buildPaintInfo,
  defaultScenarios,
  createProbeContext,
  assertNoOffScreenDraws,
  assertNotEmpty,
  assertWithinLaneVertical,
} from './testing/extra-lane-contract';
export type {
  ContractScenario,
  ContractScenarioOverrides,
  ProbeContext,
  RunContractOptions,
} from './testing/extra-lane-contract';
export {
  useEditorState,
  useEditorSessionState,
  createInitialState,
  editorReducer,
  createEditorSession,
  cleanSequenceFromEditorState,
  hasUncommittedSequenceEdits,
} from './hooks/useEditorState';
export { adjustAnnotationsForInsert, adjustAnnotationsForDelete } from './hooks/useEditorState';
export { useSequenceSearch } from './hooks/useSequenceSearch';
export type { SearchMode, UseSequenceSearchReturn } from './hooks/useSequenceSearch';

export { FindBar } from './FindBar';
export type { FindBarAnnotationBadgeStyle, FindBarProps } from './FindBar';

export { SequenceStateProvider, useSequenceState, useSequenceStateOptional } from './context';
export type { SequenceState, SequenceStateProviderProps, DraftEdit } from './context';

export { TabActivityProvider, useIsTabActive } from './tab-activity';

export { DEFAULT_EDITOR_CONFIG, CHANGE_COLORS, MUTATION_COLORS } from './types';
export { parseAnyColorToRgb } from './utils/color-utils';

export { getCanvasTheme, resolveCanvasTheme, setCanvasTheme } from './canvas-theme';
export type { CanvasTheme } from './canvas-theme';
export {
  MIN_ZOOM,
  MAX_ZOOM,
  clampZoom,
  computeScaledConfig,
  computeCanvasFitOnceMinZoom,
  deriveSequenceLodLevel,
  canRenderNucleotideText,
  detailTrackPreviewProgress,
  cdsDetailZoomProgress,
  cdsReplacementZoomPresentation,
  resolveIndexedCdsZoomConfig,
  WRAP_ZOOM_SENSITIVITY,
  formatZoomPercent,
  nextZoomFromWheelDelta,
  stepZoomByFactor,
} from './zoom-math';
export type { SequenceLodLevel, SequenceLodMetrics } from './zoom-math';
export type {
  WorkspaceEditorConfig,
  WorkspaceEditorProps,
  WorkspaceEditorHandle,
  ScrollToBiologicalPositionOptions,
  SequenceScrollPresentation,
  LayoutSnapshot2D,
  Layout2DRow,
  AnnotationWithLane,
  Selection,
  ViewportRange,
  ViewportChangeSource,
  EditorState,
  EditorAction,
  HistoryEntry,
  SequenceEditorSession,
  InsertedRange,
  DeletedRange,
  SubstitutedRange,
  EditorPasteFragment,
  EditorPastePrimerBinding,
  EditorPendingPrimerBinding,
  AnnotatedSequence,
  Annotation,
  AnnotationColorMode,
  PrimerDisplay,
  RenderedPrimerSegment,
  RenderedPrimerSegmentRole,
  OligoMismatch,
  RulerSegment,
  JunctionIndicator,
  RenderedGGProductLabel,
  CoordinateSpace,
  CoordinateSpaceMode,
  MutationMarker,
  MutationType,
  RulerDecoration,
} from './types';
export { computeRenderedPrimerSegments } from './primer-render-geometry';
export type { ComputeRenderedPrimerSegmentsInput } from './primer-render-geometry';

export {
  getMutationColor,
  getMutationWidth,
  getMutationsForLine,
  generateMutationMarkers,
} from './mutation-track';

export { useORFs } from './orfs/useORFs';
export type { UseORFsResult } from './orfs/useORFs';
export type { OrfPresentation, OrfQualifiedPaint } from './orfs/orf-observation';

export { isInAlignmentMode } from './coordinate-space-utils';

export {
  annotationKeyOf,
  annotationRenderState,
  annotationOutlineStrokeSpec,
  paintAnnotationOutline,
  type AnnotationStateIdentity,
  type AnnotationRenderState,
  type AnnotationRenderStateInput,
  type AnnotationOutlineStrokeSpec,
} from './annotation-render-state';
export {
  annotationIdForOneDimensionalView,
  annotationIdentityEqual,
  annotationIdentityFromSearchMatch,
  projectSequenceSelection,
  projectSequenceSelectionFromInput,
  resolveSequenceSelectionIntent,
} from './sequence-selection-intent';
export type {
  SequenceSelectionIntent,
  SequenceSelectionIntentInput,
  SequenceSelectionProjection,
  SequenceSelectionRange,
  SequenceSelectionSource,
} from './sequence-selection-intent';

export { useCutSites, drawCutSites, hitTestCutLine } from './restriction-enzymes';
export type {
  CutSitesState,
  CutSitesActions,
  CutSiteDisplayRequest,
  RenderedCutSite,
} from './restriction-enzymes';

export {
  detectCutSiteLabelHit,
  detectGGLabelHit,
  hitTestLabels,
  getHitTarget,
} from './hit-detection';
export type {
  HitTarget,
  HitTargetType,
  HitTargetCutSite,
  HitTargetGGLabel,
  HitTargetHandle,
  HitTargetAnnotation,
  HitTargetCodon,
  HitTargetPrimer,
  HitTargetNucleotide,
  HitTargetEmpty,
  LabelBounds,
} from './hit-detection';

export {
  dragHandle,
  invertSelection,
  computeShiftClickRangeForAnnotation,
} from './selection-model';
export type { SelectionRange, ShiftClickAnnotationRangeInput } from './selection-model';

export { bioToGapped, gappedToBio, gappedToBioClamped } from './coordinate-space';

export {
  buildSplicedCodingSequence,
  getCodonsForSingleCDS,
  getCodonsForLine,
  getDraftCodonsForCDS,
  getDeletedCodons,
  getFrameshiftRanges,
  getAlignmentCodonsForCDS,
} from './translation';
export type { CodonInfo, DraftCodonInfo, AlignmentCodonInfo } from './translation';
export { getCDSTranslation, aminoAcidCreationBlockedReason } from './translation';
export type { AminoAcidCreationBlockReason } from './translation';
export type { AlignmentModeOptions } from './translation-drawing';

export { mapAlignmentToRefCoords } from './msa-utils';
export type { RefCoordBase, InsertionMarker, RefCoordAlignment, MSATrackData } from './msa-utils';
export { LinearMSAView } from './LinearMSAView';
export type { LinearMSAViewProps } from './LinearMSAView';

export { buildCanvasContentReportCounts, type CanvasContentReportCounts } from './content-report';

export {
  annotationsWithCdsExtensionPreview,
  arrowHitTest,
  buildExtendedCdsPreview,
  cdsExtensionOriginalBounds,
  cdsExtensionHoveredEnds,
  cdsExtensionIdentityKey,
  cdsExtensionPreviewDirection,
  cdsExtensionPreviewEnds,
  cdsWithoutExtensionPreview,
  buildExtendedCdsPreviewForEnds,
  committedBoundsForExtensionPreview,
  committedQualifiersForExtensionPreview,
  extensionQualifiersForSavedRow,
  incompleteCdsEnds,
  isCdsExtensionPreview,
  isPredictedCodonCell,
  CDS_EXTENSION_DIRECTION_QUALIFIER,
  CDS_EXTENSION_HOVER_QUALIFIER,
  CDS_EXTENSION_ORIGINAL_QUALIFIER,
} from './cds-extension-affordance';
export type {
  CdsExtensionArrowBounds,
  CdsExtensionArrowKind,
  CdsExtensionArrowId,
  CdsExtensionOriginalBounds,
} from './cds-extension-affordance';
export { cdsExtensionKeyFor } from './cds-extension-affordance';
export {
  CdsExtensionHoverProvider,
  useCdsExtensionHover,
  useCdsExtensionHoverStore,
  useCreateCdsExtensionHoverStore,
  createCdsExtensionHoverStore,
} from './cds-extension-hover-store';
export type { CdsExtensionHoverStore } from './cds-extension-hover-store';
