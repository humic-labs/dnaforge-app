import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { useProjectEditFolders } from '../../workspace-loader/public/use-project-edit-folders';
import { projectPathIsReadOnly } from '../../workspace-loader/public/project-edit-folders';
import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  annotatedSequenceToParsedPlasmid,
  findStructureAnnotationByLabel,
  findStructureAnnotationAtPosition,
} from '../adapters';
import { useSequence } from '../hooks';
import { isNativeSequenceClientInputPending } from '../sequence-client-port';
import { useAnnotationReviewStore } from '../annotation-review-store';
import { useAnnotationOperationState } from '../annotation-operation-state';
import {
  applyNativeAnnotationReview,
  nativeAnnotationReviewBlockReason,
  nativeAnnotationReviewNeedsObservation,
  prepareNativeAnnotationReview,
  observeNativeAnnotationReopen,
} from '../annotation-native-review';
import {
  reviewSelectedAnnotationOutput,
  applyAnnotationOutputReview,
} from '../annotation-output-review';
import { notifySavedAnnotationDocument } from '../annotation-save-recovery';
import { hydrateAnnotationOperationReview } from '../annotation-operation-review';
import { managedOperations } from '../../../services/managed-operations';
import {
  commitReviewedAnnotations,
  resolveDraftForViewerAnnotation,
} from '../annotation-review-utils';
import { useToastStore } from '../../../stores/toast-store';
import { useSequenceEditModeStore } from '../../../stores/sequence-edit-mode-store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { sequenceEditorSession, useSequenceStore, type AnnotationEditPatch } from '../store';
import {
  useRichSequenceClipboard,
  type ReReadPastedFeatures,
} from '../../sequence-clipboard/public/use-rich-sequence-clipboard';
import { useAlignmentDerivedState } from '../../alignment-manager/public/hooks/useAlignmentDerivedState';
import { useVerificationStore } from '../../alignment-manager/public/store';
import { selectAlignmentQueryFiles } from '../../alignment-manager/public/select-alignment-query-files';
import type {
  CoordinateSpace,
  MutationMarker,
  AnnotationStateIdentity,
  EditorPendingPrimerBinding,
  PrimerDisplay,
} from '@waypoint/workspace-editor';
import { annotationIdentityEqual } from '@waypoint/workspace-editor';
import {
  buildExtendedCdsPreviewForEnds,
  cdsExtensionKeyFor,
  extensionQualifiersForSavedRow,
} from '@waypoint/workspace-editor';
import { gappedToBioClamped } from '@waypoint/workspace-editor';
import { getCDSTranslation } from '@waypoint/workspace-editor';
import { recordProtein } from '../../proteins/public/record-proteins';
import {
  CreateAminoAcidSequenceDialog,
  type PendingAminoAcidCreation,
} from '../../proteins/public/components/CreateAminoAcidSequenceDialog';
import { openLimsEntity } from '../../lims/public/open-entity';
import { getFeatureColor } from '@waypoint/sequence-utils';
import type { Annotation } from '@waypoint/sequence-utils';
import type { DraftQualifiers } from '../types';
import { SequenceTabInfoChrome } from './SequenceTabInfoChrome';
import { AssemblyEditUnsavedDialog } from './AssemblyEditUnsavedDialog';

import { resolveSequenceGeneticCode, type GeneticCodeSpec } from '@waypoint/sequence-utils';
import { useGeneticCodePrompt } from '../use-genetic-code-prompt';
import { SequenceTabWorkspaceCanvas } from './SequenceTabWorkspaceCanvas';
import { buildSharedAlignmentProjection } from './shared-alignment-projection';
import { buildSharedSequenceAxis } from './shared-sequence-read-model';
import { resolveAlignmentMutationNavigation } from './alignment-mutation-navigation';
import { SequenceTabStatus } from './SequenceTabStatus';
import { SequenceHistoryNotice } from './SequenceHistoryNotice';
import {
  sequenceTabCoordinateSpace,
  sequenceTabDiffViewActive,
  sequenceTabIsCircular,
  sequenceTabManagedDocument,
  sequenceTabWorkspaceRoot,
} from './sequence-tab-flags';
import { useReferenceHighlight } from '../hooks/useReferenceHighlight';
import { SequenceErrorBoundary } from './SequenceErrorBoundary';
import { useAnnotationRun } from '../hooks/useAnnotationRun';
import { shouldEnableTestBridge } from '@/lib/test-bridge-gate';
import {
  type ActivateFromViewerBridge,
  registerGetAnnotationDraft,
  registerSaveActiveSequence,
  registerSelectAnnotationInViewer,
} from '../activate-from-viewer-bridge';
import {
  drawerRequiresEditingAccess,
  useDrawerState,
  type DrawerType,
} from '../hooks/useDrawerState';
import {
  assertWorkspaceEditorsSettled,
  getWorkspaceEditorBlockers,
} from '../../../services/workspace-editor-mutation-state';
import { useManagedSequenceRenameRequest } from '../public/managed-sequence-rename';
import { useMetadataEditRequest } from '../../canvas/public/use-metadata-edit-request';
import { useManagedSequenceMetadataRequest } from '../public/managed-sequence-metadata';
import { useSequenceTabViewerAnnotationGestures } from '../hooks/useSequenceTabViewerAnnotationGestures';
import { candidatePrimerDisplaysFromSearch } from '../candidate-primer-displays';
import { annotationVisibilityKey } from './annotations-drawer';
import { useCanvasStore } from '../../canvas/public/store';
import { useGitDiff } from '../hooks/useGitDiff';
import { useGitHistory } from '../hooks/useGitHistory';
import { useSequencePackageHistory } from '../hooks/useSequencePackageHistory';
import type { SequenceRestoreApplyRequest } from '../../../shared/sequence-package-revision';
import { applySequencePackageRestoreWithDelivery } from '../apply-sequence-package-restore';
import { isHostedBrowserRuntime } from '../../../utils/environment';
import { hostedDocumentIdentity } from '../../../hosted/document-identity';
import { useSequencePersistence } from '../hooks/useSequencePersistence';
import { completeSequenceDocumentSave } from '../complete-sequence-document-save';
import { useSequenceAutoSave } from '../hooks/useSequenceAutoSave';
import { useChangeNavigation } from '../hooks/useChangeNavigation';
import { useAnnotationEditing } from '../hooks/useAnnotationEditing';
import { diffToDecorations } from '../diff/diff-decorations';
import { diffToGappedAlignment } from '../diff/diff-alignment';

import type { SequenceViewMode } from './SequenceViewerModeToggle';
import { useSequenceViewState } from '../view-state/useSequenceViewState';
import type {
  SequenceMapLayout,
  SequenceRendererVisibility,
} from '../view-state/sequence-view-state';

import { useExternalResourceInvalidationListener } from '../../structure-drawer/public/hooks/useExternalResourceInvalidationListener';
import { useStructureDrawerStore } from '../../structure-drawer/public';
import { buildStructureDrawerRequestFromAnnotation } from '../../structure-drawer/public/api/build-structure-request';
import { registerViewStructureByLabelHandler } from '../../structure-drawer/public/api/view-structure-handler-registry';
import { sourceCdsIdentityForRequest } from '../../structure-drawer/public/utils/source-cds-identity';

import type { PrimerAutoScopeRequest } from '../../primers/public/components/PrimerSearchPanel';
import { usePrimers } from '../../primers/public/hooks/usePrimers';
import { usePrimerSearch } from '../../primers/public/hooks/usePrimerSearch';
import type { BoundPrimer, PrimerDirection, CreatePrimerInput } from '../../primers/public/types';
import { dbPrimerToPrimerDisplay } from '../../primers/public/adapters';
import {
  persistRichPastePrimerBindings,
  hasRichPastePrimerBindingOwnership,
} from '../../sequence-clipboard/public/persist-primer-bindings';
import { ensureSequenceIdentity } from '../../../db';
import { isDeveloperImportSourcePath } from '../../../shared/developer-import-sources';
import { findWorkspaceRootForPath } from '../../../db/workspace-catalog';
import { useReopenAcceptedAssembly } from '../../assembly/public/hooks/useReopenAcceptedAssembly';
import {
  stageHistoricalAssemblyComponents,
  type StageHistoricalAssemblyComponentsInput,
} from '../../assembly/public/historical-component-workflow';
import { forgetFinalizedPlasmid } from '../../assembly/public/plasmid-identity';
import { platform } from '../../../platform';

import { emitLimsRegistrationChanged } from '../../lims/public/events';
import { trackToolOpened } from '../../../lib/analytics';
import { beginWorkflowAction, observeWorkflowAction } from '../../../lib/workflow-telemetry';
import { isPathInsideBoundary } from '../../../shared/path-boundary';
import {
  ALIGNMENT_QUERY_FILE_FILTERS,
  pendingAlignmentFilesFromSelection,
  type PendingAlignmentFile,
} from '../alignment-file-selection';
import { selectionToAnnotationBoundaryRange } from '../annotation-boundaries';
import type { WireRange } from './annotations-drawer/plannotate-range';
import { askAiAboutSelection } from '../../ai/public/ask-ai-about-selection';
import { buildAskAiSelectionInput, type AskAiViewerPayload } from './ask-ai-selection-input';
import { commitVisibleFileOpen, failPendingFileOpen } from '../file-open-telemetry';
import {
  sequenceDocumentKey,
  type SequenceDocumentRef,
} from '../../../shared/managed-sequence-document';

import {
  boundPrimerForDisplay,
  copyPrimerRecord,
  primerArtifactLocation,
} from '../primer-menu-actions';
import type { QuickLookPackageReceipt } from '../../../shared/file-association-ipc';

import { managedSequenceRepository } from '../managed-sequence-repository';
import {
  sequenceDisplayName,
  type SequencePresentation,
} from '../../../shared/sequence-presentation';
import { requestQuickLookImport } from '../../../stores/quick-look-import-store';
import { LimsRegistrationBadge } from '../../lims/public/registration-badge';
import { ManagedSequenceRegistrationBadge } from './ManagedSequenceRegistrationBadge';
import { DeepShareControl } from '../../deep-share/public/deep-share-control';

type CanvasSelectionRange = { start: number; end: number; wraps?: boolean };
const ANNOTATION_DRAFT_SOURCE = 'annotation-draft';

interface SequenceTabProps {
  tabId: string;
  filePath: string;
  documentRef: SequenceDocumentRef;
  presentation: SequencePresentation;

  readOnly?: boolean;
  quickLookSource?: QuickLookPackageReceipt;
}

