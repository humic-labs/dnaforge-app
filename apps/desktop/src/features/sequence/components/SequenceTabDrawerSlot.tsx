import { type UserMessage, toOptionalUserMessage } from '@waypoint/user-messages';

import type { AnnotatedSequence, Annotation, GeneticCodeSpec } from '@waypoint/sequence-utils';
import { AlignmentDrawerContent, inspectMutationProtein } from '../../alignment-manager/public';
import { useCallback } from 'react';
import {
  clearStructureInspection,
  structureInspectionId,
} from '../../structure-drawer/public/structure-inspection';
import { PrimersDrawerContent } from '../../primers/public/components/PrimersDrawerContent';
import type { PrimerAutoScopeRequest } from '../../primers/public/components/PrimerSearchPanel';
import type { PrimerPreview } from '../../primers/public/components/PrimerCreationForm';
import type { BindingHit, PrimerSearchResult } from '../../primers/public/primer-search-service';
import type {
  BoundPrimer,
  CreatePrimerInput,
  Primer,
  PrimerDirection,
} from '../../primers/public/types';
import { StructureDrawerContent } from '../../structure-drawer/public/components/StructureDrawerContent';
import { useCanvasStore } from '../../canvas/public/store';
import { emitLimsRegistrationChanged } from '../../lims/public/events';
import type { ManagedSequenceDocumentRef } from '../../../shared/managed-sequence-document';
import type { SequencePresentation } from '../../../shared/sequence-presentation';
import type { SequencePackageDocument } from '../../../db/sequence-package';
import type { GitLogEntry } from '../../workspace/public/git';
import type { PendingAlignmentFile } from '../alignment-file-selection';
import type { AnnotationDiffResult, DiffResult, SequenceChange } from '../diff/sequence-diff';
import type { AcceptedAssemblySidecarPayload } from '../../assembly/public/accepted-types';
import type { GitDiffStatus } from '../hooks/useGitDiff';
import type { DrawerType } from '../hooks/useDrawerState';
import type { DraftAnnotation, AnnotationDraft } from '../types';
import { AnnotationsDrawerContent } from './annotations-drawer';
import type { AnnotationRange, AnnotationSavePayload } from './annotations-drawer/helpers';
import type { WireRange } from './annotations-drawer/plannotate-range';
import { AnnotationReviewPanel } from './AnnotationReviewPanel';
import { GitHistoryDrawer } from './GitHistoryDrawer';
import { SequenceDrawer } from './SequenceDrawer';
import { SequenceMetadataDrawer } from './SequenceMetadataDrawer';
import { sequenceTabPrimerSaveDir } from './sequence-tab-flags';

type PlannotateStatus = 'idle' | 'loading' | 'success' | 'error';
type AnnotationsDrawerTab = 'annotations' | 'plannotate';
type HighlightRange = { start: number; end: number };

