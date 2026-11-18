import type { SharedSequenceColumnNavigation } from './alignment-mutation-navigation';
import { useMemo, useState, type ComponentProps } from 'react';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import type { ParsedPlasmid, BackboneSegment } from '@waypoint/plasmid-viewer';
import type {
  AnnotationStateIdentity,
  CoordinateSpace,
  EditorPasteFragment,
  MutationMarker,
  PrimerDisplay,
  SequenceEditorSession,
} from '@waypoint/workspace-editor';
import type { AnnotationDraft } from '../types';
import type { DiffResult } from '../diff/sequence-diff';
import type { DrawerType } from '../hooks/useDrawerState';
import type { SelectionState } from '../selection-state';
import type { ResolvedAcceptedAssemblyRecord } from '../../assembly/public/accepted-record-reader';
import {
  acceptedAssemblyVersionFromSidecar,
  parseAcceptedAssemblyPayload,
} from '../../assembly/public/accepted-reopen';
import { acceptedHistoryBackboneSegments } from '../../assembly/public/accepted-history-presentation';
import { useAssemblyColorScheme } from '../../design/public/color-scheme-store';
import { annotatedSequenceToParsedPlasmid } from '../adapters';
import { SequencePackageHistoryPanel } from './SequencePackageHistoryPanel';
import { SequenceDrawer } from './SequenceDrawer';
import type { SharedAlignmentLane } from './shared-sequence-read-model';
import { SequenceTabDrawerSlot } from './SequenceTabDrawerSlot';
import { WorkspaceViewer } from './WorkspaceViewer';
import type { AskAiViewerPayload } from './ask-ai-selection-input';
import type { SequencePackageHistoryView } from '../hooks/useSequencePackageHistory';

type HighlightRange = { start: number; end: number; wraps?: boolean };
type SequenceTabDrawerProps = ComponentProps<typeof SequenceTabDrawerSlot>;

