import type { ReactNode } from 'react';
import type {
  SequenceDisplayName,
  SequencePresentation,
} from '../../../shared/sequence-presentation';
import { SequenceInfoBar } from './SequenceInfoBar';
import { isHostedBrowserRuntime } from '../../../utils/environment';
import type { SequenceViewMode } from './SequenceViewerModeToggle';
import type {
  SequenceMapLayout,
  SequenceRendererVisibility,
} from '../view-state/sequence-view-state';

export function SequenceTabInfoChrome({
  readOnly,
  quickLook,
  presentation,
  sequenceLength,
  annotationCount,
  circular,
  viewMode,
  onViewModeChange,
  rendererVisibility,
  onRendererVisibilityChange,
  mapLayout,
  onMapLayoutChange,
  sequenceDocumentId,
  limsBadge,
  hostedRevisionNumber,
  hostedPendingDraft = false,
  shareControl,
  isViewerEditMode,
  editingPending = false,
  onRequestEdit,
  acceptedAssemblyProductMismatch,
  showExternalChangeToast,
  onAcceptExternalChange,
  onDismissExternalChange,
}: {
  readOnly: boolean;
  presentation: SequencePresentation;
  quickLook?: {
    sourceFileName: string;
    records: readonly {
      recordId: string;
      displayName: SequenceDisplayName;
      sequenceLength: number;
    }[];
    selectedRecordId: string;
    onSelect: (recordId: string) => void;
    onImportToEdit: () => void;
  };
  sequenceLength: number;
  annotationCount?: number;
  circular?: boolean;
  viewMode: SequenceViewMode;
  onViewModeChange: (next: SequenceViewMode) => void;
  rendererVisibility: SequenceRendererVisibility;
  onRendererVisibilityChange: (next: SequenceRendererVisibility) => void;
  mapLayout: SequenceMapLayout;
  onMapLayoutChange: (next: SequenceMapLayout) => void;
  sequenceDocumentId: string;
  limsBadge: ReactNode;
  hostedRevisionNumber: number | null;
  hostedPendingDraft?: boolean;
  shareControl: ReactNode;
  isViewerEditMode: boolean;
  editingPending?: boolean;
  onRequestEdit: (documentId: string) => void;
  acceptedAssemblyProductMismatch: {
    expectedChecksum: string;
    actualChecksum: string | null;
  } | null;
  showExternalChangeToast: boolean;
  onAcceptExternalChange: () => void;
  onDismissExternalChange: () => void;
}) {
  const isHostedDocument = hostedRevisionNumber !== null;

  return (
    <>
      {}
      <div data-testid={isHostedDocument ? 'hosted-document-bar' : undefined}>
        <SequenceInfoBar
          documentLabel={presentation.name}
          sequenceLength={sequenceLength}
          circular={circular}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          rendererVisibility={rendererVisibility}
          onRendererVisibilityChange={onRendererVisibilityChange}
          mapLayout={mapLayout}
          onMapLayoutChange={onMapLayoutChange}
          showViewModeToggle={false}
          showRendererVisibilityToggle={false}
          showMapLayoutToggle={false}
          accessMode={
            quickLook
              ? {
                  kind: 'external-preview',
                  sourceFileName: quickLook.sourceFileName,
                  onImportToEdit: quickLook.onImportToEdit,
                }
              : readOnly
                ? { kind: 'read-only' }
                : undefined
          }
          recordSelector={
            quickLook
              ? {
                  records: quickLook.records,
                  selectedRecordId: quickLook.selectedRecordId,
                  onSelect: quickLook.onSelect,
                }
              : undefined
          }
          limsBadge={quickLook ? undefined : limsBadge}
          trailingContent={
            isHostedDocument || (!readOnly && !quickLook && shareControl) ? (
              <>
                {isHostedDocument ? (
                  <>
                    <span>{annotationCount ?? 0} annotations</span>
                    <span data-testid="hosted-version-id">
                      {hostedPendingDraft
                        ? `Local draft · based on revision ${hostedRevisionNumber}`
                        : `Revision ${hostedRevisionNumber}`}
                    </span>
                  </>
                ) : null}
                {!isHostedDocument && !readOnly && !quickLook ? shareControl : null}
              </>
            ) : undefined
          }
          onEdit={
            !readOnly && !isViewerEditMode ? () => onRequestEdit(sequenceDocumentId) : undefined
          }
          editingPending={editingPending}
          editButtonTestId={
            isHostedBrowserRuntime() ? 'hosted-edit-sequence' : 'sequence-edit-button'
          }
        />
      </div>
      {acceptedAssemblyProductMismatch ? (
        <div
          className="flex items-center gap-3 px-3 py-1.5 bg-yellow-900/30 border-b border-yellow-700/50 text-xs text-yellow-200"
          data-testid="accepted-assembly-product-mismatch"
        >
          This plasmid file no longer matches the last accepted construction.
        </div>
      ) : null}
      {}
      {showExternalChangeToast && (
        <div className="flex items-center gap-3 px-3 py-1.5 bg-yellow-900/30 border-b border-yellow-700/50 text-xs text-yellow-200">
          <span>File changed on disk. You have unsaved edits.</span>
          <button
            className="px-2 py-0.5 rounded bg-yellow-600/30 hover:bg-yellow-600/50 text-yellow-100"
            onClick={onAcceptExternalChange}
          >
            Reload
          </button>
          <button
            className="px-2 py-0.5 rounded hover:bg-yellow-600/20 text-yellow-300"
            onClick={onDismissExternalChange}
          >
            Keep my edits
          </button>
        </div>
      )}
    </>
  );
}
