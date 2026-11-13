import type { ReactElement } from 'react';
import { SequenceContextMenu } from '@waypoint/ui-components';
import { formatShortcut } from '@waypoint/ui-components/keyboard';
import { shortcutChord } from '../../../keyboard/shortcutRegistry';
import { aminoAcidCreationBlockedReason, isCdsExtensionPreview } from '@waypoint/workspace-editor';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type { Annotation, GeneticCodeSpec, RecordGeneticCodeBasis } from '@waypoint/sequence-utils';
import type { BackbonePartHitPayload } from '@waypoint/genome-renderer';
import { structureViewDisabledReason } from '../adapters';
import { canOfferReindexHere } from './useSequenceViewTransformActions';
import { isHostedCapabilityShown } from '../../../hosted/capabilities';
import type { SequenceContextMenuState } from './useSequenceContextMenuState';
import type { ActiveOverlaySnapshot } from '../../ai/public/selection-descriptor/active-overlays';
import type { AnnotationDraft } from '../types';

type SourceMapper = {
  position(position: number | null): number | null;
  annotation(annotation: Annotation): Annotation;
  primer(primer: PrimerDisplay): PrimerDisplay;
  annotationDraft(draft: AnnotationDraft): AnnotationDraft;
};

type InclusiveRange = { start: number; end: number; wraps?: boolean };