export function SequenceTab({
  tabId,
  filePath,
  documentRef,
  presentation,
  readOnly: intrinsicReadOnly = false,
  quickLookSource,
}: SequenceTabProps) {
  const owningPaths = useMemo(() => [filePath], [filePath]);
  const editFolders = useProjectEditFolders(owningPaths);
  const readOnly = intrinsicReadOnly || projectPathIsReadOnly(filePath, editFolders);
  const sequenceDocumentId = sequenceDocumentKey(documentRef);
  const managedDocument = sequenceTabManagedDocument(documentRef);
  const isActiveView = useCanvasStore((state) =>
    Object.values(state.panels).some((panel) => panel.activeTabId === tabId)
  );

  const savedAnnotationReviewsAtMount = useRef(
    Object.values(useAnnotationReviewStore.getState().sessions).filter(
      (review) => review.documentId === sequenceDocumentId && review.disposition === 'applied'
    )
  );
  const requestEditMode = useSequenceEditModeStore((state) => state.requestEdit);
  const requestSequenceEdit = useCallback(
    (documentId: string) => {
      if (
        readOnly ||
        documentId !== sequenceDocumentId ||
        isNativeSequenceClientInputPending(documentId)
      )
        return;

      const alignments = useVerificationStore.getState();
      const session = alignments.getActiveSession(documentId);
      if (session)
        alignments.setSessionViewPreferences(documentId, session.id, { alignmentVisible: false });
      requestEditMode(documentId);
    },
    [readOnly, requestEditMode, sequenceDocumentId]
  );
  const [isViewerEditMode, setIsViewerEditMode] = useState(false);
  const selectedQuickLookRecord = quickLookSource?.records.find(
    (record) =>
      managedDocument && isPathInsideBoundary(record.productPath, managedDocument.packageRoot)
  );
  const selectQuickLookRecord = useCallback(
    (recordId: string): void => {
      if (!quickLookSource || recordId === selectedQuickLookRecord?.recordId) return;
      const record = quickLookSource.records.find((candidate) => candidate.recordId === recordId);
      if (!record) return;
      void (async () => {
        try {
          const resolved = await managedSequenceRepository.findByMemberPath(record.productPath);
          if (!resolved) {
            useToastStore
              .getState()
              .addToast(userMessage('notice.could-not-open-that-quick-look-record'), {
                definition: 'sequence-tab-could-not-open-that-quick-look-record',
              });
            return;
          }
          const canvas = useCanvasStore.getState();
          const panel = Object.values(canvas.panels).find((p) =>
            p.tabs.some(
              (t) =>
                t.id === tabId &&
                t.quickLookSource === quickLookSource &&
                t.sequenceDocument === documentRef
            )
          );
          if (panel)
            canvas.retargetTab(
              panel.id,
              tabId,
              { type: 'sequence', sequenceDocument: resolved.ref },
              {
                label: resolved.document.name || record.displayName,
                readOnly: true,
                quickLookSource,
                sourceFileName: quickLookSource.sourceFileName,
              }
            );
        } catch (error) {
          console.error('[SequenceTab] Could not open Quick Look record:', error);
          useToastStore
            .getState()
            .addToast(userMessage('notice.could-not-open-that-quick-look-record'), {
              definition: 'sequence-tab-could-not-open-that-quick-look-record',
            });
        }
      })();
    },
    [documentRef, quickLookSource, selectedQuickLookRecord?.recordId, tabId]
  );

  useExternalResourceInvalidationListener();

  const {
    data: storedSequence,
    isLoading,
    editingPending,
    error,
    errorClass,
  } = useSequence(filePath, sequenceDocumentId);

  useEffect(() => {
    if (
      !isActiveView ||
      isLoading ||
      !storedSequence ||
      savedAnnotationReviewsAtMount.current.length === 0
    )
      return;
    const savedReviews = savedAnnotationReviewsAtMount.current;
    savedAnnotationReviewsAtMount.current = [];
    void observeNativeAnnotationReopen(sequenceDocumentId, storedSequence, savedReviews).catch(
      () => {}
    );
  }, [isActiveView, isLoading, storedSequence, sequenceDocumentId]);

  const [cdsExtensionDraft, setCdsExtensionDraft] = useState<{
    key: string;
    original: Annotation;

    ends: Array<'five-prime' | 'three-prime'>;
  } | null>(null);

  const cdsExtensionDraftExtended = useMemo(() => {
    if (!storedSequence || !cdsExtensionDraft) return null;
    const annotations = storedSequence.annotations ?? [];

    const index = annotations.findIndex((a) => cdsExtensionKeyFor(a) === cdsExtensionDraft.key);
    const live = index < 0 ? null : annotations[index];
    if (!live) return null;
    const extended = buildExtendedCdsPreviewForEnds(live, storedSequence.sequence, {
      drafted: cdsExtensionDraft.ends,
      circular: storedSequence.circular === true,
    });
    return extended ? { index, extended } : null;
  }, [storedSequence, cdsExtensionDraft]);

  const sequence = useMemo(() => {
    if (!storedSequence || !cdsExtensionDraftExtended) return storedSequence;
    const annotations = storedSequence.annotations ?? [];
    const next = annotations.slice();
    next[cdsExtensionDraftExtended.index] = cdsExtensionDraftExtended.extended;
    return { ...storedSequence, annotations: next };
  }, [storedSequence, cdsExtensionDraftExtended]);

  useEffect(() => {
    if (!cdsExtensionDraft) return;
    const stillThere = (storedSequence?.annotations ?? []).some(
      (a) => cdsExtensionKeyFor(a) === cdsExtensionDraft.key
    );
    if (!stillThere) setCdsExtensionDraft(null);
  }, [cdsExtensionDraft, storedSequence?.annotations]);
  useEffect(() => {
    if (error) {
      failPendingFileOpen(sequenceDocumentId, errorClass ?? 'filesystem');
      return;
    }
    if (!isLoading && sequence) commitVisibleFileOpen(sequenceDocumentId);
  }, [error, errorClass, isLoading, sequence, sequenceDocumentId]);
  const acceptedAssemblyReopen = useReopenAcceptedAssembly(sequenceDocumentId, filePath);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const primerWorkspaceRoot = useMemo(
    () => findWorkspaceRootForPath(workspaceFolders, filePath),
    [workspaceFolders, filePath]
  );
  const packageHistory = useSequencePackageHistory(managedDocument, primerWorkspaceRoot);

  const proteinSaveLocationRoots = useMemo(() => {
    const list = workspaceFolders.map((f) => ({ path: f.path, name: f.name }));
    if (list.length === 0 && primerWorkspaceRoot) {
      list.push({
        path: primerWorkspaceRoot,
        name: primerWorkspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? primerWorkspaceRoot,
      });
    }
    return list;
  }, [workspaceFolders, primerWorkspaceRoot]);

  const {
    activeDrawer,
    isDrawerOpen,
    drawerWidth,
    toggleDrawer: toggleDrawerUnchecked,
    openDrawer: openDrawerUnchecked,
    closeDrawer: closeDrawerUnchecked,
    getDrawerWidth,
    setDrawerWidth,
    editTargetIndex,
    openToAnnotation: openToAnnotationUnchecked,
    clearEditTarget,
  } = useDrawerState(sequenceDocumentId);
  const [metadataDirty, setMetadataDirty] = useState(false);
  const canLeaveMetadata = useCallback((): boolean => {
    if (activeDrawer !== 'metadata' || !managedDocument) return true;
    const pendingMetadata = getWorkspaceEditorBlockers({
      workspaceRoot: managedDocument.packageRoot,
      affectedEntityIds: [managedDocument.packageId],
    }).some(
      (editor) =>
        editor.entityId === managedDocument.packageId &&
        editor.path === managedDocument.packageRoot &&
        editor.state !== 'clean'
    );
    if (!pendingMetadata) return true;
    useToastStore
      .getState()
      .addToast(
        userMessage('notice.save-or-cancel-the-unfinished-metadata-edits-before-switching-views'),
        {
          definition: 'sequence-metadata-finish-edits-before-switching-views',
        }
      );
    return false;
  }, [activeDrawer, managedDocument]);
  const toggleDrawer = useCallback(
    (drawer: DrawerType) => {
      if (activeDrawer === 'metadata' && !canLeaveMetadata()) return;
      toggleDrawerUnchecked(drawer);
    },
    [activeDrawer, canLeaveMetadata, toggleDrawerUnchecked]
  );
  const openDrawer = useCallback(
    (drawer: DrawerType) => {
      if (drawer !== 'metadata' && !canLeaveMetadata()) return;
      openDrawerUnchecked(drawer);
    },
    [canLeaveMetadata, openDrawerUnchecked]
  );
  const closeDrawer = useCallback(() => {
    if (!canLeaveMetadata()) return;
    closeDrawerUnchecked();
  }, [canLeaveMetadata, closeDrawerUnchecked]);
  const openToAnnotation = useCallback(
    (index: number) => {
      if (!canLeaveMetadata()) return;
      openToAnnotationUnchecked(index);
    },
    [canLeaveMetadata, openToAnnotationUnchecked]
  );
  const alignmentReviewRequestId = useCanvasStore(
    (state) =>
      Object.values(state.panels)
        .flatMap((panel) => panel.tabs)
        .find((tab) => tab.id === tabId)?.viewState?.alignmentReviewRequestId
  );
  useEffect(() => {
    if (alignmentReviewRequestId) openDrawer('alignments');
  }, [alignmentReviewRequestId, openDrawer]);
  const [metadataNameEditRequestId, setMetadataNameEditRequestId] = useState(0);
  useMetadataEditRequest(tabId, 'sequence', () => {
    openDrawer('metadata');
    return false;
  });
  const openMetadataForRename = useCallback(
    (requestId: number) => {
      openDrawer('metadata');
      setMetadataNameEditRequestId(requestId);
    },
    [openDrawer]
  );
  useManagedSequenceRenameRequest(managedDocument?.packageId, openMetadataForRename);
  useManagedSequenceMetadataRequest(sequenceDocumentId, () => openDrawer('metadata'));

  useEffect(() => {
    if (readOnly && drawerRequiresEditingAccess(activeDrawer, Boolean(managedDocument))) {
      closeDrawer();
    }
  }, [activeDrawer, closeDrawer, managedDocument, readOnly]);

  const structureDrawerEntityId = useStructureDrawerStore((state) =>
    state.status === 'idle' ? null : (state.request?.entityId ?? null)
  );
  const hasAssociatedStructure = structureDrawerEntityId === sequenceDocumentId;
  const handleRestrictionEnzymeDrawerOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openDrawer('restriction-enzymes');
        return;
      }
      if (activeDrawer === 'restriction-enzymes') {
        closeDrawer();
      }
    },
    [activeDrawer, closeDrawer, openDrawer]
  );

  const exitReviewMode = useAnnotationReviewStore((state) => state.exitReviewMode);
  const selectDraft = useAnnotationReviewStore((state) => state.selectDraft);
  const toggleDraftAccepted = useAnnotationReviewStore((state) => state.toggleDraftAccepted);
  const acceptRange = useAnnotationReviewStore((state) => state.acceptRange);
  const setRangeAccepted = useAnnotationReviewStore((state) => state.setRangeAccepted);
  const acceptAll = useAnnotationReviewStore((state) => state.acceptAll);
  const rejectAll = useAnnotationReviewStore((state) => state.rejectAll);
  const getAcceptedDrafts = useAnnotationReviewStore((state) => state.getAcceptedDrafts);
  const session = useAnnotationReviewStore((state) => state.getSession(sequenceDocumentId));
  const isTargetSequence = session !== undefined;
  const highlightRequest = session?.highlightRequest ?? null;
  const drafts = useMemo(() => session?.drafts ?? [], [session?.drafts]);

  const editorSession = useMemo(
    () => sequenceEditorSession(sequenceDocumentId),
    [sequenceDocumentId]
  );
  const sequenceVersion = useSequenceStore(
    (state) => state.sequenceVersions[sequenceDocumentId] ?? 0
  );
  const savedVersion = useSequenceStore((state) => state.savedVersions[sequenceDocumentId] ?? 0);
  const hasPendingSequenceEdits = useSequenceStore(
    (state) => state.dirtyPaths[sequenceDocumentId] === true
  );

  const resumePendingEdits = useSequenceStore((state) =>
    state.hasPendingSequenceEdits(sequenceDocumentId)
  );
  const [primerSequenceId, setPrimerSequenceId] = useState<number | null>(null);

  const sequenceBasename = presentation.name;

  const pendingCommitMessageRef = useRef<string | null>(null);

  const persistPendingPrimerBindings = useCallback(
    async (
      bindings: EditorPendingPrimerBinding[],
      context: { draftLineageId: string; expectedFileSha256: string }
    ) => {
      if (primerSequenceId == null || !primerWorkspaceRoot) {
        if (
          bindings.length === 0 &&
          !(await hasRichPastePrimerBindingOwnership(sequenceDocumentId, context.draftLineageId))
        )
          return;
        throw new Error('The target sequence does not have a project primer identity yet.');
      }

      await persistRichPastePrimerBindings({
        bindings,
        draftLineageId: context.draftLineageId,
        expectedFileSha256: context.expectedFileSha256,
        targetDocumentId: sequenceDocumentId,
        targetFilePath: filePath,
        targetSequenceId: primerSequenceId,
        targetWorkspaceRoot: primerWorkspaceRoot,
      });
    },
    [filePath, primerSequenceId, primerWorkspaceRoot, sequenceDocumentId]
  );

  const {
    diffResult,
    annotationDiff,
    status: gitDiffStatus,
    refreshHeadContent,
    recomputeNow,
  } = useGitDiff(tabId, filePath, sequence?.sequence ?? null, sequence?.annotations ?? null);

  const changedAnnotationNames = useMemo(() => {
    if (!annotationDiff) return undefined;
    const names = new Set<string>();
    for (const change of annotationDiff.changes) {
      if (change.type === 'added' || change.type === 'modified') {
        names.add(change.name);
      }
    }
    return names.size > 0 ? names : undefined;
  }, [annotationDiff]);

  const {
    isDirty,
    isSaving,
    save,
    showExternalChangeToast,
    acceptExternalChange,
    dismissExternalChange,
    reloadFromDisk,
  } = useSequencePersistence({
    documentId: sequenceDocumentId,
    filePath,
    sequence: sequence ?? null,
    readOnly,
    getCommitMessage: () => pendingCommitMessageRef.current ?? `Auto-save ${sequenceBasename}`,
    onSaveComplete: async (publication) => {
      recomputeNow();
      const message = pendingCommitMessageRef.current ?? `Auto-save ${sequenceBasename}`;
      pendingCommitMessageRef.current = null;
      return completeSequenceDocumentSave(
        { documentId: sequenceDocumentId, sourcePath: filePath },
        message,
        publication
      );
    },
    onExternalReload: () => {
      refreshHeadContent();
      emitLimsRegistrationChanged({ documentId: sequenceDocumentId, filePath });
    },
    persistPendingPrimerBindings,
  });

  useEffect(() => {
    const bridge = (window as Window & { __test?: ActivateFromViewerBridge }).__test;
    if (!bridge) return;
    return registerSaveActiveSequence(bridge, sequenceDocumentId, save);
  }, [save, sequenceDocumentId]);

  useDocumentLifecycle({
    target: { kind: 'sequence-document', documentId: sequenceDocumentId },
    tabId,
    isDirty: () =>
      Boolean(useSequenceStore.getState().dirtyPaths[sequenceDocumentId]) || metadataDirty,
    save: async () => {
      if (metadataDirty) {
        useToastStore
          .getState()
          .addToast(
            userMessage(
              'notice.save-or-cancel-the-unfinished-metadata-edits-in-its-drawer-before-clos'
            ),
            { definition: 'sequence-save-close-metadata-draft-must-be-resolved' }
          );
        return false;
      }
      await save();
      return useSequenceStore.getState().dirtyPaths[sequenceDocumentId] !== true;
    },
    discard: () => {
      useSequenceStore.getState().discardEdits(sequenceDocumentId);
    },
  });

  const {
    log: gitLog,
    isLoading: gitLogLoading,
    isGitRepo: isFileInGitRepo,
    selectedCommitHash,
    selectedCommitSequence,
    selectCommit: selectGitCommit,
    clearSelection: clearGitSelection,
    commitFile: gitCommitFile,
    revertFile: gitRevertFile,
    refreshLog: refreshGitHistoryLog,
  } = useGitHistory({
    filePath,
    readOnly: readOnly || Boolean(filePath && isDeveloperImportSourcePath(filePath)),
    onRevert: refreshHeadContent,
    onCommit: refreshHeadContent,
  });

  const { flush: flushAutoSave } = useSequenceAutoSave({
    editEpoch: sequenceVersion,
    isDirty,
    save,
    enabled: false,
  });

  useEffect(() => {
    const handleWorkspaceReconciled = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string | null; workspaceRoot?: string | null }>)
        .detail;
      if (detail?.path && detail.path !== filePath) return;
      const workspaceRoot = detail?.workspaceRoot?.replace(/\/+$/, '');
      if (!detail?.path && workspaceRoot && !isPathInsideBoundary(filePath, workspaceRoot)) {
        return;
      }

      refreshHeadContent();
      refreshGitHistoryLog();
    };

    window.addEventListener('waypoint:workspace-reconciled', handleWorkspaceReconciled);
    return () => {
      window.removeEventListener('waypoint:workspace-reconciled', handleWorkspaceReconciled);
    };
  }, [filePath, refreshHeadContent, refreshGitHistoryLog]);

  const [isDiffViewActive, setIsDiffViewActive] = useState(false);

  useEffect(() => {
    if (activeDrawer !== 'git-history') {
      setIsDiffViewActive(false);
    }
  }, [activeDrawer]);

  useEffect(() => {
    if (activeDrawer === 'git-history' && !isDirty) {
      void reloadFromDisk();
    }
  }, [activeDrawer, isDirty, reloadFromDisk]);

  useEffect(() => {
    return useStructureDrawerStore.subscribe((state) => {
      if (state.status === 'idle') return;
      if (state.request?.entityId !== sequenceDocumentId) return;
      if (handledStructureRequestIdRef.current === state.requestId) return;
      handledStructureRequestIdRef.current = state.requestId;
      if (
        !Object.values(useCanvasStore.getState().panels).some(
          (panel) => panel.activeTabId === tabId
        )
      )
        return;
      if (activeDrawerRef.current !== 'structure') {
        flushSync(() => {
          openDrawer('structure');
        });
      }
    });
  }, [openDrawer, sequenceDocumentId, tabId]);

  const activeDrawerRef = useRef(activeDrawer);
  activeDrawerRef.current = activeDrawer;
  const handledStructureRequestIdRef = useRef(useStructureDrawerStore.getState().requestId);
  const structureDrawerRequest = useStructureDrawerStore((s) => s.request);
  const structureDrawerStatus = useStructureDrawerStore((s) => s.status);

  const headDiffCoordinateSpace = useMemo(() => {
    if (!isDiffViewActive || !diffResult?.oldGapped || !diffResult?.newGapped) return undefined;
    return {
      mode: 'gapped' as const,
      gappedSequence: diffResult.newGapped,
      alignedQuery: diffResult.oldGapped,
    };
  }, [isDiffViewActive, diffResult]);

  const ungappedToGapped = useMemo((): number[] => {
    if (!headDiffCoordinateSpace) return [];
    const { gappedSequence } = headDiffCoordinateSpace;
    const map: number[] = [];
    for (let gappedIdx = 0; gappedIdx < gappedSequence.length; gappedIdx++) {
      if (gappedSequence[gappedIdx] !== '-') {
        map.push(gappedIdx);
      }
    }
    return map;
  }, [headDiffCoordinateSpace]);

  const commitDiffCacheRef = useRef<{
    commitSeq: string;
    currentSeq: string;
    result: { mode: 'gapped'; gappedSequence: string; alignedQuery: string };
  } | null>(null);

  const gitDiffCoordinateSpace = useMemo(() => {
    if (!selectedCommitSequence || !sequence) return undefined;
    const commitSeq = selectedCommitSequence.sequence;
    const currentSeq = sequence.sequence;

    const cache = commitDiffCacheRef.current;
    if (cache && cache.commitSeq === commitSeq && cache.currentSeq === currentSeq) {
      return cache.result;
    }
    const { oldGapped, newGapped } = diffToGappedAlignment(commitSeq, currentSeq);
    const result = {
      mode: 'gapped' as const,
      gappedSequence: newGapped,
      alignedQuery: oldGapped,
    };
    commitDiffCacheRef.current = { commitSeq, currentSeq, result };
    return result;
  }, [selectedCommitSequence, sequence]);

  const activeDiffSpace = sequenceTabCoordinateSpace(
    undefined,
    headDiffCoordinateSpace,
    gitDiffCoordinateSpace
  );
  const isAnyDiffViewActive = sequenceTabDiffViewActive(isDiffViewActive, gitDiffCoordinateSpace);

  const diffViewMutations = useMemo((): MutationMarker[] => {
    if (!activeDiffSpace) return [];
    const { gappedSequence: newGapped, alignedQuery: oldGapped } = activeDiffSpace;
    const markers: MutationMarker[] = [];
    for (let i = 0; i < newGapped.length; i++) {
      const newBase = newGapped[i];
      const oldBase = oldGapped[i];
      if (newBase === oldBase) continue;
      const isNewGap = newBase === '-';
      const isOldGap = oldBase === '-';
      if (isNewGap && isOldGap) continue;
      markers.push({
        column: i,
        type: isOldGap ? 'insertion' : isNewGap ? 'deletion' : 'substitution',
        refBase: newBase,
        queryBase: oldBase,
      });
    }
    return markers;
  }, [activeDiffSpace]);

  const handleEditCommit = useCallback(async () => {
    if (readOnly) return;
    return save();
  }, [readOnly, save]);
  const handleEditDiscard = useCallback(
    () => useSequenceStore.getState().discardEdits(sequenceDocumentId),
    [sequenceDocumentId]
  );
  const [assemblyEditDecisionOpen, setAssemblyEditDecisionOpen] = useState(false);
  const [assemblyEditDecisionBusy, setAssemblyEditDecisionBusy] = useState(false);
  const [assemblyEditDecisionError, setAssemblyEditDecisionError] = useState<string | null>(null);
  const requestAssemblyEdit = useCallback(async () => {
    if (metadataDirty) {
      useToastStore
        .getState()
        .addToast(
          userMessage(
            'notice.update-entity-or-discard-the-unfinished-metadata-changes-before-editin'
          ),
          { definition: 'sequence-metadata-finish-edits-before-switching-views' }
        );
      return;
    }
    if (useSequenceStore.getState().isDirty(sequenceDocumentId)) {
      setAssemblyEditDecisionError(null);
      setAssemblyEditDecisionOpen(true);
      return;
    }
    await acceptedAssemblyReopen.reopen();
  }, [acceptedAssemblyReopen, metadataDirty, sequenceDocumentId]);
  const resolveAssemblyEditDecision = useCallback(
    async (choice: 'save' | 'discard' | 'cancel') => {
      if (assemblyEditDecisionBusy) return;
      if (choice === 'cancel') {
        setAssemblyEditDecisionOpen(false);
        setAssemblyEditDecisionError(null);
        return;
      }
      setAssemblyEditDecisionBusy(true);
      setAssemblyEditDecisionError(null);
      try {
        if (choice === 'save') {
          const saved = await save();
          if (!saved || useSequenceStore.getState().isDirty(sequenceDocumentId)) {
            throw new Error('The sequence could not be saved. Its edits are still open.');
          }
        } else {
          handleEditDiscard();
        }
        setAssemblyEditDecisionOpen(false);
        await acceptedAssemblyReopen.reopen();
      } catch (error) {
        setAssemblyEditDecisionError(
          toUserMessage(error, 'failure.the-assembly-editor-could-not-open')
        );
      } finally {
        setAssemblyEditDecisionBusy(false);
      }
    },
    [acceptedAssemblyReopen, assemblyEditDecisionBusy, handleEditDiscard, save, sequenceDocumentId]
  );
  const applyPackageRestore = useCallback(
    async (request: SequenceRestoreApplyRequest): Promise<void> => {
      if (
        !managedDocument ||
        !primerWorkspaceRoot ||
        request.packageId !== managedDocument.packageId
      ) {
        throw new Error('The current sequence is not the requested managed package.');
      }
      if (metadataDirty || useSequenceStore.getState().isDirty(sequenceDocumentId)) {
        throw new Error('Resolve unsaved sequence and Metadata edits before applying Restore.');
      }
      const result = await applySequencePackageRestoreWithDelivery(request);
      if (result.delivery.git === 'failed' || result.delivery.git === 'unverified-replay') {
        useToastStore
          .getState()
          .addToast(
            result.delivery.git === 'failed'
              ? userMessage('operation.failed')
              : userMessage(
                  'notice.restore-was-already-published-its-git-delivery-could-not-be-verified-w'
                ),
            { definition: 'sequence-restore-git-delivery-incomplete' }
          );
      }

      if (!useSequenceStore.getState().isDirty(sequenceDocumentId)) await reloadFromDisk();
      packageHistory.refresh();
    },
    [
      managedDocument,
      metadataDirty,
      packageHistory,
      primerWorkspaceRoot,
      reloadFromDisk,
      sequenceDocumentId,
    ]
  );
  const handleSequenceTopologySaved = useCallback(
    (documentId: string, circular: boolean) =>
      useSequenceStore.getState().patchSavedMetadata(documentId, { circular }),
    []
  );

  const handleSequenceGeneticCodeSaved = useCallback(
    (documentId: string, savedGeneticCode: GeneticCodeSpec | null) =>
      useSequenceStore.getState().patchSavedMetadata(documentId, {
        chosenGeneticCode: savedGeneticCode ?? undefined,

        unreadableGeneticCode: undefined,
      }),
    []
  );

  const openInFocusedPanel = useCanvasStore((s) => s.openInFocusedPanel);

  const allRulerDecorations = useMemo(() => {
    return diffResult ? diffToDecorations(diffResult) : [];
  }, [diffResult]);

  const [drawerTab, setDrawerTab] = useState<'annotations' | 'plannotate'>('annotations');
  const [pendingAlignmentFiles, setPendingAlignmentFiles] = useState<PendingAlignmentFile[]>([]);

  const [reviewHighlight, setReviewHighlight] = useState<{
    start: number;
    end: number;
    wraps?: boolean;
  } | null>(null);
  const [scrollToPosition, setScrollToPosition] = useState<number | null>(null);
  const [changeHighlight, setChangeHighlight] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const lastHighlightTimestamp = useRef<number>(0);

  useChangeNavigation(diffResult?.changes ?? [], scrollToPosition ?? 0, (pos) => {
    setScrollToPosition(pos + 1);
  });

  const {
    highlightRange: referenceHighlight,
    scrollPosition: referenceScrollPosition,
    navigationRequestId: referenceNavigationRequestId,
    onHighlightApplied: clearReferenceHighlight,
    onScrollApplied: clearReferenceScroll,
  } = useReferenceHighlight(sequenceDocumentId);

  const {
    status: annotateStatus,
    operationId: annotationOperationId,
    data: annotateData,
    error: annotateError,
    unavailableReason: annotateUnavailableReason,
    execute: executeAnnotate,
  } = useAnnotationRun(sequenceDocumentId);

  const processedJobIdRef = useRef<string | null>(null);
  const autoAnnotateApiError = null;
  const reviewPresentation = useAnnotationOperationState(
    (state) => state.presentationRequests[sequenceDocumentId]
  );
  const consumedReviewPresentation = useRef<string>();

  useEffect(() => {
    if (!reviewPresentation || reviewPresentation.requestId === consumedReviewPresentation.current)
      return;
    consumedReviewPresentation.current = reviewPresentation.requestId;
    openDrawer('annotations');
    setDrawerTab('plannotate');
  }, [reviewPresentation, openDrawer]);

  useEffect(() => {
    if (annotateStatus !== 'success' || !annotateData || !sequence || !annotationOperationId)
      return;
    if (useAnnotationReviewStore.getState().getSession(sequenceDocumentId)?.outputImport) {
      processedJobIdRef.current = annotationOperationId;
      return;
    }
    if (processedJobIdRef.current === annotationOperationId) return;
    const operation = managedOperations
      .getSnapshot()
      .records.find((record) => record.snapshot.id === annotationOperationId)?.snapshot;
    if (!operation) return;
    processedJobIdRef.current = annotationOperationId;
    hydrateAnnotationOperationReview(operation, annotateData, sequence);
    void prepareNativeAnnotationReview(annotationOperationId);
  }, [annotateStatus, annotateData, annotationOperationId, sequence, sequenceDocumentId]);

  useEffect(() => {
    if (!session?.operationId || !session.inputRevision || session.disposition !== 'in-review')
      return;
    const operationId = session.operationId;
    useAnnotationReviewStore
      .getState()
      .setOperationBlockedReason(
        operationId,
        hasPendingSequenceEdits ? userMessage('annotation.unsavedEdits') : undefined
      );
  }, [session?.operationId, session?.inputRevision, session?.disposition, hasPendingSequenceEdits]);

  useEffect(() => {
    if (
      !session?.operationId ||
      session.disposition !== 'in-review' ||
      session.nativeApplyPending ||
      hasPendingSequenceEdits ||
      session.nativeInspection?.status !== 'ready' ||
      session.nativeInspection.savedVersion === savedVersion ||
      nativeAnnotationReviewNeedsObservation(session.nativeApplyResult)
    )
      return;
    void prepareNativeAnnotationReview(session.operationId, { refresh: true });
  }, [
    session?.operationId,
    session?.disposition,
    session?.nativeApplyPending,
    session?.nativeInspection,
    session?.nativeApplyResult,
    hasPendingSequenceEdits,
    savedVersion,
  ]);

  useEffect(() => {
    if (
      isTargetSequence &&
      activeDrawer === 'annotations' &&
      highlightRequest &&
      highlightRequest.timestamp !== lastHighlightTimestamp.current
    ) {
      lastHighlightTimestamp.current = highlightRequest.timestamp;
      setReviewHighlight({
        start: highlightRequest.start,
        end: highlightRequest.end,
        wraps: highlightRequest.wraps,
      });
      setScrollToPosition(highlightRequest.start + 1);
    }
  }, [isTargetSequence, activeDrawer, highlightRequest]);

  useEffect(() => {
    if (!isTargetSequence || activeDrawer !== 'annotations') {
      setReviewHighlight(null);
      setScrollToPosition(null);
    }
  }, [isTargetSequence, activeDrawer]);

  const focusedPosition = useVerificationStore((s) => s.focusedPosition);

  const {
    activeSessionId,
    activeSession,
    selectedTrackId,
    viewMode,
    hiddenTrackIds,
    alignedReference,
    alignedQuery,
    alignmentPanelOpen,
    alignmentVisible,
    selectedTrackHidden,
    getTrackMutations,
  } = useAlignmentDerivedState(sequenceDocumentId);

  const alignmentProjection = useMemo(() => {
    if (!activeSession || !alignmentPanelOpen || !alignmentVisible) return null;
    const visibleTracks = activeSession.tracks.filter(
      (track) =>
        !hiddenTrackIds.includes(track.id) &&
        (viewMode === 'stacked' || track.id === (selectedTrackId ?? activeSession.tracks[0]?.id))
    );
    return buildSharedAlignmentProjection(
      sequence?.sequence ?? '',
      visibleTracks.map((track) => ({
        id: track.id,
        label: track.label,
        alignedReference: track.alignment.alignedReference,
        alignedQuery: track.alignment.alignedQuery,
      })),
      selectedTrackId
    );
  }, [
    activeSession,
    alignmentPanelOpen,
    alignmentVisible,
    hiddenTrackIds,
    viewMode,
    selectedTrackId,
    sequence?.sequence,
  ]);

  const coordinateSpace = useMemo((): CoordinateSpace | undefined => {
    if (alignmentProjection) return alignmentProjection.coordinateSpace;
    if (
      !alignmentPanelOpen ||
      !activeSessionId ||
      !alignedReference ||
      !alignedQuery ||
      !alignmentVisible ||
      selectedTrackHidden
    ) {
      return undefined;
    }
    return { mode: 'gapped', gappedSequence: alignedReference, alignedQuery };
  }, [
    alignmentProjection,
    activeSessionId,
    alignedReference,
    alignedQuery,
    alignmentPanelOpen,
    alignmentVisible,
    selectedTrackHidden,
  ]);

  const effectiveCoordinateSpace = sequenceTabCoordinateSpace(
    coordinateSpace,
    headDiffCoordinateSpace,
    gitDiffCoordinateSpace
  );

  const mutationAxis = useMemo(
    () =>
      alignmentProjection
        ? buildSharedSequenceAxis(sequence?.sequence ?? '', alignmentProjection.coordinateSpace)
        : null,
    [sequence?.sequence, alignmentProjection]
  );
  const mutationNavigation = useMemo(
    () =>
      mutationAxis
        ? resolveAlignmentMutationNavigation(
            focusedPosition,
            sequenceDocumentId,
            alignmentProjection,
            mutationAxis
          )
        : null,
    [focusedPosition, sequenceDocumentId, alignmentProjection, mutationAxis]
  );
  const mutationHighlight = mutationNavigation?.highlightRange ?? null;
  const lastFocusTimestamp = useRef<number>(0);
  useEffect(() => {
    if (
      mutationNavigation &&
      mutationNavigation.columnNavigation.requestId !== lastFocusTimestamp.current
    ) {
      lastFocusTimestamp.current = mutationNavigation.columnNavigation.requestId;
      setScrollToPosition(mutationNavigation.position);
    }
  }, [mutationNavigation]);

  const effectiveTrackId =
    alignmentProjection?.selectedTrackId ?? selectedTrackId ?? activeSession?.tracks[0]?.id ?? null;

  const mutations = useMemo((): MutationMarker[] => {
    if (!activeSessionId || !effectiveTrackId || !alignmentPanelOpen || !alignmentVisible)
      return [];
    if (hiddenTrackIds.includes(effectiveTrackId)) return [];
    const source = getTrackMutations(sequenceDocumentId, activeSessionId, effectiveTrackId);
    if (!alignmentProjection) return source;
    return source.flatMap((marker) => {
      const column = alignmentProjection.projectTrackColumn(effectiveTrackId, marker.column);
      if (column === null) return [];
      const endColumn =
        marker.endColumn === undefined
          ? undefined
          : (alignmentProjection.projectTrackColumn(effectiveTrackId, marker.endColumn) ??
            undefined);
      return [{ ...marker, column, endColumn }];
    });
  }, [
    activeSessionId,
    effectiveTrackId,
    alignmentPanelOpen,
    alignmentVisible,
    alignmentProjection,
    hiddenTrackIds,
    sequenceDocumentId,
    getTrackMutations,
  ]);

  const savedSequence = useSequenceStore((state) => state.savedSequences[sequenceDocumentId]);
  useEffect(() => {
    if (
      isHostedBrowserRuntime() ||
      readOnly ||
      !primerWorkspaceRoot ||
      (filePath && isDeveloperImportSourcePath(filePath))
    ) {
      setPrimerSequenceId(null);
      return;
    }
    if (!filePath || !savedSequence) return;
    ensureSequenceIdentity(
      sequenceDocumentId,
      filePath,
      savedSequence.name ?? 'Unknown',
      savedSequence.length ?? 0,
      !!savedSequence.circular,
      primerWorkspaceRoot
    )
      .then(setPrimerSequenceId)
      .catch((err) => {
        console.error('Failed to resolve sequence identity for primers:', err);
      });
  }, [filePath, primerWorkspaceRoot, readOnly, savedSequence, sequenceDocumentId]);
  const {
    primers: primerRecords,
    isLoading: primersLoading,
    error: primersError,
    reload: reloadPrimers,
    create: createPrimerRecord,
    detach: detachPrimerBinding,
  } = usePrimers(primerSequenceId, sequenceTabWorkspaceRoot(primerWorkspaceRoot));

  const reReadPastedFeatures = useCallback(
    (rewrite: ReReadPastedFeatures) => {
      const store = useSequenceStore.getState();
      const draft = store.drafts[sequenceDocumentId];
      if (!draft) return;
      const inserted = draft.insertedRanges;

      const insertedRange = inserted.length === 1 ? inserted[0] : null;
      const next = rewrite(draft.annotations, insertedRange);
      if (!next) return;
      store.dispatchEdit(sequenceDocumentId, { type: 'SET_ANNOTATIONS', annotations: next });
    },
    [sequenceDocumentId]
  );

  const { copySelection: handleCopy, resolvePasteFragment } = useRichSequenceClipboard({
    documentId: sequenceDocumentId,
    displayName: presentation.name,
    sequence,
    primerRecords,
    workspaceRoot: sequenceTabWorkspaceRoot(primerWorkspaceRoot),
    ...(readOnly ? {} : { onReReadPastedFeatures: reReadPastedFeatures }),
  });

  const {
    results: searchResults,
    isSearching,
    error: searchError,
    libraryEmpty: searchLibraryEmpty,
    search: searchPrimersAction,
    attach: attachPrimer,
  } = usePrimerSearch(
    primerSequenceId,
    sequence?.sequence,
    sequenceTabIsCircular(sequence?.circular),
    primerWorkspaceRoot
      ? {
          workspaceRoot: primerWorkspaceRoot,
          targetDocumentId: sequenceDocumentId,
          targetFilePath: filePath,
        }
      : undefined,
    activeDrawer === 'primers',
    sequenceDocumentId
  );

  const [canvasSelection, setCanvasSelection] = useState<CanvasSelectionRange | null>(null);

  const [clickedAnnotationIdentity, setClickedAnnotationIdentity] =
    useState<AnnotationStateIdentity | null>(null);
  const currentAnnotationBoundarySelection = useMemo(() => {
    return selectionToAnnotationBoundaryRange(canvasSelection);
  }, [canvasSelection]);

  const primerAutoScopeSeqRef = useRef(0);
  const [primerAutoScope, setPrimerAutoScope] = useState<PrimerAutoScopeRequest | null>(null);

  useEffect(() => {
    const w = window as Window & {
      __test?: {
        canvasInteraction?: Record<string, { canvasSelection: typeof canvasSelection }>;
      };
    };
    if (!w.__test) return;
    if (!w.__test.canvasInteraction) w.__test.canvasInteraction = {};
    w.__test.canvasInteraction[sequenceDocumentId] = { canvasSelection };
  }, [canvasSelection, sequenceDocumentId]);

  const [workspaceSelection, setWorkspaceSelection] = useState<
    import('../selection-state').SelectionState
  >({ kind: 'none' });
  useEffect(() => {
    const w = window as Window & {
      __test?: {
        workspaceSelection?: Record<string, { selection: typeof workspaceSelection }>;
      };
    };
    if (!w.__test) return;
    if (!w.__test.workspaceSelection) w.__test.workspaceSelection = {};
    w.__test.workspaceSelection[sequenceDocumentId] = { selection: workspaceSelection };
  }, [workspaceSelection, sequenceDocumentId]);

  const [pendingPrimerCreation, setPendingPrimerCreation] = useState<{
    sequence: string;
    direction: PrimerDirection;
    bindingStart: number;
    bindingEnd: number;
  } | null>(null);
  const [pendingPrimerBindingEdit, setPendingPrimerBindingEdit] = useState<BoundPrimer | null>(
    null
  );

  const primerDisplays = useMemo(() => {
    return primerRecords.map((p) =>
      dbPrimerToPrimerDisplay(
        {
          id: p.id,
          catalog_number: p.catalogNumber,
          name: p.name,
          sequence: p.sequence,
          length: p.length,
          tm: p.tm,
          gc_percent: p.gcPercent,
          origin: p.origin,
          origin_details: p.originDetails ? JSON.stringify(p.originDetails) : null,
          status: p.status,
          vendor: p.vendor,
          order_date: p.orderDate,
          application: p.application,
          scale: p.scale,
          purification: p.purification,
          modifications: p.modifications,
          stock_location: p.stockLocation,
          concentration: p.concentration,
          notes: p.notes,
          workspace_id: p.workspaceId,
          created_at: p.createdAt,
          updated_at: p.updatedAt,

          binding_id: p.binding.id,
          binding_start: p.binding.bindingStart,
          binding_end: p.binding.bindingEnd,
          strand: p.binding.strand,
          source: p.binding.source,
          binding_created_at: p.binding.createdAt,
          binding_updated_at: p.binding.updatedAt,
        },
        sequence?.sequence,
        { circular: sequenceTabIsCircular(sequence?.circular) }
      )
    );
  }, [primerRecords, sequence?.sequence, sequence?.circular]);

  const primerRecordForDisplay = useCallback(
    (primer: PrimerDisplay) => boundPrimerForDisplay(primer, primerRecords),
    [primerRecords]
  );

  const copyPrimer = useCallback(
    async (primer: PrimerDisplay) => {
      const record = primerRecordForDisplay(primer);
      try {
        await copyPrimerRecord({
          bases: record?.sequence ?? primer.bases,
          modifications: record?.modifications,
        });
      } catch (copyError) {
        useToastStore
          .getState()
          .addToast(toUserMessage(copyError, 'failure.could-not-copy-the-primer'), {
            definition: 'sequence-tab-could-not-copy-the-primer',
          });
      }
    },
    [primerRecordForDisplay]
  );

  const editPrimerArtifact = useCallback(
    async (primer: PrimerDisplay) => {
      const record = primerRecordForDisplay(primer);
      const location = record ? await primerArtifactLocation(record, workspaceFolders) : null;
      if (!record || !location) {
        if (activeDrawer !== 'primers') toggleDrawer('primers');
        setScrollToPosition(primer.start + 1);
        setChangeHighlight({ start: primer.start, end: primer.end - 1 });
        return;
      }
      openInFocusedPanel('primer', location.artifactPath, record.name, {
        artifactDocument: { kind: 'primer', persistence: 'persisted', ...location },
      });
    },
    [activeDrawer, openInFocusedPanel, primerRecordForDisplay, toggleDrawer, workspaceFolders]
  );

  const editPrimerBinding = useCallback(
    (primer: PrimerDisplay) => {
      const record = primerRecordForDisplay(primer);
      if (!record) return;
      setPendingPrimerBindingEdit(record);
      if (activeDrawer !== 'primers') toggleDrawer('primers');
    },
    [activeDrawer, primerRecordForDisplay, toggleDrawer]
  );

  const [draftPrimerPreview, setDraftPrimerPreview] = useState<
    import('@waypoint/workspace-editor').PrimerDisplay | null
  >(null);

  const handlePreviewChange = useCallback(
    (preview: { display: import('@waypoint/workspace-editor').PrimerDisplay | null }) => {
      setDraftPrimerPreview(preview.display);
    },
    []
  );

  useEffect(() => {
    if (activeDrawer !== 'primers') {
      setDraftPrimerPreview(null);
    }
  }, [activeDrawer]);

  const candidatePrimerDisplays = useMemo(
    () => candidatePrimerDisplaysFromSearch(searchResults),
    [searchResults]
  );

  const allPrimerDisplays = useMemo(() => {
    const result = [...primerDisplays, ...candidatePrimerDisplays];
    if (draftPrimerPreview) {
      result.push(draftPrimerPreview);
    }
    return result;
  }, [primerDisplays, candidatePrimerDisplays, draftPrimerPreview]);

  useEffect(() => {
    if (!shouldEnableTestBridge(import.meta.env)) return;
    if (typeof window === 'undefined') return;
    const w = window as Window & {
      __sequencePrimerDebug?: Record<string, unknown>;
    };
    const sourceAnnotations = sequence?.annotations ?? [];
    w.__sequencePrimerDebug ??= {};
    w.__sequencePrimerDebug[sequenceDocumentId] = {
      primerSequenceId,
      primerRecordCount: primerRecords.length,
      primerDisplayCount: primerDisplays.length,
      candidatePrimerDisplayCount: candidatePrimerDisplays.length,
      hasDraftPrimerPreview: !!draftPrimerPreview,
      draftPrimerPreview: draftPrimerPreview
        ? {
            start: draftPrimerPreview.start,
            end: draftPrimerPreview.end,
            length: draftPrimerPreview.bases.length,
            direction: draftPrimerPreview.direction,
          }
        : null,
      allPrimerDisplayCount: allPrimerDisplays.length,
      sequenceCircular: sequenceTabIsCircular(sequence?.circular),
      sequenceAnnotationCount: sourceAnnotations.length,
      sequencePrimerBindAnnotationCount: sourceAnnotations.filter(
        (ann) => ann.type === 'primer_bind'
      ).length,
      sequenceAnnotationNames: sourceAnnotations.map((ann) => ann.name).slice(0, 50),
      primersLoading,
      primersError: primersError?.message ?? null,
    };
  }, [
    allPrimerDisplays.length,
    candidatePrimerDisplays.length,
    draftPrimerPreview,
    sequenceDocumentId,
    primerDisplays.length,
    primerRecords.length,
    primerSequenceId,
    primersError,
    primersLoading,
    sequence,
  ]);

  const handleOpenPrimers = useCallback(() => {
    if (readOnly) return;
    if (activeDrawer !== 'primers') trackToolOpened('primers', 'tab');
    toggleDrawer('primers');
  }, [activeDrawer, readOnly, toggleDrawer]);

  const handleAttachPrimers = useCallback(() => {
    if (readOnly) return;
    if (activeDrawer !== 'primers') toggleDrawer('primers');
    primerAutoScopeSeqRef.current += 1;
    setPrimerAutoScope({
      nonce: primerAutoScopeSeqRef.current,

      region: canvasSelection,
    });
  }, [activeDrawer, canvasSelection, readOnly, toggleDrawer]);

  const handlePrimerAutoScopeConsumed = useCallback(() => {
    setPrimerAutoScope(null);
  }, []);

  const handleCreatePrimerFromViewer = useCallback(
    (range: { start: number; end: number; sequence: string }, direction: PrimerDirection) => {
      if (readOnly) return;
      setPendingPrimerCreation({
        sequence: range.sequence,
        direction,
        bindingStart: range.start,
        bindingEnd: range.end,
      });
      if (activeDrawer !== 'primers') toggleDrawer('primers');
    },
    [activeDrawer, readOnly, toggleDrawer]
  );

  const handlePrimerCreate = useCallback(
    async (input: CreatePrimerInput) => {
      if (readOnly) throw new Error('Preserved source primers are read-only.');
      return createPrimerRecord(input);
    },
    [createPrimerRecord, readOnly]
  );

  const handleSearchResultClick = useCallback((hit: { start: number; end: number }) => {
    setScrollToPosition(hit.start + 1);

    setChangeHighlight({ start: hit.start, end: hit.end - 1 });
  }, []);

  const handleViewStructure = useCallback(
    (annotation: Annotation) => {
      if (!sequence) return null;
      if (activeDrawerRef.current !== 'structure') {
        flushSync(() => {
          openDrawer('structure');
        });
      }
      const request = buildStructureDrawerRequestFromAnnotation({
        annotation,
        sequence,
        entityId: sequenceDocumentId,
      });
      if (!request) return null;
      request.sourceWorkspaceRoot = sequenceTabWorkspaceRoot(primerWorkspaceRoot);
      void useStructureDrawerStore.getState().open(request);
      return request;
    },
    [openDrawer, primerWorkspaceRoot, sequence, sequenceDocumentId]
  );

  const [pendingProteinCreation, setPendingProteinCreation] =
    useState<PendingAminoAcidCreation | null>(null);
  const [isCreatingProtein, setIsCreatingProtein] = useState(false);

  const handleCreateAminoAcidSequence = useCallback(
    (cds: Annotation) => {
      if (!sequence || !primerWorkspaceRoot) {
        useToastStore
          .getState()
          .addToast(userMessage('notice.open-this-file-inside-a-project-to-create-a-protein'), {
            definition: 'sequence-tab-open-this-file-inside-a-project-to-create-a-protein',
          });
        return;
      }

      const recordCode = resolveSequenceGeneticCode(sequence);
      const aminoAcidSequence = getCDSTranslation(
        cds,
        sequence.sequence,
        recordCode.code,
        recordCode.basis
      );
      setPendingProteinCreation({
        suggestedName: cds.name || 'Protein',
        sequence: aminoAcidSequence,
        workspaceRoot: primerWorkspaceRoot,
        sourceFilePath: filePath,
      });
    },
    [sequence, primerWorkspaceRoot, filePath]
  );

  const handleConfirmCreateAminoAcidSequence = useCallback(
    async (name: string, dir: string, workspaceRoot: string) => {
      if (!pendingProteinCreation) return;
      setIsCreatingProtein(true);
      try {
        const result = await recordProtein({
          name,
          sequence: pendingProteinCreation.sequence,
          workspaceRoot,
          sourceCds: pendingProteinCreation.suggestedName,
          dir,
        });
        setPendingProteinCreation(null);
        useToastStore.getState().addToast(
          userMessageWithValues('notice.registered-protein-value-value-at-value', {
            value0: userMessageValue(result.limsEntity.name),
            value1: userMessageValue(result.limsEntity.id),
            value2: userMessageValue(result.artifactPath),
          }),
          { definition: 'sequence-tab-registered-protein-example-example-at-example-file' }
        );
        await openLimsEntity({ entityId: result.limsEntity.id });
      } catch (error) {
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.failed-to-create-amino-acid-sequence'), {
            definition: 'sequence-tab-failed-to-create-amino-acid-sequence',
          });
      } finally {
        setIsCreatingProtein(false);
      }
    },
    [pendingProteinCreation]
  );

  useEffect(() => {
    if (!sequence) return;
    return registerViewStructureByLabelHandler(sequenceDocumentId, async (labelToken) => {
      const annotation = findStructureAnnotationByLabel(sequence.annotations ?? [], labelToken);
      if (!annotation) {
        return { ok: false, reason: `Structure annotation not found for token: ${labelToken}` };
      }
      const request = handleViewStructure(annotation);
      if (!request) {
        return { ok: false, reason: `Annotation did not yield a structure request: ${labelToken}` };
      }
      return { ok: true, request };
    });
  }, [handleViewStructure, sequence, sequenceDocumentId]);

  const handleAskAIAboutSelection = useCallback(
    (payload: AskAiViewerPayload) => {
      const input = buildAskAiSelectionInput(payload, {
        documentId: sequenceDocumentId,
        workspaceRootPath: primerWorkspaceRoot,
        sequenceBasename,
      });

      const route = payload.seedText ? 'seed-focused-chat' : 'picker';
      void askAiAboutSelection(input, { route });
    },
    [primerWorkspaceRoot, sequenceBasename, sequenceDocumentId]
  );

  const handleAnnotateToolClick = useCallback(() => {
    if (readOnly) return;
    toggleDrawer('annotations');
  }, [readOnly, toggleDrawer]);

  const handleOpenAlignments = useCallback(() => {
    toggleDrawer('alignments');
  }, [toggleDrawer]);

  const handleAddAlignmentFiles = useCallback(async () => {
    try {
      const selected = await selectAlignmentQueryFiles(filePath, {
        multiple: true,
        title: 'Select files to align',
        filters: ALIGNMENT_QUERY_FILE_FILTERS,
      });

      setPendingAlignmentFiles((current) => pendingAlignmentFilesFromSelection(selected, current));
    } catch (err) {
      console.error('[SequenceTab] Failed to select alignment files:', err);
    }
  }, [filePath]);

  const selectedStructureRequest = useMemo(() => {
    if (!sequence?.annotations?.length || !sequence) return null;

    const clicked = clickedAnnotationIdentity;
    const annotation =
      (clicked &&
        sequence.annotations.find((a) =>
          annotationIdentityEqual(clicked, {
            type: a.type,
            name: a.name,
            start: a.start,
            end: a.end,
            direction: a.direction,
          })
        )) ||
      findStructureAnnotationAtPosition(sequence.annotations, null, null, canvasSelection);
    if (!annotation) return null;
    const request = buildStructureDrawerRequestFromAnnotation({
      annotation,
      sequence,
      entityId: sequenceDocumentId,
    });
    if (request) request.sourceWorkspaceRoot = sequenceTabWorkspaceRoot(primerWorkspaceRoot);
    return request;
  }, [
    sequence,
    clickedAnnotationIdentity,
    canvasSelection,
    sequenceDocumentId,
    primerWorkspaceRoot,
  ]);

  const handleOpenStructure = useCallback(() => {
    if (activeDrawer === 'structure') {
      toggleDrawer('structure');
      return;
    }
    if (selectedStructureRequest) {
      if (activeDrawerRef.current !== 'structure') {
        flushSync(() => {
          openDrawer('structure');
        });
      }
      void useStructureDrawerStore.getState().open(selectedStructureRequest);
      return;
    }
    if (hasAssociatedStructure) {
      toggleDrawer('structure');
    }
  }, [activeDrawer, toggleDrawer, selectedStructureRequest, openDrawer, hasAssociatedStructure]);

  const handleOpenGitHistory = useCallback(() => {
    if (activeDrawer === 'git-history') {
      clearGitSelection();
      setIsDiffViewActive(false);
    } else {
      packageHistory.refresh();
    }
    toggleDrawer('git-history');
  }, [toggleDrawer, activeDrawer, clearGitSelection, packageHistory.refresh]);

  const handleAutoAnnotate = useCallback(
    (range?: WireRange) => {
      if (readOnly) return;
      if (sequence?.sequence) {
        if (useAnnotationReviewStore.getState().getSession(sequenceDocumentId)?.outputImport)
          exitReviewMode(sequenceDocumentId);
        void executeAnnotate({
          sequence: sequence.sequence,
          linear: !sequence.circular,
          start: range?.start,
          end: range?.end,
        });
      }
    },
    [executeAnnotate, readOnly, sequence, sequenceDocumentId, exitReviewMode]
  );

  const [isImportingAnnotationOutput, setIsImportingAnnotationOutput] = useState(false);
  const handleImportAnnotationOutput = useCallback(async () => {
    if (readOnly || isImportingAnnotationOutput) return;
    setIsImportingAnnotationOutput(true);
    try {
      const selected = await platform().dialog.open({
        multiple: false,
        title: 'Import annotation results',
        filters: [{ name: 'Annotation results', extensions: ['json', 'gff3', 'gff'] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      await reviewSelectedAnnotationOutput(path, sequenceDocumentId, workspaceFolders);
      openDrawer('annotations');
      setDrawerTab('plannotate');
    } catch (error) {
      useToastStore
        .getState()
        .addToast(toUserMessage(error, 'failure.the-annotation-file-could-not-be-imported'), {
          definition: 'sequence-tab-the-annotation-file-could-not-be-imported',
        });
    } finally {
      setIsImportingAnnotationOutput(false);
    }
  }, [readOnly, isImportingAnnotationOutput, sequenceDocumentId, workspaceFolders, openDrawer]);

  const handleAnnotationClick = useCallback((annotation: { start: number; end: number }) => {
    setScrollToPosition(annotation.start);
    setReviewHighlight({
      start: annotation.start - 1,
      end: annotation.end - 1,
      wraps: annotation.end < annotation.start,
    });
    observeWorkflowAction({
      workflow: 'annotation',
      action: 'view',
      status: 'viewed',
      phase: 'result',
    });
  }, []);

  const isApplyingRef = useRef(false);

  const handleCommit = useCallback(async () => {
    if (!sequence || readOnly) return;
    if (isApplyingRef.current) return;
    isApplyingRef.current = true;
    const acceptedDrafts = getAcceptedDrafts(sequenceDocumentId);
    const managedReview = useAnnotationReviewStore.getState().getSession(sequenceDocumentId);
    const activity = managedReview?.outputImport
      ? { workflow: 'annotation' as const, action: 'import' as const }
      : { workflow: 'plannotate' as const, action: 'commit' as const };
    const operation = beginWorkflowAction({
      ...activity,
      operationId: managedReview?.operationId,
      selectedCount: acceptedDrafts.length,
    });
    try {
      if (managedReview?.outputImport) {
        const result = await applyAnnotationOutputReview(
          sequenceDocumentId,
          workspaceFolders,
          operation.actionId
        );
        if (result.status === 'blocked' || result.status === 'save-failed') {
          operation.fail(result.status, { selectedCount: acceptedDrafts.length, status: 'failed' });
          useToastStore.getState().addToast(toUserMessage(result.reason), {
            definition: 'sequence-tab-handle-commit',
            variant: result.status === 'blocked' ? 'warning' : 'error',
          });
        } else {
          operation.complete({
            selectedCount: acceptedDrafts.length,
            affectedCount: acceptedDrafts.length,
            status: 'saved',
          });
        }
        return;
      }
      if (managedReview?.operationId) {
        const result = await applyNativeAnnotationReview(managedReview.operationId, {
          readOnly,
        });
        if (
          result.status === 'blocked' ||
          result.status === 'save-failed' ||
          result.status === 'outcome-unresolved' ||
          result.status === 'previous-runtime'
        ) {
          operation.fail(result.status, { selectedCount: acceptedDrafts.length, status: 'failed' });
          useToastStore.getState().addToast(toUserMessage(result.reason), {
            definition: 'sequence-tab-handle-commit',
            variant: result.status === 'blocked' ? 'warning' : 'error',
          });
        } else {
          operation.complete({
            selectedCount: acceptedDrafts.length,
            affectedCount: acceptedDrafts.length,
            status: 'saved',
            operationId: managedReview.operationId,
            nativeActionId: result.status === 'saved' ? result.actionId : undefined,
            outcomeKind:
              result.status === 'saved' && result.receipt.outcome.status === 'saved'
                ? result.receipt.outcome.display === 'pending'
                  ? 'display_pending'
                  : result.receipt.outcome.display === 'refreshed'
                    ? 'display_refreshed'
                    : undefined
                : undefined,
          });
          if (result.status === 'saved' && result.receipt.outcome.status === 'saved') {
            notifySavedAnnotationDocument(result.receipt, documentRef, sequence.name);
          }
        }
        return;
      }

      const store = useSequenceStore.getState();
      const result = await commitReviewedAnnotations({
        sequence,
        documentId: sequenceDocumentId,
        acceptedDrafts,
        hasPendingSequenceEdits: store.hasPendingSequenceEdits(sequenceDocumentId),
        mergeAnnotations: store.mergeAnnotations,
        exitReviewMode,
        save: () => save(undefined, { kind: 'annotation', parentActionId: operation.actionId }),
      });
      if (result.status === 'blocked-pending-edits') {
        operation.fail('blocked_pending_edits', {
          selectedCount: acceptedDrafts.length,
          status: 'blocked',
        });
        useToastStore
          .getState()
          .addToast(
            userMessage('notice.commit-or-discard-your-sequence-edits-before-applying-annotations'),
            {
              definition:
                'sequence-tab-commit-or-discard-your-sequence-edits-before-applying-annotations',
            }
          );
      } else if (result.status === 'save-failed') {
        operation.fail('save_failed', {
          selectedCount: acceptedDrafts.length,
          status: 'failed',
        });
      } else {
        operation.complete({
          selectedCount: acceptedDrafts.length,
          affectedCount: acceptedDrafts.length,
          status: 'saved',
        });
      }
    } catch (error) {
      operation.fail(error instanceof Error ? error.name : 'unknown', {
        selectedCount: acceptedDrafts.length,
        status: 'failed',
      });
      throw error;
    } finally {
      isApplyingRef.current = false;
    }
  }, [
    sequence,
    documentRef,
    readOnly,
    getAcceptedDrafts,
    sequenceDocumentId,
    exitReviewMode,
    save,
    workspaceFolders,
  ]);

  const handleCancel = useCallback(() => {
    exitReviewMode(sequenceDocumentId);
  }, [exitReviewMode, sequenceDocumentId]);

  const {
    hiddenAnnotationKeys,
    toggleAnnotationVisibility,
    setAllAnnotationsVisible,
    handleAnnotationSave,
    handleAnnotationDelete,
    handleAnnotationAdd,
  } = useAnnotationEditing({
    documentId: sequenceDocumentId,
    sequence,
    flushAutoSave,
    pendingCommitMessageRef,
    readOnly,
  });

  const selectDraftFromViewer = useCallback(
    (annotation: { name: string; start: number; end: number }): boolean => {
      if (!isTargetSequence || drafts.length === 0 || drawerTab !== 'plannotate') return false;

      const draft = resolveDraftForViewerAnnotation(
        drafts,
        annotation,
        sequence?.annotations ?? []
      );
      if (!draft) return false;
      selectDraft(sequenceDocumentId, draft.id);
      return true;
    },
    [isTargetSequence, drafts, drawerTab, selectDraft, sequenceDocumentId, sequence]
  );

  const {
    pendingNewRange,
    pendingNewDraft,
    setPendingNewDraft,
    draftSessionId,
    clearPendingNewRange,
    clearPendingNewDraft,
    handleEditAnnotationFromViewer,
    handleActivateAnnotationFromViewer,
    handleDeleteAnnotationFromViewer,
    handleAddAnnotationFromViewer,
    handleAddAnnotationDraftFromViewer,
  } = useSequenceTabViewerAnnotationGestures({
    readOnly,
    sequenceAnnotations: sequence?.annotations,
    sequenceDocumentId,
    activeDrawer,
    openToAnnotation,
    toggleDrawer,
    selectDraftFromViewer,
    handleAnnotationDelete,
  });

  const handleOpenCdsExtensionDraft = useCallback(
    ({
      original,
      direction,
      kind,
    }: {
      original: Annotation;
      direction: 'five-prime' | 'three-prime';
      kind: 'extend' | 'undo';
    }) => {
      if (readOnly) return;
      const annotations = storedSequence?.annotations ?? [];
      const index = annotations.findIndex(
        (a) =>
          a.name === original.name &&
          a.type === original.type &&
          a.start === original.start &&
          a.end === original.end
      );
      if (index < 0) return;
      const key = cdsExtensionKeyFor(original);

      const current =
        cdsExtensionDraft && cdsExtensionDraft.key === key ? cdsExtensionDraft.ends : [];
      const ends =
        kind === 'undo'
          ? current.filter((end) => end !== direction)
          : current.includes(direction)
            ? current
            : [...current, direction];

      setCdsExtensionDraft(ends.length === 0 ? null : { key, original, ends });
      if (ends.length > 0) openToAnnotation(index);
    },
    [cdsExtensionDraft, openToAnnotation, readOnly, storedSequence?.annotations]
  );

  const handleCdsExtensionDraftCancelled = useCallback(
    (abandonedIndex: number) => {
      setCdsExtensionDraft((current) => {
        if (!current) return current;
        const annotations = storedSequence?.annotations ?? [];
        const draftIndex = annotations.findIndex((a) => cdsExtensionKeyFor(a) === current.key);
        return abandonedIndex === draftIndex ? null : current;
      });
    },
    [storedSequence?.annotations]
  );

  const handleAnnotationSaveWithExtension = useCallback(
    (index: number, data: AnnotationEditPatch) => {
      const qualifiers = extensionQualifiersForSavedRow(
        cdsExtensionDraft && cdsExtensionDraftExtended
          ? { key: cdsExtensionDraft.key, extended: cdsExtensionDraftExtended.extended }
          : null,
        storedSequence?.annotations?.[index]
      );
      if (!qualifiers) return handleAnnotationSave(index, data);
      setCdsExtensionDraft(null);
      return handleAnnotationSave(index, { ...data, qualifiers });
    },
    [
      cdsExtensionDraft,
      cdsExtensionDraftExtended,
      handleAnnotationSave,
      storedSequence?.annotations,
    ]
  );

  const handleCommitCdsExtension = useCallback(
    ({ original, updated }: { original: Annotation; updated: Annotation }) => {
      if (readOnly || !sequenceDocumentId) return;
      const annotations = useSequenceStore.getState().sequences[sequenceDocumentId]?.annotations;
      if (!annotations) return;

      const index = annotations.findIndex(
        (a: Annotation) =>
          a.name === original.name &&
          a.type === original.type &&
          (a.direction ?? 1) === (original.direction ?? 1) &&
          a.start === original.start &&
          a.end === original.end
      );
      const existing = annotations[index];
      if (index < 0 || !existing) return;
      useSequenceStore.getState().updateAnnotation(sequenceDocumentId, index, {
        name: existing.name,
        type: existing.type,
        direction: (existing.direction ?? 1) as 1 | -1 | 0,
        color: existing.color ?? '#4E79A7',
        start: updated.start,
        end: updated.end,

        qualifiers: updated.qualifiers,
      });
    },
    [readOnly, sequenceDocumentId]
  );

  useEffect(() => {
    if (!shouldEnableTestBridge(import.meta.env)) return;
    const bridge = (
      window as Window & {
        __test?: {
          _selectAnnotationInViewer?: Record<string, unknown>;
          selectAnnotationInViewer?: unknown;
        };
      }
    ).__test;
    if (!bridge) return;
    return registerSelectAnnotationInViewer(
      bridge,
      sequenceDocumentId,
      setClickedAnnotationIdentity
    );
  }, [sequenceDocumentId]);

  const candidateOrf: { start: number; end: number; strand: '+' | '-' } | null = null;

  const handleMutationClick = useCallback(
    (mutation: MutationMarker) => {
      const gappedSeq = effectiveCoordinateSpace?.gappedSequence;
      if (gappedSeq) {
        setScrollToPosition(gappedToBioClamped(mutation.column, gappedSeq));
      } else {
        setScrollToPosition(mutation.column + 1);
      }
    },
    [effectiveCoordinateSpace]
  );

  const handleScrollComplete = useCallback(() => {
    setScrollToPosition(null);
    if (scrollToPosition == null) clearReferenceScroll();
  }, [clearReferenceScroll, scrollToPosition]);

  const handleHighlightComplete = useCallback(() => {
    if (!changeHighlight && !mutationHighlight && !reviewHighlight) {
      clearReferenceHighlight();
    }
  }, [changeHighlight, clearReferenceHighlight, mutationHighlight, reviewHighlight]);

  const reviewSequence = useMemo(() => {
    if (
      !sequence ||
      !isTargetSequence ||
      drafts.length === 0 ||
      activeDrawer !== 'annotations' ||
      drawerTab !== 'plannotate'
    ) {
      return sequence;
    }

    const visibleDrafts = drafts;

    const grayedAnnotations = (sequence.annotations || []).map((ann) => ({
      ...ann,
      color: '#e5e7eb',
    }));

    const draftAnnotations = visibleDrafts.map((draft) => {
      const qualifiers: DraftQualifiers = {
        source: ['pLannotate-draft'],
        status: draft.accepted ? ['accepted'] : ['rejected'],
      };
      if (draft.duplicateStatus.isDuplicate && draft.duplicateStatus.existingAnnotationName) {
        qualifiers.suppressedBy = [draft.duplicateStatus.existingAnnotationName];
      }
      return {
        name: draft.name,
        type: draft.type || 'misc_feature',
        start: draft.start,
        end: draft.end,
        direction: (draft.strand === 1 ? 1 : draft.strand === -1 ? -1 : 0) as 1 | -1 | 0,

        color: getFeatureColor(draft.type || 'misc_feature'),
        qualifiers,
      };
    });

    const result = {
      ...sequence,
      annotations: [...grayedAnnotations, ...draftAnnotations],
    };
    return result;
  }, [sequence, isTargetSequence, drafts, activeDrawer, drawerTab]);

  const pendingDraftAnnotation = useMemo<Annotation | null>(() => {
    if (!pendingNewDraft) return null;
    if (pendingNewDraft.start < 1 || pendingNewDraft.end < pendingNewDraft.start) {
      return null;
    }
    const type = pendingNewDraft.type || 'misc_feature';
    const name = pendingNewDraft.name.trim();
    return {
      name,
      type,
      start: pendingNewDraft.start,
      end: pendingNewDraft.end,
      direction: pendingNewDraft.direction,
      color: pendingNewDraft.color ?? getFeatureColor(type),
      qualifiers: {
        ...(pendingNewDraft.qualifiers ?? {}),
        source: [ANNOTATION_DRAFT_SOURCE],
      },
    };
  }, [pendingNewDraft]);

  const activeStructureCdsIdentity = useMemo(() => {
    if (activeDrawer !== 'structure' || structureDrawerStatus === 'idle') return null;
    return sourceCdsIdentityForRequest(structureDrawerRequest, sequenceDocumentId);
  }, [activeDrawer, sequenceDocumentId, structureDrawerRequest, structureDrawerStatus]);
  const forcedSelectedAnnotation = activeStructureCdsIdentity;

  const displaySequence = useMemo(() => {
    const base = reviewSequence ?? sequence;
    if (!base) return base;
    const withDraft = pendingDraftAnnotation
      ? { ...base, annotations: [...(base.annotations ?? []), pendingDraftAnnotation] }
      : base;
    if (hiddenAnnotationKeys.size === 0) return withDraft;
    return {
      ...withDraft,
      annotations: (withDraft.annotations ?? []).filter(
        (a) => !hiddenAnnotationKeys.has(annotationVisibilityKey(a))
      ),
    };
  }, [reviewSequence, sequence, pendingDraftAnnotation, hiddenAnnotationKeys]);

  useEffect(() => {
    if (!shouldEnableTestBridge(import.meta.env)) return;
    const bridge = (
      window as Window & {
        __test?: {
          annotationDrafts?: Record<string, unknown>;
          getAnnotationDraft?: (documentId?: string) => unknown;
        };
      }
    ).__test;
    if (!bridge) return;
    if (!bridge.annotationDrafts) bridge.annotationDrafts = {};
    bridge.annotationDrafts[sequenceDocumentId] = {
      draft: pendingNewDraft,
      preview: pendingDraftAnnotation,
    };
    const getAnnotationDraft = (documentId: string = sequenceDocumentId) =>
      bridge.annotationDrafts?.[documentId] ?? null;
    const disposeGetAnnotationDraft = registerGetAnnotationDraft(
      bridge,
      sequenceDocumentId,
      getAnnotationDraft
    );
    return () => {
      if (bridge.annotationDrafts) delete bridge.annotationDrafts[sequenceDocumentId];
      disposeGetAnnotationDraft();
    };
  }, [pendingDraftAnnotation, pendingNewDraft, sequenceDocumentId]);

  const parsedPlasmid = useMemo(() => {
    return displaySequence
      ? annotatedSequenceToParsedPlasmid(displaySequence, primerDisplays)
      : null;
  }, [displaySequence, primerDisplays]);

  const sequenceIsCircular = sequenceTabIsCircular(displaySequence?.circular);
  const [seqView, patchSeqView] = useSequenceViewState(sequenceDocumentId, {
    circular: sequenceIsCircular,
    surface: 'sequence',
  });
  const sequenceViewMode: SequenceViewMode = seqView.canvasMode;
  const setSequenceViewMode = useCallback(
    (next: SequenceViewMode) => {
      patchSeqView({ canvasMode: next });
    },
    [patchSeqView]
  );
  const setRendererVisibility = useCallback(
    (next: SequenceRendererVisibility) => {
      patchSeqView({ rendererVisibility: next });
    },
    [patchSeqView]
  );
  const setMapLayout = useCallback(
    (next: SequenceMapLayout) => {
      patchSeqView({ mapLayout: next });
    },
    [patchSeqView]
  );
  const historicalSequence =
    activeDrawer === 'git-history' ? packageHistory.selectedSequence : null;
  const historicalRevision = historicalSequence
    ? packageHistory.index?.document.versionHistory.revisions.find(
        (revision) => revision.id === packageHistory.selectedRevisionId
      )
    : null;
  const stageHistoryAssembly = useCallback(
    async (input: StageHistoricalAssemblyComponentsInput) => {
      const index = packageHistory.index;
      if (
        !index ||
        index.document.id !== input.constructId ||
        !managedDocument ||
        !primerWorkspaceRoot ||
        readOnly
      ) {
        throw new Error('The editable sequence package changed before assembly staging.');
      }
      const canvas = useCanvasStore.getState();
      const sequenceTab = canvas.findTab('sequence', sequenceDocumentId);
      if (!sequenceTab || sequenceTab.tabId !== tabId) {
        throw new Error('The sequence tab closed before its assembly copy could open.');
      }
      const initialAssemblyEditDesignId = canvas.panels[sequenceTab.panelId]?.tabs.find(
        (item) => item.id === sequenceTab.tabId
      )?.assemblyEditDesignId;
      if (metadataDirty || useSequenceStore.getState().isDirty(sequenceDocumentId)) {
        throw new Error(
          'Save or discard unsaved sequence and Metadata edits before staging the assembly.'
        );
      }
      assertWorkspaceEditorsSettled({
        workspaceRoot: index.packageRoot,
        affectedEntityIds: [sequenceDocumentId, input.constructId],
      });
      const result = await stageHistoricalAssemblyComponents(input);
      const currentCanvas = useCanvasStore.getState();
      const stillOpen = currentCanvas.findTab('sequence', sequenceDocumentId);
      const stillOpenDesignId = stillOpen
        ? currentCanvas.panels[stillOpen.panelId]?.tabs.find((item) => item.id === stillOpen.tabId)
            ?.assemblyEditDesignId
        : undefined;
      if (
        !stillOpen ||
        stillOpen.tabId !== sequenceTab.tabId ||
        stillOpenDesignId !== initialAssemblyEditDesignId
      ) {
        throw new Error(
          'The assembly copy was staged, but the sequence tab changed before it could open.'
        );
      }
      if (useSequenceStore.getState().isDirty(sequenceDocumentId)) {
        throw new Error(
          'The assembly copy was staged, but new unsaved sequence edits prevent switching modes.'
        );
      }
      forgetFinalizedPlasmid(sequenceDocumentId);
      useCanvasStore
        .getState()
        .setSequenceAssemblyEdit(sequenceTab.panelId, sequenceTab.tabId, result.designId);
    },
    [
      managedDocument,
      metadataDirty,
      packageHistory.index,
      primerWorkspaceRoot,
      readOnly,
      sequenceDocumentId,
      tabId,
    ]
  );

  useGeneticCodePrompt(sequenceDocumentId, displaySequence, { enabled: !readOnly });

  return (
    <SequenceTabStatus
      isLoading={isLoading}
      error={error}
      sequence={sequence}
      displaySequence={displaySequence}
      parsedPlasmid={parsedPlasmid}
      ready={() => (
        <SequenceErrorBoundary documentLabel={presentation.name}>
          {!sequence || !displaySequence || !parsedPlasmid ? null : (
            <div
              data-testid={
                isHostedBrowserRuntime() ? 'hosted-scientific-editor' : 'sequence-loaded'
              }
              data-document-id={sequenceDocumentId}
              className="h-full flex flex-col"
              {...(() => {
                if (!isHostedBrowserRuntime()) return {};
                const identity = hostedDocumentIdentity(filePath);
                if (!identity) return {};
                return {
                  'data-workspace-id': identity.workspaceId,
                  'data-client-workspace-id': identity.clientWorkspaceId,
                  'data-version-id': identity.revisionId,
                  'data-accepted-base-version-id': identity.acceptedBaseRevisionId,
                  'data-local-revision-id': identity.localRevisionId ?? '',
                  'data-sync-state': identity.localRevisionId ? 'pending' : 'accepted',
                  'data-document-path': identity.documentPath,
                  'data-resource-id': identity.resourceId,
                  'data-content-sha256': identity.contentSha256,
                };
              })()}
            >
              <SequenceHistoryNotice documentId={sequenceDocumentId} />
              <SequenceTabInfoChrome
                readOnly={readOnly || historicalSequence !== null}
                presentation={
                  historicalRevision
                    ? { name: sequenceDisplayName(historicalRevision.state.name) }
                    : presentation
                }
                quickLook={
                  quickLookSource && selectedQuickLookRecord
                    ? {
                        sourceFileName: quickLookSource.sourceFileName,
                        records: quickLookSource.records.map((record) => ({
                          recordId: record.recordId,
                          displayName: sequenceDisplayName(record.displayName),
                          sequenceLength: record.sequenceLength,
                        })),
                        selectedRecordId: selectedQuickLookRecord.recordId,
                        onSelect: selectQuickLookRecord,
                        onImportToEdit: () => requestQuickLookImport(quickLookSource, tabId),
                      }
                    : undefined
                }
                sequenceLength={
                  historicalSequence ? historicalSequence.length : displaySequence.length
                }
                annotationCount={
                  historicalSequence
                    ? historicalSequence.annotations.length
                    : displaySequence.annotations.length
                }
                circular={
                  historicalSequence ? historicalSequence.circular : displaySequence.circular
                }
                viewMode={sequenceViewMode}
                onViewModeChange={setSequenceViewMode}
                rendererVisibility={seqView.rendererVisibility}
                onRendererVisibilityChange={setRendererVisibility}
                mapLayout={seqView.mapLayout}
                onMapLayoutChange={setMapLayout}
                sequenceDocumentId={sequenceDocumentId}
                limsBadge={
                  managedDocument ? (
                    <ManagedSequenceRegistrationBadge documentRef={managedDocument} />
                  ) : (
                    <LimsRegistrationBadge documentId={sequenceDocumentId} sourcePath={filePath} />
                  )
                }
                hostedRevisionNumber={
                  isHostedBrowserRuntime()
                    ? (hostedDocumentIdentity(filePath)?.revisionNumber ?? null)
                    : null
                }
                hostedPendingDraft={
                  isHostedBrowserRuntime() &&
                  Boolean(hostedDocumentIdentity(filePath)?.localRevisionId)
                }
                shareControl={
                  primerWorkspaceRoot ? (
                    <DeepShareControl
                      workspaceRootPaths={[primerWorkspaceRoot]}
                      targetReference={managedDocument?.packageRoot ?? filePath}
                    />
                  ) : null
                }
                isViewerEditMode={isViewerEditMode}
                editingPending={editingPending}
                onRequestEdit={requestSequenceEdit}
                acceptedAssemblyProductMismatch={acceptedAssemblyReopen.productMismatch}
                showExternalChangeToast={showExternalChangeToast}
                onAcceptExternalChange={acceptExternalChange}
                onDismissExternalChange={dismissExternalChange}
              />
              {}
              <div className="flex-1 min-h-0 relative">
                <SequenceTabWorkspaceCanvas
                  sequenceDocumentId={sequenceDocumentId}
                  readOnly={readOnly}
                  editingPending={editingPending}
                  savePending={isSaving}
                  displaySequence={displaySequence}
                  dataLayerSourceSequence={storedSequence ?? undefined}
                  parsedPlasmid={parsedPlasmid}
                  allPrimerDisplays={allPrimerDisplays}
                  onCopy={handleCopy}
                  resolvePasteFragment={resolvePasteFragment}
                  onSelectionChange={setCanvasSelection}
                  onSelectionStateChange={setWorkspaceSelection}
                  onAnnotateToolClick={handleAnnotateToolClick}
                  isDrawerOpen={isDrawerOpen}
                  activeDrawer={activeDrawer}
                  isTargetSequence={isTargetSequence}
                  draftsLength={drafts.length}
                  drawerTab={drawerTab}
                  changeHighlight={changeHighlight}
                  mutationHighlight={mutationHighlight}
                  columnNavigation={mutationNavigation?.columnNavigation}
                  reviewHighlight={reviewHighlight}
                  referenceHighlight={referenceHighlight}
                  onHighlightComplete={handleHighlightComplete}
                  scrollToPosition={scrollToPosition}
                  referenceScrollPosition={referenceScrollPosition}
                  sequenceNavigationRequestId={referenceNavigationRequestId}
                  onScrollComplete={handleScrollComplete}
                  onOpenAlignments={handleOpenAlignments}
                  canOpenMetadata={Boolean(managedDocument || filePath)}
                  onToggleMetadata={() => toggleDrawer('metadata')}
                  packageHistory={managedDocument ? packageHistory : undefined}
                  packageRestore={
                    managedDocument && primerWorkspaceRoot && !readOnly
                      ? {
                          workspaceRoot: primerWorkspaceRoot,
                          isDirty: isDirty || metadataDirty,
                          savePending: async () => {
                            if (metadataDirty) {
                              throw new Error(
                                'Finish or cancel the unfinished Metadata edits before Restore.'
                              );
                            }
                            const saved = await save();
                            return (
                              saved && !useSequenceStore.getState().isDirty(sequenceDocumentId)
                            );
                          },
                          discardPending: () => {
                            if (metadataDirty) return false;
                            handleEditDiscard();
                            return true;
                          },
                          apply: applyPackageRestore,
                        }
                      : undefined
                  }
                  assemblyComposition={
                    managedDocument && primerWorkspaceRoot && packageHistory.index && !readOnly
                      ? { isDirty: isDirty || metadataDirty, stage: stageHistoryAssembly }
                      : undefined
                  }
                  onOpenGitHistory={handleOpenGitHistory}
                  onOpenPrimers={handleOpenPrimers}
                  onOpenStructure={handleOpenStructure}
                  hasAssociatedStructure={hasAssociatedStructure}
                  hasSelectedStructureRequest={selectedStructureRequest !== null}
                  onCreatePrimer={handleCreatePrimerFromViewer}
                  onAttachPrimers={handleAttachPrimers}
                  onViewStructure={handleViewStructure}
                  onCreateAminoAcidSequence={handleCreateAminoAcidSequence}
                  onAskAI={handleAskAIAboutSelection}
                  onEditPrimer={editPrimerArtifact}
                  onEditPrimerBinding={editPrimerBinding}
                  onCopyPrimer={copyPrimer}
                  onDetachPrimerBinding={detachPrimerBinding}
                  onReloadPrimers={reloadPrimers}
                  isAnyDiffViewActive={isAnyDiffViewActive}
                  coordinateSpace={coordinateSpace ?? undefined}
                  alignmentLanes={alignmentProjection?.lanes}
                  effectiveCoordinateSpace={effectiveCoordinateSpace ?? undefined}
                  diffViewMutations={diffViewMutations}
                  mutations={mutations}
                  onMutationClick={handleMutationClick}
                  onEditModeChange={setIsViewerEditMode}
                  onRestrictionEnzymeDrawerOpenChange={handleRestrictionEnzymeDrawerOpenChange}
                  restrictionEnzymeDrawerWidth={getDrawerWidth('restriction-enzymes')}
                  onRestrictionEnzymeDrawerWidthChange={setDrawerWidth}
                  onEditAnnotation={handleEditAnnotationFromViewer}
                  onCommitCdsExtension={readOnly ? undefined : handleCommitCdsExtension}
                  onOpenCdsExtensionDraft={readOnly ? undefined : handleOpenCdsExtensionDraft}
                  onActivateAnnotation={handleActivateAnnotationFromViewer}
                  onSelectedAnnotationChange={setClickedAnnotationIdentity}
                  onDeleteAnnotation={handleDeleteAnnotationFromViewer}
                  onAddAnnotation={handleAddAnnotationFromViewer}
                  onAddAnnotationDraft={handleAddAnnotationDraftFromViewer}
                  candidateOrf={candidateOrf}
                  forcedSelectedAnnotation={forcedSelectedAnnotation}
                  allRulerDecorations={allRulerDecorations}
                  changedAnnotationNames={changedAnnotationNames}
                  editorSession={editorSession}
                  resumePendingEdits={resumePendingEdits}
                  diffResult={diffResult}
                  onEditCommit={handleEditCommit}
                  onEditDiscard={handleEditDiscard}
                  drawer={{
                    readOnly,
                    filePath,
                    sequenceDocumentId,
                    presentation,
                    sequence,
                    displaySequence,
                    managedDocument,
                    activeDrawer,
                    drawerWidth,
                    onDrawerWidthChange: setDrawerWidth,
                    hiddenAnnotationKeys,
                    onToggleAnnotationVisibility: toggleAnnotationVisibility,
                    onSetAllAnnotationsVisible: setAllAnnotationsVisible,
                    onAnnotationClick: handleAnnotationClick,
                    onAnnotationSave: handleAnnotationSaveWithExtension,
                    onAnnotationEditCancel: handleCdsExtensionDraftCancelled,
                    onAnnotationDelete: handleAnnotationDelete,
                    onRunPlannotate: handleAutoAnnotate,
                    onImportAnnotationOutput: readOnly ? undefined : handleImportAnnotationOutput,
                    isImportingAnnotationOutput,
                    importedOutputName: session?.outputImport
                      ? (session.outputImport.source.kind === 'granted-file'
                          ? session.outputImport.source.absolutePath
                          : session.outputImport.source.path
                        )
                          .split(/[\\/]/)
                          .pop()
                      : undefined,
                    autoAnnotateApiError,
                    annotateError,
                    annotateUnavailableReason,
                    annotateStatus: session?.outputImport ? 'success' : annotateStatus,
                    sequenceVersion,
                    reviewRunVersion: session?.runVersion,
                    reviewIsApplying: session?.nativeApplyPending,
                    reviewBlockedReason:
                      session?.disposition === 'applied'
                        ? userMessage('annotation.reviewApplied')
                        : session?.disposition === 'dismissed'
                          ? userMessage('annotation.reviewDismissed')
                          : session?.operationId
                            ? nativeAnnotationReviewBlockReason(session)
                            : session?.blockedReason,
                    reviewCoordinateProvenance:
                      session?.nativeInspection?.status === 'ready'
                        ? {
                            coordinates: session.nativeInspection.coordinates,
                            transitionCount: session.nativeInspection.transitionCount,
                          }
                        : undefined,
                    onRefreshReview:
                      session?.operationId &&
                      session.disposition === 'in-review' &&
                      !session.nativeApplyPending &&
                      session.nativeInspection?.status !== 'checking' &&
                      !(
                        session.nativeInspection?.status === 'unavailable' &&
                        session.nativeInspection.recovery === 'rerun'
                      ) &&
                      !nativeAnnotationReviewNeedsObservation(session.nativeApplyResult)
                        ? () => {
                            const operationId = session.operationId;
                            if (operationId)
                              void prepareNativeAnnotationReview(operationId, { refresh: true });
                          }
                        : undefined,
                    onRerunReview:
                      session?.operationId &&
                      session.disposition === 'in-review' &&
                      session.nativeInspection?.status === 'unavailable' &&
                      session.nativeInspection.recovery === 'rerun' &&
                      annotateStatus !== 'loading'
                        ? () => handleAutoAnnotate()
                        : undefined,
                    editTargetIndex,
                    onClearEditTarget: clearEditTarget,
                    drawerTab,
                    onDrawerTabChange: setDrawerTab,
                    isTargetSequence,
                    drafts,
                    onAnnotationAdd: handleAnnotationAdd,
                    pendingNewRange,
                    currentSelectionRange: currentAnnotationBoundarySelection,
                    onClearPendingNewRange: clearPendingNewRange,
                    pendingNewDraft,
                    onClearPendingNewDraft: clearPendingNewDraft,
                    onPendingNewDraftChange: setPendingNewDraft,
                    draftSessionId,
                    reviewSelectedId: session?.selectedId,
                    onSelectDraft: selectDraft,
                    onToggleDraftAccepted: toggleDraftAccepted,
                    onAcceptRange: acceptRange,
                    onSetRangeAccepted: setRangeAccepted,
                    onAcceptAll: acceptAll,
                    onRejectAll: rejectAll,
                    onCommitReview: handleCommit,
                    onCancelReview: handleCancel,
                    onCloseDrawer: closeDrawer,
                    onMetadataDirtyChange: setMetadataDirty,
                    onReloadSavedSequence: reloadFromDisk,
                    nameEditRequestId: metadataNameEditRequestId,
                    metadataEditorTabId: tabId,
                    onReopenAssembly: requestAssemblyEdit,
                    assemblyReopenStatus: acceptedAssemblyReopen.status,
                    assemblyReopenError: acceptedAssemblyReopen.error,
                    acceptedAssemblyRecord: acceptedAssemblyReopen.acceptedRecord,
                    onSequenceTopologySaved: handleSequenceTopologySaved,
                    onSequenceGeneticCodeSaved: handleSequenceGeneticCodeSaved,
                    pendingAlignmentFiles,
                    onClearPendingAlignmentFiles: () => setPendingAlignmentFiles([]),
                    onAddAlignmentFiles: handleAddAlignmentFiles,
                    primerRecords,
                    primersLoading,
                    primersError,
                    onReloadPrimers: reloadPrimers,
                    onPrimerCreate: handlePrimerCreate,
                    onDetachPrimerBinding: detachPrimerBinding,
                    pendingPrimerBindingEdit,
                    onClearPendingPrimerBindingEdit: () => setPendingPrimerBindingEdit(null),
                    pendingPrimerCreation,
                    onClearPendingPrimerCreation: () => setPendingPrimerCreation(null),
                    onPreviewChange: handlePreviewChange,
                    primerSequenceId,
                    primerWorkspaceRoot,
                    searchResults,
                    isSearching,
                    onSearchPrimers: searchPrimersAction,
                    onAttachPrimer: attachPrimer,
                    canvasSelection,
                    primerAutoScope,
                    searchLibraryEmpty,
                    onPrimerAutoScopeConsumed: handlePrimerAutoScopeConsumed,
                    searchError,
                    onSearchResultClick: handleSearchResultClick,
                    onGoToPrimerBinding: (bindingStart, bindingEnd) => {
                      setScrollToPosition(bindingStart + 1);
                      setChangeHighlight({ start: bindingStart, end: bindingEnd - 1 });
                    },
                    gitLog,
                    gitLogLoading,
                    isFileInGitRepo,
                    selectedCommitHash,
                    diffResult,
                    annotationDiff,
                    gitDiffStatus,
                    isDiffViewActive,
                    ungappedToGapped,
                    onScrollToPosition: setScrollToPosition,
                    onChangeHighlight: setChangeHighlight,
                    onToggleDiffView: () => setIsDiffViewActive((v) => !v),
                    onSelectCommit: selectGitCommit,
                    onGitCommit: gitCommitFile,
                    onGitRevert: gitRevertFile,
                  }}
                />
              </div>
              <CreateAminoAcidSequenceDialog
                pending={pendingProteinCreation}
                onCancel={() => setPendingProteinCreation(null)}
                onConfirm={handleConfirmCreateAminoAcidSequence}
                isCreating={isCreatingProtein}
                roots={proteinSaveLocationRoots}
              />
              {assemblyEditDecisionOpen ? (
                <AssemblyEditUnsavedDialog
                  busy={assemblyEditDecisionBusy}
                  error={assemblyEditDecisionError}
                  onChoose={(choice) => void resolveAssemblyEditDecision(choice)}
                />
              ) : null}
            </div>
          )}
        </SequenceErrorBoundary>
      )}
    />
  );
}