export function SequenceTabDrawerSlot({
  readOnly,
  filePath,
  sequenceDocumentId,
  presentation,
  sequence,
  displaySequence,
  managedDocument,
  activeDrawer,
  drawerWidth,
  onDrawerWidthChange,
  hiddenAnnotationKeys,
  onToggleAnnotationVisibility,
  onSetAllAnnotationsVisible,
  onAnnotationClick,
  onAnnotationSave,
  onAnnotationEditCancel,
  onAnnotationDelete,
  onRunPlannotate,
  onImportAnnotationOutput,
  isImportingAnnotationOutput,
  importedOutputName,
  autoAnnotateApiError,
  annotateError,
  annotateUnavailableReason,
  annotateStatus,
  sequenceVersion,
  reviewRunVersion,
  reviewBlockedReason,
  reviewCoordinateProvenance,
  onRefreshReview,
  onRerunReview,
  reviewIsApplying,
  editTargetIndex,
  onClearEditTarget,
  drawerTab,
  onDrawerTabChange,
  isTargetSequence,
  drafts,
  onAnnotationAdd,
  pendingNewRange,
  currentSelectionRange,
  onClearPendingNewRange,
  pendingNewDraft,
  onClearPendingNewDraft,
  onPendingNewDraftChange,
  draftSessionId,
  reviewSelectedId,
  onSelectDraft,
  onToggleDraftAccepted,
  onAcceptRange,
  onSetRangeAccepted,
  onAcceptAll,
  onRejectAll,
  onCommitReview,
  onCancelReview,
  onCloseDrawer,
  onMetadataDirtyChange,
  onReloadSavedSequence,
  nameEditRequestId = 0,
  metadataEditorTabId,
  onReopenAssembly,
  assemblyReopenStatus,
  assemblyReopenError,
  acceptedAssemblyRecord,
  onAssemblyBackboneSegmentsChange,
  onSequenceTopologySaved,
  onSequenceGeneticCodeSaved,
  pendingAlignmentFiles,
  onClearPendingAlignmentFiles,
  onAddAlignmentFiles,
  primerRecords,
  primersLoading,
  primersError,
  onReloadPrimers,
  onPrimerCreate,
  onDetachPrimerBinding,
  pendingPrimerBindingEdit,
  onClearPendingPrimerBindingEdit,
  pendingPrimerCreation,
  onClearPendingPrimerCreation,
  onPreviewChange,
  primerSequenceId,
  primerWorkspaceRoot,
  searchResults,
  isSearching,
  onSearchPrimers,
  onAttachPrimer,
  canvasSelection,
  primerAutoScope,
  searchLibraryEmpty,
  onPrimerAutoScopeConsumed,
  searchError,
  onSearchResultClick,
  onGoToPrimerBinding,
  gitLog,
  gitLogLoading,
  isFileInGitRepo,
  selectedCommitHash,
  diffResult,
  annotationDiff,
  gitDiffStatus,
  isDiffViewActive,
  ungappedToGapped,
  onScrollToPosition,
  onChangeHighlight,
  onToggleDiffView,
  onSelectCommit,
  onGitCommit,
  onGitRevert,
}: {
  readOnly: boolean;
  filePath: string;
  sequenceDocumentId: string;
  presentation: SequencePresentation;
  sequence: AnnotatedSequence;
  displaySequence: AnnotatedSequence;
  managedDocument: ManagedSequenceDocumentRef | undefined;
  activeDrawer: DrawerType | null;
  drawerWidth: number;
  onDrawerWidthChange: (width: number) => void;
  hiddenAnnotationKeys: Set<string>;
  onToggleAnnotationVisibility: (ann: Annotation) => void;
  onSetAllAnnotationsVisible: (visible: boolean) => void;
  onAnnotationClick: (annotation: { start: number; end: number }) => void;
  onAnnotationSave: (index: number, data: AnnotationSavePayload) => void;
  onAnnotationEditCancel?: (abandonedIndex: number) => void;
  onAnnotationDelete: (index: number) => void;
  onRunPlannotate: (range?: WireRange) => void;
  onImportAnnotationOutput?: () => void;
  isImportingAnnotationOutput?: boolean;
  importedOutputName?: string;
  autoAnnotateApiError: string | null;
  annotateError: string | null;
  annotateUnavailableReason?: UserMessage;
  annotateStatus: PlannotateStatus;
  sequenceVersion: number;
  reviewRunVersion: number | undefined;
  reviewBlockedReason?: UserMessage;
  reviewCoordinateProvenance?: {
    coordinates: 'exact' | 'mapped';
    transitionCount: number;
  };
  onRefreshReview?: () => void;
  onRerunReview?: () => void;
  reviewIsApplying?: boolean;
  editTargetIndex: number | null;
  onClearEditTarget: () => void;
  drawerTab: AnnotationsDrawerTab;
  onDrawerTabChange: (tab: AnnotationsDrawerTab) => void;
  isTargetSequence: boolean;
  drafts: DraftAnnotation[];
  onAnnotationAdd: (annotation: Annotation) => void;
  pendingNewRange: AnnotationRange | null;
  currentSelectionRange: AnnotationRange | null;
  onClearPendingNewRange: () => void;
  pendingNewDraft: AnnotationDraft | null;
  onClearPendingNewDraft: () => void;
  onPendingNewDraftChange: (draft: AnnotationDraft | null) => void;
  draftSessionId: number;
  reviewSelectedId: string | null | undefined;
  onSelectDraft: (documentId: string, id: string) => void;
  onToggleDraftAccepted: (documentId: string, id: string) => void;
  onAcceptRange: (documentId: string, ids: string[]) => void;
  onSetRangeAccepted: (documentId: string, ids: string[], accepted: boolean) => void;
  onAcceptAll: (documentId: string) => void;
  onRejectAll: (documentId: string) => void;
  onCommitReview: () => void;
  onCancelReview: () => void;
  onCloseDrawer: () => void;
  onMetadataDirtyChange?: (dirty: boolean) => void;
  onReloadSavedSequence?: () => Promise<void>;

  nameEditRequestId?: number;
  metadataEditorTabId?: string;
  onReopenAssembly?: () => Promise<void>;
  assemblyReopenStatus?: 'missing' | 'checking' | 'available' | 'opening' | 'error';
  assemblyReopenError?: UserMessage | null;
  acceptedAssemblyRecord?: AcceptedAssemblySidecarPayload | null;
  onAssemblyBackboneSegmentsChange?: (
    segments: import('@waypoint/plasmid-viewer').BackboneSegment[] | undefined
  ) => void;

  onSequenceTopologySaved: (documentId: string, circular: boolean) => void;

  onSequenceGeneticCodeSaved: (documentId: string, geneticCode: GeneticCodeSpec | null) => void;
  pendingAlignmentFiles: PendingAlignmentFile[];
  onClearPendingAlignmentFiles: () => void;
  onAddAlignmentFiles: () => void;
  primerRecords: BoundPrimer[];
  primersLoading: boolean;
  primersError: Error | null;
  onReloadPrimers: () => Promise<void> | void;
  onPrimerCreate: (input: CreatePrimerInput) => Promise<void>;
  onDetachPrimerBinding: (bindingId: string) => Promise<void> | void;
  pendingPrimerBindingEdit: BoundPrimer | null;
  onClearPendingPrimerBindingEdit: () => void;
  pendingPrimerCreation: {
    sequence: string;
    direction: PrimerDirection;
    bindingStart: number;
    bindingEnd: number;
  } | null;
  onClearPendingPrimerCreation: () => void;
  onPreviewChange: (preview: PrimerPreview) => void;
  primerSequenceId: number | null;
  primerWorkspaceRoot: string | null;
  searchResults: PrimerSearchResult[];
  isSearching: boolean;
  onSearchPrimers: (constraints: { regionStart?: number; regionEnd?: number }) => void;
  onAttachPrimer: (primer: Primer, hit: BindingHit) => Promise<void>;
  canvasSelection: { start: number; end: number; wraps?: boolean } | null;
  primerAutoScope: PrimerAutoScopeRequest | null;
  searchLibraryEmpty: boolean;
  onPrimerAutoScopeConsumed: () => void;
  searchError: Error | null;
  onSearchResultClick: (hit: { start: number; end: number }) => void;
  onGoToPrimerBinding: (bindingStart: number, bindingEnd: number) => void;
  gitLog: GitLogEntry[];
  gitLogLoading: boolean;
  isFileInGitRepo: boolean;
  selectedCommitHash: string | null;
  diffResult: DiffResult | null;
  annotationDiff?: AnnotationDiffResult | null;
  gitDiffStatus: GitDiffStatus;
  isDiffViewActive: boolean;
  ungappedToGapped: number[];
  onScrollToPosition: (position: number) => void;
  onChangeHighlight: (range: HighlightRange) => void;
  onToggleDiffView: () => void;
  onSelectCommit: (hash: string) => void;
  onGitCommit: (message: string) => Promise<void>;
  onGitRevert: () => Promise<void>;
}) {
  const linkedInspection = useCanvasStore(
    (state) =>
      Object.values(state.panels)
        .flatMap((panel) => panel.tabs)
        .find(
          (tab) =>
            tab.type === 'structure' && tab.entityId === structureInspectionId(sequenceDocumentId)
        )?.structureInspection
  );
  const followProteinContext = !!linkedInspection;
  const clearProteinContext = useCallback(
    (reason: string) => {
      clearStructureInspection(sequenceDocumentId, reason);
    },
    [sequenceDocumentId]
  );
  return (
    <SequenceDrawer width={drawerWidth} onWidthChange={onDrawerWidthChange}>
      {activeDrawer === 'annotations' && !readOnly && (
        <AnnotationsDrawerContent
          filePath={filePath}
          annotations={sequence.annotations ?? []}
          circular={sequence.circular}
          sequenceLength={sequence.length}
          hiddenAnnotationKeys={hiddenAnnotationKeys}
          onToggleAnnotationVisibility={onToggleAnnotationVisibility}
          onSetAllAnnotationsVisible={onSetAllAnnotationsVisible}
          onAnnotationClick={onAnnotationClick}
          onAnnotationSave={onAnnotationSave}
          onAnnotationEditCancel={onAnnotationEditCancel}
          onAnnotationDelete={onAnnotationDelete}
          onRunPlannotate={onRunPlannotate}
          onImportAnnotationOutput={onImportAnnotationOutput}
          isImportingAnnotationOutput={isImportingAnnotationOutput}
          importedOutputName={importedOutputName}
          plannotateStatus={autoAnnotateApiError ? 'error' : annotateStatus}
          plannotateError={toOptionalUserMessage(
            autoAnnotateApiError ?? annotateError ?? undefined
          )}
          plannotateUnavailableReason={annotateUnavailableReason}
          sequenceVersion={sequenceVersion}
          runVersion={reviewRunVersion}
          editTargetIndex={editTargetIndex}
          onClearEditTarget={onClearEditTarget}
          activeTab={drawerTab}
          onTabChange={onDrawerTabChange}
          hasReviewSession={isTargetSequence}
          onAnnotationAdd={onAnnotationAdd}
          pendingNewRange={pendingNewRange}
          currentSelectionRange={currentSelectionRange}
          currentSelectionWraps={canvasSelection?.wraps ?? false}
          onClearPendingNewRange={onClearPendingNewRange}
          pendingNewDraft={pendingNewDraft}
          onClearPendingNewDraft={onClearPendingNewDraft}
          onPendingNewDraftChange={onPendingNewDraftChange}
          draftSessionId={draftSessionId}
          reviewPanel={
            isTargetSequence ? (
              <AnnotationReviewPanel
                drafts={drafts}
                existingAnnotations={sequence.annotations ?? []}
                selectedId={reviewSelectedId ?? null}
                onSelect={(id) => onSelectDraft(sequenceDocumentId, id)}
                onToggleAccepted={(id) => onToggleDraftAccepted(sequenceDocumentId, id)}
                onAcceptRange={(ids) => onAcceptRange(sequenceDocumentId, ids)}
                onSetRangeAccepted={(ids, accepted) =>
                  onSetRangeAccepted(sequenceDocumentId, ids, accepted)
                }
                onAcceptAll={() => onAcceptAll(sequenceDocumentId)}
                onRejectAll={() => onRejectAll(sequenceDocumentId)}
                onCommit={onCommitReview}
                commitBlockedReason={reviewBlockedReason}
                coordinateProvenance={reviewCoordinateProvenance}
                onRefreshReview={onRefreshReview}
                onRerunReview={onRerunReview}
                isApplying={reviewIsApplying}
                onCancel={onCancelReview}
              />
            ) : undefined
          }
        />
      )}
      {activeDrawer === 'metadata' && (
        <SequenceMetadataDrawer
          documentRef={managedDocument}
          sequenceDocumentId={sequenceDocumentId}
          presentation={presentation}
          filePath={filePath}
          readOnly={readOnly}
          sequenceLength={sequence.length}
          sequenceTopology={sequence.circular ? 'circular' : 'linear'}
          sequence={sequence}
          nameEditRequestId={nameEditRequestId}
          metadataEditorTabId={metadataEditorTabId}
          onReopenAssembly={onReopenAssembly}
          assemblyReopenStatus={assemblyReopenStatus}
          assemblyReopenError={assemblyReopenError}
          acceptedAssemblyRecord={acceptedAssemblyRecord}
          onAssemblyBackboneSegmentsChange={onAssemblyBackboneSegmentsChange}
          onClose={onCloseDrawer}
          onDirtyChange={onMetadataDirtyChange}
          onReloadSavedSequence={onReloadSavedSequence}
          onSaved={(document: SequencePackageDocument, savedGeneticCode) => {
            const savedTopology = document.product.topology;
            if (savedTopology) {
              onSequenceTopologySaved(sequenceDocumentId, savedTopology === 'circular');
            }

            if (savedGeneticCode !== undefined) {
              onSequenceGeneticCodeSaved(sequenceDocumentId, savedGeneticCode);
            }
            const found = useCanvasStore.getState().findTab('sequence', sequenceDocumentId);
            if (found) {
              useCanvasStore.getState().updateTab(found.panelId, found.tabId, {
                label: document.name,
              });
            }
            window.dispatchEvent(
              new CustomEvent('waypoint:workspace-files-changed', {
                detail: { path: managedDocument?.packageRoot ?? filePath },
              })
            );
            emitLimsRegistrationChanged({ documentId: sequenceDocumentId });
          }}
        />
      )}
      {activeDrawer === 'alignments' && (
        <AlignmentDrawerContent
          documentId={sequenceDocumentId}
          sourcePath={filePath}
          referenceName={filePath.split('/').pop() || 'Reference'}
          pendingFiles={pendingAlignmentFiles}
          onClearPendingFiles={onClearPendingAlignmentFiles}
          onAddFiles={onAddAlignmentFiles}
          followProteinContext={followProteinContext}
          inspectedMutation={linkedInspection?.request.variantContext}
          onClearProteinContext={clearProteinContext}
          onInspectProteinContext={(mutation, track) =>
            inspectMutationProtein({
              sequence,
              documentId: sequenceDocumentId,
              mutation,
              track,
              sourceWorkspaceRoot: primerWorkspaceRoot ?? undefined,
            })
          }
        />
      )}
      {activeDrawer === 'primers' && !readOnly && (
        <PrimersDrawerContent
          primers={primerRecords}
          isLoading={primersLoading}
          error={primersError}
          onRetry={onReloadPrimers}
          onPrimerCreate={onPrimerCreate}
          onDetach={onDetachPrimerBinding}
          pendingBindingEdit={pendingPrimerBindingEdit}
          onClearBindingEdit={onClearPendingPrimerBindingEdit}
          pendingCreation={pendingPrimerCreation}
          onClearPendingCreation={onClearPendingPrimerCreation}
          onPreviewChange={onPreviewChange}
          referenceSequence={sequence.sequence}
          sequenceId={primerSequenceId ?? undefined}
          sequenceLength={sequence.sequence?.length}
          circular={displaySequence.circular ?? false}
          workspaceRoot={primerWorkspaceRoot ?? undefined}
          targetDocumentId={sequenceDocumentId}
          targetFilePath={filePath}
          initialSaveDir={sequenceTabPrimerSaveDir(managedDocument, filePath)}
          searchResults={searchResults}
          isSearching={isSearching}
          onSearch={onSearchPrimers}
          onAttach={async (primer, hit) => {
            await onAttachPrimer(primer, hit);
            await onReloadPrimers();
          }}
          selectionRange={canvasSelection}
          autoScope={primerAutoScope}
          libraryEmpty={searchLibraryEmpty}
          onAutoScopeConsumed={onPrimerAutoScopeConsumed}
          searchError={searchError}
          onSearchResultClick={onSearchResultClick}
          onPrimerClick={(primer) => {
            const { bindingStart, bindingEnd } = primer.binding;
            onGoToPrimerBinding(bindingStart, bindingEnd);
          }}
          onGoToBinding={onGoToPrimerBinding}
        />
      )}
      {activeDrawer === 'structure' && <StructureDrawerContent onCloseDrawer={onCloseDrawer} />}
      {activeDrawer === 'git-history' && !readOnly && (
        <GitHistoryDrawer
          log={gitLog}
          isLoading={gitLogLoading}
          isGitRepo={isFileInGitRepo}
          selectedCommitHash={selectedCommitHash}
          hasUncommittedChanges={
            (diffResult !== null && diffResult.changes.length > 0) ||
            (annotationDiff?.changes.length ?? 0) > 0 ||
            (isFileInGitRepo && gitDiffStatus === 'unavailable')
          }
          diffResult={diffResult}
          onScrollToChange={(change: SequenceChange) => {
            if (isDiffViewActive && ungappedToGapped.length > 0) {
              onScrollToPosition(change.position + 1);
              const gappedStart = ungappedToGapped[change.position] ?? change.position;
              if (change.type === 'deletion') {
                onChangeHighlight({ start: gappedStart, end: gappedStart + change.length - 1 });
              } else {
                const gappedEnd =
                  ungappedToGapped[change.position + change.length - 1] ?? gappedStart;
                onChangeHighlight({ start: gappedStart, end: gappedEnd });
              }
            } else {
              onScrollToPosition(change.position + 1);
              if (change.type === 'deletion') {
                onChangeHighlight({ start: change.position, end: change.position });
              } else {
                onChangeHighlight({
                  start: change.position,
                  end: change.position + change.length - 1,
                });
              }
            }
          }}
          isDiffViewActive={isDiffViewActive}
          onToggleDiffView={onToggleDiffView}
          onSelectCommit={onSelectCommit}
          onCommit={onGitCommit}
          onRevert={onGitRevert}
        />
      )}
    </SequenceDrawer>
  );
}