export function WorkspaceViewerContextMenu({
  contextMenu,
  onClose,
  selectionLength,
  sequenceLength,
  sequenceBases,
  sequenceGeneticCode,
  geneticCodeBasis,
  circular,
  readOnly,
  isSequenceViewTransformed,
  canEditSequence,
  inAlignmentMode,
  isGapped,
  sequenceCommandIsActive,
  coordinateSpace,
  viewCursor,
  highlightedRange,
  annotationBoundarySelection,
  askAiBoundarySelection,
  effectiveCDS,
  effectiveStructureFeature,
  sequenceViewToSource,
  onCopySequence,
  onCopyReverseComplement,
  onCopyTranslation,
  onCopyCDSTranslation,
  onCreateAminoAcidSequence,
  onPaste,
  pasteTargetLabel,
  onEnterEditMode,
  onAddAnnotation,
  onEditAnnotation,
  onDeleteAnnotation,
  onCommitCdsExtension,
  onSaveORFAsAnnotation,
  onEditPrimer,
  onEditPrimerBinding,
  onCopyPrimerBases,
  onDetachPrimer,
  onReverseComplementAssemblyPart,
  onAttachPrimers,
  onCreatePrimer,
  getSelectedSequenceText,
  getSelectedReverseComplementText,
  onInvertSelection,
  onReindexHere,
  onFlipOrientation,
  onResetSequenceView,
  onPreviewCDS,
  onViewStructure,
  onAskAI,
  buildAskAiOverlaysSnapshot,
}: {
  contextMenu: SequenceContextMenuState;
  onClose: () => void;
  selectionLength: number;
  sequenceLength: number;
  sequenceBases: string;
  sequenceGeneticCode?: GeneticCodeSpec;
  geneticCodeBasis?: RecordGeneticCodeBasis;
  circular: boolean;
  readOnly: boolean;
  isSequenceViewTransformed: boolean;
  canEditSequence: boolean;
  inAlignmentMode: boolean;
  isGapped: boolean;
  sequenceCommandIsActive: boolean;
  coordinateSpace: unknown;
  viewCursor: number | null;
  highlightedRange: InclusiveRange | null;
  annotationBoundarySelection: InclusiveRange | null;
  askAiBoundarySelection: InclusiveRange | null;
  effectiveCDS: Annotation | null;
  effectiveStructureFeature: Annotation | null;
  sequenceViewToSource: SourceMapper;
  onCopySequence: () => void;
  onCopyReverseComplement: () => void;
  onCopyTranslation: () => void;
  onCopyCDSTranslation: () => void;
  onCreateAminoAcidSequence?: (cds: Annotation) => void;
  onPaste?: (position: number | null) => void;
  pasteTargetLabel?: string;
  onEnterEditMode: (position?: number) => void;
  onAddAnnotation: (range: { start: number; end: number }) => void;
  onEditAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  onCommitCdsExtension?: (preview: Annotation) => void;
  onSaveORFAsAnnotation: (orf: {
    start: number;
    end: number;
    strand: '+' | '-';
    frame: number;
    length: number;
  }) => void;
  onEditPrimer?: (primer: PrimerDisplay) => void;
  onEditPrimerBinding?: (primer: PrimerDisplay) => void;
  onCopyPrimerBases?: (primer: PrimerDisplay) => void;
  onDetachPrimer?: (primer: PrimerDisplay) => void;
  onReverseComplementAssemblyPart?: (part: BackbonePartHitPayload) => void;
  onAttachPrimers?: () => void;
  onCreatePrimer?: (
    range: { start: number; end: number; sequence: string },
    direction: 'forward' | 'reverse'
  ) => void;
  getSelectedSequenceText: () => string;
  getSelectedReverseComplementText: () => string;
  onInvertSelection: () => void;
  onReindexHere: () => void;
  onFlipOrientation: () => void;
  onResetSequenceView: () => void;
  onPreviewCDS: (previewing: boolean) => void;
  onViewStructure?: (cds: Annotation) => void;
  onAskAI?: (payload: {
    range: { start: number; end: number };
    wraps?: boolean;
    overlays?: ActiveOverlaySnapshot;
    anchor?: { x: number; y: number };
  }) => void;
  buildAskAiOverlaysSnapshot: () => ActiveOverlaySnapshot | undefined;
}): ReactElement {
  const primer = contextMenu.primer;
  const assemblyPart = contextMenu.assemblyPart;
  const primersShown = isHostedCapabilityShown('primers');
  return (
    <SequenceContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      isOpen={contextMenu.isOpen}
      onClose={onClose}
      shortcutHints={{
        copySequence: formatShortcut(shortcutChord('app.copy')),
        copyReverseComplement: formatShortcut(shortcutChord('sequence.reverse-complement')),
        copyTranslation: formatShortcut(shortcutChord('sequence.copy-translation')),
        addAnnotation: formatShortcut(shortcutChord('sequence.add-annotation')),
        invertSelection: formatShortcut(shortcutChord('sequence.invert')),
        paste: formatShortcut(shortcutChord('app.paste')),
      }}
      hasSelection={selectionLength > 0}
      onCopySequence={onCopySequence}
      onCopyReverseComplement={onCopyReverseComplement}
      onCopyTranslation={onCopyTranslation}
      onCopyCDSTranslation={effectiveCDS ? onCopyCDSTranslation : undefined}
      clickedCDS={effectiveCDS}
      onCreateAminoAcidSequence={
        effectiveCDS && onCreateAminoAcidSequence
          ? () => onCreateAminoAcidSequence(effectiveCDS)
          : undefined
      }
      createAminoAcidSequenceDisabled={
        effectiveCDS != null &&
        aminoAcidCreationBlockedReason(
          effectiveCDS,
          sequenceBases,
          sequenceGeneticCode,
          geneticCodeBasis
        ) !== null
      }
      onPaste={
        onPaste
          ? () => onPaste(sequenceViewToSource.position(contextMenu.position ?? viewCursor))
          : undefined
      }
      pasteTargetLabel={pasteTargetLabel}
      isOnNucleotideRow={contextMenu.isOnNucleotideRow}
      onEditSequence={
        readOnly || isSequenceViewTransformed || !canEditSequence
          ? undefined
          : () => onEnterEditMode(contextMenu.position ?? undefined)
      }
      clickedAnnotation={contextMenu.annotation}
      selectionRange={annotationBoundarySelection}
      onAddAnnotation={readOnly ? undefined : onAddAnnotation}
      onEditAnnotation={readOnly ? undefined : onEditAnnotation}
      onDeleteAnnotation={readOnly ? undefined : onDeleteAnnotation}
      clickedAnnotationIsCdsExtensionPreview={
        contextMenu.annotation ? isCdsExtensionPreview(contextMenu.annotation) : false
      }
      onCommitCdsExtension={
        contextMenu.annotation &&
        onCommitCdsExtension &&
        isCdsExtensionPreview(contextMenu.annotation)
          ? () => onCommitCdsExtension(contextMenu.annotation!)
          : undefined
      }
      clickedORF={contextMenu.orf}
      onSaveORFAsAnnotation={readOnly ? undefined : onSaveORFAsAnnotation}
      inAlignmentMode={inAlignmentMode}
      clickedPrimer={primer}
      onEditPrimer={
        primer && onEditPrimer ? () => onEditPrimer(sequenceViewToSource.primer(primer)) : undefined
      }
      onEditPrimerBinding={
        primer?.sourcePrimerId && !primer.isDraft && onEditPrimerBinding
          ? () => onEditPrimerBinding(sequenceViewToSource.primer(primer))
          : undefined
      }
      onCopyPrimerBases={
        primer && onCopyPrimerBases
          ? () => onCopyPrimerBases(sequenceViewToSource.primer(primer))
          : undefined
      }
      onDetachPrimer={
        primer && onDetachPrimer
          ? () => onDetachPrimer(sequenceViewToSource.primer(primer))
          : undefined
      }
      onReverseComplementAssemblyPart={
        assemblyPart && onReverseComplementAssemblyPart
          ? () => onReverseComplementAssemblyPart(assemblyPart)
          : undefined
      }
      onAttachPrimers={primersShown ? onAttachPrimers : undefined}
      onCreateForwardPrimer={
        primersShown && highlightedRange && onCreatePrimer && !isSequenceViewTransformed
          ? () =>
              onCreatePrimer(
                {
                  start: highlightedRange.start,
                  end: highlightedRange.end + 1,
                  sequence: getSelectedSequenceText(),
                },
                'forward'
              )
          : undefined
      }
      onCreateReversePrimer={
        primersShown && highlightedRange && onCreatePrimer && !isSequenceViewTransformed
          ? () =>
              onCreatePrimer(
                {
                  start: highlightedRange.start,
                  end: highlightedRange.end + 1,
                  sequence: getSelectedReverseComplementText(),
                },
                'reverse'
              )
          : undefined
      }
      onInvertSelection={highlightedRange && circular ? onInvertSelection : undefined}
      onReindexHere={
        canOfferReindexHere({
          circular,
          contextPosition: contextMenu.position,
          selectionLength,
        })
          ? onReindexHere
          : undefined
      }
      onFlipOrientation={coordinateSpace ? undefined : onFlipOrientation}
      onResetSequenceView={isSequenceViewTransformed ? onResetSequenceView : undefined}
      isSequenceViewTransformed={isSequenceViewTransformed}
      onPreviewCDS={effectiveCDS ? onPreviewCDS : undefined}
      onViewStructure={
        effectiveStructureFeature && onViewStructure && isHostedCapabilityShown('external-lookups')
          ? () => onViewStructure(sequenceViewToSource.annotation(effectiveStructureFeature))
          : undefined
      }
      onAskAI={
        askAiBoundarySelection && onAskAI
          ? () =>
              onAskAI({
                range: {
                  start: askAiBoundarySelection.start,
                  end: askAiBoundarySelection.end,
                },
                wraps: askAiBoundarySelection.wraps,
                overlays: buildAskAiOverlaysSnapshot(),
                anchor: { x: contextMenu.x, y: contextMenu.y },
              })
          : undefined
      }
      askAiShortcut={sequenceCommandIsActive && !isGapped && !inAlignmentMode ? '/' : undefined}
      structureAnnotation={effectiveStructureFeature}
      viewStructureDisabled={
        structureViewDisabledReason(effectiveStructureFeature, sequenceLength) !== null
      }
    />
  );
}