export function SequenceTabWorkspaceCanvas({
  sequenceDocumentId,
  readOnly,
  editingPending = false,
  savePending = false,
  displaySequence,
  dataLayerSourceSequence,
  parsedPlasmid,
  allPrimerDisplays,
  onCopy,
  resolvePasteFragment,
  onSelectionChange,
  onSelectionStateChange,
  onAnnotateToolClick,
  isDrawerOpen,
  activeDrawer,
  isTargetSequence,
  draftsLength,
  drawerTab,
  changeHighlight,
  mutationHighlight,
  columnNavigation,
  reviewHighlight,
  referenceHighlight,
  onHighlightComplete,
  scrollToPosition,
  referenceScrollPosition,
  sequenceNavigationRequestId,
  onScrollComplete,
  onOpenAlignments,
  canOpenMetadata,
  onToggleMetadata,
  packageHistory,
  packageRestore,
  assemblyComposition,
  onOpenGitHistory,
  onOpenPrimers,
  onOpenStructure,
  hasAssociatedStructure,
  hasSelectedStructureRequest,
  onCreatePrimer,
  onAttachPrimers,
  onViewStructure,
  onCreateAminoAcidSequence,
  onAskAI,
  onEditPrimer,
  onEditPrimerBinding,
  onCopyPrimer,
  onDetachPrimerBinding,
  onReloadPrimers,
  isAnyDiffViewActive,
  coordinateSpace,
  alignmentLanes,
  effectiveCoordinateSpace,
  diffViewMutations,
  mutations,
  onMutationClick,
  onEditModeChange,
  onRestrictionEnzymeDrawerOpenChange,
  restrictionEnzymeDrawerWidth,
  onRestrictionEnzymeDrawerWidthChange,
  onEditAnnotation,
  onCommitCdsExtension,
  onOpenCdsExtensionDraft,
  onActivateAnnotation,
  onSelectedAnnotationChange,
  onDeleteAnnotation,
  onAddAnnotation,
  onAddAnnotationDraft,
  candidateOrf,
  forcedSelectedAnnotation,
  allRulerDecorations,
  changedAnnotationNames,
  editorSession,
  resumePendingEdits,
  diffResult,
  onEditCommit,
  onEditDiscard,
  drawer,
}: {
  sequenceDocumentId: string;
  readOnly: boolean;
  editingPending?: boolean;
  savePending?: boolean;
  displaySequence: AnnotatedSequence;
  dataLayerSourceSequence?: AnnotatedSequence;
  parsedPlasmid: ParsedPlasmid;
  allPrimerDisplays: PrimerDisplay[];
  onCopy: ComponentProps<typeof WorkspaceViewer> extends { onCopy?: infer T } ? T : never;
  resolvePasteFragment: (
    clipboardText: string
  ) => EditorPasteFragment | null | Promise<EditorPasteFragment | null>;
  onSelectionChange: (range: { start: number; end: number; wraps?: boolean } | null) => void;
  onSelectionStateChange: (state: SelectionState) => void;
  onAnnotateToolClick: () => void;
  isDrawerOpen: boolean;
  activeDrawer: DrawerType | null;
  isTargetSequence: boolean;
  draftsLength: number;
  drawerTab: 'annotations' | 'plannotate';
  changeHighlight: HighlightRange | null;
  mutationHighlight: HighlightRange | null;
  columnNavigation?: SharedSequenceColumnNavigation;
  reviewHighlight: HighlightRange | null;
  referenceHighlight: HighlightRange | null;
  onHighlightComplete: () => void;
  scrollToPosition: number | null;
  referenceScrollPosition: number | null;
  sequenceNavigationRequestId: number | string | null;
  onScrollComplete: () => void;
  onOpenAlignments: () => void;
  canOpenMetadata: boolean;
  onToggleMetadata: () => void;
  packageHistory?: SequencePackageHistoryView;
  packageRestore?: ComponentProps<typeof SequencePackageHistoryPanel>['restore'];
  assemblyComposition?: ComponentProps<typeof SequencePackageHistoryPanel>['composition'];
  onOpenGitHistory: () => void;
  onOpenPrimers: () => void;
  onOpenStructure: () => void;
  hasAssociatedStructure: boolean;
  hasSelectedStructureRequest: boolean;
  onCreatePrimer: (
    range: { start: number; end: number; sequence: string },
    direction: 'forward' | 'reverse'
  ) => void;
  onAttachPrimers: () => void;
  onViewStructure: (cds: Annotation) => void;
  onCreateAminoAcidSequence: (cds: Annotation) => void;
  onAskAI: (payload: AskAiViewerPayload) => void;
  onEditPrimer: (primer: PrimerDisplay) => void;
  onEditPrimerBinding: (primer: PrimerDisplay) => void;
  onCopyPrimer: (primer: PrimerDisplay) => void;
  onDetachPrimerBinding: (bindingId: string) => Promise<void> | void;
  onReloadPrimers: () => Promise<void> | void;
  isAnyDiffViewActive: boolean;
  coordinateSpace: CoordinateSpace | undefined;
  alignmentLanes?: ReadonlyArray<SharedAlignmentLane>;
  effectiveCoordinateSpace: CoordinateSpace | undefined;
  diffViewMutations: MutationMarker[];
  mutations: MutationMarker[];
  onMutationClick: (mutation: MutationMarker) => void;
  onEditModeChange: (active: boolean) => void;
  onRestrictionEnzymeDrawerOpenChange: (open: boolean) => void;
  restrictionEnzymeDrawerWidth: number;
  onRestrictionEnzymeDrawerWidthChange: (width: number) => void;
  onEditAnnotation: (annotation: Annotation) => void;
  onCommitCdsExtension?: (commit: { original: Annotation; updated: Annotation }) => void;
  onOpenCdsExtensionDraft?: (action: {
    original: Annotation;
    direction: 'five-prime' | 'three-prime';
    kind: 'extend' | 'undo';
  }) => void;
  onActivateAnnotation: (annotation: AnnotationStateIdentity) => void;
  onSelectedAnnotationChange: (annotation: AnnotationStateIdentity | null) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  onAddAnnotation: (range: { start: number; end: number }) => void;
  onAddAnnotationDraft: (draft: AnnotationDraft) => void;
  candidateOrf: { start: number; end: number; strand: '+' | '-' } | null;
  forcedSelectedAnnotation: {
    type: string;
    name: string;
    start: number;
    end: number;
    direction: number;
  } | null;
  allRulerDecorations: NonNullable<ComponentProps<typeof WorkspaceViewer>['rulerDecorations']>;
  changedAnnotationNames: Set<string> | undefined;

  editorSession: SequenceEditorSession;

  resumePendingEdits: boolean;
  diffResult: DiffResult | null;
  onEditCommit: () => Promise<boolean | void> | boolean | void;

  onEditDiscard: () => AnnotatedSequence | null;
  drawer: SequenceTabDrawerProps;
}) {
  const drawerHostedByWorkspace = activeDrawer === 'restriction-enzymes';
  const shouldRenderDrawerSlot = isDrawerOpen && !drawerHostedByWorkspace;
  const [assemblyHistorySegments, setAssemblyHistorySegments] = useState<
    BackboneSegment[] | undefined
  >();
  const [hoveredSavedPart, setHoveredSavedPart] = useState<number | null>(null);
  const assemblyColorScheme = useAssemblyColorScheme();
  const historicalSequence =
    activeDrawer === 'git-history' ? (packageHistory?.selectedSequence ?? null) : null;
  const historicalPlasmid = useMemo(
    () => (historicalSequence ? annotatedSequenceToParsedPlasmid(historicalSequence) : null),
    [historicalSequence]
  );
  const showingHistoricalSequence = Boolean(historicalSequence && historicalPlasmid);
  const historicalAssemblyRecord = useMemo<ResolvedAcceptedAssemblyRecord | null>(() => {
    const index = packageHistory?.index;
    const revision = index?.document.versionHistory.revisions.find(
      (entry) => entry.id === packageHistory?.selectedRevisionId
    );
    if (!revision?.state.acceptedAssembly || !historicalSequence || !index) return null;
    try {
      const accepted = parseAcceptedAssemblyPayload(revision.state.acceptedAssembly, {
        packageRoot: index.packageRoot,
      });
      const acceptedAssemblyVersionId = acceptedAssemblyVersionFromSidecar(accepted).id;
      const expectedChecksum = accepted.artifacts.productGenBankChecksum ?? null;
      return {
        constructId: index.document.id,
        packageId: index.document.id,
        packageRoot: index.packageRoot,
        productPath: index.productPath,
        metaPath: index.markerPath,
        acceptedAssemblyVersionId,
        accepted,
        acceptedRecords: [accepted],
        recordIsCurrent: revision.id === index.document.versionHistory.headId,
        integrity: {
          productGenBank:
            expectedChecksum === revision.productSnapshot.sha256 ? 'verified' : 'historical',
          expectedChecksum,
          actualChecksum: revision.productSnapshot.sha256,
        },
        catalogEvents: [],
      };
    } catch {
      return null;
    }
  }, [historicalSequence, packageHistory]);
  const historicalSegments = useMemo(
    () =>
      historicalAssemblyRecord && historicalSequence
        ? acceptedHistoryBackboneSegments(
            historicalAssemblyRecord.accepted,
            historicalSequence.sequence,
            hoveredSavedPart,
            assemblyColorScheme
          )
        : undefined,
    [assemblyColorScheme, historicalAssemblyRecord, historicalSequence, hoveredSavedPart]
  );
  const viewerReadOnly = readOnly || showingHistoricalSequence;
  const viewedSequence = historicalSequence ?? displaySequence;
  const viewedPlasmid = historicalPlasmid ?? parsedPlasmid;

  return (
    <WorkspaceViewer
      key={showingHistoricalSequence ? 'historical-sequence' : 'current-sequence'}
      entityId={sequenceDocumentId}
      readOnly={viewerReadOnly}
      editingPending={editingPending}
      savePending={savePending}
      sequence={viewedSequence}
      dataLayerSourceSequence={historicalSequence ?? dataLayerSourceSequence}
      plasmid={viewedPlasmid}
      backboneSegments={
        showingHistoricalSequence
          ? historicalSegments
          : isDrawerOpen && activeDrawer === 'metadata' && !isAnyDiffViewActive && !coordinateSpace
            ? assemblyHistorySegments
            : undefined
      }
      circular={viewedSequence.circular ?? false}
      initialEditMode={!viewerReadOnly && (displaySequence.length === 0 || resumePendingEdits)}
      onEditModeChange={onEditModeChange}
      primers={!viewerReadOnly && allPrimerDisplays.length > 0 ? allPrimerDisplays : undefined}
      onCopy={viewerReadOnly ? undefined : onCopy}
      resolvePasteFragment={resolvePasteFragment}
      onSelectionChange={viewerReadOnly ? undefined : onSelectionChange}
      onSelectionStateChange={viewerReadOnly ? undefined : onSelectionStateChange}
      onAutoAnnotateClick={viewerReadOnly ? undefined : onAnnotateToolClick}
      autoAnnotateStatus={isDrawerOpen && activeDrawer === 'annotations' ? 'success' : 'idle'}
      isAnyDrawerOpen={isDrawerOpen}
      isAnnotationDrawerOpen={isDrawerOpen && activeDrawer === 'annotations'}
      hasReviewSession={isTargetSequence && draftsLength > 0}
      highlightRange={
        viewerReadOnly
          ? undefined
          : (changeHighlight ?? mutationHighlight ?? reviewHighlight ?? referenceHighlight)
      }
      onHighlightComplete={onHighlightComplete}
      scrollToPosition={scrollToPosition ?? referenceScrollPosition}
      sequenceNavigationRequestId={
        scrollToPosition != null && columnNavigation
          ? columnNavigation.requestId
          : sequenceNavigationRequestId
      }
      columnNavigation={viewerReadOnly ? undefined : columnNavigation}
      onScrollComplete={onScrollComplete}
      isReviewMode={
        isTargetSequence && activeDrawer === 'annotations' && drawerTab === 'plannotate'
      }
      onOpenAlignments={onOpenAlignments}
      isAlignmentPanelOpen={activeDrawer === 'alignments'}
      onOpenMetadata={canOpenMetadata ? onToggleMetadata : undefined}
      isMetadataOpen={activeDrawer === 'metadata'}
      onOpenGitHistory={readOnly ? undefined : onOpenGitHistory}
      historyLabel={packageHistory ? 'History' : undefined}
      isGitHistoryOpen={activeDrawer === 'git-history'}
      onOpenPrimers={readOnly ? undefined : onOpenPrimers}
      isPrimersPanelOpen={activeDrawer === 'primers'}
      onOpenStructure={viewerReadOnly ? undefined : onOpenStructure}
      isStructureDrawerOpen={activeDrawer === 'structure'}
      isStructureAvailable={
        !viewerReadOnly &&
        (hasAssociatedStructure || activeDrawer === 'structure' || hasSelectedStructureRequest)
      }
      onCreatePrimer={viewerReadOnly ? undefined : onCreatePrimer}
      onAttachPrimers={viewerReadOnly ? undefined : onAttachPrimers}
      onViewStructure={viewerReadOnly ? undefined : onViewStructure}
      onCreateAminoAcidSequence={viewerReadOnly ? undefined : onCreateAminoAcidSequence}
      onAskAI={viewerReadOnly ? undefined : onAskAI}
      onEditPrimer={viewerReadOnly ? undefined : onEditPrimer}
      onEditPrimerBinding={viewerReadOnly ? undefined : onEditPrimerBinding}
      onCopyPrimerBases={(primer) => void onCopyPrimer(primer)}
      onDetachPrimer={
        viewerReadOnly
          ? undefined
          : async (primer) => {
              if (!primer.isCandidate && !primer.isDraft) {
                await onDetachPrimerBinding(primer.id);
                await onReloadPrimers();
              }
            }
      }
      hideReverseComplement={!viewerReadOnly && (isAnyDiffViewActive || !!coordinateSpace)}
      mutations={viewerReadOnly ? [] : isAnyDiffViewActive ? diffViewMutations : mutations}
      onMutationClick={viewerReadOnly ? undefined : onMutationClick}
      coordinateSpace={viewerReadOnly ? undefined : effectiveCoordinateSpace}
      drawerSlot={
        activeDrawer === 'git-history' && packageHistory ? (
          <SequenceDrawer width={drawer.drawerWidth} onWidthChange={drawer.onDrawerWidthChange}>
            <SequencePackageHistoryPanel
              history={packageHistory}
              restore={packageRestore}
              composition={assemblyComposition}
              assemblyRecord={historicalAssemblyRecord}
              onHoverPart={setHoveredSavedPart}
            />
          </SequenceDrawer>
        ) : shouldRenderDrawerSlot ? (
          <SequenceTabDrawerSlot
            {...drawer}
            onAssemblyBackboneSegmentsChange={setAssemblyHistorySegments}
          />
        ) : undefined
      }
      alignmentLanes={alignmentLanes}
      adaptiveDrawerWidth={activeDrawer === 'alignments' ? drawer.drawerWidth : undefined}
      isRestrictionEnzymeDrawerOpen={activeDrawer === 'restriction-enzymes'}
      onRestrictionEnzymeDrawerOpenChange={onRestrictionEnzymeDrawerOpenChange}
      restrictionEnzymeDrawerWidth={restrictionEnzymeDrawerWidth}
      onRestrictionEnzymeDrawerWidthChange={onRestrictionEnzymeDrawerWidthChange}
      onEditAnnotation={viewerReadOnly ? undefined : onEditAnnotation}
      onCommitCdsExtension={viewerReadOnly ? undefined : onCommitCdsExtension}
      onOpenCdsExtensionDraft={viewerReadOnly ? undefined : onOpenCdsExtensionDraft}
      onActivateAnnotation={onActivateAnnotation}
      onSelectedAnnotationChange={onSelectedAnnotationChange}
      onDeleteAnnotation={viewerReadOnly ? undefined : onDeleteAnnotation}
      onAddAnnotation={viewerReadOnly ? undefined : onAddAnnotation}
      onAddAnnotationDraft={viewerReadOnly ? undefined : onAddAnnotationDraft}
      candidateOrf={candidateOrf}
      forcedSelectedAnnotation={forcedSelectedAnnotation}
      rulerDecorations={viewerReadOnly || isAnyDiffViewActive ? [] : allRulerDecorations}
      changedAnnotationNames={changedAnnotationNames}
      editorSession={viewerReadOnly ? undefined : editorSession}
      diffResult={viewerReadOnly ? null : diffResult}
      onEditCommit={viewerReadOnly ? undefined : onEditCommit}
      onEditDiscard={viewerReadOnly ? undefined : onEditDiscard}
    />
  );
}
